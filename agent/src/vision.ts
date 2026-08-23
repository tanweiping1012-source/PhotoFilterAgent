/**
 * 视觉打分客户端（MiniMax，OpenAI 兼容的 chat completions）。
 *
 * 为什么由工具自己调用视觉模型，而不是把图片交回给 harness 的循环模型：
 * 图片一旦进入对话历史，之后**每一轮都要重发**。100 次 inspect 就是 100 份图片
 * 反复穿过上下文。工具自己调用、只把紧凑的五维分交回循环，历史里就只剩数字。
 *
 * 发出去的永远是引擎生成的无元数据缩放 JPEG：不含原图、文件名、路径、GPS 与拍摄时间。
 * @module
 */

const ENDPOINT = 'https://api.minimaxi.com/v1/chat/completions'

/** 五个互相独立的审美维度，0–100。总分不由模型给，由本地加权算出。 */
export interface Dimensions {
  moment: number
  composition: number
  subject: number
  lighting: number
  storytelling: number
}

export interface PhotoScore {
  id: string
  dimensions: Dimensions
  reasons: string[]
  summary: string
}

export class VisionError extends Error {}

const SHARED_ANCHOR = `锚点：80 分等同专业摄影师的交付水准；普通旅行快照通常落在 60–75，
不要因为画面讨喜或有纪念意义而抬分。只给五个维度分，不要给总分或名次——总分由 App 按用户权重本地计算。
不得比较图片，不得使用"相比、更好、本组、优先"等相对表述。只返回 JSON，不要 Markdown 代码块。`

/** 人像标尺。和风景分开，因为决定一张人像成败的东西风景照里根本不存在。 */
const PEOPLE_PROMPT = `你在帮一个人从自己的旅行照片里挑出值得留下的几张。照片里的人是他自己或同行的人。

先判断有没有硬伤。以下任意一条成立，就是硬伤：
- 眼睛闭着、半闭、或明显在眨眼的中途
- 脸被头发、手、物体遮住，或严重逆光成剪影看不清五官
- 脸部失焦（背景是清楚的而脸是糊的）
- 表情僵硬到失真：说话说到一半的口型、被抓拍到的怪表情

**有硬伤时，主体分必须低于 40，瞬间分必须低于 45。**
这类照片是废片，不是风格。不要因为"自然""不摆拍""有情绪""有生活感""闭目沉思"
之类的理由给它加分——用户想要的是能拿出去看的照片，不是候选帧。

没有硬伤时，按五个维度打分：
- **瞬间**：表情和姿态是不是这一刻最好的状态。眼神有没有落点，笑是不是到眼睛里
- **构图**：人在画面里的位置、留白、背景有没有干扰物（电线杆、路人、垃圾桶）
- **主体**：人是不是清楚的视觉中心。脸的清晰度、肤色、有没有被环境淹没
- **光线**：脸上的光。顺光/侧光/逆光处理得如何，有没有难看的阴影或过曝
- **叙事**：这张照片能不能让人想起这次旅行。环境有没有交代地点和氛围

${SHARED_ANCHOR}`

/** 风景标尺。 */
const SCENERY_PROMPT = `你在帮一个人从自己的旅行照片里挑出值得留下的风景照。

按五个维度打分：
- **瞬间**：光线、天气、人流的时机。是不是这个场景最好的一刻
- **构图**：取景、水平、透视、前中后景的层次
- **主体**：画面有没有明确的视觉重心，还是一片平均的杂乱
- **光线**：整体影调、动态范围、有没有死黑或死白
- **叙事**：看得出这是哪里、什么季节、什么氛围吗

${SHARED_ANCHOR}`

/** 比较用的系统提示。这里主动解禁相对表述——比较正是它存在的理由。 */
const COMPARE_PROMPT = `你在帮一个人从同一场景的连拍里挑出最好的一张。

**判断顺序**：先看有没有人。有人的话，第一优先是脸——眼睛睁开、表情自然、脸没被遮挡、
脸是清楚的。只有在这些都相当的情况下，才去比构图、光线和背景。

一组连拍里经常只有一两张眼睛是睁开的，其余都是眨眼的瞬间。**把睁眼的挑出来，
不要因为闭眼那张"更有情绪"就选它。**

只返回 JSON，不要 Markdown 代码块。`

/** 单张打分的用户提示。附图在文本之后。 */
function scorePrompt(id: string, category: 'people' | 'scenery'): string {
    const hint = category === 'people'
      ? '若存在硬伤（闭眼／遮挡／脸失焦／表情失真），reasons 第一条必须直接指出是哪一条。'
      : ''
    return `评分这一张匿名照片（id: ${id}，类型：${category === 'people' ? '人物' : '风景'}）。
${hint}
只返回：{"id":"${id}","dimensions":{"moment":0,"composition":0,"subject":0,"lighting":0,"storytelling":0},"reasons":["…","…"],"summary":"…"}
reasons 是 1–3 条、每条 2–40 字的具体中文评价；summary 是 4–60 字的中文总结，只评价这一张自己。`
}

/** 家族内比较：这里**主动解禁**相对表述——比较正是这个工具存在的理由。 */
function comparePrompt(ids: string[], question: string): string {
  return `下面 ${ids.length} 张是同一场景的连拍（顺序对应 id：${ids.join('、')}）。
${question}
连拍之间的差别通常在表情、眼神、手的位置、主体姿态，而不是清晰度。请据此判断。
只返回：{"winner":"<id>","reason":"<30 字以内的具体理由>","order":["<最好>","…"]}`
}

interface ChatChoice {
  message?: { content?: string }
}

