import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PHOTO_ANCHOR_LAB_CODEX_ID,
  PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA,
  photoAnchorLabCodexStateDirectory,
} from './anchor-lab-codex-identity.ts'
import type { FrozenAnchorAbcManifest } from './anchor-experiment-manifest.ts'
import type { ReferenceSheetFaceFocus } from './engine.ts'
import type { PortraitExperimentArm, PortraitEvaluationRole } from './evaluation-profile.ts'
import type {
  FocusedPortraitAnchorAssessment,
} from './portrait-anchor-vision.ts'
import {
  PORTRAIT_ANCHOR_DIMENSION_IDS,
  PORTRAIT_ANCHOR_WEIGHTS,
  validatePortraitAnchorAssessment,
  validatePortraitAnchorPairwise,
  type PortraitAnchorAssessment,
} from './portrait-anchor-rubric.ts'
import {
  assertPortraitBaselineAssessmentConsistent,
  type PairwiseRawDecision,
  type PortraitBaselineAssessment,
} from './portrait-vision.ts'
import {
  PORTRAIT_BASELINE_RUBRIC_VERSION,
  PORTRAIT_BASELINE_WEIGHTS,
  PORTRAIT_DIMENSION_IDS,
} from './rubric.ts'
import type { HighRefinementPlan, PairwiseBudgetPlan } from './selection-budget.ts'
import { HARNESS_REJECTED_RESPONSE_CODES } from './harness-vision.ts'

export const ANCHOR_EXPERIMENT_STATE_SCHEMA = 'photo-filter-anchor-experiment-state/v3' as const
export const ANCHOR_EXPERIMENT_BINDING_SCHEMA = 'photo-filter-anchor-experiment-binding/v1' as const

type Hash = string
export type ExperimentDetail = 'low' | 'high'

export interface AnchorExperimentRunBinding {
  readonly schemaVersion: typeof ANCHOR_EXPERIMENT_BINDING_SCHEMA
  readonly experimentId: string
  readonly arm: PortraitExperimentArm
  readonly manifestHash: Hash
  readonly sourceSnapshotHash: Hash
  readonly datasetFingerprint: Hash
  readonly candidateScope: 'people_only'
  readonly targetK: number
  readonly seed: string
  readonly preferenceHash: Hash
  readonly route: Readonly<{
    provider: string
    model: string
    protocol: string
    reasoningEffort?: string
  }>
  readonly routeIdentityHash: Hash
  readonly profileProtocol: string
  readonly rubricVersion: string
  readonly rubricContentHash: Hash
  readonly contracts: Readonly<{
    selectorLow: Hash
    selectorHigh: Hash
    selectorPairwise: Hash
    auditLow: Hash
    auditHigh: Hash
    auditPairwise: Hash
  }>
  readonly budget: Readonly<{
    highCap: number
    pairwisePairCap: number
    auditCallCapPerTurn: number
    maxCompleteAuditRounds: number
  }>
  readonly visual?: Readonly<{
    anchorPackHash: Hash
    anchorSheetSha256: Hash
    layoutProtocolHash: Hash
    qualityReceiptHash: Hash
    legendHash: Hash
  }>
  readonly stateNamespaceHash: Hash
}

interface ExperimentAssessmentBase {
  readonly id: string
  readonly role: PortraitEvaluationRole
  readonly detail: ExperimentDetail
  readonly eligibility: 'eligible' | 'ineligible' | 'needs_review'
  /** Locally normalized sortable value; null means the photo may not enter ranking. */
  readonly score: number | null
  readonly scoreInterval: readonly [number, number] | null
  /** Legacy keeps its provider interval; B/C use a clearly labelled local derivation. */
  readonly scoreIntervalSource: 'provider' | 'local_confidence_radius'
  readonly overallConfidence: number
  readonly summary: string
  readonly primarySubjectHeadFocus?: ReferenceSheetFaceFocus
}

export interface LegacyExperimentAssessment extends ExperimentAssessmentBase {
  readonly contract: 'legacy-portrait-baseline/v1'
  readonly raw: PortraitBaselineAssessment
}

export interface AnchorRubricExperimentAssessment extends ExperimentAssessmentBase {
  readonly contract: 'portrait-anchor-rubric/v1'
  readonly raw: PortraitAnchorAssessment | FocusedPortraitAnchorAssessment
}

export type ExperimentAssessment = LegacyExperimentAssessment | AnchorRubricExperimentAssessment

export interface ExperimentPairwiseDecision {
  readonly contract: 'legacy-portrait-pairwise/v1' | 'portrait-anchor-pairwise/v1'
  readonly order: 'AB' | 'BA'
  /** Normalized to the stable A/B IDs used by the caller, not FIRST/SECOND order. */
  readonly result: 'left' | 'right' | 'tie' | 'reject_both'
  readonly weightedMargin: number
  readonly confidence: number
  readonly reason: string
  readonly raw: unknown
}

export interface ExperimentPairwiseLegRecord {
  readonly aId: string
  readonly bId: string
  readonly role: PortraitEvaluationRole
  readonly order: 'AB' | 'BA'
  readonly decision: ExperimentPairwiseDecision
  readonly cacheKey: Hash
  /** C binds the dynamic candidate sheet/focus/source receipt; A/B omit it. */
  readonly pairCandidateReceiptHash?: Hash
}

export type ExperimentProviderOperationKind = 'score' | 'pairwise'
export type ExperimentProviderOperationStatus = 'reserved' | 'succeeded' | 'failed'

export interface ExperimentProviderOperationRequest {
  readonly cacheKey: Hash
  readonly role: PortraitEvaluationRole
  readonly kind: ExperimentProviderOperationKind
  readonly detail?: ExperimentDetail
  readonly candidateId?: string
  readonly aId?: string
  readonly bId?: string
  readonly order?: 'AB' | 'BA'
  readonly pairCandidateReceiptHash?: Hash
}

export interface ExperimentProviderOperation {
  readonly cacheKey: Hash
  readonly role: PortraitEvaluationRole
  readonly kind: ExperimentProviderOperationKind
  /** Score operations bind low/high explicitly; pairwise operations omit it. */
  readonly detail?: ExperimentDetail
  readonly candidateId?: string
  readonly aId?: string
  readonly bId?: string
  readonly order?: 'AB' | 'BA'
  readonly pairCandidateReceiptHash?: Hash
  readonly status: ExperimentProviderOperationStatus
  readonly attempts: number
  readonly lastFailureCode?: string
}

export interface AnchorExperimentDraft {
  readonly bindingHash: Hash
  readonly keep: readonly string[]
  readonly scores: Readonly<Record<string, number>>
  readonly selectionHash: Hash
}

export function anchorExperimentSelectionHash(input: Readonly<{
  binding: AnchorExperimentRunBinding
  keep: readonly string[]
  scores: Readonly<Record<string, number>>
}>): string {
  return sha256(JSON.stringify(canonical({
    protocol: 'photo-filter-anchor-selection/v1',
    bindingHash: input.binding.stateNamespaceHash,
    keep: input.keep,
    scores: input.scores,
  })))
}

export interface AnchorExperimentAuditReport {
  readonly schemaVersion: 'photo-filter-anchor-audit/v1'
  readonly round: number
  readonly bindingHash: Hash
  readonly selectionHash: Hash
  readonly status: 'PASS' | 'FAIL' | 'INCOMPLETE'
  readonly stage: 'selected_high' | 'remaining_low' | 'promotion_high' | 'pairwise' | 'complete'
  readonly selectedIds: readonly string[]
  readonly remainingCount: number
  readonly pairwiseRemainingCount: number
  readonly strongerChallengerIds: readonly string[]
  readonly disqualifiedSelectedIds: readonly string[]
}

export type AnchorExperimentExpectedPhase =
  | 'baseline'
  | 'refinement'
  | 'pairwise'
  | 'selection'
  | 'audit'

export interface AnchorExperimentSelectorRoundFeedback {
  readonly failedAuditRound: number
  readonly failedSelectionHash: Hash
  readonly strongerChallengerIds: readonly string[]
  readonly disqualifiedSelectedIds: readonly string[]
  readonly feedbackHash: Hash
}

export interface AnchorExperimentSelectorRound {
  readonly protocol: typeof PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA
  readonly technicalId: typeof PHOTO_ANCHOR_LAB_CODEX_ID
  readonly round: number
  readonly priorSelectionHash?: Hash
  readonly feedback?: AnchorExperimentSelectorRoundFeedback
  readonly prePlanComparisonKeys: readonly Hash[]
  readonly roundHash: Hash
}

/**
 * Read-only input to deterministic planning/ranking/audit code. Derived fields
 * are deliberately absent, so a persisted checkpoint or PASS cannot validate
 * itself by being visible to its own recomputation callback.
 */
export interface AnchorExperimentEvidenceView {
  readonly binding: AnchorExperimentRunBinding
  readonly candidateIds: readonly string[]
  readonly selectorScores: readonly (readonly [string, StoredExperimentAssessment])[]
  readonly auditScores: readonly (readonly [string, StoredExperimentAssessment])[]
  readonly selectorPairwiseLegs: readonly (readonly [string, ExperimentPairwiseLegRecord])[]
  readonly auditPairwiseLegs: readonly (readonly [string, ExperimentPairwiseLegRecord])[]
  readonly providerOperations: readonly (readonly [string, ExperimentProviderOperation])[]
}

export interface AnchorExperimentAuditEvidenceView {
  readonly binding: AnchorExperimentRunBinding
  readonly candidateIds: readonly string[]
  readonly auditScores: readonly (readonly [string, StoredExperimentAssessment])[]
  readonly auditPairwiseLegs: readonly (readonly [string, ExperimentPairwiseLegRecord])[]
  readonly providerOperations: readonly (readonly [string, ExperimentProviderOperation])[]
}

/**
 * Deterministic recomputation boundary for every derived artifact that could
 * authorize more paid work or a final PASS. Persistence is only storage: a
 * self-consistent JSON object is never authority by itself.
 */
export interface AnchorExperimentDerivedAuthority {
  /** Phase expected on disk before this DSH command; never inferred from JSON. */
  readonly expectedPersistedPhase: AnchorExperimentExpectedPhase
  /** Durable selector planning boundary supplied by the named Anchor Lab route. */
  readonly expectedSelectorRound?: AnchorExperimentSelectorRound
  /**
   * Rebuild the selector round from verified score/pairwise/audit evidence.
   * This is mandatory for later rounds: a persisted JSON feedback object is
   * storage, not proof that the preceding isolated audit really failed.
   */
  recomputeSelectorRound?: (
    evidence: AnchorExperimentEvidenceView,
    auditEvidence: AnchorExperimentAuditEvidenceView,
  ) => AnchorExperimentSelectorRound
  /** Required only for audit; binds resume to one deterministic audit round. */
  readonly expectedAuditRound?: number
  recomputeRefinementCheckpoint?: (
    evidence: AnchorExperimentEvidenceView,
  ) => AnchorExperimentState['refinementCheckpoint']
  recomputePairwiseCheckpoint?: (
    evidence: AnchorExperimentEvidenceView,
    verifiedRefinement: NonNullable<AnchorExperimentState['refinementCheckpoint']>,
  ) => AnchorExperimentState['pairwiseCheckpoint']
  recomputeDraft?: (
    evidence: AnchorExperimentEvidenceView,
    verifiedRefinement: NonNullable<AnchorExperimentState['refinementCheckpoint']>,
    verifiedPairwise: NonNullable<AnchorExperimentState['pairwiseCheckpoint']>,
  ) => AnchorExperimentDraft | undefined
  recomputeAudit?: (
    evidence: AnchorExperimentAuditEvidenceView,
    verifiedDraft: AnchorExperimentDraft,
    verifiedRefinement: NonNullable<AnchorExperimentState['refinementCheckpoint']>,
    verifiedPairwise: NonNullable<AnchorExperimentState['pairwiseCheckpoint']>,
    expectedRound: number,
  ) => AnchorExperimentAuditReport | undefined
}

export interface StoredExperimentAssessment {
  readonly assessment: ExperimentAssessment
  readonly cacheKey: Hash
}

