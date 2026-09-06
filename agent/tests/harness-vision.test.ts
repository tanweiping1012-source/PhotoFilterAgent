import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HARNESS_VISION_PROTOCOL,
  HarnessVisionError,
  HarnessVisionTransport,
  harnessRouteIdentity,
  isHarnessVisionCircuitBreakerError,
  isHarnessVisionRejectedResponse,
  resolveHarnessModelRoute,
  resolveStrictHarnessModelRoute,
} from '../src/harness-vision.ts'

function fakeServices(options: {
  /** null simulates adapter metadata with unknown/omitted modalities. */
  modalities?: readonly string[] | null
  finishFailure?: { kind: string; failure?: { message: string; code: string; status?: number } }
  wrongTool?: boolean
  textInsteadOfTool?: boolean
  mutateEnvelope?: (payload: Record<string, unknown>) => unknown
  malformedArguments?: boolean
} = {}) {
  const events: string[] = []
  const calls: Array<Record<string, unknown>> = []
  const attachments: Array<readonly { data: Uint8Array; mediaType: 'image/jpeg' }[]> = []
  const llm = {
    async resolveModelInfo(provider: string, model: string) {
      events.push(`resolve:${provider}/${model}`)
      return {
        provider,
        id: model,
        ...(options.modalities === null
          ? {}
          : { inputModalities: options.modalities ?? ['text', 'image'] }),
      }
    },
    async prepareCall(config: Record<string, unknown> & { provider: string; model: string }) {
      events.push(`prepare:${config.provider}/${config.model}`)
      return {
        config,
        async * stream(request: Record<string, unknown>) {
          calls.push(request)
          events.push(`stream:${config.provider}/${config.model}`)
          if (options.finishFailure) {
            yield { type: 'finish', reason: options.finishFailure }
            return
          }
          if (options.textInsteadOfTool) {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'private provider text' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          const tools = request.tools as Array<{
            name: string
            parameters: { properties: { nonce: { enum: string[] } } }
          }>
          const tool = tools[0]!
          const messages = request.messages as Array<{ content: Array<{ type: string; text?: string }> }>
          const text = messages[0]?.content.find(block => block.type === 'text')?.text ?? ''
          const literal = text.split('Reproduce this exact JSON object: ')[1]?.split('\n\nOUTPUT CONTRACT:')[0]
          const domainPayload = literal ? JSON.parse(literal) as Record<string, unknown> : { accepted: true }
          const payload = {
            nonce: tool.parameters.properties.nonce.enum[0],
            result: domainPayload,
          }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call', id: 'fake-call',
              name: options.wrongTool ? 'wrong_tool' : tool.name,
              arguments: options.malformedArguments ? '{private-photo-evidence' :
                JSON.stringify(options.mutateEnvelope ? options.mutateEnvelope(payload) : payload),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        },
      }
    },
  }
  const attachmentStore = {
    imageLimits: {
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 1024 * 1024,
      mediaTypes: ['image/jpeg'],
    },
    async saveImages(images: readonly { data: Uint8Array; mediaType: 'image/jpeg' }[]) {
      events.push('save-images')
      attachments.push(images)
      return images.map((image, index) => ({
        attachmentId: `attachment-${index}`,
        mediaType: image.mediaType,
        bytes: image.data.byteLength,
        width: 1,
        height: 1,
      }))
    },
  }
  return { services: { llm, attachments: attachmentStore }, events, calls, attachments }
}

function execRoute() {
  return {
    agent: {
      options: { provider: 'old-default', model: 'old-model', reasoningEffort: 'low' },
      session: {
        id: 'session-a',
        requestHeader: () => ({
          config: {
            provider: 'volcengine-ark',
            model: 'doubao-seed-2-1-pro-260628',
            reasoningEffort: 'high',
          },
        }),
      },
    },
  }
}

test('request header route wins over stale agent options and identity binds reasoning', () => {
  const selected = resolveHarnessModelRoute(execRoute())
  assert.deepEqual(selected, {
    provider: 'volcengine-ark',
    model: 'doubao-seed-2-1-pro-260628',
    protocol: HARNESS_VISION_PROTOCOL,
    reasoningEffort: 'high',
  })
  const changed = { ...selected, reasoningEffort: 'medium' }
  assert.notEqual(harnessRouteIdentity(selected), harnessRouteIdentity(changed))
})

test('agent options are used only when no request header exists', () => {
  assert.equal(resolveHarnessModelRoute({
    agent: { options: { provider: 'fallback', model: 'visual' } },
  }).provider, 'fallback')
  assert.throws(() => resolveHarnessModelRoute({ agent: { options: {} } }), /provider\/model/u)
})

test('strict experiment route requires the current request header and never falls back', () => {
  assert.deepEqual(resolveStrictHarnessModelRoute(execRoute()), {
    provider: 'volcengine-ark',
    model: 'doubao-seed-2-1-pro-260628',
    protocol: HARNESS_VISION_PROTOCOL,
    reasoningEffort: 'high',
  })
  assert.throws(
    () => resolveStrictHarnessModelRoute({
      agent: { options: { provider: 'fallback', model: 'visual' } },
    }),
    (error: unknown) => error instanceof HarnessVisionError
      && error.code === 'EXPERIMENT_ROUTE_HEADER_REQUIRED',
  )
  assert.throws(
    () => resolveStrictHarnessModelRoute({
      agent: {
        options: { provider: 'fallback', model: 'visual' },
        session: { requestHeader: () => ({ config: { provider: 'selected' } }) },
      },
    }),
    (error: unknown) => error instanceof HarnessVisionError
      && error.code === 'EXPERIMENT_ROUTE_HEADER_REQUIRED',
  )
})

test('unknown or text-only image capability fails before prepare stream or attachment writes', async () => {
  for (const modalities of [null, ['text']] as const) {
    const fake = fakeServices({ modalities })
    const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
    await assert.rejects(() => transport.preflight(), (error: unknown) => {
      assert.ok(error instanceof HarnessVisionError)
      assert.equal(error.code, 'IMAGE_INPUT_UNSUPPORTED')
      return true
    })
    assert.equal(fake.events.some(event => event.startsWith('prepare:')), false)
    assert.equal(fake.calls.length, 0)
    assert.equal(fake.attachments.length, 0)
  }
})

test('image requests are impossible before the text-only structured probe passes', async () => {
  const fake = fakeServices()
  const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
  await assert.rejects(() => transport.invokeStructured({
    system: 'isolated rubric', user: 'score', jpegs: ['ZmFrZQ=='],
    tool: { name: 'submit', description: 'submit', parameters: { type: 'object' } },
    maxTokens: 100,
  }), /预检/u)
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.attachments.length, 0)
})

