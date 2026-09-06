/**
 * Provider-neutral, one-shot visual inference through DeepSeek Harness.
 *
 * The current tool caller owns the route. This module never reads provider
 * credentials, constructs an endpoint, or falls back to another model. Each
 * request contains only a context-free rubric plus anonymous derived JPEGs.
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

/**
 * The provider sees one typed tool envelope whose `result`
 * object carries the domain result without a second JSON escaping layer.
 * The exact domain JSON Schema is included both in the tool declaration and
 * in the prompt; the decoded object is still validated locally. In particular,
 * empty arrays must retain their declared types rather than a free-form shape.
 * This requires ordinary tool use, not provider-specific forced tool choice.
 */
export const HARNESS_VISION_PROTOCOL = 'dsh-llm-typed-envelope-v4'

export interface HarnessModelRoute {
  provider: string
  model: string
  protocol: typeof HARNESS_VISION_PROTOCOL
  reasoningEffort?: string
}

interface ModelInfo {
  provider: string
  id: string
  inputModalities?: readonly string[]
}

interface ImageAttachmentRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

interface HarnessAttachmentStore {
  imageLimits: {
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    mediaTypes: readonly string[]
  }
  saveImages(inputs: ReadonlyArray<{
    data: Uint8Array
    mediaType: 'image/jpeg'
  }>): Promise<readonly ImageAttachmentRef[]>
}

interface HarnessPreparedCall {
  config: Record<string, unknown> & { provider: string; model: string }
  stream(options: Record<string, unknown>): AsyncIterable<Record<string, unknown>>
}

interface HarnessLlmService {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>
  prepareCall(
    config: Record<string, unknown> & { provider: string; model: string },
    signal?: AbortSignal,
  ): Promise<HarnessPreparedCall>
}

export interface HarnessVisionServices {
  llm?: HarnessLlmService
  attachments?: HarnessAttachmentStore
}

export interface HarnessVisionExecution {
  signal?: AbortSignal
  agent?: {
    options?: { provider?: string; model?: string; reasoningEffort?: string }
    session?: {
      id?: string
      requestHeader?: () => {
        config?: { provider?: string; model?: string; reasoningEffort?: string }
      } | undefined
    }
  }
}

export interface StructuredVisionRequest {
  system: string
  user: string
  jpegs: readonly string[]
  tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  maxTokens: number
}

/** One no-image, exact-domain-contract probe performed before photo bytes. */
export interface HarnessVisionContractProbe extends Omit<StructuredVisionRequest, 'jpegs'> {
  /** Stable public label included in the preflight receipt/cache identity. */
  label: string
  /** Literal decoded domain result the routed model must reproduce. */
  expected: Readonly<Record<string, unknown>>
}

export interface HarnessVisionPreflight {
  route: HarnessModelRoute
  imageInput: true
  structuredToolCall: true
  /** A text-only adapter dispatch authenticated and reached this exact route. */
  dynamicRouteProbe: true
  /** Exact local attachment ceilings observed for this routed execution. */
  imageLimits: HarnessVisionAttachmentLimits
  /** Exact no-image domain contracts proven through the same envelope. */
  contractsProbed: readonly string[]
}

export interface HarnessVisionAttachmentLimits {
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  mediaTypes: readonly string[]
}

export class HarnessVisionError extends Error {
  readonly code?: string
  readonly status?: number

