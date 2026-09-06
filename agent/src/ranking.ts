/**
 * Deterministic portrait ranking from absolute scores, pairwise comparisons,
 * near-duplicate family caps, bounded semantic novelty, and Bradley-Terry evidence.
 *
 * No file, model, clock, or global random state is consulted by this module.
 * @module
 */

import { MAX_DIVERSITY_BONUS, type PreferenceProfile } from './preferences.ts'
import type { EligibilityStatus } from './rubric.ts'

/** Any ranking-policy change invalidates frozen decision receipts. */
export const PORTRAIT_RANKING_POLICY_VERSION = 'portrait-ranking-v2-comparison-first' as const

export interface RankingCandidate {
  id: string
  /** Baseline plus any already-bounded preference overlay, in 0–100. */
  score: number
  /** Similar/continuous frames share a near-duplicate family. Missing IDs are singleton families. */
  familyId?: string
  /** Only `eligible` participates; review and hard-rejected photos never receive a rank. */
  eligibility: EligibilityStatus
  /** Non-sensitive semantic labels used only for MMR novelty. */
  diversityTags?: readonly string[]
}

export interface PairwiseComparison {
  leftId: string
  rightId: string
  /**
   * 1 means left wins and 0 right wins. In this flow 0.5 means AB/BA was
   * unstable, so it is durable no-direction evidence and does not update BT.
   * Other intermediate directional probabilities are allowed.
   */
  leftOutcome: number
  /** Confidence multiplier in (0, 10], default 1. */
  weight?: number
  /** Provider/prompt/dataset identity; legacy entries without it are not reused by the selector. */
  cacheKey?: string
}

export interface BradleyTerryOptions {
  /** Regularization toward absolute scores; larger values trust the rubric more. */
  priorStrength?: number
  iterations?: number
}

export interface RankPortraitOptions extends BradleyTerryOptions {
  topK: number
  comparisons?: readonly PairwiseComparison[]
  /**
   * Independently audited counterexamples that must remain in the active set.
   * They still need to be eligible and inside Top-K capacity. A hard numeric
   * family cap fails closed when the required set itself violates that user
   * instruction; `auto` may relax rather than silently dropping evidence.
   */
  requiredIds?: readonly string[]
  /** 0–1; semantic novelty has a maximum four-point budget. */
  diversityStrength?: number
  /**
   * Per-family selection cap. `auto` starts from the smallest uniform cap that
   * can return exact Top-K, but relaxes it when the best capped-out photo is
   * more than the four-point diversity budget above the best capped-in photo.
   * A positive integer is an explicit hard cap;
   * `unlimited` preserves series when the user explicitly asks for them.
   * @default 'auto'
   */
  familyCap?: 'auto' | 'unlimited' | number
}

/** Convert a validated user profile into collection-level ranking controls. */
export function portraitRankPolicy(
  preference: Pick<PreferenceProfile, 'diversity' | 'seriesRetention'>,
): Pick<RankPortraitOptions, 'diversityStrength' | 'familyCap'> {
  const familyCap = preference.seriesRetention === 'one_per_family'
    ? 1
    : preference.seriesRetention === 'allow_series'
      ? 'unlimited'
      : 'auto'
  return { diversityStrength: preference.diversity, familyCap }
}

export interface RankedPortrait {
  id: string
  familyId?: string
  baseScore: number
  comparisonScore: number
  diversityBonus: number
  finalScore: number
  rank: number
}

export interface ChallengerSamplingOptions {
  sampleSize: number
  /** String and numeric seeds are stable across processes and machines. */
  seed: string | number
  /** Contiguous quality strata, highest first. Default 3. */
  strata?: number
}

function assertScore(score: unknown, name: string): asserts score is number {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new RangeError(`${name} must be a finite number between 0 and 100`)
  }
}

