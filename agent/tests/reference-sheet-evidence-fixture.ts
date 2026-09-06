import { createHash } from 'node:crypto'
import {
  freezePairCandidateSheetReceipt,
  freezeReferenceSheetQualityReceipt,
  PAIR_CANDIDATE_LAYOUT_PROTOCOL,
  PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA,
  REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA,
  REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA,
  referenceSheetOrderedSourceContentHash,
  type FrozenReferenceSheetQualityReceipt,
  type FrozenPairCandidateSheetReceipt,
  type PairCandidateFaceFocus,
  type PairCandidateRenderEvidence,
  type ReferenceSheetHumanReviewCell,
  type ReferenceSheetHumanVisualReviewReceipt,
  type ReferenceSheetLocalRenderCell,
  type ReferenceSheetLocalRenderReport,
} from '../src/reference-sheet-quality.ts'

export const evidenceHash = (label: string): string =>
  createHash('sha256').update(label).digest('hex')

export const jpegContentHash = (jpegBase64: string): string =>
  createHash('sha256').update(Buffer.from(jpegBase64, 'base64')).digest('hex')

/** Small structurally valid, metadata-free JPEG container for receipt unit tests. */
export const metadataFreeTestJpeg = (tag: number): string =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x03, tag & 0xff, 0xff, 0xd9])
    .toString('base64')

export interface ReferenceSheetEvidenceFixtureOptions {
  anchorPackHash?: string
  anchorSheetSha256?: string
  layoutProtocolHash?: string
}

export function makeReferenceSheetEvidence(
  options: ReferenceSheetEvidenceFixtureOptions = {},
): {
  localRenderReport: ReferenceSheetLocalRenderReport
  humanVisualReviewReceipt: ReferenceSheetHumanVisualReviewReceipt
} {
  const anchorPackHash = options.anchorPackHash ?? evidenceHash('anchor-pack')
  const anchorSheetSha256 = options.anchorSheetSha256 ?? evidenceHash('anchor-sheet')
  const layoutProtocolHash = options.layoutProtocolHash ?? evidenceHash('layout-protocol')
  const identities = Array.from({ length: 14 }, (_, index) => ({
    cellIndex: index + 1,
    caseIndex: Math.floor(index / 2) + 1,
    side: (index % 2 === 0 ? 'A' : 'B') as 'A' | 'B',
    sourceContentSha256: evidenceHash(`anchor-source-${index + 1}`),
    // anchor-006 A is the single intentionally non-face-critical back-view.
    faceCritical: index !== 10,
  }))
  const orderedSourceContentHash = referenceSheetOrderedSourceContentHash(
    identities.map(cell => cell.sourceContentSha256),
  )
  const localCells: ReferenceSheetLocalRenderCell[] = identities.map(identity => ({
    ...identity,
    assetRendered: true,
    explicitFocusCropRendered: identity.faceCritical,
  }))
  const humanCells: ReferenceSheetHumanReviewCell[] = identities.map((identity, index) => ({
    ...identity,
    assetPresent: true,
    labelReadable: true,
    aspectRatioPreserved: true,
    fullCompositionVisible: true,
    sourceCorrespondenceConfirmed: true,
    faceDetailReadable: identity.faceCritical ? true : null,
    observation: index === 7 ? '源图本身的轻微模糊被如实保留。' : '',
  }))
  return {
    localRenderReport: {
      schemaVersion: REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA,
      status: 'NEEDS_HUMAN_VISUAL_REVIEW',
      anchorPackHash,
      anchorSheetSha256,
      layoutProtocolHash,
      orderedSourceContentHash,
      anchorCaseCount: 7,
      anchorAssetCount: 14,
      faceCriticalAssetCount: 13,
      automaticFaceMeasurementCount: 0,
      explicitFocusCropCount: 13,
      pairLabelsPresent: true,
      readingOrderDeterministic: true,
      preservesAspectRatio: true,
      stripsMetadata: true,
      containsPathsOrFilenames: false,
      cells: localCells,
    },
    humanVisualReviewReceipt: {
      schemaVersion: REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA,
      status: 'PASS',
      reviewerProtocol: 'independent-human-visual-review/v1',
      reviewedWithoutSelectorState: true,
      anchorPackHash,
      anchorSheetSha256,
      layoutProtocolHash,
      orderedSourceContentHash,
      anchorCaseCount: 7,
      anchorAssetCount: 14,
      faceCriticalAssetCount: 13,
      faceCriticalAssetsPassed: 13,
      overallConfidence: 0.96,
      pairLabelsReadable: true,
      readingOrderConfirmed: true,
      preservesAspectRatio: true,
      stripsMetadata: true,
      containsPathsOrFilenames: false,
      cells: humanCells,
    },
  }
}

