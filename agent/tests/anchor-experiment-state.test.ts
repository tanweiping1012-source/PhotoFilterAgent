import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  AnchorExperimentState,
  AnchorExperimentStateError,
  anchorExperimentPairwiseLegCacheKey,
  anchorExperimentScoreCacheKey,
  anchorExperimentSelectionHash,
  anchorExperimentStateFile,
  loadAnchorExperimentState,
  normalizeAnchorRubricExperimentAssessment,
  reserveAndPersistAnchorExperimentProviderOperation,
  saveAnchorExperimentState,
  type AnchorExperimentDerivedAuthority,
  type AnchorExperimentRunBinding,
  type ExperimentAssessment,
  type ExperimentPairwiseLegRecord,
} from '../src/anchor-experiment-state.ts'
import type { PortraitAnchorAssessment } from '../src/portrait-anchor-rubric.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function binding(arm: 'A' | 'B' | 'C', route = 'model-1'): AnchorExperimentRunBinding {
  const manifestHash = hash(`manifest:${arm}`)
  const routeIdentityHash = hash(['provider', route, 'protocol', ''].join('\u0000'))
  const base = {
    schemaVersion: 'photo-filter-anchor-experiment-binding/v1' as const,
    experimentId: 'experiment-1',
    arm,
    manifestHash,
    sourceSnapshotHash: hash('source'),
    datasetFingerprint: hash('dataset'),
    candidateScope: 'people_only' as const,
    targetK: 2,
    seed: 'seed-1',
    preferenceHash: hash('preference'),
    route: Object.freeze({ provider: 'provider', model: route, protocol: 'protocol' }),
    routeIdentityHash,
    profileProtocol: 'profile-v1',
    rubricVersion: arm === 'A' ? 'legacy' : 'anchor',
    rubricContentHash: hash(`rubric:${arm}`),
    contracts: Object.freeze({
      selectorLow: hash(`${arm}:selector:low`),
      selectorHigh: hash(`${arm}:selector:high`),
      selectorPairwise: hash(`${arm}:selector:pair`),
      auditLow: hash(`${arm}:audit:low`),
      auditHigh: hash(`${arm}:audit:high`),
      auditPairwise: hash(`${arm}:audit:pair`),
    }),
    budget: Object.freeze({
      highCap: 2,
      pairwisePairCap: 2,
      auditCallCapPerTurn: 2,
      maxCompleteAuditRounds: 2,
    }),
    ...(arm === 'C' ? { visual: Object.freeze({
      anchorPackHash: hash('pack'), anchorSheetSha256: hash('sheet'),
      layoutProtocolHash: hash('layout'), qualityReceiptHash: hash('receipt'),
      legendHash: hash('legend'),
    }) } : {}),
  }
  return Object.freeze({
    ...base,
    stateNamespaceHash: hash([
      'photo-filter-anchor-experiment-binding/v1', 'experiment-1', arm,
      manifestHash, base.routeIdentityHash, base.datasetFingerprint,
    ].join('\u0000')),
  })
}

function anchorAssessment(id: string, high: boolean): PortraitAnchorAssessment {
  return {
    id,
    rubricVersion: 'portrait-baseline-anchor-v0.1',
    hardGate: { triggered: false, code: null, confidence: 0.95, evidence: [] },
    absoluteTier: 'keep',
    contentRejectCodes: [],
    uncertaintyCodes: [],
    dimensionScores: {
      expression_eye_naturalness: 80,
      facial_features_shape: 78,
      pose_keepworthy_moment: 75,
      technical_completion: 82,
      environment_frame: 70,
    },
    dimensionEvidence: {
      expression_eye_naturalness: ['自然'], facial_features_shape: ['流畅'],
      pose_keepworthy_moment: ['姿态成立'], technical_completion: ['清晰'], environment_frame: ['完整'],
    },
    sortableScore: 78.05,
    overallConfidence: 0.9,
    summary: '可保留',
    ...(high ? { primarySubjectHeadFocus: { center_x: 0.5, center_y: 0.3, side_fraction: 0.2 } } : {}),
  } as PortraitAnchorAssessment
}

