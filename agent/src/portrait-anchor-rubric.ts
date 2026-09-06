import { createHash } from 'node:crypto'

export const PORTRAIT_ANCHOR_RUBRIC_VERSION = 'portrait-baseline-anchor-v0.1' as const
export const PORTRAIT_HARD_GATE_MIN_CONFIDENCE = 0.8

export const PORTRAIT_ANCHOR_DIMENSION_IDS = [
  'expression_eye_naturalness',
  'facial_features_shape',
  'pose_keepworthy_moment',
  'technical_completion',
  'environment_frame',
] as const

export type PortraitAnchorDimensionId = (typeof PORTRAIT_ANCHOR_DIMENSION_IDS)[number]
export type PortraitAnchorDimensionScores = Record<PortraitAnchorDimensionId, number>
export type PortraitAnchorDimensionEvidence = Record<PortraitAnchorDimensionId, string[]>

export const PORTRAIT_ANCHOR_WEIGHTS: Readonly<Record<PortraitAnchorDimensionId, number>> = Object.freeze({
  expression_eye_naturalness: 35,
  facial_features_shape: 25,
  pose_keepworthy_moment: 15,
  technical_completion: 15,
  environment_frame: 10,
})

export const PORTRAIT_ABSOLUTE_TIERS = [
  'reject',
  'keep_threshold',
  'keep',
  'best',
  'uncertain',
] as const
export type PortraitAbsoluteTier = (typeof PORTRAIT_ABSOLUTE_TIERS)[number]

export const PORTRAIT_HARD_GATE_CODES = [
  'HG_UNASSESSABLE_ASSET',
  'HG_NO_INTENTIONAL_HUMAN_SUBJECT',
  'HG_PRIMARY_SUBJECT_EYES_CLOSED_OR_BLINKING',
  'HG_PRIMARY_FACE_UNREADABLE_TECHNICAL',
  'HG_ABNORMAL_BODY_POSE',
] as const
export type PortraitHardGateCode = (typeof PORTRAIT_HARD_GATE_CODES)[number]

export const PORTRAIT_CONTENT_REJECT_CODES = [
  'CQ_LOW_EYE_ENERGY',
  'CQ_STARING_OR_TENSE_GAZE',
  'CQ_UNNATURAL_OR_TRANSITIONAL_EXPRESSION',
  'CQ_UNFLATTERING_FACE_RELATIVE_TO_SELF',
  'CQ_NO_KEEPWORTHY_MOMENT',
  'CQ_POSE_OR_INTENT_WEAK',
] as const
export type PortraitContentRejectCode = (typeof PORTRAIT_CONTENT_REJECT_CODES)[number]

export const PORTRAIT_UNCERTAINTY_CODES = [
  'eye_state_ambiguous',
  'expression_intent_ambiguous',
  'face_too_small',
  'pose_intent_ambiguous',
  'near_keep_threshold',
] as const
export type PortraitUncertaintyCode = (typeof PORTRAIT_UNCERTAINTY_CODES)[number]

export interface PortraitAnchorHardGate {
  triggered: boolean
  code: PortraitHardGateCode | null
  confidence: number
  evidence: string[]
}

export interface PortraitAnchorAssessment {
  id: string
  rubricVersion: typeof PORTRAIT_ANCHOR_RUBRIC_VERSION
  hardGate: PortraitAnchorHardGate
  absoluteTier: PortraitAbsoluteTier
  contentRejectCodes: PortraitContentRejectCode[]
  uncertaintyCodes: PortraitUncertaintyCode[]
  dimensionScores: PortraitAnchorDimensionScores
  dimensionEvidence: PortraitAnchorDimensionEvidence
  /** Locally recomputed and null unless the photo crosses the keep threshold. */
  sortableScore: number | null
  overallConfidence: number
  summary: string
}

export type PortraitAnchorPairwiseResult = 'left' | 'right' | 'tie' | 'reject_both'

export interface PortraitAnchorPairwiseAssessment {
  leftTier: PortraitAbsoluteTier
  rightTier: PortraitAbsoluteTier
  result: PortraitAnchorPairwiseResult
  strength: 'slight' | 'clear'
  reason: string
}

