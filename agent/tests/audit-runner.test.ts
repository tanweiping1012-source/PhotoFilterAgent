import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  runAuditV3,
  type AuditPreviewSource,
  type AuditVisionProvider,
} from '../src/audit-runner.ts'
import type { AnalyzeReport } from '../src/engine.ts'
import type {
  PairwiseRawDecision,
  PortraitBaselineAssessment,
} from '../src/portrait-vision.ts'
import { PORTRAIT_BASELINE_RUBRIC_VERSION, PORTRAIT_DIMENSION_IDS } from '../src/rubric.ts'
import {
  loadState,
  RunState,
  saveState,
  validateProposal,
} from '../src/state.ts'

const SELECTED_ID = 'p000'
const NEAR_ID = 'p001'
const IDS = [
  SELECTED_ID,
  // 19 base scores + 12 frozen promotions consume 31 calls. The first AB
  // pairwise leg consumes call 32, forcing the BA leg to resume after reload.
  ...Array.from({ length: 18 }, (_, index) => `p${String(index + 1).padStart(3, '0')}`),
]

function syntheticReport(fingerprint: string): AnalyzeReport {
  return {
    workdir: '/opaque-synthetic-engine',
    dataset_fingerprint: fingerprint,
    photo_count: IDS.length,
    people_count: IDS.length,
    scenery_count: 0,
    family_count: 0,
    families: [],
    collapsed_by_family: [],
    candidates: IDS.map(id => ({
      id,
      category: 'people',
      sharp: 80,
      range: 75,
      clip: 0,
      risk: [],
      local_top: true,
    })),
  }
}

function assessment(id: string, score: number): PortraitBaselineAssessment {
  return {
    id,
    rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
    eligibility: {
      status: 'eligible',
      failureCodes: [],
      evidence: ['synthetic evidence'],
      assessability: 0.9,
      ambiguousIntent: false,
    },
    dimensionScores: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, score])) as never,
    dimensionConfidences: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, 0.9])) as never,
    dimensionEvidence: Object.fromEntries(
      PORTRAIT_DIMENSION_IDS.map(key => [key, ['synthetic evidence']]),
    ) as never,
    baselineScore: score,
    overallConfidence: 0.9,
    scoreInterval: [score - 2, score + 2],
    observableTags: {
      expression: [],
      gaze: [],
      framing: [],
      lighting: [],
      mood: [],
      scene: [],
      poseAction: [],
    },
    summary: `${id} synthetic audit`,
  }
}

function pairDecision(order: 'AB' | 'BA', challengerWins: boolean): PairwiseRawDecision {
  return {
    order,
    winner: challengerWins ? 'A' : 'B',
    normalizedDeltas: Object.fromEntries(
      PORTRAIT_DIMENSION_IDS.map(key => [key, challengerWins ? 1 : -1]),
    ) as never,
    weightedMargin: challengerWins ? 5 : -5,
    confidence: 0.9,
    reason: challengerWins ? 'synthetic challenger wins' : 'synthetic selected wins',
  }
}

function initialState(fingerprint: string, folder: string): RunState {
  const state = new RunState()
  state.absorb(syntheticReport(fingerprint), folder, undefined, 'people_only')
  state.targets = { people: 1, scenery: 0 }
  state.recordPortrait(assessment(SELECTED_ID, 80), 'high', 'selector-offline')
  state.portraitDraft = {
    keep: [SELECTED_ID],
    why: { [SELECTED_ID]: 'synthetic frozen best' },
    baselineScores: { [SELECTED_ID]: 80 },
    personalizedScores: { [SELECTED_ID]: 80 },
    selectionHash: `selection-${fingerprint}`,
    preference: state.preference,
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
  }
  return state
}

function fakeRuntime(calls: string[], nearScore: number, challengerWins: boolean): {
  engine: AuditPreviewSource
  client: AuditVisionProvider
} {
  return {
    engine: {
      async preview(id, detail) {
        return { jpeg_base64: Buffer.from(`${id}:${detail}`).toString('base64') }
      },
    },
    client: {
      cacheIdentity: {
        endpoint: 'offline://portrait-audit',
        model: 'fake-model',
        selectorBaselinePromptHash: 'selector-prompt',
        auditBaselinePromptHash: 'audit-prompt',
        auditPairwisePromptHash: 'pair-prompt',
      },
      async scoreBaseline(id, _jpeg, detail, _signal, role) {
        assert.equal(role, 'audit')
        calls.push(`score:${detail}:${id}`)
        const score = id === SELECTED_ID ? 80 : id === NEAR_ID ? nearScore : 30
        return assessment(id, score)
      },
      async comparePairLeg(aId, _aJpeg, bId, _bJpeg, order) {
        calls.push(`pair:${order}:${aId}:${bId}`)
        return pairDecision(order, challengerWins)
      },
    },
  }
}

