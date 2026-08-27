/**
 * Isolated visual client for the frozen portrait-baseline rubric.
 *
 * The model only observes anonymous JPEG pixels and a context-free rubric. It
 * never receives a filename, selection state, ranking, or user preference.
 */

import { createHash } from 'node:crypto'
import {
  HARNESS_VISION_PROTOCOL,
  HarnessVisionTransport,
  harnessRouteIdentity,
  isHarnessVisionCircuitBreakerError,
  type HarnessModelRoute,
} from './harness-vision.ts'
import {
  ELIGIBILITY_FAILURE_CODES,
  PORTRAIT_BASELINE_RUBRIC_VERSION,
  PORTRAIT_BASELINE_WEIGHTS,
  PORTRAIT_DIMENSION_IDS,
  type EligibilityFailureCode,
  type EligibilityStatus,
  type PortraitDimensionId,
  type PortraitDimensionScores,
} from './rubric.ts'
import {
  EXPRESSION_TAGS,
  FRAMING_TAGS,
  GAZE_TAGS,
  LIGHTING_TAGS,
  MOOD_TAGS,
  type ExpressionTag,
  type FramingTag,
  type GazeTag,
  type LightingTag,
  type MoodTag,
  type PhotoPreferenceAttributes,
} from './preferences.ts'

const PAIRWISE_STEP_POINTS = 5
// Reasoning-capable routed models can spend a substantial part of the output
// budget before emitting the required tool call. 1,200/600 caused valid image
// requests to terminate at maxTokens and then be paid for again on every resume.
// These ceilings stay bounded while leaving room for the tool call to finish.
const BASELINE_MAX_TOKENS = 4_000
const PAIRWISE_MAX_TOKENS = 2_400

export type PortraitDetail = 'low' | 'high'
export type PortraitEvaluatorRole = 'selector' | 'audit'

export interface PortraitEligibilityAssessment {
  status: EligibilityStatus
  failureCodes: EligibilityFailureCode[]
  evidence: string[]
  assessability: number
  ambiguousIntent: boolean
}

export interface PortraitObservableTags {
  expression: ExpressionTag[]
  gaze: GazeTag[]
  framing: FramingTag[]
  lighting: LightingTag[]
  mood: MoodTag[]
  scene: string[]
  poseAction: string[]
}

export interface PortraitBaselineAssessment {
  id: string
  rubricVersion: typeof PORTRAIT_BASELINE_RUBRIC_VERSION
  eligibility: PortraitEligibilityAssessment
  dimensionScores: PortraitDimensionScores
  dimensionConfidences: Record<PortraitDimensionId, number>
  dimensionEvidence: Record<PortraitDimensionId, string[]>
  /** Recomputed locally from the frozen weights; never trusted from model output. */
  baselineScore: number | null
  overallConfidence: number
  scoreInterval: [number, number]
  observableTags: PortraitObservableTags
  summary: string
}

export interface PortraitVisionOptions {
  transport: HarnessVisionTransport
}

export interface PairwiseRawDecision {
  order: 'AB' | 'BA'
  winner: 'A' | 'B' | 'TIE'
  normalizedDeltas: Record<PortraitDimensionId, number>
  weightedMargin: number
  confidence: number
  reason: string
}

export interface PairwiseResult {
  winner: string | 'TIE'
  margin: number
  confidence: number
  reason: string
  rawDecisions: [PairwiseRawDecision, PairwiseRawDecision]
}

export class PortraitVisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortraitVisionError'
  }
}

/**
 * Reject self-contradictory structured outputs before they can become a
 * quality verdict. This is deliberately deterministic and evidence-local: a
 * retryable provider-format failure is safer than silently converting rich,
 * positive visual evidence into a hard eligibility failure.
 */
