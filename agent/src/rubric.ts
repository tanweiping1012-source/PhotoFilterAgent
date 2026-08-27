/**
 * Versioned, context-free baseline rubric for selecting excellent portraits.
 *
 * The rubric intentionally separates eligibility from quality. Eligibility only
 * rejects an image when it cannot participate in a meaningful portrait ranking;
 * stylistic choices such as closed eyes remain scoreable evidence rather than an
 * automatic rejection.
 *
 * @module
 */

/** Stable identifier persisted with every rubric result. */
export const PORTRAIT_BASELINE_RUBRIC_VERSION = 'portrait-baseline-v1.0.0' as const

/** The six independently scored dimensions in the frozen v1 baseline. */
export const PORTRAIT_DIMENSION_IDS = [
  'technical_subject_legibility',
  'human_moment',
  'composition_visual_hierarchy',
  'light_color_tone',
  'travel_context_story',
  'intentionality_finish',
] as const

export type PortraitDimensionId = (typeof PORTRAIT_DIMENSION_IDS)[number]

/** Scores are always expressed on a 0–100 scale before weighting. */
export type PortraitDimensionScores = Record<PortraitDimensionId, number>

export interface RubricAnchor {
  score: 0 | 25 | 50 | 75 | 100
  description: string
}

export interface PortraitDimensionDefinition {
  id: PortraitDimensionId
  label: string
  weight: number
  question: string
  anchors: readonly [RubricAnchor, RubricAnchor, RubricAnchor, RubricAnchor, RubricAnchor]
}

/**
 * The weights sum to 100 and are the sole no-preference baseline. Changing them
 * is a rubric version change, not a user preference.
 */
export const PORTRAIT_BASELINE_WEIGHTS: Readonly<Record<PortraitDimensionId, number>> = Object.freeze({
  technical_subject_legibility: 18,
  human_moment: 22,
  composition_visual_hierarchy: 18,
  light_color_tone: 16,
  travel_context_story: 16,
  intentionality_finish: 10,
})

/** Human-readable scoring contract suitable for an isolated evaluator agent. */
export const PORTRAIT_BASELINE_RUBRIC: Readonly<{
  version: typeof PORTRAIT_BASELINE_RUBRIC_VERSION
  scale: '0-100'
  dimensions: readonly PortraitDimensionDefinition[]
}> = Object.freeze({
  version: PORTRAIT_BASELINE_RUBRIC_VERSION,
  scale: '0-100',
  dimensions: Object.freeze([
    {
      id: 'technical_subject_legibility',
      label: '技术质量与主体可读性',
      weight: 18,
      question: '主体是否清楚、可读，关键细节是否被焦点、抖动、曝光或遮挡破坏？',
      anchors: [
        { score: 0, description: '主体关键细节严重损坏，观看意图难以成立。' },
        { score: 25, description: '主体勉强可辨，但技术问题持续阻碍判断人物状态。' },
        { score: 50, description: '主体可读，但存在可见且分散注意力的技术问题。' },
        { score: 75, description: '关键细节可靠，只有轻微问题且不妨碍观看。' },
        { score: 100, description: '技术处理完整服务于主体，关键细节清楚且没有干扰。' },
      ],
    },
    {
      id: 'human_moment',
      label: '人物瞬间',
      weight: 22,
      question: '表情、眼神、姿态与时机是否自然、有感染力且彼此一致？',
      anchors: [
        { score: 0, description: '表情或姿态明显失误，人物状态缺乏可取之处。' },
        { score: 25, description: '人物状态勉强成立，但时机、表情或姿态有明显问题。' },
        { score: 50, description: '人物状态合格，但普通、僵硬或缺少决定性瞬间。' },
        { score: 75, description: '人物状态自然且有感染力，只缺少不可替代性。' },
        { score: 100, description: '表情、眼神与动作形成真实、准确且难以复刻的瞬间。' },
      ],
    },
    {
      id: 'composition_visual_hierarchy',
      label: '构图与视觉层级',
      weight: 18,
      question: '取景、主体位置、边缘、前后景和视觉动线是否形成明确层级？',
      anchors: [
        { score: 0, description: '取景混乱或关键部位被意外截断，主体关系不成立。' },
        { score: 25, description: '能找到主体，但边缘、比例或背景关系明显失控。' },
        { score: 50, description: '构图稳定可用，但层级普通或仍有明显干扰。' },
        { score: 75, description: '主体层级明确，取景与动线有效且只有轻微干扰。' },
        { score: 100, description: '画面组织精准，视觉动线自然强化人物与环境关系。' },
      ],
    },
    {
      id: 'light_color_tone',
      label: '光线、色彩与影调',
      weight: 16,
      question: '光线方向、肤色、色彩关系和影调是否共同塑造人物？',
      anchors: [
        { score: 0, description: '光色或影调明显破坏人物呈现且缺少可解释的意图。' },
        { score: 25, description: '人物仍可辨，但肤色、反差或色彩关系明显不协调。' },
        { score: 50, description: '曝光和色彩基本可靠，但造型作用有限。' },
        { score: 75, description: '光色协调并有效塑造人物，仍有少量可优化之处。' },
        { score: 100, description: '光线与色彩具有明确造型作用，肤色和氛围协调。' },
      ],
    },
    {
      id: 'travel_context_story',
      label: '旅行语境与叙事',
      weight: 16,
      question: '照片是否把人物与地点、事件或旅途体验连接成有信息的画面？',
      anchors: [
        { score: 0, description: '环境没有信息，人物与旅行语境割裂。' },
        { score: 25, description: '存在环境线索，但与人物关系偶然或信息很弱。' },
        { score: 50, description: '能辨认地点或活动，但叙事关系较弱。' },
        { score: 75, description: '人物与地点形成清楚关系，能够唤起具体旅途记忆。' },
        { score: 100, description: '人物与环境相互解释，单张照片即可承载具体旅途记忆。' },
      ],
    },
    {
      id: 'intentionality_finish',
      label: '完成度与意图',
      weight: 10,
      question: '所有选择是否像有意识的成片，而不是偶然合格的快照？',
      anchors: [
        { score: 0, description: '明显像误触、过渡帧或未完成的尝试。' },
        { score: 25, description: '存在拍摄意图，但画面仍像未完成或未经判断的版本。' },
        { score: 50, description: '可交付，但仍能看到犹豫、偶然或未整理之处。' },
        { score: 75, description: '整体判断明确且完成度高，只剩局部可推敲。' },
        { score: 100, description: '画面选择统一、克制且完成度高，具有明确作者判断。' },
      ],
    },
  ] as const satisfies readonly PortraitDimensionDefinition[]),
})

