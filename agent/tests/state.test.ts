import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  currentExportSelectionHash,
  decidePortraitAuditStatus,
  loadState,
  parseCandidateScope,
  portraitAuditPassed,
  RunState,
  saveState,
  validateProposal,
  type PortraitAuditReport,
} from '../src/state.ts'
import { PORTRAIT_BASELINE_RUBRIC_VERSION, PORTRAIT_DIMENSION_IDS } from '../src/rubric.ts'
import type { AnalyzeReport } from '../src/engine.ts'
import type { PortraitBaselineAssessment } from '../src/portrait-vision.ts'
import { planHighRefinement } from '../src/selection-budget.ts'

function report(fingerprint: string, ids = ['p001', 'p002']): AnalyzeReport {
  return {
    workdir: '/opaque',
    dataset_fingerprint: fingerprint,
    photo_count: ids.length,
    people_count: ids.length,
    scenery_count: 0,
    family_count: 0,
    families: [],
    collapsed_by_family: [],
    candidates: ids.map(id => ({
      id,
      category: 'people' as const,
      sharp: 80,
      range: 70,
      clip: 0,
      risk: [],
      local_top: true,
    })),
  }
}

function assessment(id: string, score = 80): PortraitBaselineAssessment {
  const dimensionScores = Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, score]))
  const dimensionConfidences = Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, 0.9]))
  const dimensionEvidence = Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(key => [key, ['visible']]))
  return {
    id,
    rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
    eligibility: {
      status: 'eligible',
      failureCodes: [],
      evidence: [],
      assessability: 0.9,
      ambiguousIntent: false,
    },
    dimensionScores,
    dimensionConfidences,
    dimensionEvidence,
    baselineScore: score,
    overallConfidence: 0.9,
    scoreInterval: [score - 3, score + 3],
    observableTags: {
      expression: ['natural'],
      gaze: ['camera'],
      framing: ['half_body'],
      lighting: ['soft'],
      mood: ['warm'],
      scene: ['trail'],
      poseAction: ['walking'],
    },
    summary: 'visible portrait evidence',
  }
}

function passingAudit(
  fingerprint: string,
  selectionHash: string,
  selectedIds: string[],
  challengerIds: string[] = [],
): PortraitAuditReport {
  return {
    schemaVersion: 'portrait-audit-v3',
    datasetFingerprint: fingerprint,
    selectionHash,
    selectedIds,
    challengerIds,
    randomChallengerIds: challengerIds,
    status: 'PASS',
    passed: true,
    weakestSelectedScore: 80,
    strongerChallengers: [],
    evaluatedCount: selectedIds.length + challengerIds.length,
    plannedCount: selectedIds.length + challengerIds.length,
    remainingCount: 0,
    pairwiseEvaluatedCount: 0,
    pairwisePlannedCount: 0,
    pairwiseRemainingCount: 0,
    paidCalls: selectedIds.length + challengerIds.length,
    contextKey: 'audit-v3-context',
    stage: 'complete',
    auditProviderIdentityKey: 'audit-provider-v1',
  }
}

function locallySceneryReport(fingerprint = 'local-false-negative'): AnalyzeReport {
  const value = report(fingerprint)
  value.people_count = 0
  value.scenery_count = value.photo_count
  for (const candidate of value.candidates) candidate.category = 'scenery'
  return value
}

test('analyze of another dataset clears every old anonymous-id decision', () => {
  const state = new RunState()
  state.absorb(report('first'), '/first')
  state.recordPortrait(assessment('p001'), 'low', 'cache-v1')
  state.portraitDraft = {
    keep: ['p001'],
    why: { p001: 'old' },
    baselineScores: { p001: 80 },
    personalizedScores: { p001: 80 },
    selectionHash: 'old',
    preference: state.preference,
    selectorIdentityKey: 'selector-v1',
    selectorPairwiseIdentityKey: 'selector-pair-v1',
  }
  state.proposal = { keep: ['p001'], why: { p001: 'old' } }

  state.absorb(report('second', ['p001']), '/second')

  assert.equal(state.portraitScores.size, 0)
  assert.equal(state.portraitDraft, undefined)
  assert.equal(state.portraitAudit, undefined)
  assert.equal(state.proposal, undefined)
  assert.equal(state.folder, '/second')
})

