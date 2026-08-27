import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fitBradleyTerryScores,
  portraitRankPolicy,
  rankPortraits,
  resolveFamilyCap,
  sampleStratifiedChallengers,
  type RankingCandidate,
} from '../src/ranking.ts'
import { createPreferenceProfile } from '../src/preferences.ts'

test('preference profile drives diversity and near-duplicate retention policy', () => {
  assert.deepEqual(portraitRankPolicy(createPreferenceProfile({})), {
    diversityStrength: 1,
    familyCap: 'auto',
  })
  assert.deepEqual(portraitRankPolicy(createPreferenceProfile({
    diversity: 0,
    seriesRetention: 'one_per_family',
  })), {
    diversityStrength: 0,
    familyCap: 1,
  })
  assert.deepEqual(portraitRankPolicy(createPreferenceProfile({
    diversity: 0.4,
    seriesRetention: 'allow_series',
  })), {
    diversityStrength: 0.4,
    familyCap: 'unlimited',
  })
})

test('pairwise evidence can separate close absolute scores deterministically', () => {
  const candidates = [
    { id: 'a', score: 80, eligibility: 'eligible' as const },
    { id: 'b', score: 79, eligibility: 'eligible' as const },
  ]
  const comparisons = [
    { leftId: 'b', rightId: 'a', leftOutcome: 1, weight: 4 },
  ]
  const first = fitBradleyTerryScores(candidates, comparisons)
  const second = fitBradleyTerryScores(candidates, comparisons)
  assert.deepEqual(first, second)
  assert.ok(first.b > first.a)
})

test('family de-duplication keeps one member when distinct families can satisfy exact K', () => {
  const selected = rankPortraits([
    { id: 'burst-a', score: 99, familyId: 'burst-1', eligibility: 'eligible' },
    { id: 'burst-b', score: 98, familyId: 'burst-1', eligibility: 'eligible' },
    { id: 'other', score: 97, familyId: 'single-2', eligibility: 'eligible' },
    { id: 'third', score: 96, eligibility: 'eligible' },
  ], { topK: 3, diversityStrength: 1 })

  assert.equal(selected.length, 3)
  assert.deepEqual(selected.map(item => item.id), ['burst-a', 'other', 'third'])
  assert.equal(selected.filter(item => item.familyId === 'burst-1').length, 1)
})

test('auto cap is the smallest uniform family cap that still permits exact K', () => {
  const candidates: RankingCandidate[] = [
    { id: 'a1', score: 99, familyId: 'a', eligibility: 'eligible' },
    { id: 'a2', score: 96, familyId: 'a', eligibility: 'eligible' },
    { id: 'a3', score: 95, familyId: 'a', eligibility: 'eligible' },
    { id: 'b1', score: 98, familyId: 'b', eligibility: 'eligible' },
    { id: 'b2', score: 94, familyId: 'b', eligibility: 'eligible' },
    { id: 'c1', score: 70, familyId: 'c', eligibility: 'eligible' },
  ]
  assert.equal(resolveFamilyCap(candidates, 5), 2)

  const selected = rankPortraits([
    ...candidates,
  ], { topK: 5, diversityStrength: 1 })

  assert.equal(selected.length, 5)
  assert.deepEqual(selected.map(item => item.id), ['a1', 'b1', 'a2', 'b2', 'c1'])
  const counts = selected.reduce<Record<string, number>>((result, item) => {
    result[item.familyId!] = (result[item.familyId!] ?? 0) + 1
    return result
  }, {})
  assert.deepEqual(counts, { a: 2, b: 2, c: 1 })
})

test('289 eligible photos in 13 families produce exact K=20 with at most two per family', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 289 }, (_, index) => ({
    id: `portrait-${String(index + 1).padStart(3, '0')}`,
    score: 100 - (index % 80),
    familyId: `family-${String((index % 13) + 1).padStart(2, '0')}`,
    eligibility: 'eligible',
    diversityTags: [`pose:${index % 5}`, `light:${index % 3}`],
  }))

  const selected = rankPortraits(candidates, { topK: 20, diversityStrength: 1 })

  assert.equal(resolveFamilyCap(candidates, 20), 2)
  assert.equal(selected.length, 20)
  assert.equal(new Set(selected.map(item => item.id)).size, 20)
  assert.ok(selected.every(item => item.diversityBonus >= 0 && item.diversityBonus <= 4))
  const familyCounts = selected.reduce<Record<string, number>>((counts, item) => {
    counts[item.familyId!] = (counts[item.familyId!] ?? 0) + 1
    return counts
  }, {})
  assert.ok(Math.max(...Object.values(familyCounts)) <= 2)
})

test('extremely few families raise auto cap only as far as exact K requires', () => {
  const candidates: RankingCandidate[] = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `a${index + 1}`,
      score: 100 - index,
      familyId: 'a',
      eligibility: 'eligible' as const,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `b${index + 1}`,
      score: 90 - index,
      familyId: 'b',
      eligibility: 'eligible' as const,
    })),
  ]
  assert.equal(resolveFamilyCap(candidates, 7), 4)
  const selected = rankPortraits(candidates, { topK: 7 })
  assert.equal(selected.length, 7)
  const countA = selected.filter(item => item.familyId === 'a').length
  const countB = selected.filter(item => item.familyId === 'b').length
  assert.ok(countA <= 4 && countB <= 4)
  assert.equal(countA + countB, 7)
})

