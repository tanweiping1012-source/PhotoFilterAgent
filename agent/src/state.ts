/**
 * 一轮策展的运行状态。
 *
 * 它是“上下文经济学”的落点：工具结果进这里，不进对话历史。模型每一轮读到的是
 * 一份**渲染出来的固定大小摘要**（当前排名、切线、还剩什么没看），而不是几十条
 * 历史打分记录的重放。
 * @module
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AnalyzeReport, Candidate, Family } from './engine.ts'
import { weightedTotal, type Dimensions, type PhotoScore } from './vision.ts'
import {
  isPortraitBaselineAssessmentConsistent,
  observableTagsToPreferenceAttributes,
  type PairwiseRawDecision,
  type PairwiseResult,
  type PortraitBaselineAssessment,
  type PortraitDetail,
} from './portrait-vision.ts'
import type { AuditPairPlan } from './audit-v3.ts'
import {
  applyPreferenceOverlay,
  createPreferenceProfile,
  type PreferenceProfile,
  type PreferenceProfileInput,
} from './preferences.ts'
import { scorePortraitBaseline } from './rubric.ts'
import type { PairwiseComparison } from './ranking.ts'
import type { HighRefinementPlan, PairwiseBudgetPlan } from './selection-budget.ts'

export type Category = 'people' | 'scenery'
export type CandidateScope = 'auto' | 'people_only'

/**
 * Parse the user-visible candidate policy before any paid tool can run.
 * `people_only` is deliberately opt-in and must be paired with an explicit
 * zero scenery target so a mixed/scenery workflow is never widened silently.
 */
export function parseCandidateScope(value: unknown, sceneryTarget: unknown): CandidateScope {
  if (value === undefined || value === 'auto') return 'auto'
  if (value !== 'people_only') {
    throw new TypeError('candidate_scope 必须是 auto 或 people_only。')
  }
  if (sceneryTarget !== 0) {
    throw new TypeError('candidate_scope=people_only 必须在同一次 analyze_folder 明确设置 scenery_target=0。')
  }
  return 'people_only'
}

export interface StoredScore {
  dimensions: Dimensions
  /** 打这一次分用的档位；同一张已有 ≥ 该档位的分数就不再重复付费。 */
  detail: 'low' | 'high'
  reasons: string[]
  summary: string
}

export interface StoredPortraitScore {
  assessment: PortraitBaselineAssessment
  /** low 粗评可被 high 覆盖；相反方向禁止，避免为降档重复付费。 */
  detail: 'low' | 'high'
  /** rubric + provider/model 的稳定身份；任何一项变化都让旧缓存失效。 */
  cacheKey: string
}

/**
 * 独立 evaluator 的逐图盲评分数。
 *
 * 它不能与 selector 的 `portraitScores` 共用，否则审计会受到主流程结论污染；
 * 但它又必须落盘，否则一次 255 张的审计只要后半段限流，重试就会把前半段全部重买。
 */
export interface StoredPortraitAuditScore {
  assessment: PortraitBaselineAssessment
  detail: PortraitDetail
  /** dataset + rubric + provider/model 的稳定身份。 */
  cacheKey: string
}

/** 一次完整的双向盲比较结果；只在 AB 与 BA 都成功后写入缓存。 */
export interface StoredPortraitAuditPairwise {
  leftId: string
  rightId: string
  result: PairwiseResult
  cacheKey: string
}

/** v3 persists each directional leg independently; legacy complete-pair cache is never trusted. */
export interface StoredPortraitAuditPairwiseLeg {
  challengerId: string
  selectedId: string
  order: 'AB' | 'BA'
  decision: PairwiseRawDecision
  cacheKey: string
}

/** Selector-side directional pair leg, persisted before the reverse leg starts. */
export interface StoredPortraitSelectorPairwiseLeg {
  aId: string
  bId: string
  order: 'AB' | 'BA'
  decision: PairwiseRawDecision
  cacheKey: string
}

export interface PortraitDraft {
  keep: string[]
  why: Record<string, string>
  baselineScores: Record<string, number>
  personalizedScores: Record<string, number>
  selectionHash: string
  preference: PreferenceProfile
  selectorIdentityKey: string
  selectorPairwiseIdentityKey: string
}

/**
 * Durable two-phase export authorization. The code is bound to both the exact
 * frozen selection and the canonical destination, and is consumed before any
 * copy starts.
 */
export interface ExportApproval {
  schemaVersion: 'export-approval-v1'
  selectionHash: string
  destination: string
  confirmationCode: string
  /** Last genuine user message visible when the code was issued. */
  requestedAfterUserMessageId?: string
}

/**
 * Paid high-detail candidates are frozen before the first request. A retry may
 * fill failures from this same set, but cannot re-rank mixed low/high scores and
 * silently admit a 61st paid candidate.
 */
export interface PortraitRefinementCheckpoint {
  schemaVersion: 'portrait-refinement-checkpoint-v1'
  /** dataset + scope + target + preference + rubric/model + planning algorithm. */
  contextKey: string
  plan: HighRefinementPlan
}

/** Pair plans are frozen before the first paid leg so retries add no new pairs. */
export interface PortraitSelectorPairwiseCheckpoint {
  schemaVersion: 'portrait-selector-pairwise-checkpoint-v1'
  /** Same dataset/scope/target/preference/rubric-model identity as high refinement. */
  contextKey: string
  plan: PairwiseBudgetPlan
}

export type PortraitAuditStatus = 'PASS' | 'FAIL' | 'INCOMPLETE'