async function exerciseResume(finalStatus: 'PASS' | 'FAIL'): Promise<void> {
  const workdir = await mkdtemp(join(tmpdir(), `photo-filter-offline-${finalStatus.toLowerCase()}-`))
  const folder = `/synthetic-${finalStatus.toLowerCase()}`
  const fingerprint = `offline-${finalStatus.toLowerCase()}`
  const calls: string[] = []
  const runtime = fakeRuntime(calls, finalStatus === 'PASS' ? 79 : 82, finalStatus === 'FAIL')
  try {
    const first = initialState(fingerprint, folder)
    assert.equal(await saveState(first, workdir), true)
    const common = {
      candidateIdentities: first.portraitCandidates().map(candidate => ({ id: candidate.id })),
      frozenSelectedIds: [SELECTED_ID],
      target: 1,
      seed: 'offline-resume-seed',
      selectionHash: `selection-${fingerprint}`,
      auditProviderIdentityKey: 'audit-provider-offline',
      selectorIdentityKey: 'selector-offline',
      selectorPairwiseIdentityKey: 'selector-pairwise-offline',
      inspectConcurrency: 4,
      engine: runtime.engine,
      client: runtime.client,
    }

    const firstOutput = await runAuditV3({
      ...common,
      state: first,
      persist: () => saveState(first, workdir),
    })
    assert.match(firstOutput, /^INCOMPLETE：/u)
    assert.equal(first.portraitAudit?.status, 'INCOMPLETE')
    assert.equal(first.portraitAudit?.stage, 'pairwise')
    assert.equal(first.portraitAudit?.attemptedCallsThisAttempt, 32)
    assert.equal(first.portraitAudit?.remainingCount, 0)
    assert.equal(first.portraitAudit?.pairwiseRemainingCount, 1)
    assert.match(validateProposal(first, [SELECTED_ID]).reason ?? '', /PASS/u)
    const firstAttemptCalls = new Set(calls)
    assert.equal(firstAttemptCalls.size, 32)

    // A new state object models a new evaluator process/session. Only the
    // isolated temporary checkpoint is loaded; no real dataset state is read.
    const resumed = new RunState()
    resumed.absorb(syntheticReport(fingerprint), folder, undefined, 'people_only')
    assert.equal(await loadState(resumed, workdir, folder), true)
    const secondOutput = await runAuditV3({
      ...common,
      state: resumed,
      persist: () => saveState(resumed, workdir),
    })

    assert.match(secondOutput, new RegExp(`^${finalStatus}：`, 'u'))
    assert.equal(resumed.portraitAudit?.status, finalStatus)
    assert.equal(resumed.portraitAudit?.stage, 'complete')
    assert.equal(resumed.portraitAudit?.remainingCount, 0)
    assert.equal(resumed.portraitAudit?.pairwiseRemainingCount, 0)
    assert.equal(resumed.portraitAudit?.lastAttemptPaidCalls, 1)
    assert.equal(resumed.portraitAudit?.pairwiseEvaluatedCount, 2)
    assert.deepEqual(resumed.portraitDraft?.keep, [SELECTED_ID])
    assert.equal(calls.length, new Set(calls).size, 'a successful checkpointed provider operation was repeated')
    assert.ok(calls.slice(32).every(call => !firstAttemptCalls.has(call)))
    assert.equal(calls.filter(call => call.startsWith('pair:')).length, 2)
    assert.equal(resumed.portraitAudit?.paidCalls, calls.length)

    if (finalStatus === 'PASS') {
      assert.equal(resumed.portraitAudit?.nextAction, 'propose')
      assert.equal(resumed.portraitRebuildFeedback, undefined)
      assert.deepEqual(validateProposal(resumed, [SELECTED_ID]), { ok: true })
    } else {
      assert.equal(resumed.portraitAudit?.nextAction, 'rebuild_selection')
      assert.deepEqual(resumed.portraitAudit?.strongerChallengers.map(item => item.id), [NEAR_ID])
      assert.deepEqual(resumed.portraitRebuildFeedback?.strongerChallengerIds, [NEAR_ID])
      assert.equal(resumed.portraitRebuildFeedback?.failedSelectionHash,
        `selection-${fingerprint}`)
      assert.equal(resumed.portraitRebuildFeedback?.selectorIdentityKey, 'selector-offline')
      assert.equal(resumed.portraitRebuildFeedback?.selectorPairwiseIdentityKey,
        'selector-pairwise-offline')
      assert.equal(resumed.portraitRebuildFeedback?.auditProviderIdentityKey,
        'audit-provider-offline')
      assert.match(resumed.portraitRebuildFeedback?.feedbackHash ?? '', /^[a-f0-9]{64}$/u)
      assert.match(validateProposal(resumed, [SELECTED_ID]).reason ?? '', /PASS/u)
    }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

test('offline audit resumes an isolated INCOMPLETE checkpoint to PASS without duplicate provider calls', async () => {
  await exerciseResume('PASS')
})

test('offline audit resumes an isolated INCOMPLETE checkpoint to quality FAIL without duplicate provider calls', async () => {
  await exerciseResume('FAIL')
})

test('provider auth circuit is terminal for the same audit route and repeats zero provider calls', async () => {
  const folder = '/synthetic-circuit'
  const fingerprint = 'offline-circuit'
  const state = initialState(fingerprint, folder)
  let providerCalls = 0
  const runtime = fakeRuntime([], 79, false)
  runtime.client.scoreBaseline = async () => {
    providerCalls += 1
    throw new Error('HTTP 401 unauthorized')
  }
  const input = {
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-circuit-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-circuit',
    selectorIdentityKey: 'selector-circuit',
    selectorPairwiseIdentityKey: 'selector-pairwise-circuit',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  }

  const first = await runAuditV3(input)
  assert.match(first, /^BLOCKED：/u)
  assert.match(first, /audit_status=INCOMPLETE/u)
  assert.match(first, /next_action=fix_model_route/u)
  assert.equal(state.portraitAudit?.status, 'INCOMPLETE')
  assert.equal(state.portraitAudit?.nextAction, 'fix_model_route')
  assert.match(state.portraitAudit?.circuitBreaker ?? '', /401/u)
  assert.ok(providerCalls > 0 && providerCalls <= 4)

  const callsAfterCircuit = providerCalls
  const second = await runAuditV3(input)
  assert.match(second, /^BLOCKED：/u)
  assert.equal(providerCalls, callsAfterCircuit, 'same broken route was probed again')
})