function validateCandidates(candidates: readonly RankingCandidate[]): void {
  const ids = new Set<string>()
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object') throw new TypeError(`candidates[${index}] must be an object`)
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
      throw new TypeError(`candidates[${index}].id must be a non-empty string`)
    }
    if (ids.has(candidate.id)) throw new TypeError(`duplicate candidate id: ${candidate.id}`)
    ids.add(candidate.id)
    assertScore(candidate.score, `candidates[${index}].score`)
    if (!['eligible', 'needs_review', 'ineligible'].includes(candidate.eligibility)) {
      throw new TypeError(`candidates[${index}].eligibility must be eligible, needs_review, or ineligible`)
    }
    if (candidate.familyId !== undefined && (typeof candidate.familyId !== 'string' || !candidate.familyId.trim())) {
      throw new TypeError(`candidates[${index}].familyId must be a non-empty string when present`)
    }
    if (candidate.diversityTags !== undefined) {
      if (!Array.isArray(candidate.diversityTags)
        || candidate.diversityTags.some(tag => typeof tag !== 'string' || !tag.trim())) {
        throw new TypeError(`candidates[${index}].diversityTags must contain non-empty strings`)
      }
    }
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value))
}

function logistic(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value)
    return 1 / (1 + exp)
  }
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function logit(probability: number): number {
  return Math.log(probability / (1 - probability))
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

/**
 * Fit a regularized Bradley–Terry model, anchored by absolute rubric scores.
 * Batch updates and canonical comparison ordering make the result deterministic.
 */
export function fitBradleyTerryScores(
  candidates: readonly RankingCandidate[],
  comparisons: readonly PairwiseComparison[] = [],
  options: BradleyTerryOptions = {},
): Readonly<Record<string, number>> {
  validateCandidates(candidates)
  const ids = new Set(candidates.map(candidate => candidate.id))
  const priorStrength = options.priorStrength ?? 2
  const iterations = options.iterations ?? 120
  if (!Number.isFinite(priorStrength) || priorStrength <= 0) {
    throw new RangeError('priorStrength must be a positive finite number')
  }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000) {
    throw new RangeError('iterations must be an integer between 1 and 10000')
  }

  const normalized = comparisons.flatMap((comparison, index) => {
    if (!ids.has(comparison.leftId) || !ids.has(comparison.rightId)) {
      throw new TypeError(`comparisons[${index}] references an unknown candidate`)
    }
    if (comparison.leftId === comparison.rightId) {
      throw new TypeError(`comparisons[${index}] compares a candidate with itself`)
    }
    if (typeof comparison.leftOutcome !== 'number' || !Number.isFinite(comparison.leftOutcome)
      || comparison.leftOutcome < 0 || comparison.leftOutcome > 1) {
      throw new RangeError(`comparisons[${index}].leftOutcome must be between 0 and 1`)
    }
    const weight = comparison.weight ?? 1
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 10) {
      throw new RangeError(`comparisons[${index}].weight must be in (0, 10]`)
    }
    // AB and BA disagreeing is uncertainty, not evidence that two images have
    // equal latent quality. Treating it as an equality observation collapses
    // a strong absolute score toward a weak opponent and can invert the
    // rubric by far more than the bounded diversity budget.
    if (comparison.leftOutcome === 0.5) return []
    // Canonicalize left/right so caller ordering cannot influence summation order.
    return [comparison.leftId < comparison.rightId
      ? { leftId: comparison.leftId, rightId: comparison.rightId, outcome: comparison.leftOutcome, weight }
      : { leftId: comparison.rightId, rightId: comparison.leftId, outcome: 1 - comparison.leftOutcome, weight }]
  }).sort((a, b) => a.leftId.localeCompare(b.leftId)
    || a.rightId.localeCompare(b.rightId)
    || a.outcome - b.outcome
    || a.weight - b.weight)

  if (!normalized.length) {
    return Object.freeze(Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.score])))
  }

  const prior = new Map<string, number>()
  const ability = new Map<string, number>()
  for (const candidate of candidates) {
    const latent = logit(clamp(candidate.score / 100, 0.01, 0.99))
    prior.set(candidate.id, latent)
    ability.set(candidate.id, latent)
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = new Map(candidates.map(candidate => [candidate.id, 0]))
    const curvature = new Map(candidates.map(candidate => [candidate.id, priorStrength]))
    for (const comparison of normalized) {
      const left = ability.get(comparison.leftId)!
      const right = ability.get(comparison.rightId)!
      const probability = logistic(left - right)
      const residual = comparison.weight * (comparison.outcome - probability)
      gradient.set(comparison.leftId, gradient.get(comparison.leftId)! + residual)
      gradient.set(comparison.rightId, gradient.get(comparison.rightId)! - residual)
      const information = comparison.weight * probability * (1 - probability)
      curvature.set(comparison.leftId, curvature.get(comparison.leftId)! + information)
      curvature.set(comparison.rightId, curvature.get(comparison.rightId)! + information)
    }
    let maxChange = 0
    for (const candidate of candidates) {
      const id = candidate.id
      const current = ability.get(id)!
      const regularizedGradient = gradient.get(id)! - priorStrength * (current - prior.get(id)!)
      // Damped diagonal Newton step: stable for sparse or contradictory comparisons.
      const change = clamp(0.75 * regularizedGradient / curvature.get(id)!, -1, 1)
      ability.set(id, clamp(current + change, -8, 8))
      maxChange = Math.max(maxChange, Math.abs(change))
    }
    if (maxChange < 1e-8) break
  }

  return Object.freeze(Object.fromEntries(candidates.map(candidate => [
    candidate.id,
    roundScore(100 * logistic(ability.get(candidate.id)!)),
  ])))
}