/** Only these conditions may make a portrait ineligible in rubric v1. */
export const ELIGIBILITY_FAILURE_CODES = [
  'HR_UNASSESSABLE_ASSET',
  'HR_NO_INTENTIONAL_HUMAN_SUBJECT',
  'HR_PRIMARY_SUBJECT_UNINTERPRETABLE',
  'HR_CATASTROPHIC_CAPTURE_FAILURE',
] as const

export type EligibilityFailureCode = (typeof ELIGIBILITY_FAILURE_CODES)[number]

/**
 * Hard caps prevent preferences from rescuing an invalid candidate. A zero cap
 * means the image cannot be meaningfully scored as the requested portrait.
 */
export type EligibilityStatus = 'eligible' | 'needs_review' | 'ineligible'

export const ELIGIBILITY_CONFIDENCE_THRESHOLDS: Readonly<Partial<Record<EligibilityFailureCode, number>>> = Object.freeze({
  HR_NO_INTENTIONAL_HUMAN_SUBJECT: 0.98,
  HR_PRIMARY_SUBJECT_UNINTERPRETABLE: 0.95,
  HR_CATASTROPHIC_CAPTURE_FAILURE: 0.95,
})

export interface EligibilityGateInput {
  /** The file can be decoded and visually judged. */
  assessable: boolean
  /** The image intentionally contains a human subject, not an incidental passer-by. */
  intentionalHumanSubject: boolean
  /** Required for automatic ineligibility when `intentionalHumanSubject` is false. */
  intentionalHumanSubjectConfidence?: number
  /** The primary person's visual state can be interpreted. */
  primarySubjectInterpretable: boolean
  /** Required for automatic ineligibility when `primarySubjectInterpretable` is false. */
  primarySubjectInterpretableConfidence?: number
  /** Irrecoverable corruption or technical failure defeats the image's intent. */
  catastrophicFailure?: boolean
  catastrophicFailureConfidence?: number
  /** Any ambiguity between an accident and artistic intent requires human review. */
  ambiguousIntent?: boolean
  /** Explicit upstream escape hatch when evidence cannot support an automatic decision. */
  needsReview?: boolean
}

export interface EligibilityGateResult {
  status: EligibilityStatus
  eligible: boolean
  failures: readonly EligibilityFailureCode[]
  /** Non-eligible results are capped to zero and never receive a sortable score. */
  scoreCap: number
}

export interface PortraitRubricResult {
  rubricVersion: typeof PORTRAIT_BASELINE_RUBRIC_VERSION
  eligibility: EligibilityGateResult
  dimensionScores: PortraitDimensionScores
  /** Weighted baseline before an eligibility cap. */
  uncappedScore: number
  /** Baseline after the hard cap. This is the no-preference score. */
  baselineScore: number
  /** Null for both `needs_review` and `ineligible`; only eligible photos may rank. */
  sortableScore: number | null
}

