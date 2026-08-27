/**
 * Pure, deterministic budget planning for the paid portrait-selection stage.
 *
 * Keeping this separate from the tool makes the cap testable without a vision
 * client, filesystem access, or a Harness session.
 * @module
 */

import { createHash } from 'node:crypto'
import type {
  PairwiseComparison,
  RankedPortrait,
  RankingCandidate,
} from './ranking.ts'

export const DEFAULT_FAMILY_CHALLENGERS_PER_FAMILY = 2
export const MAX_PAIRWISE_PAIRS = 24
export const HIGH_REFINEMENT_PLAN_VERSION = 'portrait-high-budget-v2-audit-feedback'

export interface HighRefinementPlan {
  target: number
  eligibleCount: number
  /** Absolute ceiling for high-detail candidates, including family additions. */
  hardCap: number
  /** Globally strongest candidates admitted before family-specific additions. */
  baseCount: number
  leadingWindowCount: number
  leadingFamilyCount: number
  familyChallengersPerFamily: number
  /** Audit-FAIL challengers admitted before normal score/family planning. */
  auditForcedCount: number
  familyChallengerAddedCount: number
  globalFillCount: number
  candidateIds: readonly string[]
}

export interface HighRefinementPlanOptions {
  familyChallengersPerFamily?: number
  /**
   * IDs surfaced by a completed independent-audit FAIL. They do not import
   * evaluator scores into selector ranking; they only guarantee a fresh high
   * review slot inside the existing hard cap.
   */
  forcedCandidateIds?: readonly string[]
}

export interface HighRefinementContext {
  datasetFingerprint: string
  candidateScope: string
  target: number
  preferenceFingerprint: string
  rubricModelKey: string
  /** `none` for the first build; otherwise a hash of isolated audit feedback. */
  auditFeedbackFingerprint?: string
}

/** Stable identity for the inputs that are allowed to share one paid budget. */
export function highRefinementContextKey(context: HighRefinementContext): string {
  assertPositiveInteger(context.target, 'target')
  for (const [name, value] of Object.entries(context)) {
    if (name === 'target') continue
    if (name === 'auditFeedbackFingerprint' && value === undefined) continue
    if (typeof value !== 'string' || !value) {
      throw new TypeError(`${name} must be a non-empty string`)
    }
  }
  return createHash('sha256')
    .update([
      HIGH_REFINEMENT_PLAN_VERSION,
      context.datasetFingerprint,
      context.candidateScope,
      String(context.target),
      context.preferenceFingerprint,
      context.rubricModelKey,
      context.auditFeedbackFingerprint ?? 'none',
    ].join('\u0000'))
    .digest('hex')
}

export interface PlannedPair {
  leftId: string
  rightId: string
  source: 'audit' | 'family' | 'cutline'
}

export interface PairwiseBudgetPlan {
  pairs: readonly PlannedPair[]
  auditPairCount: number
  familyPairCount: number
  cutlinePairCount: number
  pairCap: number
  /** comparePair evaluates both A/B and B/A, so every pair can cost two calls. */
  bidirectionalCallCap: number
}

export interface PlannedPairwiseLeg extends PlannedPair {
  order: 'AB' | 'BA'
}

/**
 * A paid stage may start only after its prerequisite checkpoint is durable.
 * Keeping this boundary explicit makes a failed local write testable without a
 * provider client and prevents callers from accidentally treating persistence
 * as best-effort.
 */
export async function runAfterDurableCheckpoint<T>(
  checkpoint: () => Promise<boolean>,
  paidStage: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (!await checkpoint()) return { ok: false }
  return { ok: true, value: await paidStage() }
}

