/**
 * Strict preference parsing and a bounded overlay on the portrait baseline.
 *
 * Preferences never mutate the baseline rubric. The default eight-point tradeoff
 * means at most four points in either direction; diversity contributes at most four. An
 * eligibility cap is always re-applied after the overlay.
 *
 * @module
 */

import {
  PORTRAIT_BASELINE_WEIGHTS,
  PORTRAIT_DIMENSION_IDS,
  type PortraitDimensionId,
  type PortraitDimensionScores,
  type PortraitRubricResult,
  validatePortraitDimensionScores,
} from './rubric.ts'

/** Default total quality tradeoff window; per-photo movement is half in either direction. */
export const DEFAULT_MAX_QUALITY_TRADEOFF = 8
export const MAX_QUALITY_TRADEOFF = 8
/** Backwards-readable alias for callers that describe the same total window as a tradeoff. */
export const DEFAULT_PREFERENCE_TRADEOFF = DEFAULT_MAX_QUALITY_TRADEOFF
export const MAX_DIVERSITY_BONUS = 4

export const EXPRESSION_TAGS = ['natural', 'joyful', 'calm', 'serious', 'candid', 'dramatic'] as const
export const GAZE_TAGS = ['camera', 'off_camera', 'mutual', 'introspective'] as const
export const FRAMING_TAGS = ['close_up', 'half_body', 'full_body', 'environmental'] as const
export const LIGHTING_TAGS = ['soft', 'dramatic', 'backlit', 'natural', 'high_key', 'low_key'] as const
export const MOOD_TAGS = ['warm', 'cool', 'cinematic', 'playful', 'serene', 'energetic', 'documentary'] as const
export const SERIES_RETENTION_VALUES = ['balanced', 'one_per_family', 'allow_series'] as const

export type ExpressionTag = (typeof EXPRESSION_TAGS)[number]
export type GazeTag = (typeof GAZE_TAGS)[number]
export type FramingTag = (typeof FRAMING_TAGS)[number]
export type LightingTag = (typeof LIGHTING_TAGS)[number]
export type MoodTag = (typeof MOOD_TAGS)[number]
export type SeriesRetention = (typeof SERIES_RETENTION_VALUES)[number]

type PreferenceVector<T extends string> = Readonly<Partial<Record<T, number>>>

export interface PreferenceProfileInput {
  expression?: Partial<Record<ExpressionTag, number>>
  gaze?: Partial<Record<GazeTag, number>>
  framing?: Partial<Record<FramingTag, number>>
  lighting?: Partial<Record<LightingTag, number>>
  mood?: Partial<Record<MoodTag, number>>
  /** 0 disables MMR novelty; 1 permits the baseline four-point diversity bonus. Omitted inherits 1. */
  diversity?: number
  /** Persistence marker: distinguishes an omitted baseline value from an explicit user value. */
  diversityExplicit?: boolean
  /** Relative desired importance. Omitted dimensions receive zero preference mass. */
  dimensionWeights?: Partial<Record<PortraitDimensionId, number>>
  /** Total quality tradeoff window. Default/max 8 means each photo moves by at most ±4. */
  maxQualityTradeoff?: number
  /** How strongly later ranking should de-duplicate photos from the same series. */
  seriesRetention?: SeriesRetention
}

/** Tool frameworks may materialize omitted optional fields as own `undefined` keys. */
export function compactPreferenceProfileInput(input: PreferenceProfileInput): PreferenceProfileInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as PreferenceProfileInput
}

export interface PreferenceProfile {
  expression?: PreferenceVector<ExpressionTag>
  gaze?: PreferenceVector<GazeTag>
  framing?: PreferenceVector<FramingTag>
  lighting?: PreferenceVector<LightingTag>
  mood?: PreferenceVector<MoodTag>
  diversity: number
  /** True only when diversity was explicitly supplied by the user (including 0 or 1). */
  diversityExplicit: boolean
  dimensionWeights?: Readonly<Partial<Record<PortraitDimensionId, number>>>
  maxQualityTradeoff: number
  seriesRetention: SeriesRetention
  isBaseline: boolean
}

