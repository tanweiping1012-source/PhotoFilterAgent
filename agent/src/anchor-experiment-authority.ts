import { createHash } from 'node:crypto'
import {
  PHOTO_ANCHOR_LAB_CODEX_ID,
  PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA,
  assertPhotoAnchorLabCodexExperimentId,
} from './anchor-lab-codex-identity.ts'
import {
  anchorExperimentSelectionHash,
  type AnchorExperimentAuditEvidenceView,
  type AnchorExperimentAuditReport,
  type AnchorExperimentDerivedAuthority,
  type AnchorExperimentDraft,
  type AnchorExperimentEvidenceView,
  type AnchorExperimentExpectedPhase,
  type AnchorExperimentRunBinding,
  type ExperimentAssessment,
  type ExperimentPairwiseLegRecord,
} from './anchor-experiment-state.ts'
import {
  rankPortraits,
  type PairwiseComparison,
  type RankingCandidate,
} from './ranking.ts'
import {
  planHighRefinement,
  planPairwiseBudget,
  type HighRefinementPlan,
  type PairwiseBudgetPlan,
} from './selection-budget.ts'

export const ANCHOR_LAB_CODEX_CATALOG_PROTOCOL =
  'photo-anchor-lab-codex-candidate-catalog/v1' as const
export const ANCHOR_LAB_CODEX_SELECTOR_ROUND_PROTOCOL =
  PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA
export const ANCHOR_LAB_CODEX_REFINEMENT_POLICY =
  'photo-anchor-lab-codex-refinement/v1' as const
export const ANCHOR_LAB_CODEX_PAIRWISE_POLICY =
  'photo-anchor-lab-codex-pairwise/v1' as const
export const ANCHOR_LAB_CODEX_AGGREGATION_POLICY =
  'photo-anchor-lab-codex-ab-ba/v1' as const
export const ANCHOR_LAB_CODEX_SELECTION_POLICY =
  'photo-anchor-lab-codex-selection/v1' as const

type Hash = string

export interface AnchorLabCandidateMeta {
  readonly id: string
  readonly familyId?: string
  /** Same local metadata must be supplied to A/B/C. */
  readonly diversityTags: readonly string[]
  readonly localEligibility: 'eligible' | 'ineligible'
  /** Preference is a bounded overlay; it never rewrites the baseline score. */
  readonly preferenceAdjustment: number
}

export interface FrozenAnchorLabCandidateCatalog {
  readonly protocol: typeof ANCHOR_LAB_CODEX_CATALOG_PROTOCOL
  readonly technicalId: typeof PHOTO_ANCHOR_LAB_CODEX_ID
  readonly datasetFingerprint: Hash
  readonly candidates: readonly AnchorLabCandidateMeta[]
  readonly catalogHash: Hash
}

export interface AnchorLabSelectionPolicy {
  readonly preferenceHash: Hash
  readonly diversityStrength: number
  readonly familyCap: 'auto' | 'unlimited' | number
  /** Non-zero diversity is allowed only with a frozen, shared local tag catalog. */
  readonly diversityProtocol: 'disabled' | 'catalog-v1'
}

export interface AnchorLabSelectorFeedback {
  readonly failedAuditRound: number
  readonly failedSelectionHash: Hash
  readonly strongerChallengerIds: readonly string[]
  readonly disqualifiedSelectedIds: readonly string[]
  readonly feedbackHash: Hash
}

export interface AggregatedExperimentComparison {
  readonly logicalKey: Hash
  readonly aId: string
  readonly bId: string
  readonly abCacheKey: Hash
  readonly baCacheKey: Hash
  readonly result: PairwiseComparison
  readonly terminal: 'left' | 'right' | 'tie' | 'reject_both'
}

export interface FrozenSelectorRound {
  readonly protocol: typeof ANCHOR_LAB_CODEX_SELECTOR_ROUND_PROTOCOL
  readonly technicalId: typeof PHOTO_ANCHOR_LAB_CODEX_ID
  readonly round: number
  readonly priorSelectionHash?: Hash
  readonly feedback?: AnchorLabSelectorFeedback
  /** Complete logical comparisons that existed before this round's pair plan. */
  readonly prePlanComparisonKeys: readonly Hash[]
  readonly roundHash: Hash
}

export interface CreateAnchorLabAuthorityInput {
  readonly binding: AnchorExperimentRunBinding
  readonly candidateCatalog: FrozenAnchorLabCandidateCatalog
  readonly selectionPolicy: AnchorLabSelectionPolicy
  readonly selectorRound: FrozenSelectorRound
  readonly expectedPersistedPhase: AnchorExperimentExpectedPhase
  readonly expectedAuditRound?: number
  /** Supplied by the isolated audit module; selector code never reads audit evidence. */
  readonly recomputeAudit?: AnchorExperimentDerivedAuthority['recomputeAudit']
  /**
   * Isolated audit computation used only to prove later-round lineage from
   * retained evidence. It returns plans as well as the report so later-round
   * evidence can be excluded while reconstructing the historical audit.
   */
  readonly recomputeHistoricalAudit?: AnchorLabHistoricalAuditRecompute
}

export interface AnchorLabHistoricalAuditComputation {
  readonly promotionPlan?: Readonly<{ promotionIds: readonly string[] }>
  readonly pairPlan?: Readonly<{
    pairs: readonly Readonly<{ aId: string; bId: string }>[]
  }>
  readonly report: AnchorExperimentAuditReport
}

