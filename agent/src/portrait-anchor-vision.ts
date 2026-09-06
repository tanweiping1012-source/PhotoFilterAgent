import { createHash } from 'node:crypto'
import type {
  HarnessModelRoute,
  HarnessVisionAttachmentLimits,
  HarnessVisionContractProbe,
  StructuredVisionRequest,
} from './harness-vision.ts'
import type { ReferenceSheetFaceFocus } from './engine.ts'
import {
  portraitStageCacheIdentity,
  usesVisualAnchors,
  type PortraitEvaluationProfile,
  type PortraitEvaluationRole,
  type PortraitEvaluationStage,
  type PortraitStageIdentityInput,
  type VisualAnchorAttachmentProtocol,
} from './evaluation-profile.ts'
import {
  PORTRAIT_ABSOLUTE_TIERS,
  PORTRAIT_ANCHOR_DIMENSION_IDS,
  PORTRAIT_ANCHOR_RUBRIC_TEXT,
  PORTRAIT_ANCHOR_RUBRIC_VERSION,
  PORTRAIT_ANCHOR_WEIGHTS,
  PORTRAIT_CONTENT_REJECT_CODES,
  PORTRAIT_HARD_GATE_CODES,
  PORTRAIT_UNCERTAINTY_CODES,
  anchorWeightedScore,
  validatePortraitAnchorAssessment,
  validatePortraitAnchorPairwise,
  type PortraitAbsoluteTier,
  type PortraitAnchorAssessment,
  type PortraitAnchorDimensionId,
  type PortraitAnchorDimensionScores,
  type PortraitAnchorPairwiseAssessment,
  type PortraitContentRejectCode,
  type PortraitHardGateCode,
  type PortraitUncertaintyCode,
} from './portrait-anchor-rubric.ts'
import {
  prepareAnchoredAttachments,
  type FrozenPairCandidateSheetReceipt,
  type FrozenReferenceSheetQualityReceipt,
} from './reference-sheet-quality.ts'

const BASELINE_MAX_TOKENS = 3_200
const PAIRWISE_MAX_TOKENS = 2_400
export const ANCHOR_PAIRWISE_STABLE_MARGIN_POINTS = 2
export const ANCHOR_PAIRWISE_STABLE_CONFIDENCE = 0.7
const PAIRWISE_STEP_POINTS = 5

export interface AnchorVisionTransport {
  readonly route: HarnessModelRoute
  attachmentLimits(): Readonly<HarnessVisionAttachmentLimits>
  invokeStructured(
    request: StructuredVisionRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>
}

export interface VisualAnchorRuntime {
  protocol: Extract<VisualAnchorAttachmentProtocol, { id: 'reference-sheet/v2' }>
  qualityReceipt: FrozenReferenceSheetQualityReceipt
  anchorSheetJpegBase64: string
  /** Anonymous, compact explanation of the labels rendered in the sheet. */
  legendText: string
  legendHash: string
}

export interface PairCandidateSheetRuntime {
  jpegBase64: string
  receipt: FrozenPairCandidateSheetReceipt
}

export interface FocusedPortraitAnchorAssessment extends PortraitAnchorAssessment {
  /** Present for every high result and frozen before any pairwise sheet is rendered. */
  primarySubjectHeadFocus: ReferenceSheetFaceFocus
}

export interface AnchorPortraitVisionOptions {
  transport: AnchorVisionTransport
  profile: PortraitEvaluationProfile
  visualRuntime?: VisualAnchorRuntime
}

export interface AnchorPairwiseRawDecision extends PortraitAnchorPairwiseAssessment {
  order: 'AB' | 'BA'
  normalizedDimensionDeltas: Record<PortraitAnchorDimensionId, number>
  weightedMargin: number
  confidence: number
}

export interface AnchorPairwiseResult {
  winner: string | 'TIE' | 'REJECT_BOTH'
  margin: number
  confidence: number
  reason: string
  rawDecisions: [AnchorPairwiseRawDecision, AnchorPairwiseRawDecision]
}

export class AnchorPortraitVisionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorPortraitVisionError'
    this.code = code
  }
}

const DIMENSION_SCORE_PROPERTIES = Object.fromEntries(
  PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, { type: 'number', minimum: 0, maximum: 100 }]),
)
const DIMENSION_EVIDENCE_PROPERTIES = Object.fromEntries(
  PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, {
    type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' },
  }]),
)