/** Expand a frozen pair plan into independently resumable directional legs. */
export function plannedPairwiseLegs(plan: PairwiseBudgetPlan): readonly PlannedPairwiseLeg[] {
  return Object.freeze(plan.pairs.flatMap(pair => (['AB', 'BA'] as const).map(order =>
    Object.freeze({ ...pair, order }))))
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function scoreOrder(left: RankingCandidate, right: RankingCandidate): number {
  return right.score - left.score || left.id.localeCompare(right.id)
}

/**
 * Plan the high-detail review pool under one non-bypassable ceiling.
 *
 * The base list deliberately leaves room below the hard cap. At most a small
 * number of additional members from each family represented near the top may
 * use that room. Remaining room is filled by global score. Family expansion is
 * therefore useful for close-frame challengers but can never turn one large
 * family into an unbounded paid review.
 */
export function planHighRefinement(
  candidates: readonly RankingCandidate[],
  target: number,
  options: HighRefinementPlanOptions = {},
): HighRefinementPlan {
  assertPositiveInteger(target, 'target')
  const perFamily = options.familyChallengersPerFamily
    ?? DEFAULT_FAMILY_CHALLENGERS_PER_FAMILY
  if (!Number.isInteger(perFamily) || perFamily < 0 || perFamily > 10) {
    throw new RangeError('familyChallengersPerFamily must be an integer between 0 and 10')
  }

  const eligible = candidates
    .filter(candidate => candidate.eligibility === 'eligible')
    .sort(scoreOrder)
  if (eligible.length < target) {
    throw new RangeError(`cannot plan target ${target}: only ${eligible.length} eligible photos`)
  }

  const hardCap = Math.min(eligible.length, Math.max(target * 3, target + 20))
  // Reserve at most one target-sized tranche for family challengers. Global
  // fill below guarantees the final plan still uses the available hard budget.
  const baseCount = Math.min(hardCap, Math.max(target * 2, target + 10))
  const leadingWindowCount = Math.min(eligible.length, target + 10)
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const forcedIds = [...new Set(options.forcedCandidateIds ?? [])]
  for (const id of forcedIds) {
    if (!candidateById.has(id)) throw new RangeError(`forced candidate is unknown: ${id}`)
  }
  const selected = new Set<string>()
  const candidateIds: string[] = []
  for (const id of forcedIds) {
    if (candidateIds.length >= hardCap) break
    selected.add(id)
    candidateIds.push(id)
  }
  for (const candidate of eligible.slice(0, baseCount)) {
    if (candidateIds.length >= hardCap || selected.has(candidate.id)) continue
    selected.add(candidate.id)
    candidateIds.push(candidate.id)
  }

  const leadingFamilies: string[] = []
  const seenFamilies = new Set<string>()
  for (const candidate of eligible.slice(0, leadingWindowCount)) {
    if (!candidate.familyId || seenFamilies.has(candidate.familyId)) continue
    seenFamilies.add(candidate.familyId)
    leadingFamilies.push(candidate.familyId)
  }

  let familyChallengerAddedCount = 0
  for (const familyId of leadingFamilies) {
    let addedForFamily = 0
    for (const candidate of eligible) {
      if (candidate.familyId !== familyId || selected.has(candidate.id)) continue
      if (candidateIds.length >= hardCap || addedForFamily >= perFamily) break
      selected.add(candidate.id)
      candidateIds.push(candidate.id)
      addedForFamily += 1
      familyChallengerAddedCount += 1
    }
    if (candidateIds.length >= hardCap) break
  }

  let globalFillCount = 0
  for (const candidate of eligible) {
    if (candidateIds.length >= hardCap) break
    if (selected.has(candidate.id)) continue
    selected.add(candidate.id)
    candidateIds.push(candidate.id)
    globalFillCount += 1
  }

  if (candidateIds.length > hardCap) {
    throw new Error(`high-refinement plan exceeded hard cap ${hardCap}`)
  }
  return Object.freeze({
    target,
    eligibleCount: eligible.length,
    hardCap,
    baseCount,
    leadingWindowCount,
    leadingFamilyCount: leadingFamilies.length,
    familyChallengersPerFamily: perFamily,
    auditForcedCount: Math.min(forcedIds.length, hardCap),
    familyChallengerAddedCount,
    globalFillCount,
    candidateIds: Object.freeze(candidateIds),
  })
}

function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join('\u0000')
}

