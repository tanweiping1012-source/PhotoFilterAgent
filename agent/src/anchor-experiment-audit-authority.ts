import { createHash } from 'node:crypto'
import { PHOTO_ANCHOR_LAB_CODEX_ID } from './anchor-lab-codex-identity.ts'
import {
  aggregateExperimentComparisons,
  type FrozenAnchorLabCandidateCatalog,
  type AnchorLabHistoricalAuditRecompute,
} from './anchor-experiment-authority.ts'
import type {
  AnchorExperimentAuditEvidenceView,
  AnchorExperimentAuditReport,
  AnchorExperimentDraft,
  AnchorExperimentRunBinding,
  ExperimentAssessment,
  ExperimentPairwiseLegRecord,
} from './anchor-experiment-state.ts'

export const ANCHOR_LAB_CODEX_AUDIT_POLICY =
  'photo-anchor-lab-codex-audit/v1' as const
export const ANCHOR_LAB_CODEX_AUDIT_PROMOTION_CAP = 60
export const ANCHOR_LAB_CODEX_AUDIT_PROMOTION_COMPONENT_CAP = 20
export const ANCHOR_LAB_CODEX_AUDIT_PAIR_CAP = 8

type Hash = string

export interface AnchorLabAuditUniverse {
  readonly contextKey: Hash
  readonly derivedSeed: Hash
  readonly selectedHighIds: readonly string[]
  readonly remainingLowIds: readonly string[]
  readonly randomChallengerIds: readonly string[]
}

export interface AnchorLabAuditPromotionPlan {
  readonly planHash: Hash
  readonly promotionIds: readonly string[]
  readonly randomChallengerIds: readonly string[]
  readonly cutlineChallengerIds: readonly string[]
  readonly familyChallengerIds: readonly string[]
}

export interface AnchorLabAuditPairPlanRow {
  readonly challengerId: string
  readonly selectedId: string
  readonly aId: string
  readonly bId: string
}

export interface AnchorLabAuditPairPlan {
  readonly planHash: Hash
  readonly pairs: readonly AnchorLabAuditPairPlanRow[]
}

export interface AnchorLabAuditCoverage {
  readonly contextKey: Hash
  readonly stage: 'selected_high' | 'remaining_low' | 'promotion_high' | 'pairwise' | 'complete'
  readonly selectedHigh: Readonly<{
    planned: number
    completed: number
    missingIds: readonly string[]
  }>
  readonly remainingLow: Readonly<{
    planned: number
    completed: number
    missingIds: readonly string[]
  }>
  readonly promotionHigh: Readonly<{
    planFrozen: boolean
    planned: number
    completed: number
    missingIds: readonly string[]
  }>
  readonly pairwise: Readonly<{
    planFrozen: boolean
    plannedPairs: number
    plannedLegs: number
    completedLegs: number
    missingLegKeys: readonly string[]
  }>
  readonly unresolvedOperationKeys: readonly string[]
  readonly complete: boolean
}

export interface AnchorLabAuditComputation {
  readonly universe: AnchorLabAuditUniverse
  readonly promotionPlan?: AnchorLabAuditPromotionPlan
  readonly pairPlan?: AnchorLabAuditPairPlan
  readonly coverage: AnchorLabAuditCoverage
  readonly report: AnchorExperimentAuditReport
}

export class AnchorExperimentAuditAuthorityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentAuditAuthorityError'
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function seededOrder(ids: readonly string[], seed: string, namespace: string): readonly string[] {
  return Object.freeze([...ids].sort((left, right) => {
    const leftHash = sha256([PHOTO_ANCHOR_LAB_CODEX_ID, seed, namespace, left].join('\u0000'))
    const rightHash = sha256([PHOTO_ANCHOR_LAB_CODEX_ID, seed, namespace, right].join('\u0000'))
    return leftHash.localeCompare(rightHash) || left.localeCompare(right)
  }))
}

function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join('\u0000')
}

function auditScores(evidence: AnchorExperimentAuditEvidenceView): Map<string, ExperimentAssessment> {
  return new Map(evidence.auditScores.map(([, stored]) => [
    `${stored.assessment.id}\u0000${stored.assessment.detail}`,
    stored.assessment,
  ]))
}

function bestScore(
  scores: ReadonlyMap<string, ExperimentAssessment>,
  id: string,
): ExperimentAssessment | undefined {
  return scores.get(`${id}\u0000high`) ?? scores.get(`${id}\u0000low`)
}

