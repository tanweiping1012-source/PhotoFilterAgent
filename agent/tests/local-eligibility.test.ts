import assert from 'node:assert/strict'
import test from 'node:test'

import type { Candidate } from '../src/engine.ts'
import {
  LOCAL_PORTRAIT_GATE_VERSION,
  localPortraitEligibility,
} from '../src/local-eligibility.ts'
import { rankPortraits } from '../src/ranking.ts'

function candidate(id: string, eyesClosed = false): Candidate {
  return {
    id,
    category: 'people',
    sharp: 80,
    range: 80,
    clip: 0,
    risk: [],
    local_top: true,
    eyes_closed: eyesClosed || undefined,
  }
}

test('local portrait gate is versioned and rejects only a positive closed-eye fact', () => {
  assert.match(LOCAL_PORTRAIT_GATE_VERSION, /^local-portrait-gate-v\d+$/u)
  assert.deepEqual(localPortraitEligibility(candidate('open')), {
    eligible: true,
    failureCodes: [],
  })
  assert.deepEqual(localPortraitEligibility(candidate('closed', true)), {
    eligible: false,
    failureCodes: ['LOCAL_EYES_CLOSED'],
  })
})

test('closed eyes cannot enter Top-K even when the visual model score is 99', () => {
  const source = [candidate('closed', true), candidate('open')]
  const rankingCandidates = source.map((item, index) => ({
    id: item.id,
    score: index === 0 ? 99 : 70,
    eligibility: localPortraitEligibility(item).eligible ? 'eligible' as const : 'ineligible' as const,
  }))
  assert.deepEqual(rankPortraits(rankingCandidates, { topK: 1 }).map(item => item.id), ['open'])
  assert.throws(() => rankPortraits(rankingCandidates, { topK: 2 }), /only 1 eligible/u)
})

test('production build and isolated audit use the same local portrait universe', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8'))
  assert.match(source, /const people = locallyEligiblePortraitCandidates\(state\)/u)
  assert.match(source, /const candidateIdentities = locallyEligiblePortraitCandidates\(state\)/u)
  assert.match(source, /selectorPairwiseIdentityKey[\s\S]*LOCAL_PORTRAIT_GATE_VERSION/u)
})
