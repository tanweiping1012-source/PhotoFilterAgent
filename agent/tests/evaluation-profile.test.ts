import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPortraitAttachmentCapacity,
  createPortraitEvaluationProfile,
  planPortraitAttachments,
  portraitStageCacheIdentity,
  PortraitEvaluationProfileError,
  usesVisualAnchors,
  type PortraitEvaluationProfile,
  type PortraitStageIdentityInput,
} from '../src/evaluation-profile.ts'

const OLD_RUBRIC_HASH = '1'.repeat(64)
const NEW_RUBRIC_HASH = '2'.repeat(64)
const ANCHOR_PACK_HASH = '3'.repeat(64)

function profile(arm: 'A' | 'B' | 'C'): PortraitEvaluationProfile {
  return createPortraitEvaluationProfile({
    arm,
    rubricVersion: arm === 'A' ? 'portrait-baseline-v1.0.0' : 'portrait-baseline-anchor-v0.1',
    rubricContentHash: arm === 'A' ? OLD_RUBRIC_HASH : NEW_RUBRIC_HASH,
    ...(arm === 'C' ? { visualAnchorPackHash: ANCHOR_PACK_HASH } : {}),
  })
}

function identityInput(
  evaluationProfile: PortraitEvaluationProfile,
  stage: 'low' | 'high' | 'pairwise',
): PortraitStageIdentityInput {
  return {
    profile: evaluationProfile,
    role: 'selector',
    stage,
    datasetFingerprint: 'dataset-fingerprint',
    routeIdentity: 'provider\0model\0protocol\0reasoning',
    promptHash: stage === 'pairwise' ? 'pair-prompt' : 'baseline-prompt',
    imageProtocol: stage === 'low' ? 'jpeg-512-v1' : 'jpeg-1536-v1',
    preferenceHash: 'empty-preference',
    aggregationVersion: 'pairwise-aggregation-v1',
    ...(evaluationProfile.arm === 'C' && stage !== 'low'
      ? {
        visualProtocol: {
          id: 'reference-sheet/v2' as const,
          anchorSheetSha256: '4'.repeat(64),
          layoutProtocolHash: '5'.repeat(64),
          qualityReceiptHash: '6'.repeat(64),
          anchorSheetCount: 1 as const,
          candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2' as const,
        },
      }
      : {}),
  }
}

test('only C high and pairwise use frozen visual anchors', () => {
  assert.equal(usesVisualAnchors(profile('A'), 'high'), false)
  assert.equal(usesVisualAnchors(profile('B'), 'pairwise'), false)
  assert.equal(usesVisualAnchors(profile('C'), 'low'), false)
  assert.equal(usesVisualAnchors(profile('C'), 'high'), true)
  assert.equal(usesVisualAnchors(profile('C'), 'pairwise'), true)
})

test('B and C low may share cache only because their effective contract is identical', () => {
  const b = portraitStageCacheIdentity(identityInput(profile('B'), 'low'))
  const c = portraitStageCacheIdentity(identityInput(profile('C'), 'low'))
  assert.equal(b, c)
})

test('C high and pairwise cannot reuse B results', () => {
  const bHigh = portraitStageCacheIdentity(identityInput(profile('B'), 'high'))
  const cHigh = portraitStageCacheIdentity(identityInput(profile('C'), 'high'))
  assert.notEqual(bHigh, cHigh)

  const bPair = portraitStageCacheIdentity(identityInput(profile('B'), 'pairwise'))
  const cPair = portraitStageCacheIdentity(identityInput(profile('C'), 'pairwise'))
  assert.notEqual(bPair, cPair)
})

test('role, stage, rubric content, route, prompt and preference all invalidate cache', () => {
  const base = identityInput(profile('B'), 'high')
  const key = portraitStageCacheIdentity(base)
  for (const changed of [
    { ...base, role: 'audit' as const },
    { ...base, stage: 'low' as const, imageProtocol: 'jpeg-512-v1' },
    { ...base, routeIdentity: 'different-route' },
    { ...base, promptHash: 'different-prompt' },
    { ...base, preferenceHash: 'different-preference' },
    { ...base, profile: createPortraitEvaluationProfile({
      arm: 'B',
      rubricVersion: base.profile.rubricVersion,
      rubricContentHash: '4'.repeat(64),
    }) },
  ]) {
    assert.notEqual(portraitStageCacheIdentity(changed), key)
  }
})

test('current two-image Harness blocks C pairwise with 14 separate anchor images', () => {
  assert.throws(
    () => assertPortraitAttachmentCapacity(
      profile('C'),
      'pairwise',
      { maxImagesPerMessage: 2, maxMessageImageBytes: 10_000_000 },
      { id: 'separate-anchor-images/v1', anchorImageCount: 14 },
    ),
    (error: unknown) => error instanceof PortraitEvaluationProfileError
      && error.code === 'ANCHOR_ATTACHMENT_UNSUPPORTED',
  )
})

test('reference sheet is never an implicit or unhashed fallback', () => {
  assert.throws(
    () => planPortraitAttachments(profile('C'), 'pairwise'),
    (error: unknown) => error instanceof PortraitEvaluationProfileError
      && error.code === 'VISUAL_PROTOCOL_REQUIRED',
  )
  assert.throws(() => planPortraitAttachments(profile('C'), 'pairwise', {
    id: 'reference-sheet/v2',
    anchorSheetSha256: '',
    layoutProtocolHash: '5'.repeat(64),
    qualityReceiptHash: '6'.repeat(64),
    anchorSheetCount: 1,
    candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2',
  }), PortraitEvaluationProfileError)
})

test('validated reference-sheet protocol fits exactly two Harness attachments', () => {
  const plan = assertPortraitAttachmentCapacity(
    profile('C'),
    'pairwise',
    { maxImagesPerMessage: 2, maxMessageImageBytes: 10_000_000 },
    {
      id: 'reference-sheet/v2',
      anchorSheetSha256: '4'.repeat(64),
      layoutProtocolHash: '5'.repeat(64),
      qualityReceiptHash: '6'.repeat(64),
      anchorSheetCount: 1,
      candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2',
    },
  )
  assert.deepEqual(plan, {
    imageCount: 2,
    candidateImageCount: 1,
    anchorImageCount: 1,
    protocolId: 'reference-sheet/v2',
  })
})

test('actual JPEG bytes are checked before an attachment can be written', () => {
  assert.throws(
    () => assertPortraitAttachmentCapacity(
      profile('C'),
      'high',
      { maxImagesPerMessage: 2, maxMessageImageBytes: 1_000 },
      {
        id: 'reference-sheet/v2',
        anchorSheetSha256: '4'.repeat(64),
        layoutProtocolHash: '5'.repeat(64),
        qualityReceiptHash: '6'.repeat(64),
        anchorSheetCount: 1,
        candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2',
      },
      { imageByteSizes: [700, 500] },
    ),
    (error: unknown) => error instanceof PortraitEvaluationProfileError
      && error.code === 'ANCHOR_ATTACHMENT_BYTES_EXCEEDED',
  )
})