function tagSimilarity(left: RankingCandidate, right: RankingCandidate): number {
  if (!left.diversityTags?.length || !right.diversityTags?.length) return 0
  const leftTags = new Set(left.diversityTags)
  const rightTags = new Set(right.diversityTags)
  let intersection = 0
  for (const tag of leftTags) if (rightTags.has(tag)) intersection += 1
  const union = new Set([...leftTags, ...rightTags]).size
  return union ? intersection / union : 0
}

function familyKey(candidate: RankingCandidate): string {
  return candidate.familyId ?? `id:${candidate.id}`
}

/**
 * Resolve the effective uniform near-duplicate family cap.
 *
 * In `auto` mode this returns the minimum integer q for which
 * `sum(min(familySize, q)) >= topK`. Therefore the constraint is as strict as
 * possible without making exact Top-K infeasible. Singleton photos never share
 * a synthetic family. Explicit caps fail loudly when they cannot satisfy K.
 */
export function resolveFamilyCap(
  candidates: readonly RankingCandidate[],
  topK: number,
  policy: RankPortraitOptions['familyCap'] = 'auto',
): number {
  validateCandidates(candidates)
  if (!Number.isInteger(topK) || topK < 0) throw new RangeError('topK must be a non-negative integer')
  const eligible = candidates.filter(candidate => candidate.eligibility === 'eligible')
  if (eligible.length < topK) {
    throw new RangeError(`cannot select exactly ${topK}: only ${eligible.length} eligible photos`)
  }
  if (policy === 'unlimited') return Number.POSITIVE_INFINITY
  if (policy !== undefined && policy !== 'auto') {
    if (!Number.isInteger(policy) || policy < 1) {
      throw new RangeError('familyCap must be auto, unlimited, or a positive integer')
    }
  }
  if (topK === 0) return 0

  const sizes = new Map<string, number>()
  for (const candidate of eligible) {
    const family = familyKey(candidate)
    sizes.set(family, (sizes.get(family) ?? 0) + 1)
  }
  const capacity = (cap: number): number => [...sizes.values()].reduce(
    (sum, size) => sum + Math.min(size, cap),
    0,
  )

  if (typeof policy === 'number') {
    const available = capacity(policy)
    if (available < topK) {
      throw new RangeError(`familyCap ${policy} cannot select exactly ${topK}: capacity is ${available}`)
    }
    return policy
  }

  const largestFamily = Math.max(...sizes.values())
  for (let cap = 1; cap <= largestFamily; cap += 1) {
    if (capacity(cap) >= topK) return cap
  }
  // Eligible-count validation makes this unreachable.
  throw new Error('family-cap invariant violated: exact Top-K has no feasible cap')
}

/**
 * Return exactly Top-K eligible portraits whenever at least K eligible photos
 * exist. Balanced `auto` starts with the strictest feasible uniform family cap,
 * but no diversity constraint may displace a photo by more than four points.
 * Explicit numeric policies remain hard user instructions; `unlimited` keeps
 * a deliberate series.
 */
