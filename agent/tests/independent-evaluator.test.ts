import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import {
  INDEPENDENT_EVALUATOR_PERSONA,
  captureIndependentEvaluatorRoute,
  forceIndependentEvaluatorRoute,
  independentEvaluatorToolDefinition,
  installIndependentEvaluatorRouteOverride,
  renderIndependentEvaluatorPrompt,
  type IndependentEvaluatorInput,
} from '../src/independent-evaluator.ts'

interface HeaderConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

const INPUT: IndependentEvaluatorInput = Object.freeze({
  folder: '/authorized/photos',
  candidate_scope: 'people_only',
  selected_ids: Object.freeze(['p001', 'p002']) as unknown as string[],
  target: 2,
  seed: 'frozen-seed',
})

function parentAgent(
  header: HeaderConfig | undefined,
  options: Record<string, unknown> = { provider: 'stale-provider', model: 'stale-model' },
): Agent {
  return {
    id: 'parent-session',
    options,
    session: {
      id: 'parent-session',
      requestHeader: () => header === undefined ? undefined : { config: header },
      header: { version: 0, id: 'parent-session', createdAt: 1 },
    },
  } as unknown as Agent
}

function fakeRun(): SubagentRun {
  return { marker: 'offline-run' } as unknown as SubagentRun
}

function fakeContext(
  run: SubagentRun,
  onStart: (provider: string, request: Record<string, unknown>) => void = () => undefined,
): Context {
  return {
    subagents: {
      async start(provider: string, request: Record<string, unknown>) {
        onStart(provider, request)
        return run
      },
    },
  } as unknown as Context
}

function execution(agent: Agent, signal = new AbortController().signal) {
  return {
    agent,
    signal,
    deferContext() {},
    concludeTurn() {},
  } as never
}

const defineOfflineTool = ((options: unknown) => options) as never

test('captures the live request header instead of stale creation-time agent options', () => {
  const route = captureIndependentEvaluatorRoute(parentAgent(
    { provider: 'current-provider', model: 'current-model', reasoningEffort: 'high' },
    { provider: 'stale-provider', model: 'stale-model', reasoningEffort: 'low' },
  ))

  assert.equal(route.provider, 'current-provider')
  assert.equal(route.model, 'current-model')
  assert.equal(route.reasoningEffort, 'high')
  assert.equal(route.parentSessionId, 'parent-session')
  assert.equal(
    route.routeIdentity,
    'current-provider\u0000current-model\u0000dsh-llm-tool-call-v1\u0000high',
  )
  assert.equal(Object.isFrozen(route), true)
})

test('fails closed when no request header exists even if stale options look usable', () => {
  assert.throws(
    () => captureIndependentEvaluatorRoute(parentAgent(undefined, {
      provider: 'stale-provider',
      model: 'stale-model',
      reasoningEffort: 'high',
    })),
    /request header.*已阻止/u,
  )
  assert.throws(
    () => captureIndependentEvaluatorRoute(undefined),
    /需要由当前 Harness Agent 调用/u,
  )
})

test('forcing a route removes stale reasoning when the captured route has none', () => {
  const route = captureIndependentEvaluatorRoute(parentAgent({
    provider: 'current-provider',
    model: 'current-model',
  }))
  const forced = forceIndependentEvaluatorRoute({
    provider: 'wrong-provider',
    model: 'wrong-model',
    reasoningEffort: 'ultra',
    temperature: 0.7,
  } as never, route)

  assert.equal(forced.provider, 'current-provider')
  assert.equal(forced.model, 'current-model')
  assert.equal(forced.temperature, 0.7)
  assert.equal(Object.hasOwn(forced, 'reasoningEffort'), false)
  assert.equal(Object.isFrozen(forced), true)
})

test('child request override enforces the frozen parent route only for valid delegated lineage', async () => {
  let listener: ((event: { agent: Agent }, next: () => Promise<Record<string, unknown>>) => Promise<unknown>) | undefined
  const ctx = {
    on(event: string, callback: typeof listener, prepend?: boolean) {
      assert.equal(event, 'agent/request')
      assert.equal(prepend, true)
      listener = callback
    },
  } as unknown as Context
  installIndependentEvaluatorRouteOverride(ctx)
  assert.ok(listener)

  const route = captureIndependentEvaluatorRoute(parentAgent({
    provider: 'current-provider',
    model: 'current-model',
    reasoningEffort: 'high',
  }))
  const child = {
    options: { photoFilterIndependentEvaluatorRoute: route },
    session: {
      header: {
        origin: 'subagent',
        parentSession: 'parent-session',
        delegationDepth: 1,
      },
    },
  } as unknown as Agent
  const forced = await listener!({ agent: child }, async () => ({
    provider: 'stale-provider',
    model: 'stale-model',
    reasoningEffort: 'low',
    temperature: 0.2,
  })) as Record<string, unknown>
  assert.deepEqual(forced, {
    provider: 'current-provider',
    model: 'current-model',
    reasoningEffort: 'high',
    temperature: 0.2,
  })

  const forged = {
    ...child,
    session: { header: { origin: 'subagent', parentSession: 'other', delegationDepth: 1 } },
  } as unknown as Agent
  await assert.rejects(
    () => listener!({ agent: forged }, async () => ({ provider: 'x', model: 'y' })),
    /not bound to a valid delegated child/u,
  )
})