function anchorPairRecord(
  active: AnchorExperimentRunBinding,
  overrides: Partial<ExperimentPairwiseLegRecord> = {},
): ExperimentPairwiseLegRecord {
  const aId = overrides.aId ?? 'p001'
  const bId = overrides.bId ?? 'p002'
  const order = overrides.order ?? 'AB'
  const role = overrides.role ?? 'selector'
  const raw = {
    order,
    leftTier: 'keep' as const,
    rightTier: 'keep' as const,
    result: 'left' as const,
    strength: 'slight' as const,
    normalizedDimensionDeltas: {
      expression_eye_naturalness: 2,
      facial_features_shape: 1,
      pose_keepworthy_moment: 0,
      technical_completion: 0,
      environment_frame: 0,
    },
    weightedMargin: 4.75,
    confidence: 0.9,
    reason: 'A 更好',
  }
  const decision = {
    contract: 'portrait-anchor-pairwise/v1' as const,
    order,
    result: 'left' as const,
    weightedMargin: 4.75,
    confidence: 0.9,
    reason: 'A 更好',
    raw,
  }
  return {
    aId,
    bId,
    role,
    order,
    decision,
    cacheKey: anchorExperimentPairwiseLegCacheKey({
      binding: active, role, aId, bId, order,
      pairCandidateReceiptHash: overrides.pairCandidateReceiptHash,
    }),
    ...overrides,
  }
}

function attachSelectorPlanning(state: AnchorExperimentState): AnchorExperimentDerivedAuthority {
  const refinement = Object.freeze({
    contextKey: hash('refinement-context'),
    plan: Object.freeze({
      target: 2,
      eligibleCount: 2,
      hardCap: 2,
      baseCount: 2,
      leadingWindowCount: 2,
      leadingFamilyCount: 0,
      familyChallengersPerFamily: 0,
      auditForcedCount: 0,
      familyChallengerAddedCount: 0,
      globalFillCount: 0,
      candidateIds: Object.freeze(['p001', 'p002']),
    }),
  })
  const pairwise = Object.freeze({
    contextKey: hash('pairwise-context'),
    plan: Object.freeze({
      pairs: Object.freeze([
        Object.freeze({ leftId: 'p001', rightId: 'p002', source: 'cutline' as const }),
      ]),
      auditPairCount: 0,
      familyPairCount: 0,
      cutlinePairCount: 1,
      pairCap: 1,
      bidirectionalCallCap: 2,
    }),
  })
  state.refinementCheckpoint = refinement
  state.pairwiseCheckpoint = pairwise
  return Object.freeze({
    expectedPersistedPhase: 'pairwise' as const,
    recomputeRefinementCheckpoint: () => refinement,
    recomputePairwiseCheckpoint: () => pairwise,
    recomputeDraft: () => undefined,
    recomputeAudit: () => undefined,
  })
}

function attachAuditProgress(state: AnchorExperimentState): AnchorExperimentDerivedAuthority {
  const planning = attachSelectorPlanning(state)
  const scores = Object.freeze({ p001: 80, p002: 79 })
  const keep = Object.freeze(['p001', 'p002'])
  const draft = Object.freeze({
    bindingHash: state.binding.stateNamespaceHash,
    keep,
    scores,
    selectionHash: anchorExperimentSelectionHash({ binding: state.binding, keep, scores }),
  })
  const audit = Object.freeze({
    schemaVersion: 'photo-filter-anchor-audit/v1' as const,
    round: 1,
    bindingHash: state.binding.stateNamespaceHash,
    selectionHash: draft.selectionHash,
    status: 'INCOMPLETE' as const,
    stage: 'selected_high' as const,
    selectedIds: keep,
    remainingCount: 2,
    pairwiseRemainingCount: 1,
    strongerChallengerIds: Object.freeze([]),
    disqualifiedSelectedIds: Object.freeze([]),
  })
  state.draft = draft
  state.audit = audit
  return Object.freeze({
    ...planning,
    expectedPersistedPhase: 'audit' as const,
    expectedAuditRound: 1,
    recomputeDraft: () => draft,
    recomputeAudit: () => audit,
  })
}

