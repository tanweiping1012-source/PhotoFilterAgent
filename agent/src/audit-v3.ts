/**
 * Pure planning and cache identities for the isolated staged portrait audit.
 *
 * This module deliberately has no RunState dependency. Its inputs contain only
 * anonymous candidate/family identities, the five evaluator inputs, frozen
 * rubric/provider identity, and assessments produced by the audit role.
 */

import { createHash } from 'node:crypto'
import type {
  PairwiseResult,
  PortraitBaselineAssessment,
  PortraitDetail,
  PortraitVisionCacheIdentity,
} from './portrait-vision.ts'
import { PORTRAIT_BASELINE_RUBRIC_VERSION } from './rubric.ts'

export const PORTRAIT_AUDIT_V3 = 'portrait-audit-v3'
/**
 * Planning policy is versioned separately from score/pair cache identities.
 * A policy change must invalidate a frozen audit plan, while rubric-identical
 * image assessments remain safe to reuse.
 */
export const PORTRAIT_AUDIT_PLAN_VERSION = 'bounded-promotions-v1'
// DeepSeek Harness one-shot evaluator 存在单轮墙钟上限。32 是跨模型的
// 保守 provider-operation 硬上限；不声称任意模型都能在一轮内完成。超出时通过
// checkpoint + INCOMPLETE 续跑 remaining，而不得改换供应商或模型。
export const AUDIT_PROVIDER_CALL_BUDGET = 32
/** Every successful provider response is checkpointed before scheduling another call. */
export const AUDIT_CHECKPOINT_BATCH_SIZE = 1
export const AUDIT_MAX_PAIRWISE_PAIRS = 8
export const AUDIT_MAX_PAIRWISE_LEGS = AUDIT_MAX_PAIRWISE_PAIRS * 2
export const AUDIT_FAMILY_CHALLENGERS_PER_SELECTED_FAMILY = 2
/** Fixed sample + cutline + family promotions may never expand to the corpus. */
export const AUDIT_MAX_PROMOTION_HIGH = 60
export const AUDIT_MAX_PROMOTION_COMPONENT = 20

export interface AuditCandidateIdentity {
  id: string
  family?: string
}

export interface AuditV3Context {
  datasetFingerprint: string
  candidateScope: string
  selectedIds: readonly string[]
  target: number
  seed: string
  provider: PortraitVisionCacheIdentity
}

export interface AuditUniversePlan {
  selectedHighIds: readonly string[]
  remainingLowIds: readonly string[]
  randomChallengerIds: readonly string[]
  randomCount: number
}

export interface AuditPromotionPlan {
  promotionIds: readonly string[]
  cutlineChallengerIds: readonly string[]
  familyChallengerIds: readonly string[]
  randomChallengerIds: readonly string[]
}

export interface AuditPairPlan {
  challengerId: string
  selectedId: string
}

