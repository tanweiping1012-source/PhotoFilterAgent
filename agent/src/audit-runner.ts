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
  let paidCalls = 0
  let cachedCalls = 0
  let accountedPaid = 0
  let accountedCached = 0
  let lastFailures: string[] = []
  let circuitBreaker: string | undefined

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
        `paid=${report.lastAttemptPaidCalls} cached=${report.lastAttemptCachedCalls}；` +
        `cumulative_paid=${report.paidCalls} cumulative_cached=${report.cachedCalls ?? 0}。`,
      `候选 ${candidateIdentities.length}；固定 seed random R=${universe.randomCount}；` +
        `selection_hash=${selectionHash}（名单保持冻结）。`,
      ...(report.circuitBreaker ? [`circuit_breaker=${report.circuitBreaker}`] : []),
      ...lastFailures.slice(0, 16),
      ...report.strongerChallengers.slice(0, 12).map(item =>
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
    state.paidCalls.portraitAudit += paidCalls - accountedPaid
    state.paidCalls.cached += cachedCalls - accountedCached
    accountedPaid = paidCalls
    accountedCached = cachedCalls
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
      pairwiseEvaluatedCount: pairPlans.length * 2 - legsRemaining.length,
      pairwisePlannedCount: pairPlans.length * 2,
      pairwiseRemainingCount: legsRemaining.length,
      failedPairKeys: legsRemaining.map(leg => `${leg.plan.challengerId}/${leg.plan.selectedId}/${leg.order}`),
      paidCalls: (previousReport?.paidCalls ?? 0) + paidCalls,
      cachedCalls: (previousReport?.cachedCalls ?? 0) + cachedCalls,
      lastAttemptPaidCalls: paidCalls,
      lastAttemptCachedCalls: cachedCalls,
      nextAction: status === 'INCOMPLETE'
        ? circuitBreaker ? 'fix_model_route' : 'retry_audit'
        : status === 'PASS' ? 'propose' : 'rebuild_selection',
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
    if (status === 'FAIL' && report.strongerChallengers.length > 0) {
      const strongerChallengerIds = report.strongerChallengers.map(item => item.id)
      const feedbackHash = createHash('sha256').update([
        'portrait-rebuild-feedback-v1',
        state.datasetFingerprint!,
        selectionHash,
        selectorIdentityKey,
        selectorPairwiseIdentityKey,
        auditProviderIdentityKey,
        ...strongerChallengerIds,
      ].join('\u0000')).digest('hex')
      state.portraitRebuildFeedback = {
        schemaVersion: 'portrait-rebuild-feedback-v1',
        datasetFingerprint: state.datasetFingerprint!,
        failedSelectionHash: selectionHash,
        selectedIds: [...frozenSelectedIds],
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
      providerBudget -= batch.length
      attemptedCalls += batch.length
      const outcomes = await Promise.all(batch.map(async id => {
        try {
          const preview = await engine.preview(id, detail, signal)
          const assessment = await client.scoreBaseline(id, preview.jpeg_base64, detail, signal, 'audit')
          state.recordPortraitAudit(assessment, detail, scoreKey(id, detail))
          return { id, ok: true as const }
        } catch (error) {
          return {
            id,
            ok: false as const,
            message: error instanceof Error ? error.message : '视觉评分失败',
            circuit: isPortraitVisionCircuitBreakerError(error),
          }
        }
      }))
      paidCalls += outcomes.filter(outcome => outcome.ok).length
      lastFailures = outcomes.filter(outcome => !outcome.ok)
        .map(outcome => `评分未完成 ${outcome.id}：${outcome.message}`)
      const breaker = outcomes.find(outcome => !outcome.ok && outcome.circuit)
      if (breaker && !breaker.ok) circuitBreaker = breaker.message
      await checkpoint(stage)
    }
  }

  await runScoreStage(universe.selectedHighIds, 'high', 'selected_high')
  if (pendingScoreIds(universe.selectedHighIds, 'high').length || circuitBreaker || providerBudget <= 0) {
    return renderReport(await checkpoint('selected_high'))
  }

  await runScoreStage(universe.remainingLowIds, 'low', 'remaining_low')
  if (pendingScoreIds(universe.remainingLowIds, 'low').length || circuitBreaker || providerBudget <= 0) {
    return renderReport(await checkpoint('remaining_low'))
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
    return renderReport(await checkpoint('promotion_high'))
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
    providerBudget -= batch.length
    attemptedCalls += batch.length
    const outcomes = await Promise.all(batch.map(async leg => {
      try {
        const [challenger, selected] = await Promise.all([
          engine.preview(leg.plan.challengerId, 'high', signal),
          engine.preview(leg.plan.selectedId, 'high', signal),
        ])
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
          ok: false as const,
          message: error instanceof Error ? error.message : '视觉比较失败',
          circuit: isPortraitVisionCircuitBreakerError(error),
        }
      }
    }))
    paidCalls += outcomes.filter(outcome => outcome.ok).length
    lastFailures = outcomes.filter(outcome => !outcome.ok)
      .map(outcome => `比较 leg 未完成 ${outcome.key.slice(0, 12)}：${outcome.message}`)
    const breaker = outcomes.find(outcome => !outcome.ok && outcome.circuit)
    if (breaker && !breaker.ok) circuitBreaker = breaker.message
    await checkpoint('pairwise')
  }
  if (pendingLegs().length || circuitBreaker) {
    return renderReport(await checkpoint('pairwise'))
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
  return renderReport(await checkpoint('complete', status, quality))
}
