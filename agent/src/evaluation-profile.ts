import { createHash } from 'node:crypto'

export const PORTRAIT_ANCHOR_PROFILE_PROTOCOL = 'photo-filter-anchor-profile/v1' as const

export type PortraitExperimentArm = 'A' | 'B' | 'C'
export type PortraitEvaluationRole = 'selector' | 'audit'
export type PortraitEvaluationStage = 'low' | 'high' | 'pairwise'
export type PortraitAbsoluteTier = 'reject' | 'keep_threshold' | 'keep' | 'best' | 'uncertain'

export interface PortraitEvaluationProfile {
  readonly protocol: typeof PORTRAIT_ANCHOR_PROFILE_PROTOCOL
  readonly arm: PortraitExperimentArm
  readonly rubricVersion: string
  readonly rubricContentHash: string
  /** Present only when high/pairwise requests use frozen visual examples. */
  readonly visualAnchorPackHash?: string
}

export type VisualAnchorAttachmentProtocol =
  | Readonly<{
    id: 'separate-anchor-images/v1'
    /** Number of visual example images attached after the candidate images. */
    anchorImageCount: number
  }>
  | Readonly<{
    id: 'reference-sheet/v2'
    /** Bind the exact rendered anchor sheet, not merely a true/false flag. */
    anchorSheetSha256: string
    /** Bind the frozen layout used to render labels, crops and reading order. */
    layoutProtocolHash: string
    /** Bind an immutable PASS receipt produced before any scored request. */
    qualityReceiptHash: string
    /** One sheet contains only the frozen anchors. */
    anchorSheetCount: 1
    /** Pairwise uses one side-by-side candidate sheet; high uses one candidate image. */
    candidateSheetProtocol: 'pair-side-by-side-3072x1536-face-inset-v2'
  }>

export interface PortraitStageIdentityInput {
  readonly profile: PortraitEvaluationProfile
  readonly role: PortraitEvaluationRole
  readonly stage: PortraitEvaluationStage
  readonly datasetFingerprint: string
  readonly routeIdentity: string
  readonly promptHash: string
  readonly imageProtocol: string
  readonly preferenceHash: string
  readonly aggregationVersion: string
  readonly visualProtocol?: VisualAnchorAttachmentProtocol
}

export interface AttachmentLimits {
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
}

export interface AttachmentPayload {
  /** Exact byte size of each JPEG in the order it will be attached. */
  readonly imageByteSizes: readonly number[]
}

export interface AttachmentPlan {
  readonly imageCount: number
  readonly candidateImageCount: number
  readonly anchorImageCount: number
  readonly protocolId: string
}

export class PortraitEvaluationProfileError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortraitEvaluationProfileError'
    this.code = code
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertHash(value: string | undefined, field: string, required: boolean): void {
  if (!required && value === undefined) return
  if (!nonEmpty(value) || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new PortraitEvaluationProfileError(
      'INVALID_PROFILE_HASH',
      `${field} 必须是 64 位小写 SHA-256。`,
    )
  }
}

/**
 * Freeze one experiment arm without making a personal profile the product
 * default. The caller owns the versioned rubric and pack artifacts.
 */
export function createPortraitEvaluationProfile(input: Readonly<{
  arm: PortraitExperimentArm
  rubricVersion: string
  rubricContentHash: string
  visualAnchorPackHash?: string
}>): PortraitEvaluationProfile {
  if (!nonEmpty(input.rubricVersion)) {
    throw new PortraitEvaluationProfileError('INVALID_RUBRIC_VERSION', 'rubricVersion 不能为空。')
  }
  assertHash(input.rubricContentHash, 'rubricContentHash', true)
  if (input.arm === 'C') {
    assertHash(input.visualAnchorPackHash, 'visualAnchorPackHash', true)
  } else if (input.visualAnchorPackHash !== undefined) {
    throw new PortraitEvaluationProfileError(
      'ANCHOR_PACK_NOT_ALLOWED',
      `实验 ${input.arm} 不得携带视觉锚点包。`,
    )
  }
  return Object.freeze({
    protocol: PORTRAIT_ANCHOR_PROFILE_PROTOCOL,
    arm: input.arm,
    rubricVersion: input.rubricVersion,
    rubricContentHash: input.rubricContentHash,
    ...(input.visualAnchorPackHash === undefined
      ? {}
      : { visualAnchorPackHash: input.visualAnchorPackHash }),
  })
}

/** C differs from B only in high and pairwise; low remains text-only. */
export function usesVisualAnchors(
  profile: PortraitEvaluationProfile,
  stage: PortraitEvaluationStage,
): boolean {
  return profile.arm === 'C' && stage !== 'low'
}

/**
 * Effective identity deliberately omits the experiment arm label. Therefore B
 * and C may share low cache only when every effective input is byte-identical;
 * high/pairwise include the anchor hash and protocol and cannot collide.
 */
