/**
 * Resumable, provider-agnostic execution of the isolated portrait audit.
 *
 * The Harness tool owns authorization and frozen-selection validation. This
 * module owns the production audit state machine so it can be exercised with
 * synthetic candidates and fake providers without importing Cordis, opening
 * photos, or touching a real checkpoint.
 */

import {
  decidePortraitAuditStatus,
  type PortraitAuditFailureStat,
  type PortraitAuditReport,
  type RunState,
} from './state.ts'
import { createHash } from 'node:crypto'
import {
  combinePairwiseLegs,
  isPortraitVisionCircuitBreakerError,
  type PairwiseRawDecision,
  type PortraitBaselineAssessment,
  type PortraitDetail,
  type PortraitVisionCacheIdentity,
} from './portrait-vision.ts'
import {
  AUDIT_CHECKPOINT_BATCH_SIZE,
  AUDIT_MAX_PAIRWISE_LEGS,
  AUDIT_PROVIDER_CALL_BUDGET,
  auditPairwiseLegCacheKey,
  auditScoreCacheKey,
  auditV3ContextKey,
  evaluateAuditQuality,
  planAuditPairs,
  planAuditPromotions,
  planAuditUniverse,
  type AuditCandidateIdentity,
  type AuditPairPlan,
  type AuditPromotionPlan,
  type AuditUniversePlan,
} from './audit-v3.ts'

const AUDIT_REBUILD_FEEDBACK_LIMIT = 12
const AUDIT_FAILURE_STATS_LIMIT = 128
const AUDIT_STALL_LIMIT = 2

const AUDIT_STAGE_ORDER: Record<NonNullable<PortraitAuditReport['stage']>, number> = {
  selected_high: 0,
  remaining_low: 1,
  promotion_high: 2,
  pairwise: 3,
  complete: 4,
}

function providerFailureDetails(error: unknown): {
  code: string
  status?: number
  message: string
} {
  const row = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown }
    : undefined
  const status = typeof row?.status === 'number' && Number.isFinite(row.status)
    ? row.status
    : undefined
  const code = typeof row?.code === 'string' && row.code.trim()
    ? row.code.trim()
    : status !== undefined
      ? `HTTP_${status}`
      : typeof row?.name === 'string' && row.name.trim()
        ? row.name.trim()
        : 'UNKNOWN_PROVIDER_ERROR'
  const rawMessage = typeof row?.message === 'string'
    ? row.message
    : error instanceof Error ? error.message : '视觉请求失败'
  // Request IDs are not an error identity and can also be needlessly noisy.
  const message = rawMessage
    .replace(/(?:request[_ -]?id|req[_ -]?id)\s*[:=]\s*[A-Za-z0-9_-]+/giu, 'request_id=<redacted>')
    .slice(0, 240)
  return { code, status, message }
}

export interface AuditPreviewSource {
  preview(
    id: string,
    detail: PortraitDetail,
    signal?: AbortSignal,
  ): Promise<{ jpeg_base64: string }>
}

export interface AuditVisionProvider {
  readonly cacheIdentity: PortraitVisionCacheIdentity
  scoreBaseline(
    id: string,
    jpegBase64: string,
    detail: PortraitDetail,
    signal: AbortSignal | undefined,
    role: 'audit',
  ): Promise<PortraitBaselineAssessment>
  comparePairLeg(
    aId: string,
    aJpeg: string,
    bId: string,
    bJpeg: string,
    order: 'AB' | 'BA',
    signal?: AbortSignal,
  ): Promise<PairwiseRawDecision>
}

export interface RunAuditV3Input {
  state: RunState
  candidateIdentities: readonly AuditCandidateIdentity[]
  frozenSelectedIds: readonly string[]
  target: number
  seed: string
  selectionHash: string
  auditProviderIdentityKey: string
  selectorIdentityKey: string
  selectorPairwiseIdentityKey: string
  inspectConcurrency: number
  engine: AuditPreviewSource
  client: AuditVisionProvider
  persist: () => Promise<boolean>
  signal?: AbortSignal
}

/**
 * Execute at most 32 uncached provider operations and checkpoint every success.
 * Repeating the same inputs after reloading state schedules only missing cache
 * identities; complete coverage alone can produce PASS or FAIL.
 */