test('portrait cache is rubric/model keyed and never downgraded', () => {
  const state = new RunState()
  state.absorb(report('same', ['p001']), '/same')
  state.recordPortrait(assessment('p001', 80), 'high', 'rubric-model-v1')

  assert.ok(state.cachedPortrait('p001', 'low', 'rubric-model-v1'))
  assert.equal(state.cachedPortrait('p001', 'low', 'rubric-model-v2'), undefined)
  state.recordPortrait(assessment('p001', 20), 'low', 'rubric-model-v1')
  assert.equal(state.portraitScores.get('p001')?.assessment.baselineScore, 80)
})

test('legacy contradictory eligibility caches are ignored and must be retried', () => {
  const state = new RunState()
  state.absorb(report('inconsistent-cache'), '/inconsistent-cache')
  const valid = assessment('p001')
  const inconsistent: PortraitBaselineAssessment = {
    ...valid,
    eligibility: {
      status: 'needs_review',
      failureCodes: [
        'HR_UNASSESSABLE_ASSET',
        'HR_NO_INTENTIONAL_HUMAN_SUBJECT',
        'HR_PRIMARY_SUBJECT_UNINTERPRETABLE',
        'HR_CATASTROPHIC_CAPTURE_FAILURE',
      ],
      evidence: ['主体清晰可见'],
      assessability: 0.96,
      ambiguousIntent: false,
    },
    baselineScore: null,
  }

  state.recordPortrait(inconsistent, 'high', 'selector-key')
  state.recordPortraitAudit(inconsistent, 'high', 'audit-key')

  assert.equal(state.cachedPortrait('p001', 'high', 'selector-key'), undefined)
  assert.equal(state.cachedPortraitAudit('p001', 'high', 'audit-key'), undefined)
})