function intervalOverlaps(
  left: readonly [number, number] | null,
  right: readonly [number, number] | null,
): boolean {
  return Boolean(left && right && left[0] <= right[1] && right[0] <= left[1])
}

function scoreOrder(
  scores: ReadonlyMap<string, ExperimentAssessment>,
  left: string,
  right: string,
): number {
  const leftScore = bestScore(scores, left)?.score ?? Number.NEGATIVE_INFINITY
  const rightScore = bestScore(scores, right)?.score ?? Number.NEGATIVE_INFINITY
  return rightScore - leftScore || left.localeCompare(right)
}

export function createAnchorLabAuditUniverse(input: Readonly<{
  binding: AnchorExperimentRunBinding
  catalog: FrozenAnchorLabCandidateCatalog
  draft: AnchorExperimentDraft
  auditRound: number
}>): AnchorLabAuditUniverse {
  if (input.draft.bindingHash !== input.binding.stateNamespaceHash
    || input.draft.keep.length !== input.binding.targetK
    || new Set(input.draft.keep).size !== input.draft.keep.length
    || !Number.isInteger(input.auditRound) || input.auditRound < 1
    || input.auditRound > input.binding.budget.maxCompleteAuditRounds
    || input.catalog.datasetFingerprint !== input.binding.datasetFingerprint) {
    throw new AnchorExperimentAuditAuthorityError('AUDIT_CONTEXT_INVALID', 'audit draft/round/catalog 身份无效。')
  }
  const catalogIds = input.catalog.candidates.map(row => row.id)
  if (input.draft.keep.some(id => !catalogIds.includes(id))) {
    throw new AnchorExperimentAuditAuthorityError('AUDIT_SELECTION_OUTSIDE_UNIVERSE', 'selected ID 不在候选宇宙。')
  }
  const selected = new Set(input.draft.keep)
  const remaining = catalogIds.filter(id => !selected.has(id))
  const derivedSeed = sha256([
    PHOTO_ANCHOR_LAB_CODEX_ID,
    input.binding.seed,
    String(input.auditRound),
    input.draft.selectionHash,
  ].join('\u0000'))
  const remainingLowIds = seededOrder(remaining, derivedSeed, 'remaining-low')
  const randomCount = Math.min(remaining.length, Math.min(24, Math.max(12, input.binding.targetK)))
  const randomChallengerIds = seededOrder(remaining, derivedSeed, 'random-promotion')
    .slice(0, randomCount)
  const identity = {
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    policy: ANCHOR_LAB_CODEX_AUDIT_POLICY,
    bindingHash: input.binding.stateNamespaceHash,
    selectionHash: input.draft.selectionHash,
    auditRound: input.auditRound,
    derivedSeed,
    contracts: {
      low: input.binding.contracts.auditLow,
      high: input.binding.contracts.auditHigh,
      pairwise: input.binding.contracts.auditPairwise,
    },
    selectedHighIds: input.draft.keep,
    remainingLowIds,
    randomChallengerIds,
  }
  return immutable({
    contextKey: canonicalHash(identity),
    derivedSeed,
    selectedHighIds: input.draft.keep,
    remainingLowIds,
    randomChallengerIds,
  })
}