export function makeReferenceSheetQualityReceipt(
  options: ReferenceSheetEvidenceFixtureOptions = {},
): FrozenReferenceSheetQualityReceipt {
  return freezeReferenceSheetQualityReceipt(makeReferenceSheetEvidence(options))
}

export interface PairCandidateEvidenceFixtureOptions {
  combinedLayoutProtocolHash?: string
  firstAnonymousID?: string
  secondAnonymousID?: string
  firstSourceJpegBase64?: string
  secondSourceJpegBase64?: string
  candidateSheetJpegBase64?: string
  firstFaceFocus?: PairCandidateFaceFocus
  secondFaceFocus?: PairCandidateFaceFocus
}

export function makePairCandidateEvidence(options: PairCandidateEvidenceFixtureOptions = {}): {
  input: Parameters<typeof freezePairCandidateSheetReceipt>[0]
  renderEvidence: PairCandidateRenderEvidence
} {
  const firstAnonymousID = options.firstAnonymousID ?? 'first-anonymous'
  const secondAnonymousID = options.secondAnonymousID ?? 'second-anonymous'
  const firstSourceJpegBase64 = options.firstSourceJpegBase64 ?? metadataFreeTestJpeg(1)
  const secondSourceJpegBase64 = options.secondSourceJpegBase64 ?? metadataFreeTestJpeg(2)
  const candidateSheetJpegBase64 = options.candidateSheetJpegBase64 ?? metadataFreeTestJpeg(3)
  const firstFaceFocus = options.firstFaceFocus
    ?? { center_x: 0.4, center_y: 0.35, side_fraction: 0.3 }
  const secondFaceFocus = options.secondFaceFocus
    ?? { center_x: 0.6, center_y: 0.4, side_fraction: 0.28 }
  const renderEvidence: PairCandidateRenderEvidence = {
    schemaVersion: PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA,
    status: 'READY_FOR_PAIRWISE',
    layoutProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    candidateSheetSha256: jpegContentHash(candidateSheetJpegBase64),
    width: 3072,
    height: 1536,
    pairCount: 1,
    assetCount: 2,
    faceInsetCount: 2,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    cells: [
      {
        cellIndex: 1,
        label: 'FIRST',
        faceCritical: true,
        faceRegionSource: 'explicit_focus_unverified',
        anonymousID: firstAnonymousID,
        sourceContentSha256: jpegContentHash(firstSourceJpegBase64),
      },
      {
        cellIndex: 2,
        label: 'SECOND',
        faceCritical: true,
        faceRegionSource: 'explicit_focus_unverified',
        anonymousID: secondAnonymousID,
        sourceContentSha256: jpegContentHash(secondSourceJpegBase64),
      },
    ],
  }
  return {
    input: {
      combinedLayoutProtocolHash: options.combinedLayoutProtocolHash ?? evidenceHash('layout-bundle'),
      firstAnonymousID,
      secondAnonymousID,
      firstSourceJpegBase64,
      secondSourceJpegBase64,
      firstFaceFocus,
      secondFaceFocus,
      candidateSheetJpegBase64,
      renderEvidence,
    },
    renderEvidence,
  }
}

export function makePairCandidateSheetReceipt(
  options: PairCandidateEvidenceFixtureOptions = {},
): FrozenPairCandidateSheetReceipt {
  return freezePairCandidateSheetReceipt(makePairCandidateEvidence(options).input)
}