export function assertPortraitBaselineAssessmentConsistent(
  assessment: PortraitBaselineAssessment,
): void {
  const { eligibility, dimensionScores, dimensionConfidences, dimensionEvidence } = assessment
  const failures = new Set(eligibility.failureCodes)
  if (failures.size !== eligibility.failureCodes.length) {
    throw new PortraitVisionError('资格失败码重复，结构化响应不一致')
  }
  if (eligibility.status === 'eligible' && (failures.size > 0 || eligibility.ambiguousIntent)) {
    throw new PortraitVisionError('eligible 与资格失败/意图歧义同时出现')
  }
  if (eligibility.status === 'ineligible' && failures.size === 0) {
    throw new PortraitVisionError('ineligible 缺少资格失败码')
  }
  if (eligibility.status === 'needs_review' && failures.size === 0 && !eligibility.ambiguousIntent) {
    throw new PortraitVisionError('needs_review 缺少失败码或意图歧义')
  }
  if (failures.has('HR_UNASSESSABLE_ASSET') && eligibility.assessability >= 0.5) {
    throw new PortraitVisionError('无法评估与高 assessability 同时出现')
  }
  const confidentlySupported = (dimension: PortraitDimensionId, minimumScore: number): boolean =>
    dimensionScores[dimension] >= minimumScore
    && dimensionConfidences[dimension] >= 0.6
    && dimensionEvidence[dimension].length > 0
  if (failures.has('HR_NO_INTENTIONAL_HUMAN_SUBJECT')
    && confidentlySupported('human_moment', 60)) {
    throw new PortraitVisionError('无人像主体失败码与清晰人物瞬间证据冲突')
  }
  if (failures.has('HR_PRIMARY_SUBJECT_UNINTERPRETABLE')
    && confidentlySupported('human_moment', 60)) {
    throw new PortraitVisionError('主体不可解释失败码与清晰人物瞬间证据冲突')
  }
  if (failures.has('HR_CATASTROPHIC_CAPTURE_FAILURE')
    && confidentlySupported('technical_subject_legibility', 60)) {
    throw new PortraitVisionError('灾难性拍摄失败码与高技术可读性证据冲突')
  }
  if (assessment.scoreInterval[0] > assessment.scoreInterval[1]) {
    throw new PortraitVisionError('scoreInterval 下界高于上界')
  }
}

export function isPortraitBaselineAssessmentConsistent(
  assessment: PortraitBaselineAssessment,
): boolean {
  try {
    assertPortraitBaselineAssessmentConsistent(assessment)
    return true
  } catch {
    return false
  }
}

/** Provider backpressure/limit signals stop scheduling new audit work in this invocation. */
export function isPortraitVisionCircuitBreakerError(error: unknown): boolean {
  return isHarnessVisionCircuitBreakerError(error)
}

const RUBRIC_TEXT = `你只评估一张匿名旅行人像本身，不比较、不排序、不判断是否已被选择，也不推测用户偏好。
资格与质量必须分开。只有以下四项可导致资格失败：
1. HR_UNASSESSABLE_ASSET：图像无法解码或无法进行视觉判断；
2. HR_NO_INTENTIONAL_HUMAN_SUBJECT：没有有意拍摄的人物主体；
3. HR_PRIMARY_SUBJECT_UNINTERPRETABLE：主要人物状态无法解释；
4. HR_CATASTROPHIC_CAPTURE_FAILURE：灾难性拍摄失败使画面意图无法成立。
闭眼、侧脸、背影、剪影、运动模糊、遮挡或非常规表情本身都不是自动淘汰；应结合可观察意图在六维里评分。无法区分事故与艺术意图时标 needs_review，ambiguousIntent=true。

六维均按 0–100 独立评分：
- technical_subject_legibility：技术质量与主体可读性；
- human_moment：表情、眼神、姿态与时机形成的人物瞬间；
- composition_visual_hierarchy：取景、边缘、前后景、动线与视觉层级；
- light_color_tone：光线方向、肤色、色彩与影调；
- travel_context_story：人物与地点、事件、旅途体验的联系；
- intentionality_finish：画面是否像完成的、有意识的成片。
锚点统一为 0 严重失败、25 明显欠缺、50 合格普通、75 强且只有小问题、100 极为出色且难以替代。

只依据像素证据。不要输出总分、推荐、名次、偏好适配度或选择建议。必须调用指定的结构化工具，不要返回纯文本。`