export interface PhotoPreferenceAttributesInput {
  expression?: Partial<Record<ExpressionTag, number>>
  gaze?: Partial<Record<GazeTag, number>>
  framing?: Partial<Record<FramingTag, number>>
  lighting?: Partial<Record<LightingTag, number>>
  mood?: Partial<Record<MoodTag, number>>
}

export interface PhotoPreferenceAttributes {
  expression?: PreferenceVector<ExpressionTag>
  gaze?: PreferenceVector<GazeTag>
  framing?: PreferenceVector<FramingTag>
  lighting?: PreferenceVector<LightingTag>
  mood?: PreferenceVector<MoodTag>
}

export interface PreferenceOverlayResult {
  baselineScore: number
  /** Signed and bounded to half of `profile.maxQualityTradeoff` in either direction. */
  preferenceAdjustment: number
  /** Baseline plus adjustment, with the rubric eligibility cap re-applied. */
  adjustedScore: number | null
  attributeSignal: number
  dimensionSignal: number
  hardCapApplied: boolean
}

const PROFILE_KEYS = new Set([
  'expression', 'gaze', 'framing', 'lighting', 'mood',
  'diversity', 'diversityExplicit', 'dimensionWeights', 'maxQualityTradeoff', 'seriesRetention',
  // Derived output field is accepted only so a serialized PreferenceProfile can
  // be parsed again. Its value is never trusted when recomputing the profile.
  'isBaseline',
])
const ATTRIBUTE_KEYS = new Set(['expression', 'gaze', 'framing', 'lighting', 'mood'])

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`)
  }
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${name} contains unknown key: ${key}`)
  }
}

function normalizePreferenceVector<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): PreferenceVector<T> | undefined {
  if (value === undefined) return undefined
  assertPlainObject(value, name)
  const allowedSet = new Set<string>(allowed)
  let total = 0
  const parsed: Partial<Record<T, number>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${name} contains unknown value: ${key}`)
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new RangeError(`${name}.${key} must be a finite non-negative number`)
    }
    if (raw > 0) {
      parsed[key as T] = raw
      total += raw
    }
  }
  if (total <= 0) throw new RangeError(`${name} must contain at least one positive weight`)
  for (const key of Object.keys(parsed) as T[]) parsed[key] = parsed[key]! / total
  return Object.freeze(parsed)
}

function validateEvidenceVector<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): PreferenceVector<T> | undefined {
  if (value === undefined) return undefined
  assertPlainObject(value, name)
  const allowedSet = new Set<string>(allowed)
  const parsed: Partial<Record<T, number>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${name} contains unknown value: ${key}`)
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      throw new RangeError(`${name}.${key} must be a finite number between 0 and 1`)
    }
    parsed[key as T] = raw
  }
  return Object.freeze(parsed)
}

function normalizeDimensionWeights(value: unknown): PreferenceProfile['dimensionWeights'] {
  if (value === undefined) return undefined
  assertPlainObject(value, 'dimensionWeights')
  const allowed = new Set<string>(PORTRAIT_DIMENSION_IDS)
  let total = 0
  const parsed: Partial<Record<PortraitDimensionId, number>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) throw new TypeError(`dimensionWeights contains unknown dimension: ${key}`)
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new RangeError(`dimensionWeights.${key} must be a finite non-negative number`)
    }
    if (raw > 0) {
      parsed[key as PortraitDimensionId] = raw
      total += raw
    }
  }
  if (total <= 0) throw new RangeError('dimensionWeights must contain at least one positive weight')
  for (const key of Object.keys(parsed) as PortraitDimensionId[]) parsed[key] = parsed[key]! / total
  return Object.freeze(parsed)
}

