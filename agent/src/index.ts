/**
 * 照片策展工具集：把本地分析引擎与视觉打分接成 DeepSeek Harness 的模型可见工具。
 *
 * 分工：harness 提供循环、会话与工具管线；这个插件提供领域能力。
 *
 * 三条不随配置放宽的边界：
 * - **原图只读**——工具集里没有任何修改、移动或删除原图的工具，`export` 只复制。
 * - **照片不外泄**——发出去的只有引擎生成的无元数据缩放 JPEG；文件名、路径、
 *   绝对拍摄时间与 GPS 都不出本机。
 * - **不重复计费**——同一张同档位已有分数时直接命中缓存，并在结果里如实标注。
 * @module @photo-filter-agent/dsh-photo-filter-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveVisionApiKey } from './apikey.ts'
import { PhotoEngine, type Candidate } from './engine.ts'
import { mapWithConcurrency } from './pool.ts'
import { loadState, RunState, saveState, validateProposal, type Category } from './state.ts'
import { VisionClient, weightedTotal } from './vision.ts'

export const name = 'photo-filter-agent'
export const inject = ['tools']

export interface Config {
  /** `photofilter` 可执行文件路径。 */
  engineBinary: string
  /** 引擎工作目录：匿名 ID ↔ 路径的映射存在这里，不进模型上下文。 */
  workdir: string
  /** 视觉模型 ID。 */
  visionModel: string
  /** 允许回落到 macOS Keychain 读取 Key。会弹图形授权框，无人值守时应保持关闭。 */
  allowKeychain: boolean
  /** 一次 inspect 最多几张，避免模型一次要走整池。 */
  maxInspectBatch: number
  /** 打分的并发路数。开满会换来一串 429 再触发退避，反而更慢。 */
  inspectConcurrency: number
  /** analyze_folder 摘要里直接列出 ID 的上限；超过就只给区间，让模型去 list_candidates。 */
  maxInlineIdList: number
  /** 单次视觉请求超时（毫秒）。 */
  visionTimeoutMs: number
  /** 一轮策展默认的保留目标。 */
  defaultPeopleTarget: number
  defaultSceneryTarget: number
}

export const Config: z<Config> = z.object({
  engineBinary: z.string().default('photofilter'),
  workdir: z.string().default('/tmp/photo-filter-agent'),
  visionModel: z.string().default('MiniMax-M3'),
  allowKeychain: z.boolean().default(false),
  maxInspectBatch: z.number().step(1).min(1).max(32).default(8),
  inspectConcurrency: z.number().step(1).min(1).max(16).default(4),
  maxInlineIdList: z.number().step(1).min(0).default(80),
  visionTimeoutMs: z.number().step(1).min(1_000).default(90_000),
  defaultPeopleTarget: z.number().step(1).min(1).default(6),
  defaultSceneryTarget: z.number().step(1).min(1).default(6),
})

/** 候选表里给模型看的一行：只有匿名 ID 与本地事实。 */
function row(candidate: Candidate): string {
  const parts = [
    candidate.id,
    candidate.category === 'people' ? '人物' : '风景',
    `清晰${candidate.sharp}`,
    `宽容${candidate.range}`,
    `过曝${candidate.clip}`,
  ]
  if (candidate.family) parts.push(`连拍${candidate.family}`)
  if (candidate.risk.length) parts.push(`风险:${candidate.risk.join(',')}`)
  if (candidate.face) parts.push(candidate.face)
  if (candidate.eyes_closed) parts.push('⚠硬伤:闭眼')
  if (candidate.local_top) parts.push('本地优等')
  if (candidate.t !== undefined) parts.push(`+${candidate.t}s`)
  return parts.join(' ')
}