const SELECTOR_SYSTEM_PROMPT = `你是人像基线评分员。你的任务是稳定执行冻结标尺。\n\n${RUBRIC_TEXT}`
const AUDIT_SYSTEM_PROMPT = `你是与选片流程隔离的盲审人像评分员。你不知道候选如何产生，只能重新执行同一冻结标尺。\n\n${RUBRIC_TEXT}`

const BASELINE_USER_PROMPT = `评估附带的这一张匿名 JPEG。严格返回：
{"eligibility":{"status":"eligible|ineligible|needs_review","failureCodes":[],"evidence":[],"assessability":0.0,"ambiguousIntent":false},"dimensionScores":{"technical_subject_legibility":0,"human_moment":0,"composition_visual_hierarchy":0,"light_color_tone":0,"travel_context_story":0,"intentionality_finish":0},"dimensionConfidences":{"technical_subject_legibility":0.0,"human_moment":0.0,"composition_visual_hierarchy":0.0,"light_color_tone":0.0,"travel_context_story":0.0,"intentionality_finish":0.0},"dimensionEvidence":{"technical_subject_legibility":[],"human_moment":[],"composition_visual_hierarchy":[],"light_color_tone":[],"travel_context_story":[],"intentionality_finish":[]},"overallConfidence":0.0,"scoreInterval":[0,100],"observableTags":{"expression":[],"gaze":[],"framing":[],"lighting":[],"mood":[],"scene":[],"poseAction":[]},"summary":""}`

const PAIRWISE_SYSTEM_PROMPT = `你是隔离的旅行人像成对比较员。只比较两张匿名照片，不知道文件名、排名、选择状态或用户偏好。
按冻结六维标尺判断，每维 delta 只能是 -2、-1、0、1、2；正数表示 FIRST 更好，负数表示 SECOND 更好。
闭眼等现象不是自动淘汰，必须判断人物瞬间与画面意图。必须调用指定的结构化工具，不要返回纯文本。`

const PAIRWISE_USER_PROMPT = `比较按顺序附带的 FIRST 与 SECOND 两张匿名 JPEG。严格返回：
{"winner":"FIRST|SECOND|TIE","dimensionDeltas":{"technical_subject_legibility":0,"human_moment":0,"composition_visual_hierarchy":0,"light_color_tone":0,"travel_context_story":0,"intentionality_finish":0},"confidence":0.0,"reason":""}`

const DIMENSION_SCORE_PROPERTIES = Object.fromEntries(
  PORTRAIT_DIMENSION_IDS.map(id => [id, { type: 'number', minimum: 0, maximum: 100 }]),
)
const DIMENSION_CONFIDENCE_PROPERTIES = Object.fromEntries(
  PORTRAIT_DIMENSION_IDS.map(id => [id, { type: 'number', minimum: 0, maximum: 1 }]),
)
const DIMENSION_EVIDENCE_PROPERTIES = Object.fromEntries(
  PORTRAIT_DIMENSION_IDS.map(id => [id, {
    type: 'array',
    maxItems: 3,
    items: { type: 'string' },
  }]),
)

