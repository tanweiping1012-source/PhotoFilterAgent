import { createHash } from 'node:crypto'
import {
  assertPortraitAttachmentCapacity,
  type AttachmentLimits,
  type PortraitEvaluationProfile,
  type PortraitEvaluationStage,
  type VisualAnchorAttachmentProtocol,
} from './evaluation-profile.ts'

export const REFERENCE_SHEET_QUALITY_SCHEMA = 'photo-filter-reference-sheet-quality/v2' as const
export const REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA =
  'photo-filter-reference-sheet-local-render-report/v1' as const
export const REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA =
  'photo-filter-reference-sheet-human-review/v1' as const
export const REFERENCE_SHEET_ORDERED_SOURCE_PROTOCOL =
  'photo-filter-reference-sheet-ordered-sources/v1' as const
export const PAIR_CANDIDATE_SHEET_SCHEMA = 'photo-filter-pair-candidate-sheet/v2' as const
export const PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA =
  'photo-filter-pair-candidate-render-evidence/v1' as const
export const PAIR_CANDIDATE_LAYOUT_PROTOCOL =
  'pair-side-by-side-3072x1536-face-inset-v2' as const

type Hash = string

export interface ReferenceSheetEvidenceCellIdentity {
  cellIndex: number
  caseIndex: number
  side: 'A' | 'B'
  sourceContentSha256: Hash
  faceCritical: boolean
}

export interface ReferenceSheetLocalRenderCell extends ReferenceSheetEvidenceCellIdentity {
  assetRendered: true
  explicitFocusCropRendered: boolean
}

export interface ReferenceSheetHumanReviewCell extends ReferenceSheetEvidenceCellIdentity {
  assetPresent: true
  labelReadable: true
  aspectRatioPreserved: true
  fullCompositionVisible: true
  sourceCorrespondenceConfirmed: true
  faceDetailReadable: true | null
  /** A bounded note may record source blur or another non-blocking observation. */
  observation: string
}

export interface ReferenceSheetLocalRenderReport {
  schemaVersion: typeof REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA
  status: 'NEEDS_HUMAN_VISUAL_REVIEW'
  anchorPackHash: Hash
  anchorSheetSha256: Hash
  layoutProtocolHash: Hash
  orderedSourceContentHash: Hash
  anchorCaseCount: 7
  anchorAssetCount: 14
  faceCriticalAssetCount: 13
  automaticFaceMeasurementCount: number
  explicitFocusCropCount: 13
  pairLabelsPresent: true
  readingOrderDeterministic: true
  preservesAspectRatio: true
  stripsMetadata: true
  containsPathsOrFilenames: false
  cells: readonly ReferenceSheetLocalRenderCell[]
}

export interface ReferenceSheetHumanVisualReviewReceipt {
  schemaVersion: typeof REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA
  status: 'PASS'
  reviewerProtocol: 'independent-human-visual-review/v1'
  reviewedWithoutSelectorState: true
  anchorPackHash: Hash
  anchorSheetSha256: Hash
  layoutProtocolHash: Hash
  orderedSourceContentHash: Hash
  anchorCaseCount: 7
  anchorAssetCount: 14
  faceCriticalAssetCount: 13
  faceCriticalAssetsPassed: 13
  overallConfidence: number
  pairLabelsReadable: true
  readingOrderConfirmed: true
  preservesAspectRatio: true
  stripsMetadata: true
  containsPathsOrFilenames: false
  cells: readonly ReferenceSheetHumanReviewCell[]
}

export type ReferenceSheetEvidence = unknown | string | Uint8Array

export interface ReferenceSheetQualityReceiptInput {
  localRenderReport: ReferenceSheetEvidence
  humanVisualReviewReceipt: ReferenceSheetEvidence
}

export interface ReferenceSheetQualityReceiptIdentity {
  anchorPackHash: Hash
  anchorSheetSha256: Hash
  layoutProtocolHash: Hash
  orderedSourceContentHash: Hash
  localRenderReportHash: Hash
  humanReviewReceiptHash: Hash
  anchorCaseCount: 7
  anchorAssetCount: 14
  faceCriticalAssetCount: 13
  faceCriticalAssetsPassed: 13
  explicitFocusCropCount: 13
  humanReviewConfidence: number
  pairLabelsReadable: true
  preservesAspectRatio: true
  stripsMetadata: true
  containsPathsOrFilenames: false
  reviewerProtocol: 'local-render-and-human-review/v1'
}

export interface FrozenReferenceSheetQualityReceipt extends ReferenceSheetQualityReceiptIdentity {
  readonly schemaVersion: typeof REFERENCE_SHEET_QUALITY_SCHEMA
  readonly status: 'PASS'
  readonly receiptHash: Hash
}

export interface PairCandidateSheetReceiptInput {
  combinedLayoutProtocolHash: Hash
  firstAnonymousID: string
  secondAnonymousID: string
  firstSourceJpegBase64: string
  secondSourceJpegBase64: string
  firstFaceFocus: PairCandidateFaceFocus
  secondFaceFocus: PairCandidateFaceFocus
  candidateSheetJpegBase64: string
  renderEvidence: ReferenceSheetEvidence
}

export interface PairCandidateFaceFocus {
  center_x: number
  center_y: number
  side_fraction: number
}

export interface PairCandidateRenderCell {
  cellIndex: 1 | 2
  label: 'FIRST' | 'SECOND'
  faceCritical: true
  faceRegionSource: 'explicit_focus_unverified'
  anonymousID: string
  sourceContentSha256: Hash
}

export interface PairCandidateRenderEvidence {
  schemaVersion: typeof PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA
  status: 'READY_FOR_PAIRWISE'
  layoutProtocol: typeof PAIR_CANDIDATE_LAYOUT_PROTOCOL
  candidateSheetSha256: Hash
  width: 3072
  height: 1536
  pairCount: 1
  assetCount: 2
  faceInsetCount: 2
  preservesAspectRatio: true
  stripsMetadata: true
  containsPathsOrFilenames: false
  cells: readonly [PairCandidateRenderCell, PairCandidateRenderCell]
}

export interface PairCandidateSheetReceiptIdentity {
  combinedLayoutProtocolHash: Hash
  candidateLayoutProtocol: typeof PAIR_CANDIDATE_LAYOUT_PROTOCOL
  firstAnonymousID: string
  secondAnonymousID: string
  firstSourceJpegSha256: Hash
  secondSourceJpegSha256: Hash
  firstFaceFocusHash: Hash
  secondFaceFocusHash: Hash
  candidateSheetSha256: Hash
  renderEvidenceHash: Hash
  faceInsetCount: 2
  labelsReadable: true
  preservesAspectRatio: true
  stripsMetadata: true
  containsPathsOrFilenames: false
}

