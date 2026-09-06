import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createPortraitEvaluationProfile } from '../src/evaluation-profile.ts'
import {
  assertReferenceSheetQualityReceipt,
  freezePairCandidateSheetReceipt,
  freezeReferenceSheetQualityReceipt,
  loadReferenceSheetQualityReceipt,
  prepareAnchoredAttachments,
  ReferenceSheetQualityError,
  referenceSheetOrderedSourceContentHash,
} from '../src/reference-sheet-quality.ts'
import {
  evidenceHash,
  makeReferenceSheetEvidence,
  makeReferenceSheetQualityReceipt,
  makePairCandidateEvidence,
  makePairCandidateSheetReceipt,
  metadataFreeTestJpeg,
} from './reference-sheet-evidence-fixture.ts'

const hash = (character: string) => character.repeat(64)
const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, marker, 0xff, 0xd9]).toString('base64')
const jpegHash = (value: string) => createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function resign(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { receiptHash: _oldHash, ...withoutHash } = value
  return {
    ...withoutHash,
    receiptHash: createHash('sha256').update(JSON.stringify(canonical(withoutHash))).digest('hex'),
  }
}

function profile() {
  return createPortraitEvaluationProfile({
    arm: 'C',
    rubricVersion: 'portrait-baseline-anchor-v0.1',
    rubricContentHash: hash('2'),
    visualAnchorPackHash: hash('3'),
  })
}

function receipt(anchorSheet: string) {
  return makeReferenceSheetQualityReceipt({
    anchorPackHash: hash('3'),
    anchorSheetSha256: jpegHash(anchorSheet),
    layoutProtocolHash: hash('4'),
  })
}

function protocol(anchorSheet: string, qualityReceiptHash: string) {
  return {
    id: 'reference-sheet/v2' as const,
    anchorSheetSha256: jpegHash(anchorSheet),
    layoutProtocolHash: hash('4'),
    qualityReceiptHash,
    anchorSheetCount: 1 as const,
    candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2' as const,
  }
}

test('legacy self-reported hashes cannot mint a quality PASS', () => {
  assert.throws(() => freezeReferenceSheetQualityReceipt({
    localRenderReportHash: hash('5'),
    humanReviewReceiptHash: hash('6'),
  } as never), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'INVALID_RECEIPT_SHAPE')
})

test('quality receipt binds exact pixels, layout, privacy and all 14 assets', () => {
  const value = receipt(jpeg(1))
  assert.equal(value.schemaVersion, 'photo-filter-reference-sheet-quality/v2')
  assert.equal(value.status, 'PASS')
  assert.match(value.receiptHash, /^[a-f0-9]{64}$/u)
  assert.equal(value.anchorAssetCount, value.anchorCaseCount * 2)
  assert.notEqual(value.localRenderReportHash, value.humanReviewReceiptHash)
})

test('PASS requires both complete local-render and independent human evidence', () => {
  const evidence = makeReferenceSheetEvidence()
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      localRenderReport: evidence.localRenderReport,
    } as never),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'INVALID_RECEIPT_SHAPE',
  )
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      humanVisualReviewReceipt: evidence.humanVisualReviewReceipt,
    } as never),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'INVALID_RECEIPT_SHAPE',
  )
  const incompleteLocal = structuredClone(evidence.localRenderReport)
  incompleteLocal.cells = incompleteLocal.cells.slice(0, 13)
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      ...evidence,
      localRenderReport: incompleteLocal,
    }),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'INCOMPLETE_LOCAL_CELLS',
  )
  const nonPassHuman = structuredClone(evidence.humanVisualReviewReceipt) as Record<string, unknown>
  nonPassHuman.status = 'PENDING'
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      ...evidence,
      humanVisualReviewReceipt: nonPassHuman,
    }),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'HUMAN_REVIEW_NOT_PASS',
  )
})

test('evidence must bind the same exact sheet, layout and ordered cell identities', () => {
  const evidence = makeReferenceSheetEvidence()
  const changedSheet = structuredClone(evidence.humanVisualReviewReceipt)
  changedSheet.anchorSheetSha256 = evidenceHash('different-sheet')
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      ...evidence,
      humanVisualReviewReceipt: changedSheet,
    }),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'EVIDENCE_IDENTITY_MISMATCH',
  )

  const changedCells = structuredClone(evidence.humanVisualReviewReceipt)
  changedCells.cells[0].faceCritical = false
  changedCells.cells[0].faceDetailReadable = null
  changedCells.cells[10].faceCritical = true
  changedCells.cells[10].faceDetailReadable = true
  assert.equal(changedCells.orderedSourceContentHash, referenceSheetOrderedSourceContentHash(
    changedCells.cells.map(cell => cell.sourceContentSha256),
  ))
  assert.throws(
    () => freezeReferenceSheetQualityReceipt({
      ...evidence,
      humanVisualReviewReceipt: changedCells,
    }),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'EVIDENCE_CELL_IDENTITY_MISMATCH',
  )
})

test('string evidence must be exact canonical JSON bytes', () => {
  const evidence = makeReferenceSheetEvidence()
  assert.throws(() => freezeReferenceSheetQualityReceipt({
    localRenderReport: JSON.stringify(evidence.localRenderReport, null, 2),
    humanVisualReviewReceipt: evidence.humanVisualReviewReceipt,
  }), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'NON_CANONICAL_EVIDENCE_BYTES')

  const localBytes = JSON.stringify(canonical(evidence.localRenderReport))
  const humanBytes = Buffer.from(JSON.stringify(canonical(evidence.humanVisualReviewReceipt)))
  const value = freezeReferenceSheetQualityReceipt({
    localRenderReport: localBytes,
    humanVisualReviewReceipt: humanBytes,
  })
  assert.equal(value.status, 'PASS')
})