  constructor(message: string, details: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'HarnessVisionError'
    this.code = details.code
    this.status = details.status
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Resolve the exact current request route. Request-header state wins. */
export function resolveHarnessModelRoute(exec: HarnessVisionExecution): HarnessModelRoute {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const reasoningEffort = routed?.reasoningEffort ?? exec.agent?.options?.reasoningEffort
  if (!nonEmpty(provider) || !nonEmpty(model)) {
    throw new HarnessVisionError('无法解析当前 DSH 会话的 provider/model；视觉评估已阻止。', {
      code: 'MODEL_ROUTE_UNRESOLVED',
    })
  }
  return Object.freeze({
    provider,
    model,
    protocol: HARNESS_VISION_PROTOCOL,
    ...(nonEmpty(reasoningEffort) ? { reasoningEffort } : {}),
  })
}

/**
 * Experiment acceptance is bound to the route selected for this exact turn.
 * Unlike the compatibility resolver above, it must never fall back to stale
 * Agent options when the request header is absent or incomplete.
 */
export function resolveStrictHarnessModelRoute(exec: HarnessVisionExecution): HarnessModelRoute {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider
  const model = routed?.model
  const reasoningEffort = routed?.reasoningEffort
  if (!nonEmpty(provider) || !nonEmpty(model)) {
    throw new HarnessVisionError(
      '锚点实验无法从当前 DSH request header 解析 provider/model；图片请求已阻止。',
      { code: 'EXPERIMENT_ROUTE_HEADER_REQUIRED' },
    )
  }
  return Object.freeze({
    provider,
    model,
    protocol: HARNESS_VISION_PROTOCOL,
    ...(nonEmpty(reasoningEffort) ? { reasoningEffort } : {}),
  })
}

export function harnessRouteIdentity(route: HarnessModelRoute): string {
  return [
    route.provider,
    route.model,
    route.protocol,
    route.reasoningEffort ?? '',
  ].join('\u0000')
}

export function renderHarnessRoute(route: HarnessModelRoute): string {
  return `${route.provider} / ${route.model} / ${route.protocol}` +
    (route.reasoningEffort ? ` / reasoning=${route.reasoningEffort}` : '')
}

function failureFromFinish(reason: unknown): HarnessVisionError | undefined {
  if (!reason || typeof reason !== 'object') {
    return new HarnessVisionError('Harness LLM 未返回有效 finish reason。', { code: 'INVALID_FINISH' })
  }
  const row = reason as { kind?: unknown; failure?: { message?: unknown; code?: unknown; status?: unknown } }
  if (row.kind === 'error' || row.kind === 'aborted') {
    const failure = row.failure
    return new HarnessVisionError(
      nonEmpty(failure?.message) ? failure.message : `Harness LLM ${String(row.kind)}`,
      {
        ...(nonEmpty(failure?.code) ? { code: failure.code } : {}),
        ...(typeof failure?.status === 'number' ? { status: failure.status } : {}),
      },
    )
  }
  if (row.kind === 'max-tokens') {
    return new HarnessVisionError('结构化视觉输出达到 maxTokens，结果未接受。', {
      code: 'MAX_TOKENS',
    })
  }
  if (row.kind === 'stop' || row.kind === 'tool-calls') return undefined
  return new HarnessVisionError(`不支持的 Harness finish reason：${String(row.kind)}`, {
    code: 'UNSUPPORTED_FINISH',
  })
}

function publicFailureDetails(error: unknown): { code?: string; status?: number } {
  if (!error || typeof error !== 'object') return {}
  const value = error as { code?: unknown; status?: unknown }
  return {
    ...(nonEmpty(value.code) ? { code: value.code } : {}),
    ...(typeof value.status === 'number' ? { status: value.status } : {}),
  }
}

function parseToolArguments(
  blocks: readonly Record<string, unknown>[],
  expectedTool: string,
  nonce: string,
  finish: unknown,
): Record<string, unknown> {
  const calls = blocks.filter(block => block.type === 'tool-call')
  if (calls.length !== 1 || calls[0]?.name !== expectedTool) {
    const blockTypes = [...new Set(blocks.map(block => String(block.type ?? 'unknown')))].sort()
    const finishKind = finish && typeof finish === 'object' && 'kind' in finish
      ? String((finish as { kind?: unknown }).kind ?? 'unknown')
      : 'missing'
    throw new HarnessVisionError(
      `模型没有且仅调用结构化工具 ${expectedTool}；` +
      `finish=${finishKind}，blocks=${blockTypes.join(',') || 'none'}；` +
      '禁止解析纯文本或回退其他模型。',
      { code: 'STRUCTURED_OUTPUT_UNSUPPORTED' },
    )
  }
  const raw = calls[0]?.arguments
  if (typeof raw !== 'string') {
    throw new HarnessVisionError('结构化工具参数不是 JSON 字符串。', {
      code: 'INVALID_TOOL_ARGUMENTS',
    })
  }
  const invalid = (stage: string): never => {
    // Never include JSON.parse's message: it can quote private photo evidence.
    throw new HarnessVisionError(`结构化工具信封验证失败；stage=${stage}。`, {
      code: 'INVALID_TOOL_ENVELOPE',
    })
  }
  let envelope: unknown
  try { envelope = JSON.parse(raw) } catch { return invalid('outer_json') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return invalid('outer_object')
  }
  const row = envelope as Record<string, unknown>
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, 'nonce') || !Object.hasOwn(row, 'result')) {
    const missing = ['nonce', 'result'].filter(key => !Object.hasOwn(row, key)).join('+') || 'none'
    const extraCount = Object.keys(row).filter(key => key !== 'nonce' && key !== 'result').length
    return invalid(`envelope_keys,missing=${missing},extra_count=${extraCount}`)
  }
  if (row.nonce !== nonce) return invalid('nonce')
  if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) {
    return invalid('result_object')
  }
  return row.result as Record<string, unknown>
}