export interface FrozenPairCandidateSheetReceipt extends PairCandidateSheetReceiptIdentity {
  readonly schemaVersion: typeof PAIR_CANDIDATE_SHEET_SCHEMA
  readonly firstLabel: 'FIRST'
  readonly secondLabel: 'SECOND'
  readonly receiptHash: Hash
}

export class ReferenceSheetQualityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ReferenceSheetQualityError'
    this.code = code
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ReferenceSheetQualityError('INVALID_HASH', `${field} 必须是 64 位小写 SHA-256。`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string):
asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReferenceSheetQualityError('INVALID_RECEIPT_SHAPE', `${label} 必须是对象。`)
  }
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new ReferenceSheetQualityError(
      'INVALID_RECEIPT_SHAPE',
      `${label} 缺少必需字段或包含未知字段。`,
    )
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function receiptHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

const REFERENCE_SHEET_QUALITY_FACTORY_KEYS = Object.freeze([
  'localRenderReport',
  'humanVisualReviewReceipt',
])

const REFERENCE_SHEET_QUALITY_IDENTITY_KEYS = Object.freeze([
  'anchorPackHash',
  'anchorSheetSha256',
  'layoutProtocolHash',
  'orderedSourceContentHash',
  'localRenderReportHash',
  'humanReviewReceiptHash',
  'anchorCaseCount',
  'anchorAssetCount',
  'faceCriticalAssetCount',
  'faceCriticalAssetsPassed',
  'explicitFocusCropCount',
  'humanReviewConfidence',
  'pairLabelsReadable',
  'preservesAspectRatio',
  'stripsMetadata',
  'containsPathsOrFilenames',
  'reviewerProtocol',
])

const REFERENCE_SHEET_QUALITY_RECEIPT_KEYS = Object.freeze([
  ...REFERENCE_SHEET_QUALITY_IDENTITY_KEYS,
  'schemaVersion',
  'status',
  'receiptHash',
])

const LOCAL_RENDER_REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'anchorPackHash',
  'anchorSheetSha256',
  'layoutProtocolHash',
  'orderedSourceContentHash',
  'anchorCaseCount',
  'anchorAssetCount',
  'faceCriticalAssetCount',
  'automaticFaceMeasurementCount',
  'explicitFocusCropCount',
  'pairLabelsPresent',
  'readingOrderDeterministic',
  'preservesAspectRatio',
  'stripsMetadata',
  'containsPathsOrFilenames',
  'cells',
])

const LOCAL_RENDER_CELL_KEYS = Object.freeze([
  'cellIndex',
  'caseIndex',
  'side',
  'sourceContentSha256',
  'faceCritical',
  'assetRendered',
  'explicitFocusCropRendered',
])

const HUMAN_REVIEW_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'reviewerProtocol',
  'reviewedWithoutSelectorState',
  'anchorPackHash',
  'anchorSheetSha256',
  'layoutProtocolHash',
  'orderedSourceContentHash',
  'anchorCaseCount',
  'anchorAssetCount',
  'faceCriticalAssetCount',
  'faceCriticalAssetsPassed',
  'overallConfidence',
  'pairLabelsReadable',
  'readingOrderConfirmed',
  'preservesAspectRatio',
  'stripsMetadata',
  'containsPathsOrFilenames',
  'cells',
])

const HUMAN_REVIEW_CELL_KEYS = Object.freeze([
  'cellIndex',
  'caseIndex',
  'side',
  'sourceContentSha256',
  'faceCritical',
  'assetPresent',
  'labelReadable',
  'aspectRatioPreserved',
  'fullCompositionVisible',
  'sourceCorrespondenceConfirmed',
  'faceDetailReadable',
  'observation',
])

function nonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReferenceSheetQualityError(
      'INVALID_QUALITY_METRIC',
      `${field} 必须是非负整数。`,
    )
  }
}

function evidenceObject(value: ReferenceSheetEvidence, label: string): unknown {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) return value
  let text: string
  try {
    text = typeof value === 'string'
      ? value
      : new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    throw new ReferenceSheetQualityError('INVALID_EVIDENCE_BYTES', `${label} 不是有效 UTF-8。`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ReferenceSheetQualityError('INVALID_EVIDENCE_JSON', `${label} 不是有效 JSON。`)
  }
  if (text !== JSON.stringify(canonical(parsed))) {
    throw new ReferenceSheetQualityError(
      'NON_CANONICAL_EVIDENCE_BYTES',
      `${label} 的字节必须是无歧义 canonical JSON；也可以直接传解析后的对象。`,
    )
  }
  return parsed
}

export function referenceSheetOrderedSourceContentHash(
  sourceHashes: readonly string[],
): string {
  if (!Array.isArray(sourceHashes) || sourceHashes.length !== 14) {
    throw new ReferenceSheetQualityError(
      'INVALID_ORDERED_SOURCES',
      'ordered source list 必须正好包含 14 个内容哈希。',
    )
  }
  sourceHashes.forEach((value, index) => assertHash(value, `sourceHashes[${index}]`))
  if (new Set(sourceHashes).size !== sourceHashes.length) {
    throw new ReferenceSheetQualityError(
      'DUPLICATE_ANCHOR_SOURCE',
      '14 个锚点图片必须具有互不重复的内容哈希。',
    )
  }
  return sha256([REFERENCE_SHEET_ORDERED_SOURCE_PROTOCOL, ...sourceHashes].join('\u0000'))
}

function cellIdentity(
  value: Record<string, unknown>,
  index: number,
  label: string,
): ReferenceSheetEvidenceCellIdentity {
  const expectedCellIndex = index + 1
  const expectedCaseIndex = Math.floor(index / 2) + 1
  const expectedSide = index % 2 === 0 ? 'A' : 'B'
  if (value.cellIndex !== expectedCellIndex || value.caseIndex !== expectedCaseIndex
    || value.side !== expectedSide) {
    throw new ReferenceSheetQualityError(
      'INVALID_CELL_ORDER',
      `${label} 必须按 7 组 A/B、共 14 格的冻结顺序排列。`,
    )
  }
  assertHash(value.sourceContentSha256, `${label}.sourceContentSha256`)
  if (typeof value.faceCritical !== 'boolean') {
    throw new ReferenceSheetQualityError(
      'INVALID_CELL_IDENTITY',
      `${label}.faceCritical 必须是布尔值。`,
    )
  }
  return {
    cellIndex: expectedCellIndex,
    caseIndex: expectedCaseIndex,
    side: expectedSide,
    sourceContentSha256: value.sourceContentSha256,
    faceCritical: value.faceCritical,
  }
}