export function apply(ctx: Context, config: Config): void {
  const engine = new PhotoEngine(config.engineBinary, config.workdir)
  const state = new RunState()
  state.targets = { people: config.defaultPeopleTarget, scenery: config.defaultSceneryTarget }

  /** 视觉客户端按需创建：没有 Key 时返回 undefined，调用方走本地兜底。 */
  let visionCache: VisionClient | null | undefined
  async function vision(): Promise<VisionClient | undefined> {
    if (visionCache !== undefined) return visionCache ?? undefined
    const lookup = await resolveVisionApiKey({ allowKeychain: config.allowKeychain })
    visionCache = lookup.key
      ? new VisionClient({
          apiKey: lookup.key,
          model: config.visionModel,
          timeoutMs: config.visionTimeoutMs,
        })
      : null
    return visionCache ?? undefined
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          photo_count: { type: 'number' },
          people_count: { type: 'number' },
          scenery_count: { type: 'number' },
          family_count: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const report = await engine.analyze(args.folder, args.limit, exec.signal)
      state.absorb(report, args.folder, args.limit)
      // 分数是花过钱的资产：同一目录、同一取样上限下已经打过的分要接着用，
      // 否则每开一个新会话就把同一批照片重新买一遍。
      const restored = await loadState(state, config.workdir, args.folder, args.limit)
      if (args.people_target) state.targets.people = args.people_target
      if (args.scenery_target) state.targets.scenery = args.scenery_target
      await saveState(state, config.workdir)
      const multi = report.families.filter((f) => f.members.length > 1)
      // 摘要里不给 ID，模型就只能凭空猜（实测它造出了 people_01 这种不存在的编号，
      // 白白多花两步往返）。ID 是它下一步唯一能用的抓手，必须直接给出来。
      const listing = (category: 'people' | 'scenery') => {
        const ids = report.candidates.filter((c) => c.category === category).map((c) => c.id)
        if (!ids.length) return ''
        const label = category === 'people' ? '人物' : '风景'
        if (ids.length <= config.maxInlineIdList) {
          return `${label} ${ids.length} 张：${ids.join(' ')}\n`
        }
        return `${label} ${ids.length} 张：${ids[0]} … ${ids[ids.length - 1]}` +
          `（太多不全列，用 list_candidates 取）\n`
      }
      const resumed = restored && state.scores.size
        ? `\n已恢复上次的 ${state.scores.size} 张打分与 ${state.championByFamily.size} 个连拍组结论，不会重复计费。\n`
        : ''
      const closedEyes = report.candidates.filter((c) => c.eyes_closed).length
      const banner = multi.length
        ? `\n⚠ 发现 ${multi.length} 组连拍，已默认折叠——每组只有一张露在候选池里，\n` +
          `其余不参与竞争。连拍之间的差别在表情、眼神、手的位置，绝对打分分不出来。\n` +
          `**下一步请对每组调 compare 比较，再用 resolve_family 定代表**，然后才开始 inspect。\n`
        : ''
      const eyeNote = closedEyes
        ? `⚠ 本机已判定 ${closedEyes} 张人物照眼睛闭合（候选表里标了 eyes_closed）。这是硬伤，别选它们。\n`
        : ''
      const summary =
        `已在本机分析 ${report.photo_count} 张：人物 ${report.people_count} · 风景 ${report.scenery_count}。\n` +
        resumed + banner + eyeNote +
        `目标：人物 ${state.targets.people} 张 · 风景 ${state.targets.scenery} 张。\n\n` +
        listing('people') + listing('scenery') +
        (multi.length
          ? `连拍组：${multi.map((f) => `${f.id}[${f.members.join(' ')}]`).join('  ')}\n`
          : '') +
        `\n` + state.render()
      return {
        photo_count: report.photo_count,
        people_count: report.people_count,
        scenery_count: report.scenery_count,
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
    async execute(args) {
      const category = args.category === 'people' || args.category === 'scenery'
        ? (args.category as Category)
        : undefined
      let pool = state.active(category)
      if (args.family) pool = pool.filter((c) => c.family === args.family)
      if (!pool.length) return '没有符合条件的候选。先运行 analyze_folder。'
      const head = `${pool.length} 张候选（清晰/宽容/过曝为 0–100 的本地指标，越高越好，过曝越低越好）：`
      return [head, ...pool.map(row)].join('\n')
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
    async execute() {
      return state.render()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inspect',
    description:
      '让视觉模型给若干张照片打五维分（瞬间/构图/主体/光线/叙事），0–100。这一步会花钱。' +
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
      const detail: 'low' | 'high' = args.detail === 'high' ? 'high' : 'low'
      const ids = args.photo_ids.slice(0, config.maxInspectBatch)
      const client = await vision()
      if (!client) {
        return '视觉模型不可用：没有找到 API Key。请设置环境变量 MINIMAX_API_KEY 后重试，或改用本地确定性选片（propose 会自动兜底）。'
      }

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
            const category = state.candidates.get(id)?.category ?? 'scenery'
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
      const ids = args.photo_ids.slice(0, 4)
      if (ids.length < 2) return '至少需要两张照片才能比较。'
      const client = await vision()
      if (!client) return '视觉模型不可用：没有找到 API Key。'
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
      '为一个连拍组定下代表。同组其余照片退出候选——这个瞬间仍然保留着，只是换了一张代表，所以是安全操作。',
    parameters: {
      family: { type: 'string', required: true, description: '连拍组 ID，例如 F03' },
      winner: { type: 'string', required: true, description: '留下的那一张' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
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
      '给出最终保留名单与理由，结束这一轮策展。会做五项校验：都在候选池里、都被看过、同一连拍组不超过一张、不超目标、每张有理由。校验不过会告诉你哪里错了，可以改了再提。',
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
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const verdict = validateProposal(state, args.keep)
      if (!verdict.ok) {
        return { accepted: false, message: `提议未通过校验：${verdict.reason}\n请修正后重新 propose。` }
      }
      const why: Record<string, string> = {}
      args.keep.forEach((id, offset) => { why[id] = args.why[offset] ?? '' })
      state.proposal = { keep: args.keep, why }
      await saveState(state, config.workdir)

      const lines = args.keep.map((id) => {
        const candidate = state.candidates.get(id)
        const total = state.total(id)
        return `  ${id}  ${candidate?.category === 'people' ? '人物' : '风景'}  ` +
          `${total !== undefined ? `总分 ${total}` : '（无 AI 分）'}  ${why[id]}`
      })
      return {
        accepted: true,
        message: [
          `保留名单已确定，共 ${args.keep.length} 张：`,
          ...lines,
          '',
          `花费：打分 ${state.paidCalls.inspect} 次 · 比较 ${state.paidCalls.compare} 次 · 缓存省下 ${state.paidCalls.cached} 次`,
          '如需导出副本，调用 export_selection。原图不会被移动、删除或修改。',
        ].join('\n'),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'export_selection',
    description:
      '把已确定的保留名单复制到目标目录。只复制——原图不移动、不删除、不改名、不写回。',
    parameters: {
      destination: { type: 'string', required: true, description: '导出目标目录的绝对路径' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!state.proposal && state.folder) {
        await loadState(state, config.workdir, state.folder, state.limit)
      }
      if (!state.proposal) return '还没有确定的保留名单，先调用 propose（或先 analyze_folder 恢复上次的进度）。'
      const result = await engine.export(state.proposal.keep, args.destination, exec.signal)
      return `已复制 ${result.count} 张到 ${result.destination}：\n` +
        result.copied.map((c) => `  ${c.filename}`).join('\n') +
        '\n原图未被移动、删除或修改。'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'local_fallback_selection',
    description:
      '不联网、不花钱的确定性选片：按本地技术指标（清晰度/宽容度/过曝）加连拍组去重排出名次。' +
      '没有 API Key 时用它完成策展；有 Key 时它是 agent 失败的兜底。注意：技术指标与人的口味相关性很弱。',
    parameters: {
      people: { type: 'number', description: '人物保留几张' },
      scenery: { type: 'number', description: '风景保留几张' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (!state.folder) return '先运行 analyze_folder。'
      const report = await engine.select(
        state.folder,
        args.people ?? state.targets.people,
        args.scenery ?? state.targets.scenery,
        state.limit,
        exec.signal,
      )
      state.proposal = {
        keep: report.keep,
        why: Object.fromEntries(report.keep.map((id) => [id, '本地技术指标排名靠前'])),
      }
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
