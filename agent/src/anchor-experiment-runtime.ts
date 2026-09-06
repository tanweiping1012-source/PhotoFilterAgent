import { createHash } from 'node:crypto'
import {
  loadReferenceSheetQualityReceipt,
  type FrozenReferenceSheetQualityReceipt,
} from './reference-sheet-quality.ts'
import {
  PAIR_CANDIDATE_LAYOUT_PROTOCOL,
} from './reference-sheet-quality.ts'
import type { VisualAnchorRuntime } from './portrait-anchor-vision.ts'
import { PORTRAIT_ANCHOR_RUBRIC_VERSION } from './portrait-anchor-rubric.ts'

export const ANCHOR_RUNTIME_BUNDLE_SCHEMA = 'photo-filter-anchor-runtime-bundle/v1' as const
export const ANCHOR_CANDIDATE_OVERLAP_PROTOCOL = 'anchor-candidate-overlap/v1' as const

type Hash = string

interface VisualAnchorPackImage {
  slot: 'A' | 'B'
  asset_ref: string
  absolute_tier: string
}

interface VisualAnchorPackCase {
  anchor_id: string
  images: readonly VisualAnchorPackImage[]
  rationale_zh: string
}

interface VisualAnchorPackDocument {
  schema: 'photo-filter-visual-anchor-pack/v1'
  status: 'frozen_for_experiment'
  rubric_version: string
  privacy: {
    contains_absolute_paths: false
    contains_filenames: false
    contains_oracle_data: false
    contains_original_asset_ids: false
  }
  anchors: readonly VisualAnchorPackCase[]
}

export interface AnchorExperimentBundleInput {
  /** Exact raw JSON bytes; their SHA-256 is the immutable pack identity. */
  anchorPackBytes: Uint8Array
  /** Exact JPEG bytes reviewed by the independent visual reviewer. */
  anchorSheetJpeg: Uint8Array
  referenceSheetQualityReceipt: unknown
  /** Original-content hashes for exactly the 14 runtime examples, locally resolved. */
  orderedAnchorOriginalContentHashes: readonly string[]
}

export interface PreparedAnchorExperimentBundle {
  readonly schemaVersion: typeof ANCHOR_RUNTIME_BUNDLE_SCHEMA
  readonly packHash: Hash
  readonly anchorSheetSha256: Hash
  readonly layoutProtocolHash: Hash
  readonly qualityReceipt: FrozenReferenceSheetQualityReceipt
  readonly orderedAssetContentMultisetHash: Hash
  readonly orderedAnchorOriginalContentHashes: readonly Hash[]
  readonly legendText: string
  readonly legendHash: Hash
  readonly visualRuntime: VisualAnchorRuntime
}

export interface AnchorCandidateOverlapReport {
  readonly protocolVersion: typeof ANCHOR_CANDIDATE_OVERLAP_PROTOCOL
  readonly datasetFingerprint: Hash
  readonly anchorPackHash: Hash
  readonly candidateAssetCount: number
  readonly anchorAssetCount: 14
  readonly overlapCount: number
  readonly reportHash: Hash
}

export class AnchorExperimentRuntimeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentRuntimeError'
    this.code = code
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function parsePack(bytes: Uint8Array): VisualAnchorPackDocument {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new AnchorExperimentRuntimeError('ANCHOR_PACK_INVALID_JSON', '视觉锚点包不是有效 JSON。')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnchorExperimentRuntimeError('ANCHOR_PACK_INVALID', '视觉锚点包结构无效。')
  }
  const pack = value as Partial<VisualAnchorPackDocument>
  if (pack.schema !== 'photo-filter-visual-anchor-pack/v1'
    || pack.status !== 'frozen_for_experiment'
    || pack.rubric_version !== PORTRAIT_ANCHOR_RUBRIC_VERSION
    || pack.privacy?.contains_absolute_paths !== false
    || pack.privacy?.contains_filenames !== false
    || pack.privacy?.contains_oracle_data !== false
    || pack.privacy?.contains_original_asset_ids !== false
    || !Array.isArray(pack.anchors) || pack.anchors.length !== 7) {
    throw new AnchorExperimentRuntimeError(
      'ANCHOR_PACK_CONTRACT_MISMATCH',
      '视觉锚点包必须冻结为 7 组、无路径/文件名/oracle/原始 ID，并绑定当前 Rubric。',
    )
  }
  const assetRefs = new Set<string>()
  for (const [index, anchor] of pack.anchors.entries()) {
    if (!anchor || typeof anchor.anchor_id !== 'string'
      || anchor.anchor_id !== `anchor-${String(index + 1).padStart(3, '0')}`
      || !Array.isArray(anchor.images) || anchor.images.length !== 2
      || anchor.images[0]?.slot !== 'A' || anchor.images[1]?.slot !== 'B'
      || typeof anchor.rationale_zh !== 'string' || !anchor.rationale_zh.trim()) {
      throw new AnchorExperimentRuntimeError('ANCHOR_PACK_ORDER_INVALID', `视觉锚点第 ${index + 1} 组不完整。`)
    }
    for (const image of anchor.images) {
      if (typeof image.asset_ref !== 'string' || !image.asset_ref
        || typeof image.absolute_tier !== 'string' || !image.absolute_tier
        || assetRefs.has(image.asset_ref)) {
        throw new AnchorExperimentRuntimeError('ANCHOR_PACK_ASSET_INVALID', '视觉锚点资产必须匿名且 14 张互不重复。')
      }
      assetRefs.add(image.asset_ref)
    }
  }
  if (assetRefs.size !== 14) {
    throw new AnchorExperimentRuntimeError('ANCHOR_PACK_ASSET_COUNT', '视觉锚点包必须恰好包含 14 张匿名资产。')
  }
  return pack as VisualAnchorPackDocument
}

