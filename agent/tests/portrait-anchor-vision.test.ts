import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { HARNESS_VISION_PROTOCOL, type StructuredVisionRequest } from '../src/harness-vision.ts'
import { createPortraitEvaluationProfile } from '../src/evaluation-profile.ts'
import {
  AnchorPortraitVisionClient,
  combineAnchorPairwiseLegs,
  type AnchorVisionTransport,
  type VisualAnchorRuntime,
} from '../src/portrait-anchor-vision.ts'
import {
  makePairCandidateSheetReceipt,
  makeReferenceSheetQualityReceipt,
  metadataFreeTestJpeg,
} from './reference-sheet-evidence-fixture.ts'

const repeatedHash = (character: string) => character.repeat(64)
const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]).toString('base64')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const jpegSha = (value: string) => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')

function baselineRaw(tier: 'reject' | 'keep' = 'keep') {
  const hardReject = tier === 'reject'
  return {
    hardGate: {
      triggered: hardReject,
      code: hardReject ? 'HG_PRIMARY_SUBJECT_EYES_CLOSED_OR_BLINKING' : null,
      confidence: 0.95,
      evidence: hardReject ? ['主要人物明确闭眼'] : [],
    },
    absoluteTier: tier,
    contentRejectCodes: [],
    uncertaintyCodes: [],
    dimensionScores: {
      expression_eye_naturalness: 80,
      facial_features_shape: 75,
      pose_keepworthy_moment: 70,
      technical_completion: 85,
      environment_frame: 65,
    },
    dimensionEvidence: {
      expression_eye_naturalness: ['眼睛与表情清楚'],
      facial_features_shape: ['脸型流畅'],
      pose_keepworthy_moment: ['姿态自然'],
      technical_completion: ['人脸清晰'],
      environment_frame: ['背景有层次'],
    },
    overallConfidence: 0.91,
    summary: '结构化测试',
    primarySubjectHeadFocus: {
      center_x: 0.51,
      center_y: 0.42,
      side_fraction: 0.3,
    },
  }
}

class FakeTransport implements AnchorVisionTransport {
  readonly route = {
    provider: 'selected-provider',
    model: 'selected-model',
    protocol: HARNESS_VISION_PROTOCOL,
    reasoningEffort: 'high',
  } as const
  readonly requests: StructuredVisionRequest[] = []
  response: Record<string, unknown> = baselineRaw()

  attachmentLimits() {
    return { maxImagesPerMessage: 2, maxMessageImageBytes: 1_000_000, mediaTypes: ['image/jpeg'] }
  }

  async invokeStructured(request: StructuredVisionRequest) {
    this.requests.push(request)
    return this.response
  }
}

function profile(arm: 'B' | 'C') {
  return createPortraitEvaluationProfile({
    arm,
    rubricVersion: 'portrait-baseline-anchor-v0.1',
    rubricContentHash: repeatedHash('2'),
    ...(arm === 'C' ? { visualAnchorPackHash: repeatedHash('3') } : {}),
  })
}

function visualRuntime(): VisualAnchorRuntime {
  const anchor = jpeg(1)
  const legendText = 'anchor-001：A=best，B=reject；用于校准明确闭眼和自然表情。'
  const qualityReceipt = makeReferenceSheetQualityReceipt({
    anchorPackHash: repeatedHash('3'),
    anchorSheetSha256: jpegSha(anchor),
    layoutProtocolHash: repeatedHash('4'),
  })
  return {
    protocol: {
      id: 'reference-sheet/v2',
      anchorSheetSha256: jpegSha(anchor),
      layoutProtocolHash: repeatedHash('4'),
      qualityReceiptHash: qualityReceipt.receiptHash,
      anchorSheetCount: 1,
      candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2',
    },
    qualityReceipt,
    anchorSheetJpegBase64: anchor,
    legendText,
    legendHash: sha(legendText),
  }
}

function identity(stage: 'low' | 'high' | 'pairwise') {
  return {
    role: 'selector' as const,
    stage,
    datasetFingerprint: 'dataset',
    routeIdentity: 'selected-provider\0selected-model\0protocol\0high',
    imageProtocol: stage === 'low' ? 'jpeg-512-v1' : 'jpeg-1536-v1',
    preferenceHash: 'empty',
    aggregationVersion: 'anchor-pairwise-v1',
  }
}

test('B and C low requests are byte-identical and share effective cache identity', async () => {
  const bTransport = new FakeTransport()
  const cTransport = new FakeTransport()
  const b = new AnchorPortraitVisionClient({ transport: bTransport, profile: profile('B') })
  const c = new AnchorPortraitVisionClient({
    transport: cTransport, profile: profile('C'), visualRuntime: visualRuntime(),
  })
  await b.scoreBaseline('opaque', jpeg(2), 'low', 'selector')
  await c.scoreBaseline('opaque', jpeg(2), 'low', 'selector')
  assert.deepEqual(bTransport.requests[0], cTransport.requests[0])
  assert.equal(b.stageCacheIdentity(identity('low')), c.stageCacheIdentity(identity('low')))
})