const BASELINE_PROPERTIES = Object.freeze({
  hardGate: {
    type: 'object', additionalProperties: false,
    required: ['triggered', 'code', 'confidence', 'evidence'],
    properties: {
      triggered: { type: 'boolean' },
      code: { enum: [null, ...PORTRAIT_HARD_GATE_CODES] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: { type: 'array', maxItems: 4, items: { type: 'string' } },
    },
  },
  absoluteTier: { type: 'string', enum: [...PORTRAIT_ABSOLUTE_TIERS] },
  contentRejectCodes: {
    type: 'array', uniqueItems: true,
    items: { type: 'string', enum: [...PORTRAIT_CONTENT_REJECT_CODES] },
  },
  uncertaintyCodes: {
    type: 'array', uniqueItems: true,
    items: { type: 'string', enum: [...PORTRAIT_UNCERTAINTY_CODES] },
  },
  dimensionScores: {
    type: 'object', additionalProperties: false, required: [...PORTRAIT_ANCHOR_DIMENSION_IDS],
    properties: DIMENSION_SCORE_PROPERTIES,
  },
  dimensionEvidence: {
    type: 'object', additionalProperties: false, required: [...PORTRAIT_ANCHOR_DIMENSION_IDS],
    properties: DIMENSION_EVIDENCE_PROPERTIES,
  },
  overallConfidence: { type: 'number', minimum: 0, maximum: 1 },
  summary: { type: 'string' },
})

const PRIMARY_SUBJECT_HEAD_FOCUS_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['center_x', 'center_y', 'side_fraction'],
  properties: {
    center_x: { type: 'number', minimum: 0, maximum: 1 },
    center_y: { type: 'number', minimum: 0, maximum: 1 },
    side_fraction: { type: 'number', minimum: 0.05, maximum: 0.8 },
  },
})

const BASELINE_TOOL_LOW = Object.freeze({
  name: 'submit_portrait_anchor_baseline',
  description: '提交一张匿名旅行人像的分层绝对判断。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [
      'hardGate', 'absoluteTier', 'contentRejectCodes', 'uncertaintyCodes',
      'dimensionScores', 'dimensionEvidence', 'overallConfidence', 'summary',
    ],
    properties: BASELINE_PROPERTIES,
  },
})

const BASELINE_TOOL_HIGH = Object.freeze({
  name: 'submit_portrait_anchor_baseline_high',
  description: '提交一张匿名旅行人像的分层绝对判断，并冻结主人物头脸聚焦区域。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [
      'hardGate', 'absoluteTier', 'contentRejectCodes', 'uncertaintyCodes',
      'dimensionScores', 'dimensionEvidence', 'overallConfidence', 'summary',
      'primarySubjectHeadFocus',
    ],
    properties: {
      ...BASELINE_PROPERTIES,
      primarySubjectHeadFocus: PRIMARY_SUBJECT_HEAD_FOCUS_PROPERTY,
    },
  },
})

const PAIRWISE_TOOL = Object.freeze({
  name: 'submit_portrait_anchor_pairwise',
  description: '提交 FIRST/SECOND 的绝对层级与逐维比较；最终方向由本地程序决定。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['firstTier', 'secondTier', 'result', 'dimensionDeltas', 'confidence', 'reason'],
    properties: {
      firstTier: { type: 'string', enum: [...PORTRAIT_ABSOLUTE_TIERS] },
      secondTier: { type: 'string', enum: [...PORTRAIT_ABSOLUTE_TIERS] },
      result: { type: 'string', enum: ['first', 'second', 'tie', 'reject_both'] },
      dimensionDeltas: {
        type: 'object', additionalProperties: false, required: [...PORTRAIT_ANCHOR_DIMENSION_IDS],
        properties: Object.fromEntries(PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, {
          type: 'integer', minimum: -2, maximum: 2,
        }])),
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
  },
})

const ANCHOR_BASELINE_CONTRACT_PROBE_RESULT = Object.freeze({
  hardGate: { triggered: false, code: null, confidence: 0.5, evidence: [] },
  absoluteTier: 'keep_threshold',
  contentRejectCodes: [],
  uncertaintyCodes: [],
  dimensionScores: Object.fromEntries(PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, 50])),
  dimensionEvidence: Object.fromEntries(
    PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, ['contract-probe']]),
  ),
  overallConfidence: 0.5,
  summary: 'contract-probe',
})