export class PortraitAnchorRubricError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortraitAnchorRubricError'
  }
}

/**
 * This text is the frozen experiment-B/C evaluation contract. Changing any
 * sentence changes the exported content hash and invalidates paid caches.
 */
export const PORTRAIT_ANCHOR_RUBRIC_TEXT = `你在一批旅行人像中挑选真正值得保留的照片。必须按层判断，不能只计算一个总分。

第一层：高置信度硬淘汰。
- 无法评估、没有有意人物主体、人脸因失焦/重影/严重曝光失败而不可读：淘汰。
- 单一主要人物明确闭眼、眨眼或一只眼异常闭合：淘汰。自然笑眼、轻微眯眼或没有完全睁大不自动淘汰。
- 明显超出正常人体动作的扭曲姿态：淘汰。轻微摆拍感、轻微仰头不自动淘汰。
- 只有可观察证据充分且 confidence>=0.8 才触发 hard gate；否则 absoluteTier=uncertain，并要求 high_review。

第二层：绝对保留线。
每张照片独立归入 reject / keep_threshold / keep / best / uncertain。
- 五官整体自然舒展，眼睛与表情协调、有精神、有明确意图。
- 脸型相对这个人的其他照片流畅，没有被角度明显扭曲。
- 姿态和瞬间值得保留；普通背影或过渡帧不能只靠风景入选。
- 眼睛未完全睁开但整体五官、脸型和表情仍自然，可以 keep_threshold。
- 眼睛即使睁开，若呈瞪视、紧绷、呆滞或不自然过渡态，仍应 reject。

第三层：同人相对排序。
- 两张都 reject 时必须 reject_both，不能选“较不差”的一张。
- 一张过线、一张 reject 时选择过线者。
- 两张都过线时，先比较表情和眼神，再比较五官脸型、姿态瞬间，最后才比较技术与环境。
- 人物呈现占75%，技术完成度15%，环境与画面10%；这些权重只能用于过线照片，不能救回硬淘汰或内容 reject。
- 背景和多样性只能在人物质量足够接近时作为 tie-breaker。

必须分别输出 hardGate、absoluteTier、contentRejectCodes、uncertaintyCodes、五维分数和可观察证据。不要根据文件名、已有排名、入选状态或用户 oracle 判断。`

export const PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH = createHash('sha256')
  .update(JSON.stringify({
    version: PORTRAIT_ANCHOR_RUBRIC_VERSION,
    hardGateConfidence: PORTRAIT_HARD_GATE_MIN_CONFIDENCE,
    dimensions: PORTRAIT_ANCHOR_DIMENSION_IDS,
    weights: PORTRAIT_ANCHOR_WEIGHTS,
    tiers: PORTRAIT_ABSOLUTE_TIERS,
    hardGateCodes: PORTRAIT_HARD_GATE_CODES,
    contentRejectCodes: PORTRAIT_CONTENT_REJECT_CODES,
    uncertaintyCodes: PORTRAIT_UNCERTAINTY_CODES,
    outputContract: [
      'hardGate',
      'absoluteTier',
      'contentRejectCodes',
      'uncertaintyCodes',
      'dimensionScores',
      'dimensionEvidence',
      'overallConfidence',
      'summary',
    ],
    text: PORTRAIT_ANCHOR_RUBRIC_TEXT,
  }))
  .digest('hex')

function finiteScore(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new PortraitAnchorRubricError(`${label} 必须是 0..100 的有限数。`)
  }
  return value
}

function finiteConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new PortraitAnchorRubricError('hardGate.confidence 必须是 0..1 的有限数。')
  }
  return value
}

function isSortableTier(tier: PortraitAbsoluteTier): boolean {
  return tier === 'keep_threshold' || tier === 'keep' || tier === 'best'
}

export function anchorWeightedScore(scores: PortraitAnchorDimensionScores): number {
  const score = PORTRAIT_ANCHOR_DIMENSION_IDS.reduce(
    (sum, id) => sum + finiteScore(scores[id], id) * PORTRAIT_ANCHOR_WEIGHTS[id] / 100,
    0,
  )
  return Math.round((score + Number.EPSILON) * 10_000) / 10_000
}