/**
 * Use the same rules for preflight estimation and the actual pairwise run.
 * Scores can change after high-detail review, so callers should label a
 * pre-high plan as an estimate and report the post-high plan as actual.
 */
export function planPairwiseBudget(
  candidates: readonly RankingCandidate[],
  preliminary: readonly RankedPortrait[],
  comparisons: readonly PairwiseComparison[],
  target: number,
  pairCap = MAX_PAIRWISE_PAIRS,
  forcedChallengerIds: readonly string[] = [],
): PairwiseBudgetPlan {
  assertPositiveInteger(target, 'target')
  if (!Number.isInteger(pairCap) || pairCap < 0) {
    throw new RangeError('pairCap must be a non-negative integer')
  }
  const eligible = candidates
    .filter(candidate => candidate.eligibility === 'eligible')
    .sort(scoreOrder)
  const existing = new Set(comparisons.map(comparison =>
    pairKey(comparison.leftId, comparison.rightId)))
  const plannedKeys = new Set<string>()
  const proposed: PlannedPair[] = []
  const addPair = (leftId: string, rightId: string, source: PlannedPair['source']) => {
    if (leftId === rightId || proposed.length >= pairCap) return false
    const key = pairKey(leftId, rightId)
    if (existing.has(key) || plannedKeys.has(key)) return false
    plannedKeys.add(key)
    proposed.push({ leftId, rightId, source })
    return true
  }

  // A completed isolated-audit FAIL is feedback about *where to compare*, not
  // a selector score. Reserve the scarce pair budget first so rebuild cannot
  // silently reproduce the failed selection without testing the counterexamples.
  const selectedIds = new Set(preliminary.map(candidate => candidate.id))
  const weakestSelected = [...preliminary].reverse()
  const eligibleIds = new Set(eligible.map(candidate => candidate.id))
  for (const challengerId of [...new Set(forcedChallengerIds)]) {
    if (!eligibleIds.has(challengerId) || selectedIds.has(challengerId)) continue
    for (const selected of weakestSelected) {
      if (addPair(challengerId, selected.id, 'audit')) break
    }
    if (proposed.length >= pairCap) break
  }

  const rankIndex = new Map(eligible.map((candidate, index) => [candidate.id, index]))
  const families = new Map<string, RankingCandidate[]>()
  for (const candidate of eligible) {
    if (!candidate.familyId) continue
    const members = families.get(candidate.familyId) ?? []
    members.push(candidate)
    families.set(candidate.familyId, members)
  }
  for (const familyId of [...families.keys()].sort()) {
    const members = families.get(familyId)!.sort(scoreOrder)
    if (members.length < 2) continue
    const firstRank = rankIndex.get(members[0].id) ?? Number.MAX_SAFE_INTEGER
    if (firstRank < target + 10 && members[0].score - members[1].score <= 6) {
      addPair(members[0].id, members[1].id, 'family')
    }
  }

  const weakest = preliminary.at(-1)
  if (weakest && proposed.length < pairCap) {
    const challengers = eligible
      .filter(candidate => !selectedIds.has(candidate.id))
      .slice(0, 12)
    for (const challenger of challengers) {
      if (Math.abs(weakest.comparisonScore - challenger.score) <= 4) {
        addPair(weakest.id, challenger.id, 'cutline')
      }
    }
  }

  const pairs = Object.freeze(proposed)
  return Object.freeze({
    pairs,
    auditPairCount: pairs.filter(pair => pair.source === 'audit').length,
    familyPairCount: pairs.filter(pair => pair.source === 'family').length,
    cutlinePairCount: pairs.filter(pair => pair.source === 'cutline').length,
    pairCap,
    bidirectionalCallCap: pairCap * 2,
  })
}