function legend(pack: VisualAnchorPackDocument): string {
  return [
    '图版标签中的 BEST / KEEP / KEEP_THRESHOLD / REJECT 是冻结的绝对层级。',
    ...pack.anchors.map(anchor => {
      const labels = anchor.images.map(image => `${image.slot}=${image.absolute_tier.toUpperCase()}`).join('，')
      return `${anchor.anchor_id}（${labels}）：${anchor.rationale_zh}`
    }),
  ].join('\n')
}

export function prepareAnchorExperimentBundle(
  input: AnchorExperimentBundleInput,
): PreparedAnchorExperimentBundle {
  if (!(input.anchorPackBytes instanceof Uint8Array)
    || !(input.anchorSheetJpeg instanceof Uint8Array)
    || input.anchorPackBytes.byteLength === 0 || input.anchorSheetJpeg.byteLength === 0) {
    throw new AnchorExperimentRuntimeError('ANCHOR_BUNDLE_BYTES_MISSING', '锚点包或精确参考图版字节为空。')
  }
  const pack = parsePack(input.anchorPackBytes)
  const qualityReceipt = loadReferenceSheetQualityReceipt(input.referenceSheetQualityReceipt)
  const packHash = sha256(input.anchorPackBytes)
  const anchorSheetSha256 = sha256(input.anchorSheetJpeg)
  if (qualityReceipt.anchorPackHash !== packHash
    || qualityReceipt.anchorSheetSha256 !== anchorSheetSha256) {
    throw new AnchorExperimentRuntimeError(
      'ANCHOR_BUNDLE_RECEIPT_MISMATCH',
      '参考图版质量收据没有绑定当前锚点包与精确 JPEG；请求已阻止。',
    )
  }
  if (!Array.isArray(input.orderedAnchorOriginalContentHashes)
    || input.orderedAnchorOriginalContentHashes.length !== 14
    || input.orderedAnchorOriginalContentHashes.some(value => !validHash(value))
    || new Set(input.orderedAnchorOriginalContentHashes).size !== 14) {
    throw new AnchorExperimentRuntimeError(
      'ANCHOR_ORIGINAL_HASHES_INVALID',
      '必须提供 14 个互不重复的本地锚点原图内容哈希。',
    )
  }
  const legendText = legend(pack)
  const legendHash = sha256(legendText)
  const protocol = Object.freeze({
    id: 'reference-sheet/v2' as const,
    anchorSheetSha256,
    layoutProtocolHash: qualityReceipt.layoutProtocolHash,
    qualityReceiptHash: qualityReceipt.receiptHash,
    anchorSheetCount: 1 as const,
    candidateSheetProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
  })
  const visualRuntime: VisualAnchorRuntime = Object.freeze({
    protocol,
    qualityReceipt,
    anchorSheetJpegBase64: Buffer.from(input.anchorSheetJpeg).toString('base64'),
    legendText,
    legendHash,
  })
  return Object.freeze({
    schemaVersion: ANCHOR_RUNTIME_BUNDLE_SCHEMA,
    packHash,
    anchorSheetSha256,
    layoutProtocolHash: qualityReceipt.layoutProtocolHash,
    qualityReceipt,
    orderedAssetContentMultisetHash: canonicalHash({
      protocol: 'anchor-original-content-multiset/v1',
      hashes: [...input.orderedAnchorOriginalContentHashes].sort(),
    }),
    orderedAnchorOriginalContentHashes: Object.freeze([...input.orderedAnchorOriginalContentHashes]),
    legendText,
    legendHash,
    visualRuntime,
  })
}

export function createAnchorCandidateOverlapReport(input: Readonly<{
  datasetFingerprint: string
  candidateOriginalContentHashes: readonly string[]
  bundle: PreparedAnchorExperimentBundle
}>): AnchorCandidateOverlapReport {
  if (!validHash(input.datasetFingerprint)
    || !Array.isArray(input.candidateOriginalContentHashes)
    || input.candidateOriginalContentHashes.length === 0
    || input.candidateOriginalContentHashes.some(value => !validHash(value))
    || new Set(input.candidateOriginalContentHashes).size !== input.candidateOriginalContentHashes.length) {
    throw new AnchorExperimentRuntimeError(
      'CANDIDATE_CONTENT_HASHES_INVALID',
      '候选原图内容哈希不完整、重复或未绑定有效 dataset fingerprint。',
    )
  }
  const candidateSet = new Set(input.candidateOriginalContentHashes)
  const overlapCount = input.bundle.orderedAnchorOriginalContentHashes
    .filter(value => candidateSet.has(value)).length
  const identity = {
    protocolVersion: ANCHOR_CANDIDATE_OVERLAP_PROTOCOL,
    datasetFingerprint: input.datasetFingerprint,
    anchorPackHash: input.bundle.packHash,
    candidateAssetCount: input.candidateOriginalContentHashes.length,
    anchorAssetCount: 14 as const,
    overlapCount,
    // Bind both complete sets without exposing their members in the report.
    candidateContentSetHash: canonicalHash([...input.candidateOriginalContentHashes].sort()),
    anchorContentSetHash: canonicalHash([...input.bundle.orderedAnchorOriginalContentHashes].sort()),
  }
  return Object.freeze({
    protocolVersion: identity.protocolVersion,
    datasetFingerprint: identity.datasetFingerprint,
    anchorPackHash: identity.anchorPackHash,
    candidateAssetCount: identity.candidateAssetCount,
    anchorAssetCount: 14,
    overlapCount,
    reportHash: canonicalHash(identity),
  })
}
