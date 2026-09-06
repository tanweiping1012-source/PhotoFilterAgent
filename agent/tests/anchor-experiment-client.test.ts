import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  AnchorExperimentVisionClient,
  AnchorExperimentVisionClientError,
  type AnchorExperimentPairSheetEngine,
} from '../src/anchor-experiment-client.ts'
import type { AnchorExperimentRunBinding } from '../src/anchor-experiment-state.ts'
import type { ReferenceSheetFaceFocus, ReferenceSheetPreview } from '../src/engine.ts'
import { createPortraitEvaluationProfile } from '../src/evaluation-profile.ts'
import { HARNESS_VISION_PROTOCOL, type StructuredVisionRequest } from '../src/harness-vision.ts'
import type { AnchorVisionTransport, VisualAnchorRuntime } from '../src/portrait-anchor-vision.ts'
import { PAIR_CANDIDATE_LAYOUT_PROTOCOL } from '../src/reference-sheet-quality.ts'
import {
  makeReferenceSheetQualityReceipt,
  metadataFreeTestJpeg,
} from './reference-sheet-evidence-fixture.ts'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const jpegSha = (value: string) => sha(Buffer.from(value, 'base64'))
const fixedHash = (value: string) => sha(value)

class FakeTransport implements AnchorVisionTransport {
  readonly route = Object.freeze({
    provider: 'selected-provider',
    model: 'selected-model',
    protocol: HARNESS_VISION_PROTOCOL,
    reasoningEffort: 'high',
  })
  response: Record<string, unknown> = anchorBaselineRaw()
  readonly requests: StructuredVisionRequest[] = []

  attachmentLimits() {
    return Object.freeze({
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 20_000_000,
      mediaTypes: Object.freeze(['image/jpeg']),
    })
  }

  async invokeStructured(request: StructuredVisionRequest) {
    this.requests.push(request)
    return this.response
  }
}

function routeIdentityHash(transport: FakeTransport): string {
  return sha([
    transport.route.provider,
    transport.route.model,
    transport.route.protocol,
    transport.route.reasoningEffort,
  ].join('\u0000'))
}

function anchorBaselineRaw() {
  return {
    hardGate: { triggered: false, code: null, confidence: 0.95, evidence: [] },
    absoluteTier: 'keep',
    contentRejectCodes: [],
    uncertaintyCodes: [],
    dimensionScores: {
      expression_eye_naturalness: 82,
      facial_features_shape: 78,
      pose_keepworthy_moment: 75,
      technical_completion: 84,
      environment_frame: 70,
    },
    dimensionEvidence: {
      expression_eye_naturalness: ['眼睛自然睁开'],
      facial_features_shape: ['脸型流畅'],
      pose_keepworthy_moment: ['姿态成立'],
      technical_completion: ['人脸清晰'],
      environment_frame: ['背景完整'],
    },
    overallConfidence: 0.9,
    summary: '可保留',
    primarySubjectHeadFocus: { center_x: 0.5, center_y: 0.35, side_fraction: 0.25 },
  }
}

function legacyBaselineRaw() {
  const dimensions = {
    technical_subject_legibility: 80,
    human_moment: 75,
    composition_visual_hierarchy: 70,
    light_color_tone: 72,
    travel_context_story: 68,
    intentionality_finish: 74,
  }
  return {
    eligibility: {
      status: 'eligible', failureCodes: [], evidence: ['主体可读'],
      assessability: 0.95, ambiguousIntent: false,
    },
    dimensionScores: dimensions,
    dimensionConfidences: Object.fromEntries(Object.keys(dimensions).map(key => [key, 0.9])),
    dimensionEvidence: Object.fromEntries(Object.keys(dimensions).map(key => [key, ['像素证据']])),
    overallConfidence: 0.9,
    scoreInterval: [70, 80],
    observableTags: {
      expression: [], gaze: [], framing: [], lighting: [], mood: [], scene: [], poseAction: [],
    },
    summary: '旧基线结果',
  }
}