test('preflight uses the selected adapter with no image and rejects unsupported tool calling', async () => {
  const fake = fakeServices({ wrongTool: true })
  const route = resolveHarnessModelRoute(execRoute())
  const transport = new HarnessVisionTransport(fake.services as never, route, 'session-a')
  await assert.rejects(() => transport.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessVisionError)
    assert.equal(error.code, 'STRUCTURED_OUTPUT_UNSUPPORTED')
    return true
  })
  assert.equal(fake.attachments.length, 0)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0]?.provider, route.provider)
  assert.equal(fake.calls[0]?.model, route.model)
  assert.equal(JSON.stringify(fake.calls).includes('old-default'), false)
})

test('preflight proves each supplied exact contract before enabling images', async () => {
  const fake = fakeServices()
  const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
  let dispatches = 0
  const probes = [
    {
      label: 'baseline-contract', system: 'probe',
      user: 'Reproduce this exact JSON object: {"accepted":true}',
      tool: {
        name: 'submit_baseline', description: 'submit',
        parameters: {
          type: 'object', required: ['accepted'],
          properties: { accepted: { type: 'boolean' } },
        },
      },
      maxTokens: 100,
      expected: { accepted: true },
    },
    {
      label: 'pairwise-contract', system: 'probe',
      user: 'Reproduce this exact JSON object: {"accepted":true}',
      tool: {
        name: 'submit_pairwise', description: 'submit',
        parameters: {
          type: 'object', required: ['accepted'],
          properties: { accepted: { type: 'boolean' } },
        },
      },
      maxTokens: 100,
      expected: { accepted: true },
    },
  ] as const
  const ready = await transport.preflight(undefined, probes, () => { dispatches += 1 })
  assert.equal(dispatches, 2)
  assert.deepEqual(ready.contractsProbed, ['baseline-contract', 'pairwise-contract'])
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.attachments.length, 0)
})

test('unsupported structured output reports only finish and block types, never provider text', async () => {
  const fake = fakeServices({ textInsteadOfTool: true })
  const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
  await assert.rejects(() => transport.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessVisionError)
    assert.equal(error.code, 'STRUCTURED_OUTPUT_UNSUPPORTED')
    assert.match(error.message, /finish=stop.*blocks=text/u)
    assert.equal(error.message.includes('private provider text'), false)
    return true
  })
})

test('after preflight an isolated image call uses only the selected route and Harness attachments', async () => {
  const fake = fakeServices()
  const route = resolveHarnessModelRoute(execRoute())
  const transport = new HarnessVisionTransport(fake.services as never, route, 'session-a')
  const ready = await transport.preflight()
  assert.equal(ready.dynamicRouteProbe, true)
  assert.deepEqual(ready.contractsProbed, ['generic-tool-envelope'])
  assert.deepEqual(ready.imageLimits, {
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 1024 * 1024,
    mediaTypes: ['image/jpeg'],
  })
  const response = await transport.invokeStructured({
    system: 'isolated rubric',
    user: 'score this anonymous image',
    jpegs: ['ZmFrZQ=='],
    tool: {
      name: 'submit_score', description: 'submit',
      parameters: { type: 'object', properties: { accepted: { type: 'boolean' } } },
    },
    maxTokens: 100,
  })
  assert.deepEqual(response, { accepted: true })
  assert.equal(fake.calls.length, 2)
  assert.equal(fake.attachments.length, 1)
  assert.ok(fake.events.indexOf(`prepare:${route.provider}/${route.model}`)
    < fake.events.indexOf('save-images'))
  const request = fake.calls[1]!
  assert.equal(request.provider, route.provider)
  assert.equal(request.model, route.model)
  assert.equal(JSON.stringify(request).includes('parent conversation'), false)
  const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>
  assert.deepEqual(messages[0]?.content.map(block => block.type), ['image', 'text'])
  const wireTool = (request.tools as Array<{ parameters: { required: string[]; properties: { result: Record<string, unknown> } } }>)[0]
  assert.deepEqual(wireTool?.parameters.required, ['nonce', 'result'])
  assert.deepEqual(wireTool?.parameters.properties.result.properties, { accepted: { type: 'boolean' } })
  assert.equal(JSON.stringify(fake.calls).includes('old-default'), false)
})