function validateLocalRenderReport(value: unknown): ReferenceSheetLocalRenderReport {
  assertExactKeys(value, LOCAL_RENDER_REPORT_KEYS, 'localRenderReport')
  if (value.schemaVersion !== REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA
    || value.status !== 'NEEDS_HUMAN_VISUAL_REVIEW') {
    throw new ReferenceSheetQualityError(
      'INVALID_LOCAL_RENDER_STATUS',
      '本地报告必须使用冻结 schema，且只能停在 NEEDS_HUMAN_VISUAL_REVIEW。',
    )
  }
  assertHash(value.anchorPackHash, 'anchorPackHash')
  assertHash(value.anchorSheetSha256, 'anchorSheetSha256')
  assertHash(value.layoutProtocolHash, 'layoutProtocolHash')
  assertHash(value.orderedSourceContentHash, 'orderedSourceContentHash')
  if (value.anchorCaseCount !== 7 || value.anchorAssetCount !== 14
    || value.faceCriticalAssetCount !== 13 || value.explicitFocusCropCount !== 13) {
    throw new ReferenceSheetQualityError(
      'INVALID_ANCHOR_COUNTS',
      '本地报告必须绑定冻结的 7 组、14 张、13 张关键人脸与 13 个显式 focus crop。',
    )
  }
  nonNegativeInteger(value.automaticFaceMeasurementCount, 'automaticFaceMeasurementCount')
  if (value.automaticFaceMeasurementCount > 13) {
    throw new ReferenceSheetQualityError(
      'INVALID_QUALITY_METRIC',
      'automaticFaceMeasurementCount 不得超过 13。',
    )
  }
  if (value.pairLabelsPresent !== true || value.readingOrderDeterministic !== true
    || value.preservesAspectRatio !== true || value.stripsMetadata !== true
    || value.containsPathsOrFilenames !== false) {
    throw new ReferenceSheetQualityError(
      'LOCAL_RENDER_SAFETY_FAILED',
      '本地报告必须证明标签、顺序、比例、元数据和路径隐私门禁。',
    )
  }
  if (!Array.isArray(value.cells) || value.cells.length !== 14) {
    throw new ReferenceSheetQualityError(
      'INCOMPLETE_LOCAL_CELLS',
      '本地报告必须逐格覆盖全部 14 张锚点图片。',
    )
  }
  const cells = value.cells.map((rawCell, index): ReferenceSheetLocalRenderCell => {
    assertExactKeys(rawCell, LOCAL_RENDER_CELL_KEYS, `localRenderReport.cells[${index}]`)
    const identity = cellIdentity(rawCell, index, `localRenderReport.cells[${index}]`)
    if (rawCell.assetRendered !== true
      || rawCell.explicitFocusCropRendered !== identity.faceCritical) {
      throw new ReferenceSheetQualityError(
        'LOCAL_CELL_NOT_RENDERED',
        `localRenderReport.cells[${index}] 必须渲染资产，且仅关键人脸格带显式 focus crop。`,
      )
    }
    return { ...identity, assetRendered: true, explicitFocusCropRendered: identity.faceCritical }
  })
  if (cells.filter(cell => cell.faceCritical).length !== 13
    || cells.filter(cell => cell.explicitFocusCropRendered).length !== 13) {
    throw new ReferenceSheetQualityError(
      'FACE_DETAIL_NOT_COVERED',
      '本地报告必须明确覆盖 13/13 个关键人脸 focus crop。',
    )
  }
  const orderedSourceContentHash = referenceSheetOrderedSourceContentHash(
    cells.map(cell => cell.sourceContentSha256),
  )
  if (value.orderedSourceContentHash !== orderedSourceContentHash) {
    throw new ReferenceSheetQualityError(
      'ORDERED_SOURCE_HASH_MISMATCH',
      '本地报告的 ordered source hash 与逐格来源不一致。',
    )
  }
  return {
    schemaVersion: REFERENCE_SHEET_LOCAL_RENDER_REPORT_SCHEMA,
    status: 'NEEDS_HUMAN_VISUAL_REVIEW',
    anchorPackHash: value.anchorPackHash,
    anchorSheetSha256: value.anchorSheetSha256,
    layoutProtocolHash: value.layoutProtocolHash,
    orderedSourceContentHash,
    anchorCaseCount: 7,
    anchorAssetCount: 14,
    faceCriticalAssetCount: 13,
    automaticFaceMeasurementCount: value.automaticFaceMeasurementCount,
    explicitFocusCropCount: 13,
    pairLabelsPresent: true,
    readingOrderDeterministic: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    cells,
  }
}

function pathFreeObservation(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\u0000')
    || /(?:\/Users\/|file:\/\/|[A-Za-z]:\\|\.(?:jpe?g|heic|png|tiff?)\b)/iu.test(value)) {
    throw new ReferenceSheetQualityError(
      'UNSAFE_HUMAN_OBSERVATION',
      `${label} 必须是长度受限且不含路径或文件名的说明。`,
    )
  }
}