function recordSuccessfulScore(
  state: AnchorExperimentState,
  assessment: ExperimentAssessment,
): void {
  const cacheKey = anchorExperimentScoreCacheKey({
    binding: state.binding,
    role: assessment.role,
    id: assessment.id,
    detail: assessment.detail,
  })
  assert.equal(state.reserveProviderOperation({
    cacheKey, role: assessment.role, kind: 'score', detail: assessment.detail,
    candidateId: assessment.id,
  }), 'dispatch')
  state.recordScore(assessment)
  state.markProviderOperationSucceeded(cacheKey)
}

function recordSuccessfulPair(
  state: AnchorExperimentState,
  record: ExperimentPairwiseLegRecord,
): void {
  assert.equal(state.reserveProviderOperation({
    cacheKey: record.cacheKey, role: record.role, kind: 'pairwise',
    aId: record.aId, bId: record.bId, order: record.order,
    pairCandidateReceiptHash: record.pairCandidateReceiptHash,
  }), 'dispatch')
  state.recordPairwiseLeg(record)
  state.markProviderOperationSucceeded(record.cacheKey)
}

test('arm, manifest and route produce distinct state files and score keys', () => {
  const b = binding('B')
  const c = binding('C')
  const bChangedRoute = binding('B', 'model-2')
  assert.notEqual(anchorExperimentStateFile('/tmp/x', '/photos', undefined, b),
    anchorExperimentStateFile('/tmp/x', '/photos', undefined, c))
  assert.notEqual(anchorExperimentScoreCacheKey({ binding: b, role: 'selector', id: 'p001', detail: 'low' }),
    anchorExperimentScoreCacheKey({ binding: c, role: 'selector', id: 'p001', detail: 'low' }))
  assert.notEqual(anchorExperimentScoreCacheKey({ binding: b, role: 'selector', id: 'p001', detail: 'low' }),
    anchorExperimentScoreCacheKey({ binding: bChangedRoute, role: 'selector', id: 'p001', detail: 'low' }))
})

test('low and high coexist, and high focus is mandatory without fabricating legacy fields', () => {
  const state = new AnchorExperimentState(binding('B'), ['p001', 'p002'])
  const low = normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
  })
  const high = normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', true) as never, role: 'selector', detail: 'high',
  })
  state.recordScore(low)
  state.recordScore(high)
  assert.equal(state.cachedScore('selector', 'p001', 'low')?.detail, 'low')
  assert.equal(state.cachedScore('selector', 'p001', 'high')?.detail, 'high')
  assert.equal(state.bestScore('selector', 'p001')?.detail, 'high')
  assert.equal('baselineScore' in high, false)
  assert.throws(() => normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p002', false), role: 'selector', detail: 'high',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'HIGH_FOCUS_REQUIRED')
})

test('live score recording validates the local normalization instead of trusting callers', () => {
  const state = new AnchorExperimentState(binding('B'), ['p001', 'p002'])
  const forged = {
    ...normalizeAnchorRubricExperimentAssessment({
      assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
    }),
    score: 999,
  }
  assert.throws(() => state.recordScore(forged), (error: unknown) =>
    error instanceof AnchorExperimentStateError && error.code === 'PERSISTED_SCORE_TAMPERED')
})