export function portraitStageCacheIdentity(input: PortraitStageIdentityInput): string {
  const withAnchors = usesVisualAnchors(input.profile, input.stage)
  if (withAnchors && !input.visualProtocol) {
    throw new PortraitEvaluationProfileError(
      'VISUAL_PROTOCOL_REQUIRED',
      'C 的 high/pairwise 缓存身份必须绑定视觉附件协议。',
    )
  }
  if (!withAnchors && input.visualProtocol) {
    throw new PortraitEvaluationProfileError(
      'UNEXPECTED_VISUAL_PROTOCOL',
      '纯文本阶段不得携带视觉附件协议。',
    )
  }
  const visualIdentity = withAnchors
    ? JSON.stringify({
      anchorPackHash: input.profile.visualAnchorPackHash,
      protocol: input.visualProtocol,
    })
    : 'text-only'
  return sha256([
    PORTRAIT_ANCHOR_PROFILE_PROTOCOL,
    input.role,
    input.stage,
    input.datasetFingerprint,
    input.routeIdentity,
    input.profile.rubricVersion,
    input.profile.rubricContentHash,
    input.promptHash,
    input.imageProtocol,
    input.preferenceHash,
    input.aggregationVersion,
    visualIdentity,
  ].join('\u0000'))
}

function candidateImageCount(stage: PortraitEvaluationStage): 1 | 2 {
  return stage === 'pairwise' ? 2 : 1
}

/**
 * Compute the exact attachment requirement. No protocol is automatically
 * substituted: an unsupported C request is blocked before any image is saved.
 */
export function planPortraitAttachments(
  profile: PortraitEvaluationProfile,
  stage: PortraitEvaluationStage,
  protocol?: VisualAnchorAttachmentProtocol,
): AttachmentPlan {
  const candidates = candidateImageCount(stage)
  if (!usesVisualAnchors(profile, stage)) {
    if (protocol) {
      throw new PortraitEvaluationProfileError(
        'UNEXPECTED_VISUAL_PROTOCOL',
        'A/B 或 low 阶段不得声明视觉锚点协议。',
      )
    }
    return Object.freeze({
      imageCount: candidates,
      candidateImageCount: candidates,
      anchorImageCount: 0,
      protocolId: 'candidate-images/v1',
    })
  }
  if (!protocol) {
    throw new PortraitEvaluationProfileError(
      'VISUAL_PROTOCOL_REQUIRED',
      'C 的 high/pairwise 必须显式声明视觉锚点附件协议。',
    )
  }
  if (protocol.id === 'separate-anchor-images/v1') {
    if (!Number.isInteger(protocol.anchorImageCount) || protocol.anchorImageCount < 1) {
      throw new PortraitEvaluationProfileError(
        'INVALID_ANCHOR_IMAGE_COUNT',
        'anchorImageCount 必须是正整数。',
      )
    }
    return Object.freeze({
      imageCount: candidates + protocol.anchorImageCount,
      candidateImageCount: candidates,
      anchorImageCount: protocol.anchorImageCount,
      protocolId: protocol.id,
    })
  }
  assertHash(protocol.anchorSheetSha256, 'anchorSheetSha256', true)
  assertHash(protocol.layoutProtocolHash, 'layoutProtocolHash', true)
  assertHash(protocol.qualityReceiptHash, 'qualityReceiptHash', true)
  return Object.freeze({
    imageCount: 2,
    candidateImageCount: 1,
    anchorImageCount: 1,
    protocolId: protocol.id,
  })
}

export function assertPortraitAttachmentCapacity(
  profile: PortraitEvaluationProfile,
  stage: PortraitEvaluationStage,
  limits: AttachmentLimits,
  protocol?: VisualAnchorAttachmentProtocol,
  payload?: AttachmentPayload,
): AttachmentPlan {
  const plan = planPortraitAttachments(profile, stage, protocol)
  if (!Number.isInteger(limits.maxImagesPerMessage) || limits.maxImagesPerMessage < plan.imageCount) {
    throw new PortraitEvaluationProfileError(
      'ANCHOR_ATTACHMENT_UNSUPPORTED',
      `当前 Harness 每条消息最多 ${limits.maxImagesPerMessage} 张图，` +
      `${profile.arm}/${stage}/${plan.protocolId} 需要 ${plan.imageCount} 张；请求已阻止。`,
    )
  }
  if (!Number.isFinite(limits.maxMessageImageBytes) || limits.maxMessageImageBytes <= 0) {
    throw new PortraitEvaluationProfileError(
      'INVALID_ATTACHMENT_BYTE_LIMIT',
      'Harness 图片字节上限无效；请求已阻止。',
    )
  }
  if (payload) {
    if (payload.imageByteSizes.length !== plan.imageCount
      || payload.imageByteSizes.some(size => !Number.isInteger(size) || size <= 0)) {
      throw new PortraitEvaluationProfileError(
        'INVALID_ATTACHMENT_PAYLOAD',
        `附件字节清单必须包含 ${plan.imageCount} 个正整数。`,
      )
    }
    const totalBytes = payload.imageByteSizes.reduce((sum, size) => sum + size, 0)
    if (totalBytes > limits.maxMessageImageBytes) {
      throw new PortraitEvaluationProfileError(
        'ANCHOR_ATTACHMENT_BYTES_EXCEEDED',
        `匿名 JPEG 合计 ${totalBytes} bytes，超过 Harness 上限 ` +
        `${limits.maxMessageImageBytes} bytes；图片尚未写入 attachment service。`,
      )
    }
  }
  return plan
}