interface PersistedAnchorExperimentState {
  schemaVersion: typeof ANCHOR_EXPERIMENT_STATE_SCHEMA
  binding: AnchorExperimentRunBinding
  candidateIds: readonly string[]
  selectorScores: readonly (readonly [string, StoredExperimentAssessment])[]
  auditScores: readonly (readonly [string, StoredExperimentAssessment])[]
  selectorPairwiseLegs: readonly (readonly [string, ExperimentPairwiseLegRecord])[]
  auditPairwiseLegs: readonly (readonly [string, ExperimentPairwiseLegRecord])[]
  providerOperations: readonly (readonly [string, ExperimentProviderOperation])[]
  selectorRound?: AnchorExperimentSelectorRound
  refinementCheckpoint?: Readonly<{ contextKey: Hash; plan: HighRefinementPlan }>
  pairwiseCheckpoint?: Readonly<{ contextKey: Hash; plan: PairwiseBudgetPlan }>
  draft?: AnchorExperimentDraft
  audit?: AnchorExperimentAuditReport
  paidCalls: AnchorExperimentState['paidCalls']
}

export class AnchorExperimentStateError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentStateError'
    this.code = code
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function safeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\u0000')
}

function safeCandidateId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
}

function assertRunBinding(binding: AnchorExperimentRunBinding): void {
  if (!Object.isFrozen(binding)
    || binding.schemaVersion !== ANCHOR_EXPERIMENT_BINDING_SCHEMA
    || !safeToken(binding.experimentId) || binding.candidateScope !== 'people_only'
    || !['A', 'B', 'C'].includes(binding.arm)
    || !Number.isInteger(binding.targetK) || binding.targetK <= 0
    || !safeToken(binding.seed)
    || !safeToken(binding.route?.provider) || !safeToken(binding.route?.model)
    || !safeToken(binding.route?.protocol)
    || (binding.route.reasoningEffort !== undefined && !safeToken(binding.route.reasoningEffort))
    || !safeToken(binding.profileProtocol) || !safeToken(binding.rubricVersion)
    || !binding.budget
    || !Number.isInteger(binding.budget.highCap) || binding.budget.highCap < binding.targetK
    || !Number.isInteger(binding.budget.pairwisePairCap) || binding.budget.pairwisePairCap < 0
    || !Number.isInteger(binding.budget.auditCallCapPerTurn) || binding.budget.auditCallCapPerTurn < 1
    || !Number.isInteger(binding.budget.maxCompleteAuditRounds) || binding.budget.maxCompleteAuditRounds < 1) {
    throw new AnchorExperimentStateError('EXPERIMENT_BINDING_INVALID', '实验运行 binding 基础字段无效。')
  }
  const hashes = [
    binding.manifestHash,
    binding.sourceSnapshotHash,
    binding.datasetFingerprint,
    binding.preferenceHash,
    binding.routeIdentityHash,
    binding.rubricContentHash,
    ...Object.values(binding.contracts ?? {}),
    binding.stateNamespaceHash,
  ]
  if (hashes.length !== 13 || hashes.some(value => !validHash(value))) {
    throw new AnchorExperimentStateError('EXPERIMENT_BINDING_INVALID', '实验运行 binding 哈希字段不完整。')
  }
  const expectedRoute = sha256([
    binding.route.provider,
    binding.route.model,
    binding.route.protocol,
    binding.route.reasoningEffort ?? '',
  ].join('\u0000'))
  const expectedNamespace = sha256([
    ANCHOR_EXPERIMENT_BINDING_SCHEMA,
    binding.experimentId,
    binding.arm,
    binding.manifestHash,
    binding.routeIdentityHash,
    binding.datasetFingerprint,
  ].join('\u0000'))
  if (binding.routeIdentityHash !== expectedRoute || binding.stateNamespaceHash !== expectedNamespace) {
    throw new AnchorExperimentStateError(
      'EXPERIMENT_BINDING_IDENTITY_MISMATCH',
      '实验 binding 的 route 或 namespace 不是由冻结字段重算得到。',
    )
  }
  if (binding.arm === 'C') {
    if (!binding.visual || Object.values(binding.visual).some(value => !validHash(value))) {
      throw new AnchorExperimentStateError('EXPERIMENT_VISUAL_BINDING_INVALID', 'C 缺少完整视觉身份。')
    }
  } else if (binding.visual) {
    throw new AnchorExperimentStateError('EXPERIMENT_VISUAL_BINDING_INVALID', 'A/B 不得携带视觉身份。')
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function immutableCanonicalClone<T>(value: T): T {
  return deepFreeze(canonical(value) as T)
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function validateSelectorRound(
  value: AnchorExperimentSelectorRound | undefined,
  binding: AnchorExperimentRunBinding,
  allowed: ReadonlySet<string>,
): AnchorExperimentSelectorRound | undefined {
  if (value === undefined) return undefined
  if (value.protocol !== PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA
    || value.technicalId !== PHOTO_ANCHOR_LAB_CODEX_ID
    || !Number.isInteger(value.round) || value.round < 1
    || value.round > binding.budget.maxCompleteAuditRounds
    || !validHash(value.roundHash)
    || !Array.isArray(value.prePlanComparisonKeys)
    || value.prePlanComparisonKeys.some(key => !validHash(key))
    || new Set(value.prePlanComparisonKeys).size !== value.prePlanComparisonKeys.length
    || JSON.stringify(value.prePlanComparisonKeys) !== JSON.stringify([...value.prePlanComparisonKeys].sort())) {
    throw new AnchorExperimentStateError('PERSISTED_SELECTOR_ROUND_INVALID', 'selector round 基础字段无效。')
  }
  if (value.round === 1) {
    if (value.priorSelectionHash !== undefined || value.feedback !== undefined
      || value.prePlanComparisonKeys.length !== 0) {
      throw new AnchorExperimentStateError(
        'PERSISTED_SELECTOR_ROUND_INVALID',
        '首轮 selector round 必须没有历史 selection、feedback 或 pre-plan comparison。',
      )
    }
  } else {
    const feedback = value.feedback
    if (!validHash(value.priorSelectionHash) || !feedback
      || feedback.failedAuditRound !== value.round - 1
      || feedback.failedSelectionHash !== value.priorSelectionHash
      || !validHash(feedback.feedbackHash)
      || !Array.isArray(feedback.strongerChallengerIds)
      || !Array.isArray(feedback.disqualifiedSelectedIds)) {
      throw new AnchorExperimentStateError('PERSISTED_SELECTOR_ROUND_INVALID', '后续 selector round feedback 无效。')
    }
    const stronger = [...feedback.strongerChallengerIds]
    const disqualified = [...feedback.disqualifiedSelectedIds]
    if (new Set(stronger).size !== stronger.length || new Set(disqualified).size !== disqualified.length
      || JSON.stringify(stronger) !== JSON.stringify([...stronger].sort())
      || JSON.stringify(disqualified) !== JSON.stringify([...disqualified].sort())
      || stronger.some(id => !allowed.has(id) || disqualified.includes(id))
      || disqualified.some(id => !allowed.has(id))) {
      throw new AnchorExperimentStateError('PERSISTED_SELECTOR_ROUND_INVALID', 'selector feedback 集合无效。')
    }
    const feedbackIdentity = {
      technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
      bindingHash: binding.stateNamespaceHash,
      failedAuditRound: feedback.failedAuditRound,
      failedSelectionHash: feedback.failedSelectionHash,
      strongerChallengerIds: stronger,
      disqualifiedSelectedIds: disqualified,
    }
    if (canonicalHash(feedbackIdentity) !== feedback.feedbackHash) {
      throw new AnchorExperimentStateError('PERSISTED_SELECTOR_ROUND_INVALID', 'selector feedback hash 不匹配。')
    }
  }
  const roundIdentity = {
    protocol: PHOTO_ANCHOR_LAB_CODEX_SELECTOR_ROUND_SCHEMA,
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    bindingHash: binding.stateNamespaceHash,
    round: value.round,
    ...(value.priorSelectionHash ? { priorSelectionHash: value.priorSelectionHash } : {}),
    ...(value.feedback ? { feedback: value.feedback } : {}),
    prePlanComparisonKeys: value.prePlanComparisonKeys,
  }
  if (canonicalHash(roundIdentity) !== value.roundHash) {
    throw new AnchorExperimentStateError('PERSISTED_SELECTOR_ROUND_INVALID', 'selector round hash 不匹配。')
  }
  return immutableCanonicalClone(value)
}

function finiteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= minimum && value <= maximum
}

function assertLegacyAssessmentPersisted(raw: PortraitBaselineAssessment): void {
  if (!raw || raw.rubricVersion !== PORTRAIT_BASELINE_RUBRIC_VERSION
    || typeof raw.id !== 'string' || !raw.id
    || !finiteInRange(raw.overallConfidence, 0, 1)
    || !finiteInRange(raw.eligibility?.assessability, 0, 1)
    || !Array.isArray(raw.scoreInterval) || raw.scoreInterval.length !== 2
    || !raw.scoreInterval.every(value => finiteInRange(value, 0, 100))) {
    throw new AnchorExperimentStateError('PERSISTED_SCORE_INVALID', '旧基线持久化评分结构无效。')
  }
  for (const id of PORTRAIT_DIMENSION_IDS) {
    if (!finiteInRange(raw.dimensionScores?.[id], 0, 100)
      || !finiteInRange(raw.dimensionConfidences?.[id], 0, 1)
      || !Array.isArray(raw.dimensionEvidence?.[id])) {
      throw new AnchorExperimentStateError('PERSISTED_SCORE_INVALID', `旧基线 ${id} 无效。`)
    }
  }
  assertPortraitBaselineAssessmentConsistent(raw)
  const computed = Math.round(PORTRAIT_DIMENSION_IDS.reduce(
    (sum, id) => sum + raw.dimensionScores[id] * PORTRAIT_BASELINE_WEIGHTS[id] / 100,
    0,
  ) * 10_000) / 10_000
  if (raw.baselineScore !== (raw.eligibility.status === 'eligible' ? computed : null)) {
    throw new AnchorExperimentStateError('PERSISTED_SCORE_INVALID', '旧基线总分未由冻结权重重算。')
  }
}

function validatePersistedAssessment(value: ExperimentAssessment): ExperimentAssessment {
  let normalized: ExperimentAssessment
  if (value.contract === 'legacy-portrait-baseline/v1') {
    assertLegacyAssessmentPersisted(value.raw)
    normalized = normalizeLegacyExperimentAssessment({
      assessment: value.raw,
      role: value.role,
      detail: value.detail,
    })
  } else if (value.contract === 'portrait-anchor-rubric/v1') {
    const raw = validatePortraitAnchorAssessment(value.raw)
    normalized = normalizeAnchorRubricExperimentAssessment({
      assessment: raw,
      role: value.role,
      detail: value.detail,
    })
  } else {
    throw new AnchorExperimentStateError('PERSISTED_SCORE_INVALID', '未知持久化评分合同。')
  }
  if (!sameCanonical(normalized, value)) {
    throw new AnchorExperimentStateError('PERSISTED_SCORE_TAMPERED', '持久化评分与本地重算结果不一致。')
  }
  return normalized
}

function validatePairwiseDecision(
  binding: AnchorExperimentRunBinding,
  decision: ExperimentPairwiseDecision,
): void {
  const allowedResults = ['left', 'right', 'tie', 'reject_both']
  if (!['AB', 'BA'].includes(decision.order)
    || !allowedResults.includes(decision.result)
    || !finiteInRange(decision.confidence, 0, 1)
    || !Number.isFinite(decision.weightedMargin)
    || typeof decision.reason !== 'string'
    || !decision.raw || typeof decision.raw !== 'object') {
    throw new AnchorExperimentStateError('PAIRWISE_DECISION_INVALID', 'pairwise 决策结构无效。')
  }
  if (binding.arm === 'A') {
    if (decision.contract !== 'legacy-portrait-pairwise/v1') {
      throw new AnchorExperimentStateError('PAIRWISE_CONTRACT_MISMATCH', 'A pairwise 合同不匹配。')
    }
    const raw = decision.raw as PairwiseRawDecision
    const result = raw.winner === 'A' ? 'left' : raw.winner === 'B' ? 'right' : 'tie'
    if (raw.order !== decision.order || result !== decision.result
      || raw.weightedMargin !== decision.weightedMargin
      || raw.confidence !== decision.confidence || raw.reason !== decision.reason) {
      throw new AnchorExperimentStateError('PAIRWISE_DECISION_TAMPERED', 'A pairwise 归一化结果被篡改。')
    }
    const computed = PORTRAIT_DIMENSION_IDS.reduce((sum, id) => {
      const value = raw.normalizedDeltas?.[id]
      if (!Number.isInteger(value) || value < -2 || value > 2) {
        throw new AnchorExperimentStateError('PAIRWISE_DECISION_INVALID', `A pairwise ${id} 无效。`)
      }
      return sum + value * PORTRAIT_BASELINE_WEIGHTS[id] / 100
    }, 0) * 5
    const rounded = Math.round(computed * 10_000) / 10_000
    const expectedWinner = rounded > 0 ? 'A' : rounded < 0 ? 'B' : 'TIE'
    if (rounded !== raw.weightedMargin || raw.winner !== expectedWinner) {
      throw new AnchorExperimentStateError(
        'PAIRWISE_DECISION_DIRECTION_INVALID',
        'A pairwise winner/margin 未由冻结六维权重重算。',
      )
    }
    return
  }
  if (decision.contract !== 'portrait-anchor-pairwise/v1') {
    throw new AnchorExperimentStateError('PAIRWISE_CONTRACT_MISMATCH', 'B/C pairwise 合同不匹配。')
  }
  const raw = decision.raw as Record<string, unknown>
  validatePortraitAnchorPairwise(raw as never)
  const deltas = raw.normalizedDimensionDeltas as Record<string, unknown> | undefined
  if (raw.order !== decision.order || raw.result !== decision.result
    || raw.confidence !== decision.confidence || raw.reason !== decision.reason
    || !deltas) {
    throw new AnchorExperimentStateError('PAIRWISE_DECISION_TAMPERED', 'B/C pairwise 归一化结果被篡改。')
  }
  const computed = PORTRAIT_ANCHOR_DIMENSION_IDS.reduce((sum, id) => {
    const value = deltas[id]
    if (!Number.isInteger(value) || (value as number) < -2 || (value as number) > 2) {
      throw new AnchorExperimentStateError('PAIRWISE_DECISION_INVALID', `B/C pairwise ${id} 无效。`)
    }
    return sum + (value as number) * PORTRAIT_ANCHOR_WEIGHTS[id] / 100
  }, 0) * 5
  const rounded = Math.round(computed * 10_000) / 10_000
  if (rounded !== decision.weightedMargin || raw.weightedMargin !== decision.weightedMargin) {
    throw new AnchorExperimentStateError('PAIRWISE_DECISION_TAMPERED', 'B/C pairwise margin 未由冻结权重重算。')
  }
  const leftTier = raw.leftTier
  const rightTier = raw.rightTier
  const eligible = (tier: unknown) => tier === 'keep_threshold' || tier === 'keep' || tier === 'best'
  const expectedResult = leftTier === 'reject' && rightTier === 'reject'
    ? 'reject_both'
    : leftTier === 'uncertain' || rightTier === 'uncertain'
      ? 'tie'
      : eligible(leftTier) && rightTier === 'reject'
        ? 'left'
        : eligible(rightTier) && leftTier === 'reject'
          ? 'right'
          : !eligible(leftTier) || !eligible(rightTier)
            || Math.abs(rounded) < 2 || decision.confidence < 0.7
            ? 'tie'
            : rounded > 0 ? 'left' : rounded < 0 ? 'right' : 'tie'
  if (decision.result !== expectedResult || raw.result !== expectedResult) {
    throw new AnchorExperimentStateError(
      'PAIRWISE_DECISION_DIRECTION_INVALID',
      'B/C pairwise result 与绝对层级、冻结 margin 或置信阈值矛盾。',
    )
  }
}

function freezeFocus(value: ReferenceSheetFaceFocus | undefined): ReferenceSheetFaceFocus | undefined {
  if (!value) return undefined
  if (![value.center_x, value.center_y, value.side_fraction].every(Number.isFinite)
    || value.center_x < 0 || value.center_x > 1 || value.center_y < 0 || value.center_y > 1
    || value.side_fraction < 0.05 || value.side_fraction > 0.8) {
    throw new AnchorExperimentStateError('INVALID_SUBJECT_FOCUS', '主人物头脸 focus 无效。')
  }
  return Object.freeze({ ...value })
}

function tierEligibility(tier: PortraitAnchorAssessment['absoluteTier']): ExperimentAssessment['eligibility'] {
  if (tier === 'keep_threshold' || tier === 'keep' || tier === 'best') return 'eligible'
  return tier === 'uncertain' ? 'needs_review' : 'ineligible'
}

export function normalizeLegacyExperimentAssessment(input: Readonly<{
  assessment: PortraitBaselineAssessment
  role: PortraitEvaluationRole
  detail: ExperimentDetail
}>): LegacyExperimentAssessment {
  const assessment = input.assessment
  return Object.freeze({
    contract: 'legacy-portrait-baseline/v1',
    id: assessment.id,
    role: input.role,
    detail: input.detail,
    eligibility: assessment.eligibility.status,
    score: assessment.baselineScore,
    scoreInterval: assessment.baselineScore === null
      ? null
      : Object.freeze([...assessment.scoreInterval]) as readonly [number, number],
    scoreIntervalSource: 'provider',
    overallConfidence: assessment.overallConfidence,
    summary: assessment.summary,
    raw: assessment,
  })
}

export function normalizeAnchorRubricExperimentAssessment(input: Readonly<{
  assessment: PortraitAnchorAssessment | FocusedPortraitAnchorAssessment
  role: PortraitEvaluationRole
  detail: ExperimentDetail
}>): AnchorRubricExperimentAssessment {
  const assessment = input.assessment
  const focus = 'primarySubjectHeadFocus' in assessment
    ? freezeFocus(assessment.primarySubjectHeadFocus)
    : undefined
  if (input.detail === 'high' && !focus) {
    throw new AnchorExperimentStateError(
      'HIGH_FOCUS_REQUIRED',
      'B/C high assessment 缺少同一次调用冻结的主人物头脸 focus。',
    )
  }
  if (input.detail === 'low' && focus) {
    throw new AnchorExperimentStateError('LOW_FOCUS_NOT_ALLOWED', 'low assessment 不得携带 high focus。')
  }
  const score = assessment.sortableScore
  const radius = score === null ? 0 : Math.max(1, (1 - assessment.overallConfidence) * 10)
  const interval = score === null
    ? null
    : Object.freeze([
      Math.round(clamp(score - radius, 0, 100) * 10_000) / 10_000,
      Math.round(clamp(score + radius, 0, 100) * 10_000) / 10_000,
    ]) as readonly [number, number]
  return Object.freeze({
    contract: 'portrait-anchor-rubric/v1',
    id: assessment.id,
    role: input.role,
    detail: input.detail,
    eligibility: tierEligibility(assessment.absoluteTier),
    score,
    scoreInterval: interval,
    scoreIntervalSource: 'local_confidence_radius',
    overallConfidence: assessment.overallConfidence,
    summary: assessment.summary,
    ...(focus ? { primarySubjectHeadFocus: focus } : {}),
    raw: assessment,
  })
}

export function anchorExperimentBindingFromManifest(
  manifest: FrozenAnchorAbcManifest,
  arm: PortraitExperimentArm,
  legendHash?: string,
): AnchorExperimentRunBinding {
  if (!Object.isFrozen(manifest) || !validHash(manifest.manifestHash)
    || manifest.arms[arm]?.profile.arm !== arm) {
    throw new AnchorExperimentStateError('EXPERIMENT_MANIFEST_INVALID', '实验 manifest 未冻结或 active arm 不匹配。')
  }
  const contracts = manifest.arms[arm]
  const visual = arm === 'C'
    ? (() => {
      if (!validHash(legendHash)) {
        throw new AnchorExperimentStateError('EXPERIMENT_LEGEND_REQUIRED', 'C 缺少冻结 legend hash。')
      }
      return Object.freeze({
        anchorPackHash: manifest.visualAnchorPack.packHash,
        anchorSheetSha256: manifest.visualAnchorPack.anchorSheetSha256,
        layoutProtocolHash: manifest.visualAnchorPack.layoutProtocolHash,
        qualityReceiptHash: manifest.visualAnchorPack.referenceSheetQualityReceipt.receiptHash,
        legendHash,
      })
    })()
    : undefined
  if (arm !== 'C' && legendHash !== undefined) {
    throw new AnchorExperimentStateError('EXPERIMENT_VISUAL_NOT_ALLOWED', `${arm} 不得绑定视觉锚点 legend。`)
  }
  const withoutNamespace = {
    schemaVersion: ANCHOR_EXPERIMENT_BINDING_SCHEMA,
    experimentId: manifest.experimentId,
    arm,
    manifestHash: manifest.manifestHash,
    sourceSnapshotHash: manifest.sourceSnapshotHash,
    datasetFingerprint: manifest.dataset.fingerprint,
    candidateScope: manifest.dataset.candidateScope,
    targetK: manifest.dataset.targetK,
    seed: manifest.dataset.seed,
    preferenceHash: manifest.dataset.preferenceHash,
    route: Object.freeze({ ...manifest.route }),
    routeIdentityHash: manifest.routeIdentityHash,
    profileProtocol: contracts.profile.protocol,
    rubricVersion: contracts.profile.rubricVersion,
    rubricContentHash: contracts.profile.rubricContentHash,
    contracts: Object.freeze({
      selectorLow: contracts.selectorLowContractHash,
      selectorHigh: contracts.selectorHighContractHash,
      selectorPairwise: contracts.selectorPairwiseContractHash,
      auditLow: contracts.auditLowContractHash,
      auditHigh: contracts.auditHighContractHash,
      auditPairwise: contracts.auditPairwiseContractHash,
    }),
    budget: Object.freeze({ ...manifest.budget }),
    ...(visual ? { visual } : {}),
  }
  return Object.freeze({
    ...withoutNamespace,
    stateNamespaceHash: sha256([
      ANCHOR_EXPERIMENT_BINDING_SCHEMA,
      manifest.experimentId,
      arm,
      manifest.manifestHash,
      manifest.routeIdentityHash,
      manifest.dataset.fingerprint,
    ].join('\u0000')),
  })
}

function scoreSlot(role: PortraitEvaluationRole, id: string, detail: ExperimentDetail): string {
  return `${role}\u0000${id}\u0000${detail}`
}

const RESTORE_PROVIDER_OPERATION = Symbol('restore-provider-operation')

function stageContract(
  binding: AnchorExperimentRunBinding,
  role: PortraitEvaluationRole,
  detail: ExperimentDetail | 'pairwise',
): string {
  const key = `${role}${detail[0].toUpperCase()}${detail.slice(1)}` as
    | 'selectorLow' | 'selectorHigh' | 'selectorPairwise'
    | 'auditLow' | 'auditHigh' | 'auditPairwise'
  return binding.contracts[key]
}

export function anchorExperimentScoreCacheKey(input: Readonly<{
  binding: AnchorExperimentRunBinding
  role: PortraitEvaluationRole
  id: string
  detail: ExperimentDetail
}>): string {
  if (!['selector', 'audit'].includes(input.role)
    || !['low', 'high'].includes(input.detail) || !safeCandidateId(input.id)) {
    throw new AnchorExperimentStateError('EXPERIMENT_CACHE_INPUT_INVALID', '评分缓存输入无效。')
  }
  return sha256(JSON.stringify([
    ANCHOR_EXPERIMENT_STATE_SCHEMA,
    input.binding.stateNamespaceHash,
    input.binding.experimentId,
    input.binding.arm,
    input.binding.manifestHash,
    input.binding.routeIdentityHash,
    input.binding.datasetFingerprint,
    input.role,
    input.detail,
    stageContract(input.binding, input.role, input.detail),
    input.id,
  ]))
}

export function anchorExperimentPairwiseLegCacheKey(input: Readonly<{
  binding: AnchorExperimentRunBinding
  role: PortraitEvaluationRole
  aId: string
  bId: string
  order: 'AB' | 'BA'
  pairCandidateReceiptHash?: string
}>): string {
  if (!['selector', 'audit'].includes(input.role)
    || !['AB', 'BA'].includes(input.order)
    || !safeCandidateId(input.aId) || !safeCandidateId(input.bId)
    || input.aId === input.bId) {
    throw new AnchorExperimentStateError('EXPERIMENT_CACHE_INPUT_INVALID', 'pairwise 缓存输入无效。')
  }
  if (input.binding.arm === 'C' && !validHash(input.pairCandidateReceiptHash)) {
    throw new AnchorExperimentStateError('PAIR_RECEIPT_REQUIRED', 'C pairwise cache 必须绑定动态候选图版收据。')
  }
  if (input.binding.arm !== 'C' && input.pairCandidateReceiptHash !== undefined) {
    throw new AnchorExperimentStateError('PAIR_RECEIPT_NOT_ALLOWED', `${input.binding.arm} 不得绑定候选图版收据。`)
  }
  return sha256(JSON.stringify([
    ANCHOR_EXPERIMENT_STATE_SCHEMA,
    input.binding.stateNamespaceHash,
    input.role,
    'pairwise',
    stageContract(input.binding, input.role, 'pairwise'),
    // aId/bId define the stable left/right semantics of AB and BA. Sorting
    // would make (a,b,AB) collide with the visually different (b,a,AB).
    input.aId,
    input.bId,
    input.order,
    input.pairCandidateReceiptHash ?? 'direct-two-candidate-jpegs',
  ]))
}

export class AnchorExperimentState {
  readonly binding: AnchorExperimentRunBinding
  readonly candidateIds: readonly string[]
  private readonly candidateIdSet: ReadonlySet<string>
  private readonly selectorScores = new Map<string, StoredExperimentAssessment>()
  private readonly auditScores = new Map<string, StoredExperimentAssessment>()
  private readonly selectorPairwiseLegs = new Map<string, ExperimentPairwiseLegRecord>()
  private readonly auditPairwiseLegs = new Map<string, ExperimentPairwiseLegRecord>()
  private readonly providerOperations = new Map<string, ExperimentProviderOperation>()
  selectorRound?: AnchorExperimentSelectorRound
  refinementCheckpoint?: Readonly<{ contextKey: Hash; plan: HighRefinementPlan }>
  pairwiseCheckpoint?: Readonly<{ contextKey: Hash; plan: PairwiseBudgetPlan }>
  draft?: AnchorExperimentDraft
  audit?: AnchorExperimentAuditReport

  constructor(binding: AnchorExperimentRunBinding, candidateIds: readonly string[]) {
    assertRunBinding(binding)
    if (!Array.isArray(candidateIds) || candidateIds.length < binding.targetK
      || new Set(candidateIds).size !== candidateIds.length
      || candidateIds.some(id => !safeCandidateId(id))) {
      throw new AnchorExperimentStateError('EXPERIMENT_CANDIDATES_INVALID', '实验候选匿名 ID 不完整。')
    }
    this.binding = immutableCanonicalClone(binding)
    this.candidateIds = Object.freeze([...candidateIds])
    this.candidateIdSet = new Set(candidateIds)
  }

  private scoreStore(role: PortraitEvaluationRole): Map<string, StoredExperimentAssessment> {
    return role === 'selector' ? this.selectorScores : this.auditScores
  }

  scoreEntries(role: PortraitEvaluationRole): readonly (readonly [string, StoredExperimentAssessment])[] {
    return Object.freeze([...this.scoreStore(role).entries()].map(([key, value]) =>
      Object.freeze([key, value] as const)))
  }

  pairwiseEntries(role: PortraitEvaluationRole): readonly (readonly [string, ExperimentPairwiseLegRecord])[] {
    const rows = role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs
    return Object.freeze([...rows.entries()].map(([key, value]) => Object.freeze([key, value] as const)))
  }

  operationEntries(): readonly (readonly [string, ExperimentProviderOperation])[] {
    return Object.freeze([...this.providerOperations.entries()].map(([key, value]) =>
      Object.freeze([key, value] as const)))
  }

  evidenceView(): AnchorExperimentEvidenceView {
    return Object.freeze({
      binding: this.binding,
      candidateIds: this.candidateIds,
      selectorScores: this.scoreEntries('selector'),
      auditScores: this.scoreEntries('audit'),
      selectorPairwiseLegs: this.pairwiseEntries('selector'),
      auditPairwiseLegs: this.pairwiseEntries('audit'),
      providerOperations: this.operationEntries(),
    })
  }

  auditEvidenceView(): AnchorExperimentAuditEvidenceView {
    return Object.freeze({
      binding: this.binding,
      candidateIds: this.candidateIds,
      auditScores: this.scoreEntries('audit'),
      auditPairwiseLegs: this.pairwiseEntries('audit'),
      providerOperations: Object.freeze(this.operationEntries()
        .filter(([, operation]) => operation.role === 'audit')),
    })
  }

  get paidCalls() {
    const result = {
      selectorScoreAttempted: 0,
      selectorScoreSucceeded: 0,
      selectorPairwiseAttempted: 0,
      selectorPairwiseSucceeded: 0,
      auditScoreAttempted: 0,
      auditScoreSucceeded: 0,
      auditPairwiseAttempted: 0,
      auditPairwiseSucceeded: 0,
    }
    for (const operation of this.providerOperations.values()) {
      const prefix = operation.role === 'selector' ? 'selector' : 'audit'
      const kind = operation.kind === 'score' ? 'Score' : 'Pairwise'
      const attempted = `${prefix}${kind}Attempted` as keyof typeof result
      const succeeded = `${prefix}${kind}Succeeded` as keyof typeof result
      result[attempted] += operation.attempts
      if (operation.status === 'succeeded') result[succeeded] += 1
    }
    return Object.freeze(result)
  }

  reserveProviderOperation(
    input: ExperimentProviderOperationRequest,
  ): 'dispatch' | 'cached' | 'blocked_unknown' {
    let expectedCacheKey: string
    if (!validHash(input.cacheKey) || !['selector', 'audit'].includes(input.role)
      || !['score', 'pairwise'].includes(input.kind)) {
      throw new AnchorExperimentStateError('PROVIDER_OPERATION_INVALID', 'provider operation 身份无效。')
    }
    if (input.kind === 'score') {
      if (!['low', 'high'].includes(input.detail as string)
        || !input.candidateId || !this.candidateIdSet.has(input.candidateId)
        || input.aId !== undefined || input.bId !== undefined || input.order !== undefined
        || input.pairCandidateReceiptHash !== undefined) {
        throw new AnchorExperimentStateError('PROVIDER_OPERATION_INVALID', 'score operation 身份无效。')
      }
      expectedCacheKey = anchorExperimentScoreCacheKey({
        binding: this.binding,
        role: input.role,
        id: input.candidateId,
        detail: input.detail!,
      })
    } else {
      if (input.detail !== undefined || input.candidateId !== undefined
        || !input.aId || !input.bId || !this.candidateIdSet.has(input.aId)
        || !this.candidateIdSet.has(input.bId) || input.aId === input.bId
        || !['AB', 'BA'].includes(input.order as string)) {
        throw new AnchorExperimentStateError('PROVIDER_OPERATION_INVALID', 'pairwise operation 身份无效。')
      }
      expectedCacheKey = anchorExperimentPairwiseLegCacheKey({
        binding: this.binding,
        role: input.role,
        aId: input.aId,
        bId: input.bId,
        order: input.order!,
        pairCandidateReceiptHash: input.pairCandidateReceiptHash,
      })
    }
    if (expectedCacheKey !== input.cacheKey) {
      throw new AnchorExperimentStateError(
        'PROVIDER_OPERATION_IDENTITY_MISMATCH',
        'provider operation cacheKey 不是由当前语义身份重算得到。',
      )
    }
    const semanticKey = input.kind === 'score'
      ? JSON.stringify([input.role, 'score', input.candidateId, input.detail])
      : JSON.stringify([input.role, 'pairwise', input.aId, input.bId, input.order])
    const semanticCollision = [...this.providerOperations.values()].some(operation => {
      const existingSemantic = operation.kind === 'score'
        ? JSON.stringify([operation.role, 'score', operation.candidateId, operation.detail])
        : JSON.stringify([operation.role, 'pairwise', operation.aId, operation.bId, operation.order])
      return existingSemantic === semanticKey && operation.cacheKey !== input.cacheKey
    })
    if (semanticCollision) {
      throw new AnchorExperimentStateError(
        'PROVIDER_OPERATION_SEMANTIC_DUPLICATE',
        '同一评分或比较语义不能通过另一 receipt/cacheKey 再次计费。',
      )
    }
    const existing = this.providerOperations.get(input.cacheKey)
    if (existing) {
      if (existing.role !== input.role || existing.kind !== input.kind
        || existing.detail !== input.detail || existing.candidateId !== input.candidateId
        || existing.aId !== input.aId || existing.bId !== input.bId
        || existing.order !== input.order
        || existing.pairCandidateReceiptHash !== input.pairCandidateReceiptHash) {
        throw new AnchorExperimentStateError('PROVIDER_OPERATION_COLLISION', 'provider operation key 发生合同碰撞。')
      }
      if (existing.status === 'succeeded') return 'cached'
      if (existing.status === 'reserved') return 'blocked_unknown'
      if (HARNESS_REJECTED_RESPONSE_CODES.includes(existing.lastFailureCode ?? '') && existing.attempts >= 2) {
        throw new AnchorExperimentStateError(
          'PROVIDER_RESPONSE_REPAIR_EXHAUSTED',
          '已收讫但不合格的模型响应最多允许两次总尝试；修复预算已耗尽，禁止继续计费。',
        )
      }
      this.providerOperations.set(input.cacheKey, Object.freeze({
        ...existing,
        status: 'reserved',
        attempts: existing.attempts + 1,
        lastFailureCode: undefined,
      }))
      return 'dispatch'
    }
    this.providerOperations.set(input.cacheKey, Object.freeze({
      cacheKey: input.cacheKey,
      role: input.role,
      kind: input.kind,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.candidateId ? { candidateId: input.candidateId } : {}),
      ...(input.aId ? { aId: input.aId } : {}),
      ...(input.bId ? { bId: input.bId } : {}),
      ...(input.order ? { order: input.order } : {}),
      ...(input.pairCandidateReceiptHash
        ? { pairCandidateReceiptHash: input.pairCandidateReceiptHash }
        : {}),
      status: 'reserved',
      attempts: 1,
    }))
    return 'dispatch'
  }

  markProviderOperationFailed(cacheKey: string, failureCode: string): void {
    const existing = this.providerOperations.get(cacheKey)
    if (!existing || existing.status !== 'reserved' || !safeToken(failureCode)) {
      throw new AnchorExperimentStateError('PROVIDER_OPERATION_TRANSITION_INVALID', '只能终结已持久化的 reserved operation。')
    }
    this.providerOperations.set(cacheKey, Object.freeze({
      ...existing,
      status: 'failed',
      lastFailureCode: failureCode,
    }))
  }

  markProviderOperationSucceeded(cacheKey: string): void {
    const existing = this.providerOperations.get(cacheKey)
    if (!existing || existing.status !== 'reserved') {
      throw new AnchorExperimentStateError('PROVIDER_OPERATION_TRANSITION_INVALID', '只能完成已持久化的 reserved operation。')
    }
    const hasEvidence = existing.kind === 'score'
      ? [...this.selectorScores.values(), ...this.auditScores.values()]
        .some(stored => stored.cacheKey === cacheKey
          && stored.assessment.role === existing.role
          && stored.assessment.detail === existing.detail
          && stored.assessment.id === existing.candidateId)
      : (existing.role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs)
        .get(cacheKey)?.aId === existing.aId
        && (existing.role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs)
          .get(cacheKey)?.bId === existing.bId
        && (existing.role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs)
          .get(cacheKey)?.order === existing.order
        && (existing.role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs)
          .get(cacheKey)?.pairCandidateReceiptHash === existing.pairCandidateReceiptHash
    if (!hasEvidence) {
      throw new AnchorExperimentStateError(
        'PROVIDER_OPERATION_EVIDENCE_MISSING',
        'provider operation 成功前必须先记录同一 cacheKey 的验证结果。',
      )
    }
    this.providerOperations.set(cacheKey, Object.freeze({
      ...existing,
      status: 'succeeded',
      lastFailureCode: undefined,
    }))
  }

  unresolvedProviderOperations(): readonly ExperimentProviderOperation[] {
    return Object.freeze([...this.providerOperations.values()]
      .filter(operation => operation.status === 'reserved'))
  }

  /**
   * Freeze a new selector round before any high/pairwise request in that round.
   * A later round must be derived from the currently persisted terminal FAIL.
   */
  setSelectorRound(round: AnchorExperimentSelectorRound): void {
    const validated = validateSelectorRound(round, this.binding, this.candidateIdSet)
    if (!validated) {
      throw new AnchorExperimentStateError('SELECTOR_ROUND_INVALID', 'selector round 不能为空。')
    }
    if (this.selectorRound && sameCanonical(this.selectorRound, validated)) return
    if (!this.selectorRound) {
      if (validated.round !== 1 || this.refinementCheckpoint || this.pairwiseCheckpoint
        || this.draft || this.audit) {
        throw new AnchorExperimentStateError(
          'SELECTOR_ROUND_TRANSITION_INVALID',
          '首轮必须在任何 selector 派生产物之前冻结。',
        )
      }
    } else {
      if (validated.round !== this.selectorRound.round + 1
        || this.audit?.status !== 'FAIL'
        || this.audit.round !== this.selectorRound.round
        || !this.draft
        || validated.priorSelectionHash !== this.draft.selectionHash
        || validated.feedback?.failedSelectionHash !== this.draft.selectionHash
        || !sameCanonical(validated.feedback?.strongerChallengerIds,
          [...this.audit.strongerChallengerIds].sort())
        || !sameCanonical(validated.feedback?.disqualifiedSelectedIds,
          [...this.audit.disqualifiedSelectedIds].sort())) {
        throw new AnchorExperimentStateError(
          'SELECTOR_ROUND_TRANSITION_INVALID',
          '后续 selector round 必须精确继承上一轮 terminal FAIL。',
        )
      }
    }
    this.selectorRound = validated
    this.refinementCheckpoint = undefined
    this.pairwiseCheckpoint = undefined
    this.draft = undefined
    this.audit = undefined
  }

  /** Persistence-only hydrate path; the unexported symbol prevents normal callers from bypassing transitions. */
  restoreProviderOperation(
    token: typeof RESTORE_PROVIDER_OPERATION,
    operation: ExperimentProviderOperation,
  ): void {
    if (token !== RESTORE_PROVIDER_OPERATION || this.providerOperations.has(operation.cacheKey)) {
      throw new AnchorExperimentStateError('PROVIDER_OPERATION_RESTORE_INVALID', 'provider operation 恢复入口无效。')
    }
    this.providerOperations.set(operation.cacheKey, immutableCanonicalClone(operation))
  }

  cachedScore(role: PortraitEvaluationRole, id: string, detail: ExperimentDetail): ExperimentAssessment | undefined {
    const cacheKey = anchorExperimentScoreCacheKey({ binding: this.binding, role, id, detail })
    const stored = this.scoreStore(role).get(scoreSlot(role, id, detail))
    return stored?.cacheKey === cacheKey ? stored.assessment : undefined
  }

  recordScore(assessment: ExperimentAssessment): void {
    if (!this.candidateIdSet.has(assessment.id)) {
      throw new AnchorExperimentStateError('UNKNOWN_EXPERIMENT_CANDIDATE', '评分引用了当前实验之外的匿名 ID。')
    }
    if ((this.binding.arm === 'A') !== (assessment.contract === 'legacy-portrait-baseline/v1')) {
      throw new AnchorExperimentStateError('EXPERIMENT_ASSESSMENT_CONTRACT_MISMATCH', '评分合同与实验 arm 不匹配。')
    }
    const validated = validatePersistedAssessment(assessment)
    const frozen = immutableCanonicalClone(validated)
    const cacheKey = anchorExperimentScoreCacheKey({
      binding: this.binding,
      role: frozen.role,
      id: frozen.id,
      detail: frozen.detail,
    })
    this.scoreStore(frozen.role).set(scoreSlot(frozen.role, frozen.id, frozen.detail), {
      assessment: frozen,
      cacheKey,
    })
    if (frozen.role === 'selector') {
      this.pairwiseCheckpoint = undefined
      this.draft = undefined
      this.audit = undefined
    } else {
      this.audit = undefined
    }
  }

  bestScore(role: PortraitEvaluationRole, id: string): ExperimentAssessment | undefined {
    return this.cachedScore(role, id, 'high') ?? this.cachedScore(role, id, 'low')
  }

  recordPairwiseLeg(record: ExperimentPairwiseLegRecord): void {
    if (!this.candidateIdSet.has(record.aId) || !this.candidateIdSet.has(record.bId)
      || record.aId === record.bId || record.order !== record.decision.order) {
      throw new AnchorExperimentStateError('PAIRWISE_LEG_INVALID', 'pairwise leg 的匿名 ID 或顺序无效。')
    }
    validatePairwiseDecision(this.binding, record.decision)
    const expected = anchorExperimentPairwiseLegCacheKey({
      binding: this.binding,
      role: record.role,
      aId: record.aId,
      bId: record.bId,
      order: record.order,
      pairCandidateReceiptHash: record.pairCandidateReceiptHash,
    })
    if (record.cacheKey !== expected) {
      throw new AnchorExperimentStateError('PAIRWISE_LEG_IDENTITY_MISMATCH', 'pairwise leg 没有绑定当前实验身份。')
    }
    const frozen = immutableCanonicalClone(record)
    const target = frozen.role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs
    const semanticDuplicate = [...target.values()].some(existing =>
      existing.aId === frozen.aId && existing.bId === frozen.bId
      && existing.order === frozen.order && existing.cacheKey !== frozen.cacheKey)
    if (semanticDuplicate) {
      throw new AnchorExperimentStateError(
        'PAIRWISE_SEMANTIC_LEG_DUPLICATE',
        '同一角色、A/B 身份与顺序只能存在一个 source-bound pairwise leg。',
      )
    }
    target.set(frozen.cacheKey, frozen)
    if (frozen.role === 'selector') {
      this.draft = undefined
      this.audit = undefined
    } else {
      this.audit = undefined
    }
  }

  cachedPairwiseLeg(role: PortraitEvaluationRole, cacheKey: string): ExperimentPairwiseLegRecord | undefined {
    return (role === 'selector' ? this.selectorPairwiseLegs : this.auditPairwiseLegs).get(cacheKey)
  }
}

function derivedStageNeeds(
  state: AnchorExperimentState,
  presence: Readonly<{
    refinement: boolean
    pairwise: boolean
    draft: boolean
    audit: boolean
  }>,
  expectedPhase: AnchorExperimentExpectedPhase,
): Readonly<{
  refinement: boolean
  pairwise: boolean
  draft: boolean
  audit: boolean
}> {
  const selectorScores = state.scoreEntries('selector')
  const auditScores = state.scoreEntries('audit')
  const selectorLegs = state.pairwiseEntries('selector')
  const auditLegs = state.pairwiseEntries('audit')
  const operations = state.operationEntries().map(([, operation]) => operation)
  const selectorHighWork = selectorScores.some(([, stored]) => stored.assessment.detail === 'high')
    || operations.some(operation => operation.role === 'selector'
      && ((operation.kind === 'score' && operation.detail === 'high')
        || operation.kind === 'pairwise'))
  const selectorPairwiseWork = selectorLegs.length > 0
    || operations.some(operation => operation.role === 'selector'
      && operation.kind === 'pairwise')
  const auditWork = auditScores.length > 0 || auditLegs.length > 0
    || operations.some(operation => operation.role === 'audit')
  const draftOrAudit = presence.draft || presence.audit || auditWork
  const phaseRank = {
    baseline: 0,
    refinement: 1,
    pairwise: 2,
    selection: 3,
    audit: 4,
  }[expectedPhase]
  return Object.freeze({
    refinement: phaseRank >= 1 || presence.refinement
      || selectorHighWork || selectorPairwiseWork || draftOrAudit,
    pairwise: phaseRank >= 2 || presence.pairwise
      || selectorPairwiseWork || draftOrAudit,
    draft: phaseRank >= 3 || presence.draft || presence.audit || auditWork,
    audit: phaseRank >= 4 || presence.audit || auditWork,
  })
}

function validateDerivedAuthority(
  authority: AnchorExperimentDerivedAuthority | undefined,
  binding: AnchorExperimentRunBinding,
): AnchorExperimentExpectedPhase {
  if (!authority) return 'baseline'
  if (!['baseline', 'refinement', 'pairwise', 'selection', 'audit']
    .includes(authority.expectedPersistedPhase)) {
    throw new AnchorExperimentStateError(
      'EXPERIMENT_EXPECTED_PHASE_INVALID',
      '外部运行意图不是已知实验阶段。',
    )
  }
  if (authority.expectedPersistedPhase === 'audit') {
    if (!Number.isInteger(authority.expectedAuditRound)
      || authority.expectedAuditRound! < 1
      || authority.expectedAuditRound! > binding.budget.maxCompleteAuditRounds) {
      throw new AnchorExperimentStateError(
        'EXPERIMENT_EXPECTED_AUDIT_ROUND_INVALID',
        'audit 阶段必须由当前 DSH 命令提供冻结且有界的 round。',
      )
    }
  } else if (authority.expectedAuditRound !== undefined) {
    throw new AnchorExperimentStateError(
      'EXPERIMENT_EXPECTED_AUDIT_ROUND_INVALID',
      '非 audit 阶段不得携带 audit round。',
    )
  }
  return authority.expectedPersistedPhase
}

function resolveExpectedSelectorRound(input: Readonly<{
  authority?: AnchorExperimentDerivedAuthority
  binding: AnchorExperimentRunBinding
  allowed: ReadonlySet<string>
  evidence: AnchorExperimentEvidenceView
  auditEvidence: AnchorExperimentAuditEvidenceView
}>): AnchorExperimentSelectorRound | undefined {
  const declared = validateSelectorRound(
    input.authority?.expectedSelectorRound, input.binding, input.allowed,
  )
  const recomputed = validateSelectorRound(
    input.authority?.recomputeSelectorRound?.(input.evidence, input.auditEvidence),
    input.binding,
    input.allowed,
  )
  if (declared && recomputed && !sameCanonical(declared, recomputed)) {
    throw new AnchorExperimentStateError(
      'SELECTOR_ROUND_RECOMPUTE_MISMATCH',
      '外部声明的 selector round 无法由已验证证据重建。',
    )
  }
  return recomputed ?? declared
}

function assertDerivedPresenceMatchesPhase(
  phase: AnchorExperimentExpectedPhase,
  presence: Readonly<{ refinement: boolean; pairwise: boolean; draft: boolean; audit: boolean }>,
): void {
  const maximum = {
    baseline: 0,
    refinement: 1,
    pairwise: 2,
    selection: 3,
    audit: 4,
  }[phase]
  const observed = presence.audit ? 4 : presence.draft ? 3 : presence.pairwise ? 2
    : presence.refinement ? 1 : 0
  if (observed > maximum) {
    throw new AnchorExperimentStateError(
      'PERSISTED_DERIVED_PHASE_MISMATCH',
      '持久化派生产物领先于当前 DSH 命令的外部运行意图。',
    )
  }
}

export function anchorExperimentStateFile(
  workdir: string,
  folder: string,
  limit: number | undefined,
  binding: AnchorExperimentRunBinding,
): string {
  const digest = sha256([
    folder,
    String(limit ?? 'all'),
    binding.datasetFingerprint,
    binding.experimentId,
    binding.arm,
    binding.manifestHash,
    binding.stateNamespaceHash,
  ].join('\u0000')).slice(0, 24)
  return join(anchorExperimentStateDirectory(workdir, binding), `state-${digest}.json`)
}

function anchorExperimentStateDirectory(
  workdir: string,
  binding: AnchorExperimentRunBinding,
): string {
  return binding.experimentId === PHOTO_ANCHOR_LAB_CODEX_ID
    || binding.experimentId.startsWith(`${PHOTO_ANCHOR_LAB_CODEX_ID}:`)
    || binding.experimentId.startsWith(`${PHOTO_ANCHOR_LAB_CODEX_ID}-`)
    ? photoAnchorLabCodexStateDirectory(workdir, binding.stateNamespaceHash)
    : join(workdir, 'anchor-experiments')
}

function sameBinding(left: AnchorExperimentRunBinding, right: AnchorExperimentRunBinding): boolean {
  return sameCanonical(left, right)
}

function requireCandidateList(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  options: Readonly<{
    exactLength?: number
    allowEmpty?: boolean
    errorCode?: string
  }> = {},
): readonly string[] {
  if (!Array.isArray(value)
    || (!options.allowEmpty && value.length === 0)
    || (options.exactLength !== undefined && value.length !== options.exactLength)
    || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !allowed.has(id))) {
    throw new AnchorExperimentStateError(
      options.errorCode ?? 'PERSISTED_EXPERIMENT_STATE_INVALID',
      `${label} 候选集合无效。`,
    )
  }
  return value
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function validateRefinementCheckpoint(
  value: PersistedAnchorExperimentState['refinementCheckpoint'],
  binding: AnchorExperimentRunBinding,
  allowed: ReadonlySet<string>,
): PersistedAnchorExperimentState['refinementCheckpoint'] {
  if (value === undefined) return undefined
  const plan = value.plan
  const numeric = [
    plan?.target, plan?.eligibleCount, plan?.hardCap, plan?.baseCount,
    plan?.leadingWindowCount, plan?.leadingFamilyCount,
    plan?.familyChallengersPerFamily, plan?.auditForcedCount,
    plan?.familyChallengerAddedCount, plan?.globalFillCount,
  ]
  if (!validHash(value.contextKey) || !plan || numeric.some(item => !nonNegativeInteger(item))
    || !Array.isArray(plan.candidateIds)
    || plan.target !== binding.targetK || plan.hardCap < binding.targetK
    || plan.hardCap > binding.budget.highCap || plan.hardCap > allowed.size
    || plan.eligibleCount < binding.targetK || plan.eligibleCount > allowed.size
    || plan.candidateIds.length !== plan.hardCap) {
    throw new AnchorExperimentStateError(
      'PERSISTED_REFINEMENT_CHECKPOINT_INVALID',
      'high refinement checkpoint 超出冻结预算或结构无效。',
    )
  }
  requireCandidateList(plan.candidateIds, allowed, 'refinement', {
    exactLength: plan.hardCap,
    errorCode: 'PERSISTED_REFINEMENT_CHECKPOINT_INVALID',
  })
  return immutableCanonicalClone(value)
}

function validatePairwiseCheckpoint(
  value: PersistedAnchorExperimentState['pairwiseCheckpoint'],
  binding: AnchorExperimentRunBinding,
  allowed: ReadonlySet<string>,
): PersistedAnchorExperimentState['pairwiseCheckpoint'] {
  if (value === undefined) return undefined
  const plan = value.plan
  if (!validHash(value.contextKey) || !plan || !Array.isArray(plan.pairs)
    || !nonNegativeInteger(plan.auditPairCount)
    || !nonNegativeInteger(plan.familyPairCount)
    || !nonNegativeInteger(plan.cutlinePairCount)
    || !nonNegativeInteger(plan.pairCap)
    || plan.pairCap > binding.budget.pairwisePairCap
    || plan.pairs.length > plan.pairCap
    || plan.auditPairCount + plan.familyPairCount + plan.cutlinePairCount !== plan.pairs.length
    || plan.bidirectionalCallCap !== plan.pairCap * 2) {
    throw new AnchorExperimentStateError(
      'PERSISTED_PAIRWISE_CHECKPOINT_INVALID',
      'pairwise checkpoint 超出冻结预算或结构无效。',
    )
  }
  const seen = new Set<string>()
  for (const pair of plan.pairs) {
    if (!pair || !allowed.has(pair.leftId) || !allowed.has(pair.rightId)
      || pair.leftId === pair.rightId
      || !['audit', 'family', 'cutline'].includes(pair.source)) {
      throw new AnchorExperimentStateError('PERSISTED_PAIRWISE_CHECKPOINT_INVALID', 'pairwise pair 无效。')
    }
    const key = [pair.leftId, pair.rightId].sort().join('\u0000')
    if (seen.has(key)) {
      throw new AnchorExperimentStateError('PERSISTED_PAIRWISE_CHECKPOINT_INVALID', 'pairwise pair 重复。')
    }
    seen.add(key)
  }
  return immutableCanonicalClone(value)
}

function validateDraft(
  value: AnchorExperimentDraft | undefined,
  binding: AnchorExperimentRunBinding,
  allowed: ReadonlySet<string>,
): AnchorExperimentDraft | undefined {
  if (value === undefined) return undefined
  const keep = requireCandidateList(value.keep, allowed, 'draft.keep', {
    exactLength: binding.targetK,
    errorCode: 'PERSISTED_DRAFT_INVALID',
  })
  if (value.bindingHash !== binding.stateNamespaceHash
    || !value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores)) {
    throw new AnchorExperimentStateError('PERSISTED_DRAFT_INVALID', '冻结 draft 身份或分数无效。')
  }
  const scoreEntries = Object.entries(value.scores)
  if (scoreEntries.some(([id, score]) => !allowed.has(id) || !finiteInRange(score, 0, 100))
    || keep.some(id => !Object.hasOwn(value.scores, id))) {
    throw new AnchorExperimentStateError('PERSISTED_DRAFT_INVALID', '冻结 draft 含越界候选或分数。')
  }
  const expected = anchorExperimentSelectionHash({ binding, keep, scores: value.scores })
  if (value.selectionHash !== expected) {
    throw new AnchorExperimentStateError('PERSISTED_DRAFT_INVALID', '冻结 draft selection hash 不匹配。')
  }
  return immutableCanonicalClone(value)
}