test('explicit positive and unlimited family policies support deliberate series selection', () => {
  const candidates: RankingCandidate[] = [
    { id: 'a1', score: 100, familyId: 'a', eligibility: 'eligible' },
    { id: 'a2', score: 99, familyId: 'a', eligibility: 'eligible' },
    { id: 'a3', score: 98, familyId: 'a', eligibility: 'eligible' },
    { id: 'b1', score: 70, familyId: 'b', eligibility: 'eligible' },
    { id: 'c1', score: 60, familyId: 'c', eligibility: 'eligible' },
  ]
  assert.deepEqual(
    rankPortraits(candidates, { topK: 3, familyCap: 1 }).map(item => item.id),
    ['a1', 'b1', 'c1'],
  )
  assert.deepEqual(
    rankPortraits(candidates, { topK: 3, familyCap: 'unlimited' }).map(item => item.id),
    ['a1', 'a2', 'a3'],
  )
  assert.throws(() => rankPortraits(candidates, { topK: 4, familyCap: 1 }), /capacity is 3/)
})

test('semantic novelty cannot displace a photo more than four points better', () => {
  const selected = rankPortraits([
    { id: 'best', score: 99, familyId: 'a', diversityTags: ['warm'], eligibility: 'eligible' },
    { id: 'next-best', score: 98, familyId: 'b', diversityTags: ['warm'], eligibility: 'eligible' },
    { id: 'novel-too-low', score: 93, familyId: 'c', diversityTags: ['cool'], eligibility: 'eligible' },
  ], { topK: 2, diversityStrength: 1, familyCap: 'unlimited' })

  assert.deepEqual(selected.map(item => item.id), ['best', 'next-best'])
  assert.ok(selected.every(item => item.diversityBonus <= 4))
})

test('exact K fails only when there are fewer eligible photos than K', () => {
  assert.throws(() => rankPortraits([
    { id: 'a', score: 90, familyId: 'same', eligibility: 'eligible' },
    { id: 'b', score: 80, familyId: 'same', eligibility: 'needs_review' },
  ], { topK: 2 }), /only 1 eligible photos/)
})

test('near-duplicate cap is independent from bounded semantic MMR bonus', () => {
  const selected = rankPortraits([
    { id: 'first', score: 90, familyId: 'f1', diversityTags: ['close_up', 'warm'], eligibility: 'eligible' },
    { id: 'duplicate', score: 89.9, familyId: 'f1', diversityTags: ['environmental', 'cool'], eligibility: 'eligible' },
    { id: 'similar', score: 89, familyId: 'f2', diversityTags: ['close_up', 'warm'], eligibility: 'eligible' },
    { id: 'diverse', score: 88, familyId: 'f3', diversityTags: ['environmental', 'cool'], eligibility: 'eligible' },
    { id: 'too-low', score: 80, familyId: 'f4', diversityTags: ['night', 'silhouette'], eligibility: 'eligible' },
  ], { topK: 2, diversityStrength: 1 })

  assert.deepEqual(selected.map(item => item.id), ['first', 'diverse'])
  assert.ok(selected[1].diversityBonus <= 4)
  assert.equal(selected.some(item => item.id === 'duplicate'), false)
  assert.equal(selected.some(item => item.id === 'too-low'), false)

  const explicitSeries = rankPortraits([
    { id: 'series-1', score: 90, familyId: 'series', diversityTags: ['close_up'], eligibility: 'eligible' },
    { id: 'series-2', score: 89, familyId: 'series', diversityTags: ['close_up'], eligibility: 'eligible' },
  ], { topK: 2, diversityStrength: 1, familyCap: 'unlimited' })
  assert.equal(explicitSeries[1].diversityBonus, 0)
})

test('fixed-seed stratified challengers are reproducible, unique, and exclude selections', () => {
  const candidates: RankingCandidate[] = Array.from({ length: 15 }, (_, index) => ({
    id: `p${String(index + 1).padStart(2, '0')}`,
    score: 100 - index,
    eligibility: 'eligible',
  }))
  const options = { sampleSize: 6, seed: 'audit-v1', strata: 3 }
  const first = sampleStratifiedChallengers(candidates, ['p01', 'p02'], options)
  const second = sampleStratifiedChallengers(candidates, ['p01', 'p02'], options)

  assert.deepEqual(first.map(item => item.id), second.map(item => item.id))
  assert.equal(new Set(first.map(item => item.id)).size, 6)
  assert.equal(first.some(item => item.id === 'p01' || item.id === 'p02'), false)
  // Round-robin sampling guarantees representation from high, middle, and low strata.
  assert.ok(first.some(item => item.score >= 95))
  assert.ok(first.some(item => item.score < 95 && item.score >= 91))
  assert.ok(first.some(item => item.score < 91))
})
