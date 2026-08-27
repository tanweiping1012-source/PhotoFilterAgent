import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HARNESS_VISION_PROTOCOL,
  HarnessVisionError,
  type HarnessModelRoute,
  type StructuredVisionRequest,
} from '../src/harness-vision.ts'
import {
  PortraitVisionClient,
  combinePairwiseLegs,
  isPortraitVisionCircuitBreakerError,
} from '../src/portrait-vision.ts'

const dimensions = {
  technical_subject_legibility: 80,
  human_moment: 90,
  composition_visual_hierarchy: 70,
  light_color_tone: 60,
  travel_context_story: 50,
  intentionality_finish: 40,
}

const route = (overrides: Partial<HarnessModelRoute> = {}): HarnessModelRoute => ({
  provider: 'volcengine-ark',
  model: 'doubao-seed-2-1-pro-260628',
  protocol: HARNESS_VISION_PROTOCOL,
  ...overrides,
})

function baselinePayload(status: 'eligible' | 'ineligible' | 'needs_review' = 'eligible') {
  const payloadDimensions = status === 'ineligible'
    ? { ...dimensions, technical_subject_legibility: 10 }
    : dimensions
  return {
    eligibility: {
      status,
      failureCodes: status === 'eligible' ? [] : ['HR_CATASTROPHIC_CAPTURE_FAILURE'],
      evidence: ['像素证据'], assessability: 0.9, ambiguousIntent: false,
    },
    dimensionScores: payloadDimensions,
    dimensionConfidences: Object.fromEntries(Object.keys(dimensions).map(key => [key, 0.9])),
    dimensionEvidence: Object.fromEntries(Object.keys(dimensions).map(key => [key, ['可观察证据']])),
    baselineScore: 100,
    preferenceAdjustment: 99,
    userPreference: 'should never survive',
    overallConfidence: 0.88,
    scoreInterval: [65, 82],
    observableTags: {
      expression: ['natural'], gaze: ['camera'], framing: ['half_body'],
      lighting: ['soft'], mood: ['warm'], scene: ['trail'], poseAction: ['walking'],
    },
    summary: '独立基线评价',
  }
}

function fakeTransport(
  payloads: Array<Record<string, unknown>>,
  requests: StructuredVisionRequest[] = [],
  selectedRoute = route(),
) {
  let index = 0
  return {
    route: selectedRoute,
    async invokeStructured(request: StructuredVisionRequest) {
      requests.push(request)
      const value = payloads[index++]
      if (!value) throw new Error('fake transport exhausted')
      return value
    },
  }
}

test('recomputes baseline locally and keeps id preference and parent context out of the isolated request', async () => {
  const requests: StructuredVisionRequest[] = []
  const client = new PortraitVisionClient({ transport: fakeTransport([baselinePayload()], requests) as never })
  const result = await client.scoreBaseline('private-name.jpg', 'ZmFrZQ==', 'low')

  assert.equal(result.baselineScore, 68.4)
  assert.equal('preferenceAdjustment' in result, false)
  assert.equal('userPreference' in result, false)
  const outbound = JSON.stringify(requests[0])
  assert.equal(outbound.includes('private-name.jpg'), false)
  assert.equal(outbound.includes('userPreference'), false)
  assert.equal(outbound.includes('selector ranking'), false)
  assert.deepEqual(requests[0]?.jpegs, ['ZmFrZQ=='])
  assert.equal(requests[0]?.tool.name, 'submit_portrait_baseline')
  assert.equal(requests[0]?.maxTokens, 4_000)
})

test('returns null baseline for an ineligible portrait', async () => {
  const client = new PortraitVisionClient({ transport: fakeTransport([baselinePayload('ineligible')]) as never })
  const result = await client.scoreBaseline('x', 'eA==', 'high')
  assert.equal(result.eligibility.status, 'ineligible')
  assert.equal(result.baselineScore, null)
})

test('rejects eligibility failures that contradict confident positive visual evidence', async () => {
  const payload = baselinePayload('needs_review')
  payload.eligibility.failureCodes = [
    'HR_UNASSESSABLE_ASSET',
    'HR_NO_INTENTIONAL_HUMAN_SUBJECT',
    'HR_PRIMARY_SUBJECT_UNINTERPRETABLE',
    'HR_CATASTROPHIC_CAPTURE_FAILURE',
  ]
  payload.eligibility.assessability = 0.96
  payload.dimensionScores = { ...dimensions, technical_subject_legibility: 82, human_moment: 68 }

  const client = new PortraitVisionClient({ transport: fakeTransport([payload]) as never })
  await assert.rejects(
    () => client.scoreBaseline('x', 'eA==', 'high', undefined, 'audit'),
    /不一致|冲突|assessability/u,
  )
})