test('invalid envelopes identify the failing stage without exposing provider content or retrying', async () => {
  const cases = [
    { stage: 'outer_json', options: { malformedArguments: true } },
    { stage: 'outer_object', options: { mutateEnvelope: () => [] } },
    { stage: 'envelope_keys,missing=none,extra_count=1', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ ...p, privatePhotoEvidence: 'secret' }) } },
    { stage: 'envelope_keys,missing=result,extra_count=0', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ nonce: p.nonce }) } },
    { stage: 'nonce', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ ...p, nonce: 'private-photo-evidence' }) } },
    { stage: 'result_object', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ ...p, result: '{"private-photo-evidence":true}' }) } },
    { stage: 'result_object', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ ...p, result: null }) } },
    { stage: 'result_object', options: { mutateEnvelope: (p: Record<string, unknown>) => ({ ...p, result: [] }) } },
  ]
  for (const { stage, options } of cases) {
    const fake = fakeServices(options)
    const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
    await assert.rejects(() => transport.preflight(), (error: unknown) => {
      assert.ok(error instanceof HarnessVisionError)
      assert.equal(error.code, 'INVALID_TOOL_ENVELOPE')
      assert.ok(error.message.includes(`stage=${stage}`))
      assert.equal(/private|secret/.test(error.message), false)
      return true
    })
    assert.equal(fake.calls.length, 1)
    assert.equal(fake.attachments.length, 0)
  }
})

test('contract mismatch exposes only expected paths and fixed categories', async () => {
  const fake = fakeServices({ mutateEnvelope: p => ({ ...p, result: { ok: 'secret', 'private-photo-evidence': true } }) })
  const transport = new HarnessVisionTransport(fake.services as never, resolveHarnessModelRoute(execRoute()))
  await assert.rejects(() => transport.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessVisionError)
    assert.equal(error.code, 'MODEL_PREFLIGHT_MISMATCH')
    assert.match(error.message, /result:extra_keys,result.ok:type,result.probe:missing/)
    assert.equal(/private|secret/.test(error.message), false)
    return true
  })
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.attachments.length, 0)
})

test('provider failures preserve machine code and never trigger a fallback route', async () => {
  const fake = fakeServices({
    finishFailure: { kind: 'error', failure: { message: 'missing key', code: 'MISSING_CREDENTIAL', status: 401 } },
  })
  const route = resolveHarnessModelRoute(execRoute())
  const transport = new HarnessVisionTransport(fake.services as never, route)
  await assert.rejects(() => transport.preflight(), (error: unknown) => {
    assert.ok(error instanceof HarnessVisionError)
    assert.equal(error.code, 'MISSING_CREDENTIAL')
    assert.equal(error.status, 401)
    return true
  })
  assert.equal(fake.events.some(event => event.includes('old-default')), false)
  assert.equal(fake.events.filter(event => event.startsWith('stream:')).length, 1)
})

test('raw 401 and 403 provider failures open the circuit even without a machine code', () => {
  assert.equal(isHarnessVisionCircuitBreakerError(new Error('HTTP 401 unauthorized')), true)
  assert.equal(isHarnessVisionCircuitBreakerError(new Error('HTTP 403 forbidden')), true)
  assert.equal(isHarnessVisionCircuitBreakerError(new HarnessVisionError('auth failed', { status: 401 })), true)
  assert.equal(isHarnessVisionCircuitBreakerError(new Error('temporary parse error')), false)
})

test('bounded response repair never treats unknown network outcomes as received rejections', () => {
  for (const code of ['STRUCTURED_OUTPUT_UNSUPPORTED', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ENVELOPE', 'MAX_TOKENS']) {
    assert.equal(isHarnessVisionRejectedResponse(new HarnessVisionError('rejected', { code })), true)
  }
  assert.equal(isHarnessVisionRejectedResponse(new Error('INVALID_TOOL_ENVELOPE')), false)
  assert.equal(isHarnessVisionRejectedResponse(new HarnessVisionError('network reset', { code: 'ECONNRESET' })), false)
  assert.equal(isHarnessVisionRejectedResponse(new HarnessVisionError('quota', { code: 'QUOTA' })), false)
})
