import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AUDIT_CHECKPOINT_BATCH_SIZE,
  AUDIT_MAX_PAIRWISE_LEGS,
  AUDIT_MAX_PAIRWISE_PAIRS,
  AUDIT_MAX_PROMOTION_HIGH,
  AUDIT_PROVIDER_CALL_BUDGET,
  auditPairwiseLegCacheKey,
  auditScoreCacheKey,
  auditV3ContextKey,
  evaluateAuditQuality,
  planAuditPairs,
  planAuditPromotions,
  planAuditUniverse,
} from '../src/audit-v3.ts'
import { PORTRAIT_BASELINE_RUBRIC_VERSION, PORTRAIT_DIMENSION_IDS } from '../src/rubric.ts'
import { HARNESS_VISION_PROTOCOL } from '../src/harness-vision.ts'
import {
  portraitVisionCacheIdentity,
  type PortraitBaselineAssessment,
  type PortraitVisionCacheIdentity,
} from '../src/portrait-vision.ts'

function providerFor(overrides: { provider?: string; model?: string; reasoningEffort?: string } = {}): PortraitVisionCacheIdentity {
  return portraitVisionCacheIdentity({
    provider: overrides.provider ?? 'provider-a',
    model: overrides.model ?? 'model-a',
    protocol: HARNESS_VISION_PROTOCOL,
    ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
  })
}
const provider = providerFor()

function assessment(
  id: string,
  score: number | null,
  status: 'eligible' | 'ineligible' | 'needs_review' = score === null ? 'needs_review' : 'eligible',
  interval: [number, number] = score === null ? [0, 100] : [score - 2, score + 2],
): PortraitBaselineAssessment {
  const numeric = score ?? 0
  return {
    id,
    rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
    eligibility: { status, failureCodes: [], evidence: [], assessability: 0.9, ambiguousIntent: false },
    dimensionScores: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, numeric])) as never,
    dimensionConfidences: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, 0.9])) as never,
    dimensionEvidence: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, ['visible']])) as never,
    baselineScore: score,
    overallConfidence: 0.9,
    scoreInterval: interval,
    observableTags: { expression: [], gaze: [], framing: [], lighting: [], mood: [], scene: [], poseAction: [] },
    summary: `${id} audit-only`,
  }
}

test('audit v3 universe and fixed-seed random sample ignore selector-like fields', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    id: `p${String(index + 1).padStart(2, '0')}`,
    family: `f${index % 5}`,
    selectorScore: index * 100,
    preferenceAdjustment: 4,
  }))
  const changedSelectorData = candidates.map(candidate => ({
    ...candidate,
    selectorScore: 100_000 - candidate.selectorScore,
    preferenceAdjustment: -4,
  }))
  const first = planAuditUniverse(candidates, ['p01', 'p02', 'p03'], 3, 'fixed-seed')
  const second = planAuditUniverse(changedSelectorData, ['p01', 'p02', 'p03'], 3, 'fixed-seed')

  assert.deepEqual(first, second)
  assert.equal(first.selectedHighIds.length, 3)
  assert.equal(first.remainingLowIds.length, 37)
  assert.equal(first.randomCount, 12)
  assert.equal(new Set(first.randomChallengerIds).size, 12)
})

test('audit cache identities bind role dataset id detail prompt and full Harness route', () => {
  const base = { datasetFingerprint: 'dataset-a', id: 'p01', detail: 'low' as const, provider }
  const key = auditScoreCacheKey(base)
  assert.notEqual(key, auditScoreCacheKey({ ...base, datasetFingerprint: 'dataset-b' }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, id: 'p02' }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, detail: 'high' }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, provider: providerFor({ model: 'model-b' }) }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, provider: providerFor({ provider: 'provider-b' }) }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, provider: providerFor({ reasoningEffort: 'high' }) }))
  assert.notEqual(key, auditScoreCacheKey({ ...base, provider: { ...provider, auditBaselinePromptHash: 'changed' } }))

  const ab = auditPairwiseLegCacheKey({
    datasetFingerprint: 'dataset-a', challengerId: 'p02', selectedId: 'p01', order: 'AB', provider,
  })
  const ba = auditPairwiseLegCacheKey({
    datasetFingerprint: 'dataset-a', challengerId: 'p02', selectedId: 'p01', order: 'BA', provider,
  })
  assert.notEqual(ab, ba)
  assert.notEqual(auditV3ContextKey({
    datasetFingerprint: 'dataset-a', candidateScope: 'people_only', selectedIds: ['p01'], target: 1, seed: 'a', provider,
  }), auditV3ContextKey({
    datasetFingerprint: 'dataset-a', candidateScope: 'people_only', selectedIds: ['p01'], target: 1, seed: 'b', provider,
  }))
})