export type AnchorLabHistoricalAuditRecompute = (
  evidence: AnchorExperimentAuditEvidenceView,
  draft: AnchorExperimentDraft,
  expectedRound: number,
) => AnchorLabHistoricalAuditComputation

export class AnchorExperimentAuthorityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentAuthorityError'
    this.code = code
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function immutable<T>(value: T): T {
  return deepFreeze(canonical(value) as T)
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function uniqueSorted(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value)) {
    throw new AnchorExperimentAuthorityError('INVALID_ID_SET', `${label} 必须是非空字符串数组。`)
  }
  const sorted = [...values].sort()
  if (new Set(sorted).size !== sorted.length) {
    throw new AnchorExperimentAuthorityError('DUPLICATE_ID_SET', `${label} 包含重复项。`)
  }
  return Object.freeze(sorted)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

export function createAnchorLabCandidateCatalog(input: Readonly<{
  binding: AnchorExperimentRunBinding
  candidates: readonly AnchorLabCandidateMeta[]
}>): FrozenAnchorLabCandidateCatalog {
  assertPhotoAnchorLabCodexExperimentId(input.binding.experimentId)
  if (!Array.isArray(input.candidates) || input.candidates.length < input.binding.targetK) {
    throw new AnchorExperimentAuthorityError('CANDIDATE_CATALOG_INVALID', 'candidate catalog 小于 targetK。')
  }
  const seen = new Set<string>()
  const rows = input.candidates.map((candidate, index) => {
    if (!candidate || !safeId(candidate.id) || seen.has(candidate.id)
      || (candidate.familyId !== undefined && !safeId(candidate.familyId))
      || !Array.isArray(candidate.diversityTags)
      || candidate.diversityTags.some(tag => typeof tag !== 'string' || !tag.trim())
      || new Set(candidate.diversityTags).size !== candidate.diversityTags.length
      || !['eligible', 'ineligible'].includes(candidate.localEligibility)
      || !Number.isFinite(candidate.preferenceAdjustment)
      || candidate.preferenceAdjustment < -4 || candidate.preferenceAdjustment > 4) {
      throw new AnchorExperimentAuthorityError(
        'CANDIDATE_CATALOG_INVALID',
        `candidate catalog 第 ${index + 1} 行无效或重复。`,
      )
    }
    seen.add(candidate.id)
    return {
      id: candidate.id,
      ...(candidate.familyId ? { familyId: candidate.familyId } : {}),
      diversityTags: [...candidate.diversityTags].sort(),
      localEligibility: candidate.localEligibility,
      preferenceAdjustment: Math.round(candidate.preferenceAdjustment * 10_000) / 10_000,
    }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const identity = {
    protocol: ANCHOR_LAB_CODEX_CATALOG_PROTOCOL,
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    datasetFingerprint: input.binding.datasetFingerprint,
    sourceSnapshotHash: input.binding.sourceSnapshotHash,
    candidates: rows,
  }
  return immutable({
    protocol: identity.protocol,
    technicalId: identity.technicalId,
    datasetFingerprint: identity.datasetFingerprint,
    candidates: rows,
    catalogHash: canonicalHash(identity),
  })
}

export function createAnchorLabSelectorFeedback(input: Readonly<{
  binding: AnchorExperimentRunBinding
  failedAuditRound: number
  failedSelectionHash: string
  strongerChallengerIds: readonly string[]
  disqualifiedSelectedIds: readonly string[]
}>): AnchorLabSelectorFeedback {
  const stronger = uniqueSorted(input.strongerChallengerIds, 'strongerChallengerIds')
  const disqualified = uniqueSorted(input.disqualifiedSelectedIds, 'disqualifiedSelectedIds')
  if (!Number.isInteger(input.failedAuditRound) || input.failedAuditRound < 1
    || input.failedAuditRound > input.binding.budget.maxCompleteAuditRounds
    || !validHash(input.failedSelectionHash)
    || stronger.some(id => disqualified.includes(id))) {
    throw new AnchorExperimentAuthorityError('SELECTOR_FEEDBACK_INVALID', 'FAIL feedback 身份或集合无效。')
  }
  const identity = {
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    bindingHash: input.binding.stateNamespaceHash,
    failedAuditRound: input.failedAuditRound,
    failedSelectionHash: input.failedSelectionHash,
    strongerChallengerIds: stronger,
    disqualifiedSelectedIds: disqualified,
  }
  return immutable({ ...identity, feedbackHash: canonicalHash(identity) })
}

export function createFrozenSelectorRound(input: Readonly<{
  binding: AnchorExperimentRunBinding
  round: number
  existingComparisons: readonly AggregatedExperimentComparison[]
  priorSelectionHash?: string
  feedback?: AnchorLabSelectorFeedback
}>): FrozenSelectorRound {
  assertPhotoAnchorLabCodexExperimentId(input.binding.experimentId)
  if (!Number.isInteger(input.round) || input.round < 1
    || input.round > input.binding.budget.maxCompleteAuditRounds) {
    throw new AnchorExperimentAuthorityError('SELECTOR_ROUND_INVALID', 'selector round 超出冻结上限。')
  }
  const keys = uniqueSorted(input.existingComparisons.map(row => row.logicalKey), 'prePlanComparisonKeys')
  if (input.existingComparisons.some(row => !validHash(row.logicalKey))) {
    throw new AnchorExperimentAuthorityError('SELECTOR_ROUND_INVALID', 'pre-plan comparison key 无效。')
  }
  const feedback = input.feedback
    ? createAnchorLabSelectorFeedback({
      binding: input.binding,
      failedAuditRound: input.feedback.failedAuditRound,
      failedSelectionHash: input.feedback.failedSelectionHash,
      strongerChallengerIds: input.feedback.strongerChallengerIds,
      disqualifiedSelectedIds: input.feedback.disqualifiedSelectedIds,
    })
    : undefined
  if (feedback && canonicalHash(feedback) !== canonicalHash(input.feedback)) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_FEEDBACK_HASH_MISMATCH',
      'selector feedback 无法由冻结 FAIL 字段重算。',
    )
  }
  if (input.round === 1) {
    if (input.priorSelectionHash !== undefined || input.feedback !== undefined || keys.length !== 0) {
      throw new AnchorExperimentAuthorityError(
        'SELECTOR_ROUND_ONE_NOT_CLEAN',
        '首轮必须没有历史 selection、FAIL feedback 或 pre-plan comparison。',
      )
    }
  } else if (!validHash(input.priorSelectionHash) || !feedback
    || feedback.failedAuditRound !== input.round - 1
    || feedback.failedSelectionHash !== input.priorSelectionHash) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_ROUND_FEEDBACK_REQUIRED',
      '后续 selector round 必须由上一轮 terminal FAIL 精确派生。',
    )
  }
  const identity = {
    protocol: ANCHOR_LAB_CODEX_SELECTOR_ROUND_PROTOCOL,
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    bindingHash: input.binding.stateNamespaceHash,
    round: input.round,
    ...(input.priorSelectionHash ? { priorSelectionHash: input.priorSelectionHash } : {}),
    ...(feedback ? { feedback } : {}),
    prePlanComparisonKeys: keys,
  }
  return immutable({ ...identity, roundHash: canonicalHash(identity) })
}