/**
 * 覆盖优先于质量：只要仍有计划内工作没完成，就绝不能把网络/额度问题伪装成
 * 选片质量 FAIL。覆盖完整后，才根据是否存在质量反例二分 PASS/FAIL。
 */
export function decidePortraitAuditStatus(input: {
  remainingCount: number
  pairwiseRemainingCount: number
  qualityCounterexampleCount: number
}): PortraitAuditStatus {
  if (input.remainingCount > 0 || input.pairwiseRemainingCount > 0) return 'INCOMPLETE'
  return input.qualityCounterexampleCount > 0 ? 'FAIL' : 'PASS'
}

export interface PortraitAuditReport {
  schemaVersion: 'portrait-audit-v1' | 'portrait-audit-v2' | 'portrait-audit-v3'
  datasetFingerprint: string
  selectionHash: string
  selectedIds: string[]
  challengerIds: string[]
  randomChallengerIds: string[]
  /** v2 是真正的三态结论；`passed` 仅保留给旧状态/调用方兼容。 */
  status?: PortraitAuditStatus
  passed: boolean
  weakestSelectedScore: number | null
  strongerChallengers: Array<{ id: string; score: number; margin: number; reason: string }>
  evaluatedCount: number
  plannedCount?: number
  remainingCount?: number
  failedIds?: string[]
  pairwiseEvaluatedCount?: number
  pairwisePlannedCount?: number
  pairwiseRemainingCount?: number
  failedPairKeys?: string[]
  paidCalls: number
  cachedCalls?: number
  lastAttemptPaidCalls?: number
  lastAttemptCachedCalls?: number
  nextAction?: 'retry_audit' | 'fix_model_route' | 'rebuild_selection' | 'propose'
  /** v3-only frozen staged plan/progress. */
  contextKey?: string
  stage?: 'selected_high' | 'remaining_low' | 'promotion_high' | 'pairwise' | 'complete'
  selectedHighIds?: string[]
  remainingLowIds?: string[]
  promotionIds?: string[]
  cutlineChallengerIds?: string[]
  familyChallengerIds?: string[]
  pairwisePairs?: AuditPairPlan[]
  selectedHighCompleted?: number
  remainingLowCompleted?: number
  promotionHighCompleted?: number
  providerCallBudget?: number
  attemptedCallsThisAttempt?: number
  circuitBreaker?: string
  /** Current audit rubric/prompt/provider identity; required for v3 PASS. */
  auditProviderIdentityKey?: string
}

/**
 * Durable, bounded feedback from a completed isolated-audit FAIL.
 *
 * The selector never imports evaluator scores or reasons as ranking values.
 * It may use only these anonymous challenger IDs to reserve fresh high and
 * AB/BA comparisons. Keeping this separate from `portraitAudit` matters
 * because a repaired selector score legitimately invalidates the report while
 * the already-proven counterexamples must still reach the next rebuild.
 */
export interface PortraitRebuildFeedback {
  schemaVersion: 'portrait-rebuild-feedback-v1'
  datasetFingerprint: string
  failedSelectionHash: string
  selectedIds: string[]
  strongerChallengerIds: string[]
  selectorIdentityKey: string
  selectorPairwiseIdentityKey: string
  auditProviderIdentityKey: string
  feedbackHash: string
}

/** Fail closed: legacy v1/v2 PASS is evidence from a selector-contaminated plan. */
export function portraitAuditPassed(report: PortraitAuditReport | undefined): boolean {
  return report?.schemaVersion === 'portrait-audit-v3'
    && report.status === 'PASS'
    && report.passed === true
    && report.stage === 'complete'
    && typeof report.contextKey === 'string'
    && report.contextKey.length > 0
    && typeof report.auditProviderIdentityKey === 'string'
    && report.auditProviderIdentityKey.length > 0
    && report.remainingCount === 0
    && report.pairwiseRemainingCount === 0
    && typeof report.plannedCount === 'number'
    && report.evaluatedCount === report.plannedCount
}

const DETAIL_RANK: Record<'low' | 'high', number> = { low: 0, high: 1 }