function validateAudit(
  value: AnchorExperimentAuditReport | undefined,
  binding: AnchorExperimentRunBinding,
  allowed: ReadonlySet<string>,
  draft: AnchorExperimentDraft | undefined,
): AnchorExperimentAuditReport | undefined {
  if (value === undefined) return undefined
  const selected = requireCandidateList(value.selectedIds, allowed, 'audit.selected', {
    exactLength: binding.targetK,
    errorCode: 'PERSISTED_AUDIT_INVALID',
  })
  requireCandidateList(value.strongerChallengerIds, allowed, 'audit.stronger', {
    allowEmpty: true, errorCode: 'PERSISTED_AUDIT_INVALID',
  })
  requireCandidateList(value.disqualifiedSelectedIds, allowed, 'audit.disqualified', {
    allowEmpty: true, errorCode: 'PERSISTED_AUDIT_INVALID',
  })
  if (!draft || value.schemaVersion !== 'photo-filter-anchor-audit/v1'
    || !Number.isInteger(value.round) || value.round < 1
    || value.round > binding.budget.maxCompleteAuditRounds
    || value.bindingHash !== binding.stateNamespaceHash
    || value.selectionHash !== draft.selectionHash
    || JSON.stringify(selected) !== JSON.stringify(draft.keep)
    || !['PASS', 'FAIL', 'INCOMPLETE'].includes(value.status)
    || !['selected_high', 'remaining_low', 'promotion_high', 'pairwise', 'complete'].includes(value.stage)
    || !nonNegativeInteger(value.remainingCount)
    || !nonNegativeInteger(value.pairwiseRemainingCount)) {
    throw new AnchorExperimentStateError('PERSISTED_AUDIT_INVALID', 'audit 身份、阶段或覆盖计数无效。')
  }
  const counterexamples = value.strongerChallengerIds.length + value.disqualifiedSelectedIds.length
  if ((value.status === 'PASS'
      && (value.stage !== 'complete' || value.remainingCount !== 0
        || value.pairwiseRemainingCount !== 0 || counterexamples !== 0))
    || (value.status === 'FAIL'
      && (value.stage !== 'complete' || value.remainingCount !== 0
        || value.pairwiseRemainingCount !== 0 || counterexamples === 0))
    || (value.status === 'INCOMPLETE' && value.stage === 'complete')) {
    throw new AnchorExperimentStateError('PERSISTED_AUDIT_INVALID', 'audit 三态与覆盖/反例矛盾。')
  }
  return immutableCanonicalClone(value)
}