const BASELINE_TOOL = Object.freeze({
  name: 'submit_portrait_baseline',
  description: '提交一张匿名人像的冻结 baseline 结果。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: [
      'eligibility', 'dimensionScores', 'dimensionConfidences', 'dimensionEvidence',
      'overallConfidence', 'scoreInterval', 'observableTags', 'summary',
    ],
    properties: {
      eligibility: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'failureCodes', 'evidence', 'assessability', 'ambiguousIntent'],
        properties: {
          status: { type: 'string', enum: ['eligible', 'ineligible', 'needs_review'] },
          failureCodes: { type: 'array', items: { type: 'string', enum: [...ELIGIBILITY_FAILURE_CODES] } },
          evidence: { type: 'array', maxItems: 4, items: { type: 'string' } },
          assessability: { type: 'number', minimum: 0, maximum: 1 },
          ambiguousIntent: { type: 'boolean' },
        },
      },
      dimensionScores: {
        type: 'object', additionalProperties: false, required: [...PORTRAIT_DIMENSION_IDS],
        properties: DIMENSION_SCORE_PROPERTIES,
      },
      dimensionConfidences: {
        type: 'object', additionalProperties: false, required: [...PORTRAIT_DIMENSION_IDS],
        properties: DIMENSION_CONFIDENCE_PROPERTIES,
      },
      dimensionEvidence: {
        type: 'object', additionalProperties: false, required: [...PORTRAIT_DIMENSION_IDS],
        properties: DIMENSION_EVIDENCE_PROPERTIES,
      },
      overallConfidence: { type: 'number', minimum: 0, maximum: 1 },
      scoreInterval: {
        type: 'array', minItems: 2, maxItems: 2,
        items: { type: 'number', minimum: 0, maximum: 100 },
      },
      observableTags: {
        type: 'object',
        additionalProperties: false,
        required: ['expression', 'gaze', 'framing', 'lighting', 'mood', 'scene', 'poseAction'],
        properties: {
          expression: { type: 'array', items: { type: 'string', enum: [...EXPRESSION_TAGS] } },
          gaze: { type: 'array', items: { type: 'string', enum: [...GAZE_TAGS] } },
          framing: { type: 'array', items: { type: 'string', enum: [...FRAMING_TAGS] } },
          lighting: { type: 'array', items: { type: 'string', enum: [...LIGHTING_TAGS] } },
          mood: { type: 'array', items: { type: 'string', enum: [...MOOD_TAGS] } },
          scene: { type: 'array', maxItems: 4, items: { type: 'string' } },
          poseAction: { type: 'array', maxItems: 4, items: { type: 'string' } },
        },
      },
      summary: { type: 'string' },
    },
  },
})

const PAIRWISE_TOOL = Object.freeze({
  name: 'submit_portrait_pairwise',
  description: '提交两张匿名人像的一个方向比较。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['winner', 'dimensionDeltas', 'confidence', 'reason'],
    properties: {
      winner: { type: 'string', enum: ['FIRST', 'SECOND', 'TIE'] },
      dimensionDeltas: {
        type: 'object', additionalProperties: false, required: [...PORTRAIT_DIMENSION_IDS],
        properties: Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(id => [id, {
          type: 'integer', minimum: -2, maximum: 2,
        }])),
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
    },
  },
})

function promptHash(system: string, user: string, tool: typeof BASELINE_TOOL | typeof PAIRWISE_TOOL): string {
  return createHash('sha256')
    .update([system, user, tool.name, JSON.stringify(tool.parameters)].join('\u0000'))
    .digest('hex')
}

export const PORTRAIT_AUDIT_BASELINE_PROMPT_HASH = createHash('sha256')
  .update(`${AUDIT_SYSTEM_PROMPT}\u0000${BASELINE_USER_PROMPT}\u0000${BASELINE_TOOL.name}\u0000${JSON.stringify(BASELINE_TOOL.parameters)}`)
  .digest('hex')
export const PORTRAIT_AUDIT_PAIRWISE_PROMPT_HASH = promptHash(PAIRWISE_SYSTEM_PROMPT, PAIRWISE_USER_PROMPT, PAIRWISE_TOOL)

export const PORTRAIT_SELECTOR_BASELINE_PROMPT_HASH = promptHash(SELECTOR_SYSTEM_PROMPT, BASELINE_USER_PROMPT, BASELINE_TOOL)

export interface PortraitVisionCacheIdentity {
  provider: string
  model: string
  protocol: typeof HARNESS_VISION_PROTOCOL
  reasoningEffort?: string
  routeIdentity: string
  selectorBaselinePromptHash: string
  auditBaselinePromptHash: string
  auditPairwisePromptHash: string
}