function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join('\u0000')
}

function normalizedLeg(record: ExperimentPairwiseLegRecord): Readonly<{
  aId: string
  bId: string
  order: 'AB' | 'BA'
  result: 'left' | 'right' | 'tie' | 'reject_both'
  margin: number
  confidence: number
  leftTier?: string
  rightTier?: string
  cacheKey: string
}> {
  const forward = record.aId < record.bId
  const aId = forward ? record.aId : record.bId
  const bId = forward ? record.bId : record.aId
  const result = !forward && record.decision.result === 'left'
    ? 'right'
    : !forward && record.decision.result === 'right'
      ? 'left'
      : record.decision.result
  const raw = record.decision.raw as Record<string, unknown>
  const rawLeftTier = typeof raw.leftTier === 'string' ? raw.leftTier : undefined
  const rawRightTier = typeof raw.rightTier === 'string' ? raw.rightTier : undefined
  return Object.freeze({
    aId,
    bId,
    order: forward ? record.order : record.order === 'AB' ? 'BA' : 'AB',
    result,
    margin: forward ? record.decision.weightedMargin : -record.decision.weightedMargin,
    confidence: record.decision.confidence,
    ...(rawLeftTier && rawRightTier
      ? { leftTier: forward ? rawLeftTier : rawRightTier,
          rightTier: forward ? rawRightTier : rawLeftTier }
      : {}),
    cacheKey: record.cacheKey,
  })
}

export function aggregateExperimentComparisons(input: Readonly<{
  binding: AnchorExperimentRunBinding
  legs: readonly ExperimentPairwiseLegRecord[]
  role?: 'selector' | 'audit'
}>): readonly AggregatedExperimentComparison[] {
  const role = input.role ?? 'selector'
  const groups = new Map<string, Map<'AB' | 'BA', ReturnType<typeof normalizedLeg>>>()
  for (const record of input.legs) {
    if (record.role !== role) continue
    const leg = normalizedLeg(record)
    const key = pairKey(leg.aId, leg.bId)
    const group = groups.get(key) ?? new Map()
    if (group.has(leg.order)) {
      throw new AnchorExperimentAuthorityError(
        'PAIRWISE_EFFECTIVE_LEG_DUPLICATE',
        '同一逻辑照片对出现重复的有效 AB 或 BA leg。',
      )
    }
    group.set(leg.order, leg)
    groups.set(key, group)
  }
  const results: AggregatedExperimentComparison[] = []
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!
    const ab = group.get('AB')
    const ba = group.get('BA')
    if (!ab || !ba) continue
    const sameResult = ab.result === ba.result
    const sameTiers = input.binding.arm === 'A'
      || (ab.leftTier === ba.leftTier && ab.rightTier === ba.rightTier)
    const confidence = (ab.confidence + ba.confidence) / 2
    const margin = (Math.abs(ab.margin) + Math.abs(ba.margin)) / 2
    const directional = ab.result === 'left' || ab.result === 'right'
    const signConsistent = !directional
      || (ab.result === 'left' ? ab.margin > 0 && ba.margin > 0 : ab.margin < 0 && ba.margin < 0)
    const stable = sameResult && sameTiers && signConsistent && confidence >= 0.70
      && (!directional || margin >= 2)
    const terminal = stable ? ab.result : 'tie'
    const leftOutcome = terminal === 'left' ? 1 : terminal === 'right' ? 0 : 0.5
    const weight = Math.min(10, Math.max(1, Math.round(confidence * 4 * 10_000) / 10_000))
    const result: PairwiseComparison = Object.freeze({
      leftId: ab.aId,
      rightId: ab.bId,
      leftOutcome,
      weight,
    })
    const logicalKey = canonicalHash({
      technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
      aggregationPolicy: ANCHOR_LAB_CODEX_AGGREGATION_POLICY,
      bindingHash: input.binding.stateNamespaceHash,
      role,
      aId: ab.aId,
      bId: ab.bId,
      abCacheKey: ab.cacheKey,
      baCacheKey: ba.cacheKey,
      terminal,
      leftOutcome,
      weight,
    })
    results.push(immutable({
      logicalKey,
      aId: ab.aId,
      bId: ab.bId,
      abCacheKey: ab.cacheKey,
      baCacheKey: ba.cacheKey,
      result: { ...result, cacheKey: logicalKey },
      terminal,
    }))
  }
  return Object.freeze(results)
}

