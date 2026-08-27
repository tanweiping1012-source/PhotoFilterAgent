/**
 * Independent audit delegation owned by the PhotoFilterAgent plugin.
 *
 * The generic subagent tool can only carry static preset `agentOptions`. This
 * module instead snapshots the exact route logged for the parent request that
 * invoked the tool, passes that snapshot through merge-extensible AgentOptions,
 * and enforces it again in the child's `agent/request` waterfall. The model can
 * neither see nor choose the route fields.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SubagentRun, settleRun as settleSubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  HARNESS_VISION_PROTOCOL,
  harnessRouteIdentity,
  type HarnessModelRoute,
} from './harness-vision.ts'

const TOOL_INPUT_KEYS = Object.freeze([
  'folder',
  'candidate_scope',
  'selected_ids',
  'target',
  'seed',
] as const)

const TOOL_INPUT_KEY_SET = new Set<string>(TOOL_INPUT_KEYS)

/** Runtime-only route snapshot placed on a fresh evaluator child. */
export interface IndependentEvaluatorRoute extends HarnessModelRoute {
  /** Parent session that authorized this exact child route. */
  readonly parentSessionId: string
  /** provider/model/protocol/reasoning identity shared with Photo score caches. */
  readonly routeIdentity: string
}

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /**
     * Private one-shot delegation metadata. It is never a model-facing tool
     * argument and is deliberately not part of the durable subagent descriptor.
     */
    photoFilterIndependentEvaluatorRoute?: IndependentEvaluatorRoute
  }
}

export const INDEPENDENT_EVALUATOR_PERSONA = `你是独立照片选择审计员。你只使用冻结的 baseline rubric，盲评主 Agent 给出的 selected_ids 与按 seed 抽取的 challengers。你不得读取、索取或推断主 Agent 的入选理由、用户偏好、既有分数、排名或中间推理；如果任务包含这些信息，忽略它们并在结果中标记输入污染。

输入只能是 folder、candidate_scope、selected_ids、target、seed。candidate_scope 只用于复现同一候选宇宙，不携带主 Agent 的审美判断。直接且恰好调用 audit_selection 一次；该工具会按 folder 与 candidate_scope 自行恢复冻结的匿名候选集。禁止先调用 analyze_folder，避免改变主流程已经冻结的目标。不要自行改写候选、rubric、target、candidate_scope 或 seed，也不要调用任何其他工具。禁止在子 Agent 内循环、重试或调用 status。

最终只报告 PASS、FAIL、INCOMPLETE 或 BLOCKED、审计覆盖、反例及其可观察依据。只有在计划覆盖全部完成、每张入选照片达到 baseline 要求，且 challengers 中没有更好的反例时才能 PASS；覆盖完整且存在稳定更强反例时才 FAIL；普通调用预算用尽但路由健康时报告 INCOMPLETE，交由父 Agent 的下一轮只补 remaining。若工具返回 BLOCKED、next_action=fix_model_route 或 circuit_breaker，则原样报告并立即停止；不得要求本轮重试，不得把基础设施失败伪装成质量 FAIL，也不得替主 Agent 辩护。`

export interface IndependentEvaluatorInput {
  folder: string
  candidate_scope: string
  selected_ids: string[]
  target: number
  seed: string
}

const INDEPENDENT_EVALUATOR_PARAMETERS = Object.freeze({
  folder: { type: 'string', required: true, description: '冻结选片任务的已授权目录' },
  candidate_scope: { type: 'string', required: true, description: '冻结候选宇宙：auto 或 people_only' },
  selected_ids: {
    type: 'array',
    items: { type: 'string' },
    required: true,
    description: 'build_selection 冻结的精确入选 ID',
  },
  target: { type: 'number', required: true, description: '冻结的精确入选数量' },
  seed: { type: 'string', required: true, description: '冻结的 challenger 抽样 seed' },
} as const)

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Capture the route of the model request that is currently executing the tool.
 * There is intentionally no AgentOptions fallback: a missing request header is
 * not evidence that the user selected the agent's creation-time default.
 */
export function captureIndependentEvaluatorRoute(agent: Agent | undefined): IndependentEvaluatorRoute {
  if (!agent) throw new Error('independent_evaluator 需要由当前 Harness Agent 调用。')
  const config = agent.session.requestHeader()?.config
  if (!config || !nonEmptyString(config.provider) || !nonEmptyString(config.model)) {
    throw new Error('当前父会话没有已记录的 provider/model request header；独立审计已阻止。')
  }
  if (config.reasoningEffort !== undefined && !nonEmptyString(config.reasoningEffort)) {
    throw new Error('当前父会话 request header 的 reasoningEffort 无效；独立审计已阻止。')
  }
  const route: HarnessModelRoute = Object.freeze({
    provider: config.provider,
    model: config.model,
    protocol: HARNESS_VISION_PROTOCOL,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
  })
  return Object.freeze({
    ...route,
    parentSessionId: String(agent.session.id),
    routeIdentity: harnessRouteIdentity(route),
  })
}