function anchorPairRaw() {
  return {
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
    reason: 'FIRST 人物状态更自然。',
  }
}

function profile(arm: 'A' | 'B' | 'C', visualPackHash = fixedHash('pack')) {
  return createPortraitEvaluationProfile({
    arm,
    rubricVersion: arm === 'A' ? 'legacy-v1' : 'portrait-baseline-anchor-v0.1',
    rubricContentHash: fixedHash(arm === 'A' ? 'legacy-rubric' : 'anchor-rubric'),
    ...(arm === 'C' ? { visualAnchorPackHash: visualPackHash } : {}),
  })
}

function visualRuntime(packHash = fixedHash('pack')): VisualAnchorRuntime {
  const sheet = metadataFreeTestJpeg(1)
  const layoutProtocolHash = fixedHash('reference-layout')
  const qualityReceipt = makeReferenceSheetQualityReceipt({
    anchorPackHash: packHash,
    anchorSheetSha256: jpegSha(sheet),
    layoutProtocolHash,
  })
  const legendText = '匿名锚点 legend'
  return Object.freeze({
    protocol: Object.freeze({
      id: 'reference-sheet/v2',
      anchorSheetSha256: jpegSha(sheet),
      layoutProtocolHash,
      qualityReceiptHash: qualityReceipt.receiptHash,
      anchorSheetCount: 1,
      candidateSheetProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    }),
    qualityReceipt,
    anchorSheetJpegBase64: sheet,
    legendText,
    legendHash: sha(legendText),
  })
}

function binding(
  arm: 'A' | 'B' | 'C',
  transport: FakeTransport,
  runtime?: VisualAnchorRuntime,
): AnchorExperimentRunBinding {
  const activeProfile = profile(arm)
  return Object.freeze({
    schemaVersion: 'photo-filter-anchor-experiment-binding/v1',
    experimentId: 'experiment-1',
    arm,
    manifestHash: fixedHash(`manifest:${arm}`),
    sourceSnapshotHash: fixedHash('source'),
    datasetFingerprint: fixedHash('dataset'),
    candidateScope: 'people_only',
    targetK: 2,
    seed: 'seed',
    preferenceHash: fixedHash('preference'),
    route: transport.route,
    routeIdentityHash: routeIdentityHash(transport),
    profileProtocol: activeProfile.protocol,
    rubricVersion: activeProfile.rubricVersion,
    rubricContentHash: activeProfile.rubricContentHash,
    contracts: Object.freeze({
      selectorLow: fixedHash(`${arm}:sl`), selectorHigh: fixedHash(`${arm}:sh`),
      selectorPairwise: fixedHash(`${arm}:sp`), auditLow: fixedHash(`${arm}:al`),
      auditHigh: fixedHash(`${arm}:ah`), auditPairwise: fixedHash(`${arm}:ap`),
    }),
    budget: Object.freeze({
      highCap: 2, pairwisePairCap: 2, auditCallCapPerTurn: 2,
      maxCompleteAuditRounds: 2,
    }),
    ...(arm === 'C' && runtime ? { visual: Object.freeze({
      anchorPackHash: fixedHash('pack'),
      anchorSheetSha256: runtime.protocol.anchorSheetSha256,
      layoutProtocolHash: runtime.protocol.layoutProtocolHash,
      qualityReceiptHash: runtime.protocol.qualityReceiptHash,
      legendHash: runtime.legendHash,
    }) } : {}),
    stateNamespaceHash: fixedHash(`namespace:${arm}`),
  })
}

class FakePairEngine implements AnchorExperimentPairSheetEngine {
  readonly calls: Array<{
    firstId: string
    secondId: string
    firstFocus: ReferenceSheetFaceFocus
    secondFocus: ReferenceSheetFaceFocus
  }> = []
  tamperIdentity = false