export function portraitVisionCacheIdentity(route: HarnessModelRoute): Readonly<PortraitVisionCacheIdentity> {
  return Object.freeze({
    provider: route.provider,
    model: route.model,
    protocol: route.protocol,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    routeIdentity: harnessRouteIdentity(route),
    selectorBaselinePromptHash: PORTRAIT_SELECTOR_BASELINE_PROMPT_HASH,
    auditBaselinePromptHash: PORTRAIT_AUDIT_BASELINE_PROMPT_HASH,
    auditPairwisePromptHash: PORTRAIT_AUDIT_PAIRWISE_PROMPT_HASH,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Extract the last valid top-level JSON object, ignoring thoughts and fences. */
function parseLastJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/giu, '').trim()
  const parsedObjects: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < cleaned.length; index += 1) {
    const ch = cleaned[index]
    if (inString) {
      if (ch === '"' && !escaped) inString = false
      escaped = ch === '\\' && !escaped
      if (ch !== '\\') escaped = false
      continue
    }
    if (ch === '"') {
      inString = true
      escaped = false
    } else if (ch === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (ch === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(cleaned.slice(start, index + 1))
          if (isRecord(parsed)) parsedObjects.push(parsed)
        } catch {
          // Ignore malformed earlier objects; the final conclusion may be valid.
        }
        start = -1
      }
    }
  }
  const last = parsedObjects.at(-1)
  if (last) return last
  throw new PortraitVisionError('视觉模型未返回可解析的 JSON')
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new PortraitVisionError(`视觉结果缺少有效${label}`)
  return Math.min(maximum, Math.max(minimum, number))
}

function scoreValue(value: unknown): number {
  return Math.round(finiteNumber(value, 0, 100, '维度分'))
}

function confidenceValue(value: unknown): number {
  return Math.round(finiteNumber(value, 0, 1, '置信度') * 1000) / 1000
}

function stringList(value: unknown, maximum = 4): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, maximum)
    : []
}

function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed)
  return stringList(value).filter((item): item is T => allowedSet.has(item))
}

function dimensionRecord<T>(raw: unknown, parse: (value: unknown) => T): Record<PortraitDimensionId, T> {
  if (!isRecord(raw)) throw new PortraitVisionError('视觉结果缺少六维数据')
  return Object.fromEntries(PORTRAIT_DIMENSION_IDS.map(id => [id, parse(raw[id])])) as Record<PortraitDimensionId, T>
}

function localBaseline(scores: PortraitDimensionScores): number {
  const total = PORTRAIT_DIMENSION_IDS.reduce(
    (sum, id) => sum + scores[id] * PORTRAIT_BASELINE_WEIGHTS[id] / 100,
    0,
  )
  return Math.round((total + Number.EPSILON) * 10_000) / 10_000
}

/** Convert categorical observations to preference.ts-compatible one-hot evidence. */
export function observableTagsToPreferenceAttributes(tags: PortraitObservableTags): PhotoPreferenceAttributes {
  const oneHot = <T extends string>(values: readonly T[]): Partial<Record<T, number>> | undefined => {
    if (!values.length) return undefined
    return Object.fromEntries(values.map(value => [value, 1])) as Partial<Record<T, number>>
  }
  return Object.freeze({
    expression: oneHot(tags.expression),
    gaze: oneHot(tags.gaze),
    framing: oneHot(tags.framing),
    lighting: oneHot(tags.lighting),
    mood: oneHot(tags.mood),
  })
}

export class PortraitVisionClient {
  private readonly transport: HarnessVisionTransport

  constructor(options: PortraitVisionOptions) {
    this.transport = options.transport
  }

  /** Stable public identity for cache keys; never contains credentials. */
  get cacheIdentity(): Readonly<PortraitVisionCacheIdentity> {
    return portraitVisionCacheIdentity(this.transport.route)
  }

