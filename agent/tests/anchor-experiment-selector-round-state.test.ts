import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createAnchorLabSelectorFeedback,
  createFrozenSelectorRound,
} from '../src/anchor-experiment-authority.ts'
import {
  AnchorExperimentState,
  AnchorExperimentStateError,
  anchorExperimentStateFile,
  loadAnchorExperimentState,
  saveAnchorExperimentState,
  type AnchorExperimentDerivedAuthority,
  type AnchorExperimentRunBinding,
} from '../src/anchor-experiment-state.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function binding(): AnchorExperimentRunBinding {
  const routeIdentityHash = hash(['provider', 'model', 'protocol', ''].join('\u0000'))
  const base = {
    schemaVersion: 'photo-filter-anchor-experiment-binding/v1' as const,
    experimentId: 'photo-anchor-lab-codex-v1:round-state-test',
    arm: 'B' as const,
    manifestHash: hash('manifest'),
    sourceSnapshotHash: hash('source'),
    datasetFingerprint: hash('dataset'),
    candidateScope: 'people_only' as const,
    targetK: 1,
    seed: 'seed',
    preferenceHash: hash('preference'),
    route: Object.freeze({ provider: 'provider', model: 'model', protocol: 'protocol' }),
    routeIdentityHash,
    profileProtocol: 'profile-v1',
    rubricVersion: 'anchor-v1',
    rubricContentHash: hash('rubric'),
    contracts: Object.freeze({
      selectorLow: hash('sl'), selectorHigh: hash('sh'), selectorPairwise: hash('sp'),
      auditLow: hash('al'), auditHigh: hash('ah'), auditPairwise: hash('ap'),
    }),
    budget: Object.freeze({
      highCap: 2, pairwisePairCap: 1, auditCallCapPerTurn: 1,
      maxCompleteAuditRounds: 2,
    }),
  }
  return Object.freeze({
    ...base,
    stateNamespaceHash: hash([
      'photo-filter-anchor-experiment-binding/v1', base.experimentId, base.arm,
      base.manifestHash, base.routeIdentityHash, base.datasetFingerprint,
    ].join('\u0000')),
  })
}

test('selector round is durable authority: deletion or hash tampering blocks resume', async () => {
  const active = binding()
  const ids = ['p1', 'p2']
  const state = new AnchorExperimentState(active, ids)
  const round = createFrozenSelectorRound({
    binding: active, round: 1, existingComparisons: [],
  })
  state.setSelectorRound(round)
  const authority: AnchorExperimentDerivedAuthority = Object.freeze({
    expectedPersistedPhase: 'baseline',
    expectedSelectorRound: round,
  })
  const workdir = await mkdtemp(join(tmpdir(), 'anchor-selector-round-'))
  const folder = '/private/anonymous-allowed-dataset'
  assert.equal(await saveAnchorExperimentState({ state, workdir, folder, authority }), true)
  const restored = await loadAnchorExperimentState({
    binding: active, candidateIds: ids, workdir, folder, authority,
  })
  assert.deepEqual(restored?.selectorRound, round)

  const file = anchorExperimentStateFile(workdir, folder, undefined, active)
  const original = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  const deleted = { ...original }
  delete deleted.selectorRound
  await writeFile(file, JSON.stringify(deleted))
  await assert.rejects(
    () => loadAnchorExperimentState({
      binding: active, candidateIds: ids, workdir, folder, authority,
    }),
    (error: unknown) => error instanceof AnchorExperimentStateError
      && error.code === 'PERSISTED_SELECTOR_ROUND_AUTHORITY_MISMATCH',
  )

  const tampered = structuredClone(original) as Record<string, any>
  tampered.selectorRound.roundHash = hash('forged-round')
  await writeFile(file, JSON.stringify(tampered))
  await assert.rejects(
    () => loadAnchorExperimentState({
      binding: active, candidateIds: ids, workdir, folder, authority,
    }),
    (error: unknown) => error instanceof AnchorExperimentStateError
      && error.code === 'PERSISTED_SELECTOR_ROUND_INVALID',
  )
})

test('declared selector round must also match evidence recomputation authority', async () => {
  const active = binding()
  const ids = ['p1', 'p2']
  const state = new AnchorExperimentState(active, ids)
  const roundOne = createFrozenSelectorRound({
    binding: active, round: 1, existingComparisons: [],
  })
  state.setSelectorRound(roundOne)
  const failedSelectionHash = hash('failed-selection')
  const roundTwo = createFrozenSelectorRound({
    binding: active,
    round: 2,
    existingComparisons: [],
    priorSelectionHash: failedSelectionHash,
    feedback: createAnchorLabSelectorFeedback({
      binding: active,
      failedAuditRound: 1,
      failedSelectionHash,
      strongerChallengerIds: ['p2'],
      disqualifiedSelectedIds: [],
    }),
  })
  const authority: AnchorExperimentDerivedAuthority = Object.freeze({
    expectedPersistedPhase: 'baseline',
    expectedSelectorRound: roundOne,
    recomputeSelectorRound: () => roundTwo,
  })
  const workdir = await mkdtemp(join(tmpdir(), 'anchor-selector-recompute-'))
  await assert.rejects(
    () => saveAnchorExperimentState({
      state, workdir, folder: '/private/anonymous-allowed-dataset', authority,
    }),
    (error: unknown) => error instanceof AnchorExperimentStateError
      && error.code === 'SELECTOR_ROUND_RECOMPUTE_MISMATCH',
  )
})