export class RunState {
  readonly candidates = new Map<string, Candidate>()
  readonly families = new Map<string, Family>()
  readonly scores = new Map<string, StoredScore>()
  /** 新人像 flow 的冻结 baseline 资产；与旧五维 inspect 缓存严格分开。 */
  readonly portraitScores = new Map<string, StoredPortraitScore>()
  /** 独立 evaluator 的盲评资产；绝不供 selector 排名使用。 */
  readonly portraitAuditScores = new Map<string, StoredPortraitAuditScore>()
  /** 独立 evaluator 已完成的双向比较；key 为无序匿名 ID 对。 */
  readonly portraitAuditPairwise = new Map<string, StoredPortraitAuditPairwise>()
  /** v3 directional legs, keyed by the full role/dataset/order/prompt/provider identity. */
  readonly portraitAuditPairwiseLegs = new Map<string, StoredPortraitAuditPairwiseLeg>()
  /** 家族内已定的冠军；落选者不再进入后续候选。 */
  readonly championByFamily = new Map<string, string>()
  readonly comparisons: { ids: string[]; winner: string; reason: string }[] = []
  readonly portraitComparisons: PairwiseComparison[] = []
  /** Selector pairwise legs are separate from the isolated audit role. */
  readonly portraitSelectorPairwiseLegs = new Map<string, StoredPortraitSelectorPairwiseLeg>()
  /** 已发生的付费调用次数，用于如实汇报花销。 */
  paidCalls = {
    inspect: 0,
    compare: 0,
    cached: 0,
    /** Requests committed to the routed provider, including rejected outputs. */
    portraitScoreAttempted: 0,
    portraitScore: 0,
    /** Directional AB/BA requests committed to the routed provider. */
    portraitPairwiseAttempted: 0,
    portraitPairwise: 0,
    portraitAudit: 0,
  }
  folder?: string
  /** 当前候选集合的内容身份；目录内容变化后绝不复用旧分数或匿名映射。 */
  datasetFingerprint?: string
  /** analyze 时用的取样上限；兜底选片必须用同一个值，否则两者看到的不是同一批照片。 */
  limit?: number
  /** 本地分类的使用策略；原始 `Candidate.category` 始终保持不变。 */
  candidateScope: CandidateScope = 'auto'
  targets: Record<Category, number> = { people: 6, scenery: 6 }
  preference: PreferenceProfile = createPreferenceProfile({})
  portraitRefinementCheckpoint?: PortraitRefinementCheckpoint
  portraitSelectorPairwiseCheckpoint?: PortraitSelectorPairwiseCheckpoint
  portraitDraft?: PortraitDraft
  portraitAudit?: PortraitAuditReport
  portraitRebuildFeedback?: PortraitRebuildFeedback
  proposal?: { keep: string[]; why: Record<string, string> }
  exportApproval?: ExportApproval

  absorb(
    report: AnalyzeReport,
    folder: string,
    limit?: number,
    candidateScope: CandidateScope = 'auto',
  ): void {
    this.folder = folder
    this.limit = limit
    this.candidateScope = candidateScope
    this.datasetFingerprint = report.dataset_fingerprint
    this.candidates.clear()
    this.families.clear()
    // 同一个 Harness Agent 可以再次 analyze 另一个目录。所有由旧匿名 ID 派生的
    // 状态必须先清空；若 fingerprint 相同，loadState 会随后精确恢复付费资产。
    this.scores.clear()
    this.portraitScores.clear()
    this.portraitAuditScores.clear()
    this.portraitAuditPairwise.clear()
    this.portraitAuditPairwiseLegs.clear()
    this.championByFamily.clear()
    this.comparisons.splice(0)
    this.portraitComparisons.splice(0)
    this.portraitSelectorPairwiseLegs.clear()
    this.preference = createPreferenceProfile({})
    this.portraitRefinementCheckpoint = undefined
    this.portraitSelectorPairwiseCheckpoint = undefined
    this.portraitDraft = undefined
    this.portraitAudit = undefined
    this.portraitRebuildFeedback = undefined
    this.proposal = undefined
    this.exportApproval = undefined
    this.paidCalls = {
      inspect: 0,
      compare: 0,
      cached: 0,
      portraitScoreAttempted: 0,
      portraitScore: 0,
      portraitPairwiseAttempted: 0,
      portraitPairwise: 0,
      portraitAudit: 0,
    }
    for (const candidate of report.candidates) this.candidates.set(candidate.id, candidate)
    for (const family of report.families) this.families.set(family.id, family)
  }

  /** 家族落选者：已定冠军的家族里，除冠军外的成员一律退出候选。 */
  private eliminated(): Set<string> {
    const out = new Set<string>()
    for (const [familyId, winner] of this.championByFamily) {
      for (const member of this.families.get(familyId)?.members ?? []) {
        if (member !== winner) out.add(member)
      }
    }
    return out
  }

  /** Effective routing never overwrites the engine's local classification. */
  effectiveCategory(candidate: Candidate): Category {
    return this.candidateScope === 'people_only' ? 'people' : candidate.category
  }

  isPortraitCandidate(candidate: Candidate): boolean {
    return this.effectiveCategory(candidate) === 'people'
  }

  /** 仍在竞争的候选。
   *
   * 连拍组默认折叠：未经 compare + resolve_family 的组只露一个占位代表。
   * 实测里模型会无视"发现 78 组连拍"这句提示、对每张单独打分，而连拍恰恰是
   * "哪张睁着眼"唯一能被可靠判出来的地方。折叠让它绕不过去。
   */
  active(category?: Category): Candidate[] {
    const gone = this.eliminated()
    return [...this.candidates.values()].filter(
      (c) =>
        !gone.has(c.id)
        && !(c.collapsed && !this.championByFamily.has(c.family ?? ''))
        && (!category || this.effectiveCategory(c) === category),
    )
  }

  /** 还没定代表的连拍组。 */
  openFamilies(): Family[] {
    return [...this.families.values()].filter(
      (f) => f.members.length > 1 && !this.championByFamily.has(f.id),
    )
  }

  /** 不折叠连拍的完整候选集。baseline 必须看完它，不能把占位代表当全组。 */
  all(category?: Category): Candidate[] {
    return [...this.candidates.values()].filter(
      candidate => !category || this.effectiveCategory(candidate) === category,
    )
  }

  /** 冻结人像 flow 的唯一候选入口，避免各工具重新解释本地分类。 */
  portraitCandidates(): Candidate[] {
    return this.all('people')
  }

  /** 已有分数且档位足够时返回它——重发一张已付费的照片既多收钱又换一个分数。 */
  cached(id: string, detail: 'low' | 'high'): StoredScore | undefined {
    const existing = this.scores.get(id)
    if (!existing) return undefined
    return DETAIL_RANK[existing.detail] >= DETAIL_RANK[detail] ? existing : undefined
  }