function validateHumanVisualReviewReceipt(value: unknown): ReferenceSheetHumanVisualReviewReceipt {
  assertExactKeys(value, HUMAN_REVIEW_RECEIPT_KEYS, 'humanVisualReviewReceipt')
  if (value.schemaVersion !== REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA || value.status !== 'PASS'
    || value.reviewerProtocol !== 'independent-human-visual-review/v1'
    || value.reviewedWithoutSelectorState !== true) {
    throw new ReferenceSheetQualityError(
      'HUMAN_REVIEW_NOT_PASS',
      '人工复核必须由隔离协议完成、不可见 selector 状态，并明确为 PASS。',
    )
  }
  assertHash(value.anchorPackHash, 'anchorPackHash')
  assertHash(value.anchorSheetSha256, 'anchorSheetSha256')
  assertHash(value.layoutProtocolHash, 'layoutProtocolHash')
  assertHash(value.orderedSourceContentHash, 'orderedSourceContentHash')
  if (value.anchorCaseCount !== 7 || value.anchorAssetCount !== 14
    || value.faceCriticalAssetCount !== 13 || value.faceCriticalAssetsPassed !== 13) {
    throw new ReferenceSheetQualityError(
      'INVALID_ANCHOR_COUNTS',
      '人工复核必须绑定冻结的 7 组、14 张，并逐格通过 13/13 张关键人脸。',
    )
  }
  if (typeof value.overallConfidence !== 'number' || !Number.isFinite(value.overallConfidence)
    || value.overallConfidence < 0.9 || value.overallConfidence > 1) {
    throw new ReferenceSheetQualityError(
      'HUMAN_REVIEW_CONFIDENCE_TOO_LOW',
      '人工 PASS 的 overallConfidence 必须在 0.9 到 1 之间。',
    )
  }
  if (value.pairLabelsReadable !== true || value.readingOrderConfirmed !== true
    || value.preservesAspectRatio !== true || value.stripsMetadata !== true
    || value.containsPathsOrFilenames !== false) {
    throw new ReferenceSheetQualityError(
      'HUMAN_REVIEW_SAFETY_FAILED',
      '人工复核必须确认标签、顺序、比例、元数据和路径隐私门禁。',
    )
  }
  if (!Array.isArray(value.cells) || value.cells.length !== 14) {
    throw new ReferenceSheetQualityError(
      'INCOMPLETE_HUMAN_CELLS',
      '人工复核必须逐格覆盖全部 14 张锚点图片。',
    )
  }
  const cells = value.cells.map((rawCell, index): ReferenceSheetHumanReviewCell => {
    assertExactKeys(rawCell, HUMAN_REVIEW_CELL_KEYS, `humanVisualReviewReceipt.cells[${index}]`)
    const identity = cellIdentity(rawCell, index, `humanVisualReviewReceipt.cells[${index}]`)
    pathFreeObservation(rawCell.observation, `humanVisualReviewReceipt.cells[${index}].observation`)
    if (rawCell.assetPresent !== true || rawCell.labelReadable !== true
      || rawCell.aspectRatioPreserved !== true || rawCell.fullCompositionVisible !== true
      || rawCell.sourceCorrespondenceConfirmed !== true
      || rawCell.faceDetailReadable !== (identity.faceCritical ? true : null)) {
      throw new ReferenceSheetQualityError(
        'HUMAN_CELL_NOT_PASS',
        `humanVisualReviewReceipt.cells[${index}] 未完整通过逐格视觉门禁。`,
      )
    }
    return {
      ...identity,
      assetPresent: true,
      labelReadable: true,
      aspectRatioPreserved: true,
      fullCompositionVisible: true,
      sourceCorrespondenceConfirmed: true,
      faceDetailReadable: identity.faceCritical ? true : null,
      observation: rawCell.observation,
    }
  })
  if (cells.filter(cell => cell.faceCritical && cell.faceDetailReadable === true).length !== 13) {
    throw new ReferenceSheetQualityError(
      'FACE_DETAIL_NOT_VALIDATED',
      '人工复核没有逐格确认 13/13 个关键人脸。',
    )
  }
  const orderedSourceContentHash = referenceSheetOrderedSourceContentHash(
    cells.map(cell => cell.sourceContentSha256),
  )
  if (value.orderedSourceContentHash !== orderedSourceContentHash) {
    throw new ReferenceSheetQualityError(
      'ORDERED_SOURCE_HASH_MISMATCH',
      '人工复核的 ordered source hash 与逐格来源不一致。',
    )
  }
  return {
    schemaVersion: REFERENCE_SHEET_HUMAN_REVIEW_SCHEMA,
    status: 'PASS',
    reviewerProtocol: 'independent-human-visual-review/v1',
    reviewedWithoutSelectorState: true,
    anchorPackHash: value.anchorPackHash,
    anchorSheetSha256: value.anchorSheetSha256,
    layoutProtocolHash: value.layoutProtocolHash,
    orderedSourceContentHash,
    anchorCaseCount: 7,
    anchorAssetCount: 14,
    faceCriticalAssetCount: 13,
    faceCriticalAssetsPassed: 13,
    overallConfidence: value.overallConfidence,
    pairLabelsReadable: true,
    readingOrderConfirmed: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    cells,
  }
}

function validateReferenceSheetQualityIdentity(value: unknown): ReferenceSheetQualityReceiptIdentity {
  assertExactKeys(value, REFERENCE_SHEET_QUALITY_IDENTITY_KEYS, 'qualityReceipt identity')
  assertHash(value.anchorPackHash, 'anchorPackHash')
  assertHash(value.anchorSheetSha256, 'anchorSheetSha256')
  assertHash(value.layoutProtocolHash, 'layoutProtocolHash')
  assertHash(value.orderedSourceContentHash, 'orderedSourceContentHash')
  assertHash(value.localRenderReportHash, 'localRenderReportHash')
  assertHash(value.humanReviewReceiptHash, 'humanReviewReceiptHash')
  if (value.localRenderReportHash === value.humanReviewReceiptHash) {
    throw new ReferenceSheetQualityError('DUAL_REVIEW_REQUIRED', '两份独立证据不得具有相同哈希。')
  }
  if (value.anchorCaseCount !== 7 || value.anchorAssetCount !== 14
    || value.faceCriticalAssetCount !== 13 || value.faceCriticalAssetsPassed !== 13
    || value.explicitFocusCropCount !== 13) {
    throw new ReferenceSheetQualityError(
      'INVALID_ANCHOR_COUNTS',
      '最终 PASS 必须冻结 7/14/13，并绑定 13 个显式 focus crop。',
    )
  }
  if (typeof value.humanReviewConfidence !== 'number' || !Number.isFinite(value.humanReviewConfidence)
    || value.humanReviewConfidence < 0.9 || value.humanReviewConfidence > 1) {
    throw new ReferenceSheetQualityError(
      'HUMAN_REVIEW_CONFIDENCE_TOO_LOW',
      '最终 PASS 必须绑定 0.9 到 1 的人工复核置信度。',
    )
  }
  if (value.pairLabelsReadable !== true || value.preservesAspectRatio !== true
    || value.stripsMetadata !== true || value.containsPathsOrFilenames !== false
    || value.reviewerProtocol !== 'local-render-and-human-review/v1') {
    throw new ReferenceSheetQualityError(
      'REFERENCE_SHEET_SAFETY_FAILED',
      '最终 PASS 必须绑定双重复核以及标签、比例、元数据和路径隐私门禁。',
    )
  }
  return {
    anchorPackHash: value.anchorPackHash,
    anchorSheetSha256: value.anchorSheetSha256,
    layoutProtocolHash: value.layoutProtocolHash,
    orderedSourceContentHash: value.orderedSourceContentHash,
    localRenderReportHash: value.localRenderReportHash,
    humanReviewReceiptHash: value.humanReviewReceiptHash,
    anchorCaseCount: 7,
    anchorAssetCount: 14,
    faceCriticalAssetCount: 13,
    faceCriticalAssetsPassed: 13,
    explicitFocusCropCount: 13,
    humanReviewConfidence: value.humanReviewConfidence,
    pairLabelsReadable: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    reviewerProtocol: 'local-render-and-human-review/v1',
  }
}