test('C high sends validated anchors first and target second while B sends only target', async () => {
  const bTransport = new FakeTransport()
  const cTransport = new FakeTransport()
  const runtime = visualRuntime()
  const b = new AnchorPortraitVisionClient({ transport: bTransport, profile: profile('B') })
  const c = new AnchorPortraitVisionClient({ transport: cTransport, profile: profile('C'), visualRuntime: runtime })
  const bResult = await b.scoreBaseline('opaque', jpeg(2), 'high', 'audit')
  const cResult = await c.scoreBaseline('opaque', jpeg(2), 'high', 'audit')
  assert.deepEqual(bTransport.requests[0]?.jpegs, [jpeg(2)])
  assert.deepEqual(cTransport.requests[0]?.jpegs, [runtime.anchorSheetJpegBase64, jpeg(2)])
  assert.notEqual(b.stageCacheIdentity(identity('high')), c.stageCacheIdentity(identity('high')))
  assert.deepEqual(bResult.primarySubjectHeadFocus, {
    center_x: 0.51, center_y: 0.42, side_fraction: 0.3,
  })
  assert.deepEqual(cResult.primarySubjectHeadFocus, bResult.primarySubjectHeadFocus)
})

test('high fails closed when the model omits or invalidates the frozen subject focus', async () => {
  const transport = new FakeTransport()
  const missing = baselineRaw()
  delete (missing as { primarySubjectHeadFocus?: unknown }).primarySubjectHeadFocus
  transport.response = missing
  const client = new AnchorPortraitVisionClient({ transport, profile: profile('B') })
  await assert.rejects(
    client.scoreBaseline('opaque', jpeg(2), 'high', 'selector'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'MISSING_SUBJECT_HEAD_FOCUS',
  )

  transport.response = {
    ...baselineRaw(),
    primarySubjectHeadFocus: { center_x: 1.2, center_y: 0.4, side_fraction: 0.3 },
  }
  await assert.rejects(
    client.scoreBaseline('opaque', jpeg(2), 'high', 'selector'),
    (error: unknown) => error instanceof Error
      && (error as { code?: string }).code === 'INVALID_STRUCTURED_OUTPUT',
  )
})

test('hard gate output is validated and sortable score is always local', async () => {
  const transport = new FakeTransport()
  transport.response = baselineRaw('reject')
  const client = new AnchorPortraitVisionClient({ transport, profile: profile('B') })
  const result = await client.scoreBaseline('opaque', jpeg(2), 'low', 'selector')
  assert.equal(result.absoluteTier, 'reject')
  assert.equal(result.sortableScore, null)
  assert.equal(result.hardGate.code, 'HG_PRIMARY_SUBJECT_EYES_CLOSED_OR_BLINKING')
})

test('C pairwise sends only anchor sheet plus a source-bound FIRST/SECOND sheet', async () => {
  const transport = new FakeTransport()
  transport.response = {
    firstTier: 'keep',
    secondTier: 'reject',
    result: 'first',
    dimensionDeltas: {
      expression_eye_naturalness: 2,
      facial_features_shape: 1,
      pose_keepworthy_moment: 1,
      technical_completion: 0,
      environment_frame: 0,
    },
    confidence: 0.9,
    reason: 'FIRST 人物状态更自然，SECOND 未过线。',
  }
  const runtime = visualRuntime()
  const client = new AnchorPortraitVisionClient({ transport, profile: profile('C'), visualRuntime: runtime })
  const first = jpeg(2)
  const second = jpeg(3)
  const sheet = metadataFreeTestJpeg(4)
  const receipt = makePairCandidateSheetReceipt({
    combinedLayoutProtocolHash: repeatedHash('4'),
    firstAnonymousID: 'a',
    secondAnonymousID: 'b',
    firstSourceJpegBase64: first,
    secondSourceJpegBase64: second,
    candidateSheetJpegBase64: sheet,
  })
  const result = await client.comparePairLeg({
    aId: 'a', aJpegBase64: first, bId: 'b', bJpegBase64: second,
    order: 'AB', role: 'selector', pairCandidateSheet: { jpegBase64: sheet, receipt },
  })
  assert.equal(result.result, 'left')
  assert.deepEqual(transport.requests[0]?.jpegs, [runtime.anchorSheetJpegBase64, sheet])
  assert.equal(transport.requests[0]?.jpegs.includes(first), false)
  assert.equal(transport.requests[0]?.jpegs.includes(second), false)
})

test('AB/BA disagreement is uncertainty and never a fabricated winner', () => {
  const base = {
    leftTier: 'keep' as const,
    rightTier: 'keep' as const,
    strength: 'clear' as const,
    normalizedDimensionDeltas: {
      expression_eye_naturalness: 1,
      facial_features_shape: 1,
      pose_keepworthy_moment: 0,
      technical_completion: 0,
      environment_frame: 0,
    },
    weightedMargin: 3,
    confidence: 0.9,
    reason: 'test',
  }
  const result = combineAnchorPairwiseLegs('a', 'b',
    { ...base, order: 'AB', result: 'left' },
    { ...base, order: 'BA', result: 'right', weightedMargin: -3 })
  assert.equal(result.winner, 'TIE')
})