test('C pairwise key requires the exact dynamic receipt while B forbids it', () => {
  assert.throws(() => anchorExperimentPairwiseLegCacheKey({
    binding: binding('C'), role: 'selector', aId: 'p001', bId: 'p002', order: 'AB',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PAIR_RECEIPT_REQUIRED')
  assert.throws(() => anchorExperimentPairwiseLegCacheKey({
    binding: binding('B'), role: 'selector', aId: 'p001', bId: 'p002', order: 'AB',
    pairCandidateReceiptHash: hash('receipt'),
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PAIR_RECEIPT_NOT_ALLOWED')
})

test('pairwise identity keeps stable A/B semantics and cannot collide after argument reversal', () => {
  const active = binding('B')
  assert.notEqual(
    anchorExperimentPairwiseLegCacheKey({
      binding: active, role: 'selector', aId: 'p001', bId: 'p002', order: 'AB',
    }),
    anchorExperimentPairwiseLegCacheKey({
      binding: active, role: 'selector', aId: 'p002', bId: 'p001', order: 'AB',
    }),
  )
})

test('pairwise recording recomputes direction and deep-freezes nested decisions', () => {
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const contradictory = anchorPairRecord(active)
  ;(contradictory.decision as { result: string }).result = 'right'
  ;(contradictory.decision.raw as { result: string }).result = 'right'
  assert.throws(() => state.recordPairwiseLeg(contradictory), (error: unknown) =>
    error instanceof AnchorExperimentStateError
      && error.code === 'PAIRWISE_DECISION_DIRECTION_INVALID')

  const valid = anchorPairRecord(active)
  state.recordPairwiseLeg(valid)
  ;(valid.decision as { result: string }).result = 'right'
  ;(valid.decision.raw as { result: string }).result = 'right'
  assert.equal(state.cachedPairwiseLeg('selector', valid.cacheKey)?.decision.result, 'left')
})

test('legacy pairwise also recomputes margin and winner from six frozen dimensions', () => {
  const active = binding('A')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const raw = {
    order: 'AB' as const,
    winner: 'A' as const,
    normalizedDeltas: {
      technical_subject_legibility: -1,
      human_moment: -1,
      composition_visual_hierarchy: -1,
      light_color_tone: -1,
      travel_context_story: -1,
      intentionality_finish: -1,
    },
    weightedMargin: -5,
    confidence: 0.9,
    reason: 'forged winner',
  }
  const cacheKey = anchorExperimentPairwiseLegCacheKey({
    binding: active, role: 'selector', aId: 'p001', bId: 'p002', order: 'AB',
  })
  assert.throws(() => state.recordPairwiseLeg({
    aId: 'p001', bId: 'p002', role: 'selector', order: 'AB', cacheKey,
    decision: {
      contract: 'legacy-portrait-pairwise/v1', order: 'AB', result: 'left',
      weightedMargin: -5, confidence: 0.9, reason: 'forged winner', raw,
    },
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PAIRWISE_DECISION_DIRECTION_INVALID')
})

test('state persists atomically and refuses a tampered binding', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  recordSuccessfulScore(state, normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
  }))
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const restored = await loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  })
  assert.equal(restored?.cachedScore('selector', 'p001', 'low')?.id, 'p001')

  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.binding.route.model = 'tampered'
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_EXPERIMENT_BINDING_MISMATCH')
})

test('corrupt state blocks resume instead of silently buying every request again', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-corrupt-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  await writeFile(path, '{not-json')
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_EXPERIMENT_STATE_CORRUPT')
})

test('tampered scores and pairwise legs fail closed during restore', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-tamper-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  recordSuccessfulScore(state, normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
  }))
  recordSuccessfulPair(state, anchorPairRecord(active))
  const authority = attachSelectorPlanning(state)
  assert.equal(await saveAnchorExperimentState({
    state, workdir, folder: '/photos', authority,
  }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const scorePayload = JSON.parse(await readFile(path, 'utf8'))
  scorePayload.selectorScores[0][1].assessment.score = 999
  await writeFile(path, JSON.stringify(scorePayload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_SCORE_TAMPERED')

  assert.equal(await saveAnchorExperimentState({
    state, workdir, folder: '/photos', authority,
  }), true)
  const legPayload = JSON.parse(await readFile(path, 'utf8'))
  legPayload.selectorPairwiseLegs[0][1].decision.order = 'BA'
  await writeFile(path, JSON.stringify(legPayload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PAIRWISE_LEG_INVALID')
})

test('identity mismatches are corruption, never silent paid-cache misses', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-identity-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  recordSuccessfulScore(state, normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
  }))
  recordSuccessfulPair(state, anchorPairRecord(active))
  const authority = attachSelectorPlanning(state)
  assert.equal(await saveAnchorExperimentState({
    state, workdir, folder: '/photos', authority,
  }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const scorePayload = JSON.parse(await readFile(path, 'utf8'))
  scorePayload.selectorScores[0][1].cacheKey = hash('wrong-score-key')
  await writeFile(path, JSON.stringify(scorePayload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_SCORE_IDENTITY_MISMATCH')

  assert.equal(await saveAnchorExperimentState({
    state, workdir, folder: '/photos', authority,
  }), true)
  const legPayload = JSON.parse(await readFile(path, 'utf8'))
  legPayload.selectorPairwiseLegs[0][0] = hash('wrong-leg-key')
  await writeFile(path, JSON.stringify(legPayload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_PAIRWISE_IDENTITY_MISMATCH')
})

test('forged checkpoints, draft, audit PASS and paid counters fail closed', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-p0-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const scores = { p001: 80, p002: 79 }
  const keep = ['p001', 'p002']
  const validDraft = {
    bindingHash: active.stateNamespaceHash,
    keep,
    scores,
    selectionHash: anchorExperimentSelectionHash({ binding: active, keep, scores }),
  }
  const cases: Array<{
    code: string
    mutate(payload: Record<string, unknown>): void
  }> = [
    {
      code: 'PERSISTED_REFINEMENT_CHECKPOINT_INVALID',
      mutate(payload) {
        payload.refinementCheckpoint = {
          contextKey: 'not-a-hash',
          plan: { target: 999, eligibleCount: 999, hardCap: 999, baseCount: 0,
            leadingWindowCount: 0, leadingFamilyCount: 0, familyChallengersPerFamily: 0,
            auditForcedCount: 0, familyChallengerAddedCount: 0, globalFillCount: 0,
            candidateIds: ['outside'] },
        }
      },
    },
    {
      code: 'PERSISTED_PAIRWISE_CHECKPOINT_INVALID',
      mutate(payload) {
        payload.pairwiseCheckpoint = {
          contextKey: hash('pair-context'),
          plan: { pairs: [], auditPairCount: 0, familyPairCount: 0, cutlinePairCount: 0,
            pairCap: 2, bidirectionalCallCap: 999 },
        }
      },
    },
    {
      code: 'PERSISTED_DRAFT_INVALID',
      mutate(payload) {
        payload.draft = { bindingHash: active.stateNamespaceHash, keep: [], scores: {},
          selectionHash: hash('forged') }
      },
    },
    {
      code: 'PERSISTED_AUDIT_INVALID',
      mutate(payload) {
        payload.draft = validDraft
        payload.audit = {
          schemaVersion: 'photo-filter-anchor-audit/v1',
          round: 1,
          bindingHash: active.stateNamespaceHash,
          selectionHash: validDraft.selectionHash,
          status: 'PASS', stage: 'complete', selectedIds: keep,
          remainingCount: -5, pairwiseRemainingCount: 0,
          strongerChallengerIds: ['outside'], disqualifiedSelectedIds: [],
        }
      },
    },
    {
      code: 'PERSISTED_PAID_CALLS_INVALID',
      mutate(payload) {
        const paid = payload.paidCalls as Record<string, number>
        paid.selectorScoreAttempted = -4
      },
    },
  ]
  for (const item of cases) {
    assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
    const payload = JSON.parse(await readFile(path, 'utf8'))
    item.mutate(payload)
    await writeFile(path, JSON.stringify(payload))
    await assert.rejects(() => loadAnchorExperimentState({
      binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
    }), (error: unknown) => error instanceof AnchorExperimentStateError
      && error.code === item.code)
  }
})

test('self-consistent draft and PASS still require recomputation from current evidence', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-authority-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const planningState = new AnchorExperimentState(active, ['p001', 'p002'])
  const planningAuthority = attachSelectorPlanning(planningState)
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const payload = JSON.parse(await readFile(path, 'utf8'))
  const keep = ['p001', 'p002']
  const scores = { p001: 80, p002: 79 }
  const draft = {
    bindingHash: active.stateNamespaceHash,
    keep,
    scores,
    selectionHash: anchorExperimentSelectionHash({ binding: active, keep, scores }),
  }
  payload.draft = draft
  payload.refinementCheckpoint = planningState.refinementCheckpoint
  payload.pairwiseCheckpoint = planningState.pairwiseCheckpoint
  payload.audit = {
    schemaVersion: 'photo-filter-anchor-audit/v1',
    round: 1,
    bindingHash: active.stateNamespaceHash,
    selectionHash: draft.selectionHash,
    status: 'PASS', stage: 'complete', selectedIds: keep,
    remainingCount: 0, pairwiseRemainingCount: 0,
    strongerChallengerIds: [], disqualifiedSelectedIds: [],
  }
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_DERIVED_AUTHORITY_REQUIRED')
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active,
    candidateIds: ['p001', 'p002'],
    workdir,
    folder: '/photos',
    authority: {
      ...planningAuthority,
      expectedPersistedPhase: 'audit',
      expectedAuditRound: 1,
      // No selector evidence was recorded, so deterministic recomputation
      // correctly produces no draft and can never authorize the forged PASS.
      recomputeDraft: () => undefined,
      recomputeAudit: () => undefined,
    },
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_DERIVED_RECOMPUTE_MISSING')
})

test('durable operation reservation blocks an unknown crash from being charged twice', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-ledger-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const cacheKey = anchorExperimentScoreCacheKey({
    binding: active, role: 'selector', id: 'p001', detail: 'low',
  })
  assert.equal(await reserveAndPersistAnchorExperimentProviderOperation({
    state,
    workdir,
    folder: '/photos',
    operation: {
      cacheKey, role: 'selector', kind: 'score', detail: 'low', candidateId: 'p001',
    },
  }), 'dispatch')
  const restored = await loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  })
  assert.equal(restored?.unresolvedProviderOperations().length, 1)
  assert.equal(restored?.reserveProviderOperation({
    cacheKey, role: 'selector', kind: 'score', detail: 'low', candidateId: 'p001',
  }), 'blocked_unknown')
  assert.deepEqual(restored?.paidCalls, {
    selectorScoreAttempted: 1,
    selectorScoreSucceeded: 0,
    selectorPairwiseAttempted: 0,
    selectorPairwiseSucceeded: 0,
    auditScoreAttempted: 0,
    auditScoreSucceeded: 0,
    auditPairwiseAttempted: 0,
    auditPairwiseSucceeded: 0,
  })
})

test('failed operations may retry next turn, while success requires matching evidence', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-ledger-transition-'))
  const active = binding('B')
  const cacheKey = anchorExperimentScoreCacheKey({
    binding: active, role: 'audit', id: 'p001', detail: 'low',
  })
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const authority = attachAuditProgress(state)
  assert.equal(await reserveAndPersistAnchorExperimentProviderOperation({
    state,
    workdir,
    folder: '/photos',
    authority,
    operation: {
      cacheKey, role: 'audit', kind: 'score', detail: 'low', candidateId: 'p001',
    },
  }), 'dispatch')
  assert.throws(() => state.markProviderOperationSucceeded(cacheKey), (error: unknown) =>
    error instanceof AnchorExperimentStateError
      && error.code === 'PROVIDER_OPERATION_EVIDENCE_MISSING')
  state.markProviderOperationFailed(cacheKey, 'RATE_LIMIT')
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos', authority }), true)
  const restored = await loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
    authority,
  })
  assert.equal(await reserveAndPersistAnchorExperimentProviderOperation({
    state: restored!,
    workdir,
    folder: '/photos',
    authority,
    operation: {
      cacheKey, role: 'audit', kind: 'score', detail: 'low', candidateId: 'p001',
    },
  }), 'dispatch')
  const dispatched = await loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
    authority,
  })
  dispatched!.recordScore(normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'audit', detail: 'low',
  }))
  dispatched!.markProviderOperationSucceeded(cacheKey)
  const completedAuthority = attachAuditProgress(dispatched!)
  assert.equal(await saveAnchorExperimentState({
    state: dispatched!, workdir, folder: '/photos', authority: completedAuthority,
  }), true)
  const completed = await loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
    authority: completedAuthority,
  })
  assert.equal(completed?.reserveProviderOperation({
    cacheKey, role: 'audit', kind: 'score', detail: 'low', candidateId: 'p001',
  }), 'cached')
  assert.equal(completed?.paidCalls.auditScoreAttempted, 2)
  assert.equal(completed?.paidCalls.auditScoreSucceeded, 1)
})

