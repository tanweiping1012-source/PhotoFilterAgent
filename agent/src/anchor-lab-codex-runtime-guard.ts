/**
 * Per-DSH-turn paid-work guard for the isolated Anchor Lab Codex preset.
 *
 * A tool's local `paid` counter is not an authority: one model step may emit
 * several tool calls and a later call in the same physical turn would start at
 * zero again. This ledger is keyed by the real Agent and the `tool/call` turn
 * recorded for `rootCallId`, so concurrent/sequential tool roots share one
 * monotonic budget and one circuit latch.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

type GuardExecution = Pick<ToolRunContext, 'agent' | 'rootCallId'>

interface CircuitFacts {
  readonly code: string
  readonly status?: number
}

interface TurnLedger {
  readonly turn: number
  paidTool?: Readonly<{
    rootCallId: string
    name: string
  }>
  providerDispatches: number
  circuit?: CircuitFacts
}

export class AnchorLabCodexRuntimeGuardError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorLabCodexRuntimeGuardError'
    this.code = code
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function publicCircuitFacts(value: unknown): CircuitFacts {
  const row = value && typeof value === 'object'
    ? value as { code?: unknown; status?: unknown }
    : {}
  return Object.freeze({
    code: nonEmpty(row.code) ? row.code : 'circuit_breaker',
    ...(typeof row.status === 'number' ? { status: row.status } : {}),
  })
}

/**
 * Provider-neutral terminal failures. These must never reach a retry plugin in
 * this preset and also trip direct visual-call work for the rest of the turn.
 */
export function isAnchorLabCodexCircuitBreakerFailure(value: unknown): boolean {
  const row = value && typeof value === 'object'
    ? value as { code?: unknown; status?: unknown; message?: unknown }
    : {}
  if (row.status === 401 || row.status === 403 || row.status === 429) return true
  if (nonEmpty(row.code)
    && /RATE_LIMIT|QUOTA|CREDIT|TOKEN_PLAN|RESOURCE_EXHAUSTED|AUTH|CREDENTIAL|INVALID_API_KEY|UNSUPPORTED_CONTENT|CIRCUIT/iu
      .test(row.code)) {
    return true
  }
  const message = nonEmpty(row.message)
    ? row.message
    : value instanceof Error ? value.message : String(value)
  return /HTTP\s*(?:401|403|429)|unauthori[sz]ed|forbidden|authentication|invalid.api.key|missing credential|rate.?limit|quota|token plan|resource exhausted|circuit.?breaker|认证|鉴权|凭据|额度|限流|熔断/iu
    .test(message)
}

function executionTurn(exec: GuardExecution): number {
  const agent = exec.agent
  if (!agent) {
    throw new AnchorLabCodexRuntimeGuardError(
      'TURN_AGENT_REQUIRED',
      'Anchor Lab 付费工具必须由可追踪的 Harness Agent 调用。',
    )
  }
  const call = agent.session.events.findLast(event =>
    event.type === 'tool/call' && String(event.data.callId) === String(exec.rootCallId))
  if (!call || call.type !== 'tool/call' || !Number.isInteger(call.data.turn) || call.data.turn < 1) {
    throw new AnchorLabCodexRuntimeGuardError(
      'TURN_ID_UNRESOLVED',
      '无法把当前付费工具绑定到唯一 DSH turn；provider 请求已阻止。',
    )
  }
  return call.data.turn
}

function assertPositiveBudget(maxProviderDispatches: number): void {
  if (!Number.isInteger(maxProviderDispatches) || maxProviderDispatches < 1) {
    throw new AnchorLabCodexRuntimeGuardError(
      'TURN_PROVIDER_BUDGET_INVALID',
      '单 turn provider 调用预算必须是正整数。',
    )
  }
}

export class AnchorLabCodexRuntimeGuard {
  private readonly ledgers = new WeakMap<Agent, Map<number, TurnLedger>>()

  private ledger(agent: Agent, turn: number): TurnLedger {
    if (!Number.isInteger(turn) || turn < 1) {
      throw new AnchorLabCodexRuntimeGuardError('TURN_ID_INVALID', 'DSH turn 身份无效。')
    }
    let turns = this.ledgers.get(agent)
    if (!turns) {
      turns = new Map()
      this.ledgers.set(agent, turns)
    }
    let ledger = turns.get(turn)
    if (!ledger) {
      ledger = { turn, providerDispatches: 0 }
      turns.set(turn, ledger)
      // A live Agent cannot have many useful open turns. Bound retained
      // history without ever deleting the current turn's authority.
      if (turns.size > 16) {
        const old = [...turns.keys()].filter(value => value !== turn).sort((a, b) => a - b)
        while (turns.size > 16 && old.length) turns.delete(old.shift()!)
      }
    }
    return ledger
  }

  private ledgerForExecution(exec: GuardExecution): TurnLedger {
    if (!exec.agent) {
      throw new AnchorLabCodexRuntimeGuardError(
        'TURN_AGENT_REQUIRED',
        'Anchor Lab 付费工具必须由可追踪的 Harness Agent 调用。',
      )
    }
    return this.ledger(exec.agent, executionTurn(exec))
  }