function createPromotionPlan(input: Readonly<{
  catalog: FrozenAnchorLabCandidateCatalog
  universe: AnchorLabAuditUniverse
  scores: ReadonlyMap<string, ExperimentAssessment>
}>): AnchorLabAuditPromotionPlan {
  const selectedAssessments = input.universe.selectedHighIds
    .map(id => input.scores.get(`${id}\u0000high`))
    .filter((row): row is ExperimentAssessment => Boolean(row))
  const weakestSelected = selectedAssessments
    .filter(row => row.eligibility === 'eligible' && row.score !== null)
    .sort((left, right) => left.score! - right.score! || left.id.localeCompare(right.id))[0]
  const cutlineChallengerIds = input.universe.remainingLowIds.filter(id => {
    const assessment = input.scores.get(`${id}\u0000low`)
    if (!assessment) return false
    if (assessment.eligibility === 'needs_review') return true
    if (!weakestSelected || assessment.eligibility !== 'eligible' || assessment.score === null) return false
    return assessment.score >= weakestSelected.score! - 4
      || intervalOverlaps(assessment.scoreInterval, weakestSelected.scoreInterval)
  }).sort((left, right) => scoreOrder(input.scores, left, right))
    .slice(0, ANCHOR_LAB_CODEX_AUDIT_PROMOTION_COMPONENT_CAP)

  const metaById = new Map(input.catalog.candidates.map(row => [row.id, row]))
  const selectedFamilies = [...new Set(input.universe.selectedHighIds
    .map(id => metaById.get(id)?.familyId)
    .filter((family): family is string => Boolean(family)))].sort()
  const familyChallengers: string[] = []
  for (const family of selectedFamilies) {
    familyChallengers.push(...input.universe.remainingLowIds
      .filter(id => metaById.get(id)?.familyId === family)
      .sort((left, right) => scoreOrder(input.scores, left, right))
      .slice(0, 2))
  }
  const familyChallengerIds = [...new Set(familyChallengers)]
    .slice(0, ANCHOR_LAB_CODEX_AUDIT_PROMOTION_COMPONENT_CAP)
  const promotionIds = [...new Set([
    ...input.universe.randomChallengerIds,
    ...cutlineChallengerIds,
    ...familyChallengerIds,
  ])].slice(0, ANCHOR_LAB_CODEX_AUDIT_PROMOTION_CAP)
  const identity = {
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    policy: ANCHOR_LAB_CODEX_AUDIT_POLICY,
    contextKey: input.universe.contextKey,
    randomChallengerIds: input.universe.randomChallengerIds,
    cutlineChallengerIds,
    familyChallengerIds,
    promotionIds,
    lowEvidenceHash: canonicalHash(input.universe.remainingLowIds.map(id =>
      input.scores.get(`${id}\u0000low`))),
    selectedHighEvidenceHash: canonicalHash(input.universe.selectedHighIds.map(id =>
      input.scores.get(`${id}\u0000high`))),
  }
  return immutable({
    planHash: canonicalHash(identity),
    promotionIds,
    randomChallengerIds: input.universe.randomChallengerIds,
    cutlineChallengerIds,
    familyChallengerIds,
  })
}

function createPairPlan(input: Readonly<{
  catalog: FrozenAnchorLabCandidateCatalog
  universe: AnchorLabAuditUniverse
  promotion: AnchorLabAuditPromotionPlan
  scores: ReadonlyMap<string, ExperimentAssessment>
}>): AnchorLabAuditPairPlan {
  const selected = input.universe.selectedHighIds
    .map(id => input.scores.get(`${id}\u0000high`))
    .filter((row): row is ExperimentAssessment => Boolean(row)
      && row!.eligibility === 'eligible' && row!.score !== null)
    .sort((left, right) => left.score! - right.score! || left.id.localeCompare(right.id))
  const weakest = selected[0]
  const metaById = new Map(input.catalog.candidates.map(row => [row.id, row]))
  const selectedByFamily = new Map<string, ExperimentAssessment[]>()
  for (const assessment of selected) {
    const family = metaById.get(assessment.id)?.familyId
    if (!family) continue
    const rows = selectedByFamily.get(family) ?? []
    rows.push(assessment)
    selectedByFamily.set(family, rows)
  }
  for (const rows of selectedByFamily.values()) {
    rows.sort((left, right) => left.score! - right.score! || left.id.localeCompare(right.id))
  }
  const challengers = weakest ? input.promotion.promotionIds
    .map(id => input.scores.get(`${id}\u0000high`))
    .filter((row): row is ExperimentAssessment => Boolean(row)
      && row!.eligibility === 'eligible' && row!.score !== null)
    .filter(row => row.score! >= weakest.score! - 4
      || intervalOverlaps(row.scoreInterval, weakest.scoreInterval))
    .sort((left, right) => right.score! - left.score! || left.id.localeCompare(right.id))
    .slice(0, ANCHOR_LAB_CODEX_AUDIT_PAIR_CAP) : []
  const pairs = challengers.map(challenger => {
    const family = metaById.get(challenger.id)?.familyId
    const selectedId = (family ? selectedByFamily.get(family)?.[0] : undefined)?.id ?? weakest!.id
    const [aId, bId] = [challenger.id, selectedId].sort()
    return Object.freeze({ challengerId: challenger.id, selectedId, aId, bId })
  })
  const identity = {
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    policy: ANCHOR_LAB_CODEX_AUDIT_POLICY,
    contextKey: input.universe.contextKey,
    promotionPlanHash: input.promotion.planHash,
    highEvidenceHash: canonicalHash(input.promotion.promotionIds.map(id =>
      input.scores.get(`${id}\u0000high`))),
    pairs,
  }
  return immutable({ planHash: canonicalHash(identity), pairs })
}

