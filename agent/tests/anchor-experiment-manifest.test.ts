import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AnchorExperimentManifestError,
  freezeAnchorAbcManifest,
  type AnchorAbcManifestInput,
  type AnchorArmContracts,
} from '../src/anchor-experiment-manifest.ts'
import { createPortraitEvaluationProfile } from '../src/evaluation-profile.ts'
import { makeReferenceSheetQualityReceipt } from './reference-sheet-evidence-fixture.ts'

const hash = (character: string) => character.repeat(64)

function qualityReceipt() {
  return makeReferenceSheetQualityReceipt({
    anchorPackHash: hash('3'),
    anchorSheetSha256: hash('9'),
    layoutProtocolHash: hash('5'),
  })
}

function arm(
  name: 'A' | 'B' | 'C',
  options: { low?: string; high?: string; pair?: string; auditLow?: string } = {},
): AnchorArmContracts {
  const newRubric = name !== 'A'
  return {
    profile: createPortraitEvaluationProfile({
      arm: name,
      rubricVersion: newRubric ? 'portrait-baseline-anchor-v0.1' : 'portrait-baseline-v1.0.0',
      rubricContentHash: newRubric ? hash('2') : hash('1'),
      ...(name === 'C' ? { visualAnchorPackHash: hash('3') } : {}),
    }),
    selectorLowContractHash: options.low ?? (newRubric ? hash('4') : hash('a')),
    selectorHighContractHash: options.high ?? (name === 'C' ? hash('6') : newRubric ? hash('5') : hash('b')),
    selectorPairwiseContractHash: options.pair ?? (name === 'C' ? hash('8') : newRubric ? hash('7') : hash('c')),
    auditLowContractHash: options.auditLow ?? (newRubric ? hash('9') : hash('d')),
    auditHighContractHash: name === 'C' ? hash('f') : newRubric ? hash('e') : hash('0'),
    auditPairwiseContractHash: name === 'C' ? hash('b') : newRubric ? hash('a') : hash('c'),
    visualStages: name === 'C'
      ? ['selector_high', 'selector_pairwise', 'audit_high', 'audit_pairwise']
      : [],
  }
}

function input(): AnchorAbcManifestInput {
  return {
    experimentId: 'anchor-abc-test',
    mode: 'acceptance',
    sourceSnapshotHash: hash('1'),
    dataset: {
      fingerprint: hash('2'),
      candidateScope: 'people_only',
      targetK: 20,
      seed: 'frozen-seed',
      preferenceHash: hash('3'),
    },
    route: {
      provider: 'selected-provider',
      model: 'selected-model',
      protocol: 'dsh-llm-tool-call-v1',
      reasoningEffort: 'high',
    },
    algorithmIdentity: {
      highPlanVersion: 'v1',
      pairwisePlanVersion: 'v1',
      rankingPolicyVersion: 'v1',
      auditPlanVersion: 'v1',
    },
    budget: {
      highCap: 60,
      pairwisePairCap: 24,
      auditCallCapPerTurn: 32,
      maxCompleteAuditRounds: 2,
    },
    visualAnchorPack: {
      packHash: hash('3'),
      rubricContentHash: hash('2'),
      orderedAssetContentMultisetHash: hash('4'),
      anchorSheetSha256: hash('9'),
      layoutProtocolHash: hash('5'),
      referenceSheetQualityReceipt: qualityReceipt(),
    },
    contentOverlapPreflight: {
      protocolVersion: 'anchor-candidate-overlap/v1',
      datasetFingerprint: hash('2'),
      anchorPackHash: hash('3'),
      overlapCount: 0,
      reportHash: hash('6'),
    },
    arms: { A: arm('A'), B: arm('B'), C: arm('C') },
    oracle: {
      oracleLocked: true,
      scanExclusionPolicyHash: hash('7'),
      unlockPolicy: 'all_arms_exact_k_and_audit_terminal',
      unlockRequiresSeparateReceipt: true,
    },
  }
}