test('requires stable A/B decision after reversing image order', async () => {
  const requests: StructuredVisionRequest[] = []
  const positive = {
    winner: 'FIRST', confidence: 0.9, reason: 'FIRST 人物瞬间更完整',
    dimensionDeltas: Object.fromEntries(Object.keys(dimensions).map(key => [key, 1])),
  }
  const reversed = {
    winner: 'SECOND', confidence: 0.8, reason: 'SECOND 人物瞬间更完整',
    dimensionDeltas: Object.fromEntries(Object.keys(dimensions).map(key => [key, -1])),
  }
  const client = new PortraitVisionClient({ transport: fakeTransport([positive, reversed], requests) as never })
  const result = await client.comparePair('A-id', 'YQ==', 'B-id', 'Yg==')
  assert.equal(result.winner, 'A-id')
  assert.equal(result.margin, 5)
  assert.equal(result.confidence, 0.85)
  assert.deepEqual(result.rawDecisions.map(item => item.order), ['AB', 'BA'])
  assert.deepEqual(requests.map(request => request.maxTokens), [2_400, 2_400])
})

test('returns TIE when swapped judgments disagree', async () => {
  const firstWins = {
    winner: 'FIRST', confidence: 0.95, reason: 'FIRST 更好',
    dimensionDeltas: Object.fromEntries(Object.keys(dimensions).map(key => [key, 2])),
  }
  const client = new PortraitVisionClient({ transport: fakeTransport([firstWins, { ...firstWins }]) as never })
  const result = await client.comparePair('A', 'YQ==', 'B', 'Yg==')
  assert.equal(result.winner, 'TIE')
})

test('cache identity binds provider model protocol reasoning and prompt hashes', () => {
  const identity = (selectedRoute: HarnessModelRoute) => new PortraitVisionClient({
    transport: fakeTransport([], [], selectedRoute) as never,
  }).cacheIdentity
  const first = identity(route())
  assert.deepEqual(first, identity(route()))
  assert.notDeepEqual(first, identity(route({ provider: 'another-provider' })))
  assert.notDeepEqual(first, identity(route({ model: 'another-model' })))
  assert.notDeepEqual(first, identity(route({ reasoningEffort: 'high' })))
  assert.equal(JSON.stringify(first).includes('secret'), false)
  assert.match(first.routeIdentity, /volcengine-ark/u)
  assert.match(first.auditBaselinePromptHash, /^[a-f0-9]{64}$/u)
  assert.match(first.auditPairwisePromptHash, /^[a-f0-9]{64}$/u)
})

test('provider-neutral quota auth and unsupported-content failures open the circuit breaker', async () => {
  for (const failure of [
    new HarnessVisionError('limited', { status: 429, code: 'RATE_LIMIT' }),
    new HarnessVisionError('missing key', { code: 'MISSING_CREDENTIAL' }),
    new HarnessVisionError('image rejected', { code: 'UNSUPPORTED_CONTENT' }),
  ]) {
    const transport = { route: route(), async invokeStructured() { throw failure } }
    const client = new PortraitVisionClient({ transport: transport as never })
    await assert.rejects(
      () => client.scoreBaseline('x', 'eA==', 'low', undefined, 'audit'),
      error => isPortraitVisionCircuitBreakerError(error),
    )
  }
})

test('directional legs can be aggregated after independent checkpointing', async () => {
  const positive = {
    winner: 'FIRST', confidence: 0.9, reason: 'FIRST 更好',
    dimensionDeltas: Object.fromEntries(Object.keys(dimensions).map(key => [key, 1])),
  }
  const reversed = {
    winner: 'SECOND', confidence: 0.9, reason: 'SECOND 更好',
    dimensionDeltas: Object.fromEntries(Object.keys(dimensions).map(key => [key, -1])),
  }
  const client = new PortraitVisionClient({ transport: fakeTransport([positive, reversed]) as never })
  const ab = await client.comparePairLeg('A', 'YQ==', 'B', 'Yg==', 'AB')
  const ba = await client.comparePairLeg('A', 'YQ==', 'B', 'Yg==', 'BA')
  const result = combinePairwiseLegs('A', 'B', ab, ba)

  assert.equal(ab.order, 'AB')
  assert.equal(ba.order, 'BA')
  assert.equal(result.winner, 'A')
})
