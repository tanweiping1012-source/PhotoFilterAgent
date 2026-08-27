import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compactPreferenceProfileInput,
  applyPreferenceOverlay,
  createPhotoPreferenceAttributes,
  createPreferenceProfile,
  diversityBonus,
} from '../src/preferences.ts'
import { scorePortraitBaseline, type PortraitDimensionScores } from '../src/rubric.ts'
import { rankPortraits } from '../src/ranking.ts'

const eligible = {
  assessable: true,
  intentionalHumanSubject: true,
  primarySubjectInterpretable: true,
}

const scores = (humanMoment = 70): PortraitDimensionScores => ({
  technical_subject_legibility: 70,
  human_moment: humanMoment,
  composition_visual_hierarchy: 70,
  light_color_tone: 70,
  travel_context_story: 70,
  intentionality_finish: 70,
})

test('empty preferences are an exact baseline invariant', () => {
  const dimensions = scores()
  const rubric = scorePortraitBaseline(dimensions, eligible)
  const result = applyPreferenceOverlay(
    rubric,
    dimensions,
    createPhotoPreferenceAttributes({ expression: { joyful: 1 } }),
    createPreferenceProfile({}),
  )
  assert.equal(result.preferenceAdjustment, 0)
  assert.equal(result.adjustedScore, rubric.baselineScore)
  assert.equal(result.baselineScore, rubric.baselineScore)
})

test('tool-materialized undefined fields compact back to a true baseline input', () => {
  const compacted = compactPreferenceProfileInput({
    diversity: undefined,
    seriesRetention: undefined,
    expression: undefined,
  })
  assert.deepEqual(compacted, {})
  const profile = createPreferenceProfile(compacted)
  assert.equal(profile.isBaseline, true)
  assert.equal(profile.diversityExplicit, false)
})

test('series retention defaults to balanced without changing baseline semantics', () => {
  const defaultProfile = createPreferenceProfile({})
  const explicitBalanced = createPreferenceProfile({ seriesRetention: 'balanced' })

  assert.equal(defaultProfile.seriesRetention, 'balanced')
  assert.equal(defaultProfile.diversity, 1)
  assert.equal(defaultProfile.diversityExplicit, false)
  assert.equal(defaultProfile.isBaseline, true)
  assert.equal(explicitBalanced.seriesRetention, 'balanced')
  assert.equal(explicitBalanced.isBaseline, true)
})

test('diversity distinguishes inherited baseline strength from explicit user input', () => {
  const disabled = createPreferenceProfile({ diversity: 0 })
  const partial = createPreferenceProfile({ diversity: 0.4 })
  const explicitBaselineValue = createPreferenceProfile({ diversity: 1 })

  assert.deepEqual(
    [disabled.diversity, partial.diversity, explicitBaselineValue.diversity],
    [0, 0.4, 1],
  )
  assert.equal(disabled.diversityExplicit, true)
  assert.equal(partial.diversityExplicit, true)
  assert.equal(explicitBaselineValue.diversityExplicit, true)
  assert.equal(disabled.isBaseline, false)
  assert.equal(partial.isBaseline, false)
  assert.equal(explicitBaselineValue.isBaseline, false)
})

test('serialized diversity profile preserves omission semantics on restore', () => {
  const inherited = createPreferenceProfile({})
  const explicit = createPreferenceProfile({ diversity: 1 })

  assert.deepEqual(createPreferenceProfile(JSON.parse(JSON.stringify(inherited))), inherited)
  assert.deepEqual(createPreferenceProfile(JSON.parse(JSON.stringify(explicit))), explicit)
  assert.throws(() => createPreferenceProfile({ diversityExplicit: 'yes' }), /diversityExplicit/)
  assert.throws(() => createPreferenceProfile({ diversity: 0, diversityExplicit: false }), /inherited baseline/)
})

