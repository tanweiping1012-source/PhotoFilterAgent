import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchorWeightedScore,
  PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
  PORTRAIT_ANCHOR_RUBRIC_VERSION,
  PORTRAIT_ANCHOR_WEIGHTS,
  PortraitAnchorRubricError,
  validatePortraitAnchorAssessment,
  validatePortraitAnchorPairwise,
  type PortraitAnchorAssessment,
} from '../src/portrait-anchor-rubric.ts'

const scores = {
  expression_eye_naturalness: 80,
  facial_features_shape: 70,
  pose_keepworthy_moment: 60,
  technical_completion: 90,
  environment_frame: 50,
}

function assessment(
  overrides: Partial<PortraitAnchorAssessment> = {},
): PortraitAnchorAssessment {
  const absoluteTier = overrides.absoluteTier ?? 'keep'
  return {
    id: 'anonymous-photo',
    rubricVersion: PORTRAIT_ANCHOR_RUBRIC_VERSION,
    hardGate: { triggered: false, code: null, confidence: 0.9, evidence: [] },
    absoluteTier,
    contentRejectCodes: [],
    uncertaintyCodes: [],
    dimensionScores: scores,
    dimensionEvidence: {
      expression_eye_naturalness: ['眼睛与表情可读'],
      facial_features_shape: ['五官和脸型可读'],
      pose_keepworthy_moment: ['姿态可读'],
      technical_completion: ['人物清晰'],
      environment_frame: ['背景可读'],
    },
    sortableScore: absoluteTier === 'keep' ? anchorWeightedScore(scores) : null,
    overallConfidence: 0.9,
    summary: 'test',
    ...overrides,
  }
}

test('anchor weights freeze person 75, technical 15 and environment 10', () => {
  assert.equal(Object.values(PORTRAIT_ANCHOR_WEIGHTS).reduce((sum, value) => sum + value, 0), 100)
  assert.equal(PORTRAIT_ANCHOR_WEIGHTS.expression_eye_naturalness
    + PORTRAIT_ANCHOR_WEIGHTS.facial_features_shape
    + PORTRAIT_ANCHOR_WEIGHTS.pose_keepworthy_moment, 75)
  assert.equal(PORTRAIT_ANCHOR_WEIGHTS.technical_completion, 15)
  assert.equal(PORTRAIT_ANCHOR_WEIGHTS.environment_frame, 10)
  assert.match(PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH, /^[a-f0-9]{64}$/u)
})

test('closed eyes hard gate forces reject even with strong dimension scores', () => {
  const value = assessment({
    hardGate: {
      triggered: true,
      code: 'HG_PRIMARY_SUBJECT_EYES_CLOSED_OR_BLINKING',
      confidence: 0.95,
      evidence: ['主要人物双眼闭合'],
    },
    absoluteTier: 'reject',
    sortableScore: null,
  })
  assert.equal(validatePortraitAnchorAssessment(value).sortableScore, null)
})

test('low-confidence hard gate is rejected as inconsistent and must become uncertain', () => {
  assert.throws(
    () => validatePortraitAnchorAssessment(assessment({
      hardGate: {
        triggered: true,
        code: 'HG_PRIMARY_SUBJECT_EYES_CLOSED_OR_BLINKING',
        confidence: 0.62,
        evidence: ['疑似闭眼'],
      },
      absoluteTier: 'reject',
      sortableScore: null,
    })),
    PortraitAnchorRubricError,
  )
})

test('partially open eyes can remain at keep threshold when holistic face is natural', () => {
  const value = assessment({
    absoluteTier: 'keep_threshold',
    sortableScore: anchorWeightedScore(scores),
    summary: '眼睛没有完全睁大，但五官和脸型自然。',
  })
  assert.equal(validatePortraitAnchorAssessment(value).absoluteTier, 'keep_threshold')
})

test('content reject requires a reason and is never sortable', () => {
  assert.throws(
    () => validatePortraitAnchorAssessment(assessment({
      absoluteTier: 'reject',
      sortableScore: null,
    })),
    PortraitAnchorRubricError,
  )
  const value = assessment({
    absoluteTier: 'reject',
    contentRejectCodes: ['CQ_STARING_OR_TENSE_GAZE'],
    sortableScore: null,
  })
  assert.equal(validatePortraitAnchorAssessment(value).sortableScore, null)
})

test('pairwise keeps absolute threshold separate from relative ranking', () => {
  assert.deepEqual(validatePortraitAnchorPairwise({
    leftTier: 'keep_threshold',
    rightTier: 'reject',
    result: 'left',
    strength: 'clear',
    reason: '左图过线，右图瞪视紧张。',
  }).result, 'left')
  assert.throws(() => validatePortraitAnchorPairwise({
    leftTier: 'reject',
    rightTier: 'reject',
    result: 'left',
    strength: 'slight',
    reason: '强制选较不差者',
  }), PortraitAnchorRubricError)
  assert.equal(validatePortraitAnchorPairwise({
    leftTier: 'reject',
    rightTier: 'reject',
    result: 'reject_both',
    strength: 'clear',
    reason: '两张都未过线。',
  }).result, 'reject_both')
})

test('uncertain pairwise cannot fabricate a stable winner', () => {
  assert.throws(() => validatePortraitAnchorPairwise({
    leftTier: 'uncertain',
    rightTier: 'keep',
    result: 'right',
    strength: 'slight',
    reason: '未复核就决定',
  }), PortraitAnchorRubricError)
})