function assertBoolean(value: unknown, name: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
}

function assertConfidence(value: unknown, name: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number between 0 and 1`)
  }
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

/** Evaluate the exhaustive v1 eligibility gate. Closed eyes are deliberately absent. */
export function evaluateEligibilityGate(input: EligibilityGateInput): EligibilityGateResult {
  assertBoolean(input.assessable, 'assessable')
  assertBoolean(input.intentionalHumanSubject, 'intentionalHumanSubject')
  assertBoolean(input.primarySubjectInterpretable, 'primarySubjectInterpretable')
  if (input.catastrophicFailure !== undefined) {
    assertBoolean(input.catastrophicFailure, 'catastrophicFailure')
  }
  if (input.ambiguousIntent !== undefined) assertBoolean(input.ambiguousIntent, 'ambiguousIntent')
  if (input.needsReview !== undefined) assertBoolean(input.needsReview, 'needsReview')
  assertConfidence(input.intentionalHumanSubjectConfidence, 'intentionalHumanSubjectConfidence')
  assertConfidence(input.primarySubjectInterpretableConfidence, 'primarySubjectInterpretableConfidence')
  assertConfidence(input.catastrophicFailureConfidence, 'catastrophicFailureConfidence')

  const failures: EligibilityFailureCode[] = []
  let hasAutomaticIneligibility = false
  let hasReviewCondition = Boolean(input.ambiguousIntent || input.needsReview)
  if (!input.assessable) {
    failures.push('HR_UNASSESSABLE_ASSET')
    hasReviewCondition = true
  }
  if (!input.intentionalHumanSubject) {
    failures.push('HR_NO_INTENTIONAL_HUMAN_SUBJECT')
    if ((input.intentionalHumanSubjectConfidence ?? 0) >= ELIGIBILITY_CONFIDENCE_THRESHOLDS.HR_NO_INTENTIONAL_HUMAN_SUBJECT!) {
      hasAutomaticIneligibility = true
    } else {
      hasReviewCondition = true
    }
  }
  if (!input.primarySubjectInterpretable) {
    failures.push('HR_PRIMARY_SUBJECT_UNINTERPRETABLE')
    if ((input.primarySubjectInterpretableConfidence ?? 0) >= ELIGIBILITY_CONFIDENCE_THRESHOLDS.HR_PRIMARY_SUBJECT_UNINTERPRETABLE!) {
      hasAutomaticIneligibility = true
    } else {
      hasReviewCondition = true
    }
  }
  if (input.catastrophicFailure) {
    failures.push('HR_CATASTROPHIC_CAPTURE_FAILURE')
    if ((input.catastrophicFailureConfidence ?? 0) >= ELIGIBILITY_CONFIDENCE_THRESHOLDS.HR_CATASTROPHIC_CAPTURE_FAILURE!) {
      hasAutomaticIneligibility = true
    } else {
      hasReviewCondition = true
    }
  }

  const status: EligibilityStatus = hasAutomaticIneligibility
    ? 'ineligible'
    : hasReviewCondition
      ? 'needs_review'
      : 'eligible'
  return Object.freeze({
    status,
    eligible: status === 'eligible',
    failures: Object.freeze(failures),
    scoreCap: status === 'eligible' ? 100 : 0,
  })
}

/** Validate that all six dimension scores are finite values in the closed range 0–100. */
export function validatePortraitDimensionScores(scores: PortraitDimensionScores): void {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw new TypeError('dimensionScores must be an object')
  }
  for (const id of PORTRAIT_DIMENSION_IDS) {
    const value = scores[id]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new RangeError(`dimensionScores.${id} must be a finite number between 0 and 100`)
    }
  }
}

/**
 * Aggregate the frozen baseline, then apply the eligibility hard cap.
 *
 * @param dimensionScores - Independent 0–100 judgments for all six dimensions.
 * @param eligibilityInput - Facts for the exhaustive eligibility gate.
 */
export function scorePortraitBaseline(
  dimensionScores: PortraitDimensionScores,
  eligibilityInput: EligibilityGateInput,
): PortraitRubricResult {
  validatePortraitDimensionScores(dimensionScores)
  const eligibility = evaluateEligibilityGate(eligibilityInput)
  const uncappedScore = roundScore(PORTRAIT_DIMENSION_IDS.reduce(
    (sum, id) => sum + dimensionScores[id] * PORTRAIT_BASELINE_WEIGHTS[id] / 100,
    0,
  ))
  const baselineScore = roundScore(Math.min(uncappedScore, eligibility.scoreCap))

  return Object.freeze({
    rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
    eligibility,
    dimensionScores: Object.freeze({ ...dimensionScores }),
    uncappedScore,
    baselineScore,
    sortableScore: eligibility.status === 'eligible' ? baselineScore : null,
  })
}