function evidenceScores(
  evidence: AnchorExperimentEvidenceView,
): Map<string, ExperimentAssessment> {
  return new Map(evidence.selectorScores.map(([, stored]) => [
    `${stored.assessment.id}\u0000${stored.assessment.detail}`,
    stored.assessment,
  ]))
}

function provisionalScore(assessment: ExperimentAssessment): number {
  if (assessment.score !== null) return assessment.score
  if (assessment.scoreInterval) return (assessment.scoreInterval[0] + assessment.scoreInterval[1]) / 2
  const raw = assessment.raw as unknown as { dimensionScores?: Record<string, number> }
  const values = Object.values(raw.dimensionScores ?? {}).filter(Number.isFinite)
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function adjustedScore(score: number, adjustment: number): number {
  return Math.round(Math.min(100, Math.max(0, score + adjustment)) * 10_000) / 10_000
}

function bestRankingCandidates(input: Readonly<{
  evidence: AnchorExperimentEvidenceView
  catalog: FrozenAnchorLabCandidateCatalog
  feedback?: AnchorLabSelectorFeedback
  /** Undefined means every cached high is visible; an explicit set freezes history. */
  allowedHighIds?: ReadonlySet<string>
}>): readonly RankingCandidate[] {
  const scores = evidenceScores(input.evidence)
  const disqualified = new Set(input.feedback?.disqualifiedSelectedIds ?? [])
  return Object.freeze(input.catalog.candidates.map(meta => {
    const high = input.allowedHighIds === undefined || input.allowedHighIds.has(meta.id)
      ? scores.get(`${meta.id}\u0000high`)
      : undefined
    const assessment = high ?? scores.get(`${meta.id}\u0000low`)
    const eligible = meta.localEligibility === 'eligible' && !disqualified.has(meta.id)
      ? assessment?.eligibility ?? 'needs_review'
      : 'ineligible'
    return Object.freeze({
      id: meta.id,
      score: adjustedScore(assessment ? provisionalScore(assessment) : 0, meta.preferenceAdjustment),
      ...(meta.familyId ? { familyId: meta.familyId } : {}),
      diversityTags: meta.diversityTags,
      eligibility: eligible,
    })
  }))
}

function refinementFromEvidence(input: Readonly<{
  evidence: AnchorExperimentEvidenceView
  catalog: FrozenAnchorLabCandidateCatalog
  round: FrozenSelectorRound
}>): Readonly<{ contextKey: Hash; plan: HighRefinementPlan }> | undefined {
  const scores = evidenceScores(input.evidence)
  if (input.catalog.candidates.some(meta => !scores.has(`${meta.id}\u0000low`))) return undefined
  const disqualified = new Set(input.round.feedback?.disqualifiedSelectedIds ?? [])
  const mandatory = uniqueSorted(input.catalog.candidates
    .filter(meta => !disqualified.has(meta.id))
    .filter(meta => scores.get(`${meta.id}\u0000low`)?.eligibility === 'needs_review'
      || input.round.feedback?.strongerChallengerIds.includes(meta.id))
    .map(meta => meta.id), 'mandatoryHighIds')
  const candidates = bestRankingCandidates({
    evidence: input.evidence,
    catalog: input.catalog,
    feedback: input.round.feedback,
    // The refinement plan is a low-pass budget decision. High evidence is
    // produced only after this plan and therefore must never re-plan itself.
    allowedHighIds: new Set(),
  }).map(candidate => mandatory.includes(candidate.id)
    ? Object.freeze({ ...candidate, eligibility: 'eligible' as const })
    : candidate)
  const provisionalEligible = candidates.filter(candidate => candidate.eligibility === 'eligible').length
  const computedHardCap = Math.min(
    provisionalEligible,
    Math.max(input.evidence.binding.targetK * 3, input.evidence.binding.targetK + 20),
  )
  if (mandatory.length > input.evidence.binding.budget.highCap || mandatory.length > computedHardCap) {
    throw new AnchorExperimentAuthorityError(
      'MANDATORY_HIGH_EXCEEDS_BUDGET',
      `mandatory high ${mandatory.length} 超出冻结 hard cap。`,
    )
  }
  const plan = planHighRefinement(candidates, input.evidence.binding.targetK, {
    forcedCandidateIds: mandatory,
  })
  if (plan.hardCap > input.evidence.binding.budget.highCap
    || mandatory.some(id => !plan.candidateIds.includes(id))) {
    throw new AnchorExperimentAuthorityError(
      'REFINEMENT_PLAN_BUDGET_MISMATCH',
      'high refinement 未完整覆盖 mandatory 或超出 manifest budget。',
    )
  }
  const lowEvidenceHash = canonicalHash(input.evidence.selectorScores
    .filter(([, stored]) => stored.assessment.detail === 'low'))
  const contextKey = canonicalHash({
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    policy: ANCHOR_LAB_CODEX_REFINEMENT_POLICY,
    bindingHash: input.evidence.binding.stateNamespaceHash,
    selectorRoundHash: input.round.roundHash,
    candidateCatalogHash: input.catalog.catalogHash,
    selectorLowEvidenceHash: lowEvidenceHash,
    preferenceHash: input.evidence.binding.preferenceHash,
    mandatoryHighIds: mandatory,
    plan,
  })
  return immutable({ contextKey, plan })
}

function pairwiseFromEvidence(input: Readonly<{
  evidence: AnchorExperimentEvidenceView
  catalog: FrozenAnchorLabCandidateCatalog
  policy: AnchorLabSelectionPolicy
  round: FrozenSelectorRound
  refinement: Readonly<{ contextKey: Hash; plan: HighRefinementPlan }>
}>): Readonly<{ contextKey: Hash; plan: PairwiseBudgetPlan }> | undefined {
  const scores = evidenceScores(input.evidence)
  if (input.refinement.plan.candidateIds.some(id => !scores.has(`${id}\u0000high`))) return undefined
  const allComparisons = aggregateExperimentComparisons({
    binding: input.evidence.binding,
    legs: input.evidence.selectorPairwiseLegs.map(([, record]) => record),
  })
  const comparisonsByKey = new Map(allComparisons.map(row => [row.logicalKey, row]))
  const prePlan = input.round.prePlanComparisonKeys.map(key => {
    const row = comparisonsByKey.get(key)
    if (!row) {
      throw new AnchorExperimentAuthorityError(
        'PREPLAN_COMPARISON_EVIDENCE_MISSING',
        'selector round 的 pre-plan comparison 缺少完整 AB/BA 证据。',
      )
    }
    return row
  })
  const candidates = bestRankingCandidates({
    evidence: input.evidence, catalog: input.catalog, feedback: input.round.feedback,
  })
  const preliminary = rankPortraits(candidates, {
    topK: input.evidence.binding.targetK,
    comparisons: prePlan.map(row => row.result),
    diversityStrength: input.policy.diversityStrength,
    familyCap: input.policy.familyCap,
  })
  const rawPlan = planPairwiseBudget(
    candidates,
    preliminary,
    prePlan.map(row => row.result),
    input.evidence.binding.targetK,
    input.evidence.binding.budget.pairwisePairCap,
    input.round.feedback?.strongerChallengerIds ?? [],
  )
  const pairs = rawPlan.pairs.map(pair => pair.leftId < pair.rightId
    ? pair
    : Object.freeze({ ...pair, leftId: pair.rightId, rightId: pair.leftId }))
  const plan = immutable({ ...rawPlan, pairs })
  const highEvidenceHash = canonicalHash(input.evidence.selectorScores
    .filter(([, stored]) => stored.assessment.detail === 'high'))
  const contextKey = canonicalHash({
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    policy: ANCHOR_LAB_CODEX_PAIRWISE_POLICY,
    selectorRoundHash: input.round.roundHash,
    refinementContextKey: input.refinement.contextKey,
    postHighEvidenceHash: highEvidenceHash,
    prePlanComparisonKeys: input.round.prePlanComparisonKeys,
    preliminary,
    forcedChallengerIds: input.round.feedback?.strongerChallengerIds ?? [],
    pairCap: input.evidence.binding.budget.pairwisePairCap,
    plan,
  })
  return immutable({ contextKey, plan })
}

function draftFromEvidence(input: Readonly<{
  evidence: AnchorExperimentEvidenceView
  catalog: FrozenAnchorLabCandidateCatalog
  policy: AnchorLabSelectionPolicy
  round: FrozenSelectorRound
  refinement: Readonly<{ contextKey: Hash; plan: HighRefinementPlan }>
  pairwise: Readonly<{ contextKey: Hash; plan: PairwiseBudgetPlan }>
}>): AnchorExperimentDraft | undefined {
  const scores = evidenceScores(input.evidence)
  if (input.refinement.plan.candidateIds.some(id => !scores.has(`${id}\u0000high`))) return undefined
  const aggregated = aggregateExperimentComparisons({
    binding: input.evidence.binding,
    legs: input.evidence.selectorPairwiseLegs.map(([, record]) => record),
  })
  const byLogical = new Map(aggregated.map(row => [row.logicalKey, row]))
  const byPair = new Map(aggregated.map(row => [pairKey(row.aId, row.bId), row]))
  const prePlan = input.round.prePlanComparisonKeys.map(key => {
    const row = byLogical.get(key)
    if (!row) throw new AnchorExperimentAuthorityError('PREPLAN_COMPARISON_EVIDENCE_MISSING', 'pre-plan 证据消失。')
    return row
  })
  const planned: AggregatedExperimentComparison[] = []
  for (const pair of input.pairwise.plan.pairs) {
    const row = byPair.get(pairKey(pair.leftId, pair.rightId))
    if (!row) return undefined
    planned.push(row)
  }
  const allowedKeys = new Set([...prePlan, ...planned].map(row => row.logicalKey))
  const extras = aggregated.filter(row => !allowedKeys.has(row.logicalKey))
  if (extras.length) {
    throw new AnchorExperimentAuthorityError(
      'UNPLANNED_COMPLETE_COMPARISON',
      '存在既不属于 pre-plan、也不属于本轮冻结 plan 的完整比较；禁止影响 draft。',
    )
  }
  const candidates = bestRankingCandidates({
    evidence: input.evidence, catalog: input.catalog, feedback: input.round.feedback,
  })
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const requiredIds = (input.round.feedback?.strongerChallengerIds ?? [])
    .filter(id => candidateById.get(id)?.eligibility === 'eligible')
    .sort()
  const selected = rankPortraits(candidates, {
    topK: input.evidence.binding.targetK,
    comparisons: [...prePlan, ...planned].map(row => row.result),
    diversityStrength: input.policy.diversityStrength,
    familyCap: input.policy.familyCap,
    requiredIds,
  })
  if (selected.length !== input.evidence.binding.targetK) {
    throw new AnchorExperimentAuthorityError('EXACT_K_NOT_REACHED', 'selector 无法形成 exact-K。')
  }
  const keep = Object.freeze(selected.map(row => row.id))
  const finalScores = Object.freeze(Object.fromEntries(selected.map(row => [row.id, row.finalScore])))
  return immutable({
    bindingHash: input.evidence.binding.stateNamespaceHash,
    keep,
    scores: finalScores,
    selectionHash: anchorExperimentSelectionHash({
      binding: input.evidence.binding, keep, scores: finalScores,
    }),
  })
}

function selectorEvidenceSlice(input: Readonly<{
  evidence: AnchorExperimentEvidenceView
  visibleHighIds: ReadonlySet<string>
  comparisonKeys: ReadonlySet<string>
}>): AnchorExperimentEvidenceView {
  const aggregated = aggregateExperimentComparisons({
    binding: input.evidence.binding,
    legs: input.evidence.selectorPairwiseLegs.map(([, record]) => record),
  })
  const byLogical = new Map(aggregated.map(row => [row.logicalKey, row]))
  const allowedPairs = new Set<string>()
  for (const logicalKey of input.comparisonKeys) {
    const row = byLogical.get(logicalKey)
    if (!row) {
      throw new AnchorExperimentAuthorityError(
        'SELECTOR_LINEAGE_COMPARISON_MISSING',
        '历史 selector round 引用的完整 AB/BA 证据缺失。',
      )
    }
    allowedPairs.add(pairKey(row.aId, row.bId))
  }
  return Object.freeze({
    binding: input.evidence.binding,
    candidateIds: input.evidence.candidateIds,
    selectorScores: Object.freeze(input.evidence.selectorScores.filter(([, stored]) =>
      stored.assessment.detail === 'low' || input.visibleHighIds.has(stored.assessment.id))),
    auditScores: Object.freeze([]),
    selectorPairwiseLegs: Object.freeze(input.evidence.selectorPairwiseLegs.filter(([, record]) =>
      allowedPairs.has(pairKey(record.aId, record.bId)))),
    auditPairwiseLegs: Object.freeze([]),
    providerOperations: Object.freeze([]),
  })
}

function auditEvidenceSlice(input: Readonly<{
  evidence: AnchorExperimentAuditEvidenceView
  selectedIds: ReadonlySet<string>
  remainingIds: ReadonlySet<string>
  promotedIds: ReadonlySet<string>
  pairKeys: ReadonlySet<string>
}>): AnchorExperimentAuditEvidenceView {
  return Object.freeze({
    binding: input.evidence.binding,
    candidateIds: input.evidence.candidateIds,
    auditScores: Object.freeze(input.evidence.auditScores.filter(([, stored]) => {
      const assessment = stored.assessment
      return assessment.detail === 'high'
        ? input.selectedIds.has(assessment.id) || input.promotedIds.has(assessment.id)
        : input.remainingIds.has(assessment.id)
    })),
    auditPairwiseLegs: Object.freeze(input.evidence.auditPairwiseLegs.filter(([, record]) =>
      input.pairKeys.has(pairKey(record.aId, record.bId)))),
    // Operation rows prove dispatch/evidence integrity at state-load time. They
    // have no round identity, so including later-round reservations would
    // incorrectly rewrite an earlier terminal audit.
    providerOperations: Object.freeze([]),
  })
}

function reconstructHistoricalAudit(input: Readonly<{
  binding: AnchorExperimentRunBinding
  draft: AnchorExperimentDraft
  auditEvidence: AnchorExperimentAuditEvidenceView
  auditRound: number
  recompute: AnchorLabHistoricalAuditRecompute
}>): AnchorExperimentAuditReport {
  const selectedIds = new Set(input.draft.keep)
  const remainingIds = new Set(input.auditEvidence.candidateIds
    .filter(id => !selectedIds.has(id)))
  const empty = new Set<string>()
  const baseEvidence = auditEvidenceSlice({
    evidence: input.auditEvidence,
    selectedIds,
    remainingIds,
    promotedIds: empty,
    pairKeys: empty,
  })
  const afterLow = input.recompute(baseEvidence, input.draft, input.auditRound)
  if (!afterLow.promotionPlan) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_LINEAGE_AUDIT_EVIDENCE_INCOMPLETE',
      '无法从保留证据重建历史 audit promotion plan。',
    )
  }
  const promotedIds = new Set(afterLow.promotionPlan.promotionIds)
  const promotionEvidence = auditEvidenceSlice({
    evidence: input.auditEvidence,
    selectedIds,
    remainingIds,
    promotedIds,
    pairKeys: empty,
  })
  const afterPromotion = input.recompute(promotionEvidence, input.draft, input.auditRound)
  if (!afterPromotion.pairPlan) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_LINEAGE_AUDIT_EVIDENCE_INCOMPLETE',
      '无法从保留证据重建历史 audit pair plan。',
    )
  }
  const pairKeys = new Set(afterPromotion.pairPlan.pairs
    .map(pair => pairKey(pair.aId, pair.bId)))
  const finalEvidence = auditEvidenceSlice({
    evidence: input.auditEvidence,
    selectedIds,
    remainingIds,
    promotedIds,
    pairKeys,
  })
  const completed = input.recompute(finalEvidence, input.draft, input.auditRound)
  if (completed.report.status !== 'FAIL'
    || completed.report.stage !== 'complete'
    || completed.report.round !== input.auditRound
    || completed.report.selectionHash !== input.draft.selectionHash) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_LINEAGE_TERMINAL_FAIL_REQUIRED',
      '后续 selector round 必须由可重建的完整 terminal FAIL 派生。',
    )
  }
  return completed.report
}