  record(score: PhotoScore, detail: 'low' | 'high'): void {
    const existing = this.scores.get(score.id)
    // 高档位覆盖低档位；同档位重复以最新为准。
    if (existing && DETAIL_RANK[existing.detail] > DETAIL_RANK[detail]) return
    this.scores.set(score.id, {
      dimensions: score.dimensions,
      detail,
      reasons: score.reasons,
      summary: score.summary,
    })
  }

  cachedPortrait(id: string, detail: 'low' | 'high', cacheKey: string): StoredPortraitScore | undefined {
    const existing = this.portraitScores.get(id)
    if (!existing || existing.cacheKey !== cacheKey
      || !isPortraitBaselineAssessmentConsistent(existing.assessment)) return undefined
    return DETAIL_RANK[existing.detail] >= DETAIL_RANK[detail] ? existing : undefined
  }

  recordPortrait(
    assessment: PortraitBaselineAssessment,
    detail: 'low' | 'high',
    cacheKey: string,
  ): void {
    const existing = this.portraitScores.get(assessment.id)
    if (existing && existing.cacheKey === cacheKey
      && DETAIL_RANK[existing.detail] > DETAIL_RANK[detail]) return
    this.portraitScores.set(assessment.id, { assessment, detail, cacheKey })
    // 任意视觉证据变化后，之前的名单与审计都不再是同一份决策。
    this.portraitSelectorPairwiseCheckpoint = undefined
    this.portraitDraft = undefined
    this.portraitAudit = undefined
    this.exportApproval = undefined
  }

  private portraitAuditScoreKey(id: string, detail: PortraitDetail): string {
    return `${id}\u0000${detail}`
  }

  cachedPortraitAudit(
    id: string,
    detail: PortraitDetail,
    cacheKey: string,
  ): StoredPortraitAuditScore | undefined {
    const existing = this.portraitAuditScores.get(this.portraitAuditScoreKey(id, detail))
    return existing?.cacheKey === cacheKey
      && isPortraitBaselineAssessmentConsistent(existing.assessment) ? existing : undefined
  }

  recordPortraitAudit(
    assessment: PortraitBaselineAssessment,
    detail: PortraitDetail,
    cacheKey: string,
  ): void {
    this.portraitAuditScores.set(this.portraitAuditScoreKey(assessment.id, detail), {
      assessment,
      detail,
      cacheKey,
    })
  }

  cachedPortraitAuditPairwiseLeg(cacheKey: string): StoredPortraitAuditPairwiseLeg | undefined {
    const existing = this.portraitAuditPairwiseLegs.get(cacheKey)
    return existing?.cacheKey === cacheKey ? existing : undefined
  }

  recordPortraitAuditPairwiseLeg(
    challengerId: string,
    selectedId: string,
    order: 'AB' | 'BA',
    decision: PairwiseRawDecision,
    cacheKey: string,
  ): void {
    this.portraitAuditPairwiseLegs.set(cacheKey, {
      challengerId,
      selectedId,
      order,
      decision,
      cacheKey,
    })
  }

  cachedPortraitSelectorPairwiseLeg(cacheKey: string): StoredPortraitSelectorPairwiseLeg | undefined {
    const existing = this.portraitSelectorPairwiseLegs.get(cacheKey)
    return existing?.cacheKey === cacheKey ? existing : undefined
  }

  recordPortraitSelectorPairwiseLeg(
    aId: string,
    bId: string,
    order: 'AB' | 'BA',
    decision: PairwiseRawDecision,
    cacheKey: string,
  ): void {
    this.portraitSelectorPairwiseLegs.set(cacheKey, { aId, bId, order, decision, cacheKey })
  }

  private portraitAuditPairKey(leftId: string, rightId: string): string {
    return [leftId, rightId].sort().join('\u0000')
  }

  cachedPortraitAuditPairwise(
    leftId: string,
    rightId: string,
    cacheKey: string,
  ): StoredPortraitAuditPairwise | undefined {
    const existing = this.portraitAuditPairwise.get(this.portraitAuditPairKey(leftId, rightId))
    return existing?.cacheKey === cacheKey ? existing : undefined
  }

  recordPortraitAuditPairwise(
    leftId: string,
    rightId: string,
    result: PairwiseResult,
    cacheKey: string,
  ): void {
    this.portraitAuditPairwise.set(this.portraitAuditPairKey(leftId, rightId), {
      leftId,
      rightId,
      result,
      cacheKey,
    })
  }

  setPreference(input: PreferenceProfileInput): PreferenceProfile {
    const next = createPreferenceProfile(input)
    if (JSON.stringify(next) !== JSON.stringify(this.preference)) {
      this.portraitRefinementCheckpoint = undefined
      this.portraitSelectorPairwiseCheckpoint = undefined
      this.portraitDraft = undefined
      this.portraitAudit = undefined
      this.portraitRebuildFeedback = undefined
      this.exportApproval = undefined
    }
    this.preference = next
    return this.preference
  }