/** Parse JSON-like user input, reject unknown values, and normalize every weight vector. */
export function createPreferenceProfile(input: unknown = {}): PreferenceProfile {
  assertPlainObject(input, 'preferenceProfile')
  assertKnownKeys(input, PROFILE_KEYS, 'preferenceProfile')

  if (input.diversityExplicit !== undefined && typeof input.diversityExplicit !== 'boolean') {
    throw new TypeError('diversityExplicit must be a boolean')
  }
  if (input.isBaseline !== undefined && typeof input.isBaseline !== 'boolean') {
    throw new TypeError('isBaseline must be a boolean')
  }
  const diversityExplicit = input.diversityExplicit === undefined
    ? Object.prototype.hasOwnProperty.call(input, 'diversity')
    : input.diversityExplicit
  const diversity = input.diversity === undefined ? 1 : input.diversity
  if (typeof diversity !== 'number' || !Number.isFinite(diversity) || diversity < 0 || diversity > 1) {
    throw new RangeError('diversity must be a finite number between 0 and 1')
  }
  if (!diversityExplicit && diversity !== 1) {
    throw new TypeError('diversityExplicit=false is only valid for the inherited baseline diversity=1')
  }
  const maxQualityTradeoff = input.maxQualityTradeoff === undefined
    ? DEFAULT_MAX_QUALITY_TRADEOFF
    : input.maxQualityTradeoff
  if (typeof maxQualityTradeoff !== 'number' || !Number.isFinite(maxQualityTradeoff)
    || maxQualityTradeoff < 0 || maxQualityTradeoff > MAX_QUALITY_TRADEOFF) {
    throw new RangeError(`maxQualityTradeoff must be a finite number between 0 and ${MAX_QUALITY_TRADEOFF}`)
  }
  const seriesRetention = input.seriesRetention === undefined ? 'balanced' : input.seriesRetention
  if (typeof seriesRetention !== 'string'
    || !SERIES_RETENTION_VALUES.includes(seriesRetention as SeriesRetention)) {
    throw new TypeError(`seriesRetention must be one of: ${SERIES_RETENTION_VALUES.join(', ')}`)
  }

  const profile: PreferenceProfile = {
    expression: normalizePreferenceVector(input.expression, EXPRESSION_TAGS, 'expression'),
    gaze: normalizePreferenceVector(input.gaze, GAZE_TAGS, 'gaze'),
    framing: normalizePreferenceVector(input.framing, FRAMING_TAGS, 'framing'),
    lighting: normalizePreferenceVector(input.lighting, LIGHTING_TAGS, 'lighting'),
    mood: normalizePreferenceVector(input.mood, MOOD_TAGS, 'mood'),
    diversity,
    diversityExplicit,
    dimensionWeights: normalizeDimensionWeights(input.dimensionWeights),
    maxQualityTradeoff,
    seriesRetention: seriesRetention as SeriesRetention,
    isBaseline: false,
  }
  profile.isBaseline = !profile.expression && !profile.gaze && !profile.framing
    && !profile.lighting && !profile.mood && !profile.dimensionWeights && !profile.diversityExplicit
    && profile.seriesRetention === 'balanced'
  return Object.freeze(profile)
}

/** Validate model-produced preference evidence. Evidence is confidence, not a weight vector. */
export function createPhotoPreferenceAttributes(input: unknown = {}): PhotoPreferenceAttributes {
  assertPlainObject(input, 'photoPreferenceAttributes')
  assertKnownKeys(input, ATTRIBUTE_KEYS, 'photoPreferenceAttributes')
  return Object.freeze({
    expression: validateEvidenceVector(input.expression, EXPRESSION_TAGS, 'expression'),
    gaze: validateEvidenceVector(input.gaze, GAZE_TAGS, 'gaze'),
    framing: validateEvidenceVector(input.framing, FRAMING_TAGS, 'framing'),
    lighting: validateEvidenceVector(input.lighting, LIGHTING_TAGS, 'lighting'),
    mood: validateEvidenceVector(input.mood, MOOD_TAGS, 'mood'),
  })
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value))
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

function axisSignal<T extends string>(
  preference: PreferenceVector<T> | undefined,
  evidence: PreferenceVector<T> | undefined,
): number | undefined {
  if (!preference || !evidence) return undefined
  let match = 0
  for (const [key, weight] of Object.entries(preference) as [T, number][]) {
    match += weight * (evidence[key] ?? 0)
  }
  return clamp(match * 2 - 1, -1, 1)
}