function recomputeSelectorRoundLineage(input: Readonly<{
  binding: AnchorExperimentRunBinding
  catalog: FrozenAnchorLabCandidateCatalog
  policy: AnchorLabSelectionPolicy
  targetRound: FrozenSelectorRound
  evidence: AnchorExperimentEvidenceView
  auditEvidence: AnchorExperimentAuditEvidenceView
  recomputeHistoricalAudit?: AnchorLabHistoricalAuditRecompute
}>): FrozenSelectorRound {
  let round = createFrozenSelectorRound({
    binding: input.binding,
    round: 1,
    existingComparisons: [],
  })
  if (input.targetRound.round === 1) return round
  if (!input.recomputeHistoricalAudit) {
    throw new AnchorExperimentAuthorityError(
      'SELECTOR_LINEAGE_AUDIT_AUTHORITY_REQUIRED',
      '第 2 轮及以后必须由隔离 audit authority 重建上一轮 FAIL。',
    )
  }
  const allAggregated = aggregateExperimentComparisons({
    binding: input.binding,
    legs: input.evidence.selectorPairwiseLegs.map(([, record]) => record),
  })
  const byPair = new Map(allAggregated.map(row => [pairKey(row.aId, row.bId), row]))
  const byLogical = new Map(allAggregated.map(row => [row.logicalKey, row]))
  const visibleHighIds = new Set<string>()

  for (let completedRound = 1; completedRound < input.targetRound.round; completedRound += 1) {
    const beforeHigh = selectorEvidenceSlice({
      evidence: input.evidence,
      visibleHighIds,
      comparisonKeys: new Set(round.prePlanComparisonKeys),
    })
    const refinement = refinementFromEvidence({
      evidence: beforeHigh,
      catalog: input.catalog,
      round,
    })
    if (!refinement) {
      throw new AnchorExperimentAuthorityError(
        'SELECTOR_LINEAGE_SELECTOR_EVIDENCE_INCOMPLETE',
        '无法从保留 low 证据重建历史 refinement plan。',
      )
    }
    for (const id of refinement.plan.candidateIds) visibleHighIds.add(id)
    const beforePairPlan = selectorEvidenceSlice({
      evidence: input.evidence,
      visibleHighIds,
      comparisonKeys: new Set(round.prePlanComparisonKeys),
    })
    const pairwise = pairwiseFromEvidence({
      evidence: beforePairPlan,
      catalog: input.catalog,
      policy: input.policy,
      round,
      refinement,
    })
    if (!pairwise) {
      throw new AnchorExperimentAuthorityError(
        'SELECTOR_LINEAGE_SELECTOR_EVIDENCE_INCOMPLETE',
        '无法从保留 high 证据重建历史 pairwise plan。',
      )
    }
    const usedComparisons = new Map<string, AggregatedExperimentComparison>()
    for (const key of round.prePlanComparisonKeys) {
      const row = byLogical.get(key)
      if (!row) {
        throw new AnchorExperimentAuthorityError(
          'SELECTOR_LINEAGE_COMPARISON_MISSING',
          '历史 pre-plan comparison 已丢失。',
        )
      }
      usedComparisons.set(row.logicalKey, row)
    }
    for (const pair of pairwise.plan.pairs) {
      const row = byPair.get(pairKey(pair.leftId, pair.rightId))
      if (!row) {
        throw new AnchorExperimentAuthorityError(
          'SELECTOR_LINEAGE_SELECTOR_EVIDENCE_INCOMPLETE',
          '历史 selector pair plan 缺少完整 AB/BA。',
        )
      }
      usedComparisons.set(row.logicalKey, row)
    }
    const draftEvidence = selectorEvidenceSlice({
      evidence: input.evidence,
      visibleHighIds,
      comparisonKeys: new Set(usedComparisons.keys()),
    })
    const draft = draftFromEvidence({
      evidence: draftEvidence,
      catalog: input.catalog,
      policy: input.policy,
      round,
      refinement,
      pairwise,
    })
    if (!draft) {
      throw new AnchorExperimentAuthorityError(
        'SELECTOR_LINEAGE_SELECTOR_EVIDENCE_INCOMPLETE',
        '无法从保留 AB/BA 证据重建历史 exact-K draft。',
      )
    }
    const failed = reconstructHistoricalAudit({
      binding: input.binding,
      draft,
      auditEvidence: input.auditEvidence,
      auditRound: completedRound,
      recompute: input.recomputeHistoricalAudit,
    })
    const feedback = createAnchorLabSelectorFeedback({
      binding: input.binding,
      failedAuditRound: completedRound,
      failedSelectionHash: draft.selectionHash,
      strongerChallengerIds: failed.strongerChallengerIds,
      disqualifiedSelectedIds: failed.disqualifiedSelectedIds,
    })
    round = createFrozenSelectorRound({
      binding: input.binding,
      round: completedRound + 1,
      existingComparisons: [...usedComparisons.values()],
      priorSelectionHash: draft.selectionHash,
      feedback,
    })
  }
  return round
}

