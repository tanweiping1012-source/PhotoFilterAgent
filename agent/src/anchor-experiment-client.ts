import { createHash } from 'node:crypto'
import type { ReferenceSheetPreview } from './engine.ts'
import type { HarnessVisionTransport } from './harness-vision.ts'
import type { PortraitEvaluationProfile, PortraitEvaluationRole } from './evaluation-profile.ts'
import {
  AnchorPortraitVisionClient,
  type AnchorPairwiseRawDecision,
  type AnchorVisionTransport,
  type PairCandidateSheetRuntime,
  type VisualAnchorRuntime,
} from './portrait-anchor-vision.ts'
import {
  PortraitVisionClient,
  type PairwiseRawDecision,
} from './portrait-vision.ts'
import {
  PAIR_CANDIDATE_LAYOUT_PROTOCOL,
  PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA,
  freezePairCandidateSheetReceipt,
  type FrozenPairCandidateSheetReceipt,
  type PairCandidateRenderEvidence,
} from './reference-sheet-quality.ts'
import {
  anchorExperimentPairwiseLegCacheKey,
  normalizeAnchorRubricExperimentAssessment,
  normalizeLegacyExperimentAssessment,
  type AnchorExperimentRunBinding,
  type ExperimentAssessment,
  type ExperimentDetail,
  type ExperimentPairwiseDecision,
  type ExperimentPairwiseLegRecord,
} from './anchor-experiment-state.ts'

export interface AnchorExperimentPairSheetEngine {
  candidatePairSheet(
    firstId: string,
    secondId: string,
    firstFaceFocus: NonNullable<ExperimentAssessment['primarySubjectHeadFocus']>,
    secondFaceFocus: NonNullable<ExperimentAssessment['primarySubjectHeadFocus']>,
    signal?: AbortSignal,
  ): Promise<ReferenceSheetPreview>
}

export interface AnchorExperimentVisionClientOptions {
  binding: AnchorExperimentRunBinding
  profile: PortraitEvaluationProfile
  transport: AnchorVisionTransport
  visualRuntime?: VisualAnchorRuntime
  pairSheetEngine?: AnchorExperimentPairSheetEngine
}

export interface AnchorExperimentScoreInput {
  id: string
  jpegBase64: string
  detail: ExperimentDetail
  role: PortraitEvaluationRole
  signal?: AbortSignal
}

export interface AnchorExperimentPairInput {
  aId: string
  aJpegBase64: string
  bId: string
  bJpegBase64: string
  order: 'AB' | 'BA'
  role: PortraitEvaluationRole
  /** Required only by C; must be the frozen high result from this same role. */
  aHighAssessment?: ExperimentAssessment
  /** Required only by C; must be the frozen high result from this same role. */
  bHighAssessment?: ExperimentAssessment
  signal?: AbortSignal
}

export interface PreparedAnchorExperimentPairLeg {
  readonly aId: string
  readonly aJpegBase64: string
  readonly bId: string
  readonly bJpegBase64: string
  readonly order: 'AB' | 'BA'
  readonly role: PortraitEvaluationRole
  readonly cacheKey: string
  readonly pairCandidateSheet?: PairCandidateSheetRuntime
  readonly pairCandidateReceiptHash?: string
  readonly signal?: AbortSignal
}

export class AnchorExperimentVisionClientError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorExperimentVisionClientError'
    this.code = code
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function decodedJpegHash(value: string): string {
  return sha256(Buffer.from(value, 'base64'))
}

function routeIdentityHash(route: Readonly<{
  provider: string
  model: string
  protocol: string
  reasoningEffort?: string
}>): string {
  return sha256([
    route.provider,
    route.model,
    route.protocol,
    route.reasoningEffort ?? '',
  ].join('\u0000'))
}