test('Stage C promotes audit cutline overlap needs-review family leaders and fixed random sample', () => {
  const candidates = [
    { id: 's1', family: 'family-a' },
    { id: 's2', family: 'family-b' },
    { id: 'a1', family: 'family-a' },
    { id: 'a2', family: 'family-a' },
    { id: 'a3', family: 'family-a' },
    { id: 'near' },
    { id: 'overlap' },
    { id: 'review' },
    ...Array.from({ length: 14 }, (_, index) => ({ id: `r${index}` })),
  ]
  const universe = planAuditUniverse(candidates, ['s1', 's2'], 2, 'promotion-seed')
  const scores = new Map<string, PortraitBaselineAssessment>([
    ['s1', assessment('s1', 80, 'eligible', [77, 83])],
    ['s2', assessment('s2', 78, 'eligible', [75, 81])],
    ['a1', assessment('a1', 60)],
    ['a2', assessment('a2', 59)],
    ['a3', assessment('a3', 58)],
    ['near', assessment('near', 75)],
    ['overlap', assessment('overlap', 70, 'eligible', [76, 79])],
    ['review', assessment('review', null, 'needs_review')],
    ...Array.from({ length: 14 }, (_, index) => [`r${index}`, assessment(`r${index}`, 30 + index)] as const),
  ])
  const plan = planAuditPromotions(candidates, universe, scores)

  assert.ok(plan.cutlineChallengerIds.includes('near'))
  assert.ok(plan.cutlineChallengerIds.includes('overlap'))
  assert.ok(plan.cutlineChallengerIds.includes('review'))
  assert.deepEqual(plan.familyChallengerIds, ['a1', 'a2'])
  assert.ok(universe.randomChallengerIds.every(id => plan.promotionIds.includes(id)))
})

test('Stage C stays bounded when broad low-detail intervals overlap the cutline', () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, family: `f${index % 10}` })),
    ...Array.from({ length: 280 }, (_, index) => ({ id: `c${index}`, family: `f${index % 10}` })),
  ]
  const selectedIds = candidates.slice(0, 20).map(candidate => candidate.id)
  const universe = planAuditUniverse(candidates, selectedIds, 20, 'broad-interval-seed')
  const scores = new Map<string, PortraitBaselineAssessment>([
    ...selectedIds.map((id, index) => [id, assessment(id, 60 + index, 'eligible', [55, 85])] as const),
    ...candidates.slice(20).map((candidate, index) => [
      candidate.id,
      assessment(candidate.id, 50 + (index % 30), 'eligible', [45, 90]),
    ] as const),
  ])

  const plan = planAuditPromotions(candidates, universe, scores)

  assert.ok(plan.promotionIds.length <= AUDIT_MAX_PROMOTION_HIGH)
  assert.ok(universe.randomChallengerIds.every(id => plan.promotionIds.includes(id)))
  assert.ok(plan.cutlineChallengerIds.length <= 20)
  assert.ok(plan.familyChallengerIds.length <= 20)
})

test('Stage D caps at 8 pairs/16 legs and same-family challengers compare within family', () => {
  const candidates = [
    { id: 's-family', family: 'f1' },
    { id: 's-global', family: 'f2' },
    { id: 'c-family', family: 'f1' },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, family: `x${index}` })),
  ]
  const scores = new Map<string, PortraitBaselineAssessment>([
    ['s-family', assessment('s-family', 82)],
    ['s-global', assessment('s-global', 78)],
    ['c-family', assessment('c-family', 84)],
    ...Array.from({ length: 12 }, (_, index) => [`c${index}`, assessment(`c${index}`, 90 - index)] as const),
  ])
  const pairs = planAuditPairs(
    candidates,
    ['s-family', 's-global'],
    ['c-family', ...Array.from({ length: 12 }, (_, index) => `c${index}`)],
    scores,
  )

  assert.equal(pairs.length, AUDIT_MAX_PAIRWISE_PAIRS)
  assert.equal(AUDIT_MAX_PAIRWISE_LEGS, 16)
  assert.equal(pairs.find(pair => pair.challengerId === 'c-family')?.selectedId, 's-family')
})