function effectiveLegOrders(
  legs: readonly ExperimentPairwiseLegRecord[],
  aId: string,
  bId: string,
): ReadonlySet<'AB' | 'BA'> {
  const orders = new Set<'AB' | 'BA'>()
  for (const leg of legs) {
    if (leg.role !== 'audit' || pairKey(leg.aId, leg.bId) !== pairKey(aId, bId)) continue
    const forward = leg.aId < leg.bId
    orders.add(forward ? leg.order : leg.order === 'AB' ? 'BA' : 'AB')
  }
  return orders
}

export function computeAnchorLabAudit(input: Readonly<{
  binding: AnchorExperimentRunBinding
  catalog: FrozenAnchorLabCandidateCatalog
  draft: AnchorExperimentDraft
  evidence: AnchorExperimentAuditEvidenceView
  auditRound: number
}>): AnchorLabAuditComputation {
  if (input.evidence.binding.stateNamespaceHash !== input.binding.stateNamespaceHash
    || !sameStrings(input.evidence.candidateIds, input.catalog.candidates.map(row => row.id))) {
    throw new AnchorExperimentAuditAuthorityError('AUDIT_EVIDENCE_UNIVERSE_MISMATCH', 'audit evidence 宇宙不匹配。')
  }
  const universe = createAnchorLabAuditUniverse(input)
  const scores = auditScores(input.evidence)
  const missingSelected = universe.selectedHighIds
    .filter(id => !scores.has(`${id}\u0000high`))
  const missingRemaining = universe.remainingLowIds
    .filter(id => !scores.has(`${id}\u0000low`))
  const promotionPlan = missingSelected.length === 0 && missingRemaining.length === 0
    ? createPromotionPlan({ catalog: input.catalog, universe, scores })
    : undefined
  const missingPromotion = promotionPlan?.promotionIds
    .filter(id => !scores.has(`${id}\u0000high`)) ?? []
  const pairPlan = promotionPlan && missingPromotion.length === 0
    ? createPairPlan({ catalog: input.catalog, universe, promotion: promotionPlan, scores })
    : undefined
  const auditLegs = input.evidence.auditPairwiseLegs.map(([, record]) => record)
  const missingLegKeys: string[] = []
  let completedLegs = 0
  for (const pair of pairPlan?.pairs ?? []) {
    const orders = effectiveLegOrders(auditLegs, pair.aId, pair.bId)
    for (const order of ['AB', 'BA'] as const) {
      if (orders.has(order)) completedLegs += 1
      else missingLegKeys.push(canonicalHash({
        technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
        auditContextKey: universe.contextKey,
        pairPlanHash: pairPlan!.planHash,
        aId: pair.aId,
        bId: pair.bId,
        order,
      }))
    }
  }
  const unresolvedOperationKeys = input.evidence.providerOperations
    .filter(([, operation]) => operation.role === 'audit' && operation.status === 'reserved')
    .map(([key]) => key).sort()
  const stage = missingSelected.length ? 'selected_high'
    : missingRemaining.length ? 'remaining_low'
      : missingPromotion.length ? 'promotion_high'
        : missingLegKeys.length || unresolvedOperationKeys.length ? 'pairwise'
          : 'complete'
  const complete = stage === 'complete' && unresolvedOperationKeys.length === 0
  const coverage: AnchorLabAuditCoverage = immutable({
    contextKey: universe.contextKey,
    stage,
    selectedHigh: {
      planned: universe.selectedHighIds.length,
      completed: universe.selectedHighIds.length - missingSelected.length,
      missingIds: missingSelected,
    },
    remainingLow: {
      planned: universe.remainingLowIds.length,
      completed: universe.remainingLowIds.length - missingRemaining.length,
      missingIds: missingRemaining,
    },
    promotionHigh: {
      planFrozen: Boolean(promotionPlan),
      planned: promotionPlan?.promotionIds.length ?? 0,
      completed: (promotionPlan?.promotionIds.length ?? 0) - missingPromotion.length,
      missingIds: missingPromotion,
    },
    pairwise: {
      planFrozen: Boolean(pairPlan),
      plannedPairs: pairPlan?.pairs.length ?? 0,
      plannedLegs: (pairPlan?.pairs.length ?? 0) * 2,
      completedLegs,
      missingLegKeys,
    },
    unresolvedOperationKeys,
    complete,
  })

  let strongerChallengerIds: readonly string[] = Object.freeze([])
  let disqualifiedSelectedIds: readonly string[] = Object.freeze([])
  if (complete) {
    const selectedHigh = universe.selectedHighIds.map(id => scores.get(`${id}\u0000high`)!)
    const disqualified = new Set(selectedHigh
      .filter(row => row.eligibility !== 'eligible' || row.score === null)
      .map(row => row.id))
    const validSelected = selectedHigh
      .filter(row => row.eligibility === 'eligible' && row.score !== null)
    const weakestScore = validSelected.length
      ? Math.min(...validSelected.map(row => row.score!)) : null
    const stronger = new Set<string>()
    if (weakestScore !== null) {
      for (const id of universe.remainingLowIds) {
        const assessment = bestScore(scores, id)
        if (assessment?.eligibility === 'eligible' && assessment.score !== null
          && assessment.score > weakestScore + 4) stronger.add(id)
      }
    }
    const aggregated = aggregateExperimentComparisons({
      binding: input.binding,
      legs: auditLegs,
      role: 'audit',
    })
    const plannedPairKeys = new Set((pairPlan?.pairs ?? []).map(pair => pairKey(pair.aId, pair.bId)))
    const extras = aggregated.filter(row => !plannedPairKeys.has(pairKey(row.aId, row.bId)))
    if (extras.length) {
      throw new AnchorExperimentAuditAuthorityError(
        'UNPLANNED_AUDIT_COMPARISON',
        '计划外 audit comparison 不得影响 PASS/FAIL。',
      )
    }
    const comparisonByPair = new Map(aggregated.map(row => [pairKey(row.aId, row.bId), row]))
    for (const pair of pairPlan?.pairs ?? []) {
      const comparison = comparisonByPair.get(pairKey(pair.aId, pair.bId))!
      const challengerWins = comparison.terminal === 'left'
        ? comparison.aId === pair.challengerId
        : comparison.terminal === 'right' && comparison.bId === pair.challengerId
      if (challengerWins) stronger.add(pair.challengerId)
      if (comparison.terminal === 'reject_both') disqualified.add(pair.selectedId)
    }
    strongerChallengerIds = Object.freeze([...stronger].sort())
    disqualifiedSelectedIds = Object.freeze([...disqualified].sort())
  }
  const status = !complete ? 'INCOMPLETE'
    : strongerChallengerIds.length || disqualifiedSelectedIds.length ? 'FAIL' : 'PASS'
  const report: AnchorExperimentAuditReport = immutable({
    schemaVersion: 'photo-filter-anchor-audit/v1',
    round: input.auditRound,
    bindingHash: input.binding.stateNamespaceHash,
    selectionHash: input.draft.selectionHash,
    status,
    stage,
    selectedIds: input.draft.keep,
    remainingCount: missingSelected.length + missingRemaining.length + missingPromotion.length,
    pairwiseRemainingCount: missingLegKeys.length + unresolvedOperationKeys.length,
    strongerChallengerIds,
    disqualifiedSelectedIds,
  })
  return immutable({ universe, promotionPlan, pairPlan, coverage, report })
}