const ANCHOR_BASELINE_HIGH_CONTRACT_PROBE_RESULT = Object.freeze({
  ...ANCHOR_BASELINE_CONTRACT_PROBE_RESULT,
  primarySubjectHeadFocus: { center_x: 0.5, center_y: 0.5, side_fraction: 0.25 },
})

const ANCHOR_PAIRWISE_CONTRACT_PROBE_RESULT = Object.freeze({
  firstTier: 'keep_threshold',
  secondTier: 'keep_threshold',
  result: 'tie',
  dimensionDeltas: Object.fromEntries(PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, 0])),
  confidence: 0.5,
  reason: 'contract-probe',
})

/** Exact B/C schemas exercised without images before any candidate or anchor sheet is sent. */
export function portraitAnchorContractProbes(): readonly HarnessVisionContractProbe[] {
  return Object.freeze([
    Object.freeze({
      label: 'anchor-baseline-low',
      system: 'You are a no-image contract probe. Call the supplied tool exactly once.',
      user: `Reproduce this exact JSON object: ${JSON.stringify(ANCHOR_BASELINE_CONTRACT_PROBE_RESULT)}`,
      tool: BASELINE_TOOL_LOW,
      maxTokens: 1_200,
      expected: ANCHOR_BASELINE_CONTRACT_PROBE_RESULT,
    }),
    Object.freeze({
      label: 'anchor-baseline-high',
      system: 'You are a no-image contract probe. Call the supplied tool exactly once.',
      user: `Reproduce this exact JSON object: ${JSON.stringify(ANCHOR_BASELINE_HIGH_CONTRACT_PROBE_RESULT)}`,
      tool: BASELINE_TOOL_HIGH,
      maxTokens: 1_300,
      expected: ANCHOR_BASELINE_HIGH_CONTRACT_PROBE_RESULT,
    }),
    Object.freeze({
      label: 'anchor-pairwise',
      system: 'You are a no-image contract probe. Call the supplied tool exactly once.',
      user: `Reproduce this exact JSON object: ${JSON.stringify(ANCHOR_PAIRWISE_CONTRACT_PROBE_RESULT)}`,
      tool: PAIRWISE_TOOL,
      maxTokens: 700,
      expected: ANCHOR_PAIRWISE_CONTRACT_PROBE_RESULT,
    }),
  ])
}

const BASELINE_USER_PROMPT = `评估 TARGET 匿名人像。严格按分层规则输出；五维证据只描述像素中可见事实。`
const BASELINE_HIGH_FOCUS_PROMPT = `同时输出 primarySubjectHeadFocus：使用视觉正向图片、左上角原点的 0..1 坐标；中心对准主人物头脸，side_fraction 是相对源图短边的正方形边长。即使闭眼、背影或应淘汰，也要框住主人物头部；不得根据锚点人物位置照抄。`
const PAIRWISE_USER_PROMPT = `比较 FIRST 与 SECOND。先分别给出绝对层级，再逐维输出 delta：+2/+1 表示 FIRST 更好，-2/-1 表示 SECOND 更好，0 表示难分。两张都 reject 时必须 result=reject_both。`

function roleSystem(role: PortraitEvaluationRole): string {
  const identity = role === 'audit'
    ? '你是与 selector 状态隔离的盲审人像评测员，不知道已有分数、排名、入选状态或理由。'
    : '你是人像候选评测员，不知道 oracle，也不能使用文件名、路径或已有排名。'
  return `${identity}\n\n${PORTRAIT_ANCHOR_RUBRIC_TEXT}`
}

function visualInstructions(runtime: VisualAnchorRuntime, stage: 'high' | 'pairwise'): string {
  const target = stage === 'high'
    ? '第一张 JPEG 是冻结锚点参考图版，第二张 JPEG 是 TARGET。'
    : '第一张 JPEG 是冻结锚点参考图版，第二张 JPEG 是带 FIRST/SECOND 标签的双候选图版。'
  return `${target}\n锚点只用于校准保留线与细粒度人物状态，不改变 Rubric，也不能推断用户身份。\n${runtime.legendText}`
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value)
}

