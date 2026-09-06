/**
 * Dedicated DSH entry point for Photo Curator Anchor Lab (Codex).
 *
 * This acceptance-only plugin intentionally exposes no export operation. It
 * inherits the exact provider/model from each DSH request header, persists a
 * reservation before every provider dispatch, and keeps the independent audit
 * behind a fresh child Agent with exactly five visible inputs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { PhotoEngine, type AnalyzeReport, type Candidate } from './engine.ts'
import { localPortraitEligible } from './local-eligibility.ts'
import {
  HarnessVisionError,
  HarnessVisionTransport,
  harnessVisionContractProbeIdentity,
  harnessRouteIdentity,
  isHarnessVisionCircuitBreakerError,
  isHarnessVisionRejectedResponse,
  renderHarnessRoute,
  resolveStrictHarnessModelRoute,
  type HarnessModelRoute,
  type HarnessVisionContractProbe,
  type HarnessVisionServices,
} from './harness-vision.ts'
import { AnchorLabCodexRuntimeGuard } from './anchor-lab-codex-runtime-guard.ts'
import {
  AnchorLabStateCoordinator,
} from './anchor-lab-codex-state-coordinator.ts'
import {
  prepareAnchorExperimentBundle,
  createAnchorCandidateOverlapReport,
  type PreparedAnchorExperimentBundle,
} from './anchor-experiment-runtime.ts'
import {
  buildCompiledAnchorAbcManifest,
  createCompiledAnchorProfiles,
} from './anchor-experiment-contracts.ts'
import type { FrozenAnchorAbcManifest } from './anchor-experiment-manifest.ts'
import {
  AnchorExperimentState,
  AnchorExperimentStateError,
  anchorExperimentBindingFromManifest,
  anchorExperimentScoreCacheKey,
  anchorExperimentStateFile,
  loadAnchorExperimentState,
  reserveAndPersistAnchorExperimentProviderOperation,
  saveAnchorExperimentState,
  type AnchorExperimentDerivedAuthority,
  type AnchorExperimentExpectedPhase,
  type AnchorExperimentRunBinding,
  type AnchorExperimentSelectorRound,
  type ExperimentDetail,
  type ExperimentProviderOperationRequest,
} from './anchor-experiment-state.ts'
import {
  aggregateExperimentComparisons,
  createAnchorLabCandidateCatalog,
  createAnchorLabDerivedAuthority,
  createAnchorLabSelectorFeedback,
  createFrozenSelectorRound,
  type AnchorLabSelectionPolicy,
  type FrozenAnchorLabCandidateCatalog,
  type FrozenSelectorRound,
} from './anchor-experiment-authority.ts'
import {
  computeAnchorLabAudit,
  createAnchorLabAuditRecompute,
  createAnchorLabHistoricalAuditRecompute,
} from './anchor-experiment-audit-authority.ts'
import { AnchorExperimentVisionClient } from './anchor-experiment-client.ts'
import { PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH } from './portrait-anchor-rubric.ts'
import { portraitLegacyContractProbes } from './portrait-vision.ts'
import { portraitAnchorContractProbes } from './portrait-anchor-vision.ts'
import {
  PHOTO_ANCHOR_LAB_CODEX_ID,
  PHOTO_ANCHOR_LAB_CODEX_NAME,
  PHOTO_ANCHOR_LAB_CODEX_PACKAGE,
  PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX,
  assertPhotoAnchorLabCodexExperimentId,
  photoAnchorLabCodexArtifactDirectory,
} from './anchor-lab-codex-identity.ts'

export const name = PHOTO_ANCHOR_LAB_CODEX_ID
export const inject = ['tools', 'llm', 'attachments', 'subagents']

const TOOL = Object.freeze({
  activate: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}activate`,
  analyze: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}analyze_folder`,
  evaluate: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}evaluate_pool`,
  build: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}build_selection`,
  independent: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}independent_evaluator`,
  audit: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}audit_selection`,
  propose: `${PHOTO_ANCHOR_LAB_CODEX_TOOL_PREFIX}propose_selection`,
})

const MAX_COMPLETE_AUDIT_ROUNDS = 2
const PAIRWISE_PAIR_CAP = 24
const DEFAULT_AUDIT_CALL_CAP = 16
const TOOL_INPUT_KEYS = new Set(['folder', 'candidate_scope', 'selected_ids', 'target', 'seed'])

export interface Config {
  engineBinary: string
  workdir: string
  artifactRoot: string
  allowedRoots: string[]
  excludedRelativePaths: string[]
  anchorPackPath: string
  referenceSheetPath: string
  referenceSheetReceiptPath: string
  anchorOverlapReceiptPath: string
  presetSourcePath: string
  maxPaidCallsPerTurn: number
}

export const Config: z<Config> = z.object({
  engineBinary: z.string().default('photofilter'),
  workdir: z.string().default('/tmp/photo-anchor-lab-codex-v1'),
  artifactRoot: z.string().default('/tmp/photo-anchor-lab-codex-v1-artifacts'),
  allowedRoots: z.array(z.string()).default([]),
  excludedRelativePaths: z.array(z.string()).default([]),
  anchorPackPath: z.string().required(),
  referenceSheetPath: z.string().required(),
  referenceSheetReceiptPath: z.string().required(),
  anchorOverlapReceiptPath: z.string().required(),
  presetSourcePath: z.string().required(),
  maxPaidCallsPerTurn: z.number().step(1).min(1).max(64).default(16),
})

type Arm = 'A' | 'B' | 'C'
type Mode = 'diagnostic' | 'acceptance'

interface Activation {
  readonly folder: string
  readonly arm: Arm
  readonly target: number
  readonly seed: string
  readonly mode: Mode
  readonly route: HarnessModelRoute
  readonly ownerSessionId: string
}

interface ActiveRun extends Activation {
  readonly engine: PhotoEngine
  /** Original bytes frozen by analyze; every later preview must match. */
  originalContentHashes?: ReadonlyMap<string, string>
  report?: AnalyzeReport
  bundle?: PreparedAnchorExperimentBundle
  manifest?: FrozenAnchorAbcManifest
  binding?: AnchorExperimentRunBinding
  catalog?: FrozenAnchorLabCandidateCatalog
  policy?: AnchorLabSelectionPolicy
  selectorRound?: FrozenSelectorRound
  state?: AnchorExperimentState
  stateCoordinator?: AnchorLabStateCoordinator
}

interface CodexAuditDelegation {
  readonly technicalId: typeof PHOTO_ANCHOR_LAB_CODEX_ID
  readonly stateNamespaceHash: string
  readonly selectionHash: string
  readonly parentSessionId: string
  readonly route: HarnessModelRoute
  readonly routeIdentity: string
}

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    photoAnchorLabCodexAudit?: CodexAuditDelegation
  }
}

class AnchorLabToolStop extends Error {
  readonly publicText: string

  constructor(publicText: string) {
    super(publicText)
    this.name = 'AnchorLabToolStop'
    this.publicText = publicText
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]))
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

function normalizeExcludedRelativePaths(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const raw of values) {
    if (!nonEmpty(raw) || isAbsolute(raw)) {
      throw new TypeError('excludedRelativePaths 只能包含非空相对路径。')
    }
    const components = raw.split('/')
    if (components.includes('..')) throw new TypeError('excludedRelativePaths 不能包含 ..。')
    const value = components.filter(component => component && component !== '.').join('/')
    if (!value) throw new TypeError('excludedRelativePaths 不能指向照片根目录。')
    normalized.add(value)
  }
  return Object.freeze([...normalized].sort())
}

async function requireAllowedPath(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path) || !roots.length) throw new Error('照片目录尚未获得绝对路径授权。')
  const resolved = await realpath(path)
  for (const root of roots) {
    let allowed: string
    try {
      allowed = await realpath(root)
    } catch {
      continue
    }
    const remainder = relative(allowed, resolved)
    if (remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder))) return resolved
  }
  throw new Error('照片目录不在已授权范围内。')
}