export async function runAuditV3(input: RunAuditV3Input): Promise<string> {
  const {
    state,
    candidateIdentities,
    frozenSelectedIds,
    target,
    seed,
    selectionHash,
    auditProviderIdentityKey,
    selectorIdentityKey,
    selectorPairwiseIdentityKey,
    inspectConcurrency,
    engine,
    client,
    persist,
    signal,
  } = input
  if (!state.datasetFingerprint) throw new Error('audit v3 requires a dataset fingerprint')

  const provider = client.cacheIdentity
  const contextKey = auditV3ContextKey({
    datasetFingerprint: state.datasetFingerprint,
    candidateScope: state.candidateScope,
    selectedIds: frozenSelectedIds,
    target,
    seed,
    provider,
  })
  const previousReport = state.portraitAudit?.schemaVersion === 'portrait-audit-v3'
    && state.portraitAudit.contextKey === contextKey
    && state.portraitAudit.selectionHash === selectionHash
    ? state.portraitAudit
    : undefined
  const freshUniverse = planAuditUniverse(candidateIdentities, frozenSelectedIds, target, seed)
  const previousUniverseIsValid = previousReport
    && previousReport.selectedHighIds?.join('\u0000') === freshUniverse.selectedHighIds.join('\u0000')
    && previousReport.remainingLowIds?.length === freshUniverse.remainingLowIds.length
    && previousReport.remainingLowIds.every(id => freshUniverse.remainingLowIds.includes(id))
    && previousReport.randomChallengerIds.every(id => freshUniverse.randomChallengerIds.includes(id))
  const universe: AuditUniversePlan = previousUniverseIsValid
    ? {
        selectedHighIds: previousReport.selectedHighIds!,
        remainingLowIds: previousReport.remainingLowIds!,
        randomChallengerIds: previousReport.randomChallengerIds,
        randomCount: previousReport.randomChallengerIds.length,
      }
    : freshUniverse
  const scoreKey = (id: string, detail: PortraitDetail) => auditScoreCacheKey({
    datasetFingerprint: state.datasetFingerprint!,
    id,
    detail,
    provider,
  })
  const auditAssessment = (id: string, detail: PortraitDetail) =>
    state.cachedPortraitAudit(id, detail, scoreKey(id, detail))?.assessment

  const upstreamPlanInputsComplete = [
    ...universe.selectedHighIds.map(id => auditAssessment(id, 'high')),
    ...universe.remainingLowIds.map(id => auditAssessment(id, 'low')),
  ].every(Boolean)
  let promotionPlan: AuditPromotionPlan | undefined = previousReport?.promotionIds
    && upstreamPlanInputsComplete
    ? {
        promotionIds: previousReport.promotionIds,
        cutlineChallengerIds: previousReport.cutlineChallengerIds ?? [],
        familyChallengerIds: previousReport.familyChallengerIds ?? [],
        randomChallengerIds: previousReport.randomChallengerIds,
    }
    : undefined
  const promotionPlanInputsComplete = promotionPlan
    ? promotionPlan.promotionIds.every(id => Boolean(auditAssessment(id, 'high')))
    : false
  let pairPlans: readonly AuditPairPlan[] = promotionPlanInputsComplete
    ? previousReport?.pairwisePairs ?? []
    : []
  let pairPlanFrozen = promotionPlanInputsComplete
    && previousReport?.pairwisePairs !== undefined
    && (previousReport.stage === 'pairwise' || previousReport.stage === 'complete')
  let providerBudget = AUDIT_PROVIDER_CALL_BUDGET
  let attemptedCalls = 0
  let succeededCalls = 0
  let failedCalls = 0
  let cachedCalls = 0
  let accountedSucceeded = 0
  let lastFailures: string[] = []
  let circuitBreaker: string | undefined
  const failureStats: Record<string, PortraitAuditFailureStat> = {
    ...(previousReport?.failureStats ?? {}),
  }
  const recordProviderFailure = (key: string, error: unknown): PortraitAuditFailureStat => {
    const details = providerFailureDetails(error)
    const previous = failureStats[key]
    if (!previous && Object.keys(failureStats).length >= AUDIT_FAILURE_STATS_LIMIT) {
      const evict = Object.entries(failureStats)
        .sort((left, right) => left[1].attempts - right[1].attempts || left[0].localeCompare(right[0]))[0]?.[0]
      if (evict) delete failureStats[evict]
    }
    const result: PortraitAuditFailureStat = {
      attempts: (previous?.attempts ?? 0) + 1,
      consecutiveSameCode: previous?.lastCode === details.code
        ? previous.consecutiveSameCode + 1
        : 1,
      lastCode: details.code,
      lastStatus: details.status,
      lastMessage: details.message,
    }
    failureStats[key] = result
    return result
  }
  const previousSucceededCalls = previousReport?.succeededCalls
    ?? previousReport?.paidCalls
    ?? 0
  const previousAttemptedCalls = previousReport?.attemptedCalls
    ?? previousSucceededCalls
  const previousFailedCalls = previousReport?.failedCalls
    ?? Math.max(0, previousAttemptedCalls - previousSucceededCalls)
  const previousUnresolvedCalls = previousReport?.unresolvedCalls ?? 0
  const accountingBasis: NonNullable<PortraitAuditReport['accountingBasis']> = previousReport
    && previousReport.attemptedCalls === undefined
    ? 'legacy_success_lower_bound'
    : previousReport?.accountingBasis ?? 'exact'

  const legKey = (plan: AuditPairPlan, order: 'AB' | 'BA') => auditPairwiseLegCacheKey({
    datasetFingerprint: state.datasetFingerprint!,
    challengerId: plan.challengerId,
    selectedId: plan.selectedId,
    order,
    provider,
  })
  const pendingScoreIds = (ids: readonly string[], detail: PortraitDetail) =>
    ids.filter(id => !auditAssessment(id, detail))
  const pendingLegs = () => pairPlans.flatMap(plan => (['AB', 'BA'] as const).map(order => ({
    plan,
    order,
    key: legKey(plan, order),
  }))).filter(leg => !state.cachedPortraitAuditPairwiseLeg(leg.key))

  const renderReport = (report: PortraitAuditReport): string => {
    const routeBlocked = report.status === 'INCOMPLETE' && report.nextAction === 'fix_model_route'
    const lines = [
      `${routeBlocked ? 'BLOCKED' : report.status}：audit_v3 stage=${report.stage}；score completed=${report.evaluatedCount} ` +
        `planned=${report.plannedCount} remaining=${report.remainingCount}；pairwise legs completed=${report.pairwiseEvaluatedCount} ` +
        `planned=${report.pairwisePlannedCount} remaining=${report.pairwiseRemainingCount}。`,
      ...(routeBlocked ? ['audit_status=INCOMPLETE；provider/auth/quota 路由熔断。'] : []),
      `StageA selected-high=${report.selectedHighCompleted}/${universe.selectedHighIds.length}；` +
        `StageB remaining-low=${report.remainingLowCompleted}/${universe.remainingLowIds.length}；` +
        `StageC promoted-high=${report.promotionHighCompleted}/${promotionPlan?.promotionIds.length ?? 0}；` +
        `StageD≤8 pairs/16 legs。`,
      `hard_budget=${AUDIT_PROVIDER_CALL_BUDGET} attempted=${report.attemptedCallsThisAttempt} ` +
        `succeeded=${report.lastAttemptSucceededCalls ?? report.lastAttemptPaidCalls ?? 0} ` +
        `failed=${report.lastAttemptFailedCalls ?? 0} unresolved=${report.lastAttemptUnresolvedCalls ?? 0} ` +
        `cache_hits=${report.lastAttemptCachedCalls ?? 0}；` +
        `cumulative_attempted=${report.attemptedCalls ?? report.paidCalls} ` +
        `succeeded=${report.succeededCalls ?? report.paidCalls} failed=${report.failedCalls ?? 0} ` +
        `unresolved=${report.unresolvedCalls ?? 0} ` +
        `unique_cached_assets=${report.uniqueCachedAssets ?? report.cachedCalls ?? 0} ` +
        `accounting=${report.accountingBasis ?? 'legacy_success_lower_bound'}。`,
      `attempt=${report.attemptNumber ?? 0} progress_delta=${report.progressDelta ?? 0} ` +
        `stalled_rounds=${report.stalledRounds ?? 0} ` +
        `prior_remaining=${report.priorRemainingCount ?? 'n/a'} ` +
        `prior_pairwise_remaining=${report.priorPairwiseRemainingCount ?? 'n/a'}。`,
      `候选 ${candidateIdentities.length}；固定 seed random R=${universe.randomCount}；` +
        `selection_hash=${selectionHash}（名单保持冻结）。`,
      ...(report.circuitBreaker ? [`circuit_breaker=${report.circuitBreaker}`] : []),
      ...Object.entries(report.failureStats ?? {})
        .sort((left, right) => right[1].attempts - left[1].attempts || left[0].localeCompare(right[0]))
        .slice(0, 16)
        .map(([key, stat]) =>
          `失败历史 ${key}：累计${stat.attempts}次，同类连续${stat.consecutiveSameCode}次，code=${stat.lastCode}`),
      ...lastFailures.slice(0, 16),
      ...report.strongerChallengers.slice(0, AUDIT_REBUILD_FEEDBACK_LIMIT).map(item =>
        `反例 ${item.id} audit=${item.score} margin=${item.margin.toFixed(1)}：${item.reason}`),
      report.status === 'INCOMPLETE'
        ? routeBlocked
          ? '覆盖尚未完成，不作质量 PASS/FAIL 判断；本轮禁止再次调用 independent_evaluator、audit_selection 或 status 形成重试循环。先修复或切换当前会话模型路由，再由新一轮只补 remaining。'
          : '覆盖尚未完成，不作质量 PASS/FAIL 判断，不允许回 build_selection。'
        : report.status === 'PASS'
          ? 'v3 覆盖完整，未发现优于切线的反例。'
          : 'v3 覆盖完整且发现稳定质量反例，才允许回 build_selection。',
      `next_action=${report.nextAction}`,
    ]
    return lines.join('\n')
  }

  const checkpoint = async (
    stage: NonNullable<PortraitAuditReport['stage']>,
    status: 'PASS' | 'FAIL' | 'INCOMPLETE' = 'INCOMPLETE',
    quality?: ReturnType<typeof evaluateAuditQuality>,
    finalizeAttempt = false,
  ): Promise<PortraitAuditReport> => {
    const selectedHighCompleted = universe.selectedHighIds.length
      - pendingScoreIds(universe.selectedHighIds, 'high').length
    const remainingLowCompleted = universe.remainingLowIds.length
      - pendingScoreIds(universe.remainingLowIds, 'low').length
    const promotionHighCompleted = promotionPlan
      ? promotionPlan.promotionIds.length - pendingScoreIds(promotionPlan.promotionIds, 'high').length
      : 0
    const scorePlanned = universe.selectedHighIds.length + universe.remainingLowIds.length
      + (promotionPlan?.promotionIds.length ?? 0)
    const scoreCompleted = selectedHighCompleted + remainingLowCompleted + promotionHighCompleted
    const legsRemaining = pendingLegs()
    const pairwiseEvaluatedCount = pairPlans.length * 2 - legsRemaining.length
    const uniqueCachedAssets = scoreCompleted + pairwiseEvaluatedCount
    const previousAssets = previousReport?.uniqueCachedAssets
      ?? (previousReport
        ? previousReport.evaluatedCount + (previousReport.pairwiseEvaluatedCount ?? 0)
        : 0)
    const progressDelta = Math.max(0, uniqueCachedAssets - previousAssets)
    const stageAdvanced = previousReport?.stage === undefined
      ? uniqueCachedAssets > 0 || stage !== 'selected_high'
      : AUDIT_STAGE_ORDER[stage] > AUDIT_STAGE_ORDER[previousReport.stage]
    const madeProgress = progressDelta > 0 || stageAdvanced
    const attemptNumber = finalizeAttempt
      ? (previousReport?.attemptNumber ?? 0) + 1
      : previousReport?.attemptNumber ?? 0
    const stalledRounds = finalizeAttempt
      ? status === 'INCOMPLETE' && !madeProgress
        ? (previousReport?.stalledRounds ?? 0) + 1
        : 0
      : previousReport?.stalledRounds ?? 0
    const nextAction: NonNullable<PortraitAuditReport['nextAction']> = status === 'INCOMPLETE'
      ? circuitBreaker
        ? 'fix_model_route'
        : finalizeAttempt && stalledRounds >= AUDIT_STALL_LIMIT
          ? 'diagnose_stall'
          : 'retry_audit'
      : status === 'PASS' ? 'propose' : 'rebuild_selection'
    state.paidCalls.portraitAudit += succeededCalls - accountedSucceeded
    accountedSucceeded = succeededCalls
    const unresolvedCalls = attemptedCalls - succeededCalls - failedCalls
    const report: PortraitAuditReport = {
      schemaVersion: 'portrait-audit-v3',
      datasetFingerprint: state.datasetFingerprint!,
      selectionHash,
      selectedIds: [...frozenSelectedIds],
      challengerIds: [...universe.remainingLowIds],
      randomChallengerIds: [...universe.randomChallengerIds],
      status,
      passed: status === 'PASS',
      weakestSelectedScore: quality?.weakestSelectedScore ?? null,
      strongerChallengers: quality ? [...quality.strongerChallengers] : [],
      evaluatedCount: scoreCompleted,
      plannedCount: scorePlanned,
      remainingCount: scorePlanned - scoreCompleted,
      failedIds: [
        ...pendingScoreIds(universe.selectedHighIds, 'high'),
        ...pendingScoreIds(universe.remainingLowIds, 'low'),
        ...pendingScoreIds(promotionPlan?.promotionIds ?? [], 'high'),
      ],
      pairwiseEvaluatedCount,
      pairwisePlannedCount: pairPlans.length * 2,
      pairwiseRemainingCount: legsRemaining.length,
      failedPairKeys: legsRemaining.map(leg => `${leg.plan.challengerId}/${leg.plan.selectedId}/${leg.order}`),
      paidCalls: previousSucceededCalls + succeededCalls,
      cachedCalls: uniqueCachedAssets,
      attemptedCalls: previousAttemptedCalls + attemptedCalls,
      succeededCalls: previousSucceededCalls + succeededCalls,
      failedCalls: previousFailedCalls + failedCalls,
      unresolvedCalls: previousUnresolvedCalls + unresolvedCalls,
      uniqueCachedAssets,
      accountingBasis,
      lastAttemptPaidCalls: succeededCalls,
      lastAttemptCachedCalls: cachedCalls,
      lastAttemptSucceededCalls: succeededCalls,
      lastAttemptFailedCalls: failedCalls,
      lastAttemptUnresolvedCalls: unresolvedCalls,
      nextAction,
      attemptNumber,
      priorRemainingCount: previousReport?.remainingCount,
      priorPairwiseRemainingCount: previousReport?.pairwiseRemainingCount,
      progressDelta: finalizeAttempt ? progressDelta : previousReport?.progressDelta ?? 0,
      stalledRounds,
      lastProgressStage: finalizeAttempt && madeProgress
        ? stage
        : previousReport?.lastProgressStage,
      failureStats: { ...failureStats },
      contextKey,
      stage,
      selectedHighIds: [...universe.selectedHighIds],
      remainingLowIds: [...universe.remainingLowIds],
      promotionIds: promotionPlan ? [...promotionPlan.promotionIds] : undefined,
      cutlineChallengerIds: promotionPlan ? [...promotionPlan.cutlineChallengerIds] : undefined,
      familyChallengerIds: promotionPlan ? [...promotionPlan.familyChallengerIds] : undefined,
      pairwisePairs: pairPlanFrozen ? [...pairPlans] : undefined,
      selectedHighCompleted,
      remainingLowCompleted,
      promotionHighCompleted,
      providerCallBudget: AUDIT_PROVIDER_CALL_BUDGET,
      attemptedCallsThisAttempt: attemptedCalls,
      circuitBreaker,
      auditProviderIdentityKey,
    }
    state.portraitAudit = report
    if (status === 'FAIL' && (
      quality?.selectedQualityIssueIds.length || report.strongerChallengers.length
    )) {
      // Recover durable high-detail audit disagreements even if an older
      // cumulative feedback record was written by a prior selection. This is
      // still evaluator-only evidence: only anonymous IDs cross the boundary.
      // Requiring selector high prevents a random promoted audit candidate
      // from becoming a migration-time hard exclusion.
      const durableAuditDisqualifiedIds = candidateIdentities
        .map(candidate => candidate.id)
        .filter(id => state.cachedPortrait(id, 'high', selectorIdentityKey)
          ?.assessment.eligibility.status === 'eligible'
          && auditAssessment(id, 'high') !== undefined
          && auditAssessment(id, 'high')!.eligibility.status !== 'eligible')
      const disqualifiedSelectedIds = [...new Set([
        ...(state.portraitRebuildFeedback?.disqualifiedSelectedIds ?? []),
        ...(quality?.selectedQualityIssueIds ?? []),
        ...durableAuditDisqualifiedIds,
      ])]
      // Feedback stays deliberately bounded and carries IDs only. The
      // selector must re-score/re-compare these counterexamples itself; it
      // never receives the evaluator's full ranking, scores, or reasons.
      const strongerChallengerIds = report.strongerChallengers
        .slice(0, AUDIT_REBUILD_FEEDBACK_LIMIT)
        .map(item => item.id)
      const feedbackHash = createHash('sha256').update([
        'portrait-rebuild-feedback-v2',
        state.datasetFingerprint!,
        selectionHash,
        selectorIdentityKey,
        selectorPairwiseIdentityKey,
        auditProviderIdentityKey,
        'disqualified-selected',
        ...disqualifiedSelectedIds,
        'stronger-challengers',
        ...strongerChallengerIds,
      ].join('\u0000')).digest('hex')
      state.portraitRebuildFeedback = {
        schemaVersion: 'portrait-rebuild-feedback-v2',
        datasetFingerprint: state.datasetFingerprint!,
        failedSelectionHash: selectionHash,
        selectedIds: [...frozenSelectedIds],
        disqualifiedSelectedIds: [...disqualifiedSelectedIds],
        strongerChallengerIds,
        selectorIdentityKey,
        selectorPairwiseIdentityKey,
        auditProviderIdentityKey,
        feedbackHash,
      }
    } else if (status === 'PASS') {
      state.portraitRebuildFeedback = undefined
    }
    if (!await persist()) {
      throw new Error('INCOMPLETE：本地 audit checkpoint 写入失败；已停止后续付费请求。')
    }
    return report
  }

  // A provider/auth/quota circuit is sticky for this exact provider/model/
  // protocol/prompt identity. Re-entering the tool with the same broken route
  // must be a zero-call read of the terminal report, not another paid probe.
  // Switching the current Harness route changes contextKey/identity and starts
  // a new resumable attempt against the already frozen selection.
  if (previousReport?.nextAction === 'fix_model_route'
    && previousReport.auditProviderIdentityKey === auditProviderIdentityKey
    && previousReport.circuitBreaker) {
    return renderReport(previousReport)
  }

  // Completed evidence is terminal for this exact context. Replaying the tool
  // is a zero-provider-call read, not another pass through cached checkpoints.
  if (previousReport?.stage === 'complete'
    && (previousReport.status === 'PASS' || previousReport.status === 'FAIL')) {
    return renderReport(previousReport)
  }

  // Two completed invocations without any new asset or stage advance indicate
  // a deterministic local/provider failure, not useful retry work.
  if (previousReport?.nextAction === 'diagnose_stall'
    && (previousReport.stalledRounds ?? 0) >= AUDIT_STALL_LIMIT) {
    return renderReport(previousReport)
  }

  // Freeze v3 universe/random plan before the first paid request.
  await checkpoint('selected_high')

  const runScoreStage = async (
    ids: readonly string[],
    detail: PortraitDetail,
    stage: NonNullable<PortraitAuditReport['stage']>,
  ): Promise<void> => {
    const cached = ids.filter(id => auditAssessment(id, detail))
    cachedCalls += cached.length
    const pending = ids.filter(id => !auditAssessment(id, detail))
    const scheduled = pending.slice(0, providerBudget)
    for (let offset = 0; offset < scheduled.length && !circuitBreaker; offset += AUDIT_CHECKPOINT_BATCH_SIZE) {
      const batch = scheduled.slice(offset, offset + Math.min(
        AUDIT_CHECKPOINT_BATCH_SIZE,
        inspectConcurrency,
      ))
      const prepared = await Promise.all(batch.map(async id => {
        try {
          return { id, preview: await engine.preview(id, detail, signal), ok: true as const }
        } catch (error) {
          return {
            id,
            ok: false as const,
            message: error instanceof Error ? error.message : '本地预览失败',
          }
        }
      }))
      const ready = prepared.filter(item => item.ok)
      const previewFailures = prepared.filter(item => !item.ok)
        .map(item => `本地预览未完成 ${item.id}：${item.message}`)
      providerBudget -= ready.length
      attemptedCalls += ready.length
      // Reserve attempts durably before dispatch. A process crash can then be
      // reported as unresolved instead of silently under-counting a request.
      await checkpoint(stage)
      const outcomes = await Promise.all(ready.map(async ({ id, preview }) => {
        try {
          const assessment = await client.scoreBaseline(id, preview.jpeg_base64, detail, signal, 'audit')
          state.recordPortraitAudit(assessment, detail, scoreKey(id, detail))
          return { id, ok: true as const }
        } catch (error) {
          return {
            id,
            ok: false as const,
            error,
            message: error instanceof Error ? error.message : '视觉评分失败',
            circuit: isPortraitVisionCircuitBreakerError(error),
          }
        }
      }))
      succeededCalls += outcomes.filter(outcome => outcome.ok).length
      failedCalls += outcomes.filter(outcome => !outcome.ok).length
      const providerFailureLines = outcomes.filter(outcome => !outcome.ok).map(outcome => {
        const stat = recordProviderFailure(`score:${detail}:${outcome.id}`, outcome.error)
        return `评分未完成 ${outcome.id}：${outcome.message}（累计第${stat.attempts}次；同类连续${stat.consecutiveSameCode}次）`
      })
      lastFailures = [
        ...lastFailures,
        ...previewFailures,
        ...providerFailureLines,
      ].slice(-64)
      const breaker = outcomes.find(outcome => !outcome.ok && outcome.circuit)
      if (breaker && !breaker.ok) circuitBreaker = breaker.message
      await checkpoint(stage)
    }
  }

  await runScoreStage(universe.selectedHighIds, 'high', 'selected_high')
  if (pendingScoreIds(universe.selectedHighIds, 'high').length || circuitBreaker || providerBudget <= 0) {
    return renderReport(await checkpoint('selected_high', 'INCOMPLETE', undefined, true))
  }

  await runScoreStage(universe.remainingLowIds, 'low', 'remaining_low')
  if (pendingScoreIds(universe.remainingLowIds, 'low').length || circuitBreaker || providerBudget <= 0) {
    return renderReport(await checkpoint('remaining_low', 'INCOMPLETE', undefined, true))
  }

  if (!promotionPlan) {
    const stageABAssessments = new Map([
      ...universe.selectedHighIds.map(id => [id, auditAssessment(id, 'high')!] as const),
      ...universe.remainingLowIds.map(id => [id, auditAssessment(id, 'low')!] as const),
    ])
    promotionPlan = planAuditPromotions(candidateIdentities, universe, stageABAssessments)
    // Freeze Stage C before its first high request.
    await checkpoint('promotion_high')
  }
  await runScoreStage(promotionPlan.promotionIds, 'high', 'promotion_high')
  if (pendingScoreIds(promotionPlan.promotionIds, 'high').length || circuitBreaker || providerBudget <= 0) {
    return renderReport(await checkpoint('promotion_high', 'INCOMPLETE', undefined, true))
  }

  if (!pairPlanFrozen) {
    const highAssessments = new Map([
      ...universe.selectedHighIds.map(id => [id, auditAssessment(id, 'high')!] as const),
      ...promotionPlan.promotionIds.map(id => [id, auditAssessment(id, 'high')!] as const),
    ])
    pairPlans = planAuditPairs(
      candidateIdentities,
      universe.selectedHighIds,
      promotionPlan.promotionIds,
      highAssessments,
    )
    pairPlanFrozen = true
    await checkpoint('pairwise')
  }
  const allLegs = pairPlans.flatMap(plan => (['AB', 'BA'] as const).map(order => ({
    plan,
    order,
    key: legKey(plan, order),
  })))
  cachedCalls += allLegs.filter(leg => state.cachedPortraitAuditPairwiseLeg(leg.key)).length
  const scheduledLegs = allLegs
    .filter(leg => !state.cachedPortraitAuditPairwiseLeg(leg.key))
    .slice(0, Math.min(providerBudget, AUDIT_MAX_PAIRWISE_LEGS))
  for (let offset = 0; offset < scheduledLegs.length && !circuitBreaker; offset += 1) {
    const batch = scheduledLegs.slice(offset, offset + 1)
    const prepared = await Promise.all(batch.map(async leg => {
      try {
        const [challenger, selected] = await Promise.all([
          engine.preview(leg.plan.challengerId, 'high', signal),
          engine.preview(leg.plan.selectedId, 'high', signal),
        ])
        return { leg, challenger, selected, ok: true as const }
      } catch (error) {
        return {
          leg,
          ok: false as const,
          message: error instanceof Error ? error.message : '本地预览失败',
        }
      }
    }))
    const ready = prepared.filter(item => item.ok)
    const previewFailures = prepared.filter(item => !item.ok)
      .map(item => `比较预览未完成 ${item.leg.key.slice(0, 12)}：${item.message}`)
    providerBudget -= ready.length
    attemptedCalls += ready.length
    await checkpoint('pairwise')
    const outcomes = await Promise.all(ready.map(async ({ leg, challenger, selected }) => {
      try {
        const decision = await client.comparePairLeg(
          leg.plan.challengerId,
          challenger.jpeg_base64,
          leg.plan.selectedId,
          selected.jpeg_base64,
          leg.order,
          signal,
        )
        state.recordPortraitAuditPairwiseLeg(
          leg.plan.challengerId,
          leg.plan.selectedId,
          leg.order,
          decision,
          leg.key,
        )
        return { key: leg.key, ok: true as const }
      } catch (error) {
        return {
          key: leg.key,
          failureKey: `pair:${leg.plan.challengerId}:${leg.plan.selectedId}:${leg.order}`,
          ok: false as const,
          error,
          message: error instanceof Error ? error.message : '视觉比较失败',
          circuit: isPortraitVisionCircuitBreakerError(error),
        }
      }
    }))
    succeededCalls += outcomes.filter(outcome => outcome.ok).length
    failedCalls += outcomes.filter(outcome => !outcome.ok).length
    const providerFailureLines = outcomes.filter(outcome => !outcome.ok).map(outcome => {
      const stat = recordProviderFailure(outcome.failureKey, outcome.error)
      return `比较 leg 未完成 ${outcome.failureKey}：${outcome.message}（累计第${stat.attempts}次；同类连续${stat.consecutiveSameCode}次）`
    })
    lastFailures = [
      ...lastFailures,
      ...previewFailures,
      ...providerFailureLines,
    ].slice(-64)
    const breaker = outcomes.find(outcome => !outcome.ok && outcome.circuit)
    if (breaker && !breaker.ok) circuitBreaker = breaker.message
    await checkpoint('pairwise')
  }
  if (pendingLegs().length || circuitBreaker) {
    return renderReport(await checkpoint('pairwise', 'INCOMPLETE', undefined, true))
  }

  const bestAssessments = new Map([
    ...universe.selectedHighIds.map(id => [id, auditAssessment(id, 'high')!] as const),
    ...universe.remainingLowIds.map(id => [
      id,
      promotionPlan!.promotionIds.includes(id)
        ? auditAssessment(id, 'high')!
        : auditAssessment(id, 'low')!,
    ] as const),
  ])
  const pairResults = new Map(pairPlans.map(plan => {
    const ab = state.cachedPortraitAuditPairwiseLeg(legKey(plan, 'AB'))!.decision
    const ba = state.cachedPortraitAuditPairwiseLeg(legKey(plan, 'BA'))!.decision
    return [plan.challengerId, combinePairwiseLegs(
      plan.challengerId,
      plan.selectedId,
      ab,
      ba,
    )] as const
  }))
  const quality = evaluateAuditQuality(
    universe.selectedHighIds,
    universe.remainingLowIds,
    bestAssessments,
    pairResults,
  )
  const status = decidePortraitAuditStatus({
    remainingCount: 0,
    pairwiseRemainingCount: 0,
    qualityCounterexampleCount: quality.selectedQualityIssueIds.length
      + quality.strongerChallengers.length,
  })
  if (quality.selectedQualityIssueIds.length) {
    lastFailures = quality.selectedQualityIssueIds.map(id =>
      `入选项质量反例 ${id}：v3 high audit 未达到 eligible baseline。`)
  }
  return renderReport(await checkpoint('complete', status, quality, true))
}