const PAID_CALL_KEYS = Object.freeze([
  'selectorScoreAttempted', 'selectorScoreSucceeded',
  'selectorPairwiseAttempted', 'selectorPairwiseSucceeded',
  'auditScoreAttempted', 'auditScoreSucceeded',
  'auditPairwiseAttempted', 'auditPairwiseSucceeded',
] as const)

function validatePaidCalls(value: unknown): AnchorExperimentState['paidCalls'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\u0000') !== [...PAID_CALL_KEYS].sort().join('\u0000')) {
    throw new AnchorExperimentStateError('PERSISTED_PAID_CALLS_INVALID', '付费调用账本结构无效。')
  }
  const row = value as Record<(typeof PAID_CALL_KEYS)[number], unknown>
  if (PAID_CALL_KEYS.some(key => !nonNegativeInteger(row[key]))
    || (row.selectorScoreSucceeded as number) > (row.selectorScoreAttempted as number)
    || (row.selectorPairwiseSucceeded as number) > (row.selectorPairwiseAttempted as number)
    || (row.auditScoreSucceeded as number) > (row.auditScoreAttempted as number)
    || (row.auditPairwiseSucceeded as number) > (row.auditPairwiseAttempted as number)) {
    throw new AnchorExperimentStateError('PERSISTED_PAID_CALLS_INVALID', '付费调用账本计数无效。')
  }
  return immutableCanonicalClone(value as AnchorExperimentState['paidCalls'])
}