  /** 始终保留 baseline；偏好只产生可审计的第二列，且绝不恢复非 eligible。 */
  portraitScore(id: string): {
    baseline: number | null
    personalized: number | null
    adjustment: number
  } | undefined {
    const stored = this.portraitScores.get(id)
    if (!stored) return undefined
    const assessment = stored.assessment
    if (assessment.baselineScore === null || assessment.eligibility.status !== 'eligible') {
      return { baseline: null, personalized: null, adjustment: 0 }
    }
    const rubric = scorePortraitBaseline(assessment.dimensionScores, {
      assessable: true,
      intentionalHumanSubject: true,
      primarySubjectInterpretable: true,
    })
    const overlay = applyPreferenceOverlay(
      rubric,
      assessment.dimensionScores,
      observableTagsToPreferenceAttributes(assessment.observableTags),
      this.preference,
    )
    return {
      baseline: assessment.baselineScore,
      personalized: overlay.adjustedScore,
      adjustment: overlay.preferenceAdjustment,
    }
  }

  total(id: string): number | undefined {
    const score = this.scores.get(id)
    return score ? weightedTotal(score.dimensions) : undefined
  }

  /** 按已知总分排出的当前名次。没有分数的排在最后。 */
  ranking(category: Category): { id: string; total?: number }[] {
    return this.active(category)
      .map((c) => ({ id: c.id, total: this.total(c.id) }))
      .sort((a, b) => {
        if (a.total === undefined && b.total === undefined) return a.id.localeCompare(b.id)
        if (a.total === undefined) return 1
        if (b.total === undefined) return -1
        return b.total - a.total || a.id.localeCompare(b.id)
      })
  }

  /**
   * 第 N 名与第 N+1 名的分差。
   *
   * 这个数字直接回答“还要不要继续花钱”：差 15 分就别看了，差 1 分说明切线不稳。
   */
  cutlineGap(category: Category): number | undefined {
    const ranked = this.ranking(category).filter((r) => r.total !== undefined)
    const target = this.targets[category]
    if (target <= 0) return undefined
    if (ranked.length <= target) return undefined
    return (ranked[target - 1].total ?? 0) - (ranked[target].total ?? 0)
  }

  /** 每轮交给模型的固定大小摘要。历史留在这里，不留在对话里。 */
  render(): string {
    const lines: string[] = [
      `候选范围：${this.candidateScope} · 人物评估池 ${this.portraitCandidates().length} 张`,
    ]
    for (const category of ['people', 'scenery'] as Category[]) {
      const portraitFlow = category === 'people' && this.portraitScores.size > 0
      const pool = portraitFlow ? this.all(category) : this.active(category)
      if (!pool.length) continue
      const scored = pool.filter((c) => portraitFlow
        ? this.portraitScores.has(c.id)
        : this.scores.has(c.id)).length
      const portraitRanked = portraitFlow
        ? pool.map(candidate => ({ id: candidate.id, total: this.portraitScore(candidate.id)?.personalized ?? undefined }))
          .sort((a, b) => {
            if (a.total === undefined && b.total === undefined) return a.id.localeCompare(b.id)
            if (a.total === undefined) return 1
            if (b.total === undefined) return -1
            return b.total - a.total || a.id.localeCompare(b.id)
          })
        : undefined
      const ranked = (portraitRanked ?? this.ranking(category)).slice(0, this.targets[category])
      const target = this.targets[category]
      const gap = portraitRanked && portraitRanked.length > target && target > 0
        ? (portraitRanked[target - 1].total ?? 0) - (portraitRanked[target].total ?? 0)
        : this.cutlineGap(category)
      const openFamilies = [...this.families.values()].filter(
        (f) => f.members.some((m) => pool.some((c) => c.id === m)) && !this.championByFamily.has(f.id),
      )
      lines.push(
        `【${category === 'people' ? '人物' : '风景'}】目标 ${this.targets[category]} 张 · ` +
          `候选 ${pool.length} · 已看 ${scored}`,
      )
      lines.push(
        `  当前前 ${this.targets[category]}: ` +
          (ranked.every((r) => r.total === undefined)
            ? '（还没有任何分数）'
            : ranked.map((r) => `${r.id}(${r.total ?? '—'})`).join(' ')),
      )
      if (gap !== undefined) {
        lines.push(`  切线分差 ${gap}${gap <= 3 ? '  ⚠ 不稳，值得再看' : '  稳定'}`)
      }
      if (openFamilies.length && !portraitFlow) {
        lines.push(
          `  ⚠ 待定连拍组 ${openFamilies.length} 组仍被折叠，组内其余照片不在候选里：`,
        )
        lines.push(
          `    ${openFamilies.slice(0, 8).map((f) => `${f.id}[${f.members.join(' ')}]`).join('  ')}`,
        )
        lines.push('    先 compare 再 resolve_family，否则这些瞬间只有占位代表参与竞争。')
      }
    }
    lines.push(
      `已花费：打分 ${this.paidCalls.inspect} 次 · 比较 ${this.paidCalls.compare} 次 · ` +
        `人像 baseline 发送 ${this.paidCalls.portraitScoreAttempted} 次 / 成功 ${this.paidCalls.portraitScore} 次 · ` +
        `人像 pairwise 发送 ${this.paidCalls.portraitPairwiseAttempted} 次 / ` +
        `成功 ${this.paidCalls.portraitPairwise} 次 · ` +
        `独立审计 ${this.paidCalls.portraitAudit} 次 · 命中缓存省下 ${this.paidCalls.cached} 次`,
    )
    if (this.portraitAudit?.schemaVersion === 'portrait-audit-v3') {
      const audit = this.portraitAudit
      lines.push(
        `审计：status=${audit.status ?? 'INCOMPLETE'} stage=${audit.stage ?? 'unknown'} ` +
          `score_remaining=${audit.remainingCount ?? 0} pairwise_remaining=${audit.pairwiseRemainingCount ?? 0} ` +
          `next_action=${audit.nextAction ?? 'unknown'}`,
      )
      if (audit.circuitBreaker) lines.push(`审计熔断：${audit.circuitBreaker}`)
    }
    return lines.join('\n')
  }
}

