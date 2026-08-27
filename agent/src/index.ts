/**
 * 照片策展工具集：把本地分析引擎与视觉打分接成 DeepSeek Harness 的模型可见工具。
 *
 * 分工：harness 提供循环、会话与工具管线；这个插件提供领域能力。
 *
 * 三条不随配置放宽的边界：
 * - **原图只读**——工具集里没有任何修改、移动或删除原图的工具，`export` 只复制。
 * - **不公开原图**——只有用户明确运行 AI 评测时，才把引擎生成的无元数据缩放
 *   JPEG 发给已配置的视觉供应商；文件名、路径、绝对时间与 GPS 都不出本机。
 * - **不重复计费**——同一张同档位已有分数时直接命中缓存，并在结果里如实标注。
 * @module @photo-filter-agent/dsh-photo-filter-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { PhotoEngine, type Candidate } from './engine.ts'
import { mapWithConcurrency } from './pool.ts'
import {
  currentExportSelectionHash,
  loadState,
  parseCandidateScope,
  RunState,
  saveState,
  validateProposal,
  type CandidateScope,
  type Category,
} from './state.ts'
import {
  exportApprovalMatches,
  hasGenuineExportConfirmation,
  isIndependentAuditCaller,
  latestGenuineUserMessage,
  newExportConfirmationCode,
} from './authorization.ts'
import { VisionClient, weightedTotal } from './vision.ts'
import {
  PortraitVisionClient,
  combinePairwiseLegs,
  isPortraitVisionCircuitBreakerError,
  portraitVisionCacheIdentity,
} from './portrait-vision.ts'
import {
  HarnessVisionError,
  HarnessVisionTransport,
  harnessRouteIdentity,
  renderHarnessRoute,
  resolveHarnessModelRoute,
  type HarnessModelRoute,
  type HarnessVisionExecution,
  type HarnessVisionServices,
} from './harness-vision.ts'
import {
  compactPreferenceProfileInput,
  createPreferenceProfile,
  type PreferenceProfileInput,
} from './preferences.ts'
import {
  portraitRankPolicy,
  rankPortraits,
  type PairwiseComparison,
  type RankingCandidate,
} from './ranking.ts'
import {
  MAX_PAIRWISE_PAIRS,
  highRefinementContextKey,
  planHighRefinement,
  planPairwiseBudget,
  plannedPairwiseLegs,
  runAfterDurableCheckpoint,
  type HighRefinementPlan,
  type PairwiseBudgetPlan,
} from './selection-budget.ts'
import { PORTRAIT_BASELINE_RUBRIC, PORTRAIT_BASELINE_RUBRIC_VERSION } from './rubric.ts'
import { runAuditV3 } from './audit-runner.ts'
import {
  independentEvaluatorToolDefinition,
  installIndependentEvaluatorRouteOverride,
} from './independent-evaluator.ts'
import {
  createFrozenSelectionReceipt,
  serializeFrozenSelectionReceipt,
  type FrozenSelectionReceipt,
} from '../../scripts/selection-receipt.mjs'

export const name = 'photo-filter-agent'
export const inject = ['tools', 'llm', 'attachments', 'subagents']

export interface Config {
  /** `photofilter` 可执行文件路径。 */
  engineBinary: string
  /** 引擎工作目录：匿名 ID ↔ 路径的映射存在这里，不进模型上下文。 */
  workdir: string
  /** 一次 inspect 最多几张，避免模型一次要走整池。 */
  maxInspectBatch: number
  /** 打分的并发路数。开满会换来一串 429 再触发退避，反而更慢。 */
  inspectConcurrency: number
  /** analyze_folder 摘要里直接列出 ID 的上限；超过就只给区间，让模型去 list_candidates。 */
  maxInlineIdList: number
  /** 一轮策展默认的保留目标。 */
  defaultPeopleTarget: number
  defaultSceneryTarget: number
  /** 照片源目录读取白名单。空数组代表拒绝全部，不是无限制。 */
  allowedRoots: string[]
  /**
   * 相对于每次照片源根目录、必须在候选 fingerprint 与匿名 ID 生成前排除的路径。
   * 用于把离线验收 oracle（例如 me-pick）与 selector 候选宇宙物理隔离。
   */
  excludedRelativePaths: string[]
  /** 导出目标目录白名单。目标必须预先存在；空数组代表拒绝全部。 */
  allowedExportRoots: string[]
}

export const Config: z<Config> = z.object({
  engineBinary: z.string().default('photofilter'),
  workdir: z.string().default('/tmp/photo-filter-agent'),
  maxInspectBatch: z.number().step(1).min(1).max(32).default(8),
  inspectConcurrency: z.number().step(1).min(1).max(16).default(4),
  maxInlineIdList: z.number().step(1).min(0).default(80),
  defaultPeopleTarget: z.number().step(1).min(0).default(6),
  defaultSceneryTarget: z.number().step(1).min(0).default(6),
  allowedRoots: z.array(z.string()).default([]),
  excludedRelativePaths: z.array(z.string()).default([]),
  allowedExportRoots: z.array(z.string()).default([]),
})

