import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { rankPortraits, type RankingCandidate } from '../src/ranking.ts'
import {
  MAX_PAIRWISE_PAIRS,
  highRefinementContextKey,
  planHighRefinement,
  planPairwiseBudget,
  plannedPairwiseLegs,
  runAfterDurableCheckpoint,
} from '../src/selection-budget.ts'

test('failed prerequisite checkpoint prevents every paid-stage call', async () => {
  let providerCalls = 0
  const result = await runAfterDurableCheckpoint(
    async () => false,
    async () => {
      providerCalls += 1
      return 'paid result'
    },
  )

  assert.deepEqual(result, { ok: false })
  assert.equal(providerCalls, 0)
})

test('frozen pair plans expand into stable independently resumable AB/BA legs', () => {
  const plan = {
    pairs: [
      { leftId: 'p001', rightId: 'p002', source: 'family' as const },
      { leftId: 'p003', rightId: 'p004', source: 'cutline' as const },
    ],
    auditPairCount: 0,
    familyPairCount: 1,
    cutlinePairCount: 1,
    pairCap: 24,
    bidirectionalCallCap: 48,
  }

  assert.deepEqual(plannedPairwiseLegs(plan).map(leg =>
    `${leg.leftId}/${leg.rightId}/${leg.order}`), [
    'p001/p002/AB',
    'p001/p002/BA',
    'p003/p004/AB',
    'p003/p004/BA',
  ])
})

test('build selection gates high on durability and refuses to freeze an incomplete pair plan', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("name: 'build_selection'")
  const end = source.indexOf("name: 'audit_selection'", start)
  const buildSource = source.slice(start, end)
  const durableGate = buildSource.indexOf('runAfterDurableCheckpoint(')
  const highStage = buildSource.indexOf('() => scoreSelectorIds(', durableGate)
  const incompleteGate = buildSource.indexOf('if (remainingPairwiseLegs.length)')
  const repeatedFailedHashGate = buildSource.indexOf(
    'selectionHash === rebuildFeedback.failedSelectionHash',
  )
  const draftFreeze = buildSource.indexOf('state.portraitDraft = {')

  assert.ok(durableGate >= 0 && highStage > durableGate)
  assert.ok(incompleteGate >= 0 && draftFreeze > incompleteGate)
  assert.ok(repeatedFailedHashGate > incompleteGate && draftFreeze > repeatedFailedHashGate)
  assert.match(buildSource, /最佳人像必须比较完整目录；当前 analyze_folder 使用了 limit/u)
  assert.match(buildSource, /next_action=retry_build_selection；在后续新 turn 使用同一冻结计划只补 remaining legs/u)
  assert.match(buildSource, /next_action=fix_model_route；禁止在当前 turn 自动重试 build_selection 或 status/u)
  assert.match(buildSource, /portraitSelectorPairwiseCheckpoint/u)
  assert.match(buildSource, /next_action=fix_rebuild_loop/u)
})

test('refinement checkpoint identity binds dataset, scope, target, preference, and rubric/model', () => {
  const baseline = {
    datasetFingerprint: 'dataset-a',
    candidateScope: 'people_only',
    target: 20,
    preferenceFingerprint: '{"isBaseline":true}',
    rubricModelKey: 'rubric-model-a',
  }
  const key = highRefinementContextKey(baseline)
  assert.equal(highRefinementContextKey({ ...baseline }), key)
  assert.notEqual(highRefinementContextKey({ ...baseline, datasetFingerprint: 'dataset-b' }), key)
  assert.notEqual(highRefinementContextKey({ ...baseline, candidateScope: 'auto' }), key)
  assert.notEqual(highRefinementContextKey({ ...baseline, target: 21 }), key)
  assert.notEqual(highRefinementContextKey({ ...baseline, preferenceFingerprint: '{"joyful":1}' }), key)
  assert.notEqual(highRefinementContextKey({ ...baseline, rubricModelKey: 'rubric-model-b' }), key)
  assert.notEqual(highRefinementContextKey({
    ...baseline,
    auditFeedbackFingerprint: 'audit-fail-a',
  }), key)
})

