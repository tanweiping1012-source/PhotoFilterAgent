/**
 * Provider-neutral, one-shot visual inference through DeepSeek Harness.
 *
 * The current tool caller owns the route. This module never reads provider
 * credentials, constructs an endpoint, or falls back to another model. Each
 * request contains only a context-free rubric plus anonymous derived JPEGs.
 */

import { randomUUID } from 'node:crypto'

export const HARNESS_VISION_PROTOCOL = 'dsh-llm-tool-call-v1'

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

export interface HarnessVisionPreflight {
  route: HarnessModelRoute
  imageInput: true
  structuredToolCall: true
  /** A text-only adapter dispatch authenticated and reached this exact route. */
  dynamicRouteProbe: true
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
): Record<string, unknown> {
  const calls = blocks.filter(block => block.type === 'tool-call')
  if (calls.length !== 1 || calls[0]?.name !== expectedTool) {
    throw new HarnessVisionError(
      `模型没有且仅调用结构化工具 ${expectedTool}；禁止解析纯文本或回退其他模型。`,
      { code: 'STRUCTURED_OUTPUT_UNSUPPORTED' },
    )
  }
  const raw = calls[0]?.arguments
  if (typeof raw !== 'string') {
    throw new HarnessVisionError('结构化工具参数不是 JSON 字符串。', {
      code: 'INVALID_TOOL_ARGUMENTS',
    })
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Normalize every malformed provider payload to one stable public error.
  }
  throw new HarnessVisionError('结构化工具参数不是有效 JSON 对象。', {
    code: 'INVALID_TOOL_ARGUMENTS',
  })
}

/**
 * A fresh transport should be created for each tool execution. Successful
 * preflight caching belongs to the caller so an aborted/failed probe is never
 * retained as a false positive.
 */
/**
 * 一次视觉调用最多几张图。
 *
 * 这是「照片不外泄」的护栏之一：调用方拼错参数时，宁可整轮失败，
 * 也不能把一整批照片发出去。24 张足够放下「3 组整组锚点 + 一对考题」，
 * 又远小于任何一批真实照片的规模。
 */
export const MAX_JPEGS_PER_CALL = 24

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
  }

  /**
   * Text-only probe for adapter routing, credentials, and required tool calls.
   * This must pass before any JPEG is saved or sent. It is intentionally not a
   * silent text-JSON fallback: scoring accepts the same tool-call protocol.
   */
  async preflight(signal?: AbortSignal): Promise<HarnessVisionPreflight> {
    await this.assertLocalCapabilities(signal)
    const nonce = randomUUID()
    const payload = await this.callTool({
      system: 'You are a capability probe. Call the supplied tool exactly once. Do not answer with text.',
      user: `Call photo_filter_model_preflight with ok=true and nonce=${nonce}. No image is attached.`,
      jpegs: [],
      tool: {
        name: 'photo_filter_model_preflight',
        description: 'Confirm that this exact routed model can produce required structured tool arguments.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'nonce'],
          properties: {
            ok: { type: 'boolean', enum: [true] },
            nonce: { type: 'string', enum: [nonce] },
          },
        },
      },
      maxTokens: 80,
    }, signal)
    if (payload.ok !== true || payload.nonce !== nonce) {
      throw new HarnessVisionError('模型预检工具返回值不匹配；图片尚未发送。', {
        code: 'MODEL_PREFLIGHT_MISMATCH',
      })
    }
    this.preflightPassed = true
    return Object.freeze({
      route: this.route,
      imageInput: true,
      structuredToolCall: true,
      dynamicRouteProbe: true,
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
    // 上限从 2 提到 MAX_JPEGS_PER_CALL。
    //
    // 原来的 2 是 v3 的设计（1 张基线 / 2 张对比）。v4 一次要发的更多：
    //   · 每张照片 2 幅（整幅 + 高清人脸）—— 512px 上人脸只剩 30 像素，
    //     不配人脸特写模型判不了表情
    //   · 加上锚点范例（几组「这个人自己怎么挑的」）
    // 一次典型调用是 18 张：3 组整组锚点 14 张 + 考题 2 张 × 2 幅。
    //
    // 上限保留而不是取消 —— 它是防止误把整批照片发出去的护栏，
    // 而「照片不外泄」是这个项目的硬约束。
    if (request.jpegs.length < 1 || request.jpegs.length > MAX_JPEGS_PER_CALL) {
      throw new HarnessVisionError(
        `一次视觉调用最多 ${MAX_JPEGS_PER_CALL} 张 JPEG，这次给了 ${request.jpegs.length} 张。`,
        { code: 'INVALID_IMAGE_COUNT' },
      )
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
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.user }]
    for (const attachment of refs) content.push({ type: 'image', attachment })
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
      tools: [request.tool],
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
    return parseToolArguments(blocks, request.tool.name)
  }
}

/** Provider-neutral backpressure/limit signals stop new paid work. */
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