interface ChatResponse {
  choices?: ChatChoice[]
  base_resp?: { status_code?: number; status_msg?: string }
}

/** 从可能带围栏或前后缀的模型输出里取出第一个 JSON 对象。 */
function parseJsonObject(text: string): unknown {
  // 即使关掉 thinking，仍要防住偶发的 <think> 段落与围栏：推理里几乎必然出现花括号，
  // 直接取“第一个 { 到最后一个 }”会把推理片段一起吞进来。
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/giu, '')
  const trimmed = withoutThinking.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')

  // 从后往前找最后一个成对的顶层 JSON 对象——结论总在推理之后。
  for (let end = trimmed.lastIndexOf('}'); end >= 0; end = trimmed.lastIndexOf('}', end - 1)) {
    let depth = 0
    for (let start = end; start >= 0; start -= 1) {
      const ch = trimmed[start]
      if (ch === '}') depth += 1
      else if (ch === '{') {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, end + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  throw new VisionError('模型输出里没有可解析的 JSON 对象')
}

function clampScore(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) throw new VisionError('维度分不是数字')
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export interface VisionOptions {
  apiKey: string
  model?: string
  /** 单次请求超时。默认 90 秒——超时会自动重试，等于把同一批图片重新付费发一遍。 */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class VisionClient {
  private readonly model: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: VisionOptions) {
    this.model = options.model ?? 'MiniMax-M3'
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async chat(
    systemPrompt: string,
    userText: string,
    images: string[],
    detail: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const parts: unknown[] = [{ type: 'text', text: userText }]
    for (const base64 of images) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${base64}`, detail },
      })
    }

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: parts },
          ],
          temperature: 0.1,
          // M3 默认会先输出一整段 <think> 推理，既烧 token 又把 JSON 挤出截断边界。
          // 打分要的是结论不是推理过程，直接关掉。
          thinking: { type: 'disabled' },
          reasoning_split: true,
          max_completion_tokens: 1_200,
        }),
        signal: composed,
      })
    } catch (error) {
      throw new VisionError(`视觉请求失败: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      // 正文可能带 Key 回显或供应商内部细节，只取状态码。
      throw new VisionError(`视觉服务返回 HTTP ${response.status}`)
    }
    const payload = (await response.json()) as ChatResponse
    // MiniMax 会在 HTTP 200 上用 base_resp 表达业务失败（额度、限流）。
    const status = payload.base_resp?.status_code
    if (status !== undefined && status !== 0) {
      throw new VisionError(`视觉服务拒绝请求（MiniMax-${status}）`)
    }
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new VisionError('视觉服务没有返回内容')
    return content
  }

  /** 给一张照片打五维分。 */
  async score(
    id: string,
    jpegBase64: string,
    detail: 'low' | 'high',
    category: 'people' | 'scenery',
    signal?: AbortSignal,
  ): Promise<PhotoScore> {
    // 人像和风景用不同标尺：决定一张人像成败的东西（眼睛、表情、脸上的光）
    // 在风景照里根本不存在，共用一套标尺等于让模型自己去猜该看什么。
    const systemPrompt = category === 'people' ? PEOPLE_PROMPT : SCENERY_PROMPT
    const raw = await this.chat(systemPrompt, scorePrompt(id, category), [jpegBase64], detail, signal)
    const parsed = parseJsonObject(raw) as Record<string, unknown>
    const dimensions = parsed.dimensions as Record<string, unknown> | undefined
    if (!dimensions) throw new VisionError('返回里缺少 dimensions')
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === 'string').slice(0, 3)
      : []
    return {
      id,
      dimensions: {
        moment: clampScore(dimensions.moment),
        composition: clampScore(dimensions.composition),
        subject: clampScore(dimensions.subject),
        lighting: clampScore(dimensions.lighting),
        storytelling: clampScore(dimensions.storytelling),
      },
      reasons,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    }
  }

  /** 在一组连拍里挑出最好的一张。产物只进上下文，不进分数库。 */
  async compare(
    ids: string[],
    jpegs: string[],
    question: string,
    signal?: AbortSignal,
  ): Promise<{ winner: string; reason: string; order: string[] }> {
    const raw = await this.chat(COMPARE_PROMPT, comparePrompt(ids, question), jpegs, 'low', signal)
    const parsed = parseJsonObject(raw) as Record<string, unknown>
    const winner = typeof parsed.winner === 'string' && ids.includes(parsed.winner)
      ? parsed.winner
      : ids[0]
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((o): o is string => typeof o === 'string' && ids.includes(o))
      : []
    return {
      winner,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      order: order.length ? order : ids,
    }
  }
}

/** 五维按权重加权成总分。整数运算，跨机器可复现。 */
export function weightedTotal(
  dimensions: Dimensions,
  weights: Dimensions = { moment: 3, composition: 3, subject: 3, lighting: 3, storytelling: 3 },
): number {
  const pairs: [number, number][] = [
    [dimensions.moment, weights.moment],
    [dimensions.composition, weights.composition],
    [dimensions.subject, weights.subject],
    [dimensions.lighting, weights.lighting],
    [dimensions.storytelling, weights.storytelling],
  ]
  const weightSum = pairs.reduce((sum, [, w]) => sum + w, 0)
  if (weightSum === 0) return 0
  const weighted = pairs.reduce((sum, [value, w]) => sum + value * w, 0)
  // (2·加权和 + 权重和) / (2·权重和) 等价于四舍五入，且不经过浮点。
  return Math.floor((2 * weighted + weightSum) / (2 * weightSum))
}