function candidateRows(report: AnalyzeReport): readonly Candidate[] {
  return Object.freeze([...report.candidates].sort((left, right) => left.id.localeCompare(right.id)))
}

function phaseFromState(state: AnchorExperimentState): AnchorExperimentExpectedPhase {
  return state.audit ? 'audit' : state.draft ? 'selection' : state.pairwiseCheckpoint ? 'pairwise'
    : state.refinementCheckpoint ? 'refinement' : 'baseline'
}

function assertFrozen(run: ActiveRun): asserts run is ActiveRun & Required<Pick<
  ActiveRun,
  'report' | 'originalContentHashes' | 'bundle' | 'manifest' | 'binding' | 'catalog' | 'policy'
  | 'selectorRound'
>> {
  if (!run.report || !run.originalContentHashes || !run.bundle || !run.manifest || !run.binding || !run.catalog
    || !run.policy || !run.selectorRound) {
    throw new AnchorLabToolStop(`BLOCKED：请先调用 ${TOOL.analyze} 完成本地冻结。`)
  }
}

function assertAnalyzed(run: ActiveRun): asserts run is ActiveRun & Required<Pick<
  ActiveRun,
  'report' | 'originalContentHashes' | 'bundle' | 'manifest' | 'binding' | 'catalog' | 'policy'
  | 'selectorRound' | 'state' | 'stateCoordinator'
>> {
  assertFrozen(run)
  if (!run.state || !run.stateCoordinator) {
    throw new AnchorLabToolStop(`BLOCKED：${TOOL.analyze} 尚未安全加载实验 checkpoint。`)
  }
}

function expectedOriginalSHA256(run: ActiveRun, id: string): string {
  assertAnalyzed(run)
  const value = run.originalContentHashes.get(id)
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AnchorLabToolStop(`BLOCKED：${id} 没有 analyze 阶段冻结的原图内容身份。`)
  }
  return value
}

function assertExactAuditInputs(args: Record<string, unknown>): void {
  const extras = Object.keys(args).filter(key => !TOOL_INPUT_KEYS.has(key))
  if (extras.length) throw new Error(`独立审计只接受五项输入；拒绝：${extras.sort().join(',')}`)
}

function pairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join('\u0000')
}

async function computeSourceSnapshotHash(
  presetSourcePath: string,
  engineBinaryPath: string,
): Promise<string> {
  const sourceNames = [
    'anchor-lab-codex-plugin.ts',
    'anchor-lab-codex-runtime-guard.ts',
    'anchor-lab-codex-state-coordinator.ts',
    'anchor-lab-codex-identity.ts',
    'anchor-experiment-authority.ts',
    'anchor-experiment-audit-authority.ts',
    'anchor-experiment-client.ts',
    'anchor-experiment-contracts.ts',
    'anchor-experiment-manifest.ts',
    'anchor-experiment-runtime.ts',
    'anchor-experiment-state.ts',
    'evaluation-profile.ts',
    'harness-vision.ts',
    'portrait-anchor-rubric.ts',
    'portrait-anchor-vision.ts',
    'ranking.ts',
    'selection-budget.ts',
  ]
  const base = new URL('./', import.meta.url)
  const parts: Array<string | Uint8Array> = []
  for (const sourceName of sourceNames) {
    parts.push(sourceName, await readFile(new URL(sourceName, base)))
  }
  parts.push('rendered-preset', await readFile(await realpath(presetSourcePath)))
  parts.push('engine-binary', await readFile(await realpath(engineBinaryPath)))
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

async function loadBundle(config: Config): Promise<PreparedAnchorExperimentBundle> {
  const [anchorPackBytes, anchorSheetJpeg, receiptBytes, overlapBytes] = await Promise.all([
    readFile(await realpath(config.anchorPackPath)),
    readFile(await realpath(config.referenceSheetPath)),
    readFile(await realpath(config.referenceSheetReceiptPath)),
    readFile(await realpath(config.anchorOverlapReceiptPath)),
  ])
  let receipt: unknown
  let overlap: unknown
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'))
    overlap = JSON.parse(overlapBytes.toString('utf8'))
  } catch {
    throw new Error('锚点质量或内容身份收据不是有效 JSON。')
  }
  const overlapRow = overlap as {
    protocolVersion?: unknown
    anchorPackHash?: unknown
    orderedAnchorOriginalContentHashes?: unknown
  }
  if (overlapRow.protocolVersion !== 'anchor-candidate-overlap/v1'
    || !Array.isArray(overlapRow.orderedAnchorOriginalContentHashes)) {
    throw new Error('锚点原图内容身份收据不完整。')
  }
  const bundle = prepareAnchorExperimentBundle({
    anchorPackBytes,
    anchorSheetJpeg,
    referenceSheetQualityReceipt: receipt,
    orderedAnchorOriginalContentHashes: overlapRow.orderedAnchorOriginalContentHashes as string[],
  })
  if (overlapRow.anchorPackHash !== bundle.packHash) {
    throw new Error('锚点原图内容身份没有绑定当前 pack。')
  }
  return bundle
}

function toolOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function renderFailure(error: unknown): string {
  if (error instanceof AnchorLabToolStop) return error.publicText
  if (isHarnessVisionCircuitBreakerError(error)) {
    const value = error as { code?: unknown; status?: unknown; message?: unknown }
    return `BLOCKED：circuit_breaker；code=${String(value.code ?? 'unknown')} ` +
      `status=${String(value.status ?? 'unknown')}；${String(value.message ?? '模型路由失败')}；` +
      '本 turn 不重试，未切换 provider/model。'
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? 'unknown') : 'unknown'
  const message = error instanceof Error ? error.message : String(error)
  return `BLOCKED：${code}；${message}`
}