test('series retention accepts only the frozen structured values', () => {
  assert.equal(createPreferenceProfile({ seriesRetention: 'one_per_family' }).seriesRetention, 'one_per_family')
  assert.equal(createPreferenceProfile({ seriesRetention: 'allow_series' }).seriesRetention, 'allow_series')
  assert.equal(createPreferenceProfile({ seriesRetention: 'one_per_family' }).isBaseline, false)
  assert.equal(createPreferenceProfile({ seriesRetention: 'allow_series' }).isBaseline, false)
  assert.throws(() => createPreferenceProfile({ seriesRetention: 'keep_everything' }), /seriesRetention/)
  assert.throws(() => createPreferenceProfile({ seriesRetention: 1 }), /seriesRetention/)
})

test('different expression preferences deterministically change ordering', () => {
  const dimensions = scores()
  const rubric = scorePortraitBaseline(dimensions, eligible)
  const joyfulProfile = createPreferenceProfile({ expression: { joyful: 1 } })
  const calmProfile = createPreferenceProfile({ expression: { calm: 1 } })
  const joyfulAttributes = createPhotoPreferenceAttributes({ expression: { joyful: 1, calm: 0 } })
  const calmAttributes = createPhotoPreferenceAttributes({ expression: { joyful: 0, calm: 1 } })

  const underJoyful = [
    { id: 'joyful', score: applyPreferenceOverlay(rubric, dimensions, joyfulAttributes, joyfulProfile).adjustedScore!, eligibility: 'eligible' as const },
    { id: 'calm', score: applyPreferenceOverlay(rubric, dimensions, calmAttributes, joyfulProfile).adjustedScore!, eligibility: 'eligible' as const },
  ]
  const underCalm = [
    { id: 'joyful', score: applyPreferenceOverlay(rubric, dimensions, joyfulAttributes, calmProfile).adjustedScore!, eligibility: 'eligible' as const },
    { id: 'calm', score: applyPreferenceOverlay(rubric, dimensions, calmAttributes, calmProfile).adjustedScore!, eligibility: 'eligible' as const },
  ]

  assert.equal(rankPortraits(underJoyful, { topK: 1 })[0].id, 'joyful')
  assert.equal(rankPortraits(underCalm, { topK: 1 })[0].id, 'calm')
})

test('preference cannot rescue or flip a hard-gated failure', () => {
  const dimensions = scores(100)
  const hardFailed = scorePortraitBaseline(dimensions, {
    ...eligible,
    catastrophicFailure: true,
    catastrophicFailureConfidence: 0.99,
  })
  const matching = applyPreferenceOverlay(
    hardFailed,
    dimensions,
    createPhotoPreferenceAttributes({ expression: { joyful: 1 } }),
    createPreferenceProfile({ expression: { joyful: 1 }, maxQualityTradeoff: 8 }),
  )
  assert.equal(hardFailed.baselineScore, 0)
  assert.equal(matching.adjustedScore, null)
  assert.equal(matching.hardCapApplied, true)

  const selected = rankPortraits([
    { id: 'hard-failed', score: 100, eligibility: hardFailed.eligibility.status },
    { id: 'eligible', score: 21, eligibility: 'eligible' },
  ], { topK: 1 })
  assert.equal(selected[0].id, 'eligible')
})

test('preference inputs normalize strictly and the eight-point tradeoff means at most ±4', () => {
  const profile = createPreferenceProfile({
    expression: { joyful: 3, candid: 1 },
    dimensionWeights: { human_moment: 4, travel_context_story: 1 },
  })
  assert.equal(profile.expression?.joyful, 0.75)
  assert.equal(profile.expression?.candid, 0.25)
  assert.equal(profile.dimensionWeights?.human_moment, 0.8)
  assert.throws(() => createPreferenceProfile({ expression: { unknown: 1 } }), /unknown value/)
  assert.throws(() => createPreferenceProfile({ diversity: 1.01 }), /diversity/)

  const dimensions = scores(100)
  const rubric = scorePortraitBaseline(dimensions, eligible)
  const overlay = applyPreferenceOverlay(
    rubric,
    dimensions,
    createPhotoPreferenceAttributes({ expression: { joyful: 1, candid: 1 } }),
    profile,
  )
  assert.ok(Math.abs(overlay.preferenceAdjustment) <= 4)
})

test('diversity compensation is bounded to four points', () => {
  const profile = createPreferenceProfile({ diversity: 1 })
  assert.equal(diversityBonus(profile, 1), 4)
  assert.equal(diversityBonus(profile, 0.5), 2)
})