/**
 * Apply a bounded preference overlay without modifying or bypassing the rubric.
 * Missing model attributes are neutral rather than silently treated as a mismatch.
 */
export function applyPreferenceOverlay(
  rubricResult: PortraitRubricResult,
  dimensionScores: PortraitDimensionScores,
  attributes: PhotoPreferenceAttributes,
  profile: PreferenceProfile,
): PreferenceOverlayResult {
  validatePortraitDimensionScores(dimensionScores)
  if (rubricResult.eligibility.status !== 'eligible') {
    return Object.freeze({
      baselineScore: rubricResult.baselineScore,
      preferenceAdjustment: 0,
      adjustedScore: null,
      attributeSignal: 0,
      dimensionSignal: 0,
      hardCapApplied: true,
    })
  }
  if (profile.isBaseline || profile.maxQualityTradeoff === 0) {
    return Object.freeze({
      baselineScore: rubricResult.baselineScore,
      preferenceAdjustment: 0,
      adjustedScore: rubricResult.baselineScore,
      attributeSignal: 0,
      dimensionSignal: 0,
      hardCapApplied: rubricResult.baselineScore < rubricResult.uncappedScore,
    })
  }

  const axisSignals = [
    axisSignal(profile.expression, attributes.expression),
    axisSignal(profile.gaze, attributes.gaze),
    axisSignal(profile.framing, attributes.framing),
    axisSignal(profile.lighting, attributes.lighting),
    axisSignal(profile.mood, attributes.mood),
  ].filter((signal): signal is number => signal !== undefined)
  const attributeSignal = axisSignals.length
    ? axisSignals.reduce((sum, signal) => sum + signal, 0) / axisSignals.length
    : 0

  let dimensionSignal = 0
  const activeSignals: number[] = []
  if (axisSignals.length) activeSignals.push(attributeSignal)
  if (profile.dimensionWeights) {
    let preferredScore = 0
    for (const id of PORTRAIT_DIMENSION_IDS) {
      preferredScore += dimensionScores[id] * (profile.dimensionWeights[id] ?? 0)
    }
    const baselineWeightedScore = PORTRAIT_DIMENSION_IDS.reduce(
      (sum, id) => sum + dimensionScores[id] * PORTRAIT_BASELINE_WEIGHTS[id] / 100,
      0,
    )
    // A 50-point difference between the preferred and baseline views saturates the overlay.
    dimensionSignal = clamp((preferredScore - baselineWeightedScore) / 50, -1, 1)
    activeSignals.push(dimensionSignal)
  }

  const combinedSignal = activeSignals.length
    ? activeSignals.reduce((sum, signal) => sum + signal, 0) / activeSignals.length
    : 0
  const maximumAdjustment = profile.maxQualityTradeoff / 2
  const preferenceAdjustment = roundScore(clamp(
    combinedSignal * maximumAdjustment,
    -maximumAdjustment,
    maximumAdjustment,
  ))
  const uncappedAdjusted = clamp(rubricResult.baselineScore + preferenceAdjustment, 0, 100)
  const adjustedScore = roundScore(Math.min(uncappedAdjusted, rubricResult.eligibility.scoreCap))

  return Object.freeze({
    baselineScore: rubricResult.baselineScore,
    preferenceAdjustment,
    adjustedScore,
    attributeSignal: roundScore(attributeSignal),
    dimensionSignal: roundScore(dimensionSignal),
    hardCapApplied: adjustedScore < uncappedAdjusted || rubricResult.baselineScore < rubricResult.uncappedScore,
  })
}

/** Compute the ranking-time novelty allowance. The returned value never exceeds four points. */
export function diversityBonus(profile: PreferenceProfile, novelty: number): number {
  if (typeof novelty !== 'number' || !Number.isFinite(novelty) || novelty < 0 || novelty > 1) {
    throw new RangeError('novelty must be a finite number between 0 and 1')
  }
  return roundScore(Math.min(MAX_DIVERSITY_BONUS, profile.diversity * MAX_DIVERSITY_BONUS * novelty))
}