function sameRoute(
  left: AnchorExperimentRunBinding['route'],
  right: AnchorVisionTransport['route'],
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.protocol === right.protocol
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

function pairResultFromLegacy(raw: PairwiseRawDecision): ExperimentPairwiseDecision['result'] {
  return raw.winner === 'A' ? 'left' : raw.winner === 'B' ? 'right' : 'tie'
}

function normalizeLegacyPairwise(raw: PairwiseRawDecision): ExperimentPairwiseDecision {
  return Object.freeze({
    contract: 'legacy-portrait-pairwise/v1',
    order: raw.order,
    result: pairResultFromLegacy(raw),
    weightedMargin: raw.weightedMargin,
    confidence: raw.confidence,
    reason: raw.reason,
    raw,
  })
}

function normalizeAnchorPairwise(raw: AnchorPairwiseRawDecision): ExperimentPairwiseDecision {
  return Object.freeze({
    contract: 'portrait-anchor-pairwise/v1',
    order: raw.order,
    result: raw.result,
    weightedMargin: raw.weightedMargin,
    confidence: raw.confidence,
    reason: raw.reason,
    raw,
  })
}

function exactPairRenderEvidence(input: Readonly<{
  preview: ReferenceSheetPreview
  firstId: string
  secondId: string
  firstSourceHash: string
  secondSourceHash: string
}>): PairCandidateRenderEvidence {
  const { preview } = input
  const sheetBytes = Buffer.from(preview.jpeg_base64, 'base64')
  const expected = [
    { cell: 1, label: 'FIRST', slot: 'FIRST', id: input.firstId, hash: input.firstSourceHash },
    { cell: 2, label: 'SECOND', slot: 'SECOND', id: input.secondId, hash: input.secondSourceHash },
  ] as const
  const topLevelValid = preview.layout_protocol === PAIR_CANDIDATE_LAYOUT_PROTOCOL
    && preview.width === 3072 && preview.height === 1536
    && preview.pair_count === 1 && preview.asset_count === 2
    && preview.bytes === sheetBytes.byteLength
    && preview.jpeg_sha256 === sha256(sheetBytes)
    && Array.isArray(preview.source_preview_sha256)
    && preview.source_preview_sha256.length === 2
    && Array.isArray(preview.cells) && preview.cells.length === 2
    && Array.isArray(preview.ordered_cell_identity)
    && preview.ordered_cell_identity.length === 2
  if (!topLevelValid) {
    throw new AnchorExperimentVisionClientError(
      'PAIR_SHEET_RENDER_CONTRACT_MISMATCH',
      'C 双候选图版没有满足冻结的 3072x1536/v2 渲染合同。',
    )
  }
  for (const [index, wanted] of expected.entries()) {
    const cell = preview.cells[index]
    const identity = preview.ordered_cell_identity[index]
    if (preview.source_preview_sha256[index] !== wanted.hash
      || cell?.cell !== wanted.cell || cell?.label !== wanted.label
      || cell?.face_critical !== true
      || cell?.face_region_source !== 'explicit_focus_unverified'
      || identity?.cell !== wanted.cell || identity?.slot !== wanted.slot
      || identity?.anonymous_id !== wanted.id || identity?.anchor_id !== null
      || identity?.source_preview_sha256 !== wanted.hash) {
      throw new AnchorExperimentVisionClientError(
        'PAIR_SHEET_RENDER_IDENTITY_MISMATCH',
        `C 双候选图版第 ${index + 1} 格没有绑定当前顺序、源预览或 2/2 focus inset。`,
      )
    }
  }
  return Object.freeze({
    schemaVersion: PAIR_CANDIDATE_RENDER_EVIDENCE_SCHEMA,
    status: 'READY_FOR_PAIRWISE',
    layoutProtocol: PAIR_CANDIDATE_LAYOUT_PROTOCOL,
    candidateSheetSha256: preview.jpeg_sha256,
    width: 3072,
    height: 1536,
    pairCount: 1,
    assetCount: 2,
    faceInsetCount: 2,
    preservesAspectRatio: true,
    stripsMetadata: true,
    containsPathsOrFilenames: false,
    cells: Object.freeze(expected.map(wanted => Object.freeze({
      cellIndex: wanted.cell,
      label: wanted.label,
      faceCritical: true as const,
      faceRegionSource: 'explicit_focus_unverified' as const,
      anonymousID: wanted.id,
      sourceContentSha256: wanted.hash,
    }))) as PairCandidateRenderEvidence['cells'],
  })
}

function requireHighFocus(
  assessment: ExperimentAssessment | undefined,
  id: string,
  role: PortraitEvaluationRole,
): NonNullable<ExperimentAssessment['primarySubjectHeadFocus']> {
  if (!assessment || assessment.id !== id || assessment.role !== role
    || assessment.detail !== 'high' || !assessment.primarySubjectHeadFocus) {
    throw new AnchorExperimentVisionClientError(
      'PAIR_HIGH_FOCUS_REQUIRED',
      'C pairwise 必须使用同一隔离角色、同一匿名 ID 的冻结 high focus；禁止自动检测或跨角色复用。',
    )
  }
  return assessment.primarySubjectHeadFocus
}

/**
 * One honest A/B/C facade. It never converts the anchor rubric into legacy six-
 * dimension fields and never chooses a provider/model independently of the
 * immutable experiment binding.
 */
export class AnchorExperimentVisionClient {
  readonly binding: AnchorExperimentRunBinding
  private readonly legacy?: PortraitVisionClient
  private readonly anchored?: AnchorPortraitVisionClient
  private readonly visualRuntime?: VisualAnchorRuntime
  private readonly pairSheetEngine?: AnchorExperimentPairSheetEngine
  private readonly preparedPairLegs = new WeakSet<object>()

  constructor(options: AnchorExperimentVisionClientOptions) {
    this.binding = options.binding
    this.visualRuntime = options.visualRuntime
    this.pairSheetEngine = options.pairSheetEngine
    if (!Object.isFrozen(this.binding)
      || !sameRoute(this.binding.route, options.transport.route)
      || routeIdentityHash(options.transport.route) !== this.binding.routeIdentityHash) {
      throw new AnchorExperimentVisionClientError(
        'EXPERIMENT_ROUTE_MISMATCH',
        '实验 binding 与当前 Harness request route 不一致；图片请求已阻止。',
      )
    }
    if (options.profile.arm !== this.binding.arm
      || options.profile.protocol !== this.binding.profileProtocol
      || options.profile.rubricVersion !== this.binding.rubricVersion
      || options.profile.rubricContentHash !== this.binding.rubricContentHash) {
      throw new AnchorExperimentVisionClientError(
        'EXPERIMENT_PROFILE_MISMATCH',
        '评分 profile 没有绑定当前 arm/manifest/rubric。',
      )
    }
    if (this.binding.arm === 'A') {
      if (options.visualRuntime || options.pairSheetEngine) {
        throw new AnchorExperimentVisionClientError(
          'LEGACY_VISUAL_RUNTIME_NOT_ALLOWED',
          'A 必须保持冻结旧基线，不能加载视觉锚点或双候选图版引擎。',
        )
      }
      this.legacy = new PortraitVisionClient({
        transport: options.transport as HarnessVisionTransport,
      })
      return
    }
    if (this.binding.arm === 'C') {
      const visual = this.binding.visual
      const runtime = options.visualRuntime
      if (!visual || !runtime || !options.pairSheetEngine
        || options.profile.visualAnchorPackHash !== visual.anchorPackHash
        || runtime.protocol.anchorSheetSha256 !== visual.anchorSheetSha256
        || runtime.protocol.layoutProtocolHash !== visual.layoutProtocolHash
        || runtime.protocol.qualityReceiptHash !== visual.qualityReceiptHash
        || runtime.legendHash !== visual.legendHash) {
        throw new AnchorExperimentVisionClientError(
          'EXPERIMENT_VISUAL_BINDING_MISMATCH',
          'C 缺少与 manifest 精确一致的 pack/sheet/layout/quality/legend/渲染引擎。',
        )
      }
    } else if (options.visualRuntime || options.pairSheetEngine || this.binding.visual) {
      throw new AnchorExperimentVisionClientError(
        'TEXT_ARM_VISUAL_RUNTIME_NOT_ALLOWED',
        'B 只能使用文本 Rubric，不能加载视觉锚点或候选图版引擎。',
      )
    }
    this.anchored = new AnchorPortraitVisionClient({
      transport: options.transport,
      profile: options.profile,
      ...(options.visualRuntime ? { visualRuntime: options.visualRuntime } : {}),
    })
  }

  async scoreBaseline(input: AnchorExperimentScoreInput): Promise<ExperimentAssessment> {
    if (this.binding.arm === 'A') {
      const raw = await this.legacy!.scoreBaseline(
        input.id, input.jpegBase64, input.detail, input.signal, input.role,
      )
      return normalizeLegacyExperimentAssessment({
        assessment: raw, role: input.role, detail: input.detail,
      })
    }
    const raw = await this.anchored!.scoreBaseline(
      input.id, input.jpegBase64, input.detail, input.role, input.signal,
    )
    return normalizeAnchorRubricExperimentAssessment({
      assessment: raw, role: input.role, detail: input.detail,
    })
  }

  async preparePairLeg(input: AnchorExperimentPairInput): Promise<PreparedAnchorExperimentPairLeg> {
    let pairReceipt: FrozenPairCandidateSheetReceipt | undefined
    let pairCandidateSheet: PairCandidateSheetRuntime | undefined
    if (this.binding.arm === 'C') {
      const aFocus = requireHighFocus(input.aHighAssessment, input.aId, input.role)
      const bFocus = requireHighFocus(input.bHighAssessment, input.bId, input.role)
      const firstId = input.order === 'AB' ? input.aId : input.bId
      const secondId = input.order === 'AB' ? input.bId : input.aId
      const firstJpeg = input.order === 'AB' ? input.aJpegBase64 : input.bJpegBase64
      const secondJpeg = input.order === 'AB' ? input.bJpegBase64 : input.aJpegBase64
      const firstFocus = input.order === 'AB' ? aFocus : bFocus
      const secondFocus = input.order === 'AB' ? bFocus : aFocus
      const preview = await this.pairSheetEngine!.candidatePairSheet(
        firstId, secondId, firstFocus, secondFocus, input.signal,
      )
      const firstSourceHash = decodedJpegHash(firstJpeg)
      const secondSourceHash = decodedJpegHash(secondJpeg)
      const renderEvidence = exactPairRenderEvidence({
        preview, firstId, secondId, firstSourceHash, secondSourceHash,
      })
      pairReceipt = freezePairCandidateSheetReceipt({
        combinedLayoutProtocolHash: this.binding.visual!.layoutProtocolHash,
        firstAnonymousID: firstId,
        secondAnonymousID: secondId,
        firstSourceJpegBase64: firstJpeg,
        secondSourceJpegBase64: secondJpeg,
        firstFaceFocus: firstFocus,
        secondFaceFocus: secondFocus,
        candidateSheetJpegBase64: preview.jpeg_base64,
        renderEvidence,
      })
      pairCandidateSheet = Object.freeze({
        jpegBase64: preview.jpeg_base64,
        receipt: pairReceipt,
      })
    }
    const cacheKey = anchorExperimentPairwiseLegCacheKey({
      binding: this.binding,
      role: input.role,
      aId: input.aId,
      bId: input.bId,
      order: input.order,
      ...(pairReceipt ? { pairCandidateReceiptHash: pairReceipt.receiptHash } : {}),
    })
    const prepared = Object.freeze({
      aId: input.aId,
      aJpegBase64: input.aJpegBase64,
      bId: input.bId,
      bJpegBase64: input.bJpegBase64,
      role: input.role,
      order: input.order,
      cacheKey,
      ...(pairCandidateSheet ? { pairCandidateSheet } : {}),
      ...(pairReceipt ? { pairCandidateReceiptHash: pairReceipt.receiptHash } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    this.preparedPairLegs.add(prepared)
    return prepared
  }

  /**
   * Invoke only a locally prepared leg. The DSH caller must durably reserve
   * `prepared.cacheKey` before calling this method.
   */
  async invokePreparedPairLeg(
    prepared: PreparedAnchorExperimentPairLeg,
  ): Promise<ExperimentPairwiseLegRecord> {
    if (!this.preparedPairLegs.has(prepared)) {
      throw new AnchorExperimentVisionClientError(
        'PAIR_LEG_NOT_PREPARED',
        'pairwise leg 没有由当前客户端本地准备，模型调用已阻止。',
      )
    }
    // Consume before dispatch. A provider uncertainty cannot be retried by
    // invoking the same in-memory object again.
    this.preparedPairLegs.delete(prepared)
    let decision: ExperimentPairwiseDecision
    if (this.binding.arm === 'A') {
      const raw = await this.legacy!.comparePairLeg(
        prepared.aId, prepared.aJpegBase64, prepared.bId, prepared.bJpegBase64,
        prepared.order, prepared.signal,
      )
      decision = normalizeLegacyPairwise(raw)
    } else {
      const raw = await this.anchored!.comparePairLeg({
        aId: prepared.aId,
        aJpegBase64: prepared.aJpegBase64,
        bId: prepared.bId,
        bJpegBase64: prepared.bJpegBase64,
        order: prepared.order,
        role: prepared.role,
        ...(prepared.pairCandidateSheet
          ? { pairCandidateSheet: prepared.pairCandidateSheet }
          : {}),
        signal: prepared.signal,
      })
      decision = normalizeAnchorPairwise(raw)
    }
    return Object.freeze({
      aId: prepared.aId,
      bId: prepared.bId,
      role: prepared.role,
      order: prepared.order,
      decision,
      cacheKey: prepared.cacheKey,
      ...(prepared.pairCandidateReceiptHash
        ? { pairCandidateReceiptHash: prepared.pairCandidateReceiptHash }
        : {}),
    })
  }

  /** Convenience for unit tests; paid DSH paths must use prepare + reserve + invoke. */
  async comparePairLeg(input: AnchorExperimentPairInput): Promise<ExperimentPairwiseLegRecord> {
    return this.invokePreparedPairLeg(await this.preparePairLeg(input))
  }
}