/** Validate provider output before it can enter ranking or a paid cache. */
export function validatePortraitAnchorAssessment(
  assessment: PortraitAnchorAssessment,
): PortraitAnchorAssessment {
  if (assessment.rubricVersion !== PORTRAIT_ANCHOR_RUBRIC_VERSION) {
    throw new PortraitAnchorRubricError('锚点评估 Rubric 版本不匹配。')
  }
  const confidence = finiteConfidence(assessment.hardGate.confidence)
  finiteConfidence(assessment.overallConfidence)
  if (assessment.hardGate.triggered) {
    if (!assessment.hardGate.code || assessment.hardGate.evidence.length === 0) {
      throw new PortraitAnchorRubricError('hard gate 缺少代码或可观察证据。')
    }
    if (confidence < PORTRAIT_HARD_GATE_MIN_CONFIDENCE) {
      throw new PortraitAnchorRubricError('低置信度 hard gate 必须改为 uncertain/high_review。')
    }
    if (assessment.absoluteTier !== 'reject') {
      throw new PortraitAnchorRubricError('hard gate 触发时 absoluteTier 必须是 reject。')
    }
  } else if (assessment.hardGate.code !== null) {
    throw new PortraitAnchorRubricError('未触发 hard gate 时 code 必须为 null。')
  }
  if (assessment.absoluteTier === 'reject'
    && !assessment.hardGate.triggered
    && assessment.contentRejectCodes.length === 0) {
    throw new PortraitAnchorRubricError('内容 reject 必须给出 contentRejectCodes。')
  }
  if (assessment.absoluteTier === 'uncertain' && assessment.uncertaintyCodes.length === 0) {
    throw new PortraitAnchorRubricError('uncertain 必须给出 uncertaintyCodes。')
  }
  if (isSortableTier(assessment.absoluteTier) && assessment.hardGate.triggered) {
    throw new PortraitAnchorRubricError('hard reject 不能进入可排序层级。')
  }
  const computed = anchorWeightedScore(assessment.dimensionScores)
  for (const id of PORTRAIT_ANCHOR_DIMENSION_IDS) {
    const evidence = assessment.dimensionEvidence[id]
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 3
      || evidence.some(item => typeof item !== 'string' || item.trim().length === 0)) {
      throw new PortraitAnchorRubricError(`${id} 必须包含 1..3 条可观察像素证据。`)
    }
  }
  const expected = isSortableTier(assessment.absoluteTier) ? computed : null
  if (assessment.sortableScore !== expected) {
    throw new PortraitAnchorRubricError('sortableScore 必须由本地权重重算，reject/uncertain 必须为 null。')
  }
  return assessment
}

function tierEligible(tier: PortraitAbsoluteTier): boolean {
  return tier === 'keep_threshold' || tier === 'keep' || tier === 'best'
}

export function validatePortraitAnchorPairwise(
  value: PortraitAnchorPairwiseAssessment,
): PortraitAnchorPairwiseAssessment {
  const leftEligible = tierEligible(value.leftTier)
  const rightEligible = tierEligible(value.rightTier)
  if (value.leftTier === 'reject' && value.rightTier === 'reject' && value.result !== 'reject_both') {
    throw new PortraitAnchorRubricError('两张都 reject 时 pairwise 必须输出 reject_both。')
  }
  if (value.result === 'reject_both'
    && (value.leftTier !== 'reject' || value.rightTier !== 'reject')) {
    throw new PortraitAnchorRubricError('reject_both 要求左右绝对层级都为 reject。')
  }
  if (leftEligible && value.rightTier === 'reject' && value.result !== 'left') {
    throw new PortraitAnchorRubricError('过线照片必须胜过 reject 照片。')
  }
  if (rightEligible && value.leftTier === 'reject' && value.result !== 'right') {
    throw new PortraitAnchorRubricError('过线照片必须胜过 reject 照片。')
  }
  if ((value.leftTier === 'uncertain' || value.rightTier === 'uncertain')
    && value.result !== 'tie') {
    throw new PortraitAnchorRubricError('含 uncertain 的 pairwise 必须保留为 tie，等待复核。')
  }
  return value
}
