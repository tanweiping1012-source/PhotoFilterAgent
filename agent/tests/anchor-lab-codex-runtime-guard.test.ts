import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  AnchorLabCodexRuntimeGuard,
  AnchorLabCodexRuntimeGuardError,
  isAnchorLabCodexCircuitBreakerFailure,
} from '../src/anchor-lab-codex-runtime-guard.ts'

type Call = Readonly<{ turn: number; callId: string; name?: string }>

function fakeAgent(calls: readonly Call[]): Agent {
  return {
    session: {
      events: calls.map((call, index) => ({
        type: 'tool/call',
        seq: index + 1,
        time: index + 1,
        data: {
          turn: call.turn,
          step: 1,
          callId: call.callId,
          name: call.name ?? 'anchor_lab_codex_test',
          arguments: '{}',
        },
      })),
    },
  } as unknown as Agent
}

function execution(agent: Agent, rootCallId: string): ToolRunContext {
  return { agent, rootCallId } as unknown as ToolRunContext
}

function guardCode(error: unknown): string | undefined {
  return error instanceof AnchorLabCodexRuntimeGuardError ? error.code : undefined
}

test('one physical DSH turn admits only one paid-tool root while the next turn is independent', () => {
  const guard = new AnchorLabCodexRuntimeGuard()
  const agent = fakeAgent([
    { turn: 1, callId: 'evaluate-1' },
    { turn: 1, callId: 'build-1' },
    { turn: 2, callId: 'build-2' },
  ])
  const first = execution(agent, 'evaluate-1')

  assert.deepEqual(guard.claimPaidTool(first, 'evaluate'), { turn: 1, rootCallId: 'evaluate-1' })
  assert.deepEqual(guard.claimPaidTool(first, 'evaluate'), { turn: 1, rootCallId: 'evaluate-1' })
  assert.throws(
    () => guard.claimPaidTool(execution(agent, 'build-1'), 'build'),
    error => guardCode(error) === 'TURN_PAID_TOOL_ALREADY_CLAIMED',
  )
  assert.deepEqual(
    guard.claimPaidTool(execution(agent, 'build-2'), 'build'),
    { turn: 2, rootCallId: 'build-2' },
  )
})

test('provider slots are monotonic and cannot be reset by another call in the same turn', () => {
  const guard = new AnchorLabCodexRuntimeGuard()
  const agent = fakeAgent([
    { turn: 7, callId: 'audit-a' },
    { turn: 7, callId: 'audit-b' },
  ])
  const exec = execution(agent, 'audit-a')
  guard.claimPaidTool(exec, 'audit')

  assert.deepEqual(guard.consumeProviderDispatch(exec, 2), { turn: 7, used: 1, remaining: 1 })
  assert.equal(guard.remainingProviderDispatches(exec, 2), 1)
  assert.deepEqual(guard.consumeProviderDispatch(exec, 2), { turn: 7, used: 2, remaining: 0 })
  assert.throws(
    () => guard.consumeProviderDispatch(exec, 2),
    error => guardCode(error) === 'TURN_PROVIDER_BUDGET_EXHAUSTED',
  )
  assert.throws(
    () => guard.claimPaidTool(execution(agent, 'audit-b'), 'audit'),
    error => guardCode(error) === 'TURN_PAID_TOOL_ALREADY_CLAIMED',
  )
})

test('provider dispatch requires a tracked root and an explicit paid-tool claim', () => {
  const guard = new AnchorLabCodexRuntimeGuard()
  const agent = fakeAgent([{ turn: 1, callId: 'known' }])
  assert.throws(
    () => guard.consumeProviderDispatch(execution(agent, 'known'), 4),
    error => guardCode(error) === 'TURN_PAID_TOOL_NOT_CLAIMED',
  )
  assert.throws(
    () => guard.claimPaidTool(execution(agent, 'missing'), 'evaluate'),
    error => guardCode(error) === 'TURN_ID_UNRESOLVED',
  )
})

test('status, code and message circuit signals are provider-neutral', () => {
  const terminal: unknown[] = [
    { status: 401, code: 'unknown', message: 'x' },
    { status: 403, code: 'unknown', message: 'x' },
    { status: 429, code: 'unknown', message: 'x' },
    { code: 'INSUFFICIENT_QUOTA', message: 'x' },
    { code: 'RESOURCE_EXHAUSTED', message: 'x' },
    { code: 'CIRCUIT_BREAKER_OPEN', message: 'x' },
    new Error('HTTP 429 rate limited'),
    new Error('Token Plan 用量已达上限'),
  ]
  for (const failure of terminal) {
    assert.equal(isAnchorLabCodexCircuitBreakerFailure(failure), true, String(failure))
  }
  assert.equal(isAnchorLabCodexCircuitBreakerFailure({
    status: 500,
    code: 'SERVICE_UNAVAILABLE',
    message: 'temporary outage',
  }), false)
  assert.equal(isAnchorLabCodexCircuitBreakerFailure({
    code: 'OUTPUT_LIMIT',
    message: 'structured response was too long',
  }), false)
  assert.equal(isAnchorLabCodexCircuitBreakerFailure({
    code: 'MAX_TOKENS',
    message: 'generation stopped at max tokens',
  }), false)
})

test('a direct provider circuit latches the current turn but not a later turn', () => {
  const guard = new AnchorLabCodexRuntimeGuard()
  const agent = fakeAgent([
    { turn: 1, callId: 'evaluate-1' },
    { turn: 2, callId: 'evaluate-2' },
  ])
  const first = execution(agent, 'evaluate-1')
  guard.claimPaidTool(first, 'evaluate')
  guard.consumeProviderDispatch(first, 8)
  assert.equal(guard.tripExecutionIfCircuit(first, { status: 429, code: 'RATE_LIMIT' }), true)
  assert.throws(
    () => guard.consumeProviderDispatch(first, 8),
    error => guardCode(error) === 'TURN_CIRCUIT_OPEN',
  )
  assert.throws(
    () => guard.claimPaidTool(first, 'evaluate'),
    error => guardCode(error) === 'TURN_CIRCUIT_OPEN',
  )

  const second = execution(agent, 'evaluate-2')
  guard.claimPaidTool(second, 'evaluate')
  assert.deepEqual(guard.consumeProviderDispatch(second, 8), { turn: 2, used: 1, remaining: 7 })
})

test('request-error circuit handling never delegates to retry middleware', async () => {
  const guard = new AnchorLabCodexRuntimeGuard()
  const agent = fakeAgent([{ turn: 3, callId: 'after-request-error' }])
  let downstream = 0
  const failure: LlmFailure = {
    message: 'insufficient quota',
    code: 'INSUFFICIENT_QUOTA',
    status: 429,
  }
  const decision = await guard.handleRequestError(agent, 3, failure, async () => {
    downstream += 1
    return { kind: 'retry' as const }
  })
  assert.equal(decision, undefined)
  assert.equal(downstream, 0)
  assert.throws(
    () => guard.claimPaidTool(execution(agent, 'after-request-error'), 'evaluate'),
    error => guardCode(error) === 'TURN_CIRCUIT_OPEN',
  )

  const ordinary = await guard.handleRequestError(agent, 4, {
    message: 'temporary provider failure',
    code: 'SERVICE_UNAVAILABLE',
    status: 500,
  }, async () => {
    downstream += 1
    return { kind: 'retry' as const }
  })
  assert.deepEqual(ordinary, { kind: 'retry' })
  assert.equal(downstream, 1)
})