/** Adapter for AnchorExperimentDerivedAuthority.recomputeAudit. */
export function createAnchorLabAuditRecompute(input: Readonly<{
  binding: AnchorExperimentRunBinding
  catalog: FrozenAnchorLabCandidateCatalog
}>): (
  evidence: AnchorExperimentAuditEvidenceView,
  draft: AnchorExperimentDraft,
  _refinement: unknown,
  _pairwise: unknown,
  expectedRound: number,
) => AnchorExperimentAuditReport {
  return (evidence, draft, _refinement, _pairwise, expectedRound) => computeAnchorLabAudit({
    binding: input.binding,
    catalog: input.catalog,
    draft,
    evidence,
    auditRound: expectedRound,
  }).report
}

/**
 * Historical selector-round verifier. The caller supplies evidence sliced to
 * the exact historical stage, so this adapter can return the frozen promotion
 * and pair plans without exposing selector state to the isolated evaluator.
 */
export function createAnchorLabHistoricalAuditRecompute(input: Readonly<{
  binding: AnchorExperimentRunBinding
  catalog: FrozenAnchorLabCandidateCatalog
}>): AnchorLabHistoricalAuditRecompute {
  return (evidence, draft, expectedRound) => computeAnchorLabAudit({
    binding: input.binding,
    catalog: input.catalog,
    draft,
    evidence,
    auditRound: expectedRound,
  })
}