  private assertCircuitOpen(ledger: TurnLedger): void {
    if (!ledger.circuit) return
    throw new AnchorLabCodexRuntimeGuardError(
      'TURN_CIRCUIT_OPEN',
      `当前 DSH turn 已熔断（code=${ledger.circuit.code}; ` +
        `status=${String(ledger.circuit.status ?? 'unknown')}）；禁止同 turn 重试或继续付费调用。`,
    )
  }

  /** Claim the only paid-tool root that may execute in this physical turn. */
  claimPaidTool(exec: GuardExecution, name: string): Readonly<{ turn: number; rootCallId: string }> {
    if (!nonEmpty(name)) {
      throw new AnchorLabCodexRuntimeGuardError('PAID_TOOL_NAME_INVALID', '付费工具名称无效。')
    }
    const ledger = this.ledgerForExecution(exec)
    this.assertCircuitOpen(ledger)
    const rootCallId = String(exec.rootCallId)
    if (ledger.paidTool) {
      if (ledger.paidTool.rootCallId !== rootCallId || ledger.paidTool.name !== name) {
        throw new AnchorLabCodexRuntimeGuardError(
          'TURN_PAID_TOOL_ALREADY_CLAIMED',
          `DSH turn ${ledger.turn} 已由 ${ledger.paidTool.name} 占用付费工具门闩；` +
            `${name} 必须在新 turn 执行。`,
        )
      }
    } else {
      ledger.paidTool = Object.freeze({ rootCallId, name })
    }
    return Object.freeze({ turn: ledger.turn, rootCallId })
  }

  /**
   * Reserve one monotonic provider-dispatch slot immediately before dispatch.
   * Slots are never refunded: an ambiguous failure may already have incurred a
   * charge and therefore remains an attempt for this turn.
   */
  consumeProviderDispatch(
    exec: GuardExecution,
    maxProviderDispatches: number,
  ): Readonly<{ turn: number; used: number; remaining: number }> {
    assertPositiveBudget(maxProviderDispatches)
    const ledger = this.ledgerForExecution(exec)
    this.assertCircuitOpen(ledger)
    const rootCallId = String(exec.rootCallId)
    if (!ledger.paidTool || ledger.paidTool.rootCallId !== rootCallId) {
      throw new AnchorLabCodexRuntimeGuardError(
        'TURN_PAID_TOOL_NOT_CLAIMED',
        'provider dispatch 前必须先占用当前 DSH turn 的付费工具门闩。',
      )
    }
    if (ledger.providerDispatches >= maxProviderDispatches) {
      throw new AnchorLabCodexRuntimeGuardError(
        'TURN_PROVIDER_BUDGET_EXHAUSTED',
        `当前 DSH turn 已达到 provider 调用硬上限 ${maxProviderDispatches}；请在新 turn 继续。`,
      )
    }
    ledger.providerDispatches += 1
    return Object.freeze({
      turn: ledger.turn,
      used: ledger.providerDispatches,
      remaining: maxProviderDispatches - ledger.providerDispatches,
    })
  }

  remainingProviderDispatches(exec: GuardExecution, maxProviderDispatches: number): number {
    assertPositiveBudget(maxProviderDispatches)
    const ledger = this.ledgerForExecution(exec)
    this.assertCircuitOpen(ledger)
    const rootCallId = String(exec.rootCallId)
    if (!ledger.paidTool || ledger.paidTool.rootCallId !== rootCallId) {
      throw new AnchorLabCodexRuntimeGuardError(
        'TURN_PAID_TOOL_NOT_CLAIMED',
        '读取 provider 余额前必须先占用当前 DSH turn 的付费工具门闩。',
      )
    }
    return Math.max(0, maxProviderDispatches - ledger.providerDispatches)
  }

  tripAgentTurn(agent: Agent, turn: number, failure: unknown): void {
    const ledger = this.ledger(agent, turn)
    if (!ledger.circuit) ledger.circuit = publicCircuitFacts(failure)
  }

  tripExecutionIfCircuit(exec: GuardExecution, failure: unknown): boolean {
    if (!isAnchorLabCodexCircuitBreakerFailure(failure)) return false
    if (!exec.agent) {
      throw new AnchorLabCodexRuntimeGuardError(
        'TURN_AGENT_REQUIRED',
        '熔断失败无法绑定 DSH turn；后续付费调用已阻止。',
      )
    }
    this.tripAgentTurn(exec.agent, executionTurn(exec), failure)
    return true
  }

  /**
   * Prepend this to `agent/request-error`: terminal failures are recorded and
   * returned as `undefined` without consulting downstream retry middleware.
   */
  async handleRequestError<T>(
    agent: Agent,
    turn: number,
    failure: LlmFailure,
    next: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (!isAnchorLabCodexCircuitBreakerFailure(failure)) return next()
    this.tripAgentTurn(agent, turn, failure)
    return undefined
  }
}