function validateProviderOperationRows(
  rows: unknown,
  state: AnchorExperimentState,
): readonly (readonly [string, ExperimentProviderOperation])[] {
  if (!Array.isArray(rows)) {
    throw new AnchorExperimentStateError('PERSISTED_PROVIDER_OPERATIONS_INVALID', 'provider operation ledger 不是数组。')
  }
  const seen = new Set<string>()
  const seenSemantic = new Set<string>()
  const validated: Array<readonly [string, ExperimentProviderOperation]> = []
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new AnchorExperimentStateError('PERSISTED_PROVIDER_OPERATIONS_INVALID', 'provider operation row 无效。')
    }
    const [key, operation] = row as [unknown, Partial<ExperimentProviderOperation>]
    if (!validHash(key) || !operation || operation.cacheKey !== key || seen.has(key)
      || !['selector', 'audit'].includes(operation.role as string)
      || !['score', 'pairwise'].includes(operation.kind as string)
      || !['reserved', 'succeeded', 'failed'].includes(operation.status as string)
      || !Number.isInteger(operation.attempts) || (operation.attempts as number) < 1
      || (operation.status === 'failed' && !safeToken(operation.lastFailureCode))
      || (operation.status !== 'failed' && operation.lastFailureCode !== undefined)) {
      throw new AnchorExperimentStateError('PERSISTED_PROVIDER_OPERATIONS_INVALID', 'provider operation 字段无效。')
    }
    let expectedCacheKey: string
    let semanticKey: string
    if (operation.kind === 'score') {
      if (!['low', 'high'].includes(operation.detail as string)
        || !safeCandidateId(operation.candidateId)
        || !state.candidateIds.includes(operation.candidateId)
        || operation.aId !== undefined || operation.bId !== undefined
        || operation.order !== undefined || operation.pairCandidateReceiptHash !== undefined) {
        throw new AnchorExperimentStateError(
          'PERSISTED_PROVIDER_OPERATIONS_INVALID', 'score operation 语义字段无效。',
        )
      }
      expectedCacheKey = anchorExperimentScoreCacheKey({
        binding: state.binding,
        role: operation.role!,
        id: operation.candidateId,
        detail: operation.detail!,
      })
      semanticKey = JSON.stringify([
        operation.role, 'score', operation.candidateId, operation.detail,
      ])
    } else {
      if (operation.detail !== undefined || operation.candidateId !== undefined
        || !safeCandidateId(operation.aId) || !safeCandidateId(operation.bId)
        || !state.candidateIds.includes(operation.aId)
        || !state.candidateIds.includes(operation.bId)
        || operation.aId === operation.bId || !['AB', 'BA'].includes(operation.order as string)) {
        throw new AnchorExperimentStateError(
          'PERSISTED_PROVIDER_OPERATIONS_INVALID', 'pairwise operation 语义字段无效。',
        )
      }
      expectedCacheKey = anchorExperimentPairwiseLegCacheKey({
        binding: state.binding,
        role: operation.role!,
        aId: operation.aId,
        bId: operation.bId,
        order: operation.order!,
        pairCandidateReceiptHash: operation.pairCandidateReceiptHash,
      })
      semanticKey = JSON.stringify([
        operation.role, 'pairwise', operation.aId, operation.bId, operation.order,
      ])
    }
    if (expectedCacheKey !== key || seenSemantic.has(semanticKey)) {
      throw new AnchorExperimentStateError(
        'PERSISTED_PROVIDER_OPERATIONS_INVALID',
        'provider operation cacheKey 或语义唯一性无效。',
      )
    }
    const frozen = immutableCanonicalClone(operation as ExperimentProviderOperation)
    if (frozen.status === 'succeeded') {
      const evidenceExists = frozen.kind === 'score'
        ? state.scoreEntries(frozen.role).some(([, stored]) =>
          stored.cacheKey === frozen.cacheKey && stored.assessment.detail === frozen.detail)
        : state.pairwiseEntries(frozen.role).some(([storedKey]) => storedKey === frozen.cacheKey)
      if (!evidenceExists) {
        throw new AnchorExperimentStateError(
          'PERSISTED_PROVIDER_OPERATION_EVIDENCE_MISSING',
          '成功 operation 缺少同身份的已验证评分/比较证据。',
        )
      }
    }
    seen.add(key)
    seenSemantic.add(semanticKey)
    validated.push(Object.freeze([key, frozen] as const))
  }
  return Object.freeze(validated)
}