function promptIdentity(
  role: PortraitEvaluationRole,
  stage: PortraitEvaluationStage,
  runtime?: VisualAnchorRuntime,
): { system: string; user: string; hash: string } {
  const system = roleSystem(role)
  const baseUser = stage === 'pairwise'
    ? PAIRWISE_USER_PROMPT
    : stage === 'high'
      ? `${BASELINE_USER_PROMPT}\n${BASELINE_HIGH_FOCUS_PROMPT}`
      : BASELINE_USER_PROMPT
  const user = runtime && stage !== 'low'
    ? `${baseUser}\n\n${visualInstructions(runtime, stage)}`
    : baseUser
  const tool = stage === 'pairwise'
    ? PAIRWISE_TOOL
    : stage === 'high'
      ? BASELINE_TOOL_HIGH
      : BASELINE_TOOL_LOW
  return {
    system,
    user,
    hash: hashText([system, user, tool.name, JSON.stringify(tool.parameters)].join('\u0000')),
  }
}

/**
 * Hash the exact compiled request contract used by an experiment stage. This
 * is intentionally pure so a manifest cannot substitute caller-invented
 * contract hashes for the prompts and attachment protocol in this build.
 */
export function portraitAnchorStageContractHash(input: Readonly<{
  profile: PortraitEvaluationProfile
  role: PortraitEvaluationRole
  stage: PortraitEvaluationStage
  visualRuntime?: VisualAnchorRuntime
}>): string {
  const needsVisual = usesVisualAnchors(input.profile, input.stage)
  if (needsVisual && !input.visualRuntime) {
    throw new AnchorPortraitVisionError(
      'VISUAL_RUNTIME_REQUIRED',
      'C high/pairwise 合同必须绑定实际视觉锚点运行时。',
    )
  }
  if (!needsVisual && input.visualRuntime) {
    throw new AnchorPortraitVisionError(
      'VISUAL_RUNTIME_NOT_ALLOWED',
      'A/B 或 low 合同不得绑定视觉锚点运行时。',
    )
  }
  const runtime = needsVisual ? input.visualRuntime : undefined
  const prompt = promptIdentity(input.role, input.stage, runtime)
  return hashText([
    'photo-filter-anchor-stage-contract/v1',
    input.profile.protocol,
    input.profile.rubricVersion,
    input.profile.rubricContentHash,
    input.role,
    input.stage,
    prompt.hash,
    runtime ? runtime.legendHash : 'text-only',
    runtime ? JSON.stringify(runtime.protocol) : 'candidate-jpegs/v1',
  ].join('\u0000'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new AnchorPortraitVisionError('INVALID_STRUCTURED_OUTPUT', `${label} 超出范围。`)
  }
  return value
}

function stringList(value: unknown, maximum = 4): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
    .map(item => item.trim()).filter(Boolean).slice(0, maximum)
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AnchorPortraitVisionError('INVALID_STRUCTURED_OUTPUT', `${label} 不是允许值。`)
  }
  return value as T
}

function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const accepted = new Set<string>(allowed)
  return [...new Set(stringList(value, allowed.length).filter(item => accepted.has(item)))] as T[]
}

function dimensionRecord<T>(raw: unknown, parse: (value: unknown, id: PortraitAnchorDimensionId) => T): Record<PortraitAnchorDimensionId, T> {
  if (!isRecord(raw)) {
    throw new AnchorPortraitVisionError('INVALID_STRUCTURED_OUTPUT', '缺少完整五维数据。')
  }
  return Object.fromEntries(PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [id, parse(raw[id], id)])) as Record<PortraitAnchorDimensionId, T>
}

function jpegHash(jpegBase64: string): string {
  return createHash('sha256').update(Buffer.from(jpegBase64, 'base64')).digest('hex')
}

function tierEligible(tier: PortraitAbsoluteTier): boolean {
  return tier === 'keep_threshold' || tier === 'keep' || tier === 'best'
}

function parseSubjectHeadFocus(value: unknown): ReferenceSheetFaceFocus {
  if (!isRecord(value)) {
    throw new AnchorPortraitVisionError(
      'MISSING_SUBJECT_HEAD_FOCUS',
      'high 结果必须冻结主人物头脸 focus，不能回退到本机自动检测。',
    )
  }
  return Object.freeze({
    center_x: finite(value.center_x, 0, 1, 'primarySubjectHeadFocus.center_x'),
    center_y: finite(value.center_y, 0, 1, 'primarySubjectHeadFocus.center_y'),
    side_fraction: finite(
      value.side_fraction, 0.05, 0.8, 'primarySubjectHeadFocus.side_fraction',
    ),
  })
}