test('high-refinement checkpoint survives retry/reload and clears only when preference changes', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-refinement-'))
  try {
    const source = new RunState()
    source.absorb(report('refinement-checkpoint'), '/photos')
    const plan = planHighRefinement([
      { id: 'p001', score: 80, eligibility: 'eligible' },
      { id: 'p002', score: 79, eligibility: 'eligible' },
    ], 1)
    source.portraitRefinementCheckpoint = {
      schemaVersion: 'portrait-refinement-checkpoint-v1',
      contextKey: 'dataset-scope-target-preference-rubric-model',
      plan,
    }

    // Re-applying the same normalized preference is a retry, not a new budget.
    source.setPreference({})
    assert.deepEqual(source.portraitRefinementCheckpoint?.plan.candidateIds, ['p001', 'p002'])
    await saveState(source, workdir)

    const restored = new RunState()
    restored.absorb(report('refinement-checkpoint'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.equal(restored.portraitRefinementCheckpoint?.contextKey,
      'dataset-scope-target-preference-rubric-model')
    assert.deepEqual(restored.portraitRefinementCheckpoint?.plan.candidateIds, ['p001', 'p002'])

    restored.setPreference({ expression: { joyful: 1 } })
    assert.equal(restored.portraitRefinementCheckpoint, undefined)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('audit FAIL rebuild feedback survives selector repairs and reload, then clears on preference change', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-rebuild-feedback-'))
  try {
    const source = new RunState()
    source.absorb(report('rebuild-feedback'), '/photos')
    source.portraitRebuildFeedback = {
      schemaVersion: 'portrait-rebuild-feedback-v1',
      datasetFingerprint: 'rebuild-feedback',
      failedSelectionHash: 'failed-selection',
      selectedIds: ['p001'],
      strongerChallengerIds: ['p002'],
      selectorIdentityKey: 'selector-v1',
      selectorPairwiseIdentityKey: 'selector-pair-v1',
      auditProviderIdentityKey: 'audit-provider-v1',
      feedbackHash: 'feedback-v1',
    }

    source.recordPortrait(assessment('p002', 95), 'high', 'selector-v1')
    assert.deepEqual(source.portraitRebuildFeedback?.strongerChallengerIds, ['p002'])
    assert.equal(await saveState(source, workdir), true)

    const restored = new RunState()
    restored.absorb(report('rebuild-feedback'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.equal(restored.portraitRebuildFeedback?.failedSelectionHash, 'failed-selection')
    assert.deepEqual(restored.portraitRebuildFeedback?.strongerChallengerIds, ['p002'])

    restored.setPreference({ expression: { joyful: 1 } })
    assert.equal(restored.portraitRebuildFeedback, undefined)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('audit verdict is INCOMPLETE before coverage and FAIL only for a complete quality counterexample', () => {
  assert.equal(decidePortraitAuditStatus({
    remainingCount: 233,
    pairwiseRemainingCount: 0,
    qualityCounterexampleCount: 9,
  }), 'INCOMPLETE')
  assert.equal(decidePortraitAuditStatus({
    remainingCount: 0,
    pairwiseRemainingCount: 1,
    qualityCounterexampleCount: 9,
  }), 'INCOMPLETE')
  assert.equal(decidePortraitAuditStatus({
    remainingCount: 0,
    pairwiseRemainingCount: 0,
    qualityCounterexampleCount: 1,
  }), 'FAIL')
  assert.equal(decidePortraitAuditStatus({
    remainingCount: 0,
    pairwiseRemainingCount: 0,
    qualityCounterexampleCount: 0,
  }), 'PASS')
})

test('detail-aware audit scores and a directional leg survive INCOMPLETE retry without unfreezing selection', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-audit-resume-'))
  try {
    const source = new RunState()
    source.absorb(report('audit-resume'), '/photos')
    source.targets = { people: 1, scenery: 0 }
    source.recordPortrait(assessment('p001'), 'high', 'selector-key')
    source.recordPortrait(assessment('p002', 79), 'high', 'selector-key')
    source.portraitDraft = {
      keep: ['p001'],
      why: { p001: 'frozen best' },
      baselineScores: { p001: 80 },
      personalizedScores: { p001: 80 },
      selectionHash: 'frozen-selection',
      preference: source.preference,
      selectorIdentityKey: 'selector-v1',
      selectorPairwiseIdentityKey: 'selector-pair-v1',
    }
    source.recordPortraitAudit(assessment('p001', 81), 'high', 'audit-high-dataset-rubric-model')
    source.recordPortraitAudit(assessment('p002', 78), 'low', 'audit-low-dataset-rubric-model')
    source.recordPortraitAuditPairwiseLeg('p002', 'p001', 'AB', {
      order: 'AB', winner: 'B', normalizedDeltas: {}, weightedMargin: -2, confidence: 0.9, reason: 'AB',
    } as never, 'audit-pair-leg-ab')
    source.recordPortraitSelectorPairwiseLeg('p001', 'p002', 'AB', {
      order: 'AB',
      winner: 'A',
      normalizedDeltas: {},
      weightedMargin: 5,
      confidence: 0.8,
      reason: 'selector AB persisted',
    } as never, 'selector-pair-leg-ab')
    source.portraitAudit = {
      schemaVersion: 'portrait-audit-v3',
      datasetFingerprint: 'audit-resume',
      selectionHash: 'frozen-selection',
      selectedIds: ['p001'],
      challengerIds: ['p002'],
      randomChallengerIds: ['p002'],
      status: 'INCOMPLETE',
      passed: false,
      weakestSelectedScore: null,
      strongerChallengers: [],
      evaluatedCount: 1,
      plannedCount: 2,
      remainingCount: 1,
      failedIds: ['p002'],
      pairwiseEvaluatedCount: 1,
      pairwisePlannedCount: 2,
      pairwiseRemainingCount: 1,
      failedPairKeys: ['p002/p001/BA'],
      paidCalls: 3,
      cachedCalls: 0,
      lastAttemptPaidCalls: 3,
      lastAttemptCachedCalls: 0,
      nextAction: 'retry_audit',
      contextKey: 'v3-context',
      stage: 'pairwise',
    }
    await saveState(source, workdir)

    const restored = new RunState()
    restored.absorb(report('audit-resume'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.equal(
      restored.cachedPortraitAudit('p001', 'high', 'audit-high-dataset-rubric-model')?.assessment.baselineScore,
      81,
    )
    assert.equal(restored.cachedPortraitAudit('p001', 'low', 'audit-high-dataset-rubric-model'), undefined)
    assert.equal(restored.cachedPortraitAudit('p002', 'high', 'audit-low-dataset-rubric-model'), undefined)
    assert.equal(restored.cachedPortraitAudit('p001', 'high', 'another-model'), undefined)
    assert.equal(
      restored.cachedPortraitAuditPairwiseLeg('audit-pair-leg-ab')?.decision.order,
      'AB',
    )
    assert.equal(
      restored.cachedPortraitSelectorPairwiseLeg('selector-pair-leg-ab')?.decision.order,
      'AB',
    )
    assert.equal(restored.cachedPortraitAuditPairwiseLeg('missing-ba'), undefined)
    assert.deepEqual(restored.portraitDraft?.keep, ['p001'])
    assert.equal(restored.portraitDraft?.selectionHash, 'frozen-selection')
    assert.equal(restored.portraitAudit?.status, 'INCOMPLETE')
    assert.equal(portraitAuditPassed(restored.portraitAudit), false)
    assert.match(validateProposal(restored, ['p001']).reason ?? '', /PASS/)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('concurrent checkpoints serialize atomic supersets and leave no temporary file', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-atomic-state-'))
  try {
    const source = new RunState()
    source.absorb(report('atomic-state'), '/photos')
    source.recordPortrait(assessment('p001'), 'low', 'selector-v1')
    const first = saveState(source, workdir)
    source.recordPortrait(assessment('p002', 79), 'low', 'selector-v1')
    const second = saveState(source, workdir)
    assert.deepEqual(await Promise.all([first, second]), [true, true])

    const restored = new RunState()
    restored.absorb(report('atomic-state'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.deepEqual([...restored.portraitScores.keys()].sort(), ['p001', 'p002'])
    assert.equal((await readdir(workdir)).some(name => name.includes('.tmp-')), false)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('export approval persists with its selection hash and invalidates on preference or dataset change', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-export-approval-'))
  try {
    const source = new RunState()
    source.absorb(report('export-approval'), '/photos')
    source.proposal = { keep: ['p001'], why: { p001: 'selected' } }
    const selectionHash = currentExportSelectionHash(source)
    assert.ok(selectionHash)
    source.exportApproval = {
      schemaVersion: 'export-approval-v1',
      selectionHash,
      destination: '/authorized/export',
      confirmationCode: 'PF-A1B2C3D4',
      requestedAfterUserMessageId: 'message-before-code',
    }
    assert.equal(await saveState(source, workdir), true)

    const restored = new RunState()
    restored.absorb(report('export-approval'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.deepEqual(restored.exportApproval, source.exportApproval)
    assert.equal(currentExportSelectionHash(restored), selectionHash)

    restored.setPreference({ expression: { joyful: 1 } })
    assert.equal(restored.exportApproval, undefined)
    restored.exportApproval = source.exportApproval
    restored.absorb(report('another-dataset'), '/other')
    assert.equal(restored.exportApproval, undefined)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('frozen selector pairwise plan survives reload and preference changes invalidate it', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-selector-pair-plan-'))
  try {
    const source = new RunState()
    source.absorb(report('selector-pair-plan'), '/photos')
    source.portraitSelectorPairwiseCheckpoint = {
      schemaVersion: 'portrait-selector-pairwise-checkpoint-v1',
      contextKey: 'dataset-scope-target-preference-rubric-model',
      plan: {
        pairs: [{ leftId: 'p001', rightId: 'p002', source: 'cutline' }],
        familyPairCount: 0,
        cutlinePairCount: 1,
        pairCap: 24,
        bidirectionalCallCap: 48,
      },
    }
    assert.equal(await saveState(source, workdir), true)

    const restored = new RunState()
    restored.absorb(report('selector-pair-plan'), '/photos')
    assert.equal(await loadState(restored, workdir, '/photos'), true)
    assert.deepEqual(restored.portraitSelectorPairwiseCheckpoint?.plan.pairs, [
      { leftId: 'p001', rightId: 'p002', source: 'cutline' },
    ])

    restored.setPreference({ expression: { joyful: 1 } })
    assert.equal(restored.portraitSelectorPairwiseCheckpoint, undefined)
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})

test('final proposal requires exact K, frozen build result, and matching audit PASS', () => {
  const state = new RunState()
  state.absorb(report('same'), '/same')
  state.targets = { people: 1, scenery: 0 }
  state.recordPortrait(assessment('p001'), 'high', 'cache')
  state.recordPortrait(assessment('p002', 79), 'high', 'cache')
  state.portraitDraft = {
    keep: ['p001'],
    why: { p001: 'best' },
    baselineScores: { p001: 80 },
    personalizedScores: { p001: 80 },
    selectionHash: 'selection',
    preference: state.preference,
    selectorIdentityKey: 'selector-v1',
    selectorPairwiseIdentityKey: 'selector-pair-v1',
  }

  assert.match(validateProposal(state, ['p001']).reason ?? '', /evaluator/)
  state.portraitAudit = {
    schemaVersion: 'portrait-audit-v1',
    datasetFingerprint: 'same',
    selectionHash: 'selection',
    selectedIds: ['p001'],
    challengerIds: ['p002'],
    randomChallengerIds: ['p002'],
    passed: true,
    weakestSelectedScore: 80,
    strongerChallengers: [],
    evaluatedCount: 2,
    paidCalls: 2,
  }
  assert.equal(portraitAuditPassed(state.portraitAudit), false)
  assert.match(validateProposal(state, ['p001']).reason ?? '', /PASS/)
  state.portraitAudit = passingAudit('same', 'selection', ['p001'], ['p002'])
  assert.deepEqual(validateProposal(state, ['p001']), { ok: true })
  assert.match(validateProposal(state, ['p002']).reason ?? '', /build_selection/)
  assert.match(validateProposal(state, ['p001', 'p002']).reason ?? '', /目标/)
})

test('audited portrait draft may contain a bounded same-family repeat', () => {
  const sameFamily = report('same-family')
  sameFamily.family_count = 1
  sameFamily.families = [{ id: 'F01', members: ['p001', 'p002'] }]
  for (const candidate of sameFamily.candidates) candidate.family = 'F01'

  const state = new RunState()
  state.absorb(sameFamily, '/same-family')
  state.targets = { people: 2, scenery: 0 }
  state.recordPortrait(assessment('p001'), 'high', 'cache')
  state.recordPortrait(assessment('p002', 79), 'high', 'cache')
  state.portraitDraft = {
    keep: ['p001', 'p002'],
    why: { p001: 'best', p002: 'exact-K backfill' },
    baselineScores: { p001: 80, p002: 79 },
    personalizedScores: { p001: 80, p002: 79 },
    selectionHash: 'same-family-selection',
    preference: state.preference,
    selectorIdentityKey: 'selector-v1',
    selectorPairwiseIdentityKey: 'selector-pair-v1',
  }
  state.portraitAudit = passingAudit(
    'same-family',
    'same-family-selection',
    ['p001', 'p002'],
  )

  assert.deepEqual(validateProposal(state, ['p001', 'p002']), { ok: true })
})

test('people_only is explicit and requires an explicit zero scenery target', () => {
  assert.equal(parseCandidateScope(undefined, undefined), 'auto')
  assert.equal(parseCandidateScope('auto', 3), 'auto')
  assert.equal(parseCandidateScope('people_only', 0), 'people_only')
  assert.throws(() => parseCandidateScope('people_only', undefined), /scenery_target=0/)
  assert.throws(() => parseCandidateScope('people_only', 1), /scenery_target=0/)
  assert.throws(() => parseCandidateScope('portraits', 0), /auto 或 people_only/)
})

test('people_only widens the effective portrait pool without rewriting local categories', () => {
  const localReport = locallySceneryReport()
  const automatic = new RunState()
  automatic.absorb(localReport, '/photos')
  assert.equal(automatic.portraitCandidates().length, 0)
  assert.equal(automatic.all('scenery').length, 2)

  const explicit = new RunState()
  explicit.absorb(localReport, '/photos', undefined, 'people_only')
  assert.deepEqual(explicit.portraitCandidates().map(candidate => candidate.id), ['p001', 'p002'])
  assert.equal(explicit.all('scenery').length, 0)
  assert.equal(explicit.candidates.get('p001')?.category, 'scenery')
  assert.equal(explicit.effectiveCategory(explicit.candidates.get('p001')!), 'people')
})

test('people_only uses effective categories in final proposal validation', () => {
  const state = new RunState()
  state.absorb(locallySceneryReport('proposal-scope'), '/photos', undefined, 'people_only')
  state.targets = { people: 1, scenery: 0 }
  state.recordPortrait(assessment('p001'), 'high', 'cache')
  state.portraitDraft = {
    keep: ['p001'],
    why: { p001: 'portrait evidence' },
    baselineScores: { p001: 80 },
    personalizedScores: { p001: 80 },
    selectionHash: 'scoped-selection',
    preference: state.preference,
    selectorIdentityKey: 'selector-v1',
    selectorPairwiseIdentityKey: 'selector-pair-v1',
  }
  state.portraitAudit = passingAudit(
    'proposal-scope',
    'scoped-selection',
    ['p001'],
    ['p002'],
  )

  assert.deepEqual(validateProposal(state, ['p001']), { ok: true })
  assert.equal(state.candidates.get('p001')?.category, 'scenery')
})

test('scope changes reuse paid scores but invalidate scope-bound decisions', async () => {
  const workdir = await mkdtemp(join(tmpdir(), 'photo-filter-scope-'))
  try {
    const localReport = locallySceneryReport('checkpoint-scope')
    const source = new RunState()
    source.absorb(localReport, '/photos', undefined, 'people_only')
    source.targets = { people: 1, scenery: 0 }
    source.recordPortrait(assessment('p001'), 'high', 'rubric-model')
    source.portraitComparisons.push({ leftId: 'p001', rightId: 'p002', leftOutcome: 1 })
    source.portraitRefinementCheckpoint = {
      schemaVersion: 'portrait-refinement-checkpoint-v1',
      contextKey: 'people-only-budget',
      plan: planHighRefinement([
        { id: 'p001', score: 80, eligibility: 'eligible' },
        { id: 'p002', score: 79, eligibility: 'eligible' },
      ], 1),
    }
    source.portraitDraft = {
      keep: ['p001'],
      why: { p001: 'best' },
      baselineScores: { p001: 80 },
      personalizedScores: { p001: 80 },
      selectionHash: 'scope-bound',
      preference: source.preference,
      selectorIdentityKey: 'selector-v1',
      selectorPairwiseIdentityKey: 'selector-pair-v1',
    }
    source.portraitAudit = {
      schemaVersion: 'portrait-audit-v1',
      datasetFingerprint: 'checkpoint-scope',
      selectionHash: 'scope-bound',
      selectedIds: ['p001'],
      challengerIds: ['p002'],
      randomChallengerIds: ['p002'],
      passed: true,
      weakestSelectedScore: 80,
      strongerChallengers: [],
      evaluatedCount: 2,
      paidCalls: 2,
    }
    source.proposal = { keep: ['p001'], why: { p001: 'best' } }
    await saveState(source, workdir)

    const sameScope = new RunState()
    sameScope.absorb(localReport, '/photos', undefined, 'people_only')
    assert.equal(await loadState(sameScope, workdir, '/photos'), true)
    assert.equal(sameScope.portraitRefinementCheckpoint?.contextKey, 'people-only-budget')
    assert.deepEqual(sameScope.portraitDraft?.keep, ['p001'])
    assert.equal(sameScope.portraitAudit?.passed, true)
    assert.deepEqual(sameScope.proposal?.keep, ['p001'])

    const automatic = new RunState()
    automatic.absorb(localReport, '/photos', undefined, 'auto')
    assert.equal(await loadState(automatic, workdir, '/photos'), true)
    assert.ok(automatic.portraitScores.has('p001'))
    assert.equal(automatic.portraitComparisons.length, 0)
    assert.equal(automatic.portraitRefinementCheckpoint, undefined)
    assert.equal(automatic.portraitDraft, undefined)
    assert.equal(automatic.portraitAudit, undefined)
    assert.equal(automatic.proposal, undefined)
    assert.equal(automatic.candidateScope, 'auto')
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
})