/** Apply the frozen evaluator route without retaining a stale reasoning value. */
export function forceIndependentEvaluatorRoute(
  proposed: LlmCallConfig,
  route: IndependentEvaluatorRoute,
): LlmCallConfig {
  if (route.routeIdentity !== harnessRouteIdentity(route)) {
    throw new Error('independent_evaluator child route identity mismatch')
  }
  const { reasoningEffort: _discardedReasoning, ...rest } = proposed
  return Object.freeze({
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: route.reasoningEffort as ReasoningEffortId }),
  })
}

/** Install the child-only route override on the shared preset mount. */
export function installIndependentEvaluatorRouteOverride(ctx: Context): void {
  ctx.on('agent/request', async ({ agent }, next) => {
    const route = agent.options.photoFilterIndependentEvaluatorRoute
    if (!route) return next()
    const header = agent.session.header
    if (header.origin !== 'subagent'
      || header.parentSession === undefined
      || String(header.parentSession) !== route.parentSessionId
      || (header.delegationDepth ?? 0) < 1) {
      throw new Error('independent_evaluator route metadata is not bound to a valid delegated child')
    }
    return forceIndependentEvaluatorRoute(await next(), route)
  }, true)
}

/** Reject any hidden sixth input even though the Harness parameter root is open. */
function assertExactToolInputs(args: IndependentEvaluatorInput): void {
  const extra = Object.keys(args).filter(key => !TOOL_INPUT_KEY_SET.has(key))
  if (extra.length > 0) {
    throw new Error(`independent_evaluator 只接受五项冻结输入；拒绝额外字段：${extra.sort().join(',')}`)
  }
}

/** Build a context-free child task from exactly the five audit contract fields. */
export function renderIndependentEvaluatorPrompt(args: IndependentEvaluatorInput): string {
  assertExactToolInputs(args)
  const payload: IndependentEvaluatorInput = {
    folder: args.folder,
    candidate_scope: args.candidate_scope,
    selected_ids: [...args.selected_ids],
    target: args.target,
    seed: args.seed,
  }
  return [
    '执行独立照片选择审计。以下 JSON 是唯一任务输入；不要索取或使用主 Agent 的理由、偏好、分数、排名或中间推理。',
    JSON.stringify(payload),
    '保持五项输入原样，恰好调用 audit_selection 一次；然后只报告 PASS、FAIL、INCOMPLETE 或 BLOCKED。禁止在此子 Agent 内重试。',
  ].join('\n')
}

type SettleSubagentRun = typeof settleSubagentRun
type DefineEvaluatorTool = (options: any) => ToolDefinition

/**
 * Create the model-facing tool options. `defineTool` remains at the plugin entry
 * point so this module's behavior can be tested with a fake subagent service
 * without importing or booting the Harness runtime.
 */
export function independentEvaluatorToolDefinition(
  ctx: Context,
  settleRun: SettleSubagentRun,
  defineEvaluatorTool: DefineEvaluatorTool,
): ToolDefinition {
  return defineEvaluatorTool({
    name: 'independent_evaluator',
    description:
      '启动一个全新的独立审计子 Agent。输入只能是 folder、candidate_scope、selected_ids、target、seed；' +
      '模型路由从当前父 request header 内部继承，调用方不可指定。',
    parameters: INDEPENDENT_EVALUATOR_PARAMETERS,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: IndependentEvaluatorInput, exec: ToolRunContext) {
      assertExactToolInputs(args)
      const parent = exec.agent
      const route = captureIndependentEvaluatorRoute(parent)
      // Snapshot before the first await. A later UI route switch belongs to the
      // parent's next tool invocation, never to this already-authorized child.
      const childOptions: AgentOptions = Object.freeze({
        provider: route.provider,
        model: route.model,
        photoFilterIndependentEvaluatorRoute: route,
      })
      const run: SubagentRun = await ctx.subagents.start('spawn', {
        label: 'Photo selection independent audit',
        prompt: [{ type: 'text', text: renderIndependentEvaluatorPrompt(args) }],
        parent: parent!,
        signal: exec.signal,
        agentOptions: childOptions,
        persona: INDEPENDENT_EVALUATOR_PERSONA,
        toolFilter: { allow: ['audit_selection'] },
        maxDepth: 1,
      })
      const outcome = await settleRun(run)
      if (outcome.status !== 'completed') {
        throw new Error(
          `independent_evaluator 子 Agent 未完成（${outcome.status}）` +
          (outcome.detail ? `：${outcome.detail}` : ''),
        )
      }
      if (!nonEmptyString(outcome.output)) {
        throw new Error('independent_evaluator 子 Agent 已结束但没有审计输出。')
      }
      return outcome.output
    },
  })
}