test('renders exactly five frozen fields and rejects every extra input field', () => {
  const prompt = renderIndependentEvaluatorPrompt(INPUT)
  const lines = prompt.split('\n')
  const payload = JSON.parse(lines[1]!) as Record<string, unknown>

  assert.deepEqual(Object.keys(payload), [
    'folder',
    'candidate_scope',
    'selected_ids',
    'target',
    'seed',
  ])
  assert.deepEqual(payload, INPUT)
  assert.doesNotMatch(prompt, /preference|ranking|score|reasoning|why/iu)

  assert.throws(
    () => renderIndependentEvaluatorPrompt({
      ...INPUT,
      selector_score: 99,
    } as unknown as IndependentEvaluatorInput),
    /只接受五项冻结输入.*selector_score/u,
  )
})

test('spawns one constrained child with the current route, parent, signal, persona, and audit-only tool filter', async () => {
  const run = fakeRun()
  let startProvider: string | undefined
  let startRequest: Record<string, unknown> | undefined
  const ctx = fakeContext(run, (provider, request) => {
    startProvider = provider
    startRequest = request
  })
  const settleCalls: SubagentRun[] = []
  const tool = independentEvaluatorToolDefinition(ctx, (async candidate => {
    settleCalls.push(candidate)
    return { status: 'completed', output: 'PASS: offline audit' }
  }) as never, defineOfflineTool)
  const parent = parentAgent(
    { provider: 'current-provider', model: 'current-model', reasoningEffort: 'high' },
    { provider: 'stale-provider', model: 'stale-model', reasoningEffort: 'low' },
  )
  const controller = new AbortController()

  const result = await tool.execute(INPUT, execution(parent, controller.signal))

  assert.equal(result, 'PASS: offline audit')
  assert.equal(startProvider, 'spawn')
  assert.ok(startRequest)
  assert.equal(startRequest.parent, parent)
  assert.equal(startRequest.signal, controller.signal)
  assert.equal(startRequest.persona, INDEPENDENT_EVALUATOR_PERSONA)
  assert.deepEqual(startRequest.toolFilter, { allow: ['audit_selection'] })
  assert.equal(startRequest.maxDepth, 1)
  assert.deepEqual(startRequest.prompt, [{
    type: 'text',
    text: renderIndependentEvaluatorPrompt(INPUT),
  }])

  const childOptions = startRequest.agentOptions as Record<string, unknown>
  assert.equal(childOptions.provider, 'current-provider')
  assert.equal(childOptions.model, 'current-model')
  assert.equal(Object.hasOwn(childOptions, 'reasoningEffort'), false)
  const privateRoute = childOptions.photoFilterIndependentEvaluatorRoute as Record<string, unknown>
  assert.equal(privateRoute.provider, 'current-provider')
  assert.equal(privateRoute.model, 'current-model')
  assert.equal(privateRoute.reasoningEffort, 'high')
  assert.equal(privateRoute.parentSessionId, 'parent-session')
  assert.deepEqual(settleCalls, [run])
})

test('rejects non-completed child outcomes and completed runs with empty output', async () => {
  const parent = parentAgent({ provider: 'current-provider', model: 'current-model' })

  const failedRun = fakeRun()
  const failedTool = independentEvaluatorToolDefinition(
    fakeContext(failedRun),
    (async () => ({ status: 'failed', detail: 'offline failure' })) as never,
    defineOfflineTool,
  )
  await assert.rejects(
    () => failedTool.execute(INPUT, execution(parent)),
    /子 Agent 未完成（failed）：offline failure/u,
  )

  const emptyRun = fakeRun()
  const emptyTool = independentEvaluatorToolDefinition(
    fakeContext(emptyRun),
    (async () => ({ status: 'completed', output: ' \n\t ' })) as never,
    defineOfflineTool,
  )
  await assert.rejects(
    () => emptyTool.execute(INPUT, execution(parent)),
    /已结束但没有审计输出/u,
  )
})
