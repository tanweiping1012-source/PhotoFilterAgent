import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PORTRAIT_BASELINE_RUBRIC,
  PORTRAIT_BASELINE_RUBRIC_VERSION,
  PORTRAIT_BASELINE_WEIGHTS,
  evaluateEligibilityGate,
  scorePortraitBaseline,
  type PortraitDimensionScores,
} from '../src/rubric.ts'

const allAt = (score: number): PortraitDimensionScores => ({
  technical_subject_legibility: score,
  human_moment: score,
  composition_visual_hierarchy: score,
  light_color_tone: score,
  travel_context_story: score,
  intentionality_finish: score,
})

const eligible = {
  assessable: true,
  intentionalHumanSubject: true,
  primarySubjectInterpretable: true,
}

test('frozen baseline has six dimensions, stable version, and weights sum to 100', () => {
  assert.equal(PORTRAIT_BASELINE_RUBRIC.version, PORTRAIT_BASELINE_RUBRIC_VERSION)
  assert.equal(PORTRAIT_BASELINE_RUBRIC.dimensions.length, 6)
  assert.ok(PORTRAIT_BASELINE_RUBRIC.dimensions.every(dimension => (
    dimension.anchors.map(anchor => anchor.score).join(',') === '0,25,50,75,100'
  )))
  assert.equal(Object.values(PORTRAIT_BASELINE_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100)
  assert.deepEqual(PORTRAIT_BASELINE_WEIGHTS, {
    technical_subject_legibility: 18,
    human_moment: 22,
    composition_visual_hierarchy: 18,
    light_color_tone: 16,
    travel_context_story: 16,
    intentionality_finish: 10,
  })
})

test('uniform dimension scores remain unchanged by baseline aggregation', () => {
  const result = scorePortraitBaseline(allAt(73), eligible)
  assert.equal(result.uncappedScore, 73)
  assert.equal(result.baselineScore, 73)
  assert.equal(result.eligibility.eligible, true)
})

test('eligibility gate maps confidence to review or ineligible and never emits a sortable score', () => {
  const gate = evaluateEligibilityGate({
    assessable: false,
    intentionalHumanSubject: true,
    primarySubjectInterpretable: false,
    catastrophicFailure: true,
    primarySubjectInterpretableConfidence: 0.96,
    catastrophicFailureConfidence: 0.96,
  })
  assert.equal(gate.eligible, false)
  assert.equal(gate.status, 'ineligible')
  assert.deepEqual(gate.failures, [
    'HR_UNASSESSABLE_ASSET',
    'HR_PRIMARY_SUBJECT_UNINTERPRETABLE',
    'HR_CATASTROPHIC_CAPTURE_FAILURE',
  ])
  assert.equal(gate.scoreCap, 0)
  const rejected = scorePortraitBaseline(allAt(99), {
    assessable: true,
    intentionalHumanSubject: true,
    primarySubjectInterpretable: true,
    catastrophicFailure: true,
    catastrophicFailureConfidence: 0.95,
  })
  assert.equal(rejected.baselineScore, 0)
  assert.equal(rejected.sortableScore, null)

  const uncertain = evaluateEligibilityGate({
    assessable: true,
    intentionalHumanSubject: true,
    primarySubjectInterpretable: true,
    catastrophicFailure: true,
    catastrophicFailureConfidence: 0.8,
  })
  assert.equal(uncertain.status, 'needs_review')
})

test('closed eyes are not an eligibility failure in rubric v1', () => {
  // The gate deliberately has no eyesClosed input. Intentional closed-eye portraits
  // are judged under human_moment and intentionality_finish instead.
  assert.deepEqual(evaluateEligibilityGate(eligible), {
    status: 'eligible',
    eligible: true,
    failures: [],
    scoreCap: 100,
  })
})

test('invalid dimension scores fail closed', () => {
  const invalid = { ...allAt(50), human_moment: 101 }
  assert.throws(() => scorePortraitBaseline(invalid, eligible), /human_moment/)
})