function locallyDerivedPairResult(
  leftTier: PortraitAbsoluteTier,
  rightTier: PortraitAbsoluteTier,
  weightedMargin: number,
  confidence: number,
): PortraitAnchorPairwiseAssessment['result'] {
  if (leftTier === 'reject' && rightTier === 'reject') return 'reject_both'
  if (leftTier === 'uncertain' || rightTier === 'uncertain') return 'tie'
  if (tierEligible(leftTier) && rightTier === 'reject') return 'left'
  if (tierEligible(rightTier) && leftTier === 'reject') return 'right'
  if (!tierEligible(leftTier) || !tierEligible(rightTier)
    || Math.abs(weightedMargin) < ANCHOR_PAIRWISE_STABLE_MARGIN_POINTS
    || confidence < ANCHOR_PAIRWISE_STABLE_CONFIDENCE) return 'tie'
  return weightedMargin > 0 ? 'left' : weightedMargin < 0 ? 'right' : 'tie'
}

export class AnchorPortraitVisionClient {
  private readonly transport: AnchorVisionTransport
  readonly profile: PortraitEvaluationProfile
  private readonly visualRuntime?: VisualAnchorRuntime

  constructor(options: AnchorPortraitVisionOptions) {
    this.transport = options.transport
    this.profile = options.profile
    this.visualRuntime = options.visualRuntime
    if (this.profile.arm === 'A') {
      throw new AnchorPortraitVisionError('ARM_A_USES_LEGACY_CLIENT', 'A 必须继续使用冻结旧基线客户端。')
    }
    if (this.profile.arm === 'C') {
      if (!this.visualRuntime || !validHash(this.visualRuntime.legendHash)
        || hashText(this.visualRuntime.legendText) !== this.visualRuntime.legendHash) {
        throw new AnchorPortraitVisionError(
          'VISUAL_RUNTIME_REQUIRED',
          'C 必须绑定完整参考图版、QA 收据与匿名 legend。',
        )
      }
    } else if (this.visualRuntime) {
      throw new AnchorPortraitVisionError('VISUAL_RUNTIME_NOT_ALLOWED', 'B 不得加载视觉锚点。')
    }
  }

  stageCacheIdentity(input: Omit<PortraitStageIdentityInput, 'profile' | 'promptHash' | 'visualProtocol'>): string {
    const runtime = usesVisualAnchors(this.profile, input.stage) ? this.visualRuntime : undefined
    const prompt = promptIdentity(input.role, input.stage, runtime)
    return portraitStageCacheIdentity({
      ...input,
      profile: this.profile,
      promptHash: prompt.hash,
      ...(runtime ? { visualProtocol: runtime.protocol } : {}),
    })
  }

