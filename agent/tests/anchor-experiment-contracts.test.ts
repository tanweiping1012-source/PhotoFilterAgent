import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  ANCHOR_EXPERIMENT_MANIFEST_BUILDER_VERSION,
  buildCompiledAnchorAbcManifest,
  createCompiledAnchorProfiles,
  compiledAnchorArmContracts,
  type CompiledAnchorAbcManifestInput,
} from '../src/anchor-experiment-contracts.ts'
import type { VisualAnchorRuntime } from '../src/portrait-anchor-vision.ts'
import { PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH } from '../src/portrait-anchor-rubric.ts'
import { PAIR_CANDIDATE_LAYOUT_PROTOCOL } from '../src/reference-sheet-quality.ts'
import {
  makeReferenceSheetQualityReceipt,
  metadataFreeTestJpeg,
} from './reference-sheet-evidence-fixture.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const jpegHash = (value: string) => hash(Buffer.from(value, 'base64').toString('binary'))

function runtime(packHash: string): VisualAnchorRuntime {
  const jpeg = metadataFreeTestJpeg(9)
  const anchorSheetSha256 = createHash('sha256').update(Buffer.from(jpeg, 'base64')).digest('hex')
  const layoutProtocolHash = hash('layout')
  const qualityReceipt = makeReferenceSheetQualityReceipt({
    anchorPackHash: packHash,
    anchorSheetSha256,
    layoutProtocolHash,
  })
  const legendText = 'compiled anonymous anchor legend'
  return Object.freeze({
    protocol: Object.freeze({
      id: 'reference-sheet/v2',
      anchorSheetSha256,
      layoutProtocolHash,
      qualityReceiptHash: qualityReceipt.receiptHash,
      anchorSheetCount: 1,
      candidateSheetProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    }),
    qualityReceipt,
    anchorSheetJpegBase64: jpeg,
    legendText,
    legendHash: hash(legendText),
  })
}

function input(): CompiledAnchorAbcManifestInput {
  const packHash = hash('pack')
  const visualRuntime = runtime(packHash)
  return {
    experimentId: 'compiled-abc',
    mode: 'acceptance',
    sourceSnapshotHash: hash('source'),
    dataset: {
      fingerprint: hash('dataset'),
      candidateScope: 'people_only',
      targetK: 20,
      seed: 'seed',
      preferenceHash: hash('preference'),
    },
    route: {
      provider: 'provider', model: 'model', protocol: 'dsh-llm-tool-call-v1',
      reasoningEffort: 'high',
    },
    budget: {
      highCap: 60,
      pairwisePairCap: 24,
      auditCallCapPerTurn: 32,
      maxCompleteAuditRounds: 2,
    },
    visualAnchorPack: {
      packHash,
      rubricContentHash: PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
      orderedAssetContentMultisetHash: hash('anchor-content'),
      anchorSheetSha256: visualRuntime.protocol.anchorSheetSha256,
      layoutProtocolHash: visualRuntime.protocol.layoutProtocolHash,
      referenceSheetQualityReceipt: visualRuntime.qualityReceipt,
    },
    contentOverlapPreflight: {
      protocolVersion: 'anchor-candidate-overlap/v1',
      datasetFingerprint: hash('dataset'),
      anchorPackHash: packHash,
      overlapCount: 0,
      reportHash: hash('overlap'),
    },
    oracle: {
      oracleLocked: true,
      scanExclusionPolicyHash: hash('exclusion'),
      unlockPolicy: 'all_arms_exact_k_and_audit_terminal',
      unlockRequiresSeparateReceipt: true,
    },
    visualRuntime,
  }
}

test('compiled builder derives profiles, prompt contracts and algorithm identity from code', () => {
  const manifest = buildCompiledAnchorAbcManifest(input())
  assert.equal(manifest.algorithmIdentity.manifestBuilderVersion,
    ANCHOR_EXPERIMENT_MANIFEST_BUILDER_VERSION)
  assert.equal(manifest.arms.B.selectorLowContractHash,
    manifest.arms.C.selectorLowContractHash)
  assert.equal(manifest.arms.B.auditLowContractHash,
    manifest.arms.C.auditLowContractHash)
  assert.notEqual(manifest.arms.B.selectorHighContractHash,
    manifest.arms.C.selectorHighContractHash)
  assert.notEqual(manifest.arms.B.auditPairwiseContractHash,
    manifest.arms.C.auditPairwiseContractHash)
  assert.equal(manifest.arms.C.profile.visualAnchorPackHash,
    manifest.visualAnchorPack.packHash)
})

test('B/C low remain byte-contract identical without sharing arm state', () => {
  const packHash = hash('pack')
  const profiles = createCompiledAnchorProfiles(packHash)
  const b = compiledAnchorArmContracts({ profile: profiles.B })
  const c = compiledAnchorArmContracts({ profile: profiles.C, visualRuntime: runtime(packHash) })
  assert.equal(b.selectorLowContractHash, c.selectorLowContractHash)
  assert.equal(b.auditLowContractHash, c.auditLowContractHash)
  assert.notEqual(b.selectorHighContractHash, c.selectorHighContractHash)
})

test('compiled builder rejects a visual runtime not matching exact sheet identity', () => {
  const broken = input()
  broken.visualAnchorPack.anchorSheetSha256 = hash('other-sheet')
  assert.throws(() => buildCompiledAnchorAbcManifest(broken), /visual runtime does not match/u)
})