function defaultContractProbe(): HarnessVisionContractProbe {
  const nonce = randomUUID()
  const expected = Object.freeze({ ok: true, probe: nonce })
  return Object.freeze({
    label: 'generic-tool-envelope',
    system: 'You are a capability probe. Call the supplied tool exactly once. Do not answer with text.',
    user: `No image is attached. Reproduce this exact JSON object: ${JSON.stringify(expected)}`,
    tool: {
      name: 'photo_filter_model_preflight',
      description: 'Confirm that this exact routed model can produce the required JSON tool envelope.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['ok', 'probe'],
        properties: {
          ok: { type: 'boolean', enum: [true] },
          probe: { type: 'string', enum: [nonce] },
        },
      },
    },
    maxTokens: 160,
    expected,
  })
}

/** Only expected-contract paths and fixed categories may enter diagnostics. */
function contractMismatchSummary(actual: unknown, expected: unknown): string {
  const issues: string[] = []
  const visit = (a: unknown, e: unknown, path: string): void => {
    if (issues.length >= 8 || isDeepStrictEqual(a, e)) return
    if (Array.isArray(e)) {
      if (!Array.isArray(a)) { issues.push(`${path}:type`); return }
      if (a.length !== e.length) issues.push(`${path}:length`)
      for (let i = 0; i < e.length && issues.length < 8; i++) visit(a[i], e[i], `${path}[${i}]`)
    } else if (e && typeof e === 'object') {
      if (!a || typeof a !== 'object' || Array.isArray(a)) { issues.push(`${path}:type`); return }
      const ar = a as Record<string, unknown>
      const er = e as Record<string, unknown>
      if (Object.keys(ar).some(key => !Object.hasOwn(er, key))) issues.push(`${path}:extra_keys`)
      for (const key of Object.keys(er)) {
        if (issues.length >= 8) break
        if (!Object.hasOwn(ar, key)) issues.push(`${path}.${key}:missing`)
        else visit(ar[key], er[key], `${path}.${key}`)
      }
    } else issues.push(`${path}:${typeof a === typeof e ? 'value' : 'type'}`)
  }
  visit(actual, expected, 'result')
  return issues.join(',')
}

/** Stable identity for route-local preflight caching; contains no credentials. */
export function harnessVisionContractProbeIdentity(
  probes: readonly HarnessVisionContractProbe[],
): string {
  return JSON.stringify(probes.map(probe => ({
    label: probe.label,
    system: probe.system,
    user: probe.user,
    tool: probe.tool,
    maxTokens: probe.maxTokens,
    expected: probe.expected,
  })))
}

/**
 * A fresh transport should be created for each tool execution. Successful
 * preflight caching belongs to the caller so an aborted/failed probe is never
 * retained as a false positive.
 */
export class HarnessVisionTransport {
  readonly route: HarnessModelRoute
  private readonly services: HarnessVisionServices
  private readonly sessionId?: string
  private preflightPassed = false

  constructor(
    services: HarnessVisionServices,
    route: HarnessModelRoute,
    sessionId?: string,
  ) {
    this.services = services
    this.route = route
    this.sessionId = sessionId
  }

  private requireServices(): { llm: HarnessLlmService; attachments: HarnessAttachmentStore } {
    if (!this.services.llm) {
      throw new HarnessVisionError('当前 Harness 没有挂载统一 LLM adapter；视觉评估已阻止。', {
        code: 'LLM_SERVICE_MISSING',
      })
    }
    if (!this.services.attachments) {
      throw new HarnessVisionError('当前 Harness 没有挂载 attachment service；视觉评估已阻止。', {
        code: 'ATTACHMENT_SERVICE_MISSING',
      })
    }
    return { llm: this.services.llm, attachments: this.services.attachments }
  }

  /** Read-only local limits; this never resolves, stores or transmits an image. */
  attachmentLimits(): Readonly<HarnessVisionAttachmentLimits> {
    const { attachments } = this.requireServices()
    return Object.freeze({
      maxImagesPerMessage: attachments.imageLimits.maxImagesPerMessage,
      maxMessageImageBytes: attachments.imageLimits.maxMessageImageBytes,
      mediaTypes: Object.freeze([...attachments.imageLimits.mediaTypes]),
    })
  }