export function rankPortraits(
  candidates: readonly RankingCandidate[],
  options: RankPortraitOptions,
): readonly RankedPortrait[] {
  validateCandidates(candidates)
  if (!Number.isInteger(options.topK) || options.topK < 0) {
    throw new RangeError('topK must be a non-negative integer')
  }
  const diversityStrength = options.diversityStrength ?? 0
  if (typeof diversityStrength !== 'number' || !Number.isFinite(diversityStrength)
    || diversityStrength < 0 || diversityStrength > 1) {
    throw new RangeError('diversityStrength must be a finite number between 0 and 1')
  }
  if (options.topK === 0) return Object.freeze([])

  const eligible = candidates.filter(candidate => candidate.eligibility === 'eligible')
  const eligibleById = new Map(eligible.map(candidate => [candidate.id, candidate]))
  const requiredIds = [...(options.requiredIds ?? [])]
  if (new Set(requiredIds).size !== requiredIds.length) {
    throw new TypeError('requiredIds contains duplicates')
  }
  if (requiredIds.length > options.topK) {
    throw new RangeError(`requiredIds cannot exceed topK ${options.topK}`)
  }
  for (const id of requiredIds) {
    if (!eligibleById.has(id)) {
      throw new RangeError(`required candidate is unknown or ineligible: ${id}`)
    }
  }
  const familyPolicy = options.familyCap ?? 'auto'
  const effectiveFamilyCap = resolveFamilyCap(candidates, options.topK, familyPolicy)

  const comparisonScores = fitBradleyTerryScores(
    eligible,
    options.comparisons ?? [],
    { priorStrength: options.priorStrength, iterations: options.iterations },
  )
  const selected: RankedPortrait[] = []
  const selectedCandidates: RankingCandidate[] = []
  const selectedIds = new Set<string>()
  const selectedFamilyCounts = new Map<string, number>()

  if (typeof familyPolicy === 'number') {
    const requiredFamilyCounts = new Map<string, number>()
    for (const id of requiredIds) {
      const family = familyKey(eligibleById.get(id)!)
      requiredFamilyCounts.set(family, (requiredFamilyCounts.get(family) ?? 0) + 1)
    }
    const violation = [...requiredFamilyCounts.entries()]
      .find(([, count]) => count > familyPolicy)
    if (violation) {
      throw new RangeError(
        `requiredIds violate familyCap ${familyPolicy} for family ${violation[0]}`,
      )
    }
  }

  // Freeze the externally required active set before applying family/diversity
  // preferences to the remaining slots. Required rows receive no novelty
  // bonus: audit evidence authorizes inclusion, not a fabricated score lift.
  for (const candidate of requiredIds
    .map(id => eligibleById.get(id)!)
    .sort((left, right) => comparisonScores[right.id] - comparisonScores[left.id]
      || left.id.localeCompare(right.id))) {
    const family = familyKey(candidate)
    selectedIds.add(candidate.id)
    selectedFamilyCounts.set(family, (selectedFamilyCounts.get(family) ?? 0) + 1)
    selectedCandidates.push(candidate)
    selected.push(Object.freeze({
      id: candidate.id,
      familyId: candidate.familyId,
      baseScore: candidate.score,
      comparisonScore: comparisonScores[candidate.id],
      diversityBonus: 0,
      finalScore: comparisonScores[candidate.id],
      rank: selected.length + 1,
    }))
  }

  while (selected.length < options.topK) {
    const remaining = eligible.filter(candidate => !selectedIds.has(candidate.id))
    const cappedAvailable = remaining.filter(candidate =>
      (selectedFamilyCounts.get(familyKey(candidate)) ?? 0) < effectiveFamilyCap)
    let available = cappedAvailable
    if (familyPolicy === 'auto') {
      const bestRemaining = Math.max(...remaining.map(candidate => comparisonScores[candidate.id]))
      const bestCapped = cappedAvailable.length
        ? Math.max(...cappedAvailable.map(candidate => comparisonScores[candidate.id]))
        : Number.NEGATIVE_INFINITY
      if (!cappedAvailable.length || bestRemaining > bestCapped + MAX_DIVERSITY_BONUS) {
        // Balanced diversity is a bounded preference, not a license to keep a
        // materially weaker photo. Once the cap costs >4 points, relax it only
        // for the global quality frontier; semantic novelty still decides
        // within that same four-point band below.
        available = remaining.filter(candidate =>
          comparisonScores[candidate.id] >= bestRemaining - MAX_DIVERSITY_BONUS)
      }
    }
    if (!available.length) {
      throw new RangeError(
        `familyCap cannot fill exact Top-K after requiredIds: selected ${selected.length} of ${options.topK}`,
      )
    }
    const frontierBest = Math.max(...available.map(candidate => comparisonScores[candidate.id]))
    const frontierFloor = frontierBest - MAX_DIVERSITY_BONUS
    let best: { candidate: RankingCandidate; bonus: number; finalScore: number } | undefined
    for (const candidate of available) {
      // Diversity can decide only among candidates already within four quality points
      // of the best currently selectable image. It cannot rescue a weak photograph.
      if (comparisonScores[candidate.id] < frontierFloor) continue
      let bonus = 0
      if (selectedCandidates.length && diversityStrength > 0 && candidate.diversityTags?.length) {
        const maximumSimilarity = Math.max(...selectedCandidates.map(other => tagSimilarity(candidate, other)))
        const semanticNovelty = 1 - maximumSimilarity
        bonus = roundScore(Math.min(
          MAX_DIVERSITY_BONUS,
          diversityStrength * MAX_DIVERSITY_BONUS * semanticNovelty,
        ))
      }
      const finalScore = roundScore(comparisonScores[candidate.id] + bonus)
      if (!best || finalScore > best.finalScore
        || (finalScore === best.finalScore && comparisonScores[candidate.id] > comparisonScores[best.candidate.id])
        || (finalScore === best.finalScore && comparisonScores[candidate.id] === comparisonScores[best.candidate.id]
          && candidate.id.localeCompare(best.candidate.id) < 0)) {
        best = { candidate, bonus, finalScore }
      }
    }
    // The eligible-count precondition guarantees a candidate on every iteration.
    if (!best) throw new Error('ranking invariant violated: no selectable candidate')
    const family = familyKey(best.candidate)
    selectedIds.add(best.candidate.id)
    selectedFamilyCounts.set(family, (selectedFamilyCounts.get(family) ?? 0) + 1)
    selectedCandidates.push(best.candidate)
    selected.push(Object.freeze({
      id: best.candidate.id,
      familyId: best.candidate.familyId,
      baseScore: best.candidate.score,
      comparisonScore: comparisonScores[best.candidate.id],
      diversityBonus: best.bonus,
      finalScore: best.finalScore,
      rank: selected.length + 1,
    }))
  }
  if (!requiredIds.length) return Object.freeze(selected)
  return Object.freeze([...selected]
    .sort((left, right) => right.finalScore - left.finalScore
      || right.comparisonScore - left.comparisonScore
      || left.id.localeCompare(right.id))
    .map((row, index) => Object.freeze({ ...row, rank: index + 1 })))
}

