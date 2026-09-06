import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  AnchorExperimentRuntimeError,
  createAnchorCandidateOverlapReport,
  prepareAnchorExperimentBundle,
} from '../src/anchor-experiment-runtime.ts'
import { makeReferenceSheetQualityReceipt } from './reference-sheet-evidence-fixture.ts'

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const hash = (value: string) => sha256(value)

function packBytes() {
  return Buffer.from(JSON.stringify({
    schema: 'photo-filter-visual-anchor-pack/v1',
    status: 'frozen_for_experiment',
    rubric_version: 'portrait-baseline-anchor-v0.1',
    privacy: {
      contains_absolute_paths: false,
      contains_filenames: false,
      contains_oracle_data: false,
      contains_original_asset_ids: false,
    },
    anchors: Array.from({ length: 7 }, (_, index) => ({
      anchor_id: `anchor-${String(index + 1).padStart(3, '0')}`,
      images: [
        { slot: 'A', asset_ref: `safe-a-${index}`, absolute_tier: 'keep' },
        { slot: 'B', asset_ref: `safe-b-${index}`, absolute_tier: 'reject' },
      ],
      rationale_zh: `第 ${index + 1} 组只说明可观察的人物状态。`,
    })),
  }))
}

function fixture() {
  const pack = packBytes()
  const sheet = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
  const receipt = makeReferenceSheetQualityReceipt({
    anchorPackHash: sha256(pack),
    anchorSheetSha256: sha256(sheet),
    layoutProtocolHash: hash('layout'),
  })
  const anchorHashes = Array.from({ length: 14 }, (_, index) => hash(`anchor-original-${index}`))
  return { pack, sheet, receipt, anchorHashes }
}

test('runtime bundle binds exact pack, sheet, PASS receipt, legend and 14 original hashes', () => {
  const value = fixture()
  const bundle = prepareAnchorExperimentBundle({
    anchorPackBytes: value.pack,
    anchorSheetJpeg: value.sheet,
    referenceSheetQualityReceipt: value.receipt,
    orderedAnchorOriginalContentHashes: value.anchorHashes,
  })
  assert.equal(bundle.packHash, sha256(value.pack))
  assert.equal(bundle.anchorSheetSha256, sha256(value.sheet))
  assert.equal(bundle.visualRuntime.protocol.qualityReceiptHash, value.receipt.receiptHash)
  assert.equal(bundle.visualRuntime.legendText, bundle.legendText)
  assert.equal(sha256(bundle.legendText), bundle.legendHash)
  assert.equal(bundle.orderedAnchorOriginalContentHashes.length, 14)
})

test('pack, exact sheet or receipt tampering fails closed', () => {
  const value = fixture()
  assert.throws(() => prepareAnchorExperimentBundle({
    anchorPackBytes: Buffer.concat([value.pack, Buffer.from(' ')]),
    anchorSheetJpeg: value.sheet,
    referenceSheetQualityReceipt: value.receipt,
    orderedAnchorOriginalContentHashes: value.anchorHashes,
  }), (error: unknown) => error instanceof AnchorExperimentRuntimeError
    && error.code === 'ANCHOR_BUNDLE_RECEIPT_MISMATCH')
  assert.throws(() => prepareAnchorExperimentBundle({
    anchorPackBytes: value.pack,
    anchorSheetJpeg: Buffer.concat([value.sheet, Buffer.from([0])]),
    referenceSheetQualityReceipt: value.receipt,
    orderedAnchorOriginalContentHashes: value.anchorHashes,
  }), (error: unknown) => error instanceof AnchorExperimentRuntimeError
    && error.code === 'ANCHOR_BUNDLE_RECEIPT_MISMATCH')
  assert.throws(() => prepareAnchorExperimentBundle({
    anchorPackBytes: value.pack,
    anchorSheetJpeg: value.sheet,
    referenceSheetQualityReceipt: { ...value.receipt, receiptHash: hash('forged') },
    orderedAnchorOriginalContentHashes: value.anchorHashes,
  }))
})

test('overlap report binds complete sets and distinguishes acceptance from in-sample diagnosis', () => {
  const value = fixture()
  const bundle = prepareAnchorExperimentBundle({
    anchorPackBytes: value.pack,
    anchorSheetJpeg: value.sheet,
    referenceSheetQualityReceipt: value.receipt,
    orderedAnchorOriginalContentHashes: value.anchorHashes,
  })
  const clean = createAnchorCandidateOverlapReport({
    datasetFingerprint: hash('dataset'),
    candidateOriginalContentHashes: [hash('candidate-1'), hash('candidate-2')],
    bundle,
  })
  assert.equal(clean.overlapCount, 0)
  assert.match(clean.reportHash, /^[a-f0-9]{64}$/u)
  const contaminated = createAnchorCandidateOverlapReport({
    datasetFingerprint: hash('dataset'),
    candidateOriginalContentHashes: [hash('candidate-1'), value.anchorHashes[3]!],
    bundle,
  })
  assert.equal(contaminated.overlapCount, 1)
  assert.notEqual(clean.reportHash, contaminated.reportHash)
})

test('incomplete, repeated or malformed content identities are rejected', () => {
  const value = fixture()
  assert.throws(() => prepareAnchorExperimentBundle({
    anchorPackBytes: value.pack,
    anchorSheetJpeg: value.sheet,
    referenceSheetQualityReceipt: value.receipt,
    orderedAnchorOriginalContentHashes: value.anchorHashes.slice(0, 13),
  }), (error: unknown) => error instanceof AnchorExperimentRuntimeError
    && error.code === 'ANCHOR_ORIGINAL_HASHES_INVALID')
})