/** Stable identity for exactly the proposal that would be copied. */
export function currentExportSelectionHash(state: RunState): string | undefined {
  if (!state.datasetFingerprint || !state.proposal) return undefined
  return createHash('sha256')
    .update([
      'export-selection-v1',
      state.datasetFingerprint,
      state.candidateScope,
      ...[...state.proposal.keep].sort(),
    ].join('\u0000'))
    .digest('hex')
}

function validExportApproval(value: ExportApproval | undefined): value is ExportApproval {
  return value?.schemaVersion === 'export-approval-v1'
    && typeof value.selectionHash === 'string'
    && value.selectionHash.length > 0
    && typeof value.destination === 'string'
    && value.destination.length > 0
    && typeof value.confirmationCode === 'string'
    && /^PF-[0-9A-F]{8}$/u.test(value.confirmationCode)
    && (value.requestedAfterUserMessageId === undefined
      || typeof value.requestedAfterUserMessageId === 'string')
}

/** 落盘形态。分数是花过钱的资产，必须跨会话活下来。 */
interface Persisted {
  schemaVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8
  folder: string
  datasetFingerprint: string
  limit?: number
  candidateScope?: CandidateScope
  targets: Record<Category, number>
  candidates: Candidate[]
  families: Family[]
  scores: [string, StoredScore][]
  portraitScores?: [string, StoredPortraitScore][]
  portraitAuditScores?: [string, StoredPortraitAuditScore][]
  portraitAuditPairwise?: [string, StoredPortraitAuditPairwise][]
  portraitAuditPairwiseLegs?: [string, StoredPortraitAuditPairwiseLeg][]
  championByFamily: [string, string][]
  comparisons: { ids: string[]; winner: string; reason: string }[]
  portraitComparisons?: PairwiseComparison[]
  portraitSelectorPairwiseLegs?: [string, StoredPortraitSelectorPairwiseLeg][]
  paidCalls: Partial<RunState['paidCalls']>
  preference?: PreferenceProfile
  portraitRefinementCheckpoint?: PortraitRefinementCheckpoint
  portraitSelectorPairwiseCheckpoint?: PortraitSelectorPairwiseCheckpoint
  portraitDraft?: PortraitDraft
  portraitAudit?: PortraitAuditReport
  portraitRebuildFeedback?: PortraitRebuildFeedback
  proposal?: { keep: string[]; why: Record<string, string> }
  exportApproval?: ExportApproval
}

/**
 * 状态文件按目录+取样上限分片。
 *
 * 每次 `dsh` 都是全新会话，不落盘的话每一次都要为同一批照片重新付费打分。
 */
function stateFile(workdir: string, folder: string, limit: number | undefined, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(`${folder}#${limit ?? 'all'}#${fingerprint}`)
    .digest('hex')
    .slice(0, 16)
  return join(workdir, `state-${digest}.json`)
}

const stateWriteQueues = new Map<string, Promise<void>>()
let stateWriteSequence = 0

/**
 * Atomically persist paid assets. Writes for one dataset are serialized so an
 * older, smaller snapshot can never rename over a newer superset. Callers that
 * are about to spend more money must stop when this returns false.
 */