  async scoreBaseline(
    id: string,
    jpegBase64: string,
    detail: 'low' | 'high',
    role: PortraitEvaluationRole,
    signal?: AbortSignal,
  ): Promise<PortraitAnchorAssessment | FocusedPortraitAnchorAssessment> {
    const stage: PortraitEvaluationStage = detail
    const runtime = usesVisualAnchors(this.profile, stage) ? this.visualRuntime : undefined
    const prompt = promptIdentity(role, stage, runtime)
    const jpegs = runtime
      ? prepareAnchoredAttachments({
        profile: this.profile,
        stage: 'high',
        protocol: runtime.protocol,
        qualityReceipt: runtime.qualityReceipt,
        anchorSheetJpegBase64: runtime.anchorSheetJpegBase64,
        candidateJpegBase64: jpegBase64,
        limits: this.transport.attachmentLimits(),
      }).jpegs
      : [jpegBase64]
    const raw = await this.transport.invokeStructured({
      system: prompt.system,
      user: prompt.user,
      jpegs,
      tool: detail === 'high' ? BASELINE_TOOL_HIGH : BASELINE_TOOL_LOW,
      maxTokens: BASELINE_MAX_TOKENS,
    }, signal)
    const hardGateRaw = isRecord(raw.hardGate) ? raw.hardGate : {}
    const triggered = hardGateRaw.triggered === true
    const hardCode = hardGateRaw.code === null
      ? null
      : enumValue(hardGateRaw.code, PORTRAIT_HARD_GATE_CODES, 'hardGate.code')
    const absoluteTier = enumValue(raw.absoluteTier, PORTRAIT_ABSOLUTE_TIERS, 'absoluteTier')
    const dimensionScores = dimensionRecord(raw.dimensionScores,
      (value, dimension) => Math.round(finite(value, 0, 100, dimension))) as PortraitAnchorDimensionScores
    const assessment: PortraitAnchorAssessment = {
      id,
      rubricVersion: PORTRAIT_ANCHOR_RUBRIC_VERSION,
      hardGate: {
        triggered,
        code: hardCode as PortraitHardGateCode | null,
        confidence: finite(hardGateRaw.confidence, 0, 1, 'hardGate.confidence'),
        evidence: stringList(hardGateRaw.evidence),
      },
      absoluteTier,
      contentRejectCodes: enumList(raw.contentRejectCodes, PORTRAIT_CONTENT_REJECT_CODES) as PortraitContentRejectCode[],
      uncertaintyCodes: enumList(raw.uncertaintyCodes, PORTRAIT_UNCERTAINTY_CODES) as PortraitUncertaintyCode[],
      dimensionScores,
      dimensionEvidence: dimensionRecord(raw.dimensionEvidence, value => stringList(value, 3)),
      sortableScore: tierEligible(absoluteTier) ? anchorWeightedScore(dimensionScores) : null,
      overallConfidence: finite(raw.overallConfidence, 0, 1, 'overallConfidence'),
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    }
    const validated = validatePortraitAnchorAssessment(assessment)
    if (detail === 'low') return validated
    return Object.freeze({
      ...validated,
      primarySubjectHeadFocus: parseSubjectHeadFocus(raw.primarySubjectHeadFocus),
    })
  }