function validateEvidenceOperationCoverage(
  rows: readonly (readonly [string, ExperimentProviderOperation])[],
  state: AnchorExperimentState,
): void {
  const operations = new Map(rows)
  for (const role of ['selector', 'audit'] as const) {
    for (const [, stored] of state.scoreEntries(role)) {
      const operation = operations.get(stored.cacheKey)
      if (!operation || operation.status !== 'succeeded' || operation.role !== role
        || operation.kind !== 'score' || operation.detail !== stored.assessment.detail
        || operation.candidateId !== stored.assessment.id) {
        throw new AnchorExperimentStateError(
          'PERSISTED_EVIDENCE_OPERATION_MISSING',
          '评分证据缺少同身份且已成功的 provider operation；恢复已阻止。',
        )
      }
    }
    for (const [cacheKey, record] of state.pairwiseEntries(role)) {
      const operation = operations.get(cacheKey)
      if (!operation || operation.status !== 'succeeded' || operation.role !== role
        || operation.kind !== 'pairwise' || operation.detail !== undefined
        || operation.aId !== record.aId || operation.bId !== record.bId
        || operation.order !== record.order
        || operation.pairCandidateReceiptHash !== record.pairCandidateReceiptHash) {
        throw new AnchorExperimentStateError(
          'PERSISTED_EVIDENCE_OPERATION_MISSING',
          'pairwise 证据缺少同身份且已成功的 provider operation；恢复已阻止。',
        )
      }
    }
  }
}