  private async chat(
    system: string,
    user: string,
    jpegs: readonly string[],
    tool: typeof BASELINE_TOOL | typeof PAIRWISE_TOOL,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.transport.invokeStructured({
      system,
      user,
      jpegs,
      tool,
      maxTokens,
    }, signal)
  }

  async scoreBaseline(
    id: string,
    jpeg: string,
    detail: PortraitDetail,
    signal?: AbortSignal,
    role: PortraitEvaluatorRole = 'selector',
  ): Promise<PortraitBaselineAssessment> {
    // detail is represented by the engine-generated JPEG dimensions. The
    // provider receives no local filename/path and no selector context.
    void detail
    const raw = await this.chat(
      role === 'audit' ? AUDIT_SYSTEM_PROMPT : SELECTOR_SYSTEM_PROMPT,
      BASELINE_USER_PROMPT,
      [jpeg],
      BASELINE_TOOL,
      BASELINE_MAX_TOKENS,
      signal,
    )
    const eligibilityRaw = isRecord(raw.eligibility) ? raw.eligibility : {}
    const rawStatus = eligibilityRaw.status
    let status: EligibilityStatus = rawStatus === 'eligible' || rawStatus === 'ineligible' || rawStatus === 'needs_review'
      ? rawStatus
      : 'needs_review'
    const allowedFailures = new Set<string>(ELIGIBILITY_FAILURE_CODES)
    const failureCodes = stringList(eligibilityRaw.failureCodes).filter(
      (code): code is EligibilityFailureCode => allowedFailures.has(code),
    )
    // Do not silently repair a contradictory provider response into a quality
    // judgment. The completed assessment is validated below and retried by the
    // resumable caller when inconsistent.
    const dimensionScores = dimensionRecord(raw.dimensionScores, scoreValue)
    const dimensionConfidences = dimensionRecord(raw.dimensionConfidences, confidenceValue)
    const dimensionEvidence = dimensionRecord(raw.dimensionEvidence, value => stringList(value, 3))
    const tagsRaw = isRecord(raw.observableTags) ? raw.observableTags : {}
    const scoreIntervalRaw = Array.isArray(raw.scoreInterval) ? raw.scoreInterval : []
    const computedBaseline = localBaseline(dimensionScores)

    const assessment = Object.freeze({
      id,
      rubricVersion: PORTRAIT_BASELINE_RUBRIC_VERSION,
      eligibility: Object.freeze({
        status,
        failureCodes: Object.freeze(failureCodes) as unknown as EligibilityFailureCode[],
        evidence: Object.freeze(stringList(eligibilityRaw.evidence)) as unknown as string[],
        assessability: confidenceValue(eligibilityRaw.assessability ?? 0),
        ambiguousIntent: eligibilityRaw.ambiguousIntent === true,
      }),
      dimensionScores: Object.freeze(dimensionScores),
      dimensionConfidences: Object.freeze(dimensionConfidences),
      dimensionEvidence: Object.freeze(dimensionEvidence),
      baselineScore: status === 'eligible' ? computedBaseline : null,
      overallConfidence: confidenceValue(raw.overallConfidence),
      scoreInterval: Object.freeze([
        scoreValue(scoreIntervalRaw[0] ?? computedBaseline),
        scoreValue(scoreIntervalRaw[1] ?? computedBaseline),
      ]) as unknown as [number, number],
      observableTags: Object.freeze({
        expression: enumList(tagsRaw.expression, EXPRESSION_TAGS),
        gaze: enumList(tagsRaw.gaze, GAZE_TAGS),
        framing: enumList(tagsRaw.framing, FRAMING_TAGS),
        lighting: enumList(tagsRaw.lighting, LIGHTING_TAGS),
        mood: enumList(tagsRaw.mood, MOOD_TAGS),
        scene: stringList(tagsRaw.scene),
        poseAction: stringList(tagsRaw.poseAction),
      }),
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    })
    assertPortraitBaselineAssessmentConsistent(assessment)
    return assessment
  }