  async comparePairLeg(input: Readonly<{
    aId: string
    aJpegBase64: string
    bId: string
    bJpegBase64: string
    order: 'AB' | 'BA'
    role: PortraitEvaluationRole
    pairCandidateSheet?: PairCandidateSheetRuntime
    signal?: AbortSignal
  }>): Promise<AnchorPairwiseRawDecision> {
    const runtime = usesVisualAnchors(this.profile, 'pairwise') ? this.visualRuntime : undefined
    const firstJpeg = input.order === 'AB' ? input.aJpegBase64 : input.bJpegBase64
    const secondJpeg = input.order === 'AB' ? input.bJpegBase64 : input.aJpegBase64
    const firstId = input.order === 'AB' ? input.aId : input.bId
    const secondId = input.order === 'AB' ? input.bId : input.aId
    let jpegs: readonly string[]
    if (runtime) {
      if (!input.pairCandidateSheet
        || input.pairCandidateSheet.receipt.firstAnonymousID !== firstId
        || input.pairCandidateSheet.receipt.secondAnonymousID !== secondId
        || input.pairCandidateSheet.receipt.firstSourceJpegSha256 !== jpegHash(firstJpeg)
        || input.pairCandidateSheet.receipt.secondSourceJpegSha256 !== jpegHash(secondJpeg)) {
        throw new AnchorPortraitVisionError(
          'PAIR_SHEET_SOURCE_MISMATCH',
          'C pairwise 的双候选图版没有绑定当前 FIRST/SECOND 源预览。',
        )
      }
      jpegs = prepareAnchoredAttachments({
        profile: this.profile,
        stage: 'pairwise',
        protocol: runtime.protocol,
        qualityReceipt: runtime.qualityReceipt,
        anchorSheetJpegBase64: runtime.anchorSheetJpegBase64,
        candidateJpegBase64: input.pairCandidateSheet.jpegBase64,
        limits: this.transport.attachmentLimits(),
        pairCandidateReceipt: input.pairCandidateSheet.receipt,
      }).jpegs
    } else {
      if (input.pairCandidateSheet) {
        throw new AnchorPortraitVisionError('PAIR_SHEET_NOT_ALLOWED', 'B pairwise 必须直接附带两张候选图。')
      }
      jpegs = [firstJpeg, secondJpeg]
    }
    const prompt = promptIdentity(input.role, 'pairwise', runtime)
    const raw = await this.transport.invokeStructured({
      system: prompt.system,
      user: prompt.user,
      jpegs,
      tool: PAIRWISE_TOOL,
      maxTokens: PAIRWISE_MAX_TOKENS,
    }, input.signal)
    const firstTier = enumValue(raw.firstTier, PORTRAIT_ABSOLUTE_TIERS, 'firstTier')
    const secondTier = enumValue(raw.secondTier, PORTRAIT_ABSOLUTE_TIERS, 'secondTier')
    const leftTier = input.order === 'AB' ? firstTier : secondTier
    const rightTier = input.order === 'AB' ? secondTier : firstTier
    const modelDeltas = dimensionRecord(raw.dimensionDeltas,
      (value, dimension) => Math.round(finite(value, -2, 2, dimension)))
    const multiplier = input.order === 'AB' ? 1 : -1
    const normalizedDimensionDeltas = Object.fromEntries(PORTRAIT_ANCHOR_DIMENSION_IDS.map(id => [
      id, modelDeltas[id] * multiplier,
    ])) as Record<PortraitAnchorDimensionId, number>
    const weightedMargin = PORTRAIT_ANCHOR_DIMENSION_IDS.reduce(
      (sum, id) => sum + normalizedDimensionDeltas[id] * PORTRAIT_ANCHOR_WEIGHTS[id] / 100,
      0,
    ) * PAIRWISE_STEP_POINTS
    const confidence = finite(raw.confidence, 0, 1, 'confidence')
    const result = locallyDerivedPairResult(leftTier, rightTier, weightedMargin, confidence)
    const declared = enumValue(raw.result, ['first', 'second', 'tie', 'reject_both'] as const, 'result')
    const normalizedDeclared = declared === 'first'
      ? (input.order === 'AB' ? 'left' : 'right')
      : declared === 'second'
        ? (input.order === 'AB' ? 'right' : 'left')
        : declared
    if (normalizedDeclared !== result) {
      throw new AnchorPortraitVisionError(
        'PAIRWISE_OUTPUT_CONTRADICTION',
        '模型声明的 pairwise 结果与绝对层级/本地加权方向矛盾。',
      )
    }
    const value: AnchorPairwiseRawDecision = {
      order: input.order,
      leftTier,
      rightTier,
      result,
      strength: Math.abs(weightedMargin) >= 5 ? 'clear' : 'slight',
      normalizedDimensionDeltas,
      weightedMargin: Math.round(weightedMargin * 10_000) / 10_000,
      confidence,
      reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    }
    validatePortraitAnchorPairwise(value)
    return Object.freeze(value)
  }
}

export function combineAnchorPairwiseLegs(
  aId: string,
  bId: string,
  ab: AnchorPairwiseRawDecision,
  ba: AnchorPairwiseRawDecision,
): AnchorPairwiseResult {
  if (ab.order !== 'AB' || ba.order !== 'BA') {
    throw new AnchorPortraitVisionError('PAIRWISE_LEGS_INCOMPLETE', '必须同时提供 AB 与 BA。')
  }
  const sameTiers = ab.leftTier === ba.leftTier && ab.rightTier === ba.rightTier
  const sameResult = ab.result === ba.result
  const confidence = (ab.confidence + ba.confidence) / 2
  const margin = (Math.abs(ab.weightedMargin) + Math.abs(ba.weightedMargin)) / 2
  const stable = sameTiers && sameResult
    && confidence >= ANCHOR_PAIRWISE_STABLE_CONFIDENCE
    && (ab.result === 'reject_both' || ab.result === 'tie'
      || margin >= ANCHOR_PAIRWISE_STABLE_MARGIN_POINTS)
  const winner = stable
    ? ab.result === 'left' ? aId
      : ab.result === 'right' ? bId
        : ab.result === 'reject_both' ? 'REJECT_BOTH'
          : 'TIE'
    : 'TIE'
  return Object.freeze({
    winner,
    margin: Math.round(margin * 10_000) / 10_000,
    confidence: Math.round(confidence * 1_000) / 1_000,
    reason: stable ? `${ab.reason} | ${ba.reason}` : 'AB/BA 层级、方向或置信度不一致，保留为 TIE。',
    rawDecisions: Object.freeze([ab, ba]) as unknown as [AnchorPairwiseRawDecision, AnchorPairwiseRawDecision],
  })
}