test('received format rejection has one durable repair attempt and never resets on reload', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-rejected-response-'))
  const active = binding('B')
  const candidateIds = ['p001', 'p002']
  const cacheKey = anchorExperimentScoreCacheKey({ binding: active, role: 'audit', id: 'p001', detail: 'low' })
  let state = new AnchorExperimentState(active, candidateIds)
  const authority = attachAuditProgress(state)
  const operation = { cacheKey, role: 'audit', kind: 'score', detail: 'low', candidateId: 'p001' } as const
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.equal(await reserveAndPersistAnchorExperimentProviderOperation({
      state, workdir, folder: '/photos', authority, operation,
    }), 'dispatch')
    state.markProviderOperationFailed(cacheKey, 'INVALID_TOOL_ENVELOPE')
    assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos', authority }), true)
    state = (await loadAnchorExperimentState({ binding: active, candidateIds, workdir, folder: '/photos', authority }))!
    assert.equal(state.paidCalls.auditScoreAttempted, attempt)
    assert.equal(state.unresolvedProviderOperations().length, 0)
  }
  await assert.rejects(() => reserveAndPersistAnchorExperimentProviderOperation({
    state, workdir, folder: '/photos', authority, operation,
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PROVIDER_RESPONSE_REPAIR_EXHAUSTED')
  assert.equal(state.paidCalls.auditScoreAttempted, 2)
  assert.equal(state.paidCalls.auditScoreSucceeded, 0)
})

test('a persisted succeeded operation without evidence is rejected', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-ledger-tamper-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  const payload = JSON.parse(await readFile(path, 'utf8'))
  const cacheKey = anchorExperimentScoreCacheKey({
    binding: active, role: 'selector', id: 'p001', detail: 'low',
  })
  payload.providerOperations = [[cacheKey, {
    cacheKey, role: 'selector', kind: 'score', detail: 'low', candidateId: 'p001',
    status: 'succeeded', attempts: 1,
  }]]
  payload.paidCalls.selectorScoreAttempted = 1
  payload.paidCalls.selectorScoreSucceeded = 1
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_PROVIDER_OPERATION_EVIDENCE_MISSING')
})