  /** Local, no-image gate. It may query adapter-owned model metadata. */
  async assertLocalCapabilities(signal?: AbortSignal): Promise<void> {
    const { llm, attachments } = this.requireServices()
    let info: ModelInfo
    try {
      info = await llm.resolveModelInfo(this.route.provider, this.route.model, signal)
    } catch (error) {
      throw new HarnessVisionError(
        `无法解析当前模型路由 ${this.route.provider}/${this.route.model}：` +
        `${error instanceof Error ? error.message : '未知错误'}`,
        { code: 'MODEL_ROUTE_UNAVAILABLE' },
      )
    }
    if (info.provider !== this.route.provider || info.id !== this.route.model) {
      throw new HarnessVisionError('Harness adapter 返回了不同的 provider/model 身份；视觉评估已阻止。', {
        code: 'MODEL_IDENTITY_MISMATCH',
      })
    }
    if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
      throw new HarnessVisionError(
        `当前模型 ${this.route.provider}/${this.route.model} 未明确声明 image input；视觉评估已阻止。`,
        { code: 'IMAGE_INPUT_UNSUPPORTED' },
      )
    }
    if (!attachments.imageLimits.mediaTypes.includes('image/jpeg')) {
      throw new HarnessVisionError('当前 attachment service 不接受 JPEG；视觉评估已阻止。', {
        code: 'JPEG_ATTACHMENT_UNSUPPORTED',
      })
    }
    if (attachments.imageLimits.maxImagesPerMessage < 2) {
      throw new HarnessVisionError('当前 attachment service 不允许双图 pairwise；完整选片链路已阻止。', {
        code: 'PAIRWISE_ATTACHMENT_UNSUPPORTED',
      })
    }
    if (!Number.isInteger(attachments.imageLimits.maxMessageImageBytes)
      || attachments.imageLimits.maxMessageImageBytes <= 0) {
      throw new HarnessVisionError('当前 attachment service 图片字节上限无效；视觉评估已阻止。', {
        code: 'ATTACHMENT_BYTE_LIMIT_INVALID',
      })
    }
  }

  /**
   * Text-only probe for adapter routing, credentials, and required tool calls.
   * This must pass before any JPEG is saved or sent. It is intentionally not a
   * silent text-JSON fallback: scoring accepts the same tool-call protocol.
   */
  async preflight(
    signal?: AbortSignal,
    contractProbes: readonly HarnessVisionContractProbe[] = [defaultContractProbe()],
    beforeDispatch?: () => void,
  ): Promise<HarnessVisionPreflight> {
    await this.assertLocalCapabilities(signal)
    if (!contractProbes.length || contractProbes.some(probe => !nonEmpty(probe.label))) {
      throw new HarnessVisionError('模型预检合同列表为空或标签无效；图片尚未发送。', {
        code: 'MODEL_PREFLIGHT_CONTRACT_INVALID',
      })
    }
    for (const probe of contractProbes) {
      beforeDispatch?.()
      const payload = await this.callTool({
        system: probe.system,
        user: probe.user,
        jpegs: [],
        tool: probe.tool,
        maxTokens: probe.maxTokens,
      }, signal)
      if (!isDeepStrictEqual(payload, probe.expected)) {
        throw new HarnessVisionError(`模型预检合同 ${probe.label} 返回值不匹配；` +
          `mismatch=${contractMismatchSummary(payload, probe.expected)}；图片尚未发送。`, {
          code: 'MODEL_PREFLIGHT_MISMATCH',
        })
      }
    }
    this.preflightPassed = true
    return Object.freeze({
      route: this.route,
      imageInput: true,
      structuredToolCall: true,
      dynamicRouteProbe: true,
      imageLimits: this.attachmentLimits(),
      contractsProbed: Object.freeze(contractProbes.map(probe => probe.label)),
    })
  }

  async invokeStructured(
    request: StructuredVisionRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.preflightPassed) {
      throw new HarnessVisionError('动态路由/tool-call 预检尚未 PASS；图片请求已阻止。', {
        code: 'MODEL_PREFLIGHT_REQUIRED',
      })
    }
    if (request.jpegs.length < 1 || request.jpegs.length > 2) {
      throw new HarnessVisionError('视觉评分只允许 1 张 baseline 或 2 张 pairwise JPEG。', {
        code: 'INVALID_IMAGE_COUNT',
      })
    }
    return this.callTool(request, signal)
  }

  private async callTool(
    request: StructuredVisionRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { llm, attachments } = this.requireServices()
    const encoded = request.jpegs.map((jpeg) => {
      const data = Buffer.from(jpeg, 'base64')
      if (data.byteLength === 0) {
        throw new HarnessVisionError('匿名 JPEG 为空；请求已阻止。', { code: 'EMPTY_JPEG' })
      }
      return { data: new Uint8Array(data), mediaType: 'image/jpeg' as const }
    })
    const totalBytes = encoded.reduce((sum, image) => sum + image.data.byteLength, 0)
    if (encoded.length > attachments.imageLimits.maxImagesPerMessage
      || totalBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new HarnessVisionError('匿名 JPEG 超出 Harness attachment 限制；请求已阻止。', {
        code: 'ATTACHMENT_LIMIT_EXCEEDED',
      })
    }
    const callConfig: Record<string, unknown> & { provider: string; model: string } = {
      provider: this.route.provider,
      model: this.route.model,
      ...(this.route.reasoningEffort ? { reasoningEffort: this.route.reasoningEffort } : {}),
      temperature: 0,
      maxTokens: request.maxTokens,
    }
    let prepared: HarnessPreparedCall
    try {
      prepared = await llm.prepareCall(callConfig, signal)
    } catch (error) {
      const details = publicFailureDetails(error)
      throw new HarnessVisionError(
        `当前 Harness adapter 无法准备 ${this.route.provider}/${this.route.model}：` +
        `${error instanceof Error ? error.message : '未知错误'}`,
        {
          code: details.code ?? 'MODEL_CALL_UNAVAILABLE',
          ...(details.status === undefined ? {} : { status: details.status }),
        },
      )
    }
    // The exact adapter registration/config is fixed before committing an
    // attachment. Credentials/tool support were already proven by the
    // text-only preflight for this same route.
    const refs = encoded.length ? await attachments.saveImages(encoded) : []
    const nonce = randomUUID()
    const resultSchema = JSON.stringify(request.tool.parameters)
    const instruction = `${request.user}\n\n` +
      `OUTPUT CONTRACT: Call ${request.tool.name} exactly once with nonce=${nonce}. ` +
      'Its result argument must be a JSON object (not a JSON-encoded string) ' +
      `that matches this JSON Schema: ${resultSchema}. ` +
      'Do not answer with text or Markdown and do not call any other tool.'
    const content: Array<Record<string, unknown>> = []
    for (const attachment of refs) content.push({ type: 'image', attachment })
    content.push({ type: 'text', text: instruction })
    const wireTool = {
      name: request.tool.name,
      description: `${request.tool.description} Return only the required JSON envelope.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['nonce', 'result'],
        properties: {
          nonce: { type: 'string', enum: [nonce] },
          result: {
            ...request.tool.parameters,
            description: 'The complete result object matching the OUTPUT CONTRACT schema; do not stringify it.',
          },
        },
      },
    }
    const messages = [{
      id: randomUUID(),
      role: 'user',
      content,
      source: { kind: 'plugin', plugin: 'photo-filter-agent-vision' },
    }]
    const options: Record<string, unknown> = {
      ...prepared.config,
      messages,
      system: request.system,
      tools: [wireTool],
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(signal ? { signal } : {}),
    }
    const blocks: Record<string, unknown>[] = []
    let finish: unknown
    for await (const chunk of prepared.stream(options)) {
      if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
        blocks.push(chunk.block as Record<string, unknown>)
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
    const failure = failureFromFinish(finish)
    if (failure) throw failure
    return parseToolArguments(blocks, request.tool.name, nonce, finish)
  }
}

/** Provider-neutral backpressure/limit signals stop new paid work. */
export const HARNESS_REJECTED_RESPONSE_CODES: readonly string[] = Object.freeze([
  'STRUCTURED_OUTPUT_UNSUPPORTED', 'INVALID_TOOL_ARGUMENTS', 'INVALID_TOOL_ENVELOPE', 'MAX_TOKENS',
])

/** These errors are emitted only after receiving a terminal adapter response. */
export function isHarnessVisionRejectedResponse(error: unknown): error is HarnessVisionError {
  return error instanceof HarnessVisionError
    && HARNESS_REJECTED_RESPONSE_CODES.includes(error.code ?? '')
}

export function isHarnessVisionCircuitBreakerError(error: unknown): boolean {
  if (error instanceof HarnessVisionError) {
    if (error.status === 401 || error.status === 403 || error.status === 429) return true
    if (error.code && /RATE|QUOTA|LIMIT|CREDIT|TOKEN_PLAN|RESOURCE_EXHAUSTED|AUTH|CREDENTIAL|UNSUPPORTED_CONTENT/iu.test(error.code)) {
      return true
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP\s*(?:401|403|429)|unauthori[sz]ed|forbidden|authentication|missing credential|rate.?limit|quota|token plan|resource exhausted|认证|鉴权|凭据|额度|限流/iu.test(message)
}