export async function saveState(state: RunState, workdir: string): Promise<boolean> {
  if (!state.folder || !state.datasetFingerprint) return false
  const payload: Persisted = {
    schemaVersion: 8,
    folder: state.folder,
    datasetFingerprint: state.datasetFingerprint,
    limit: state.limit,
    candidateScope: state.candidateScope,
    targets: state.targets,
    candidates: [...state.candidates.values()],
    families: [...state.families.values()],
    scores: [...state.scores.entries()],
    portraitScores: [...state.portraitScores.entries()],
    portraitAuditScores: [...state.portraitAuditScores.entries()],
    portraitAuditPairwise: [...state.portraitAuditPairwise.entries()],
    portraitAuditPairwiseLegs: [...state.portraitAuditPairwiseLegs.entries()],
    championByFamily: [...state.championByFamily.entries()],
    comparisons: state.comparisons,
    portraitComparisons: state.portraitComparisons,
    portraitSelectorPairwiseLegs: [...state.portraitSelectorPairwiseLegs.entries()],
    paidCalls: state.paidCalls,
    preference: state.preference,
    portraitRefinementCheckpoint: state.portraitRefinementCheckpoint,
    portraitSelectorPairwiseCheckpoint: state.portraitSelectorPairwiseCheckpoint,
    portraitDraft: state.portraitDraft,
    portraitAudit: state.portraitAudit,
    portraitRebuildFeedback: state.portraitRebuildFeedback,
    proposal: state.proposal,
    exportApproval: state.exportApproval,
  }
  const destination = stateFile(workdir, state.folder, state.limit, state.datasetFingerprint)
  const serialized = JSON.stringify(payload)
  const previous = stateWriteQueues.get(destination) ?? Promise.resolve()
  const sequence = stateWriteSequence += 1
  const pending = previous.catch(() => undefined).then(async () => {
    await mkdir(workdir, { recursive: true })
    const temporary = `${destination}.tmp-${process.pid}-${sequence}`
    try {
      await writeFile(temporary, serialized, 'utf8')
      await rename(temporary, destination)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  })
  stateWriteQueues.set(destination, pending)
  try {
    await pending
    return true
  } catch {
    return false
  } finally {
    if (stateWriteQueues.get(destination) === pending) stateWriteQueues.delete(destination)
  }
}

/** 恢复同一目录、同一取样上限下已有的分数与家族结论。 */
export async function loadState(
  state: RunState,
  workdir: string,
  folder: string,
  limit?: number,
): Promise<boolean> {
  if (!state.datasetFingerprint) return false
  let payload: Persisted
  try {
    payload = JSON.parse(
      await readFile(stateFile(workdir, folder, limit, state.datasetFingerprint), 'utf8'),
    ) as Persisted
  } catch {
    return false
  }
  if (payload.datasetFingerprint !== state.datasetFingerprint) return false
  const persistedScope: CandidateScope = payload.candidateScope === 'people_only'
    ? 'people_only'
    : 'auto'
  const sameScope = persistedScope === state.candidateScope

  // `analyze_folder` 刚生成的候选与家族才是当前事实。旧状态只恢复仍能映射到
  // 当前集合的付费资产，绝不把旧 candidates/families 覆盖回来。候选 scope 改变时，
  // 单张分数仍可复用，但名单、审计和提议属于另一候选宇宙，必须失效。
  if (sameScope) state.targets = payload.targets
  state.scores.clear()
  state.portraitScores.clear()
  state.portraitAuditScores.clear()
  state.portraitAuditPairwise.clear()
  state.portraitAuditPairwiseLegs.clear()
  state.portraitSelectorPairwiseLegs.clear()
  state.championByFamily.clear()
  for (const [id, score] of payload.scores) {
    if (state.candidates.has(id)) state.scores.set(id, score)
  }
  for (const [id, score] of payload.portraitScores ?? []) {
    if (state.candidates.has(id)) state.portraitScores.set(id, score)
  }
  for (const [key, score] of payload.portraitAuditScores ?? []) {
    // v3 storage keys include detail; candidate identity lives in the assessment.
    if (state.candidates.has(score.assessment.id)) state.portraitAuditScores.set(key, score)
  }
  for (const [key, pair] of payload.portraitAuditPairwise ?? []) {
    if (state.candidates.has(pair.leftId) && state.candidates.has(pair.rightId)) {
      state.portraitAuditPairwise.set(key, pair)
    }
  }
  for (const [key, leg] of payload.portraitAuditPairwiseLegs ?? []) {
    if (state.candidates.has(leg.challengerId) && state.candidates.has(leg.selectedId)
      && (leg.order === 'AB' || leg.order === 'BA')) {
      state.portraitAuditPairwiseLegs.set(key, leg)
    }
  }
  for (const [key, leg] of payload.portraitSelectorPairwiseLegs ?? []) {
    if (state.candidates.has(leg.aId) && state.candidates.has(leg.bId)
      && (leg.order === 'AB' || leg.order === 'BA')) {
      state.portraitSelectorPairwiseLegs.set(key, leg)
    }
  }
  for (const [family, winner] of payload.championByFamily) {
    if (state.families.get(family)?.members.includes(winner)) {
      state.championByFamily.set(family, winner)
    }
  }
  const validComparisons = payload.comparisons.filter(({ ids, winner }) =>
    ids.every(id => state.candidates.has(id)) && ids.includes(winner),
  )
  state.comparisons.splice(0, state.comparisons.length, ...validComparisons)
  const portraitIds = new Set(state.portraitCandidates().map(candidate => candidate.id))
  const validPortraitComparisons = (payload.portraitComparisons ?? []).filter(
    ({ leftId, rightId }) => portraitIds.has(leftId) && portraitIds.has(rightId),
  )
  state.portraitComparisons.splice(
    0,
    state.portraitComparisons.length,
    ...validPortraitComparisons,
  )
  state.paidCalls = {
    inspect: payload.paidCalls.inspect ?? 0,
    compare: payload.paidCalls.compare ?? 0,
    cached: payload.paidCalls.cached ?? 0,
    // v7 checkpoints predate truthful attempt accounting. Their successful
    // count is the only defensible lower bound; new attempts are exact.
    portraitScoreAttempted: payload.paidCalls.portraitScoreAttempted
      ?? payload.paidCalls.portraitScore
      ?? 0,
    portraitScore: payload.paidCalls.portraitScore ?? 0,
    portraitPairwiseAttempted: payload.paidCalls.portraitPairwiseAttempted
      ?? payload.paidCalls.portraitPairwise
      ?? 0,
    portraitPairwise: payload.paidCalls.portraitPairwise ?? 0,
    portraitAudit: payload.paidCalls.portraitAudit ?? 0,
  }
  try {
    state.preference = createPreferenceProfile(payload.preference ?? {})
  } catch {
    state.preference = createPreferenceProfile({})
  }
  const restoredRefinement = payload.portraitRefinementCheckpoint
  state.portraitRefinementCheckpoint = sameScope
    && restoredRefinement?.schemaVersion === 'portrait-refinement-checkpoint-v1'
    && restoredRefinement.plan.candidateIds.length <= restoredRefinement.plan.hardCap
    && restoredRefinement.plan.candidateIds.every(id => portraitIds.has(id))
    ? restoredRefinement
    : undefined
  const restoredPairwise = payload.portraitSelectorPairwiseCheckpoint
  state.portraitSelectorPairwiseCheckpoint = sameScope
    && restoredPairwise?.schemaVersion === 'portrait-selector-pairwise-checkpoint-v1'
    && restoredPairwise.plan.pairs.length <= restoredPairwise.plan.pairCap
    && restoredPairwise.plan.bidirectionalCallCap === restoredPairwise.plan.pairCap * 2
    && restoredPairwise.plan.pairs.every(pair =>
      portraitIds.has(pair.leftId) && portraitIds.has(pair.rightId) && pair.leftId !== pair.rightId)
    ? restoredPairwise
    : undefined
  state.portraitDraft = sameScope && payload.portraitDraft?.keep.every(id => portraitIds.has(id))
    ? payload.portraitDraft
    : undefined
  state.portraitAudit = sameScope && payload.portraitAudit
    && payload.portraitAudit.datasetFingerprint === state.datasetFingerprint
    && payload.portraitAudit.selectedIds.every(id => portraitIds.has(id))
    && payload.portraitAudit.challengerIds.every(id => portraitIds.has(id))
    ? payload.portraitAudit
    : undefined
  const feedback = payload.portraitRebuildFeedback
  state.portraitRebuildFeedback = sameScope
    && feedback?.schemaVersion === 'portrait-rebuild-feedback-v1'
    && feedback.datasetFingerprint === state.datasetFingerprint
    && typeof feedback.failedSelectionHash === 'string'
    && feedback.failedSelectionHash.length > 0
    && feedback.selectedIds.length > 0
    && feedback.selectedIds.every(id => portraitIds.has(id))
    && feedback.strongerChallengerIds.length > 0
    && feedback.strongerChallengerIds.every(id => portraitIds.has(id))
    && typeof feedback.selectorIdentityKey === 'string'
    && feedback.selectorIdentityKey.length > 0
    && typeof feedback.selectorPairwiseIdentityKey === 'string'
    && feedback.selectorPairwiseIdentityKey.length > 0
    && typeof feedback.auditProviderIdentityKey === 'string'
    && feedback.auditProviderIdentityKey.length > 0
    && typeof feedback.feedbackHash === 'string'
    && feedback.feedbackHash.length > 0
    ? feedback
    : undefined
  state.proposal = sameScope && payload.proposal?.keep.every(id => state.candidates.has(id))
    ? payload.proposal
    : undefined
  const selectionHash = currentExportSelectionHash(state)
  state.exportApproval = selectionHash
    && validExportApproval(payload.exportApproval)
    && payload.exportApproval.selectionHash === selectionHash
    ? payload.exportApproval
    : undefined
  return true
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

/**
 * 提议的五条后置条件。
 *
 * 第 4 条（每张都必须被看过）是防幻觉的关键：模型不能推荐一张它从没打开过的照片。
 */
export function validateProposal(state: RunState, keep: string[]): ValidationResult {
  if (!keep.length) return { ok: false, reason: '提议为空' }
  const unique = new Set(keep)
  if (unique.size !== keep.length) return { ok: false, reason: '提议里有重复照片' }

  const active = new Set((state.portraitDraft ? state.all() : state.active()).map((c) => c.id))
  const outside = keep.filter((id) => !active.has(id))
  if (outside.length) {
    return { ok: false, reason: `这些照片不在候选池里（或已被家族淘汰）：${outside.join(' ')}` }
  }

  const unseen = keep.filter((id) => !state.scores.has(id) && !state.portraitScores.has(id))
  if (unseen.length) {
    return { ok: false, reason: `这些照片你还没有 inspect 过，不能推荐：${unseen.join(' ')}` }
  }

  const byFamily = new Map<string, string[]>()
  for (const id of keep) {
    const family = state.candidates.get(id)?.family
    if (!family) continue
    byFamily.set(family, [...(byFamily.get(family) ?? []), id])
  }
  const conflict = [...byFamily.entries()].find(([, ids]) => ids.length > 1)
  if (conflict) {
    if (!state.portraitDraft) {
      return { ok: false, reason: `同一连拍组 ${conflict[0]} 里选了多张：${conflict[1].join(' ')}` }
    }
    // 新人像 flow 把家族作为最多四分的受限 novelty，而不是硬禁令。
    // 这里只接受 build_selection 冻结的原名单；下面的 exact-draft 与 audit
    // 校验防止主 Agent 手工塞入任意同族重复项。
  }

  for (const category of ['people', 'scenery'] as Category[]) {
    const count = keep.filter((id) => {
      const candidate = state.candidates.get(id)
      return candidate ? state.effectiveCategory(candidate) === category : false
    }).length
    if (count !== state.targets[category]) {
      return { ok: false, reason: `${category} 必须精确达到目标：选了 ${count} 张，目标 ${state.targets[category]} 张` }
    }
  }
  if (state.targets.people > 0 && !state.portraitDraft) {
    return { ok: false, reason: '人物名单必须由 build_selection 生成，不能手填或用本地技术兜底冒充最佳选择' }
  }
  if (state.portraitDraft) {
    const expected = [...state.portraitDraft.keep].sort()
    const actual = [...keep].sort()
    if (expected.join('\u0000') !== actual.join('\u0000')) {
      return { ok: false, reason: '名单不是 build_selection 生成的冻结待选结果' }
    }
    if (!state.portraitAudit
      || !portraitAuditPassed(state.portraitAudit)
      || state.portraitAudit.selectionHash !== state.portraitDraft.selectionHash) {
      return { ok: false, reason: '独立 evaluator 尚未对这份名单给出 PASS' }
    }
  }
  return { ok: true }
}