/** 解析符号链接后验证路径仍位于允许根内；失败时不把允许根列表泄露给模型。 */
async function requireAllowedPath(path: string, roots: string[], purpose: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${purpose}必须是绝对路径。`)
  if (!roots.length) throw new Error(`${purpose}尚未获得目录授权。`)
  const resolved = await realpath(path)
  for (const root of roots) {
    let allowed: string
    try {
      allowed = await realpath(root)
    } catch {
      continue
    }
    const remainder = relative(allowed, resolved)
    if (remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))) {
      return resolved
    }
  }
  throw new Error(`${purpose}不在已授权范围内。`)
}

/** 候选表里给模型看的一行：只有匿名 ID 与本地事实。 */
function row(candidate: Candidate, effectiveCategory: Category = candidate.category): string {
  const categoryLabel = effectiveCategory === 'people' ? '人物' : '风景'
  const localOverride = effectiveCategory !== candidate.category
    ? `（本地分类:${candidate.category === 'people' ? '人物' : '风景'}）`
    : ''
  const parts = [
    candidate.id,
    `${categoryLabel}${localOverride}`,
    `清晰${candidate.sharp}`,
    `宽容${candidate.range}`,
    `过曝${candidate.clip}`,
  ]
  if (candidate.family) parts.push(`连拍${candidate.family}`)
  if (candidate.risk.length) parts.push(`风险:${candidate.risk.join(',')}`)
  if (candidate.face) parts.push(candidate.face)
  if (candidate.eyes_closed) parts.push('本地提示:可能闭眼，需结合意图复核')
  if (candidate.local_top) parts.push('本地优等')
  if (candidate.t !== undefined) parts.push(`+${candidate.t}s`)
  return parts.join(' ')
}

function portraitSelectionHash(
  datasetFingerprint: string,
  candidateScope: CandidateScope,
  ids: readonly string[],
): string {
  return createHash('sha256')
    .update(
      `${PORTRAIT_BASELINE_RUBRIC_VERSION}\u0000${datasetFingerprint}\u0000${candidateScope}\u0000` +
      [...ids].sort().join('\u0000'),
    )
    .digest('hex')
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : []
}

const PORTRAIT_RUBRIC_CONTENT_HASH = createHash('sha256')
  .update(JSON.stringify(PORTRAIT_BASELINE_RUBRIC))
  .digest('hex')

let acceptanceReceiptWriteSequence = 0

/** Persist a content-addressed receipt without ever replacing an existing file. */
async function persistAcceptanceReceipt(
  workdir: string,
  receipt: FrozenSelectionReceipt,
): Promise<string> {
  const serialized = serializeFrozenSelectionReceipt(receipt)
  const directory = join(workdir, 'acceptance-receipts')
  const destination = join(directory, `${receipt.receiptHash}.json`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = await readFile(destination, 'utf8')
    if (existing !== serialized) throw new Error('同一 receipt hash 已存在不同内容')
    return receipt.receiptHash
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const sequence = acceptanceReceiptWriteSequence += 1
  const temporary = join(
    directory,
    `.${receipt.receiptHash}.${process.pid}.${sequence}.tmp`,
  )
  await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    try {
      // A hard link is an atomic create-if-absent on this same private volume.
      await link(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(destination, 'utf8')
      if (existing !== serialized) throw new Error('同一 receipt hash 已存在不同内容')
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  return receipt.receiptHash
}

/** Canonicalize configured dataset exclusions before any engine or receipt use. */
function normalizeExcludedRelativePaths(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const raw of values) {
    if (!raw || raw.includes('\0') || isAbsolute(raw)) {
      throw new Error('excludedRelativePaths 只能包含非空相对路径。')
    }
    const components = raw.split('/')
    if (components.includes('..')) {
      throw new Error('excludedRelativePaths 不能包含 ..。')
    }
    const value = components.filter(component => component && component !== '.').join('/')
    if (!value) throw new Error('excludedRelativePaths 不能指向照片根目录。')
    normalized.add(value)
  }
  return Object.freeze([...normalized].sort())
}

export function apply(ctx: Context, config: Config): void {
  // 专用 preset 是可见工具边界；这个 guard 是不可被后加载 pre-execute 策略放宽的
  // 执行边界。即使 Host 意外注册了 shell/fs/web，Photo Curator 也执行不了它们。
  const photoTools = new Set([
    'analyze_folder',
    'list_candidates',
    'status',
    'inspect',
    'compare',
    'resolve_family',
    'propose',
    'export_selection',
    'local_fallback_selection',
    'set_preferences',
    'evaluate_pool',
    'build_selection',
    'audit_selection',
    'independent_evaluator',
  ])
  ctx.tools.guard(exec => photoTools.has(exec.name)
    ? undefined
    : 'Photo Curator 只允许执行照片策展专用工具。')
  installIndependentEvaluatorRouteOverride(ctx)
  ctx.tools.register(independentEvaluatorToolDefinition(ctx, settleRun, defineTool))
  const excludedRelativePaths = normalizeExcludedRelativePaths(config.excludedRelativePaths)
  // 一个 preset 实例会服务多个 Harness session。运行状态必须按 Agent 隔离；否则一个
  // 会话切换目录会让另一个会话预览或导出错误的匿名 ID。
  const states = new WeakMap<object, RunState>()
  const auditInvokedAgents = new WeakSet<object>()
  const headlessState = makeState()
  function makeState(): RunState {
    const state = new RunState()
    state.targets = { people: config.defaultPeopleTarget, scenery: config.defaultSceneryTarget }
    return state
  }
  function stateFor(exec: { agent?: object }): RunState {
    if (!exec.agent) return headlessState
    const existing = states.get(exec.agent)
    if (existing) return existing
    const created = makeState()
    states.set(exec.agent, created)
    return created
  }

  // Swift 的 index.json 不能被不同目录共用。按目录与取样上限分配独立工作目录；
  // 数据集内容身份再由 analyze 返回的 fingerprint 管住分数缓存。
  const engines = new Map<string, PhotoEngine>()
  function engineFor(folder: string, limit?: number): PhotoEngine {
    const key = createHash('sha256')
      .update(`${folder}#${limit ?? 'all'}#${JSON.stringify(excludedRelativePaths)}`)
      .digest('hex')
      .slice(0, 16)
    const existing = engines.get(key)
    if (existing) return existing
    const created = new PhotoEngine(config.engineBinary, join(config.workdir, 'datasets', key))
    engines.set(key, created)
    return created
  }

  // A RunState belongs to one Agent, but the model route may change between
  // steps in that session. Every identity-sensitive tool rebinds from the
  // latest logged request header; a route switch makes old paid artifacts
  // stale without deleting them.
  const routeByState = new WeakMap<RunState, HarnessModelRoute>()
  const headlessOwner = {}
  const preflightByOwner = new WeakMap<object, Map<string, Promise<HarnessVisionTransport>>>()
  const passedPreflightByOwner = new WeakMap<object, Set<string>>()

  function bindCurrentRoute(state: RunState, exec: HarnessVisionExecution): HarnessModelRoute {
    const route = resolveHarnessModelRoute(exec)
    routeByState.set(state, route)
    return route
  }

  function boundRoute(state: RunState): HarnessModelRoute {
    const route = routeByState.get(state)
    if (!route) {
      throw new HarnessVisionError('当前工具尚未绑定 DSH provider/model。', {
        code: 'MODEL_ROUTE_UNBOUND',
      })
    }
    return route
  }

  function visionServices(): HarnessVisionServices {
    return {
      llm: ctx.get('llm') as unknown as HarnessVisionServices['llm'],
      attachments: ctx.get('attachments') as unknown as HarnessVisionServices['attachments'],
    }
  }

  function transportFor(exec: HarnessVisionExecution, route: HarnessModelRoute): HarnessVisionTransport {
    return new HarnessVisionTransport(visionServices(), route, exec.agent?.session?.id)
  }

  async function ensureModelReady(
    state: RunState,
    exec: HarnessVisionExecution,
  ): Promise<HarnessVisionTransport> {
    const route = bindCurrentRoute(state, exec)
    const owner = exec.agent ?? headlessOwner
    let rows = preflightByOwner.get(owner)
    if (!rows) {
      rows = new Map()
      preflightByOwner.set(owner, rows)
    }
    const key = harnessRouteIdentity(route)
    let pending = rows.get(key)
    if (!pending) {
      const transport = transportFor(exec, route)
      pending = transport.preflight(exec.signal).then(() => {
        let passed = passedPreflightByOwner.get(owner)
        if (!passed) {
          passed = new Set()
          passedPreflightByOwner.set(owner, passed)
        }
        passed.add(key)
        return transport
      })
      rows.set(key, pending)
      pending.catch(() => {
        rows!.delete(key)
        passedPreflightByOwner.get(owner)?.delete(key)
      })
    }
    return pending
  }

  /** Every legacy call also uses the exact current Harness route. */
  async function vision(state: RunState, exec: HarnessVisionExecution): Promise<VisionClient> {
    return new VisionClient({ transport: await ensureModelReady(state, exec) })
  }

  /** Frozen portrait rubric, isolated request context, current Harness route. */
  async function portraitVision(
    state: RunState,
    exec: HarnessVisionExecution,
  ): Promise<PortraitVisionClient> {
    return new PortraitVisionClient({ transport: await ensureModelReady(state, exec) })
  }

  const configuredPortraitIdentity = (state: RunState) => portraitVisionCacheIdentity(boundRoute(state))
  const selectorCacheKey = (state: RunState): string => createHash('sha256')
    .update([
      'role:selector',
      state.datasetFingerprint ?? '',
      PORTRAIT_BASELINE_RUBRIC_VERSION,
      configuredPortraitIdentity(state).selectorBaselinePromptHash,
      configuredPortraitIdentity(state).routeIdentity,
    ].join('\u0000'))
    .digest('hex')

  const selectorPairwiseIdentityKey = (state: RunState): string => createHash('sha256')
    .update([
      'role:selector-pairwise',
      state.datasetFingerprint ?? '',
      PORTRAIT_BASELINE_RUBRIC_VERSION,
      configuredPortraitIdentity(state).auditPairwisePromptHash,
      configuredPortraitIdentity(state).routeIdentity,
    ].join('\u0000'))
    .digest('hex')

  const selectorComparisons = (state: RunState): PairwiseComparison[] => {
    const identity = selectorPairwiseIdentityKey(state)
    return state.portraitComparisons.filter(comparison => comparison.cacheKey === identity)
  }

  const selectorPairwiseLegKey = (
    state: RunState,
    aId: string,
    bId: string,
    order: 'AB' | 'BA',
  ): string => createHash('sha256')
    .update([selectorPairwiseIdentityKey(state), aId, bId, order].join('\u0000'))
    .digest('hex')

  const auditProviderIdentityKey = (state: RunState): string => createHash('sha256')
    .update([
      'role:audit-provider',
      PORTRAIT_BASELINE_RUBRIC_VERSION,
      configuredPortraitIdentity(state).auditBaselinePromptHash,
      configuredPortraitIdentity(state).auditPairwisePromptHash,
      configuredPortraitIdentity(state).routeIdentity,
    ].join('\u0000'))
    .digest('hex')

  /**
   * Freeze local acceptance evidence only after proposal validation has proved
   * exact-K + audit v3 PASS. No oracle path is opened here.
   */
  async function freezeAcceptanceReceipt(
    state: RunState,
    exec: HarnessVisionExecution,
  ): Promise<string | undefined> {
    if (!excludedRelativePaths.length || !state.portraitDraft) return undefined
    if (!state.folder || !state.datasetFingerprint || state.portraitAudit?.status !== 'PASS') {
      throw new Error('缺少 dataset、冻结名单或 audit PASS，不能生成验收 receipt')
    }
    const keep = [...state.portraitDraft.keep]
    const engine = engineFor(state.folder, state.limit)
    const contentHashes = await engine.contentHashes(keep, exec.signal)
    const hashesById = new Map(contentHashes.map(item => [item.id, item.sha256]))
    if (contentHashes.length !== keep.length || hashesById.size !== keep.length
      || keep.some(id => !hashesById.has(id))) {
      throw new Error('原图内容哈希没有完整覆盖冻结名单')
    }
    const identity = configuredPortraitIdentity(state)
    const receipt = createFrozenSelectionReceipt({
      sourceRoot: state.folder,
      excludedRelativePaths,
      datasetFingerprint: state.datasetFingerprint,
      selectionHash: state.portraitDraft.selectionHash,
      candidateScope: state.candidateScope,
      target: keep.length,
      selectedItems: keep.map(id => ({ id, sha256: hashesById.get(id)! })),
      auditStatus: 'PASS',
      routeIdentity: identity.routeIdentity,
      rubricIdentity: {
        version: PORTRAIT_BASELINE_RUBRIC_VERSION,
        hash: PORTRAIT_RUBRIC_CONTENT_HASH,
      },
      promptIdentity: {
        selectorBaselineHash: identity.selectorBaselinePromptHash,
        auditBaselineHash: identity.auditBaselinePromptHash,
        auditPairwiseHash: identity.auditPairwisePromptHash,
      },
    })
    return persistAcceptanceReceipt(config.workdir, receipt)
  }

  function portraitRefinementContextKey(
    state: RunState,
    target: number,
    auditFeedbackFingerprint?: string,
  ): string {
    return highRefinementContextKey({
      datasetFingerprint: state.datasetFingerprint ?? '',
      candidateScope: state.candidateScope,
      target,
      preferenceFingerprint: JSON.stringify(state.preference),
      rubricModelKey: selectorCacheKey(state),
      auditFeedbackFingerprint,
    })
  }

  function portraitRankingCandidates(
    state: RunState,
    baselineOnly = false,
  ): RankingCandidate[] {
    return state.portraitCandidates().flatMap(candidate => {
      const stored = state.portraitScores.get(candidate.id)
      if (!stored || stored.cacheKey !== selectorCacheKey(state)) return []
      const score = state.portraitScore(candidate.id)
      const chosen = baselineOnly ? score?.baseline : score?.personalized
      const tags = stored.assessment.observableTags
      return [{
        id: candidate.id,
        score: chosen ?? 0,
        eligibility: stored.assessment.eligibility.status,
        familyId: candidate.family,
        diversityTags: [
          ...tags.expression.map(value => `expression:${value}`),
          ...tags.gaze.map(value => `gaze:${value}`),
          ...tags.framing.map(value => `framing:${value}`),
          ...tags.lighting.map(value => `lighting:${value}`),
          ...tags.mood.map(value => `mood:${value}`),
          ...tags.scene.map(value => `scene:${value}`),
          ...tags.poseAction.map(value => `pose:${value}`),
        ],
      }]
    })
  }

  async function scoreSelectorIds(
    state: RunState,
    engine: PhotoEngine,
    client: PortraitVisionClient,
    ids: readonly string[],
    detail: 'low' | 'high',
    signal?: AbortSignal,
  ): Promise<{
    attempted: number
    paid: number
    cached: number
    failures: Array<{ id: string; message: string }>
    circuitBreaker?: string
  }> {
    const cacheKey = selectorCacheKey(state)
    const cachedIds = ids.filter(id => state.cachedPortrait(id, detail, cacheKey))
    const pending = ids.filter(id => !state.cachedPortrait(id, detail, cacheKey))
    state.paidCalls.cached += cachedIds.length
    const attemptedBefore = state.paidCalls.portraitScoreAttempted
    let circuitBreaker: string | undefined
    const outcomes = await mapWithConcurrency(
      pending,
      config.inspectConcurrency,
      async id => {
        if (circuitBreaker) {
          return { id, ok: false as const, message: `本次评分已熔断：${circuitBreaker}` }
        }
        try {
          const preview = await engine.preview(id, detail, signal)
          // A provider can charge even when its response reaches maxTokens or
          // violates the structured schema. Commit the attempt before sending
          // pixels so a crash/restart cannot hide or repeat paid work silently.
          state.paidCalls.portraitScoreAttempted += 1
          if (!await saveState(state, config.workdir)) {
            circuitBreaker = '本地计费 checkpoint 写入失败；图片尚未发送'
            return { id, ok: false as const, message: circuitBreaker }
          }
          const assessment = await client.scoreBaseline(id, preview.jpeg_base64, detail, signal, 'selector')
          state.recordPortrait(assessment, detail, cacheKey)
          state.paidCalls.portraitScore += 1
          if (!await saveState(state, config.workdir)) {
            circuitBreaker = '本地 checkpoint 写入失败；为避免重复计费已停止后续请求'
            return { id, ok: false as const, message: circuitBreaker }
          }
          return { id, ok: true as const }
        } catch (error) {
          if (isPortraitVisionCircuitBreakerError(error)) {
            circuitBreaker = error instanceof Error ? error.message : '视觉供应商额度或限流'
          }
          return {
            id,
            ok: false as const,
            message: error instanceof Error ? error.message : '视觉评分失败',
          }
        }
      },
    )
    return {
      attempted: state.paidCalls.portraitScoreAttempted - attemptedBefore,
      paid: outcomes.filter(outcome => outcome.ok).length,
      cached: cachedIds.length,
      failures: outcomes
        .filter((outcome): outcome is { id: string; ok: false; message: string } => !outcome.ok)
        .map(({ id, message }) => ({ id, message })),
      circuitBreaker,
    }
  }

  function renderSelectionBudget(
    plan: HighRefinementPlan,
    pairs: PairwiseBudgetPlan,
    state: RunState,
    label = '预算预检',
  ): string {
    const cacheKey = selectorCacheKey(state)
    const highCached = plan.candidateIds.filter(id =>
      state.cachedPortrait(id, 'high', cacheKey)).length
    const highToPay = plan.candidateIds.length - highCached
    return `${label}：eligible_at_freeze=${plan.eligibleCount} target=${plan.target}；` +
      `high_cap=min(${plan.eligibleCount}, max(${plan.target}×3, ${plan.target}+20))=${plan.hardCap}；` +
      `planned_high=${plan.candidateIds.length}（audit_forced=${plan.auditForcedCount ?? 0}，` +
      `base_window=${plan.baseCount}，` +
      `family_challenger=${plan.familyChallengerAddedCount} + global_fill=${plan.globalFillCount}；` +
      `头部家族=${plan.leadingFamilyCount}，每族额外≤${plan.familyChallengersPerFamily}）；` +
      `high_cached=${highCached} high_to_pay=${highToPay}；` +
      `estimated_pairwise_pairs=${pairs.pairs.length}（上限 ${pairs.pairCap} 组），` +
      `其中 audit_reserved=${pairs.auditPairCount ?? 0}；` +
      `estimated_bidirectional_calls=${pairs.pairs.length * 2}（上限 ${pairs.bidirectionalCallCap} 次）。`
  }

  ctx.tools.register(defineTool({
    name: 'analyze_folder',
    description:
      '在本机递归分析一个照片目录：人物/风景分类、连拍相似组、清晰度与曝光。免费，不联网，不发送任何照片。策展的第一步。',
    parameters: {
      folder: { type: 'string', required: true, description: '照片目录的绝对路径' },
      limit: { type: 'number', description: '只分析其中若干张（跨目录均匀取样）；省略则全部' },
      people_target: { type: 'number', description: '人物照要保留几张' },
      scenery_target: { type: 'number', description: '风景照要保留几张' },
      candidate_scope: {
        type: 'string',
        description:
          '候选范围：auto（默认，按本地人物/风景分类）或 people_only（用户明确确认整批均为人物候选；必须同时设置 scenery_target=0）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          photo_count: { type: 'number' },
          people_count: { type: 'number' },
          scenery_count: { type: 'number' },
          local_people_count: { type: 'number' },
          local_scenery_count: { type: 'number' },
          portrait_pool_count: { type: 'number' },
          excluded_subtree_count: { type: 'number' },
          candidate_scope: { type: 'string' },
          family_count: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const candidateScope = parseCandidateScope(args.candidate_scope, args.scenery_target)
      const folder = await requireAllowedPath(args.folder, config.allowedRoots, '照片目录')
      const engine = engineFor(folder, args.limit)
      const report = await engine.analyze(folder, args.limit, exec.signal, excludedRelativePaths)
      state.absorb(report, folder, args.limit, candidateScope)
      // 分数是花过钱的资产：同一目录、同一取样上限下已经打过的分要接着用，
      // 否则每开一个新会话就把同一批照片重新买一遍。
      const restored = await loadState(state, config.workdir, folder, args.limit)
      if (args.people_target !== undefined) {
        state.targets.people = Math.max(0, Math.floor(args.people_target))
      }
      if (args.scenery_target !== undefined) {
        state.targets.scenery = Math.max(0, Math.floor(args.scenery_target))
      }
      await saveState(state, config.workdir)
      const multi = report.families.filter((f) => f.members.length > 1)
      const localPeopleCount = report.candidates.filter(candidate => candidate.category === 'people').length
      const localSceneryCount = report.candidates.filter(candidate => candidate.category === 'scenery').length
      const portraitPoolCount = state.portraitCandidates().length
      // 摘要里不给 ID，模型就只能凭空猜（实测它造出了 people_01 这种不存在的编号，
      // 白白多花两步往返）。ID 是它下一步唯一能用的抓手，必须直接给出来。
      const listing = (category: 'people' | 'scenery') => {
        const ids = state.all(category).map((candidate) => candidate.id)
        if (!ids.length) return ''
        const label = category === 'people' ? '人物' : '风景'
        if (ids.length <= config.maxInlineIdList) {
          return `${label} ${ids.length} 张：${ids.join(' ')}\n`
        }
        return `${label} ${ids.length} 张：${ids[0]} … ${ids[ids.length - 1]}` +
          `（太多不全列，用 list_candidates 取）\n`
      }
      const resumed = restored && (state.scores.size || state.portraitScores.size)
        ? `\n已恢复本数据集的本地 checkpoint；详情可由主 Agent 调 status 查看，不在 analyze 输出排名。\n`
        : ''
      const closedEyes = report.candidates.filter((c) => c.eyes_closed).length
      const banner = multi.length
        ? `\n发现 ${multi.length} 组连拍。旧版候选视图会折叠它们，但 evaluate_pool 会评估完整组，\n` +
          `build_selection 会在高分家族和切线附近执行双向 pairwise，不会让占位代表替整组参赛。\n`
        : ''
      const eyeNote = closedEyes
        ? `本机提示 ${closedEyes} 张人物照可能闭眼；这不是自动硬淘汰，需按画面意图复核人物瞬间。\n`
        : ''
      const scopeNote = candidateScope === 'people_only'
        ? `候选范围：people_only；人物评估池 ${portraitPoolCount} 张。本地分类仅作提示，不会排除任何照片。\n`
        : `候选范围：auto；人物评估池 ${portraitPoolCount} 张。\n` +
          (state.targets.people > 0 && report.photo_count > 0 && portraitPoolCount === 0
            ? '人物目标大于 0，但本地分类未发现人物。若用户明确确认整批均为人物候选，请重新 analyze_folder，设置 candidate_scope=people_only 且 scenery_target=0；不会自动扩大付费范围。\n'
            : '')
      const exclusionNote = excludedRelativePaths.length
        ? `本轮在 fingerprint 与匿名 ID 生成前隔离 ${excludedRelativePaths.length} 个配置子树；其内容未进入候选池。\n`
        : ''
      const summary =
        `已在本机分析 ${report.photo_count} 张：本地分类人物 ${localPeopleCount} · 风景 ${localSceneryCount}。\n` +
        resumed + exclusionNote + banner + eyeNote +
        scopeNote +
        `目标：人物 ${state.targets.people} 张 · 风景 ${state.targets.scenery} 张。\n\n` +
        listing('people') + listing('scenery') +
        (multi.length
          ? `连拍组：${multi.map((f) => `${f.id}[${f.members.join(' ')}]`).join('  ')}\n`
          : '')
      return {
        photo_count: report.photo_count,
        people_count: report.people_count,
        scenery_count: report.scenery_count,
        local_people_count: localPeopleCount,
        local_scenery_count: localSceneryCount,
        portrait_pool_count: portraitPoolCount,
        excluded_subtree_count: excludedRelativePaths.length,
        candidate_scope: candidateScope,
        family_count: multi.length,
        summary,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_candidates',
    description:
      '列出仍在竞争的候选照片及其本地指标（不含图像，免费）。已被连拍组淘汰的不再出现。',
    parameters: {
      category: {
        type: 'string',
        description: '只看某一类：people 或 scenery；省略则两类都看',
      },
      family: { type: 'string', description: '只看某一个连拍组，例如 F03' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const category = args.category === 'people' || args.category === 'scenery'
        ? (args.category as Category)
        : undefined
      let pool = state.active(category)
      if (args.family) pool = pool.filter((c) => c.family === args.family)
      if (!pool.length) return '没有符合条件的候选。先运行 analyze_folder。'
      const head = `${pool.length} 张候选（清晰/宽容/过曝为 0–100 的本地指标，越高越好，过曝越低越好）：`
      return [head, ...pool.map(candidate => row(candidate, state.effectiveCategory(candidate)))].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'status',
    description: '当前处境：各类的排名、切线分差、待定连拍组、已花费。免费。用它判断还要不要继续花钱。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(_args, exec) {
      const state = stateFor(exec)
      try {
        const route = bindCurrentRoute(state, exec)
        const owner = exec.agent ?? headlessOwner
        const ready = passedPreflightByOwner.get(owner)?.has(harnessRouteIdentity(route)) ?? false
        return `全链路模型：${renderHarnessRoute(route)}；图片前动态预检=${ready ? 'PASS' : '尚未执行'}。\n` +
          state.render()
      } catch (error) {
        return `全链路模型：BLOCKED（${error instanceof Error ? error.message : '路由不可用'}）\n` +
          state.render()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'set_preferences',
    description:
      '设置可审计的人像偏好。偏好只产生最多 ±4 分的第二阶段调整；冻结 baseline 分永不改变。' +
      '全部省略表示恢复通用 baseline。只接受白名单视觉标签，不接受身份或受保护属性。',
    parameters: {
      expression: { type: 'array', items: { type: 'string' }, description: '偏好表情：natural/joyful/calm/serious/candid/dramatic' },
      gaze: { type: 'array', items: { type: 'string' }, description: '偏好视线：camera/off_camera/mutual/introspective' },
      framing: { type: 'array', items: { type: 'string' }, description: '偏好景别：close_up/half_body/full_body/environmental' },
      lighting: { type: 'array', items: { type: 'string' }, description: '偏好光线：soft/dramatic/backlit/natural/high_key/low_key' },
      mood: { type: 'array', items: { type: 'string' }, description: '偏好氛围：warm/cool/cinematic/playful/serene/energetic/documentary' },
      dimension_focus: {
        type: 'array',
        items: { type: 'string' },
        description: '希望额外重视的 baseline 维度 ID；仍不会改写 baseline 本身',
      },
      diversity: { type: 'number', description: '集合多样性强度 0–1；省略使用 baseline 集合规则' },
      series_retention: {
        type: 'string',
        description: '相似连拍保留策略：balanced（默认自动限额）、one_per_family（一组一张）、allow_series（允许系列）',
      },
      max_quality_tradeoff: { type: 'number', description: '两图可因偏好逆转的最大 baseline 分差，0–8，默认 8' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const vector = (value: unknown): Record<string, number> | undefined => {
        const values = uniqueStrings(value)
        return values.length ? Object.fromEntries(values.map(item => [item, 1])) : undefined
      }
      const dimensionWeights = vector(args.dimension_focus)
      const input: PreferenceProfileInput = compactPreferenceProfileInput({
        expression: vector(args.expression) as PreferenceProfileInput['expression'],
        gaze: vector(args.gaze) as PreferenceProfileInput['gaze'],
        framing: vector(args.framing) as PreferenceProfileInput['framing'],
        lighting: vector(args.lighting) as PreferenceProfileInput['lighting'],
        mood: vector(args.mood) as PreferenceProfileInput['mood'],
        dimensionWeights: dimensionWeights as PreferenceProfileInput['dimensionWeights'],
        diversity: args.diversity,
        seriesRetention: args.series_retention as PreferenceProfileInput['seriesRetention'],
        maxQualityTradeoff: args.max_quality_tradeoff,
      })
      try {
        // 先解析一次确保错误不改变当前 profile，再交给 state 统一失效下游决策。
        createPreferenceProfile(input)
        const profile = state.setPreference(input)
        await saveState(state, config.workdir)
        return profile.isBaseline
          ? '已恢复通用 baseline：偏好调整为 0；集合仍执行固定的 4 分质量前沿多样性规则。'
          : `偏好已锁定：单图调整范围 ±${profile.maxQualityTradeoff / 2} 分。` +
              ` baseline 将保留原值；profile=${JSON.stringify(profile)}`
      } catch (error) {
        return `偏好未生效：${error instanceof Error ? error.message : '输入不合法'}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'evaluate_pool',
    description:
      '按冻结六维人像 baseline 评估完整人物候选池（包括折叠的连拍成员）。' +
      '只支持 low：每张只发送匿名、无元数据缩略 JPEG 给配置的视觉供应商；会花钱。' +
      '失败时以完全相同参数重试只补 missing；严禁改成 high，high 只能由 build_selection 的预算计划触发。',
    parameters: {
      detail: { type: 'string', description: '只能是 low（默认，全池 baseline；重试自动只补 missing）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      let route: HarnessModelRoute
      try {
        route = bindCurrentRoute(state, exec)
      } catch (error) {
        return `拒绝执行：${error instanceof Error ? error.message : '无法解析当前 DSH 模型路由'}`
      }
      if (!state.folder) return '先运行 analyze_folder。'
      if (args.detail !== undefined && args.detail !== 'low') {
        return '拒绝执行：evaluate_pool 只允许 detail=low。high 复核必须先由 build_selection mode=plan 冻结 hard cap，再用 mode=run 执行；不要用整池 high 修复单张失败。'
      }
      const detail = 'low' as const
      const people = state.portraitCandidates()
      if (!people.length) {
        if (state.candidateScope === 'auto' && state.targets.people > 0 && state.candidates.size > 0) {
          return '人物评估池为 0；本地分类未发现人物。不会自动扩大付费范围。若用户明确确认整批均为人物候选，请重新 analyze_folder，设置 candidate_scope=people_only 且 scenery_target=0。'
        }
        return '完整候选池里没有人物照片。'
      }
      let client: PortraitVisionClient
      try {
        client = await portraitVision(state, exec)
      } catch (error) {
        return `BLOCKED：模型预检未通过，图片未发送：` +
          `${error instanceof Error ? error.message : '当前 DSH 模型不可用'}\n` +
          `route=${renderHarnessRoute(route)}\n` +
          'next_action=fix_model_route；禁止在当前 turn 自动重试 evaluate_pool、status 或切换到其他隐式视觉模型。'
      }
      const engine = engineFor(state.folder, state.limit)
      const result = await scoreSelectorIds(
        state,
        engine,
        client,
        people.map(candidate => candidate.id),
        detail,
        exec.signal,
      )
      await saveState(state, config.workdir)
      const assessments = people.flatMap(candidate => {
        const stored = state.portraitScores.get(candidate.id)
        return stored ? [stored.assessment] : []
      })
      const eligible = assessments.filter(assessment => assessment.eligibility.status === 'eligible').length
      const review = assessments.filter(assessment => assessment.eligibility.status === 'needs_review').length
      const failedText = result.failures.length
        ? `\n${result.circuitBreaker ? 'BLOCKED' : 'INCOMPLETE'}：${result.failures.length} 张未完成。` +
          result.failures.slice(0, 20).map(item => `\n  ${item.id}: ${item.message}`).join('') +
          (result.circuitBreaker
            ? `\ncircuit_breaker=${result.circuitBreaker}\n` +
              'next_action=fix_model_route；禁止在当前 turn 自动重试 evaluate_pool 或 status。修复当前会话 provider/model 后，新 turn 使用相同 detail=low 只补 missing。'
            : '\nnext_action=retry_evaluate_pool_low；在后续新 turn 使用相同 detail=low 只补 missing，禁止改用 high。')
        : ''
      return `全链路模型：${renderHarnessRoute(route)}\n` +
        `完整人物池 ${people.length} 张：本次 provider 请求 ${result.attempted} · ` +
        `成功 ${result.paid} · 失败 ${result.failures.length} · 缓存 ${result.cached} · ` +
        `eligible ${eligible} · needs_review ${review}。${failedText}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'build_selection',
    description:
      '从完整 baseline 池自动构建精确 K 张人物名单。它会高分辨率复核候选、对高分家族和切线执行 A/B 与 B/A 双向比较，' +
      '用 Bradley–Terry 聚合，并只在 4 分质量前沿内做集合多样性。mode=plan 免费返回严格预算，mode=run 执行；' +
      '省略 mode 兼容为 run。主 Agent不能手填替换结果；run 会花钱。',
    parameters: {
      mode: {
        type: 'string',
        description: 'plan：零付费预览 planned high/cache/to-pay/pairwise 预算；run：按同一 hard cap 执行。省略为 run。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      let route: HarnessModelRoute
      try {
        route = bindCurrentRoute(state, exec)
      } catch (error) {
        return `拒绝执行：${error instanceof Error ? error.message : '无法解析当前 DSH 模型路由'}`
      }
      if (!state.folder || !state.datasetFingerprint) return '先运行 analyze_folder。'
      if (state.limit !== undefined) {
        return '最佳人像必须比较完整目录；当前 analyze_folder 使用了 limit。请不传 limit 重新分析全池。'
      }
      if (args.mode !== undefined && args.mode !== 'plan' && args.mode !== 'run') {
        return 'mode 必须是 plan 或 run。'
      }
      const mode: 'plan' | 'run' = args.mode === 'plan' ? 'plan' : 'run'
      if (state.targets.scenery !== 0) {
        return '本次“最佳人像”flow 要求 scenery_target=0；请重新 analyze_folder 并明确 scenery_target=0。'
      }
      const target = state.targets.people
      if (target <= 0) return 'people_target 必须大于 0。'
      const people = state.portraitCandidates()
      const currentSelectorCacheKey = selectorCacheKey(state)
      const currentSelectorPairwiseKey = selectorPairwiseIdentityKey(state)
      const feedback = state.portraitRebuildFeedback
      const rebuildFeedback = feedback
        && feedback.datasetFingerprint === state.datasetFingerprint
        && feedback.selectorIdentityKey === currentSelectorCacheKey
        && feedback.selectorPairwiseIdentityKey === currentSelectorPairwiseKey
        && feedback.auditProviderIdentityKey === auditProviderIdentityKey(state)
        ? feedback
        : undefined
      const missing = people.filter(candidate =>
        !state.cachedPortrait(candidate.id, 'low', currentSelectorCacheKey))
      if (missing.length) {
        return `还有 ${missing.length} 张人物未完成 baseline（${missing.slice(0, 20).map(item => item.id).join(' ')}）。先调用 evaluate_pool。`
      }
      let current = portraitRankingCandidates(state)
      const eligibleCount = current.filter(item => item.eligibility === 'eligible').length
      if (eligibleCount < target) {
        return `eligible 人像只有 ${eligibleCount} 张，无法精确选择 ${target} 张。`
      }

      const auditChallengerIds = rebuildFeedback?.strongerChallengerIds ?? []
      const freshRefinementPlan = planHighRefinement(current, target, {
        forcedCandidateIds: auditChallengerIds,
      })
      const refinementContextKey = portraitRefinementContextKey(
        state,
        target,
        rebuildFeedback?.feedbackHash,
      )
      const savedRefinement = state.portraitRefinementCheckpoint
      const portraitIds = new Set(people.map(candidate => candidate.id))
      const resumedRefinement = savedRefinement !== undefined
        && savedRefinement.contextKey === refinementContextKey
        && savedRefinement.plan.target === target
        && savedRefinement.plan.hardCap === Math.min(
          savedRefinement.plan.eligibleCount,
          Math.max(target * 3, target + 20),
        )
        && savedRefinement.plan.candidateIds.length <= savedRefinement.plan.hardCap
        && new Set(savedRefinement.plan.candidateIds).size === savedRefinement.plan.candidateIds.length
        && savedRefinement.plan.candidateIds.every(id => portraitIds.has(id))
      const refinementPlan = resumedRefinement
        ? savedRefinement!.plan
        : freshRefinementPlan
      let estimatedPreliminary
      try {
        const comparisons = selectorComparisons(state)
        estimatedPreliminary = rankPortraits(current, {
          topK: target,
          comparisons,
          ...portraitRankPolicy(state.preference),
        })
      } catch (error) {
        return `无法规划名单预算：${error instanceof Error ? error.message : '排序失败'}`
      }
      const estimatedPairs = planPairwiseBudget(
        current,
        estimatedPreliminary,
        selectorComparisons(state),
        target,
        MAX_PAIRWISE_PAIRS,
        auditChallengerIds,
      )
      const preflight = `全链路模型：${renderHarnessRoute(route)}\n` +
        renderSelectionBudget(refinementPlan, estimatedPairs, state) +
        (rebuildFeedback
          ? `\naudit_feedback=${auditChallengerIds.length} challengers；只用于预留 high/AB-BA 比较，不导入 evaluator 分数。`
          : '') +
        `\nrefinement_checkpoint=${resumedRefinement ? 'resumed' : mode === 'run' ? 'frozen_before_run' : 'would_freeze_on_run'} ` +
        `context=${refinementContextKey.slice(0, 12)}；重试只补这 ${refinementPlan.candidateIds.length} 张内的失败项。`
      if (mode === 'plan') {
        return `${preflight}\nmode=plan：零付费，未读取 high 预览、未调用视觉模型、未改变名单。`
      }

      if (!resumedRefinement) {
        state.portraitRefinementCheckpoint = {
          schemaVersion: 'portrait-refinement-checkpoint-v1',
          contextKey: refinementContextKey,
          plan: refinementPlan,
        }
        state.portraitSelectorPairwiseCheckpoint = undefined
      }

      // Starting a new/retried build invalidates any prior decision. Persist the
      // frozen high plan before resolving a client or issuing a paid request.
      state.portraitDraft = undefined
      state.portraitAudit = undefined
      state.proposal = undefined
      state.exportApproval = undefined

      let client: PortraitVisionClient
      try {
        client = await portraitVision(state, exec)
      } catch (error) {
        return `${preflight}\nBLOCKED：模型预检未通过，图片未发送：` +
          `${error instanceof Error ? error.message : '当前 DSH 模型不可用'}\n` +
          'next_action=fix_model_route；禁止在当前 turn 自动重试 build_selection、status 或切换到其他隐式视觉模型。'
      }
      const engine = engineFor(state.folder, state.limit)
      const refinementRun = await runAfterDurableCheckpoint(
        () => saveState(state, config.workdir),
        () => scoreSelectorIds(
          state,
          engine,
          client,
          refinementPlan.candidateIds,
          'high',
          exec.signal,
        ),
      )
      if (!refinementRun.ok) {
        return `${preflight}\nINCOMPLETE：refinement checkpoint 写入失败；本次 high provider 调用为 0。\n` +
          'next_action=retry_build_selection'
      }
      const refined = refinementRun.value
      if (refined.failures.length) {
        await saveState(state, config.workdir)
        if (refined.circuitBreaker) {
          return `${preflight}\n` +
            `BLOCKED：high 实际结果 planned=${refinementPlan.candidateIds.length} paid=${refined.paid} ` +
            `cached=${refined.cached} failed=${refined.failures.length}。\n` +
            `circuit_breaker=${refined.circuitBreaker}\n` +
            'next_action=fix_model_route；禁止在当前 turn 自动重试 build_selection 或 status。修复当前会话 provider/model 后，新 turn 只补冻结计划中的 remaining。'
        }
        return `${preflight}\n` +
          `high 实际结果：planned=${refinementPlan.candidateIds.length} paid=${refined.paid} ` +
          `cached=${refined.cached} failed=${refined.failures.length}。\n` +
          `高分辨率复核失败 ${refined.failures.length} 张：${refined.failures.map(item => item.id).join(' ')}。` +
          '重试 build_selection 会命中成功缓存。'
      }
      // High-detail scores are paid assets. Persist them before any ranking or
      // pairwise work so a later failure still resumes with high_to_pay=0.
      await saveState(state, config.workdir)

      current = portraitRankingCandidates(state)
      let preliminary
      try {
        const comparisons = selectorComparisons(state)
        preliminary = rankPortraits(current, {
          topK: target,
          comparisons,
          ...portraitRankPolicy(state.preference),
        })
      } catch (error) {
        return `${preflight}\n` +
          `high 实际结果：planned=${refinementPlan.candidateIds.length} paid=${refined.paid} ` +
          `cached=${refined.cached} failed=0。\n` +
          `无法构建名单：${error instanceof Error ? error.message : '排序失败'}`
      }
      const freshPairPlan = planPairwiseBudget(
        current,
        preliminary,
        selectorComparisons(state),
        target,
        MAX_PAIRWISE_PAIRS,
        auditChallengerIds,
      )
      const resumedPairPlan = state.portraitSelectorPairwiseCheckpoint?.schemaVersion
          === 'portrait-selector-pairwise-checkpoint-v1'
        && state.portraitSelectorPairwiseCheckpoint.contextKey === refinementContextKey
      const actualPairPlan = resumedPairPlan
        ? state.portraitSelectorPairwiseCheckpoint!.plan
        : freshPairPlan
      if (!resumedPairPlan) {
        state.portraitSelectorPairwiseCheckpoint = {
          schemaVersion: 'portrait-selector-pairwise-checkpoint-v1',
          contextKey: refinementContextKey,
          plan: actualPairPlan,
        }
        if (!await saveState(state, config.workdir)) {
          return `${preflight}\nINCOMPLETE：pairwise 计划 checkpoint 写入失败；本次 pairwise provider 调用为 0。\n` +
            'next_action=retry_build_selection'
        }
      }

      let pairCircuitBreaker: string | undefined
      let cachedPairwiseLegs = 0
      const pairwiseAttemptedBefore = state.paidCalls.portraitPairwiseAttempted
      const pairwiseSucceededBefore = state.paidCalls.portraitPairwise
      const pairResults = await mapWithConcurrency(
        actualPairPlan.pairs,
        Math.min(2, config.inspectConcurrency),
        async ({ leftId, rightId }) => {
          if (pairCircuitBreaker) return undefined
          const [aId, bId] = [leftId, rightId].sort()
          try {
            const [aPreview, bPreview] = await Promise.all([
              engine.preview(aId, 'high', exec.signal),
              engine.preview(bId, 'high', exec.signal),
            ])
            const decisions = new Map<'AB' | 'BA', ReturnType<RunState['cachedPortraitSelectorPairwiseLeg']>>()
            for (const order of ['AB', 'BA'] as const) {
              const key = selectorPairwiseLegKey(state, aId, bId, order)
              const cached = state.cachedPortraitSelectorPairwiseLeg(key)
              if (cached) {
                cachedPairwiseLegs += 1
                decisions.set(order, cached)
                continue
              }
              if (pairCircuitBreaker) return undefined
              state.paidCalls.portraitPairwiseAttempted += 1
              if (!await saveState(state, config.workdir)) {
                pairCircuitBreaker = '本地 pairwise 计费 checkpoint 写入失败；图片尚未发送'
                return undefined
              }
              const decision = await client.comparePairLeg(
                aId,
                aPreview.jpeg_base64,
                bId,
                bPreview.jpeg_base64,
                order,
                exec.signal,
              )
              state.recordPortraitSelectorPairwiseLeg(aId, bId, order, decision, key)
              state.paidCalls.portraitPairwise += 1
              if (!await saveState(state, config.workdir)) {
                pairCircuitBreaker = '本地 pairwise checkpoint 写入失败；为避免重复计费已停止'
                return undefined
              }
              decisions.set(order, state.cachedPortraitSelectorPairwiseLeg(key))
            }
            const ab = decisions.get('AB')?.decision
            const ba = decisions.get('BA')?.decision
            if (!ab || !ba) return undefined
            return { leftId: aId, rightId: bId, result: combinePairwiseLegs(aId, bId, ab, ba) }
          } catch (error) {
            if (isPortraitVisionCircuitBreakerError(error)) {
              pairCircuitBreaker = error instanceof Error ? error.message : '视觉供应商额度或限流'
            }
            return undefined
          }
        },
      )
      state.paidCalls.cached += cachedPairwiseLegs
      const pairwiseAttempted = state.paidCalls.portraitPairwiseAttempted - pairwiseAttemptedBefore
      const pairwiseSucceeded = state.paidCalls.portraitPairwise - pairwiseSucceededBefore
      for (const outcome of pairResults) {
        if (!outcome) continue
        const alreadyRecorded = selectorComparisons(state).some(comparison =>
          [comparison.leftId, comparison.rightId].sort().join('\u0000')
            === [outcome.leftId, outcome.rightId].sort().join('\u0000'))
        if (alreadyRecorded) continue
        const comparison: PairwiseComparison = {
          leftId: outcome.leftId,
          rightId: outcome.rightId,
          leftOutcome: outcome.result.winner === 'TIE'
            ? 0.5
            : outcome.result.winner === outcome.leftId ? 1 : 0,
          weight: Math.max(1, Math.min(10, outcome.result.confidence * 4)),
          cacheKey: selectorPairwiseIdentityKey(state),
        }
        state.portraitComparisons.push(comparison)
      }
      if (!await saveState(state, config.workdir)) {
        return `${preflight}\n本地 pairwise checkpoint 写入失败；已停止，重试只补未完成的 directional leg。`
      }
      const remainingPairwiseLegs = plannedPairwiseLegs(actualPairPlan).filter(leg => {
        const [aId, bId] = [leg.leftId, leg.rightId].sort()
        return !state.cachedPortraitSelectorPairwiseLeg(
          selectorPairwiseLegKey(state, aId, bId, leg.order),
        )
      })
      if (remainingPairwiseLegs.length) {
        return `${preflight}\n${pairCircuitBreaker ? 'BLOCKED' : 'INCOMPLETE'}：计划内 pairwise 尚有 ${remainingPairwiseLegs.length} 个 directional legs 未完成；` +
          `本轮 provider 请求 ${pairwiseAttempted}，成功 ${pairwiseSucceeded}，失败 ${pairwiseAttempted - pairwiseSucceeded}；` +
          `已完成 legs 保持缓存，名单未冻结。${pairCircuitBreaker ? `\ncircuit_breaker=${pairCircuitBreaker}` : ''}\n` +
          `remaining=${remainingPairwiseLegs.slice(0, 24).map(leg =>
            `${leg.leftId}/${leg.rightId}/${leg.order}`).join(' ')}\n` +
          (pairCircuitBreaker
            ? 'next_action=fix_model_route；禁止在当前 turn 自动重试 build_selection 或 status。修复当前会话 provider/model 后，新 turn 使用同一冻结计划只补 remaining legs。'
            : 'next_action=retry_build_selection；在后续新 turn 使用同一冻结计划只补 remaining legs。')
      }

      let selected
      try {
        selected = rankPortraits(portraitRankingCandidates(state), {
          topK: target,
          comparisons: selectorComparisons(state),
          ...portraitRankPolicy(state.preference),
        })
      } catch (error) {
        await saveState(state, config.workdir)
        return `${preflight}\n` +
          `执行诊断：high planned=${refinementPlan.candidateIds.length} paid=${refined.paid} ` +
          `cached=${refined.cached} failed=0；pairwise planned=${actualPairPlan.pairs.length} ` +
          `attempted=${pairwiseAttempted} succeeded=${pairwiseSucceeded} ` +
          `completed=${pairResults.filter(Boolean).length}。\n` +
          `最终聚合失败：${error instanceof Error ? error.message : '排序失败'}`
      }
      const keep = selected.map(item => item.id)
      const selectedFamilyCount = new Set(selected.map(item => item.familyId ?? `id:${item.id}`)).size
      const familyBackfillCount = selected.length - selectedFamilyCount
      const why: Record<string, string> = {}
      const baselineScores: Record<string, number> = {}
      const personalizedScores: Record<string, number> = {}
      for (const item of selected) {
        const assessment = state.portraitScores.get(item.id)!.assessment
        const scores = state.portraitScore(item.id)!
        baselineScores[item.id] = scores.baseline!
        personalizedScores[item.id] = scores.personalized!
        why[item.id] = assessment.summary || '冻结 baseline 与切线比较均支持入选'
      }
      const selectionHash = portraitSelectionHash(state.datasetFingerprint, state.candidateScope, keep)
      if (rebuildFeedback && selectionHash === rebuildFeedback.failedSelectionHash) {
        state.portraitDraft = undefined
        state.portraitAudit = undefined
        state.proposal = undefined
        state.exportApproval = undefined
        state.portraitSelectorPairwiseCheckpoint = undefined
        await saveState(state, config.workdir)
        return `${preflight}\nBLOCKED：已消费完整 audit 反例并执行有界 high/AB-BA 重建，` +
          `但 selection_hash 仍与被推翻名单相同（${selectionHash}）。\n` +
          'next_action=fix_rebuild_loop；禁止再次审计同一名单，防止 FAIL→rebuild→同名单 的付费死循环。'
      }
      state.portraitDraft = {
        keep,
        why,
        baselineScores,
        personalizedScores,
        selectionHash,
        preference: state.preference,
        selectorIdentityKey: selectorCacheKey(state),
        selectorPairwiseIdentityKey: selectorPairwiseIdentityKey(state),
      }
      state.portraitAudit = undefined
      state.portraitRebuildFeedback = undefined
      state.proposal = undefined
      state.exportApproval = undefined
      const completedPairwiseCheckpoint = state.portraitSelectorPairwiseCheckpoint
      state.portraitSelectorPairwiseCheckpoint = undefined
      if (!await saveState(state, config.workdir)) {
        state.portraitDraft = undefined
        state.portraitSelectorPairwiseCheckpoint = completedPairwiseCheckpoint
        return `${preflight}\nINCOMPLETE：最终名单 checkpoint 写入失败；名单未冻结。\n` +
          'next_action=retry_build_selection'
      }
      return [
        preflight,
        `执行诊断：high planned=${refinementPlan.candidateIds.length} paid=${refined.paid} cached=${refined.cached} failed=0；` +
          `pairwise planned=${actualPairPlan.pairs.length} pairs/${actualPairPlan.pairs.length * 2} calls ` +
          `（hard cap ${actualPairPlan.pairCap} pairs/${actualPairPlan.bidirectionalCallCap} calls），` +
          `attempted=${pairwiseAttempted} succeeded=${pairwiseSucceeded}，` +
          `completed=${pairResults.filter(Boolean).length} pairs ` +
          `failed=${actualPairPlan.pairs.length - pairResults.filter(Boolean).length} pairs。`,
        `待选名单已冻结：精确 ${keep.length} 张；全池 low baseline + ${refinementPlan.candidateIds.length} 张 high 复核；` +
          `本轮新增双向 pairwise ${pairResults.filter(Boolean).length} 组；` +
          `覆盖 ${selectedFamilyCount} 个家族，同族重复 ${familyBackfillCount} 张（已进入独立审计）。`,
        ...selected.map(item => {
          const score = state.portraitScore(item.id)!
          return `${item.rank}. ${item.id} baseline=${score.baseline} preference=${score.adjustment >= 0 ? '+' : ''}${score.adjustment} ` +
            `personalized=${score.personalized} diversity=+${item.diversityBonus}`
        }),
        '',
        `selection_hash=${selectionHash}`,
        `这还不是最终结果：必须把 folder、candidate_scope=${state.candidateScope}、selected_ids、target、seed ` +
          '交给 independent_evaluator；只有 audit_selection PASS 才可 propose。',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'audit_selection',
    description:
      '仅供独立 evaluator 使用的 staged audit v3。Stage A 对 selected high 盲评，Stage B 对其余候选 low 盲评，' +
      'Stage C 只把独立切线/同族/固定 seed 随机 challenger 晋升 high，Stage D 最多 8 对/16 legs。' +
      '它会按 folder 自行恢复冻结候选集，不需要先调用 analyze_folder；不读取 selector 分数、比较、理由或偏好；' +
      '每次调用有硬预算，INCOMPLETE 只重试 remaining。',
    parameters: {
      folder: { type: 'string', required: true, description: '与 analyze_folder 相同的授权目录' },
      candidate_scope: { type: 'string', required: true, description: '必须与 analyze_folder 的 auto 或 people_only 完全一致' },
      selected_ids: { type: 'array', items: { type: 'string' }, required: true },
      target: { type: 'number', required: true },
      seed: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      // Prompt isolation is not an authorization boundary. Harness persists
      // these lineage fields for spawned children, while a root/main session
      // has no way to acquire them through tool arguments.
      if (!isIndependentAuditCaller(exec.agent)) {
        return 'ERROR：audit_selection 只允许独立 evaluator 子 Agent 调用；本次尚未调用视觉模型。'
      }
      if (auditInvokedAgents.has(exec.agent!)) {
        return 'BLOCKED：同一个 independent evaluator 子 Agent 只能调用 audit_selection 一次；' +
          '本次 provider 调用为 0。父 Agent 只能在后续新 turn 创建新的 evaluator 补 remaining。'
      }
      auditInvokedAgents.add(exec.agent!)
      const state = stateFor(exec)
      let route: HarnessModelRoute
      try {
        route = bindCurrentRoute(state, exec)
      } catch (error) {
        return `ERROR：${error instanceof Error ? error.message : '无法解析当前 DSH 模型路由'}；图片未发送。`
      }
      let requestedFolder: string
      try {
        requestedFolder = await requireAllowedPath(args.folder, config.allowedRoots, '照片目录')
      } catch (error) {
        return `ERROR：${error instanceof Error ? error.message : '目录未授权'}`
      }
      if (args.candidate_scope !== 'auto' && args.candidate_scope !== 'people_only') {
        return 'ERROR：candidate_scope 必须是 auto 或 people_only。'
      }

      // independent_evaluator 每次都会创建一个全新的 Agent，因此它不应依赖主 Agent
      // 的内存状态，也不需要先调用会改写 targets 的 analyze_folder。这里仅从明确传入的
      // folder/scope 重建匿名候选，再恢复同一数据集的冻结 checkpoint。
      if (!state.folder || !state.datasetFingerprint
        || requestedFolder !== state.folder
        || args.candidate_scope !== state.candidateScope) {
        const engine = engineFor(requestedFolder)
        const report = await engine.analyze(
          requestedFolder,
          undefined,
          exec.signal,
          excludedRelativePaths,
        )
        state.absorb(report, requestedFolder, undefined, args.candidate_scope)
        const restored = await loadState(state, config.workdir, requestedFolder, undefined)
        if (!restored) {
          return 'ERROR：没有找到该目录与 candidate_scope 对应的冻结选片 checkpoint。'
        }
      }

      const selectedIds = uniqueStrings(args.selected_ids)
      const target = Math.max(0, Math.floor(args.target))
      if (target <= 0 || selectedIds.length !== target) {
        return `ERROR：selected_ids 必须精确等于本次审计 target=${target}。`
      }
      if (selectedIds.some(id => {
        const candidate = state.candidates.get(id)
        return !candidate || !state.isPortraitCandidate(candidate)
      })) {
        return 'ERROR：selected_ids 含未知或非人物候选。'
      }
      if (!state.folder || !state.datasetFingerprint) {
        return 'ERROR：冻结 checkpoint 缺少目录或数据集身份；尚未调用视觉模型。'
      }
      const selectionHash = portraitSelectionHash(
        state.datasetFingerprint,
        state.candidateScope,
        selectedIds,
      )
      if (!state.portraitDraft || state.portraitDraft.selectionHash !== selectionHash) {
        return 'ERROR：名单不是 build_selection 冻结的同一份结果。'
      }
      if (state.portraitDraft.selectorIdentityKey !== selectorCacheKey(state)
        || state.portraitDraft.selectorPairwiseIdentityKey !== selectorPairwiseIdentityKey(state)) {
        return 'ERROR：当前 provider/model/protocol 与冻结名单不同；旧评分与审计缓存已失效，必须重新 evaluate/build。'
      }
      // Only keep/hash are read from the draft. Scores, reasons, preference and
      // selector comparisons are intentionally outside this execution path.
      const frozenSelectedIds = [...state.portraitDraft.keep]
      if (frozenSelectedIds.length !== target) {
        return `ERROR：冻结名单数量 ${frozenSelectedIds.length} 与本次审计 target=${target} 不一致。`
      }
      const candidateIdentities = state.portraitCandidates().map(candidate => ({
        id: candidate.id,
        family: candidate.family,
      }))
      const candidateIds = new Set(candidateIdentities.map(candidate => candidate.id))
      if (candidateIdentities.length < target || frozenSelectedIds.some(id => !candidateIds.has(id))) {
        return 'ERROR：冻结名单不属于当前候选宇宙。'
      }

      // 某个 evaluator 若错误地先调用 analyze_folder 并传了 people_target=0，不能让这个
      // 可变运行参数破坏已经冻结的审计契约。以经过 hash 校验的 frozen keep/target 为准，
      // 在任何付费调用前恢复持久目标；写失败则停止，避免产生无法续跑的付费结果。
      if (state.targets.people !== target) {
        state.targets.people = target
        if (!await saveState(state, config.workdir)) {
          return 'INCOMPLETE：无法持久化冻结审计目标；尚未调用视觉模型。\nnext_action=retry_audit'
        }
      }

      let client: PortraitVisionClient
      try {
        client = await portraitVision(state, exec)
      } catch (error) {
        return `BLOCKED：模型预检未通过，图片未发送：` +
          `${error instanceof Error ? error.message : '当前 DSH 模型不可用'}\n` +
          `route=${renderHarnessRoute(route)}\n` +
          'next_action=fix_model_route；禁止在当前 turn 再次调用 independent_evaluator、audit_selection 或 status。'
      }
      const engine = engineFor(requestedFolder, state.limit)
      const result = await runAuditV3({
        state,
        candidateIdentities,
        frozenSelectedIds,
        target,
        seed: args.seed,
        selectionHash,
        auditProviderIdentityKey: auditProviderIdentityKey(state),
        selectorIdentityKey: selectorCacheKey(state),
        selectorPairwiseIdentityKey: selectorPairwiseIdentityKey(state),
        inspectConcurrency: config.inspectConcurrency,
        engine,
        client,
        persist: () => saveState(state, config.workdir),
        signal: exec.signal,
      })
      return `全链路模型：${renderHarnessRoute(route)}\n${result}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inspect',
    description:
      '旧版五维诊断工具；不要用于“选出最佳人像”的新 flow，新 flow 必须调用 evaluate_pool。' +
      '它让视觉模型给若干张照片打五维分（瞬间/构图/主体/光线/叙事），0–100，会花钱。' +
      'detail=low 用 512px 便宜地粗筛，high 用 1536px 精看——只在切线附近用 high。' +
      '同一张同档位已经打过分会直接命中缓存，不再计费。',
    parameters: {
      photo_ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要打分的匿名照片 ID',
      },
      detail: { type: 'string', description: 'low（默认，便宜）或 high（贵，看细节）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const detail: 'low' | 'high' = args.detail === 'high' ? 'high' : 'low'
      const ids = args.photo_ids.slice(0, config.maxInspectBatch)
      if (!state.folder) return '先运行 analyze_folder。'
      let client: VisionClient
      try {
        client = await vision(state, exec)
      } catch (error) {
        return `模型预检未通过，图片未发送：` +
          `${error instanceof Error ? error.message : '当前 DSH 模型不可用'}`
      }
      const engine = engineFor(state.folder, state.limit)

      // 未知 ID 与缓存命中都不必联网，先在本地筛掉；剩下的才值得占一条并发。
      const unknown = ids.filter((id) => !state.candidates.has(id))
      const known = ids.filter((id) => state.candidates.has(id))
      const cachedIds = known.filter((id) => state.cached(id, detail))
      const pending = known.filter((id) => !state.cached(id, detail))
      state.paidCalls.cached += cachedIds.length

      // 这些请求彼此独立，串行等于把等待时间叠加（实测 8 张 37 秒）。
      const scored = await mapWithConcurrency(
        pending,
        config.inspectConcurrency,
        async (id) => {
          try {
            const preview = await engine.preview(id, detail, exec.signal)
            const candidate = state.candidates.get(id)
            const category = candidate ? state.effectiveCategory(candidate) : 'scenery'
            const score = await client.score(id, preview.jpeg_base64, detail, category, exec.signal)
            // 单线程事件循环下这两处自增没有竞态。
            state.record(score, detail)
            state.paidCalls.inspect += 1
            return { id, ok: true as const }
          } catch (error) {
            return {
              id,
              ok: false as const,
              message: error instanceof Error ? error.message : String(error),
            }
          }
        },
      )
      const failure = new Map(scored.filter((r) => !r.ok).map((r) => [r.id, r.message!]))

      // 输出顺序跟随模型给的顺序，不跟随完成顺序。
      const lines = ids.map((id) => {
        if (unknown.includes(id)) {
          return `${id}  未知的照片 ID`
        }
        const message = failure.get(id)
        if (message) return `${id}  打分失败：${message}`
        const stored = state.scores.get(id)
        if (!stored) return `${id}  没有分数`
        const d = stored.dimensions
        const suffix = cachedIds.includes(id) ? '（缓存，未计费）' : ''
        return `${id}  总分 ${weightedTotal(d)} ` +
          `[瞬${d.moment} 构${d.composition} 主${d.subject} 光${d.lighting} 叙${d.storytelling}]` +
          `${suffix}  ${stored.summary}`
      })
      if (unknown.length) {
        lines.push('', `⚠ ${unknown.length} 个 ID 不存在。用 list_candidates 取真实 ID，不要自己编。`)
      }
      await saveState(state, config.workdir)
      return [...lines, '', state.render()].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'compare',
    description:
      '旧版人工编排比较；新 flow 由 build_selection 自动做双向 pairwise。' +
      '把同一个连拍组里的几张摆在一起直接比较，选出最好的一张。这一步会花钱但很便宜（用低档图）。' +
      '连拍之间的差别在表情、眼神、手的位置——绝对打分给不出这种区分度，比较可以。',
    parameters: {
      photo_ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '同一连拍组内的 2–4 张照片 ID',
      },
      question: { type: 'string', description: '你想比较什么，例如「谁的表情更自然」' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const ids = args.photo_ids.slice(0, 4)
      if (ids.length < 2) return '至少需要两张照片才能比较。'
      if (!state.folder) return '先运行 analyze_folder。'
      let client: VisionClient
      try {
        client = await vision(state, exec)
      } catch (error) {
        return `模型预检未通过，图片未发送：` +
          `${error instanceof Error ? error.message : '当前 DSH 模型不可用'}`
      }
      const engine = engineFor(state.folder, state.limit)
      const jpegs: string[] = []
      for (const id of ids) {
        const preview = await engine.preview(id, 'low', exec.signal)
        jpegs.push(preview.jpeg_base64)
      }
      const verdict = await client.compare(
        ids,
        jpegs,
        args.question ?? '哪一张最值得留下？',
        exec.signal,
      )
      state.paidCalls.compare += 1
      // 比较的产物只进上下文，不写进分数库——否则会污染绝对分的可复现性。
      state.comparisons.push({ ids, winner: verdict.winner, reason: verdict.reason })
      await saveState(state, config.workdir)
      return `胜者 ${verdict.winner}：${verdict.reason}\n顺序：${verdict.order.join(' > ')}\n` +
        `（比较结论不计入分数，只用来定连拍组的代表）`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_family',
    description:
      '旧版连拍折叠工具；新 flow 不需要调用，它会评估完整家族并自动去重。' +
      '为一个连拍组定下代表，同组其余照片退出旧版候选。',
    parameters: {
      family: { type: 'string', required: true, description: '连拍组 ID，例如 F03' },
      winner: { type: 'string', required: true, description: '留下的那一张' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      const family = state.families.get(args.family)
      if (!family) return `没有这个连拍组：${args.family}`
      if (!family.members.includes(args.winner)) {
        return `${args.winner} 不属于 ${args.family}（成员：${family.members.join(' ')}）`
      }
      state.championByFamily.set(args.family, args.winner)
      await saveState(state, config.workdir)
      const dropped = family.members.filter((m) => m !== args.winner)
      return `${args.family} 的代表定为 ${args.winner}，${dropped.length} 张同组照片退出候选：${dropped.join(' ')}\n\n${state.render()}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'propose',
    description:
      '冻结最终名单。人物选择必须逐项等于 build_selection 的 exact-K 结果，且同一 selection_hash 已由独立 evaluator PASS；' +
      '主 Agent 无法手填替换或伪造审计。',
    parameters: {
      keep: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '最终保留的照片 ID',
      },
      why: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '与 keep 一一对应的理由，顺序相同',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean' }, message: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      try {
        bindCurrentRoute(state, exec)
      } catch (error) {
        return {
          accepted: false,
          message: `提议未通过校验：${error instanceof Error ? error.message : '无法解析当前 DSH 模型路由'}`,
        }
      }
      // 独立 evaluator 运行在另一个 Agent state 中，并把 PASS 写回同一数据集 checkpoint。
      // 提议前重新载入，确保主 Agent 不能凭上下文声称审计通过。
      if (state.folder) await loadState(state, config.workdir, state.folder, state.limit)
      if (state.portraitDraft?.selectorIdentityKey !== selectorCacheKey(state)
        || state.portraitDraft?.selectorPairwiseIdentityKey !== selectorPairwiseIdentityKey(state)) {
        return { accepted: false, message: '提议未通过校验：selector rubric/prompt/provider 身份已变化，必须重新 build_selection。' }
      }
      if (state.portraitAudit?.auditProviderIdentityKey !== auditProviderIdentityKey(state)) {
        return { accepted: false, message: '提议未通过校验：独立 audit rubric/prompt/provider 身份已变化，必须重新 blind audit。' }
      }
      const verdict = validateProposal(state, args.keep)
      if (!verdict.ok) {
        return { accepted: false, message: `提议未通过校验：${verdict.reason}\n请修正后重新 propose。` }
      }
      let acceptanceReceiptHash: string | undefined
      try {
        acceptanceReceiptHash = await freezeAcceptanceReceipt(state, exec)
      } catch (error) {
        return {
          accepted: false,
          message: '最终名单已通过质量校验，但验收 receipt 未能耐久冻结：' +
            `${error instanceof Error ? error.message : '未知本地错误'}。\n` +
            '尚未读取 oracle；请修复后用完全相同的 keep 重新 propose。',
        }
      }
      const why: Record<string, string> = {}
      args.keep.forEach((id, offset) => {
        why[id] = state.portraitDraft?.why[id] ?? args.why[offset] ?? ''
      })
      const previousProposal = state.proposal
      const previousExportApproval = state.exportApproval
      state.proposal = { keep: args.keep, why }
      state.exportApproval = undefined
      if (!await saveState(state, config.workdir)) {
        state.proposal = previousProposal
        state.exportApproval = previousExportApproval
        return {
          accepted: false,
          message: '验收 receipt 已冻结，但最终 proposal checkpoint 写入失败；尚未读取 oracle。' +
            '请用完全相同的 keep 重试 propose。',
        }
      }

      const lines = args.keep.map((id) => {
        const candidate = state.candidates.get(id)
        const total = state.total(id)
        const effectiveCategory = candidate ? state.effectiveCategory(candidate) : 'scenery'
        const localNote = candidate && effectiveCategory !== candidate.category
          ? `（本地分类:${candidate.category === 'people' ? '人物' : '风景'}）`
          : ''
        return `  ${id}  ${effectiveCategory === 'people' ? '人物' : '风景'}${localNote}  ` +
          `${total !== undefined ? `总分 ${total}` : '（无 AI 分）'}  ${why[id]}`
      })
      return {
        accepted: true,
        message: [
          `保留名单已确定，共 ${args.keep.length} 张：`,
          ...lines,
          '',
          `花费：打分 ${state.paidCalls.inspect} 次 · 比较 ${state.paidCalls.compare} 次 · 缓存省下 ${state.paidCalls.cached} 次`,
          ...(acceptanceReceiptHash
            ? [`验收 receipt_id=${acceptanceReceiptHash}；仅本地保存，oracle 尚未读取。`]
            : ['未配置 oracle 排除子树，因此本轮不生成离线重合率 receipt。']),
          '如需导出副本，调用 export_selection。原图不会被移动、删除或修改。',
        ].join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'export_selection',
    description:
      '两阶段导出：首次只冻结名单和目标并返回确认码，用户在新消息中明确回复后才复制。' +
      '原图不移动、不删除、不改名、不写回；目标已有同名文件时拒绝覆盖。',
    parameters: {
      destination: { type: 'string', required: true, description: '导出目标目录的绝对路径' },
      confirmation_code: {
        type: 'string',
        description: '第二次调用时传入的 PF-XXXXXXXX 确认码；不能代替真实用户的新消息',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      try {
        bindCurrentRoute(state, exec)
      } catch (error) {
        return `导出被拒绝：${error instanceof Error ? error.message : '无法解析当前 DSH 模型路由'}`
      }
      if (state.folder) {
        await loadState(state, config.workdir, state.folder, state.limit)
      }
      if (!state.proposal) return '还没有确定的保留名单，先调用 propose（或先 analyze_folder 恢复上次的进度）。'
      if (!state.folder) return '先运行 analyze_folder。'
      if (state.portraitDraft?.selectorIdentityKey !== selectorCacheKey(state)
        || state.portraitDraft?.selectorPairwiseIdentityKey !== selectorPairwiseIdentityKey(state)
        || state.portraitAudit?.auditProviderIdentityKey !== auditProviderIdentityKey(state)) {
        return '导出被拒绝：selector 或独立 audit 的 rubric/prompt/provider 身份已变化，必须重新选择并完成 audit v3。'
      }
      // A proposal persisted under legacy audit v1/v2 must not bypass the v3
      // gate merely because export_selection was called in a later session.
      const verdict = validateProposal(state, state.proposal.keep)
      if (!verdict.ok) return `导出被拒绝：${verdict.reason}。必须先取得 audit v3 PASS。`
      let destination: string
      try {
        destination = await requireAllowedPath(
          args.destination,
          config.allowedExportRoots,
          '导出目录',
        )
      } catch (error) {
        return `导出被拒绝：${error instanceof Error ? error.message : '目录未授权'}`
      }
      const selectionHash = currentExportSelectionHash(state)
      if (!selectionHash) return '导出被拒绝：无法冻结当前已审计名单。'

      if (typeof args.confirmation_code !== 'string' || args.confirmation_code.length === 0) {
        const matching = state.exportApproval?.selectionHash === selectionHash
          && state.exportApproval.destination === destination
          && typeof state.exportApproval.requestedAfterUserMessageId === 'string'
        if (!matching) {
          const requestMessage = latestGenuineUserMessage(exec.agent)
          if (!requestMessage) {
            state.exportApproval = undefined
            return '导出尚未执行：无法验证本次导出由真实用户消息发起。本次复制 0 张。'
          }
          state.exportApproval = {
            schemaVersion: 'export-approval-v1',
            selectionHash,
            destination,
            confirmationCode: newExportConfirmationCode(),
            requestedAfterUserMessageId: requestMessage.id,
          }
          if (!await saveState(state, config.workdir)) {
            state.exportApproval = undefined
            return '导出尚未执行：无法持久化确认凭证，请重试。'
          }
        }
        return `导出尚未执行，本次复制 0 张。名单与授权目标已冻结。\n` +
          `请用户在一条新消息中单独回复：确认导出 ${state.exportApproval!.confirmationCode}`
      }

      const approval = state.exportApproval
      if (!exportApprovalMatches(approval, selectionHash, destination, args.confirmation_code)) {
        return '导出被拒绝：确认码不存在、不匹配，或名单/目标目录已变更。本次复制 0 张。'
      }
      // TypeScript cannot infer `approval` through the structural helper.
      if (!approval) return '导出被拒绝：未找到持久化确认凭证。本次复制 0 张。'
      if (!hasGenuineExportConfirmation(
        exec.agent,
        approval.confirmationCode,
        approval.requestedAfterUserMessageId,
      )) {
        return `导出被拒绝：尚未在发码后收到真实用户的新消息“确认导出 ${approval.confirmationCode}”。` +
          '本次复制 0 张。'
      }

      // Consume before the side effect. A crash or copy failure can require a
      // new code, but can never leave a reusable authorization behind.
      state.exportApproval = undefined
      if (!await saveState(state, config.workdir)) {
        state.exportApproval = approval
        return '导出尚未执行：无法持久化一次性确认码的消费状态。本次复制 0 张。'
      }
      const engine = engineFor(state.folder, state.limit)
      const result = await engine.export(state.proposal.keep, destination, exec.signal)
      // 原始文件名不进入模型上下文；用户可直接在目标目录看到。匿名 ID 足够让
      // Agent 对账，也避免最终一步把之前一直隐藏的路径映射泄进会话历史。
      return `已复制 ${result.count} 张到授权目标目录：\n` +
        result.copied.map((c) => `  ${c.id}`).join('\n') +
        '\n原始文件名未写入 Agent 对话；原图未被移动、删除或修改。'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'local_fallback_selection',
    description:
      '不联网、不花钱的确定性选片：按本地技术指标（清晰度/宽容度/过曝）加连拍组去重排出名次。' +
      '只用于诊断或预览，不能通过“最佳人像”最终校验。注意：技术指标与人的口味相关性很弱。',
    parameters: {
      people: { type: 'number', description: '人物保留几张' },
      scenery: { type: 'number', description: '风景保留几张' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const state = stateFor(exec)
      if (!state.folder) return '先运行 analyze_folder。'
      const engine = engineFor(state.folder, state.limit)
      const report = await engine.select(
        state.folder,
        args.people ?? state.targets.people,
        args.scenery ?? state.targets.scenery,
        state.limit,
        exec.signal,
        excludedRelativePaths,
      )
      state.proposal = {
        keep: report.keep,
        why: Object.fromEntries(report.keep.map((id) => [id, '本地技术指标排名靠前'])),
      }
      state.exportApproval = undefined
      await saveState(state, config.workdir)
      const describe = (label: string, block: typeof report.people) =>
        `${label}：${block.selected_scores.map((s) => `${s.id}(${s.score})`).join(' ')}`
      return [
        `确定性选片完成（不联网，结果可复现）：`,
        describe('人物', report.people),
        describe('风景', report.scenery),
        '',
        '这是按技术指标排的名次，不代表审美判断。有 API Key 时应改用 inspect + compare。',
      ].join('\n')
    },
  }))
}
