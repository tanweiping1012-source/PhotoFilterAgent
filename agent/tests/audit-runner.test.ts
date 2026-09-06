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
  auditScoreCacheKey,
} from '../src/audit-v3.ts'
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

function needsReviewAssessment(id: string): PortraitBaselineAssessment {
  const result = assessment(id, 50)
  return {
    ...result,
    eligibility: {
      status: 'needs_review',
      failureCodes: ['HR_PRIMARY_SUBJECT_UNINTERPRETABLE'],
      evidence: ['synthetic ambiguous primary subject'],
      assessability: 0.8,
      ambiguousIntent: true,
    },
    baselineScore: null,
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

function fakeRuntime(
  calls: string[],
  nearScore: number,
  challengerWins: boolean,
  selectedEligible = true,
  allRemainingScore?: number,
): {
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
        if (id === SELECTED_ID && !selectedEligible) return needsReviewAssessment(id)
        const score = id === SELECTED_ID
          ? 80
          : allRemainingScore ?? (id === NEAR_ID ? nearScore : 30)
        return assessment(id, score)
      },
      async comparePairLeg(aId, _aJpeg, bId, _bJpeg, order) {
        calls.push(`pair:${order}:${aId}:${bId}`)
        return pairDecision(order, challengerWins)
      },
    },
  }
}