export interface AuditQualityResult {
  weakestSelectedScore: number | null
  selectedQualityIssueIds: readonly string[]
  strongerChallengers: ReadonlyArray<{ id: string; score: number; margin: number; reason: string }>
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`)
}

function seededOrder(ids: readonly string[], seed: string, namespace: string): string[] {
  return [...ids].sort((left, right) => {
    const leftHash = digest([PORTRAIT_AUDIT_V3, seed, namespace, left])
    const rightHash = digest([PORTRAIT_AUDIT_V3, seed, namespace, right])
    return leftHash.localeCompare(rightHash) || left.localeCompare(right)
  })
}

export function auditV3ContextKey(context: AuditV3Context): string {
  return digest([
    PORTRAIT_AUDIT_V3,
    PORTRAIT_AUDIT_PLAN_VERSION,
    context.datasetFingerprint,
    context.candidateScope,
    [...context.selectedIds].sort().join('\u0001'),
    String(context.target),
    context.seed,
    context.provider.routeIdentity,
    context.provider.auditBaselinePromptHash,
    context.provider.auditPairwisePromptHash,
  ])
}

/** Cache identity includes every required role/data/detail/rubric/prompt/provider dimension. */
export function auditScoreCacheKey(input: {
  datasetFingerprint: string
  id: string
  detail: PortraitDetail
  provider: PortraitVisionCacheIdentity
}): string {
  return digest([
    PORTRAIT_AUDIT_V3,
    'role:audit',
    input.datasetFingerprint,
    input.id,
    input.detail,
    PORTRAIT_BASELINE_RUBRIC_VERSION,
    input.provider.auditBaselinePromptHash,
    input.provider.routeIdentity,
  ])
}

/** AB and BA are intentionally different cache entries and can resume independently. */
export function auditPairwiseLegCacheKey(input: {
  datasetFingerprint: string
  challengerId: string
  selectedId: string
  order: 'AB' | 'BA'
  provider: PortraitVisionCacheIdentity
}): string {
  return digest([
    PORTRAIT_AUDIT_V3,
    'role:audit-pairwise',
    input.datasetFingerprint,
    input.challengerId,
    input.selectedId,
    input.order,
    PORTRAIT_BASELINE_RUBRIC_VERSION,
    input.provider.auditPairwisePromptHash,
    input.provider.routeIdentity,
  ])
}

/** Stage A/B plan: selected high, every other candidate low, plus a frozen seed sample. */
export function planAuditUniverse(
  candidates: readonly AuditCandidateIdentity[],
  selectedIds: readonly string[],
  target: number,
  seed: string,
): AuditUniversePlan {
  if (!Number.isInteger(target) || target <= 0 || selectedIds.length !== target) {
    throw new RangeError('selectedIds must contain exactly target positive entries')
  }
  assertUnique(selectedIds, 'selectedIds')
  assertUnique(candidates.map(candidate => candidate.id), 'candidates')
  const candidateSet = new Set(candidates.map(candidate => candidate.id))
  if (selectedIds.some(id => !candidateSet.has(id))) throw new TypeError('selectedIds contain an unknown candidate')
  const selectedSet = new Set(selectedIds)
  const remaining = candidates.map(candidate => candidate.id).filter(id => !selectedSet.has(id))
  const randomCount = Math.min(remaining.length, Math.min(24, Math.max(12, target)))
  return Object.freeze({
    selectedHighIds: Object.freeze([...selectedIds]),
    remainingLowIds: Object.freeze(seededOrder(remaining, seed, 'stage-b-low')),
    randomChallengerIds: Object.freeze(seededOrder(remaining, seed, 'stage-c-random').slice(0, randomCount)),
    randomCount,
  })
}

function intervalsOverlap(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1]
}

function assessmentOrder(
  assessments: ReadonlyMap<string, PortraitBaselineAssessment>,
  left: string,
  right: string,
): number {
  const leftScore = assessments.get(left)?.baselineScore ?? Number.NEGATIVE_INFINITY
  const rightScore = assessments.get(right)?.baselineScore ?? Number.NEGATIVE_INFINITY
  return rightScore - leftScore || left.localeCompare(right)
}

/** Stage C is derived only from independent audit assessments. */
export function planAuditPromotions(
  candidates: readonly AuditCandidateIdentity[],
  universe: AuditUniversePlan,
  assessments: ReadonlyMap<string, PortraitBaselineAssessment>,
): AuditPromotionPlan {
  const selectedAssessments = universe.selectedHighIds
    .map(id => assessments.get(id))
    .filter((value): value is PortraitBaselineAssessment => Boolean(value))
  const weakestSelected = selectedAssessments
    .filter(value => value.baselineScore !== null)
    .sort((left, right) => left.baselineScore! - right.baselineScore! || left.id.localeCompare(right.id))[0]

  const cutlineChallengerIds = universe.remainingLowIds.filter(id => {
    const assessment = assessments.get(id)
    if (!assessment) return false
    if (assessment.eligibility.status === 'needs_review') return true
    if (!weakestSelected || assessment.baselineScore === null) return false
    return assessment.baselineScore >= weakestSelected.baselineScore! - 4
      || intervalsOverlap(assessment.scoreInterval, weakestSelected.scoreInterval)
  }).sort((left, right) => assessmentOrder(assessments, left, right))
    .slice(0, AUDIT_MAX_PROMOTION_COMPONENT)

  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const selectedFamilies = new Set(universe.selectedHighIds
    .map(id => candidateById.get(id)?.family)
    .filter((family): family is string => Boolean(family)))
  const familyChallengerIds: string[] = []
  for (const family of [...selectedFamilies].sort()) {
    const members = universe.remainingLowIds
      .filter(id => candidateById.get(id)?.family === family)
      .sort((left, right) => assessmentOrder(assessments, left, right))
      .slice(0, AUDIT_FAMILY_CHALLENGERS_PER_SELECTED_FAMILY)
    familyChallengerIds.push(...members)
  }

  const boundedFamilyChallengerIds = [...new Set(familyChallengerIds)]
    .slice(0, AUDIT_MAX_PROMOTION_COMPONENT)
  // The acceptance contract explicitly requires a fixed-seed random check, so
  // random challengers receive first reservation. Independently ranked
  // cutline and same-family challengers then fill the remaining bounded pool.
  const promotionIds = [...new Set([
    ...universe.randomChallengerIds,
    ...cutlineChallengerIds,
    ...boundedFamilyChallengerIds,
  ])].slice(0, AUDIT_MAX_PROMOTION_HIGH)
  return Object.freeze({
    promotionIds: Object.freeze(promotionIds),
    cutlineChallengerIds: Object.freeze(cutlineChallengerIds),
    familyChallengerIds: Object.freeze(boundedFamilyChallengerIds),
    randomChallengerIds: universe.randomChallengerIds,
  })
}

/** Stage D compares at most eight strongest independently promoted challengers. */
export function planAuditPairs(
  candidates: readonly AuditCandidateIdentity[],
  selectedIds: readonly string[],
  promotionIds: readonly string[],
  highAssessments: ReadonlyMap<string, PortraitBaselineAssessment>,
): readonly AuditPairPlan[] {
  const weakestSelected = selectedIds
    .map(id => highAssessments.get(id))
    .filter((value): value is PortraitBaselineAssessment => Boolean(value) && value!.baselineScore !== null)
    .sort((left, right) => left.baselineScore! - right.baselineScore! || left.id.localeCompare(right.id))[0]
  if (!weakestSelected) return Object.freeze([])
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const selectedByFamily = new Map<string, PortraitBaselineAssessment[]>()
  for (const id of selectedIds) {
    const family = candidateById.get(id)?.family
    const assessment = highAssessments.get(id)
    if (!family || !assessment || assessment.baselineScore === null) continue
    const members = selectedByFamily.get(family) ?? []
    members.push(assessment)
    selectedByFamily.set(family, members)
  }
  for (const members of selectedByFamily.values()) {
    members.sort((left, right) => left.baselineScore! - right.baselineScore! || left.id.localeCompare(right.id))
  }
  const challengers = promotionIds
    .map(id => highAssessments.get(id))
    .filter((value): value is PortraitBaselineAssessment =>
      Boolean(value) && value!.eligibility.status === 'eligible' && value!.baselineScore !== null)
    .filter(value => value.baselineScore! >= weakestSelected.baselineScore! - 4
      || intervalsOverlap(value.scoreInterval, weakestSelected.scoreInterval))
    .sort((left, right) => right.baselineScore! - left.baselineScore! || left.id.localeCompare(right.id))
    .slice(0, AUDIT_MAX_PAIRWISE_PAIRS)
  return Object.freeze(challengers.map(challenger => {
    const family = candidateById.get(challenger.id)?.family
    const familySelected = family ? selectedByFamily.get(family)?.[0] : undefined
    return Object.freeze({
      challengerId: challenger.id,
      selectedId: familySelected?.id ?? weakestSelected.id,
    })
  }))
}

/** Complete-quality decision uses only audit scores and completed v3 pair results. */
export function evaluateAuditQuality(
  selectedIds: readonly string[],
  remainingIds: readonly string[],
  bestAssessments: ReadonlyMap<string, PortraitBaselineAssessment>,
  pairResults: ReadonlyMap<string, PairwiseResult>,
): AuditQualityResult {
  const selectedAssessments = selectedIds
    .map(id => bestAssessments.get(id))
    .filter((value): value is PortraitBaselineAssessment => Boolean(value))
  const selectedQualityIssueIds = selectedIds.filter(id => {
    const assessment = bestAssessments.get(id)
    return !assessment || assessment.eligibility.status !== 'eligible' || assessment.baselineScore === null
  })
  const weakestSelectedScore = selectedQualityIssueIds.length === 0
    ? Math.min(...selectedAssessments.map(value => value.baselineScore!))
    : null
  const stronger = new Map<string, { id: string; score: number; margin: number; reason: string }>()
  if (weakestSelectedScore !== null) {
    for (const id of remainingIds) {
      const assessment = bestAssessments.get(id)
      if (assessment?.baselineScore !== null && assessment?.baselineScore !== undefined
        && assessment.baselineScore > weakestSelectedScore + 3) {
        stronger.set(id, {
          id,
          score: assessment.baselineScore,
          margin: assessment.baselineScore - weakestSelectedScore,
          reason: assessment.summary,
        })
      }
    }
    for (const [challengerId, result] of pairResults) {
      if (result.winner !== challengerId) continue
      const assessment = bestAssessments.get(challengerId)
      if (!assessment || assessment.baselineScore === null) continue
      stronger.set(challengerId, {
        id: challengerId,
        score: assessment.baselineScore,
        margin: assessment.baselineScore - weakestSelectedScore,
        reason: result.reason,
      })
    }
  }
  return Object.freeze({
    weakestSelectedScore,
    selectedQualityIssueIds: Object.freeze(selectedQualityIssueIds),
    strongerChallengers: Object.freeze([...stronger.values()]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))),
  })
}