/**
 * A PASS receipt can only be created when every face-critical example remains
 * readable in the rendered sheet. The receipt binds pixels and layout, so a
 * later re-render cannot inherit the old approval.
 */
export function freezeReferenceSheetQualityReceipt(
  input: ReferenceSheetQualityReceiptInput,
): FrozenReferenceSheetQualityReceipt {
  assertExactKeys(input, REFERENCE_SHEET_QUALITY_FACTORY_KEYS, 'qualityReceipt factory input')
  const local = validateLocalRenderReport(
    evidenceObject(input.localRenderReport, 'localRenderReport'),
  )
  const human = validateHumanVisualReviewReceipt(
    evidenceObject(input.humanVisualReviewReceipt, 'humanVisualReviewReceipt'),
  )
  if (local.anchorPackHash !== human.anchorPackHash
    || local.anchorSheetSha256 !== human.anchorSheetSha256
    || local.layoutProtocolHash !== human.layoutProtocolHash
    || local.orderedSourceContentHash !== human.orderedSourceContentHash
    || local.anchorCaseCount !== human.anchorCaseCount
    || local.anchorAssetCount !== human.anchorAssetCount
    || local.faceCriticalAssetCount !== human.faceCriticalAssetCount) {
    throw new ReferenceSheetQualityError(
      'EVIDENCE_IDENTITY_MISMATCH',
      '本地报告与人工复核没有绑定同一 pack、sheet、layout、ordered sources 与 7/14/13。',
    )
  }
  for (let index = 0; index < 14; index += 1) {
    const localCell = local.cells[index]
    const humanCell = human.cells[index]
    if (localCell.cellIndex !== humanCell.cellIndex || localCell.caseIndex !== humanCell.caseIndex
      || localCell.side !== humanCell.side
      || localCell.sourceContentSha256 !== humanCell.sourceContentSha256
      || localCell.faceCritical !== humanCell.faceCritical) {
      throw new ReferenceSheetQualityError(
        'EVIDENCE_CELL_IDENTITY_MISMATCH',
        `本地报告与人工复核的第 ${index + 1} 格不是同一来源资产。`,
      )
    }
  }
  const validated: ReferenceSheetQualityReceiptIdentity = {
    anchorPackHash: local.anchorPackHash,
    anchorSheetSha256: local.anchorSheetSha256,
    layoutProtocolHash: local.layoutProtocolHash,
    orderedSourceContentHash: local.orderedSourceContentHash,
    localRenderReportHash: receiptHash(local),
    humanReviewReceiptHash: receiptHash(human),
    anchorCaseCount: 7,
    anchorAssetCount: 14,
    faceCriticalAssetCount: 13,
    faceCriticalAssetsPassed: 13,
    explicitFocusCropCount: 13,
    humanReviewConfidence: human.overallConfidence,
    pairLabelsReadable: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    reviewerProtocol: 'local-render-and-human-review/v1',
  }
  const withoutHash = Object.freeze({
    schemaVersion: REFERENCE_SHEET_QUALITY_SCHEMA,
    status: 'PASS' as const,
    ...validated,
  })
  return Object.freeze({ ...withoutHash, receiptHash: receiptHash(withoutHash) })
}

/** Revalidate schema, dual-review evidence, metrics, privacy flags and signature. */
export function assertReferenceSheetQualityReceipt(
  value: unknown,
): asserts value is FrozenReferenceSheetQualityReceipt {
  assertExactKeys(value, REFERENCE_SHEET_QUALITY_RECEIPT_KEYS, 'qualityReceipt')
  if (value.schemaVersion !== REFERENCE_SHEET_QUALITY_SCHEMA) {
    throw new ReferenceSheetQualityError(
      'UNSUPPORTED_QUALITY_RECEIPT_SCHEMA',
      `qualityReceipt.schemaVersion 必须是 ${REFERENCE_SHEET_QUALITY_SCHEMA}。`,
    )
  }
  if (value.status !== 'PASS') {
    throw new ReferenceSheetQualityError('QUALITY_RECEIPT_NOT_PASS', '参考图版 QA 收据必须是 PASS。')
  }
  const actual = value.receiptHash
  assertHash(actual, 'qualityReceipt.receiptHash')
  const validated = validateReferenceSheetQualityIdentity({
    anchorPackHash: value.anchorPackHash,
    anchorSheetSha256: value.anchorSheetSha256,
    layoutProtocolHash: value.layoutProtocolHash,
    orderedSourceContentHash: value.orderedSourceContentHash,
    localRenderReportHash: value.localRenderReportHash,
    humanReviewReceiptHash: value.humanReviewReceiptHash,
    anchorCaseCount: value.anchorCaseCount,
    anchorAssetCount: value.anchorAssetCount,
    faceCriticalAssetCount: value.faceCriticalAssetCount,
    faceCriticalAssetsPassed: value.faceCriticalAssetsPassed,
    explicitFocusCropCount: value.explicitFocusCropCount,
    humanReviewConfidence: value.humanReviewConfidence,
    pairLabelsReadable: value.pairLabelsReadable,
    preservesAspectRatio: value.preservesAspectRatio,
    stripsMetadata: value.stripsMetadata,
    containsPathsOrFilenames: value.containsPathsOrFilenames,
    reviewerProtocol: value.reviewerProtocol,
  })
  const withoutHash = {
    schemaVersion: REFERENCE_SHEET_QUALITY_SCHEMA,
    status: 'PASS' as const,
    ...validated,
  }
  if (receiptHash(withoutHash) !== actual) {
    throw new ReferenceSheetQualityError('QUALITY_RECEIPT_TAMPERED', '参考图版 QA 收据哈希不匹配。')
  }
}

/** Load untrusted persisted data into a newly allocated immutable receipt. */
export function loadReferenceSheetQualityReceipt(value: unknown): FrozenReferenceSheetQualityReceipt {
  assertReferenceSheetQualityReceipt(value)
  return Object.freeze({ ...value })
}

const PAIR_CANDIDATE_SHEET_INPUT_KEYS = Object.freeze([
  'combinedLayoutProtocolHash',
  'firstAnonymousID',
  'secondAnonymousID',
  'firstSourceJpegBase64',
  'secondSourceJpegBase64',
  'firstFaceFocus',
  'secondFaceFocus',
  'candidateSheetJpegBase64',
  'renderEvidence',
])