test('quality FAIL evidence is computed only after complete audit assets', () => {
  const scores = new Map([
    ['s', assessment('s', 80)],
    ['weak', assessment('weak', 70)],
    ['strong', assessment('strong', 86)],
  ])
  const quality = evaluateAuditQuality(['s'], ['weak', 'strong'], scores, new Map())
  assert.equal(quality.weakestSelectedScore, 80)
  assert.deepEqual(quality.strongerChallengers.map(item => item.id), ['strong'])
})

test('audit tool source has a hard per-call budget and no selector-state reads', async () => {
  assert.equal(AUDIT_PROVIDER_CALL_BUDGET, 32)
  assert.equal(AUDIT_CHECKPOINT_BATCH_SIZE, 1)
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const runnerSource = await readFile(new URL('../src/audit-runner.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'audit_selection'")
  const end = source.indexOf("name: 'inspect'", start)
  const auditSource = source.slice(start, end)
  assert.doesNotMatch(runnerSource, /portraitScores|portraitRankingCandidates|portraitComparisons|\.preference|\.why|baselineScores|personalizedScores/u)
  assert.match(runnerSource, /AUDIT_PROVIDER_CALL_BUDGET/u)
  assert.match(auditSource, /await runAuditV3\(/u)
  assert.match(
    auditSource,
    /engine\.analyze\(\s*requestedFolder,\s*undefined,\s*exec\.signal,\s*excludedRelativePaths,\s*\)/u,
  )
  assert.match(auditSource, /frozenSelectedIds\.length !== target/u)
  assert.doesNotMatch(auditSource, /target !== state\.targets\.people/u)
  assert.match(auditSource, /尚未调用视觉模型/u)
})

test('invalid corrected audit scores invalidate only their downstream frozen plans', async () => {
  const source = await readFile(new URL('../src/audit-runner.ts', import.meta.url), 'utf8')
  assert.match(source, /const upstreamPlanInputsComplete/u)
  assert.match(source, /previousReport\?\.promotionIds\s*\n\s*&& upstreamPlanInputsComplete/u)
  assert.match(source, /const promotionPlanInputsComplete/u)
  assert.match(source, /let pairPlans:[\s\S]*promotionPlanInputsComplete/u)
})

test('each independent evaluator child can invoke audit_selection at most once', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'audit_selection'")
  const end = source.indexOf("name: 'propose'", start)
  const auditSource = source.slice(start, end)
  assert.match(auditSource, /auditInvokedAgents\.has\(exec\.agent!\)/u)
  assert.match(auditSource, /auditInvokedAgents\.add\(exec\.agent!\)/u)
  assert.ok(auditSource.indexOf('auditInvokedAgents.add(exec.agent!)') < auditSource.indexOf('engineFor(requestedFolder)'))
  assert.match(auditSource, /本次 provider 调用为 0/u)
})

test('evaluate_pool is low-only and exposes concrete retry errors instead of enabling full-pool high', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'evaluate_pool'")
  const end = source.indexOf("name: 'build_selection'", start)
  const evaluateSource = source.slice(start, end)
  assert.match(evaluateSource, /args\.detail !== 'low'/u)
  assert.match(evaluateSource, /item\.message/u)
  assert.match(evaluateSource, /禁止改用 high/u)
  assert.match(evaluateSource, /本次 provider 请求/u)
  const scorerStart = source.indexOf('async function scoreSelectorIds')
  const scorerEnd = source.indexOf('function renderSelectionBudget', scorerStart)
  const scorerSource = source.slice(scorerStart, scorerEnd)
  assert.ok(
    scorerSource.indexOf('portraitScoreAttempted += 1')
      < scorerSource.indexOf('client.scoreBaseline'),
  )
})

test('selector pairwise persists attempted cost before each routed model call', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'build_selection'")
  const end = source.indexOf("name: 'audit_selection'", start)
  const buildSource = source.slice(start, end)
  assert.ok(
    buildSource.indexOf('portraitPairwiseAttempted += 1')
      < buildSource.indexOf('client.comparePairLeg'),
  )
  assert.match(buildSource, /本轮 provider 请求/u)
})