export function apply(ctx: Context, config: Config): void {
  const excludedRelativePaths = normalizeExcludedRelativePaths(config.excludedRelativePaths)
  const allowedToolNames = new Set<string>(Object.values(TOOL))
  const turnGuard = new AnchorLabCodexRuntimeGuard()
  ctx.tools.guard(exec => allowedToolNames.has(exec.name)
    ? undefined
    : `${PHOTO_ANCHOR_LAB_CODEX_NAME} 只允许执行独立命名的验收工具。`)

  const runs = new WeakMap<object, ActiveRun>()
  const headlessOwner = {}
  let headlessRun: ActiveRun | undefined
  const runsByNamespace = new Map<string, ActiveRun>()
  const auditInvokedAgents = new WeakSet<object>()
  const preflightByOwner = new WeakMap<object, Map<string, Promise<HarnessVisionTransport>>>()

  ctx.on('agent/request-error', ({ agent, turn, failure }, next) =>
    turnGuard.handleRequestError(agent, turn, failure, next), true)

  function renderPaidToolFailure(exec: ToolRunContext, error: unknown): string {
    try {
      turnGuard.tripExecutionIfCircuit(exec, error)
    } catch (guardError) {
      return renderFailure(guardError)
    }
    return renderFailure(error)
  }

  function runFor(exec: { agent?: object }): ActiveRun | undefined {
    return exec.agent ? runs.get(exec.agent) : headlessRun
  }

  function setRun(exec: { agent?: object }, run: ActiveRun): void {
    if (exec.agent) runs.set(exec.agent, run)
    else headlessRun = run
  }

  function visionServices(): HarnessVisionServices {
    const llm = ctx.get('llm') as unknown as HarnessVisionServices['llm']
    const attachments = ctx.get('attachments') as unknown as HarnessVisionServices['attachments']
    return {
      ...(llm ? { llm } : {}),
      ...(attachments ? { attachments } : {}),
    }
  }

  async function ensureModelReady(
    exec: ToolRunContext,
    expectedRoute?: HarnessModelRoute,
    arm?: Arm,
  ): Promise<HarnessVisionTransport> {
    if (!arm) {
      throw new HarnessVisionError('Anchor Lab 模型预检缺少 arm；图片请求已阻止。', {
        code: 'EXPERIMENT_PREFLIGHT_ARM_REQUIRED',
      })
    }
    const route = resolveStrictHarnessModelRoute(exec)
    if (expectedRoute && harnessRouteIdentity(route) !== harnessRouteIdentity(expectedRoute)) {
      throw new HarnessVisionError(
        `当前 request route ${renderHarnessRoute(route)} 与冻结实验路由 ` +
        `${renderHarnessRoute(expectedRoute)} 不一致。`,
        { code: 'EXPERIMENT_ROUTE_CHANGED' },
      )
    }
    const owner = exec.agent ?? headlessOwner
    let rows = preflightByOwner.get(owner)
    if (!rows) {
      rows = new Map()
      preflightByOwner.set(owner, rows)
    }
    const probes: readonly HarnessVisionContractProbe[] = arm === 'A'
      ? portraitLegacyContractProbes()
      : portraitAnchorContractProbes()
    const key = `${harnessRouteIdentity(route)}\u0000${sha256(harnessVisionContractProbeIdentity(probes))}`
    let pending = rows.get(key)
    if (!pending) {
      const transport = new HarnessVisionTransport(
        visionServices(), route, exec.agent?.session?.id,
      )
      pending = (async () => {
        // Resolve every local capability before spending the monotonic turn
        // slot. `preflight` repeats this check immediately before its dynamic
        // text-only adapter probe, without ever attaching a photo.
        await transport.assertLocalCapabilities(exec.signal)
        await transport.preflight(exec.signal, probes, () => {
          turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
        })
        return transport
      })()
      rows.set(key, pending)
      pending.catch(() => rows!.delete(key))
    }
    return pending
  }

  function authorityFor(
    run: ActiveRun,
    requestedPhase?: AnchorExperimentExpectedPhase,
    requestedAuditRound?: number,
  ): AnchorExperimentDerivedAuthority {
    assertFrozen(run)
    const phase = requestedPhase ?? (run.state ? phaseFromState(run.state) : 'baseline')
    const auditRound = requestedAuditRound ?? (phase === 'audit'
      ? run.state?.audit?.round ?? run.selectorRound.round
      : undefined)
    return createAnchorLabDerivedAuthority({
      binding: run.binding,
      candidateCatalog: run.catalog,
      selectionPolicy: run.policy,
      selectorRound: run.selectorRound,
      expectedPersistedPhase: phase,
      ...(phase === 'audit' && auditRound !== undefined ? { expectedAuditRound: auditRound } : {}),
      recomputeAudit: createAnchorLabAuditRecompute({ binding: run.binding, catalog: run.catalog }),
      recomputeHistoricalAudit: createAnchorLabHistoricalAuditRecompute({
        binding: run.binding, catalog: run.catalog,
      }),
    })
  }

  async function saveRun(run: ActiveRun, authority = authorityFor(run)): Promise<void> {
    assertAnalyzed(run)
    const persisted = await run.stateCoordinator.transact(() => saveAnchorExperimentState({
      state: run.state,
      workdir: config.workdir,
      folder: run.folder,
      authority,
    }))
    if (!persisted) {
      throw new AnchorLabToolStop('BLOCKED：实验 checkpoint 未可靠落盘；禁止继续付费请求。')
    }
  }

  async function reserveProviderOperation(
    run: ActiveRun,
    operation: ExperimentProviderOperationRequest,
    authority: AnchorExperimentDerivedAuthority,
  ): Promise<'dispatch' | 'cached' | 'blocked_unknown'> {
    assertAnalyzed(run)
    return run.stateCoordinator.transact(() =>
      reserveAndPersistAnchorExperimentProviderOperation({
        state: run.state,
        operation,
        workdir: config.workdir,
        folder: run.folder,
        authority,
      }))
  }

  async function peekState(
    binding: AnchorExperimentRunBinding,
    folder: string,
  ): Promise<Readonly<{
    selectorRound?: AnchorExperimentSelectorRound
    phase: AnchorExperimentExpectedPhase
    auditRound?: number
  }> | undefined> {
    const file = anchorExperimentStateFile(config.workdir, folder, undefined, binding)
    let parsed: any
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new AnchorExperimentStateError(
        'PERSISTED_EXPERIMENT_STATE_CORRUPT',
        '无法读取状态轮次提示；恢复已阻止。',
      )
    }
    const phase: AnchorExperimentExpectedPhase = parsed.audit ? 'audit'
      : parsed.draft ? 'selection' : parsed.pairwiseCheckpoint ? 'pairwise'
        : parsed.refinementCheckpoint ? 'refinement' : 'baseline'
    return Object.freeze({
      selectorRound: parsed.selectorRound,
      phase,
      ...(phase === 'audit' ? { auditRound: parsed.audit?.round } : {}),
    })
  }

  async function visionClient(
    run: ActiveRun,
    exec: ToolRunContext,
  ): Promise<AnchorExperimentVisionClient> {
    assertAnalyzed(run)
    const transport = await ensureModelReady(exec, run.route, run.arm)
    const profiles = createCompiledAnchorProfiles(run.bundle.packHash)
    return new AnchorExperimentVisionClient({
      binding: run.binding,
      profile: profiles[run.arm],
      transport,
      ...(run.arm === 'C'
        ? {
            visualRuntime: run.bundle.visualRuntime,
            pairSheetEngine: {
              candidatePairSheet: (firstId, secondId, firstFocus, secondFocus, signal) =>
                run.engine.candidatePairSheet(
                  firstId,
                  secondId,
                  firstFocus,
                  secondFocus,
                  expectedOriginalSHA256(run, firstId),
                  expectedOriginalSHA256(run, secondId),
                  signal,
                ),
            },
          }
        : {}),
    })
  }

  async function reserveSelectorScore(
    run: ActiveRun,
    exec: ToolRunContext,
    id: string,
    detail: ExperimentDetail,
    client: AnchorExperimentVisionClient,
  ): Promise<'cached' | 'paid'> {
    assertAnalyzed(run)
    if (run.state.cachedScore('selector', id, detail)) return 'cached'
    const preview = await run.engine.preview(
      id,
      detail === 'low' ? 'low' : 'high',
      exec.signal,
      expectedOriginalSHA256(run, id),
    )
    const cacheKey = anchorExperimentScoreCacheKey({
      binding: run.binding, role: 'selector', id, detail,
    })
    const authority = authorityFor(run)
    const reservation = await reserveProviderOperation(
      run,
      { cacheKey, role: 'selector', kind: 'score', detail, candidateId: id },
      authority,
    )
    if (reservation === 'cached') return 'cached'
    if (reservation === 'blocked_unknown') {
      throw new AnchorLabToolStop(`BLOCKED：${id}/${detail} 存在未知付费操作；禁止重复发送。`)
    }
    turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
    try {
      const assessment = await client.scoreBaseline({
        id, jpegBase64: preview.jpeg_base64, detail, role: 'selector',
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      run.state.recordScore(assessment)
      run.state.markProviderOperationSucceeded(cacheKey)
      await saveRun(run, authorityFor(run))
      return 'paid'
    } catch (error) {
      if (isHarnessVisionCircuitBreakerError(error) || isHarnessVisionRejectedResponse(error)) {
        run.state.markProviderOperationFailed(cacheKey, String((error as { code?: unknown }).code ?? 'circuit_breaker'))
        await saveRun(run, authorityFor(run))
      } else {
        // The request may have reached the provider. Keep it reserved so a
        // ambiguous response cannot silently be purchased again. A terminal
        // rejected response above has a durable, bounded repair allowance.
        await saveRun(run, authorityFor(run))
      }
      throw error
    }
  }

  async function reserveSelectorPair(
    run: ActiveRun,
    exec: ToolRunContext,
    record: Readonly<{ leftId: string; rightId: string; order: 'AB' | 'BA' }>,
    client: AnchorExperimentVisionClient,
    previewCache: Map<string, string>,
  ): Promise<'cached' | 'paid'> {
    assertAnalyzed(run)
    const getPreview = async (id: string) => {
      const cached = previewCache.get(id)
      if (cached) return cached
      const preview = await run.engine.preview(
        id, 'high', exec.signal, expectedOriginalSHA256(run, id),
      )
      previewCache.set(id, preview.jpeg_base64)
      return preview.jpeg_base64
    }
    const prepared = await client.preparePairLeg({
      aId: record.leftId,
      aJpegBase64: await getPreview(record.leftId),
      bId: record.rightId,
      bJpegBase64: await getPreview(record.rightId),
      order: record.order,
      role: 'selector',
      ...(run.arm === 'C' && run.state.cachedScore('selector', record.leftId, 'high')
        ? { aHighAssessment: run.state.cachedScore('selector', record.leftId, 'high')! }
        : {}),
      ...(run.arm === 'C' && run.state.cachedScore('selector', record.rightId, 'high')
        ? { bHighAssessment: run.state.cachedScore('selector', record.rightId, 'high')! }
        : {}),
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (run.state.pairwiseEntries('selector').some(([key]) => key === prepared.cacheKey)) return 'cached'
    const authority = authorityFor(run)
    const reservation = await reserveProviderOperation(
      run,
      {
        cacheKey: prepared.cacheKey,
        role: 'selector',
        kind: 'pairwise',
        aId: prepared.aId,
        bId: prepared.bId,
        order: prepared.order,
        ...(prepared.pairCandidateReceiptHash
          ? { pairCandidateReceiptHash: prepared.pairCandidateReceiptHash }
          : {}),
      },
      authority,
    )
    if (reservation === 'cached') return 'cached'
    if (reservation === 'blocked_unknown') {
      throw new AnchorLabToolStop('BLOCKED：selector pairwise 存在未知付费操作；禁止重复发送。')
    }
    turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
    try {
      const result = await client.invokePreparedPairLeg(prepared)
      run.state.recordPairwiseLeg(result)
      run.state.markProviderOperationSucceeded(prepared.cacheKey)
      await saveRun(run, authorityFor(run))
      return 'paid'
    } catch (error) {
      if (isHarnessVisionCircuitBreakerError(error) || isHarnessVisionRejectedResponse(error)) {
        run.state.markProviderOperationFailed(
          prepared.cacheKey, String((error as { code?: unknown }).code ?? 'circuit_breaker'),
        )
      }
      await saveRun(run, authorityFor(run))
      throw error
    }
  }

  function currentAudit(run: ActiveRun) {
    assertAnalyzed(run)
    if (!run.state.draft) throw new AnchorLabToolStop('BLOCKED：尚未形成 exact-K draft。')
    return computeAnchorLabAudit({
      binding: run.binding,
      catalog: run.catalog,
      draft: run.state.draft,
      evidence: run.state.auditEvidenceView(),
      auditRound: run.selectorRound.round,
    })
  }

  async function reserveAuditScore(
    run: ActiveRun,
    exec: ToolRunContext,
    id: string,
    detail: ExperimentDetail,
    client: AnchorExperimentVisionClient,
  ): Promise<'cached' | 'paid'> {
    assertAnalyzed(run)
    if (run.state.cachedScore('audit', id, detail)) return 'cached'
    const preview = await run.engine.preview(
      id,
      detail === 'low' ? 'low' : 'high',
      exec.signal,
      expectedOriginalSHA256(run, id),
    )
    run.state.audit = currentAudit(run).report
    const cacheKey = anchorExperimentScoreCacheKey({
      binding: run.binding, role: 'audit', id, detail,
    })
    const authority = authorityFor(run, 'audit', run.selectorRound.round)
    const reservation = await reserveProviderOperation(
      run,
      { cacheKey, role: 'audit', kind: 'score', detail, candidateId: id },
      authority,
    )
    if (reservation === 'cached') return 'cached'
    if (reservation === 'blocked_unknown') {
      throw new AnchorLabToolStop(`BLOCKED：audit ${id}/${detail} 存在未知付费操作；禁止重复发送。`)
    }
    turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
    try {
      const assessment = await client.scoreBaseline({
        id, jpegBase64: preview.jpeg_base64, detail, role: 'audit',
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      run.state.recordScore(assessment)
      run.state.markProviderOperationSucceeded(cacheKey)
      run.state.audit = currentAudit(run).report
      await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
      return 'paid'
    } catch (error) {
      if (isHarnessVisionCircuitBreakerError(error) || isHarnessVisionRejectedResponse(error)) {
        run.state.markProviderOperationFailed(cacheKey, String((error as { code?: unknown }).code ?? 'circuit_breaker'))
      }
      run.state.audit = currentAudit(run).report
      await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
      throw error
    }
  }

  async function reserveAuditPair(
    run: ActiveRun,
    exec: ToolRunContext,
    pair: Readonly<{ aId: string; bId: string }>,
    order: 'AB' | 'BA',
    client: AnchorExperimentVisionClient,
    previewCache: Map<string, string>,
  ): Promise<'cached' | 'paid'> {
    assertAnalyzed(run)
    const getPreview = async (id: string) => {
      const cached = previewCache.get(id)
      if (cached) return cached
      const preview = await run.engine.preview(
        id, 'high', exec.signal, expectedOriginalSHA256(run, id),
      )
      previewCache.set(id, preview.jpeg_base64)
      return preview.jpeg_base64
    }
    const prepared = await client.preparePairLeg({
      aId: pair.aId,
      aJpegBase64: await getPreview(pair.aId),
      bId: pair.bId,
      bJpegBase64: await getPreview(pair.bId),
      order,
      role: 'audit',
      ...(run.arm === 'C' && run.state.cachedScore('audit', pair.aId, 'high')
        ? { aHighAssessment: run.state.cachedScore('audit', pair.aId, 'high')! }
        : {}),
      ...(run.arm === 'C' && run.state.cachedScore('audit', pair.bId, 'high')
        ? { bHighAssessment: run.state.cachedScore('audit', pair.bId, 'high')! }
        : {}),
      ...(exec.signal ? { signal: exec.signal } : {}),
    })
    if (run.state.pairwiseEntries('audit').some(([key]) => key === prepared.cacheKey)) return 'cached'
    run.state.audit = currentAudit(run).report
    const authority = authorityFor(run, 'audit', run.selectorRound.round)
    const reservation = await reserveProviderOperation(
      run,
      {
        cacheKey: prepared.cacheKey,
        role: 'audit',
        kind: 'pairwise',
        aId: prepared.aId,
        bId: prepared.bId,
        order: prepared.order,
        ...(prepared.pairCandidateReceiptHash
          ? { pairCandidateReceiptHash: prepared.pairCandidateReceiptHash }
          : {}),
      },
      authority,
    )
    if (reservation === 'cached') return 'cached'
    if (reservation === 'blocked_unknown') {
      throw new AnchorLabToolStop('BLOCKED：audit pairwise 存在未知付费操作；禁止重复发送。')
    }
    turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
    try {
      const result = await client.invokePreparedPairLeg(prepared)
      run.state.recordPairwiseLeg(result)
      run.state.markProviderOperationSucceeded(prepared.cacheKey)
      run.state.audit = currentAudit(run).report
      await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
      return 'paid'
    } catch (error) {
      if (isHarnessVisionCircuitBreakerError(error) || isHarnessVisionRejectedResponse(error)) {
        run.state.markProviderOperationFailed(
          prepared.cacheKey, String((error as { code?: unknown }).code ?? 'circuit_breaker'),
        )
      }
      run.state.audit = currentAudit(run).report
      await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
      throw error
    }
  }

  function captureAuditDelegation(run: ActiveRun, agent: Agent | undefined): CodexAuditDelegation {
    assertAnalyzed(run)
    if (!agent || !run.state.draft) throw new Error('独立审计需要父 Agent 的 exact-K draft。')
    if (String(agent.session.id) !== run.ownerSessionId) {
      throw new Error('独立审计父 Agent 与实验 state owner 不一致。')
    }
    const route = resolveStrictHarnessModelRoute({ agent })
    if (harnessRouteIdentity(route) !== harnessRouteIdentity(run.route)) {
      throw new Error('父 Agent 当前 route 与冻结实验 route 不一致。')
    }
    return Object.freeze({
      technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
      stateNamespaceHash: run.binding.stateNamespaceHash,
      selectionHash: run.state.draft.selectionHash,
      parentSessionId: run.ownerSessionId,
      route,
      routeIdentity: harnessRouteIdentity(route),
    })
  }

  ctx.on('agent/request', async ({ agent }, next) => {
    const delegation = agent.options.photoAnchorLabCodexAudit
    if (!delegation) return next()
    const header = agent.session.header
    if (delegation.technicalId !== PHOTO_ANCHOR_LAB_CODEX_ID
      || delegation.routeIdentity !== harnessRouteIdentity(delegation.route)
      || header.origin !== 'subagent'
      || String(header.parentSession) !== delegation.parentSessionId
      || (header.delegationDepth ?? 0) < 1) {
      throw new Error('Anchor Lab audit route metadata 未绑定合法子 Agent。')
    }
    const proposed = await next()
    const { reasoningEffort: _discarded, ...rest } = proposed
    return Object.freeze({
      ...rest,
      provider: delegation.route.provider,
      model: delegation.route.model,
      ...(delegation.route.reasoningEffort
        ? { reasoningEffort: delegation.route.reasoningEffort as ReasoningEffortId }
        : {}),
    }) as LlmCallConfig
  }, true)

  const textOutput = {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }

  ctx.tools.register(defineTool({
    name: TOOL.activate,
    description: '冻结本轮 A/B/C arm、exact-K、seed、目录与当前 DSH request provider/model，并执行该 arm 全合同无图预检。',
    parameters: {
      folder: { type: 'string', required: true },
      arm: { type: 'string', required: true, description: 'A、B 或 C' },
      target: { type: 'number', required: true },
      seed: { type: 'string', required: true },
      mode: { type: 'string', description: 'acceptance（默认）或 diagnostic' },
    },
    output: textOutput,
    async execute(args, exec) {
      try {
        turnGuard.claimPaidTool(exec, TOOL.activate)
        const arm = args.arm as Arm
        const target = Math.floor(args.target)
        const mode = (args.mode ?? 'acceptance') as Mode
        if (!['A', 'B', 'C'].includes(arm) || !Number.isInteger(target) || target <= 0
          || !nonEmpty(args.seed) || !['acceptance', 'diagnostic'].includes(mode)) {
          throw new Error('arm/target/seed/mode 无效。')
        }
        const folder = await requireAllowedPath(args.folder, config.allowedRoots)
        const transport = await ensureModelReady(exec, undefined, arm)
        const route = transport.route
        const contractLabels = (arm === 'A'
          ? portraitLegacyContractProbes()
          : portraitAnchorContractProbes()).map(probe => probe.label)
        const ownerSessionId = String(exec.agent?.session?.id ?? '')
        if (!nonEmpty(ownerSessionId)) {
          throw new AnchorLabToolStop('BLOCKED：Anchor Lab 必须绑定真实 DSH 父会话。')
        }
        const engineKey = sha256(`${folder}\u0000${JSON.stringify(excludedRelativePaths)}`).slice(0, 16)
        const run: ActiveRun = {
          folder, arm, target, seed: args.seed, mode, route, ownerSessionId,
          engine: new PhotoEngine(config.engineBinary, join(config.workdir, 'datasets', engineKey)),
        }
        setRun(exec, run)
        return toolOutput({
          status: 'READY',
          technical_id: PHOTO_ANCHOR_LAB_CODEX_ID,
          package: PHOTO_ANCHOR_LAB_CODEX_PACKAGE,
          arm,
          target,
          seed: args.seed,
          candidate_scope: 'people_only',
          route: renderHarnessRoute(route),
          dynamic_preflight: 'PASS',
          contract_preflight: contractLabels,
          images_sent: 0,
          next: TOOL.analyze,
        })
      } catch (error) {
        return renderPaidToolFailure(exec, error)
      } finally {
        exec.concludeTurn()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL.analyze,
    description: '完整本地分析已激活目录，冻结候选/manifest/零重合/状态身份；不发送图片。',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      try {
        const run = runFor(exec)
        if (!run) throw new AnchorLabToolStop(`BLOCKED：请先调用 ${TOOL.activate}。`)
        await ensureModelReady(exec, run.route, run.arm)
        const report = await run.engine.analyze(run.folder, undefined, exec.signal, excludedRelativePaths)
        const candidates = candidateRows(report)
        if (candidates.length < run.target) throw new Error('候选总数小于 exact-K。')
        const eligibleCount = candidates.filter(localPortraitEligible).length
        if (eligibleCount < run.target) throw new Error('本地硬门控后候选不足 exact-K。')
        const contentRows = await run.engine.contentHashes(candidates.map(row => row.id), exec.signal)
        if (contentRows.length !== candidates.length
          || new Set(contentRows.map(row => row.id)).size !== candidates.length) {
          throw new Error('候选原图内容哈希覆盖不完整。')
        }
        const contentById = new Map(contentRows.map(row => [row.id, row.sha256]))
        const candidateHashes = candidates.map(row => contentById.get(row.id) ?? '')
        const bundle = await loadBundle(config)
        const overlap = createAnchorCandidateOverlapReport({
          datasetFingerprint: report.dataset_fingerprint,
          candidateOriginalContentHashes: candidateHashes,
          bundle,
        })
        if (run.mode === 'acceptance' && overlap.overlapCount !== 0) {
          throw new Error('正式验收的视觉锚点与候选池存在精确图片重合。')
        }
        const sourceSnapshotHash = await computeSourceSnapshotHash(
          config.presetSourcePath,
          config.engineBinary,
        )
        const preferenceHash = canonicalHash({
          protocol: 'photo-anchor-lab-codex-baseline-preference/v1',
          preferenceAdjustments: 'all-zero',
          diversityStrength: 0,
          diversityProtocol: 'disabled',
          familyCap: 'auto',
        })
        const experimentId = `${PHOTO_ANCHOR_LAB_CODEX_ID}:` +
          `${report.dataset_fingerprint.slice(0, 12)}-k${run.target}-${sha256(run.seed).slice(0, 8)}`
        assertPhotoAnchorLabCodexExperimentId(experimentId)
        const highCap = Math.min(candidates.length, Math.max(run.target * 3, run.target + 20))
        const manifest = buildCompiledAnchorAbcManifest({
          experimentId,
          mode: run.mode,
          sourceSnapshotHash,
          dataset: {
            fingerprint: report.dataset_fingerprint,
            candidateScope: 'people_only',
            targetK: run.target,
            seed: run.seed,
            preferenceHash,
          },
          route: run.route,
          budget: {
            highCap,
            pairwisePairCap: PAIRWISE_PAIR_CAP,
            auditCallCapPerTurn: Math.min(DEFAULT_AUDIT_CALL_CAP, config.maxPaidCallsPerTurn),
            maxCompleteAuditRounds: MAX_COMPLETE_AUDIT_ROUNDS,
          },
          visualAnchorPack: {
            packHash: bundle.packHash,
            rubricContentHash: PORTRAIT_ANCHOR_RUBRIC_CONTENT_HASH,
            orderedAssetContentMultisetHash: bundle.orderedAssetContentMultisetHash,
            anchorSheetSha256: bundle.anchorSheetSha256,
            layoutProtocolHash: bundle.layoutProtocolHash,
            referenceSheetQualityReceipt: bundle.qualityReceipt,
          },
          contentOverlapPreflight: overlap,
          visualRuntime: bundle.visualRuntime,
          oracle: {
            oracleLocked: true,
            scanExclusionPolicyHash: canonicalHash({
              protocol: 'photo-anchor-lab-codex-scan-exclusion/v1',
              excludedRelativePaths,
            }),
            unlockPolicy: 'all_arms_exact_k_and_audit_terminal',
            unlockRequiresSeparateReceipt: true,
          },
        })
        const binding = anchorExperimentBindingFromManifest(
          manifest, run.arm, run.arm === 'C' ? bundle.legendHash : undefined,
        )
        const catalog = createAnchorLabCandidateCatalog({
          binding,
          candidates: candidates.map(candidate => ({
            id: candidate.id,
            ...(candidate.family ? { familyId: candidate.family } : {}),
            diversityTags: [],
            localEligibility: localPortraitEligible(candidate) ? 'eligible' : 'ineligible',
            preferenceAdjustment: 0,
          })),
        })
        const policy: AnchorLabSelectionPolicy = Object.freeze({
          preferenceHash,
          diversityStrength: 0,
          familyCap: 'auto',
          diversityProtocol: 'disabled',
        })
        Object.assign(run, {
          report,
          originalContentHashes: new Map(contentById),
          bundle,
          manifest,
          binding,
          catalog,
          policy,
        })
        const stateCoordinator = new AnchorLabStateCoordinator({
          stateFile: anchorExperimentStateFile(config.workdir, run.folder, undefined, binding),
          stateNamespaceHash: binding.stateNamespaceHash,
          ownerSessionId: run.ownerSessionId,
        })
        await stateCoordinator.initialize()
        run.stateCoordinator = stateCoordinator
        const peek = await peekState(binding, run.folder)
        const selectorRound = (peek?.selectorRound ?? createFrozenSelectorRound({
          binding, round: 1, existingComparisons: [],
        })) as FrozenSelectorRound
        run.selectorRound = selectorRound
        const authority = authorityFor(
          run,
          peek?.phase ?? 'baseline',
          peek?.auditRound,
        )
        const restored = await loadAnchorExperimentState({
          binding,
          candidateIds: candidates.map(row => row.id),
          workdir: config.workdir,
          folder: run.folder,
          authority,
        })
        const state = restored ?? new AnchorExperimentState(binding, candidates.map(row => row.id))
        if (!restored) {
          state.setSelectorRound(selectorRound)
          run.state = state
          await saveRun(run, authorityFor(run, 'baseline'))
        } else {
          run.state = state
        }
        const resident = runsByNamespace.get(binding.stateNamespaceHash)
        if (resident && resident.ownerSessionId !== run.ownerSessionId) {
          throw new AnchorLabToolStop(
            'BLOCKED：同一实验 namespace 已被另一个 DSH 父会话加载；禁止覆盖独立审计上下文。',
          )
        }
        runsByNamespace.set(binding.stateNamespaceHash, run)
        return toolOutput({
          status: 'FROZEN',
          technical_id: PHOTO_ANCHOR_LAB_CODEX_ID,
          arm: run.arm,
          route: renderHarnessRoute(run.route),
          dataset_fingerprint: report.dataset_fingerprint,
          candidate_scope: 'people_only',
          candidate_count: candidates.length,
          local_eligible_count: eligibleCount,
          target: run.target,
          anchor_candidate_overlap: overlap.overlapCount,
          manifest_hash: manifest.manifestHash,
          source_snapshot_hash: sourceSnapshotHash,
          state_namespace_hash: binding.stateNamespaceHash,
          selector_round: selectorRound.round,
          resumed_phase: phaseFromState(state),
          images_sent: 0,
          next: TOOL.evaluate,
        })
      } catch (error) {
        return renderFailure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL.evaluate,
    description: '按冻结 arm 对完整候选池做 selector low；每 turn 有硬调用上限，只补 missing。',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      try {
        turnGuard.claimPaidTool(exec, TOOL.evaluate)
        const run = runFor(exec)
        if (!run) throw new AnchorLabToolStop(`BLOCKED：请先调用 ${TOOL.activate}。`)
        assertAnalyzed(run)
        await ensureModelReady(exec, run.route, run.arm)
        const client = await visionClient(run, exec)
        const maxCalls = turnGuard.remainingProviderDispatches(
          exec, config.maxPaidCallsPerTurn,
        )
        const ids = run.catalog.candidates.map(row => row.id)
        const initialMissing = ids.filter(id => !run.state.cachedScore('selector', id, 'low'))
        let paid = 0
        let cached = ids.length - initialMissing.length
        for (const id of initialMissing) {
          if (paid >= maxCalls) break
          const result = await reserveSelectorScore(run, exec, id, 'low', client)
          if (result === 'paid') paid += 1
          else cached += 1
        }
        const remaining = ids.filter(id => !run.state.cachedScore('selector', id, 'low'))
        if (remaining.length) {
          return toolOutput({
            status: 'INCOMPLETE',
            stage: 'selector_low',
            arm: run.arm,
            route: renderHarnessRoute(run.route),
            total: ids.length,
            completed: ids.length - remaining.length,
            paid_this_turn: paid,
            cached_this_turn: cached,
            remaining_count: remaining.length,
            remaining_ids: remaining,
            next_action: 'new_turn_same_inputs',
          })
        }
        const authority = authorityFor(run, 'refinement')
        const refinement = authority.recomputeRefinementCheckpoint!(run.state.evidenceView())
        if (!refinement) throw new Error('完整 low 后仍无法冻结 refinement plan。')
        run.state.refinementCheckpoint = refinement
        await saveRun(run, authority)
        return toolOutput({
          status: 'COMPLETE',
          stage: 'selector_low',
          arm: run.arm,
          route: renderHarnessRoute(run.route),
          total: ids.length,
          planned_high: refinement.plan.candidateIds.length,
          high_cap: refinement.plan.hardCap,
          paid_this_turn: paid,
          next: `${TOOL.build} mode=plan`,
        })
      } catch (error) {
        return renderPaidToolFailure(exec, error)
      } finally {
        exec.concludeTurn()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL.build,
    description: '冻结/执行 high 与 AB/BA 计划并形成 exact-K draft；plan 不调用模型，run 只补 missing。',
    parameters: {
      mode: { type: 'string', required: true, description: 'plan 或 run' },
    },
    output: textOutput,
    async execute(args, exec) {
      const paidMode = args.mode === 'run'
      try {
        if (paidMode) turnGuard.claimPaidTool(exec, TOOL.build)
        const run = runFor(exec)
        if (!run) throw new AnchorLabToolStop(`BLOCKED：请先调用 ${TOOL.activate}。`)
        assertAnalyzed(run)
        if (!['plan', 'run'].includes(args.mode)) throw new Error('mode 必须是 plan 或 run。')
        const liveRoute = resolveStrictHarnessModelRoute(exec)
        if (harnessRouteIdentity(liveRoute) !== harnessRouteIdentity(run.route)) {
          throw new HarnessVisionError(
            `当前 request route ${renderHarnessRoute(liveRoute)} 与冻结实验路由 ` +
              `${renderHarnessRoute(run.route)} 不一致。`,
            { code: 'EXPERIMENT_ROUTE_CHANGED' },
          )
        }
        if (paidMode) await ensureModelReady(exec, run.route, run.arm)

        if (run.state.audit?.status === 'FAIL') {
          if (run.selectorRound.round >= run.binding.budget.maxCompleteAuditRounds) {
            return toolOutput({
              status: 'BLOCKED',
              next_action: 'max_complete_audit_rounds_reached',
              audit: run.state.audit,
            })
          }
          const feedback = createAnchorLabSelectorFeedback({
            binding: run.binding,
            failedAuditRound: run.state.audit.round,
            failedSelectionHash: run.state.audit.selectionHash,
            strongerChallengerIds: run.state.audit.strongerChallengerIds,
            disqualifiedSelectedIds: run.state.audit.disqualifiedSelectedIds,
          })
          const nextRound = createFrozenSelectorRound({
            binding: run.binding,
            round: run.selectorRound.round + 1,
            existingComparisons: aggregateExperimentComparisons({
              binding: run.binding,
              legs: run.state.pairwiseEntries('selector').map(([, record]) => record),
            }),
            priorSelectionHash: run.state.audit.selectionHash,
            feedback,
          })
          run.state.setSelectorRound(nextRound)
          run.selectorRound = nextRound
          await saveRun(run, authorityFor(run, 'baseline'))
        }

        const lowMissing = run.catalog.candidates
          .filter(row => !run.state.cachedScore('selector', row.id, 'low'))
        if (lowMissing.length) {
          return toolOutput({ status: 'INCOMPLETE', stage: 'selector_low', remaining_count: lowMissing.length })
        }
        const refinementAuthority = authorityFor(run, 'refinement')
        const refinement = refinementAuthority.recomputeRefinementCheckpoint!(run.state.evidenceView())
        if (!refinement) throw new Error('无法冻结 refinement plan。')
        run.state.refinementCheckpoint = refinement
        await saveRun(run, refinementAuthority)
        const highMissing = refinement.plan.candidateIds
          .filter(id => !run.state.cachedScore('selector', id, 'high'))
        if (args.mode === 'plan') {
          return toolOutput({
            status: 'PLAN',
            selector_round: run.selectorRound.round,
            planned_high: refinement.plan.candidateIds.length,
            cached_high: refinement.plan.candidateIds.length - highMissing.length,
            missing_high: highMissing.length,
            high_cap: run.binding.budget.highCap,
            pairwise_pair_cap: run.binding.budget.pairwisePairCap,
            max_paid_calls_per_turn: config.maxPaidCallsPerTurn,
            route: renderHarnessRoute(run.route),
            next: `${TOOL.build} mode=run`,
          })
        }
        const client = await visionClient(run, exec)
        const maxCalls = turnGuard.remainingProviderDispatches(
          exec, config.maxPaidCallsPerTurn,
        )
        let paid = 0
        for (const id of highMissing) {
          if (paid >= maxCalls) break
          if (await reserveSelectorScore(run, exec, id, 'high', client) === 'paid') paid += 1
        }
        const highRemaining = refinement.plan.candidateIds
          .filter(id => !run.state.cachedScore('selector', id, 'high'))
        if (highRemaining.length) {
          return toolOutput({
            status: 'INCOMPLETE', stage: 'selector_high', paid_this_turn: paid,
            remaining_count: highRemaining.length, remaining_ids: highRemaining,
            next_action: 'new_turn_same_inputs',
          })
        }
        const pairAuthority = authorityFor(run, 'pairwise')
        const pairwise = pairAuthority.recomputePairwiseCheckpoint!(
          run.state.evidenceView(), refinement,
        )
        if (!pairwise) throw new Error('完整 high 后仍无法冻结 pairwise plan。')
        run.state.pairwiseCheckpoint = pairwise
        await saveRun(run, pairAuthority)
        const previewCache = new Map<string, string>()
        for (const pair of pairwise.plan.pairs) {
          for (const order of ['AB', 'BA'] as const) {
            if (paid >= maxCalls) break
            if (await reserveSelectorPair(run, exec, {
              leftId: pair.leftId, rightId: pair.rightId, order,
            }, client, previewCache) === 'paid') paid += 1
          }
          if (paid >= maxCalls) break
        }
        const completeComparisons = aggregateExperimentComparisons({
          binding: run.binding,
          legs: run.state.pairwiseEntries('selector').map(([, record]) => record),
        })
        const completePairs = new Set(completeComparisons.map(row => pairKey(row.aId, row.bId)))
        const pairRemaining = pairwise.plan.pairs
          .filter(pair => !completePairs.has(pairKey(pair.leftId, pair.rightId)))
        if (pairRemaining.length) {
          return toolOutput({
            status: 'INCOMPLETE', stage: 'selector_pairwise', paid_this_turn: paid,
            remaining_pairs: pairRemaining.length,
            remaining_legs_upper_bound: pairRemaining.length * 2,
            next_action: 'new_turn_same_inputs',
          })
        }
        const selectionAuthority = authorityFor(run, 'selection')
        const draft = selectionAuthority.recomputeDraft!(
          run.state.evidenceView(), refinement, pairwise,
        )
        if (!draft) throw new Error('完整 AB/BA 后仍无法形成 exact-K。')
        run.state.draft = draft
        await saveRun(run, selectionAuthority)
        return toolOutput({
          status: 'DRAFT_EXACT_K',
          selector_round: run.selectorRound.round,
          arm: run.arm,
          route: renderHarnessRoute(run.route),
          selected_ids: draft.keep,
          target: run.target,
          selection_hash: draft.selectionHash,
          paid_this_turn: paid,
          next: TOOL.independent,
          final: false,
        })
      } catch (error) {
        return paidMode ? renderPaidToolFailure(exec, error) : renderFailure(error)
      } finally {
        if (paidMode) exec.concludeTurn()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL.audit,
    description: '仅供隔离子 Agent 使用：按四阶段独立盲审 exact-K，单次有硬预算且只补 missing。',
    parameters: {
      folder: { type: 'string', required: true },
      candidate_scope: { type: 'string', required: true },
      selected_ids: { type: 'array', items: { type: 'string' }, required: true },
      target: { type: 'number', required: true },
      seed: { type: 'string', required: true },
    },
    output: textOutput,
    async execute(args, exec) {
      try {
        turnGuard.claimPaidTool(exec, TOOL.audit)
        assertExactAuditInputs(args)
        const delegation = exec.agent?.options.photoAnchorLabCodexAudit
        if (!delegation || delegation.technicalId !== PHOTO_ANCHOR_LAB_CODEX_ID) {
          throw new AnchorLabToolStop('BLOCKED：audit_selection 只允许命名独立 evaluator 子 Agent 调用。')
        }
        if (auditInvokedAgents.has(exec.agent!)) {
          throw new AnchorLabToolStop('BLOCKED：同一个 evaluator 子 Agent 只能调用 audit_selection 一次。')
        }
        auditInvokedAgents.add(exec.agent!)
        const run = runsByNamespace.get(delegation.stateNamespaceHash)
        if (!run) throw new Error('独立审计找不到同进程冻结实验。')
        assertAnalyzed(run)
        const folder = await requireAllowedPath(args.folder, config.allowedRoots)
        if (folder !== run.folder || args.candidate_scope !== 'people_only'
          || Math.floor(args.target) !== run.target || args.seed !== run.seed
          || delegation.parentSessionId !== run.ownerSessionId
          || !run.state.draft || delegation.selectionHash !== run.state.draft.selectionHash
          || !sameStrings(args.selected_ids, run.state.draft.keep)
          || harnessRouteIdentity(resolveStrictHarnessModelRoute(exec)) !== delegation.routeIdentity) {
          throw new Error('独立审计五项输入、selection 或 route 与冻结父任务不一致。')
        }
        const client = await visionClient(run, exec)
        const maxCalls = Math.min(
          turnGuard.remainingProviderDispatches(exec, config.maxPaidCallsPerTurn),
          run.binding.budget.auditCallCapPerTurn,
        )
        let paid = 0
        const previewCache = new Map<string, string>()
        while (paid < maxCalls) {
          const computation = currentAudit(run)
          run.state.audit = computation.report
          await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
          if (computation.report.status !== 'INCOMPLETE') break
          if (computation.coverage.stage === 'selected_high') {
            const id = computation.coverage.selectedHigh.missingIds[0]
            if (!id) break
            if (await reserveAuditScore(run, exec, id, 'high', client) === 'paid') paid += 1
            continue
          }
          if (computation.coverage.stage === 'remaining_low') {
            const id = computation.coverage.remainingLow.missingIds[0]
            if (!id) break
            if (await reserveAuditScore(run, exec, id, 'low', client) === 'paid') paid += 1
            continue
          }
          if (computation.coverage.stage === 'promotion_high') {
            const id = computation.coverage.promotionHigh.missingIds[0]
            if (!id) break
            if (await reserveAuditScore(run, exec, id, 'high', client) === 'paid') paid += 1
            continue
          }
          if (computation.coverage.stage === 'pairwise') {
            if (computation.coverage.unresolvedOperationKeys.length) {
              throw new AnchorLabToolStop('BLOCKED：audit 存在未知 reserved provider operation。')
            }
            let dispatched = false
            for (const pair of computation.pairPlan?.pairs ?? []) {
              const existing = new Set(run.state.pairwiseEntries('audit')
                .map(([, record]) => record)
                .filter(record => pairKey(record.aId, record.bId) === pairKey(pair.aId, pair.bId))
                .map(record => {
                  const forward = record.aId < record.bId
                  return forward ? record.order : record.order === 'AB' ? 'BA' : 'AB'
                }))
              for (const order of ['AB', 'BA'] as const) {
                if (existing.has(order)) continue
                if (await reserveAuditPair(run, exec, pair, order, client, previewCache) === 'paid') paid += 1
                dispatched = true
                break
              }
              if (dispatched) break
            }
            if (!dispatched) break
            continue
          }
          break
        }
        const final = currentAudit(run)
        run.state.audit = final.report
        await saveRun(run, authorityFor(run, 'audit', run.selectorRound.round))
        return toolOutput({
          status: final.report.status,
          stage: final.report.stage,
          selector_round: run.selectorRound.round,
          audit_round: final.report.round,
          selection_hash: final.report.selectionHash,
          selected_ids: final.report.selectedIds,
          stronger_challenger_ids: final.report.strongerChallengerIds,
          disqualified_selected_ids: final.report.disqualifiedSelectedIds,
          coverage: final.coverage,
          paid_this_turn: paid,
          route: renderHarnessRoute(run.route),
          next_action: final.report.status === 'INCOMPLETE'
            ? 'new_parent_turn_same_five_inputs'
            : final.report.status === 'FAIL'
              ? `${TOOL.build} mode=plan`
              : TOOL.propose,
        })
      } catch (error) {
        return renderPaidToolFailure(exec, error)
      } finally {
        exec.concludeTurn()
      }
    },
  }))

  function extractAuditToolOutput(run: SubagentRun): string {
    const events = run.localAgent?.session.events
    if (!events) throw new Error('无法读取隔离子 Agent 的本地轨迹。')
    const calls = events.filter(event => event.type === 'tool/call' && event.data.name === TOOL.audit)
    if (calls.length !== 1) throw new Error(`独立 evaluator 必须恰好调用一次 ${TOOL.audit}。`)
    const callId = calls[0]!.data.callId
    const blocks = events.flatMap(event => event.type === 'tool/result'
      ? event.data.message.content.filter(block => block.type === 'tool-result' && block.toolCallId === callId)
      : [])
    if (blocks.length !== 1) throw new Error('独立 evaluator 缺少唯一 audit tool result。')
    const block = blocks[0]!
    const output = block.content.filter(item => item.type === 'text').map(item => item.text).join('')
    if (block.isError || !nonEmpty(output)) throw new Error('独立 audit 原始工具结果为空或失败。')
    return output
  }

  const auditPersona = `你是 ${PHOTO_ANCHOR_LAB_CODEX_NAME} 的隔离审计子 Agent。输入只能是 folder、candidate_scope、selected_ids、target、seed。不要读取、索取或使用主 Agent 的评分、理由、排名、偏好或中间推理。恰好调用一次 ${TOOL.audit}，不得调用其他工具，不得在本子 Agent 内重试。最终只能原样概括工具返回的 PASS、FAIL、INCOMPLETE 或 BLOCKED。`

  ctx.tools.register(defineTool({
    name: TOOL.independent,
    description: '创建全新隔离子 Agent；五项可见输入固定，provider/model 从父 request header 内部继承。',
    parameters: {
      folder: { type: 'string', required: true },
      candidate_scope: { type: 'string', required: true },
      selected_ids: { type: 'array', items: { type: 'string' }, required: true },
      target: { type: 'number', required: true },
      seed: { type: 'string', required: true },
    },
    output: textOutput,
    async execute(args, exec: ToolRunContext) {
      try {
        turnGuard.claimPaidTool(exec, TOOL.independent)
        assertExactAuditInputs(args)
        const run = runFor(exec)
        if (!run) throw new Error('父 Agent 尚未激活实验。')
        assertAnalyzed(run)
        const folder = await requireAllowedPath(args.folder, config.allowedRoots)
        if (!run.state.draft || !sameStrings(args.selected_ids, run.state.draft.keep)
          || folder !== run.folder || args.candidate_scope !== 'people_only'
          || Math.floor(args.target) !== run.target || args.seed !== run.seed) {
          throw new Error('五项输入必须与当前 exact-K draft 完全一致。')
        }
        const delegation = captureAuditDelegation(run, exec.agent)
        const childOptions: AgentOptions = Object.freeze({
          provider: delegation.route.provider,
          model: delegation.route.model,
          photoAnchorLabCodexAudit: delegation,
        })
        const payload = {
          folder: run.folder,
          candidate_scope: args.candidate_scope,
          selected_ids: [...args.selected_ids],
          target: Math.floor(args.target),
          seed: args.seed,
        }
        // The child Agent's deliberation is itself a provider dispatch owned
        // by this paid parent tool. Its own audit tool has a separate child
        // turn ledger for preflight and visual calls.
        turnGuard.consumeProviderDispatch(exec, config.maxPaidCallsPerTurn)
        const child = await ctx.subagents.start('spawn', {
          label: 'Photo Anchor Lab Codex independent audit',
          prompt: [{
            type: 'text',
            text: '执行独立照片审计。以下 JSON 是唯一输入；保持原样并恰好调用一次审计工具：\n' +
              JSON.stringify(payload),
          }],
          parent: exec.agent!,
          signal: exec.signal,
          agentOptions: childOptions,
          persona: auditPersona,
          toolFilter: { allow: [TOOL.audit] },
          maxDepth: 1,
        })
        const outcome = await settleRun(child)
        if (outcome.status !== 'completed') {
          throw new Error(`独立 evaluator 未完成（${outcome.status}）${outcome.detail ? `：${outcome.detail}` : ''}`)
        }
        return extractAuditToolOutput(child)
      } catch (error) {
        return renderPaidToolFailure(exec, error)
      } finally {
        exec.concludeTurn()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL.propose,
    description: '仅在当前 round 的独立 audit PASS 后生成 exact-K 本地收据；不导出照片。',
    parameters: {},
    output: textOutput,
    async execute(_args, exec) {
      try {
        const run = runFor(exec)
        if (!run) throw new Error('尚未激活实验。')
        assertAnalyzed(run)
        await ensureModelReady(exec, run.route, run.arm)
        const draft = run.state.draft
        const audit = run.state.audit
        if (!draft || !audit || audit.status !== 'PASS'
          || audit.stage !== 'complete'
          || audit.selectionHash !== draft.selectionHash
          || audit.round !== run.selectorRound.round
          || draft.keep.length !== run.target) {
          throw new AnchorLabToolStop('BLOCKED：当前 exact-K 尚未获得同 round 独立 audit PASS。')
        }
        const receiptBody = {
          schemaVersion: 'photo-anchor-lab-codex-v1/selection-receipt/v1',
          technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
          arm: run.arm,
          manifestHash: run.manifest.manifestHash,
          stateNamespaceHash: run.binding.stateNamespaceHash,
          datasetFingerprint: run.binding.datasetFingerprint,
          route: run.binding.route,
          target: run.target,
          seed: run.seed,
          selectorRound: run.selectorRound.round,
          selectionHash: draft.selectionHash,
          selectedIds: draft.keep,
          auditStatus: audit.status,
          auditStage: audit.stage,
          auditRound: audit.round,
          exported: false,
        }
        const receipt = Object.freeze({ ...receiptBody, receiptHash: canonicalHash(receiptBody) })
        const directory = photoAnchorLabCodexArtifactDirectory(
          config.artifactRoot, run.binding.stateNamespaceHash,
        )
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const destination = join(directory, `${receipt.receiptHash}.json`)
        const serialized = JSON.stringify(receipt)
        try {
          const existing = await readFile(destination, 'utf8')
          if (existing !== serialized) throw new Error('同一 receipt hash 已存在不同内容。')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const temporary = `${destination}.tmp-${process.pid}`
          await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 })
          await rename(temporary, destination)
        }
        return toolOutput({
          status: 'PASS',
          final: true,
          exported: false,
          arm: run.arm,
          route: renderHarnessRoute(run.route),
          selected_ids: draft.keep,
          target: run.target,
          selection_hash: draft.selectionHash,
          receipt_hash: receipt.receiptHash,
          next_action: 'oracle_remains_locked_until_all_arms_terminal',
        })
      } catch (error) {
        return renderFailure(error)
      }
    },
  }))
}