function requireDerivedAuthority<T>(input: Readonly<{
  label: string
  persisted: T | undefined
  recompute: (() => T | undefined) | undefined
  required: boolean
}>): T | undefined {
  if (!input.recompute) {
    if (input.persisted === undefined && !input.required) return undefined
    throw new AnchorExperimentStateError(
      'PERSISTED_DERIVED_AUTHORITY_REQUIRED',
      `${input.label} 只能由当前代码根据已验证证据重算，不能直接信任状态文件。`,
    )
  }
  const expected = input.recompute()
  if (input.required && expected === undefined) {
    throw new AnchorExperimentStateError(
      'PERSISTED_DERIVED_RECOMPUTE_MISSING',
      `${input.label} 已有下游证据或请求账本，但当前代码无法重建必需的权威产物。`,
    )
  }
  // Compare both directions: deleting an expected artifact is as invalid as
  // adding a forged one. This prevents a partial run from silently replanning
  // after high/pairwise/audit evidence already exists.
  if (!sameCanonical(expected, input.persisted)) {
    throw new AnchorExperimentStateError(
      'PERSISTED_DERIVED_RECOMPUTE_MISMATCH',
      `${input.label} 与当前代码根据评分/比较证据重算的结果不一致。`,
    )
  }
  return input.persisted === undefined ? undefined : immutableCanonicalClone(input.persisted)
}

const writeQueues = new Map<string, Promise<void>>()
let writeSequence = 0

export async function saveAnchorExperimentState(input: Readonly<{
  state: AnchorExperimentState
  workdir: string
  folder: string
  limit?: number
  authority?: AnchorExperimentDerivedAuthority
}>): Promise<boolean> {
  const { state } = input
  assertRunBinding(state.binding)
  const allowed = new Set(state.candidateIds)
  const selectorScores = state.scoreEntries('selector')
  const auditScores = state.scoreEntries('audit')
  const selectorPairwiseLegs = state.pairwiseEntries('selector')
  const auditPairwiseLegs = state.pairwiseEntries('audit')
  const providerOperations = validateProviderOperationRows(state.operationEntries(), state)
  validateEvidenceOperationCoverage(providerOperations, state)
  for (const [slot, stored] of [...selectorScores, ...auditScores]) {
    const assessment = validatePersistedAssessment(stored.assessment)
    const expected = anchorExperimentScoreCacheKey({
      binding: state.binding,
      role: assessment.role,
      id: assessment.id,
      detail: assessment.detail,
    })
    if (!allowed.has(assessment.id) || slot !== scoreSlot(assessment.role, assessment.id, assessment.detail)
      || stored.cacheKey !== expected) {
      throw new AnchorExperimentStateError('EXPERIMENT_SCORE_STORE_INVALID', '评分缓存槽位或身份无效。')
    }
  }
  for (const [key, record] of [...selectorPairwiseLegs, ...auditPairwiseLegs]) {
    validatePairwiseDecision(state.binding, record.decision)
    const expected = anchorExperimentPairwiseLegCacheKey({
      binding: state.binding,
      role: record.role,
      aId: record.aId,
      bId: record.bId,
      order: record.order,
      pairCandidateReceiptHash: record.pairCandidateReceiptHash,
    })
    if (!allowed.has(record.aId) || !allowed.has(record.bId)
      || record.aId === record.bId || key !== expected || record.cacheKey !== expected) {
      throw new AnchorExperimentStateError('EXPERIMENT_PAIR_STORE_INVALID', 'pairwise 缓存槽位或身份无效。')
    }
  }
  const structurallyValidRefinement = validateRefinementCheckpoint(
    state.refinementCheckpoint, state.binding, allowed,
  )
  const structurallyValidPairwise = validatePairwiseCheckpoint(
    state.pairwiseCheckpoint, state.binding, allowed,
  )
  const structurallyValidDraft = validateDraft(state.draft, state.binding, allowed)
  const structurallyValidAudit = validateAudit(
    state.audit, state.binding, allowed, structurallyValidDraft,
  )
  const expectedPhase = validateDerivedAuthority(input.authority, state.binding)
  const structurallyValidSelectorRound = validateSelectorRound(
    state.selectorRound, state.binding, allowed,
  )
  const evidence = state.evidenceView()
  const auditEvidence = state.auditEvidenceView()
  const expectedSelectorRound = resolveExpectedSelectorRound({
    authority: input.authority,
    binding: state.binding,
    allowed,
    evidence,
    auditEvidence,
  })
  if (structurallyValidSelectorRound || expectedSelectorRound) {
    if (!input.authority || !expectedSelectorRound
      || !sameCanonical(structurallyValidSelectorRound, expectedSelectorRound)) {
      throw new AnchorExperimentStateError(
        'PERSISTED_SELECTOR_ROUND_AUTHORITY_MISMATCH',
        'selector round 必须与当前命名 Agent 的外部 authority 完全一致。',
      )
    }
  }
  const derivedPresence = {
    refinement: structurallyValidRefinement !== undefined,
    pairwise: structurallyValidPairwise !== undefined,
    draft: structurallyValidDraft !== undefined,
    audit: structurallyValidAudit !== undefined,
  }
  if (input.authority) assertDerivedPresenceMatchesPhase(expectedPhase, derivedPresence)
  if (structurallyValidAudit && input.authority
    && input.authority.expectedAuditRound !== structurallyValidAudit.round) {
    throw new AnchorExperimentStateError(
      'PERSISTED_AUDIT_ROUND_MISMATCH',
      'audit report round 与当前 DSH 命令冻结 round 不一致。',
    )
  }
  const stageNeeds = derivedStageNeeds(state, derivedPresence, expectedPhase)
  const refinementCheckpoint = requireDerivedAuthority({
    label: 'refinement checkpoint',
    persisted: structurallyValidRefinement,
    recompute: input.authority?.recomputeRefinementCheckpoint
      ? () => input.authority!.recomputeRefinementCheckpoint!(evidence)
      : undefined,
    required: stageNeeds.refinement,
  })
  const pairwiseCheckpoint = requireDerivedAuthority({
    label: 'pairwise checkpoint',
    persisted: structurallyValidPairwise,
    recompute: input.authority?.recomputePairwiseCheckpoint && refinementCheckpoint
      ? () => input.authority!.recomputePairwiseCheckpoint!(evidence, refinementCheckpoint)
      : undefined,
    required: stageNeeds.pairwise,
  })
  const draft = requireDerivedAuthority({
    label: 'selection draft',
    persisted: structurallyValidDraft,
    recompute: input.authority?.recomputeDraft && refinementCheckpoint && pairwiseCheckpoint
      ? () => input.authority!.recomputeDraft!(
        evidence, refinementCheckpoint, pairwiseCheckpoint,
      )
      : undefined,
    required: stageNeeds.draft,
  })
  const audit = requireDerivedAuthority({
    label: 'audit report',
    persisted: structurallyValidAudit,
    recompute: input.authority?.recomputeAudit && draft
      && refinementCheckpoint && pairwiseCheckpoint
      && input.authority.expectedAuditRound !== undefined
      ? () => input.authority!.recomputeAudit!(
        auditEvidence, draft, refinementCheckpoint, pairwiseCheckpoint,
        input.authority!.expectedAuditRound!,
      )
      : undefined,
    required: stageNeeds.audit,
  })
  const paidCalls = validatePaidCalls(state.paidCalls)
  const destination = anchorExperimentStateFile(input.workdir, input.folder, input.limit, state.binding)
  const payload: PersistedAnchorExperimentState = {
    schemaVersion: ANCHOR_EXPERIMENT_STATE_SCHEMA,
    binding: state.binding,
    candidateIds: [...state.candidateIds].sort(),
    selectorScores,
    auditScores,
    selectorPairwiseLegs,
    auditPairwiseLegs,
    providerOperations,
    selectorRound: structurallyValidSelectorRound,
    refinementCheckpoint,
    pairwiseCheckpoint,
    draft,
    audit,
    paidCalls,
  }
  const serialized = JSON.stringify(payload)
  const previous = writeQueues.get(destination) ?? Promise.resolve()
  const sequence = writeSequence += 1
  const pending = previous.catch(() => undefined).then(async () => {
    const directory = anchorExperimentStateDirectory(input.workdir, state.binding)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${destination}.tmp-${process.pid}-${sequence}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(serialized, { encoding: 'utf8' })
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, destination)
      // Persist the directory entry as well as the file contents. If this
      // fails, the caller must not dispatch a reserved paid operation.
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  })
  writeQueues.set(destination, pending)
  try {
    await pending
    return true
  } catch {
    return false
  } finally {
    if (writeQueues.get(destination) === pending) writeQueues.delete(destination)
  }
}