async function exerciseResume(
  finalStatus: 'PASS' | 'FAIL',
  simulateLegacyCheckpoint = false,
): Promise<void> {
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
    assert.equal(first.portraitAudit?.attemptedCalls, 32)
    assert.equal(first.portraitAudit?.succeededCalls, 32)
    assert.equal(first.portraitAudit?.failedCalls, 0)
    assert.equal(first.portraitAudit?.unresolvedCalls, 0)
    assert.equal(first.portraitAudit?.uniqueCachedAssets, 32)
    assert.equal(first.portraitAudit?.accountingBasis, 'exact')
    assert.equal(first.portraitAudit?.attemptNumber, 1)
    assert.equal(first.portraitAudit?.progressDelta, 32)
    assert.equal(first.portraitAudit?.stalledRounds, 0)
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
    if (simulateLegacyCheckpoint && resumed.portraitAudit) {
      delete resumed.portraitAudit.attemptedCalls
      delete resumed.portraitAudit.succeededCalls
      delete resumed.portraitAudit.failedCalls
      delete resumed.portraitAudit.unresolvedCalls
      delete resumed.portraitAudit.uniqueCachedAssets
      delete resumed.portraitAudit.accountingBasis
      resumed.portraitAudit.cachedCalls = 999
    }
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
    assert.equal(resumed.portraitAudit?.lastAttemptSucceededCalls, 1)
    assert.equal(resumed.portraitAudit?.lastAttemptFailedCalls, 0)
    assert.equal(resumed.portraitAudit?.lastAttemptCachedCalls, 32)
    assert.equal(resumed.portraitAudit?.attemptedCalls, 33)
    assert.equal(resumed.portraitAudit?.succeededCalls, 33)
    assert.equal(resumed.portraitAudit?.failedCalls, 0)
    assert.equal(resumed.portraitAudit?.unresolvedCalls, 0)
    assert.equal(resumed.portraitAudit?.uniqueCachedAssets, 33)
    assert.equal(resumed.portraitAudit?.cachedCalls, 33)
    assert.equal(
      resumed.portraitAudit?.accountingBasis,
      simulateLegacyCheckpoint ? 'legacy_success_lower_bound' : 'exact',
    )
    assert.equal(resumed.portraitAudit?.pairwiseEvaluatedCount, 2)
    assert.equal(resumed.portraitAudit?.attemptNumber, 2)
    assert.equal(resumed.portraitAudit?.progressDelta, 1)
    assert.equal(resumed.portraitAudit?.stalledRounds, 0)
    assert.deepEqual(resumed.portraitDraft?.keep, [SELECTED_ID])
    assert.equal(calls.length, new Set(calls).size, 'a successful checkpointed provider operation was repeated')
    assert.ok(calls.slice(32).every(call => !firstAttemptCalls.has(call)))
    assert.equal(calls.filter(call => call.startsWith('pair:')).length, 2)
    assert.equal(resumed.portraitAudit?.paidCalls, calls.length)

    const callsBeforeTerminalReplay = calls.length
    const terminalOutput = await runAuditV3({
      ...common,
      state: resumed,
      persist: () => saveState(resumed, workdir),
    })
    assert.match(terminalOutput, new RegExp(`^${finalStatus}：`, 'u'))
    assert.equal(calls.length, callsBeforeTerminalReplay,
      'a terminal audit context scheduled another provider operation')
    assert.equal(resumed.portraitAudit?.attemptNumber, 2)

    if (finalStatus === 'PASS') {
      assert.equal(resumed.portraitAudit?.nextAction, 'propose')
      assert.equal(resumed.portraitRebuildFeedback, undefined)
      assert.deepEqual(validateProposal(resumed, [SELECTED_ID]), { ok: true })
    } else {
      assert.equal(resumed.portraitAudit?.nextAction, 'rebuild_selection')
      assert.deepEqual(
        resumed.portraitAudit?.strongerChallengers.map(item => item.id),
        [NEAR_ID],
      )
      assert.deepEqual(
        resumed.portraitRebuildFeedback?.disqualifiedSelectedIds,
        [],
      )
      assert.deepEqual(
        resumed.portraitRebuildFeedback?.strongerChallengerIds,
        [NEAR_ID],
      )
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

test('offline audit feeds an ineligible selected ID back as an anonymous hard exclusion', async () => {
  const folder = '/synthetic-ineligible-selection'
  const fingerprint = 'offline-ineligible-selection'
  const state = initialState(fingerprint, folder)
  const runtime = fakeRuntime([], 79, false, false)

  const output = await runAuditV3({
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-ineligible-selection-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  })

  assert.match(output, /^FAIL：/u)
  assert.deepEqual(state.portraitAudit?.strongerChallengers, [])
  assert.deepEqual(state.portraitRebuildFeedback?.disqualifiedSelectedIds, [SELECTED_ID])
  assert.deepEqual(state.portraitRebuildFeedback?.strongerChallengerIds, [])
  assert.equal(state.portraitRebuildFeedback?.schemaVersion, 'portrait-rebuild-feedback-v2')
})

test('completed FAIL bounds anonymous rebuild feedback to the strongest 12 challenger IDs', async () => {
  const folder = '/synthetic-bounded-feedback'
  const fingerprint = 'offline-bounded-feedback'
  const state = initialState(fingerprint, folder)
  const runtime = fakeRuntime([], 90, true, true, 90)
  const input = {
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-bounded-feedback-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  }

  assert.match(await runAuditV3(input), /^INCOMPLETE：/u)
  assert.match(await runAuditV3(input), /^FAIL：/u)
  assert.equal(state.portraitAudit?.strongerChallengers.length, IDS.length - 1)
  assert.equal(state.portraitRebuildFeedback?.strongerChallengerIds.length, 12)
})

test('later audit FAIL preserves previously consumed hard exclusions until PASS', async () => {
  const folder = '/synthetic-cumulative-exclusion'
  const fingerprint = 'offline-cumulative-exclusion'
  const state = initialState(fingerprint, folder)
  state.portraitRebuildFeedback = {
    schemaVersion: 'portrait-rebuild-feedback-v2',
    datasetFingerprint: fingerprint,
    failedSelectionHash: 'older-failed-selection',
    selectedIds: ['p002'],
    disqualifiedSelectedIds: ['p002'],
    strongerChallengerIds: [],
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
    auditProviderIdentityKey: 'audit-provider-offline',
    feedbackHash: 'older-feedback',
    consumedBySelectionHash: `selection-${fingerprint}`,
  }
  const runtime = fakeRuntime([], 82, true)
  const input = {
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-cumulative-exclusion-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  }

  assert.match(await runAuditV3(input), /^INCOMPLETE：/u)
  assert.match(await runAuditV3(input), /^FAIL：/u)
  assert.deepEqual(state.portraitRebuildFeedback?.disqualifiedSelectedIds, ['p002'])
  assert.deepEqual(state.portraitRebuildFeedback?.strongerChallengerIds, [NEAR_ID])
  assert.equal(state.portraitRebuildFeedback?.consumedBySelectionHash, undefined)
})

test('later FAIL recovers a durable selector-high versus audit-high eligibility disagreement', async () => {
  const folder = '/synthetic-durable-audit-exclusion'
  const fingerprint = 'offline-durable-audit-exclusion'
  const state = initialState(fingerprint, folder)
  const durableId = 'p002'
  const runtime = fakeRuntime([], 82, true)
  state.recordPortrait(assessment(durableId, 78), 'high', 'selector-offline')
  state.recordPortraitAudit(
    needsReviewAssessment(durableId),
    'high',
    auditScoreCacheKey({
      datasetFingerprint: fingerprint,
      id: durableId,
      detail: 'high',
      provider: runtime.client.cacheIdentity,
    }),
  )
  const input = {
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-durable-audit-exclusion-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-offline',
    selectorPairwiseIdentityKey: 'selector-pairwise-offline',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  }

  assert.match(await runAuditV3(input), /^INCOMPLETE：/u)
  assert.match(await runAuditV3(input), /^FAIL：/u)
  assert.deepEqual(state.portraitRebuildFeedback?.disqualifiedSelectedIds, [durableId])
})

test('legacy audit accounting resumes as an explicit lower bound without inflating unique cache assets', async () => {
  await exerciseResume('PASS', true)
})

test('provider auth circuit is terminal for the same audit route and repeats zero provider calls', async () => {
  const folder = '/synthetic-circuit'
  const fingerprint = 'offline-circuit'
  const state = initialState(fingerprint, folder)
  let providerCalls = 0
  const runtime = fakeRuntime([], 79, false)
  runtime.client.scoreBaseline = async () => {
    providerCalls += 1
    assert.equal(state.portraitAudit?.attemptedCalls, 1,
      'attempt was not checkpointed before provider dispatch')
    assert.equal(state.portraitAudit?.unresolvedCalls, 1,
      'in-flight provider outcome was not represented durably')
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
  assert.equal(providerCalls, 1)
  assert.equal(state.portraitAudit?.attemptedCalls, 1)
  assert.equal(state.portraitAudit?.succeededCalls, 0)
  assert.equal(state.portraitAudit?.failedCalls, 1)
  assert.equal(state.portraitAudit?.unresolvedCalls, 0)
  assert.equal(state.portraitAudit?.uniqueCachedAssets, 0)
  assert.equal(state.portraitAudit?.accountingBasis, 'exact')
  assert.deepEqual(state.portraitAudit?.failureStats?.[`score:high:${SELECTED_ID}`], {
    attempts: 1,
    consecutiveSameCode: 1,
    lastCode: 'Error',
    lastStatus: undefined,
    lastMessage: 'HTTP 401 unauthorized',
  })

  const callsAfterCircuit = providerCalls
  const second = await runAuditV3(input)
  assert.match(second, /^BLOCKED：/u)
  assert.equal(providerCalls, callsAfterCircuit, 'same broken route was probed again')
})

test('local preview failure stays outside the provider attempt ledger', async () => {
  const folder = '/synthetic-preview-failure'
  const fingerprint = 'offline-preview-failure'
  const state = initialState(fingerprint, folder)
  let providerCalls = 0
  const runtime = fakeRuntime([], 79, false)
  let previewCalls = 0
  runtime.engine.preview = async () => {
    previewCalls += 1
    throw new Error('synthetic local preview failure')
  }
  runtime.client.scoreBaseline = async () => {
    providerCalls += 1
    return assessment(SELECTED_ID, 79)
  }

  const output = await runAuditV3({
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-preview-failure-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-preview-failure',
    selectorIdentityKey: 'selector-preview-failure',
    selectorPairwiseIdentityKey: 'selector-pairwise-preview-failure',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  })

  assert.match(output, /^INCOMPLETE：/u)
  assert.match(output, /本地预览未完成/u)
  assert.equal(providerCalls, 0)
  assert.equal(state.portraitAudit?.attemptedCalls, 0)
  assert.equal(state.portraitAudit?.succeededCalls, 0)
  assert.equal(state.portraitAudit?.failedCalls, 0)
  assert.equal(state.portraitAudit?.unresolvedCalls, 0)
  assert.equal(state.portraitAudit?.attemptNumber, 1)
  assert.equal(state.portraitAudit?.stalledRounds, 1)
  assert.deepEqual(state.portraitAudit?.failureStats, {})

  const second = await runAuditV3({
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-preview-failure-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-preview-failure',
    selectorPairwiseIdentityKey: 'selector-pairwise-preview-failure',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  })
  assert.match(second, /^INCOMPLETE：/u)
  assert.match(second, /next_action=diagnose_stall/u)
  assert.equal(state.portraitAudit?.attemptNumber, 2)
  assert.equal(state.portraitAudit?.stalledRounds, 2)
  const callsBeforeStallReplay = previewCalls
  const third = await runAuditV3({
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-preview-failure-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-offline',
    selectorIdentityKey: 'selector-preview-failure',
    selectorPairwiseIdentityKey: 'selector-pairwise-preview-failure',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  })
  assert.match(third, /next_action=diagnose_stall/u)
  assert.equal(previewCalls, callsBeforeStallReplay)
})

test('audit report preserves failures across provider batches', async () => {
  const folder = '/synthetic-batch-failures'
  const fingerprint = 'offline-batch-failures'
  const state = initialState(fingerprint, folder)
  const runtime = fakeRuntime([], 79, false)
  runtime.client.scoreBaseline = async id => {
    if (id === SELECTED_ID) return assessment(id, 80)
    throw new Error(`synthetic invalid assessment ${id}`)
  }

  const output = await runAuditV3({
    state,
    candidateIdentities: state.portraitCandidates().map(candidate => ({ id: candidate.id })),
    frozenSelectedIds: [SELECTED_ID],
    target: 1,
    seed: 'offline-batch-failures-seed',
    selectionHash: `selection-${fingerprint}`,
    auditProviderIdentityKey: 'audit-provider-batch-failures',
    selectorIdentityKey: 'selector-batch-failures',
    selectorPairwiseIdentityKey: 'selector-pairwise-batch-failures',
    inspectConcurrency: 4,
    engine: runtime.engine,
    client: runtime.client,
    persist: async () => true,
  })

  assert.equal(state.portraitAudit?.attemptedCalls, IDS.length)
  assert.equal(state.portraitAudit?.succeededCalls, 1)
  assert.equal(state.portraitAudit?.failedCalls, IDS.length - 1)
  assert.equal(output.match(/评分未完成 p\d{3}：synthetic invalid assessment p\d{3}/gu)?.length, 16,
    'report kept only the final provider batch instead of the bounded cross-batch failure history')
})