const PAIR_CANDIDATE_SHEET_IDENTITY_KEYS = Object.freeze([
  'combinedLayoutProtocolHash',
  'candidateLayoutProtocol',
  'firstAnonymousID',
  'secondAnonymousID',
  'firstSourceJpegSha256',
  'secondSourceJpegSha256',
  'firstFaceFocusHash',
  'secondFaceFocusHash',
  'candidateSheetSha256',
  'renderEvidenceHash',
  'faceInsetCount',
  'labelsReadable',
  'preservesAspectRatio',
  'stripsMetadata',
  'containsPathsOrFilenames',
])

const PAIR_CANDIDATE_SHEET_RECEIPT_KEYS = Object.freeze([
  ...PAIR_CANDIDATE_SHEET_IDENTITY_KEYS,
  'schemaVersion',
  'firstLabel',
  'secondLabel',
  'receiptHash',
])

const PAIR_CANDIDATE_RENDER_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'status', 'layoutProtocol', 'candidateSheetSha256',
  'width', 'height', 'pairCount', 'assetCount', 'faceInsetCount',
  'preservesAspectRatio', 'stripsMetadata', 'containsPathsOrFilenames', 'cells',
])

const PAIR_CANDIDATE_RENDER_CELL_KEYS = Object.freeze([
  'cellIndex', 'label', 'faceCritical', 'faceRegionSource',
  'anonymousID', 'sourceContentSha256',
])

function safeAnonymousID(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /(?:\/|\\|\.{2}|\.(?:jpe?g|heic|png|tiff?)\b)/iu.test(value)) {
    throw new ReferenceSheetQualityError('UNSAFE_ANONYMOUS_ID', `${label} 不是安全匿名 ID。`)
  }
}

function validatePairFocus(value: unknown, label: string): PairCandidateFaceFocus {
  assertExactKeys(value, ['center_x', 'center_y', 'side_fraction'], label)
  for (const key of ['center_x', 'center_y', 'side_fraction'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new ReferenceSheetQualityError('INVALID_PAIR_FOCUS', `${label}.${key} 必须是有限数。`)
    }
  }
  if (value.center_x < 0 || value.center_x > 1 || value.center_y < 0 || value.center_y > 1
    || value.side_fraction < 0.05 || value.side_fraction > 0.8) {
    throw new ReferenceSheetQualityError('INVALID_PAIR_FOCUS', `${label} 超出冻结坐标范围。`)
  }
  return {
    center_x: value.center_x,
    center_y: value.center_y,
    side_fraction: value.side_fraction,
  }
}

export function pairCandidateFaceFocusHash(value: PairCandidateFaceFocus): string {
  return receiptHash(validatePairFocus(value, 'faceFocus'))
}

function validatePairRenderEvidence(
  value: unknown,
  expected: Readonly<{
    firstAnonymousID: string
    secondAnonymousID: string
    firstSourceJpegSha256: string
    secondSourceJpegSha256: string
    candidateSheetSha256: string
  }>,
): PairCandidateRenderEvidence {
  assertExactKeys(value, PAIR_CANDIDATE_RENDER_EVIDENCE_KEYS, 'pair renderEvidence')
  if (value.schemaVersion !== PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA
    || value.status !== 'READY_FOR_PAIRWISE'
    || value.layoutProtocol !== PAIR_CANDIDATE_LAYOUT_PROTOCOL
    || value.width !== 3072 || value.height !== 1536
    || value.pairCount !== 1 || value.assetCount !== 2 || value.faceInsetCount !== 2
    || value.preservesAspectRatio !== true || value.stripsMetadata !== true
    || value.containsPathsOrFilenames !== false) {
    throw new ReferenceSheetQualityError(
      'PAIR_RENDER_NOT_READY',
      '双候选渲染证据必须证明 3072x1536、2/2 focus inset、比例、元数据和路径门禁。',
    )
  }
  assertHash(value.candidateSheetSha256, 'renderEvidence.candidateSheetSha256')
  if (value.candidateSheetSha256 !== expected.candidateSheetSha256) {
    throw new ReferenceSheetQualityError('PAIR_RENDER_SHEET_MISMATCH', '渲染证据没有绑定当前图版像素。')
  }
  if (!Array.isArray(value.cells) || value.cells.length !== 2) {
    throw new ReferenceSheetQualityError('PAIR_RENDER_CELLS_INCOMPLETE', '渲染证据必须覆盖 FIRST/SECOND。')
  }
  const expectedCells = [
    { cellIndex: 1, label: 'FIRST', anonymousID: expected.firstAnonymousID,
      sourceContentSha256: expected.firstSourceJpegSha256 },
    { cellIndex: 2, label: 'SECOND', anonymousID: expected.secondAnonymousID,
      sourceContentSha256: expected.secondSourceJpegSha256 },
  ] as const
  const cells = value.cells.map((raw, index): PairCandidateRenderCell => {
    assertExactKeys(raw, PAIR_CANDIDATE_RENDER_CELL_KEYS, `renderEvidence.cells[${index}]`)
    const wanted = expectedCells[index]
    if (raw.cellIndex !== wanted.cellIndex || raw.label !== wanted.label
      || raw.faceCritical !== true || raw.faceRegionSource !== 'explicit_focus_unverified'
      || raw.anonymousID !== wanted.anonymousID
      || raw.sourceContentSha256 !== wanted.sourceContentSha256) {
      throw new ReferenceSheetQualityError(
        'PAIR_RENDER_CELL_MISMATCH',
        `双候选渲染证据第 ${index + 1} 格没有绑定当前顺序、来源或 focus inset。`,
      )
    }
    return { ...wanted, faceCritical: true, faceRegionSource: 'explicit_focus_unverified' }
  }) as [PairCandidateRenderCell, PairCandidateRenderCell]
  return {
    schemaVersion: PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA,
    status: 'READY_FOR_PAIRWISE',
    layoutProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    candidateSheetSha256: expected.candidateSheetSha256,
    width: 3072,
    height: 1536,
    pairCount: 1,
    assetCount: 2,
    faceInsetCount: 2,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    cells,
  }
}