/**
 * The only production-safe pre-dispatch path: a provider request may be sent
 * only after its semantic identity and reservation have reached durable disk.
 */
export async function reserveAndPersistAnchorExperimentProviderOperation(
  input: Readonly<{
    state: AnchorExperimentState
    operation: ExperimentProviderOperationRequest
    workdir: string
    folder: string
    limit?: number
    authority?: AnchorExperimentDerivedAuthority
  }>,
): Promise<'dispatch' | 'cached' | 'blocked_unknown'> {
  const decision = input.state.reserveProviderOperation(input.operation)
  if (decision !== 'dispatch') return decision
  const persisted = await saveAnchorExperimentState({
    state: input.state,
    workdir: input.workdir,
    folder: input.folder,
    limit: input.limit,
    authority: input.authority,
  })
  if (!persisted) {
    throw new AnchorExperimentStateError(
      'PROVIDER_OPERATION_RESERVATION_PERSIST_FAILED',
      'provider reservation 未可靠落盘；为避免重复付费，本次请求禁止发送。',
    )
  }
  return 'dispatch'
}

export async function loadAnchorExperimentState(input: Readonly<{
  binding: AnchorExperimentRunBinding
  candidateIds: readonly string[]
  workdir: string
  folder: string
  limit?: number
  authority?: AnchorExperimentDerivedAuthority
}>): Promise<AnchorExperimentState | undefined> {
  const destination = anchorExperimentStateFile(input.workdir, input.folder, input.limit, input.binding)
  let payload: PersistedAnchorExperimentState
  try {
    const bytes = await readFile(destination, 'utf8')
    try {
      payload = JSON.parse(bytes) as PersistedAnchorExperimentState
    } catch {
      throw new AnchorExperimentStateError(
        'PERSISTED_EXPERIMENT_STATE_CORRUPT',
        '实验状态文件不是有效 JSON；为避免重复付费，恢复已阻止。',
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof AnchorExperimentStateError) throw error
    throw new AnchorExperimentStateError(
      'PERSISTED_EXPERIMENT_STATE_UNREADABLE',
      '实验状态文件无法读取；为避免重复付费，恢复已阻止。',
    )
  }
  if (payload.schemaVersion !== ANCHOR_EXPERIMENT_STATE_SCHEMA
    || !sameBinding(payload.binding, input.binding)) {
    throw new AnchorExperimentStateError(
      'PERSISTED_EXPERIMENT_BINDING_MISMATCH',
      '持久化实验状态的 arm/manifest/route 与当前 binding 不一致。',
    )
  }
  const allowed = new Set(input.candidateIds)
  if (!Array.isArray(payload.candidateIds)
    || payload.candidateIds.length !== allowed.size
    || new Set(payload.candidateIds).size !== payload.candidateIds.length
    || payload.candidateIds.some(id => !allowed.has(id))) {
    throw new AnchorExperimentStateError('PERSISTED_CANDIDATE_UNIVERSE_MISMATCH', '实验候选宇宙已变化。')
  }
  const state = new AnchorExperimentState(input.binding, input.candidateIds)
  const loadScores = (
    rows: readonly (readonly [string, StoredExperimentAssessment])[],
    role: PortraitEvaluationRole,
  ) => {
    if (!Array.isArray(rows)) {
      throw new AnchorExperimentStateError('PERSISTED_EXPERIMENT_STATE_INVALID', '评分缓存不是数组。')
    }
    const seenSlots = new Set<string>()
    const seenCacheKeys = new Set<string>()
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') {
        throw new AnchorExperimentStateError('PERSISTED_SCORE_IDENTITY_MISMATCH', '评分缓存 tuple 无效。')
      }
      const [slot, stored] = row
      const assessment = stored?.assessment
      if (!assessment || !allowed.has(assessment.id) || assessment.role !== role) {
        throw new AnchorExperimentStateError('PERSISTED_SCORE_IDENTITY_MISMATCH', '评分缓存包含未知候选或角色。')
      }
      const expected = anchorExperimentScoreCacheKey({
        binding: input.binding, role, id: assessment.id, detail: assessment.detail,
      })
      const expectedSlot = scoreSlot(role, assessment.id, assessment.detail)
      if (slot !== expectedSlot || stored.cacheKey !== expected
        || seenSlots.has(slot) || seenCacheKeys.has(stored.cacheKey)) {
        throw new AnchorExperimentStateError(
          'PERSISTED_SCORE_IDENTITY_MISMATCH',
          '评分缓存身份不匹配；为避免静默重付费，恢复已阻止。',
        )
      }
      seenSlots.add(slot)
      seenCacheKeys.add(stored.cacheKey)
      const validated = validatePersistedAssessment(assessment)
      state.recordScore(validated)
    }
  }
  loadScores(payload.selectorScores, 'selector')
  loadScores(payload.auditScores, 'audit')
  const loadLegs = (
    rows: readonly (readonly [string, ExperimentPairwiseLegRecord])[],
    role: PortraitEvaluationRole,
  ) => {
    if (!Array.isArray(rows)) {
      throw new AnchorExperimentStateError('PERSISTED_EXPERIMENT_STATE_INVALID', 'pairwise 缓存不是数组。')
    }
    const seenKeys = new Set<string>()
    const seenSemanticLegs = new Set<string>()
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') {
        throw new AnchorExperimentStateError(
          'PERSISTED_PAIRWISE_IDENTITY_MISMATCH', 'pairwise 缓存 tuple 无效。',
        )
      }
      const [key, record] = row
      if (!record || record.role !== role || !allowed.has(record.aId) || !allowed.has(record.bId)) {
        throw new AnchorExperimentStateError(
          'PERSISTED_PAIRWISE_IDENTITY_MISMATCH',
          'pairwise 缓存包含未知候选或角色。',
        )
      }
      try {
        const expected = anchorExperimentPairwiseLegCacheKey({
          binding: input.binding,
          role,
          aId: record.aId,
          bId: record.bId,
          order: record.order,
          pairCandidateReceiptHash: record.pairCandidateReceiptHash,
        })
        const semanticKey = JSON.stringify([role, record.aId, record.bId, record.order])
        if (key !== expected || record.cacheKey !== expected
          || seenKeys.has(key) || seenSemanticLegs.has(semanticKey)) {
          throw new AnchorExperimentStateError(
            'PERSISTED_PAIRWISE_IDENTITY_MISMATCH',
            'pairwise 缓存身份不匹配；为避免静默重付费，恢复已阻止。',
          )
        }
        seenKeys.add(key)
        seenSemanticLegs.add(semanticKey)
        state.recordPairwiseLeg(record)
      } catch (error) {
        if (error instanceof AnchorExperimentStateError) throw error
        throw new AnchorExperimentStateError(
          'PERSISTED_PAIRWISE_INVALID',
          '持久化 pairwise leg 无效；为避免错误缓存命中，恢复已阻止。',
        )
      }
    }
  }
  loadLegs(payload.selectorPairwiseLegs, 'selector')
  loadLegs(payload.auditPairwiseLegs, 'audit')
  const providerOperations = validateProviderOperationRows(payload.providerOperations, state)
  for (const [, operation] of providerOperations) {
    state.restoreProviderOperation(RESTORE_PROVIDER_OPERATION, operation)
  }
  validateEvidenceOperationCoverage(providerOperations, state)
  const structurallyValidRefinement = validateRefinementCheckpoint(
    payload.refinementCheckpoint, input.binding, allowed,
  )
  const structurallyValidPairwise = validatePairwiseCheckpoint(
    payload.pairwiseCheckpoint, input.binding, allowed,
  )
  const structurallyValidDraft = validateDraft(payload.draft, input.binding, allowed)
  const structurallyValidAudit = validateAudit(
    payload.audit, input.binding, allowed, structurallyValidDraft,
  )
  const expectedPhase = validateDerivedAuthority(input.authority, input.binding)
  const structurallyValidSelectorRound = validateSelectorRound(
    payload.selectorRound, input.binding, allowed,
  )
  const evidence = state.evidenceView()
  const auditEvidence = state.auditEvidenceView()
  const expectedSelectorRound = resolveExpectedSelectorRound({
    authority: input.authority,
    binding: input.binding,
    allowed,
    evidence,
    auditEvidence,
  })
  if (structurallyValidSelectorRound || expectedSelectorRound) {
    if (!input.authority || !expectedSelectorRound
      || !sameCanonical(structurallyValidSelectorRound, expectedSelectorRound)) {
      throw new AnchorExperimentStateError(
        'PERSISTED_SELECTOR_ROUND_AUTHORITY_MISMATCH',
        '持久化 selector round 与当前命名 Agent authority 不一致。',
      )
    }
  }
  state.selectorRound = structurallyValidSelectorRound
  const derivedPresence = {
    refinement: structurallyValidRefinement !== undefined,
    pairwise: structurallyValidPairwise !== undefined,
    draft: structurallyValidDraft !== undefined,
    audit: structurallyValidAudit !== undefined,
  }
  if (input.authority) assertDerivedPresenceMatchesPhase(expectedPhase, derivedPresence)
  if (structurallyValidAudit && input.authority
    && input.authority.expectedAuditRound !== structurallyValidAudit.round) {
    throw new AnchorExperimentStateError(
      'PERSISTED_AUDIT_ROUND_MISMATCH',
      'audit report round 与当前 DSH 命令冻结 round 不一致。',
    )
  }
  const stageNeeds = derivedStageNeeds(state, derivedPresence, expectedPhase)
  state.refinementCheckpoint = requireDerivedAuthority({
    label: 'refinement checkpoint',
    persisted: structurallyValidRefinement,
    recompute: input.authority?.recomputeRefinementCheckpoint
      ? () => input.authority!.recomputeRefinementCheckpoint!(evidence)
      : undefined,
    required: stageNeeds.refinement,
  })
  state.pairwiseCheckpoint = requireDerivedAuthority({
    label: 'pairwise checkpoint',
    persisted: structurallyValidPairwise,
    recompute: input.authority?.recomputePairwiseCheckpoint && state.refinementCheckpoint
      ? () => input.authority!.recomputePairwiseCheckpoint!(evidence, state.refinementCheckpoint!)
      : undefined,
    required: stageNeeds.pairwise,
  })
  state.draft = requireDerivedAuthority({
    label: 'selection draft',
    persisted: structurallyValidDraft,
    recompute: input.authority?.recomputeDraft
      && state.refinementCheckpoint && state.pairwiseCheckpoint
      ? () => input.authority!.recomputeDraft!(
        evidence, state.refinementCheckpoint!, state.pairwiseCheckpoint!,
      )
      : undefined,
    required: stageNeeds.draft,
  })
  state.audit = requireDerivedAuthority({
    label: 'audit report',
    persisted: structurallyValidAudit,
    recompute: input.authority?.recomputeAudit && state.draft
      && state.refinementCheckpoint && state.pairwiseCheckpoint
      && input.authority.expectedAuditRound !== undefined
      ? () => input.authority!.recomputeAudit!(
        auditEvidence, state.draft!, state.refinementCheckpoint!, state.pairwiseCheckpoint!,
        input.authority!.expectedAuditRound!,
      )
      : undefined,
    required: stageNeeds.audit,
  })
  const persistedPaidCalls = validatePaidCalls(payload.paidCalls)
  if (!sameCanonical(persistedPaidCalls, state.paidCalls)) {
    throw new AnchorExperimentStateError(
      'PERSISTED_PAID_CALLS_INVALID',
      '付费调用汇总与逐请求 operation ledger 不一致。',
    )
  }
  return state
}