test('K=20 with 289 eligible photos and one huge family never plans more than 60 high reviews', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 289 }, (_, index) => ({
    id: `portrait-${String(index + 1).padStart(3, '0')}`,
    score: 100 - index / 10,
    familyId: index < 250 ? 'huge-family' : `single-${index}`,
    eligibility: 'eligible',
  }))

  const plan = planHighRefinement(candidates, 20)

  assert.equal(plan.eligibleCount, 289)
  assert.equal(plan.hardCap, 60)
  assert.equal(plan.baseCount, 40)
  assert.equal(plan.familyChallengersPerFamily, 2)
  assert.equal(plan.familyChallengerAddedCount, 2)
  assert.equal(plan.candidateIds.length, 60)
  assert.equal(new Set(plan.candidateIds).size, 60)
  assert.ok(plan.candidateIds.every(id => candidates.some(candidate => candidate.id === id)))
})

test('family challengers get reserved slots but cannot bypass the global high cap', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 100 }, (_, index) => ({
    id: `p${String(index + 1).padStart(3, '0')}`,
    score: 100 - index / 10,
    familyId: index % 5 === 0 ? `leader-${index % 3}` : `tail-${index}`,
    eligibility: 'eligible',
  }))

  const plan = planHighRefinement(candidates, 20)

  assert.equal(plan.candidateIds.length, plan.hardCap)
  assert.equal(plan.hardCap, 60)
  assert.ok(plan.familyChallengerAddedCount <= plan.leadingFamilyCount * 2)
})

test('audit FAIL challengers are forced into high review without increasing the hard cap', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 100 }, (_, index) => ({
    id: `p${String(index + 1).padStart(3, '0')}`,
    score: 100 - index,
    familyId: `family-${index}`,
    eligibility: index === 99 ? 'needs_review' : 'eligible',
  }))

  const plan = planHighRefinement(candidates, 20, {
    forcedCandidateIds: ['p095', 'p100', 'p095'],
  })

  assert.equal(plan.hardCap, 60)
  assert.equal(plan.candidateIds.length, 60)
  assert.equal(plan.auditForcedCount, 2)
  assert.deepEqual(plan.candidateIds.slice(0, 2), ['p095', 'p100'])
  assert.equal(new Set(plan.candidateIds).size, 60)
})

test('pairwise planner reports a strict pair and bidirectional-call ceiling', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 80 }, (_, index) => ({
    id: `p${String(index + 1).padStart(3, '0')}`,
    score: 90 - index / 20,
    familyId: `family-${Math.floor(index / 2)}`,
    eligibility: 'eligible',
  }))
  const preliminary = rankPortraits(candidates, { topK: 20, diversityStrength: 1 })

  const plan = planPairwiseBudget(candidates, preliminary, [], 20)

  assert.ok(plan.pairs.length <= MAX_PAIRWISE_PAIRS)
  assert.equal(plan.pairCap, MAX_PAIRWISE_PAIRS)
  assert.equal(plan.bidirectionalCallCap, MAX_PAIRWISE_PAIRS * 2)
  assert.equal(new Set(plan.pairs.map(pair =>
    [pair.leftId, pair.rightId].sort().join('|'))).size, plan.pairs.length)
})

test('audit challengers reserve pairwise slots first while preserving the global pair cap', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 80 }, (_, index) => ({
    id: `p${String(index + 1).padStart(3, '0')}`,
    score: 100 - index / 10,
    familyId: `family-${index}`,
    eligibility: index === 79 ? 'needs_review' : 'eligible',
  }))
  const preliminary = rankPortraits(candidates, { topK: 20 })
  const forced = ['p061', 'p062', 'p080']

  const plan = planPairwiseBudget(candidates, preliminary, [], 20, 2, forced)

  assert.equal(plan.pairs.length, 2)
  assert.equal(plan.auditPairCount, 2)
  assert.ok(plan.pairs.every(pair => pair.source === 'audit'))
  assert.deepEqual(plan.pairs.map(pair => pair.leftId), ['p061', 'p062'])
  assert.ok(plan.pairs.every(pair => preliminary.some(selected => selected.id === pair.rightId)))
})