test('freezes one immutable acceptance manifest with route and manifest hashes', () => {
  const mutableInput = input()
  const manifest = freezeAnchorAbcManifest(mutableInput)
  assert.equal(manifest.acceptanceEligible, true)
  assert.equal(manifest.schemaVersion, 'photo-filter-anchor-abc/v2')
  assert.match(manifest.routeIdentityHash, /^[a-f0-9]{64}$/u)
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/u)
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.dataset), true)
  assert.equal(Object.isFrozen(manifest.arms.C.visualStages), true)
  assert.equal(Object.isFrozen(manifest.visualAnchorPack.referenceSheetQualityReceipt), true)

  mutableInput.dataset.seed = 'mutated-after-freeze'
  mutableInput.arms.C.visualStages = []
  assert.equal(manifest.dataset.seed, 'frozen-seed')
  assert.deepEqual(manifest.arms.C.visualStages,
    ['selector_high', 'selector_pairwise', 'audit_high', 'audit_pairwise'])
})

test('manifest requires the actual v2 PASS receipt and cross-checks pack/sheet/layout identity', () => {
  const arbitraryHash = input()
  arbitraryHash.visualAnchorPack.referenceSheetQualityReceipt = hash('8') as never
  assert.throws(
    () => freezeAnchorAbcManifest(arbitraryHash),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'REFERENCE_SHEET_RECEIPT_INVALID',
  )

  const wrongSheet = input()
  wrongSheet.visualAnchorPack.anchorSheetSha256 = hash('a')
  assert.throws(
    () => freezeAnchorAbcManifest(wrongSheet),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'REFERENCE_SHEET_RECEIPT_IDENTITY_MISMATCH',
  )

  const tamperedHash = input()
  tamperedHash.visualAnchorPack.referenceSheetQualityReceipt = {
    ...tamperedHash.visualAnchorPack.referenceSheetQualityReceipt,
    receiptHash: hash('a'),
  }
  assert.throws(
    () => freezeAnchorAbcManifest(tamperedHash),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'REFERENCE_SHEET_RECEIPT_INVALID',
  )
})

test('B and C low must be identical and C may not add low visual anchors', () => {
  const changed = input()
  changed.arms.C = arm('C', { low: hash('f') })
  assert.throws(
    () => freezeAnchorAbcManifest(changed),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'BC_LOW_CONTRACT_MISMATCH',
  )
  const visualLow = input()
  visualLow.arms.C = { ...visualLow.arms.C, visualStages: [...visualLow.arms.C.visualStages, 'selector_low'] }
  assert.throws(
    () => freezeAnchorAbcManifest(visualLow),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'INVALID_VISUAL_STAGES',
  )
})

test('C high and pairwise must be distinct from B', () => {
  const changed = input()
  changed.arms.C = arm('C', {
    high: changed.arms.B.selectorHighContractHash,
    pair: changed.arms.B.selectorPairwiseContractHash,
  })
  assert.throws(
    () => freezeAnchorAbcManifest(changed),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'C_VISUAL_CONTRACT_NOT_ISOLATED',
  )
})

test('acceptance blocks any exact visual-anchor/candidate overlap', () => {
  const changed = input()
  changed.contentOverlapPreflight.overlapCount = 1
  assert.throws(
    () => freezeAnchorAbcManifest(changed),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'ANCHOR_CANDIDATE_LEAKAGE',
  )
  changed.mode = 'diagnostic'
  assert.equal(freezeAnchorAbcManifest(changed).acceptanceEligible, false)
})

test('overlap preflight must bind the same dataset and pack', () => {
  const changed = input()
  changed.contentOverlapPreflight.anchorPackHash = hash('f')
  assert.throws(
    () => freezeAnchorAbcManifest(changed),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'OVERLAP_PREFLIGHT_IDENTITY_MISMATCH',
  )
})

test('oracle cannot be unlocked by rewriting the manifest', () => {
  const changed = input() as AnchorAbcManifestInput & { oracle: { oracleLocked: boolean } }
  changed.oracle.oracleLocked = false
  assert.throws(
    () => freezeAnchorAbcManifest(changed as AnchorAbcManifestInput),
    (error: unknown) => error instanceof AnchorExperimentManifestError
      && error.code === 'ORACLE_NOT_LOCKED',
  )
})