function hashSeed(seed: string | number): number {
  const text = String(seed)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

/**
 * Deterministically sample non-selected challengers across contiguous quality
 * strata. This is the reproducible random audit used by an isolated evaluator.
 */
export function sampleStratifiedChallengers(
  candidates: readonly RankingCandidate[],
  selectedIds: readonly string[],
  options: ChallengerSamplingOptions,
): readonly RankingCandidate[] {
  validateCandidates(candidates)
  if (!Number.isInteger(options.sampleSize) || options.sampleSize < 0) {
    throw new RangeError('sampleSize must be a non-negative integer')
  }
  const strata = options.strata ?? 3
  if (!Number.isInteger(strata) || strata < 1) throw new RangeError('strata must be a positive integer')
  const allIds = new Set(candidates.map(candidate => candidate.id))
  const selected = new Set<string>()
  for (const id of selectedIds) {
    if (!allIds.has(id)) throw new TypeError(`selectedIds references an unknown candidate: ${id}`)
    selected.add(id)
  }

  const pool = candidates
    .filter(candidate => candidate.eligibility === 'eligible' && !selected.has(candidate.id))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  if (!pool.length || options.sampleSize === 0) return Object.freeze([])

  const bucketCount = Math.min(strata, pool.length)
  const buckets: RankingCandidate[][] = Array.from({ length: bucketCount }, () => [])
  for (const [index, candidate] of pool.entries()) {
    const bucket = Math.min(bucketCount - 1, Math.floor(index * bucketCount / pool.length))
    buckets[bucket].push(candidate)
  }
  const random = mulberry32(hashSeed(options.seed))
  const shuffledBuckets = buckets.map(bucket => shuffled(bucket, random))
  const target = Math.min(options.sampleSize, pool.length)
  const result: RankingCandidate[] = []
  let round = 0
  while (result.length < target) {
    let added = false
    for (const bucket of shuffledBuckets) {
      if (round < bucket.length && result.length < target) {
        result.push(bucket[round])
        added = true
      }
    }
    if (!added) break
    round += 1
  }
  return Object.freeze(result)
}