function validateFactoryInput(input: CreateAnchorLabAuthorityInput): void {
  assertPhotoAnchorLabCodexExperimentId(input.binding.experimentId)
  if (input.candidateCatalog.technicalId !== PHOTO_ANCHOR_LAB_CODEX_ID
    || input.candidateCatalog.datasetFingerprint !== input.binding.datasetFingerprint
    || input.selectionPolicy.preferenceHash !== input.binding.preferenceHash
    || !validHash(input.candidateCatalog.catalogHash)
    || !validHash(input.selectorRound.roundHash)) {
    throw new AnchorExperimentAuthorityError('AUTHORITY_IDENTITY_MISMATCH', 'catalog/policy/round 未绑定当前实验。')
  }
  const catalogIdentity = {
    protocol: input.candidateCatalog.protocol,
    technicalId: input.candidateCatalog.technicalId,
    datasetFingerprint: input.candidateCatalog.datasetFingerprint,
    sourceSnapshotHash: input.binding.sourceSnapshotHash,
    candidates: input.candidateCatalog.candidates,
  }
  if (canonicalHash(catalogIdentity) !== input.candidateCatalog.catalogHash) {
    throw new AnchorExperimentAuthorityError('CATALOG_HASH_MISMATCH', 'candidate catalog hash 无法重算。')
  }
  if (input.selectionPolicy.diversityStrength < 0 || input.selectionPolicy.diversityStrength > 1
    || !Number.isFinite(input.selectionPolicy.diversityStrength)
    || (input.selectionPolicy.diversityStrength > 0
      && (input.selectionPolicy.diversityProtocol !== 'catalog-v1'
        || input.candidateCatalog.candidates.some(row => row.diversityTags.length === 0)))
    || (input.selectionPolicy.diversityStrength === 0
      && input.selectionPolicy.diversityProtocol !== 'disabled')) {
    throw new AnchorExperimentAuthorityError(
      'DIVERSITY_CONTRACT_UNAVAILABLE',
      '非零 diversity 必须由 A/B/C 共用且完整的 catalog-v1 tags 支撑。',
    )
  }
  const expectedRound = createFrozenSelectorRound({
    binding: input.binding,
    round: input.selectorRound.round,
    existingComparisons: input.selectorRound.prePlanComparisonKeys.map(logicalKey => ({
      logicalKey,
      aId: 'placeholder-a', bId: 'placeholder-b', abCacheKey: '0'.repeat(64), baCacheKey: '1'.repeat(64),
      result: { leftId: 'placeholder-a', rightId: 'placeholder-b', leftOutcome: 0.5 }, terminal: 'tie',
    })),
    priorSelectionHash: input.selectorRound.priorSelectionHash,
    feedback: input.selectorRound.feedback,
  })
  if (expectedRound.roundHash !== input.selectorRound.roundHash
    || !sameStrings(expectedRound.prePlanComparisonKeys, input.selectorRound.prePlanComparisonKeys)) {
    throw new AnchorExperimentAuthorityError('SELECTOR_ROUND_HASH_MISMATCH', 'selector round hash 无法重算。')
  }
}