test('deleted checkpoints cannot replan a partial run, even when the remaining JSON is valid', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-delete-stage-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const authority = attachSelectorPlanning(state)
  assert.equal(await saveAnchorExperimentState({
    state, workdir, folder: '/photos', authority,
  }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)
  for (const field of ['refinementCheckpoint', 'pairwiseCheckpoint'] as const) {
    assert.equal(await saveAnchorExperimentState({
      state, workdir, folder: '/photos', authority,
    }), true)
    const payload = JSON.parse(await readFile(path, 'utf8'))
    delete payload[field]
    await writeFile(path, JSON.stringify(payload))
    await assert.rejects(() => loadAnchorExperimentState({
      binding: active,
      candidateIds: ['p001', 'p002'],
      workdir,
      folder: '/photos',
      authority,
    }), (error: unknown) => error instanceof AnchorExperimentStateError
      && error.code === 'PERSISTED_DERIVED_RECOMPUTE_MISMATCH')
  }
})

test('loader rejects duplicate candidate IDs and duplicate score tuples before hydration', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-duplicate-'))
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  recordSuccessfulScore(state, normalizeAnchorRubricExperimentAssessment({
    assessment: anchorAssessment('p001', false), role: 'selector', detail: 'low',
  }))
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const path = anchorExperimentStateFile(workdir, '/photos', undefined, active)

  const duplicateCandidates = JSON.parse(await readFile(path, 'utf8'))
  duplicateCandidates.candidateIds = ['p001', 'p001']
  await writeFile(path, JSON.stringify(duplicateCandidates))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_CANDIDATE_UNIVERSE_MISMATCH')

  assert.equal(await saveAnchorExperimentState({ state, workdir, folder: '/photos' }), true)
  const duplicateScores = JSON.parse(await readFile(path, 'utf8'))
  duplicateScores.selectorScores.push(structuredClone(duplicateScores.selectorScores[0]))
  await writeFile(path, JSON.stringify(duplicateScores))
  await assert.rejects(() => loadAnchorExperimentState({
    binding: active, candidateIds: ['p001', 'p002'], workdir, folder: '/photos',
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PERSISTED_SCORE_IDENTITY_MISMATCH')
})

test('C cannot bill or store the same semantic leg under a second render receipt', () => {
  const active = binding('C')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const first = anchorPairRecord(active, {
    pairCandidateReceiptHash: hash('candidate-sheet-receipt-1'),
  })
  const second = anchorPairRecord(active, {
    pairCandidateReceiptHash: hash('candidate-sheet-receipt-2'),
  })
  state.reserveProviderOperation({
    cacheKey: first.cacheKey,
    role: first.role,
    kind: 'pairwise',
    aId: first.aId,
    bId: first.bId,
    order: first.order,
    pairCandidateReceiptHash: first.pairCandidateReceiptHash,
  })
  assert.throws(() => state.reserveProviderOperation({
    cacheKey: second.cacheKey,
    role: second.role,
    kind: 'pairwise',
    aId: second.aId,
    bId: second.bId,
    order: second.order,
    pairCandidateReceiptHash: second.pairCandidateReceiptHash,
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PROVIDER_OPERATION_SEMANTIC_DUPLICATE')

  state.recordPairwiseLeg(first)
  assert.throws(() => state.recordPairwiseLeg(second), (error: unknown) =>
    error instanceof AnchorExperimentStateError
      && error.code === 'PAIRWISE_SEMANTIC_LEG_DUPLICATE')
})

test('failed reservation persistence blocks provider dispatch', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'photo-filter-anchor-state-no-dispatch-'))
  const badWorkdir = join(temporary, 'not-a-directory')
  await writeFile(badWorkdir, 'block mkdir')
  const active = binding('B')
  const state = new AnchorExperimentState(active, ['p001', 'p002'])
  const cacheKey = anchorExperimentScoreCacheKey({
    binding: active, role: 'selector', id: 'p001', detail: 'low',
  })
  await assert.rejects(() => reserveAndPersistAnchorExperimentProviderOperation({
    state,
    workdir: badWorkdir,
    folder: '/photos',
    operation: {
      cacheKey,
      role: 'selector',
      kind: 'score',
      detail: 'low',
      candidateId: 'p001',
    },
  }), (error: unknown) => error instanceof AnchorExperimentStateError
    && error.code === 'PROVIDER_OPERATION_RESERVATION_PERSIST_FAILED')
  assert.equal(state.unresolvedProviderOperations().length, 1)
})