function validatePairCandidateSheetIdentity(value: unknown): PairCandidateSheetReceiptIdentity {
  assertExactKeys(value, PAIR_CANDIDATE_SHEET_IDENTITY_KEYS, 'pairReceipt identity')
  assertHash(value.combinedLayoutProtocolHash, 'combinedLayoutProtocolHash')
  if (value.candidateLayoutProtocol !== PAIR_CANDIDATE_LAYOUT_PROTOCOL) {
    throw new ReferenceSheetQualityError('INVALID_PAIR_LAYOUT', '双候选图版布局协议不匹配。')
  }
  safeAnonymousID(value.firstAnonymousID, 'firstAnonymousID')
  safeAnonymousID(value.secondAnonymousID, 'secondAnonymousID')
  if (value.firstAnonymousID === value.secondAnonymousID) {
    throw new ReferenceSheetQualityError('DUPLICATE_PAIR_SOURCE', 'FIRST/SECOND 不得是同一匿名照片。')
  }
  assertHash(value.firstSourceJpegSha256, 'firstSourceJpegSha256')
  assertHash(value.secondSourceJpegSha256, 'secondSourceJpegSha256')
  assertHash(value.firstFaceFocusHash, 'firstFaceFocusHash')
  assertHash(value.secondFaceFocusHash, 'secondFaceFocusHash')
  assertHash(value.candidateSheetSha256, 'candidateSheetSha256')
  assertHash(value.renderEvidenceHash, 'renderEvidenceHash')
  if (value.faceInsetCount !== 2) {
    throw new ReferenceSheetQualityError('PAIR_FACE_INSETS_REQUIRED', '双候选图版必须包含 2/2 focus inset。')
  }
  if (value.labelsReadable !== true || value.preservesAspectRatio !== true
    || value.stripsMetadata !== true || value.containsPathsOrFilenames !== false) {
    throw new ReferenceSheetQualityError(
      'PAIR_SHEET_SAFETY_FAILED',
      '双候选图版必须明确 FIRST/SECOND、保持比例并去除元数据。',
    )
  }
  return {
    combinedLayoutProtocolHash: value.combinedLayoutProtocolHash,
    candidateLayoutProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    firstAnonymousID: value.firstAnonymousID,
    secondAnonymousID: value.secondAnonymousID,
    firstSourceJpegSha256: value.firstSourceJpegSha256,
    secondSourceJpegSha256: value.secondSourceJpegSha256,
    firstFaceFocusHash: value.firstFaceFocusHash,
    secondFaceFocusHash: value.secondFaceFocusHash,
    candidateSheetSha256: value.candidateSheetSha256,
    renderEvidenceHash: value.renderEvidenceHash,
    faceInsetCount: 2,
    labelsReadable: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
  }
}

export function freezePairCandidateSheetReceipt(
  input: PairCandidateSheetReceiptInput,
): FrozenPairCandidateSheetReceipt {
  assertExactKeys(input, PAIR_CANDIDATE_SHEET_INPUT_KEYS, 'pairReceipt factory input')
  assertHash(input.combinedLayoutProtocolHash, 'combinedLayoutProtocolHash')
  safeAnonymousID(input.firstAnonymousID, 'firstAnonymousID')
  safeAnonymousID(input.secondAnonymousID, 'secondAnonymousID')
  if (input.firstAnonymousID === input.secondAnonymousID) {
    throw new ReferenceSheetQualityError('DUPLICATE_PAIR_SOURCE', 'FIRST/SECOND 不得是同一匿名照片。')
  }
  const firstSourceJpegSha256 = sha256(jpegBytes(input.firstSourceJpegBase64, 'firstSourceJpegBase64'))
  const secondSourceJpegSha256 = sha256(jpegBytes(input.secondSourceJpegBase64, 'secondSourceJpegBase64'))
  const candidateBytes = jpegBytes(input.candidateSheetJpegBase64, 'candidateSheetJpegBase64')
  assertJpegHasNoPrivateMetadata(candidateBytes, 'candidateSheetJpegBase64')
  const candidateSheetSha256 = sha256(candidateBytes)
  const firstFaceFocus = validatePairFocus(input.firstFaceFocus, 'firstFaceFocus')
  const secondFaceFocus = validatePairFocus(input.secondFaceFocus, 'secondFaceFocus')
  const renderEvidence = validatePairRenderEvidence(
    evidenceObject(input.renderEvidence, 'renderEvidence'),
    {
      firstAnonymousID: input.firstAnonymousID,
      secondAnonymousID: input.secondAnonymousID,
      firstSourceJpegSha256,
      secondSourceJpegSha256,
      candidateSheetSha256,
    },
  )
  const validated: PairCandidateSheetReceiptIdentity = {
    combinedLayoutProtocolHash: input.combinedLayoutProtocolHash,
    candidateLayoutProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    firstAnonymousID: input.firstAnonymousID,
    secondAnonymousID: input.secondAnonymousID,
    firstSourceJpegSha256,
    secondSourceJpegSha256,
    firstFaceFocusHash: receiptHash(firstFaceFocus),
    secondFaceFocusHash: receiptHash(secondFaceFocus),
    candidateSheetSha256,
    renderEvidenceHash: receiptHash(renderEvidence),
    faceInsetCount: 2,
    labelsReadable: true,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
  }
  const withoutHash = Object.freeze({
    schemaVersion: PAIR_CANDIDATE_SHEET_SCHEMA,
    firstLabel: 'FIRST' as const,
    secondLabel: 'SECOND' as const,
    ...validated,
  })
  return Object.freeze({ ...withoutHash, receiptHash: receiptHash(withoutHash) })
}

function jpegBytes(jpegBase64: string, label: string): Uint8Array {
  if (typeof jpegBase64 !== 'string' || jpegBase64.length === 0) {
    throw new ReferenceSheetQualityError('EMPTY_JPEG', `${label} 不能为空。`)
  }
  const data = new Uint8Array(Buffer.from(jpegBase64, 'base64'))
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8
    || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) {
    throw new ReferenceSheetQualityError('INVALID_JPEG', `${label} 不是完整 JPEG。`)
  }
  return data
}

function assertJpegHasNoPrivateMetadata(data: Uint8Array, label: string): void {
  let offset = 2
  while (offset < data.byteLength) {
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset]
    offset += 1
    if (marker === 0xd9) return
    if (marker === 0xda) {
      // The entropy-coded payload may contain escaped 0xff bytes. The engine
      // sanitizer already scans through every later segment; a runtime receipt
      // only accepts candidate sheets produced by that versioned engine report.
      return
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (offset + 2 > data.byteLength) {
      throw new ReferenceSheetQualityError('INVALID_JPEG', `${label} 含截断 JPEG 段。`)
    }
    const length = data[offset] * 256 + data[offset + 1]
    if (length < 2 || offset + length > data.byteLength) {
      throw new ReferenceSheetQualityError('INVALID_JPEG', `${label} 含无效 JPEG 段。`)
    }
    if (marker === 0xe1 || marker === 0xed || marker === 0xfe) {
      throw new ReferenceSheetQualityError(
        'PAIR_SHEET_PRIVATE_METADATA',
        `${label} 含 APP1/APP13/COM 隐私段。`,
      )
    }
    offset += length
  }
  throw new ReferenceSheetQualityError('INVALID_JPEG', `${label} 缺少 JPEG 结束标记。`)
}