test('assert/load revalidate all invariants even when a malformed object is re-signed', () => {
  const valid = receipt(jpeg(1))
  const malformed = resign({
    ...valid,
    faceCriticalAssetsPassed: 12,
  })
  assert.throws(
    () => assertReferenceSheetQualityReceipt(malformed),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'INVALID_ANCHOR_COUNTS',
  )
  assert.throws(
    () => loadReferenceSheetQualityReceipt(malformed),
    (error: unknown) => error instanceof ReferenceSheetQualityError
      && error.code === 'INVALID_ANCHOR_COUNTS',
  )

  const persisted = JSON.parse(JSON.stringify(valid)) as unknown
  const loaded = loadReferenceSheetQualityReceipt(persisted)
  assert.deepEqual(loaded, valid)
  assert.notEqual(loaded, persisted)
  assert.equal(Object.isFrozen(loaded), true)
})

test('C high preflight returns anchor-first attachments without writing them', () => {
  const anchor = jpeg(1)
  const candidate = jpeg(2)
  const quality = receipt(anchor)
  const prepared = prepareAnchoredAttachments({
    profile: profile(),
    stage: 'high',
    protocol: protocol(anchor, quality.receiptHash),
    qualityReceipt: quality,
    anchorSheetJpegBase64: anchor,
    candidateJpegBase64: candidate,
    limits: { maxImagesPerMessage: 2, maxMessageImageBytes: 1_000 },
  })
  assert.deepEqual(prepared.jpegs, [anchor, candidate])
  assert.equal(prepared.totalBytes, 10)
})

test('C pairwise requires a bound FIRST/SECOND candidate-sheet receipt', () => {
  const anchor = jpeg(1)
  const candidateSheet = metadataFreeTestJpeg(3)
  const quality = receipt(anchor)
  const shared = {
    profile: profile(),
    stage: 'pairwise' as const,
    protocol: protocol(anchor, quality.receiptHash),
    qualityReceipt: quality,
    anchorSheetJpegBase64: anchor,
    candidateJpegBase64: candidateSheet,
    limits: { maxImagesPerMessage: 2, maxMessageImageBytes: 1_000 },
  }
  assert.throws(() => prepareAnchoredAttachments(shared), (error: unknown) =>
    error instanceof ReferenceSheetQualityError && error.code === 'PAIR_SHEET_RECEIPT_REQUIRED')

  const pairReceipt = makePairCandidateSheetReceipt({
    combinedLayoutProtocolHash: hash('4'),
    candidateSheetJpegBase64: candidateSheet,
  })
  assert.deepEqual(prepareAnchoredAttachments({ ...shared, pairCandidateReceipt: pairReceipt }).jpegs,
    [anchor, candidateSheet])
})

test('pair receipt cannot be self-reported or minted without 2/2 bound focus insets', () => {
  assert.throws(() => freezePairCandidateSheetReceipt({
    combinedLayoutProtocolHash: hash('4'),
    firstSourceJpegSha256: hash('5'),
    secondSourceJpegSha256: hash('6'),
    candidateSheetSha256: hash('7'),
    labelsReadable: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
  } as never), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'INVALID_RECEIPT_SHAPE')

  const evidence = makePairCandidateEvidence({ combinedLayoutProtocolHash: hash('4') })
  const missingInset = structuredClone(evidence.renderEvidence) as Record<string, unknown>
  missingInset.faceInsetCount = 1
  assert.throws(() => freezePairCandidateSheetReceipt({
    ...evidence.input,
    renderEvidence: missingInset,
  }), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'PAIR_RENDER_NOT_READY')

  assert.throws(() => freezePairCandidateSheetReceipt({
    ...evidence.input,
    firstFaceFocus: { center_x: 1.1, center_y: 0.4, side_fraction: 0.3 },
  }), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'INVALID_PAIR_FOCUS')
})

test('changed sheet pixels cannot reuse a frozen PASS receipt', () => {
  const anchor = jpeg(1)
  const quality = receipt(anchor)
  assert.throws(() => prepareAnchoredAttachments({
    profile: profile(),
    stage: 'high',
    protocol: protocol(anchor, quality.receiptHash),
    qualityReceipt: quality,
    anchorSheetJpegBase64: jpeg(9),
    candidateJpegBase64: jpeg(2),
    limits: { maxImagesPerMessage: 2, maxMessageImageBytes: 1_000 },
  }), (error: unknown) => error instanceof ReferenceSheetQualityError
    && error.code === 'REFERENCE_SHEET_IDENTITY_MISMATCH')
})

test('actual payload bytes fail closed before Harness attachment limits are exceeded', () => {
  const anchor = jpeg(1)
  const quality = receipt(anchor)
  assert.throws(() => prepareAnchoredAttachments({
    profile: profile(),
    stage: 'high',
    protocol: protocol(anchor, quality.receiptHash),
    qualityReceipt: quality,
    anchorSheetJpegBase64: anchor,
    candidateJpegBase64: jpeg(2),
    limits: { maxImagesPerMessage: 2, maxMessageImageBytes: 9 },
  }), /超过 Harness 上限/u)
})