  async candidatePairSheet(
    firstId: string,
    secondId: string,
    firstFocus: ReferenceSheetFaceFocus,
    secondFocus: ReferenceSheetFaceFocus,
  ): Promise<ReferenceSheetPreview> {
    this.calls.push({ firstId, secondId, firstFocus, secondFocus })
    const firstHash = jpegSha(firstId === 'a' ? metadataFreeTestJpeg(2) : metadataFreeTestJpeg(3))
    const secondHash = jpegSha(secondId === 'b' ? metadataFreeTestJpeg(3) : metadataFreeTestJpeg(2))
    const sheet = metadataFreeTestJpeg(4)
    const bytes = Buffer.from(sheet, 'base64')
    return {
      layout_protocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
      width: 3072,
      height: 1536,
      pair_count: 1,
      asset_count: 2,
      bytes: bytes.byteLength,
      jpeg_sha256: sha(bytes),
      jpeg_base64: sheet,
      source_preview_sha256: [firstHash, secondHash],
      cells: [
        { cell: 1, label: 'FIRST', face_critical: true, primary_face_short_edge_pixels: null,
          face_region_source: 'explicit_focus_unverified' },
        { cell: 2, label: 'SECOND', face_critical: true, primary_face_short_edge_pixels: null,
          face_region_source: 'explicit_focus_unverified' },
      ],
      ordered_cell_identity: [
        { cell: 1, anchor_id: null, slot: 'FIRST',
          anonymous_id: this.tamperIdentity ? 'wrong' : firstId, source_preview_sha256: firstHash },
        { cell: 2, anchor_id: null, slot: 'SECOND', anonymous_id: secondId,
          source_preview_sha256: secondHash },
      ],
    }
  }
}

test('route mismatch blocks construction before any visual request', () => {
  const transport = new FakeTransport()
  const active = binding('B', transport)
  const mismatched = Object.freeze({
    ...active,
    route: Object.freeze({ ...active.route, model: 'other-model' }),
  })
  assert.throws(() => new AnchorExperimentVisionClient({
    binding: mismatched,
    profile: profile('B'),
    transport,
  }), (error: unknown) => error instanceof AnchorExperimentVisionClientError
    && error.code === 'EXPERIMENT_ROUTE_MISMATCH')
  assert.equal(transport.requests.length, 0)
})

test('A and B retain honest disjoint assessment contracts', async () => {
  const aTransport = new FakeTransport()
  aTransport.response = legacyBaselineRaw()
  const a = new AnchorExperimentVisionClient({
    binding: binding('A', aTransport), profile: profile('A'), transport: aTransport,
  })
  const aResult = await a.scoreBaseline({
    id: 'a', jpegBase64: metadataFreeTestJpeg(2), detail: 'low', role: 'selector',
  })
  assert.equal(aResult.contract, 'legacy-portrait-baseline/v1')
  assert.equal('baselineScore' in aResult.raw, true)

  const bTransport = new FakeTransport()
  const b = new AnchorExperimentVisionClient({
    binding: binding('B', bTransport), profile: profile('B'), transport: bTransport,
  })
  const bResult = await b.scoreBaseline({
    id: 'b', jpegBase64: metadataFreeTestJpeg(3), detail: 'low', role: 'selector',
  })
  assert.equal(bResult.contract, 'portrait-anchor-rubric/v1')
  assert.equal('baselineScore' in bResult.raw, false)
})