export function assertPairCandidateSheetReceipt(
  receipt: unknown,
): asserts receipt is FrozenPairCandidateSheetReceipt {
  assertExactKeys(receipt, PAIR_CANDIDATE_SHEET_RECEIPT_KEYS, 'pairReceipt')
  if (receipt.schemaVersion !== PAIR_CANDIDATE_SHEET_SCHEMA
    || receipt.firstLabel !== 'FIRST' || receipt.secondLabel !== 'SECOND') {
    throw new ReferenceSheetQualityError(
      'INVALID_PAIR_RECEIPT_IDENTITY',
      '双候选图版收据的 schema 或 FIRST/SECOND 标签无效。',
    )
  }
  const actual = receipt.receiptHash
  assertHash(actual, 'pairReceipt.receiptHash')
  const validated = validatePairCandidateSheetIdentity({
    combinedLayoutProtocolHash: receipt.combinedLayoutProtocolHash,
    candidateLayoutProtocol: receipt.candidateLayoutProtocol,
    firstAnonymousID: receipt.firstAnonymousID,
    secondAnonymousID: receipt.secondAnonymousID,
    firstSourceJpegSha256: receipt.firstSourceJpegSha256,
    secondSourceJpegSha256: receipt.secondSourceJpegSha256,
    firstFaceFocusHash: receipt.firstFaceFocusHash,
    secondFaceFocusHash: receipt.secondFaceFocusHash,
    candidateSheetSha256: receipt.candidateSheetSha256,
    renderEvidenceHash: receipt.renderEvidenceHash,
    faceInsetCount: receipt.faceInsetCount,
    labelsReadable: receipt.labelsReadable,
    preservesAspectRatio: receipt.preservesAspectRatio,
    stripsMetadata: receipt.stripsMetadata,
    containsPathsOrFilenames: receipt.containsPathsOrFilenames,
  })
  const withoutHash = {
    schemaVersion: PAIR_CANDIDATE_SHEET_SCHEMA,
    firstLabel: 'FIRST' as const,
    secondLabel: 'SECOND' as const,
    ...validated,
  }
  if (receiptHash(withoutHash) !== actual) {
    throw new ReferenceSheetQualityError('PAIR_RECEIPT_TAMPERED', '双候选图版收据哈希不匹配。')
  }
}

export interface AnchoredAttachmentInput {
  profile: PortraitEvaluationProfile
  stage: Extract<PortraitEvaluationStage, 'high' | 'pairwise'>
  protocol: Extract<VisualAnchorAttachmentProtocol, { id: 'reference-sheet/v2' }>
  qualityReceipt: FrozenReferenceSheetQualityReceipt
  anchorSheetJpegBase64: string
  candidateJpegBase64: string
  limits: AttachmentLimits
  pairCandidateReceipt?: FrozenPairCandidateSheetReceipt
}

/**
 * Last local gate before a C image request. It returns ordered JPEGs but never
 * writes them. The caller may pass them to Harness only after this succeeds.
 */
export function prepareAnchoredAttachments(input: AnchoredAttachmentInput): Readonly<{
  jpegs: readonly [string, string]
  totalBytes: number
}> {
  if (input.profile.arm !== 'C' || input.profile.visualAnchorPackHash === undefined) {
    throw new ReferenceSheetQualityError('VISUAL_PROFILE_REQUIRED', '只有 C high/pairwise 可使用参考图版。')
  }
  assertReferenceSheetQualityReceipt(input.qualityReceipt)
  const anchorBytes = jpegBytes(input.anchorSheetJpegBase64, 'anchorSheetJpegBase64')
  const candidateBytes = jpegBytes(input.candidateJpegBase64, 'candidateJpegBase64')
  const anchorHash = sha256(anchorBytes)
  if (input.qualityReceipt.anchorPackHash !== input.profile.visualAnchorPackHash
    || input.protocol.anchorSheetSha256 !== anchorHash
    || input.qualityReceipt.anchorSheetSha256 !== anchorHash
    || input.protocol.layoutProtocolHash !== input.qualityReceipt.layoutProtocolHash
    || input.protocol.qualityReceiptHash !== input.qualityReceipt.receiptHash) {
    throw new ReferenceSheetQualityError(
      'REFERENCE_SHEET_IDENTITY_MISMATCH',
      'C profile、锚点图版、布局协议与 QA 收据不是同一冻结资产。',
    )
  }
  if (input.stage === 'pairwise') {
    if (!input.pairCandidateReceipt) {
      throw new ReferenceSheetQualityError(
        'PAIR_SHEET_RECEIPT_REQUIRED',
        'C pairwise 必须证明 FIRST/SECOND 双候选图版的来源与顺序。',
      )
    }
    assertPairCandidateSheetReceipt(input.pairCandidateReceipt)
    if (input.pairCandidateReceipt.combinedLayoutProtocolHash !== input.protocol.layoutProtocolHash
      || input.pairCandidateReceipt.candidateSheetSha256 !== sha256(candidateBytes)) {
      throw new ReferenceSheetQualityError(
        'PAIR_SHEET_IDENTITY_MISMATCH',
        '双候选图版像素或布局协议与冻结收据不匹配。',
      )
    }
  } else if (input.pairCandidateReceipt) {
    throw new ReferenceSheetQualityError(
      'UNEXPECTED_PAIR_SHEET_RECEIPT',
      '单张 high 请求不得携带双候选图版收据。',
    )
  }
  assertPortraitAttachmentCapacity(
    input.profile,
    input.stage,
    input.limits,
    input.protocol,
    { imageByteSizes: [anchorBytes.byteLength, candidateBytes.byteLength] },
  )
  return Object.freeze({
    // Frozen order is part of reference-sheet/v2: examples first, target second.
    jpegs: Object.freeze([
      input.anchorSheetJpegBase64,
      input.candidateJpegBase64,
    ]) as unknown as readonly [string, string],
    totalBytes: anchorBytes.byteLength + candidateBytes.byteLength,
  })
}