  /** Execute exactly one directional leg so the audit can checkpoint AB and BA separately. */
  async comparePairLeg(
    aId: string,
    aJpeg: string,
    bId: string,
    bJpeg: string,
    order: 'AB' | 'BA',
    signal?: AbortSignal,
  ): Promise<PairwiseRawDecision> {
    // aId/bId deliberately participate only in the normalized A/B semantics;
    // neither identifier is sent to the provider.
    void aId
    void bId
    const first = order === 'AB' ? aJpeg : bJpeg
    const second = order === 'AB' ? bJpeg : aJpeg
    const raw = await this.chat(
      PAIRWISE_SYSTEM_PROMPT,
      PAIRWISE_USER_PROMPT,
      [first, second],
      PAIRWISE_TOOL,
      PAIRWISE_MAX_TOKENS,
      signal,
    )
    const modelDeltas = dimensionRecord(raw.dimensionDeltas, value => Math.round(finiteNumber(value, -2, 2, '比较差值')))
    const multiplier = order === 'AB' ? 1 : -1
    const normalizedDeltas = Object.fromEntries(
      PORTRAIT_DIMENSION_IDS.map(id => [id, modelDeltas[id] * multiplier]),
    ) as Record<PortraitDimensionId, number>
    const normalizedMargin = PORTRAIT_DIMENSION_IDS.reduce(
      (sum, id) => sum + normalizedDeltas[id] * PORTRAIT_BASELINE_WEIGHTS[id] / 100,
      0,
    ) * PAIRWISE_STEP_POINTS
    const claimed = raw.winner === 'FIRST' || raw.winner === 'SECOND' || raw.winner === 'TIE' ? raw.winner : 'TIE'
    const winner: 'A' | 'B' | 'TIE' = claimed === 'TIE'
      ? 'TIE'
      : (claimed === 'FIRST') === (order === 'AB') ? 'A' : 'B'
    return Object.freeze({
      order,
      winner,
      normalizedDeltas,
      weightedMargin: Math.round(normalizedMargin * 10_000) / 10_000,
      confidence: confidenceValue(raw.confidence),
      reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    })
  }

  async comparePair(
    aId: string,
    aJpeg: string,
    bId: string,
    bJpeg: string,
    signal?: AbortSignal,
  ): Promise<PairwiseResult> {
    const first = await this.comparePairLeg(aId, aJpeg, bId, bJpeg, 'AB', signal)
    const second = await this.comparePairLeg(aId, aJpeg, bId, bJpeg, 'BA', signal)
    return combinePairwiseLegs(aId, bId, first, second)
  }
}

/** Pure aggregation keeps cached directional legs equivalent to comparePair. */
export function combinePairwiseLegs(
  aId: string,
  bId: string,
  first: PairwiseRawDecision,
  second: PairwiseRawDecision,
): PairwiseResult {
  if (first.order !== 'AB' || second.order !== 'BA') {
    throw new PortraitVisionError('双向比较缺少 AB 或 BA leg')
  }
  const sameDirection = first.winner !== 'TIE' && first.winner === second.winner
    && Math.sign(first.weightedMargin) === Math.sign(second.weightedMargin)
    && (first.winner === 'A' ? first.weightedMargin > 0 : first.weightedMargin < 0)
  const margin = (Math.abs(first.weightedMargin) + Math.abs(second.weightedMargin)) / 2
  const confidence = (first.confidence + second.confidence) / 2
  const stable = sameDirection && margin >= 5 && confidence >= 0.75
  const winner = stable ? (first.winner === 'A' ? aId : bId) : 'TIE'
  return Object.freeze({
    winner,
    margin: Math.round(margin * 10_000) / 10_000,
    confidence: Math.round(confidence * 1000) / 1000,
    reason: stable ? `${first.reason}${first.reason && second.reason ? '；' : ''}${second.reason}` : '双向盲比较未达到稳定胜出阈值',
    rawDecisions: Object.freeze([first, second]) as unknown as [PairwiseRawDecision, PairwiseRawDecision],
  })
}