export function createAnchorLabDerivedAuthority(
  input: CreateAnchorLabAuthorityInput,
): AnchorExperimentDerivedAuthority {
  validateFactoryInput(input)
  const catalogIds = input.candidateCatalog.candidates.map(row => row.id)
  const assertUniverse = (evidence: AnchorExperimentEvidenceView) => {
    if (evidence.binding.stateNamespaceHash !== input.binding.stateNamespaceHash
      || !sameStrings(evidence.candidateIds, catalogIds)) {
      throw new AnchorExperimentAuthorityError(
        'AUTHORITY_CANDIDATE_UNIVERSE_MISMATCH',
        'state candidate universe 与冻结 catalog 不一致。',
      )
    }
  }
  return Object.freeze({
    expectedPersistedPhase: input.expectedPersistedPhase,
    expectedSelectorRound: input.selectorRound,
    recomputeSelectorRound: (evidence, auditEvidence) => {
      assertUniverse(evidence)
      if (auditEvidence.binding.stateNamespaceHash !== input.binding.stateNamespaceHash
        || !sameStrings(auditEvidence.candidateIds, catalogIds)) {
        throw new AnchorExperimentAuthorityError(
          'AUTHORITY_AUDIT_UNIVERSE_MISMATCH',
          'audit evidence universe 与冻结 catalog 不一致。',
        )
      }
      return recomputeSelectorRoundLineage({
        binding: input.binding,
        catalog: input.candidateCatalog,
        policy: input.selectionPolicy,
        targetRound: input.selectorRound,
        evidence,
        auditEvidence,
        recomputeHistoricalAudit: input.recomputeHistoricalAudit,
      })
    },
    ...(input.expectedAuditRound === undefined ? {} : { expectedAuditRound: input.expectedAuditRound }),
    recomputeRefinementCheckpoint: evidence => {
      assertUniverse(evidence)
      return refinementFromEvidence({
        evidence, catalog: input.candidateCatalog, round: input.selectorRound,
      })
    },
    recomputePairwiseCheckpoint: (evidence, refinement) => {
      assertUniverse(evidence)
      return pairwiseFromEvidence({
        evidence,
        catalog: input.candidateCatalog,
        policy: input.selectionPolicy,
        round: input.selectorRound,
        refinement,
      })
    },
    recomputeDraft: (evidence, refinement, pairwise) => {
      assertUniverse(evidence)
      return draftFromEvidence({
        evidence,
        catalog: input.candidateCatalog,
        policy: input.selectionPolicy,
        round: input.selectorRound,
        refinement,
        pairwise,
      })
    },
    ...(input.recomputeAudit ? { recomputeAudit: input.recomputeAudit } : {}),
  })
}