test('C prepares exact FIRST/SECOND render evidence and receipt before the paid leg', async () => {
  const transport = new FakeTransport()
  const runtime = visualRuntime()
  const engine = new FakePairEngine()
  const client = new AnchorExperimentVisionClient({
    binding: binding('C', transport, runtime),
    profile: profile('C'),
    transport,
    visualRuntime: runtime,
    pairSheetEngine: engine,
  })
  const aJpeg = metadataFreeTestJpeg(2)
  const bJpeg = metadataFreeTestJpeg(3)
  const aHigh = await client.scoreBaseline({
    id: 'a', jpegBase64: aJpeg, detail: 'high', role: 'audit',
  })
  const bHigh = await client.scoreBaseline({
    id: 'b', jpegBase64: bJpeg, detail: 'high', role: 'audit',
  })
  transport.response = anchorPairRaw()
  const requestsBeforePrepare = transport.requests.length
  const prepared = await client.preparePairLeg({
    aId: 'a', aJpegBase64: aJpeg,
    bId: 'b', bJpegBase64: bJpeg,
    order: 'AB', role: 'audit', aHighAssessment: aHigh, bHighAssessment: bHigh,
  })
  assert.equal(transport.requests.length, requestsBeforePrepare)
  assert.match(prepared.cacheKey, /^[a-f0-9]{64}$/u)
  assert.match(prepared.pairCandidateReceiptHash ?? '', /^[a-f0-9]{64}$/u)
  const record = await client.invokePreparedPairLeg(prepared)
  assert.equal(record.decision.contract, 'portrait-anchor-pairwise/v1')
  assert.match(record.pairCandidateReceiptHash ?? '', /^[a-f0-9]{64}$/u)
  assert.deepEqual(engine.calls.map(call => [call.firstId, call.secondId]), [['a', 'b']])
  assert.equal(transport.requests.at(-1)?.jpegs.length, 2)
  assert.deepEqual(transport.requests.at(-1)?.jpegs[0], runtime.anchorSheetJpegBase64)
  assert.notEqual(transport.requests.at(-1)?.jpegs[1], aJpeg)
  assert.notEqual(transport.requests.at(-1)?.jpegs[1], bJpeg)
})

test('prepared pair legs are authenticated, immutable and single-use', async () => {
  const transport = new FakeTransport()
  transport.response = anchorPairRaw()
  const client = new AnchorExperimentVisionClient({
    binding: binding('B', transport), profile: profile('B'), transport,
  })
  const prepared = await client.preparePairLeg({
    aId: 'a', aJpegBase64: metadataFreeTestJpeg(2),
    bId: 'b', bJpegBase64: metadataFreeTestJpeg(3),
    order: 'AB', role: 'selector',
  })
  assert.equal(transport.requests.length, 0)
  assert.equal(Object.isFrozen(prepared), true)

  await assert.rejects(
    () => client.invokePreparedPairLeg({ ...prepared }),
    (error: unknown) => error instanceof AnchorExperimentVisionClientError
      && error.code === 'PAIR_LEG_NOT_PREPARED',
  )
  assert.equal(transport.requests.length, 0)

  const record = await client.invokePreparedPairLeg(prepared)
  assert.equal(record.cacheKey, prepared.cacheKey)
  assert.equal(transport.requests.length, 1)
  await assert.rejects(
    () => client.invokePreparedPairLeg(prepared),
    (error: unknown) => error instanceof AnchorExperimentVisionClientError
      && error.code === 'PAIR_LEG_NOT_PREPARED',
  )
  assert.equal(transport.requests.length, 1)
})

test('C rejects tampered render identity before the pairwise provider call', async () => {
  const transport = new FakeTransport()
  const runtime = visualRuntime()
  const engine = new FakePairEngine()
  const client = new AnchorExperimentVisionClient({
    binding: binding('C', transport, runtime), profile: profile('C'), transport,
    visualRuntime: runtime, pairSheetEngine: engine,
  })
  const aJpeg = metadataFreeTestJpeg(2)
  const bJpeg = metadataFreeTestJpeg(3)
  const aHigh = await client.scoreBaseline({ id: 'a', jpegBase64: aJpeg, detail: 'high', role: 'selector' })
  const bHigh = await client.scoreBaseline({ id: 'b', jpegBase64: bJpeg, detail: 'high', role: 'selector' })
  const before = transport.requests.length
  engine.tamperIdentity = true
  await assert.rejects(() => client.comparePairLeg({
    aId: 'a', aJpegBase64: aJpeg, bId: 'b', bJpegBase64: bJpeg,
    order: 'AB', role: 'selector', aHighAssessment: aHigh, bHighAssessment: bHigh,
  }), (error: unknown) => error instanceof AnchorExperimentVisionClientError
    && error.code === 'PAIR_SHEET_RENDER_IDENTITY_MISMATCH')
  assert.equal(transport.requests.length, before)
})
