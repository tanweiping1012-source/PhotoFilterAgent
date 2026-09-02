/**
 * 照片筛选 v4：把本地确定性排序器接成 DeepSeek Harness 的模型可见工具。
 *
 * 和 v3 最大的差别不在算法，在**分工**：
 *
 *   v3 —— 模型给每张照片打 0–100 分，18 个工具围绕「怎么让这些分数可信」建设：
 *          双向盲比、Bradley-Terry、独立盲审、账本、熔断、凭证。
 *          实测这些分数的重评噪声 σ=7.28，而照片之间的真实差异只有 σ=6.72，
 *          所以整套机制建在噪声上，最终 AUC 0.497（= 掷硬币）。
 *
 *   v4 —— 排序是本机的确定性函数，模型一张照片都不看。工具只有 5 个，
 *          agent 负责的是「听懂意图、选参数、解释结果」，不负责打分。
 *
 * 因为排序确定，v3 那一整套让噪声可信的机制在这里都不需要 ——
 * 确定性函数用单元测试就能验证（ranker/tests/，28 个，1.5 秒）。
 *
 * 三条边界与 v3 一致：原图只读、照片不外泄、结果可复现。
 * @module @photo-filter-agent/dsh-photo-filter-v4
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { IdentityMap } from './identity.ts'
import { comparePairs, type AnchorBlock } from './compare.ts'
import type { HarnessVisionExecution, HarnessVisionServices } from './harness-vision.ts'
import { Ranker, RankerError, type RankResult } from './ranker.ts'

export const name = 'photo-filter-v4'
// llm/attachments 只被 compare_within_groups 用到 —— 那是整条链路里唯一花钱的工具。
export const inject = ['tools', 'llm', 'attachments']

export interface Config {
  /** 排序器目录（含 photofilter_rank 包）。 */
  rankerDir: string
  /** 跑排序器的 Python 解释器绝对路径。 */
  python: string
  /** 匿名映射与导出票据放这里，不进模型上下文。 */
  workdir: string
  /** 模型/缓存目录。 */
  cacheDir: string
  /** 只允许处理这些根目录下的照片。 */
  allowedRoots: string[]
  /** 枚举阶段就排除的相对路径（人工答案子目录必须在这里）。 */
  excludedRelativePaths: string[]
  /** 允许导出到的根目录；空表示禁止导出。 */
  allowedExportRoots: string[]
  /**
   * Swift 本地分析引擎路径，用于闭眼资格门（免费、不联网）。
   *
   * 不配的话资格门不生效。实测代价：20 张名单里 6 张闭眼（基准率 8.2%），
   * 而用户自己的 20 张精选里闭眼 0 张 —— 交付命中从 4/20 掉到 3/20。
   */
  engineBinary: string
  /** 单次排序器调用超时（毫秒）。首次跑要下模型 + 建缓存，给足。 */
  rankerTimeoutMs: number
  /** 默认保留几张。 */
  defaultTarget: number
  /**
   * 锚点范例文件。非空则**默认启用** —— 组内比较时把「这个人怎么挑的」
   * 连图带原话放进提示词。
   *
   * 实测：光是把提示词里的序数歧义去掉（第一张/第二张 → 照片甲/乙），
   * AB/BA 一致率就从 23% 翻到 45%。锚点是同一个方向的改进 ——
   * 与其让模型猜判据，不如直接示范。
   */
  anchorsFile: string
  /**
   * 阶段 2 的组内比较是否默认用视觉模型。
   *
   * ⚠️ 这一档**没有通过自己的验收线**：实测 AB/BA 一致率 45%，通过线是 60%。
   * 默认开启是产品决定，不是数据支持的结论。agent 必须在报告里如实说明。
   */
  stage2Vlm: boolean
  /** 摘要里直接列 ID 的上限。 */
  maxInlineIdList: number
  /**
   * 阶段 2 的成对评测考题文件。**非空才注册评测工具**。
   *
   * 生产 profile 不设这一项，agent 就看不见这个工具 —— 评测脚手架不该
   * 出现在真实用户的工具面上。
   */
  evalPairsFile: string
  /** 考题文件所在目录。给了之后 run_pair_eval 可以按**文件名**换一份考题，
   *  不用改 profile 重启 DSH。只接受纯文件名，不接受路径 —— 不能变成任意读文件。 */
  evalPairsDir: string
}

export const Config: z<Config> = z.object({
  rankerDir: z.string(),
  python: z.string(),
  workdir: z.string().default('/tmp/photo-filter-v4'),
  cacheDir: z.string().default('/tmp/photo-filter-v4-cache'),
  allowedRoots: z.array(z.string()).default([]),
  excludedRelativePaths: z.array(z.string()).default([]),
  allowedExportRoots: z.array(z.string()).default([]),
  engineBinary: z.string().default(''),
  rankerTimeoutMs: z.number().step(1).min(10_000).default(900_000),
  defaultTarget: z.number().step(1).min(1).default(20),
  anchorsFile: z.string().default(''),
  stage2Vlm: z.boolean().default(true),
  maxInlineIdList: z.number().step(1).min(0).default(60),
  evalPairsFile: z.string().default(''),
  evalPairsDir: z.string().default(''),
})

/** 一次会话内的运行状态。只存在内存里，工具之间靠它传递上下文。 */
interface RunState {
  folder?: string
  fingerprint?: string
  ids?: IdentityMap
  last?: RankResult
  labels: string[]
  style: string
  exportTicket?: { code: string; dest: string; names: string[] }
}

/** 读锚点配置。文件不存在或格式不对就返回 null —— 锚点是增强，不是必需。 */
function readAnchors(file: string):
  { folder: string; text: string; photos: string[]; labels: Record<string, string> } | null {
  if (!file || !existsSync(file)) return null
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    if (!d.text || !Array.isArray(d.photos) || !d.photos.length) return null
    return {
      folder: String(d.folder ?? ''), text: String(d.text), photos: d.photos.map(String),
      labels: (d.labels ?? {}) as Record<string, string>,
    }
  } catch { return null }
}

export function apply(ctx: Context, config: Config): void {
  const ranker = new Ranker(
    config.python, config.rankerDir, config.cacheDir, config.rankerTimeoutMs,
    config.engineBinary || undefined,
  )
  const state: RunState = { labels: [], style: 'quality' }

  /** 目录必须落在授权根目录内。这是结构约束，不靠 agent 自觉。 */
  const loadAnchors = () => readAnchors(config.anchorsFile)

  /**
   * 锚点 → 提示词块。**生产路径和评测路径必须走这一个函数。**
   *
   * 它存在的唯一理由是防止两边再次分叉。已经踩过三次，全都是评测那一路
   * 悄悄落后于生产那一路 —— 而评测正是用来证明生产有没有变好的，
   * 评测用了残废的锚点，测出来的「锚点没用」就是假的：
   *   ① 少传 withFace  → 锚点上人脸只有 24 像素，文字说「闭眼」模型看不到证据
   *   ② 少传 labels    → 14 张照片没烧名字，模型只能自己数第几幅
   *   ③ 用考题的 folder 去取锚点图 —— 锚点根本在另一个目录，取不到
   */
  async function buildAnchorBlock(
    anchors: { folder: string; text: string; photos: string[]; labels: Record<string, string> } | null,
    signal: AbortSignal | undefined,
  ): Promise<AnchorBlock | null> {
    if (!anchors || !anchors.photos.length) return null
    const ap = await ranker.preview(
      anchors.folder, anchors.photos, config.excludedRelativePaths, 512, signal, true,
      anchors.labels,
    )
    return {
      text: anchors.text,
      jpegs: anchors.photos.flatMap((x) =>
        [ap.previews[x], ap.faces[x]].filter(Boolean) as string[]),
    }
  }

  function assertAllowed(folder: string, roots: string[], what: string): string {
    const abs = resolvePath(folder)
    if (!roots.length) throw new Error(`没有配置任何${what}授权目录，拒绝执行。`)
    const ok = roots.some((r) => {
      const root = resolvePath(r)
      return abs === root || abs.startsWith(root + '/')
    })
    if (!ok) throw new Error(`${abs} 不在授权的${what}目录内。授权范围：${roots.join(' , ')}`)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${abs} 不存在或不是目录。`)
    return abs
  }

  function fail(e: unknown): never {
    if (e instanceof RankerError) {
      throw new Error(`${e.message}\n排序器输出（尾部）：\n${e.detail}`)
    }
    throw e
  }

  function requireRanked(): { res: RankResult; ids: IdentityMap } {
    if (!state.last || !state.ids) throw new Error('还没有排序结果，请先调用 rank_photos。')
    return { res: state.last, ids: state.ids }
  }

  // ── 工具 1：本地扫描 ────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'scan_folder',
    description:
      '在本机扫描一个照片目录：数一共多少张、生成数据集指纹、建立匿名编号。' +
      '完全免费、不联网、不发送任何照片，也不做任何评分。策展的第一步。',
    parameters: {
      folder: { type: 'string', required: true, description: '照片目录的绝对路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n_photos: { type: 'number' },
          fingerprint: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args, exec) {
      const folder = assertAllowed(args.folder, config.allowedRoots, '照片')
      try {
        const scan = await ranker.scan(folder, config.excludedRelativePaths, exec.signal)
        const ids = IdentityMap.load(config.workdir, scan.fingerprint)
        ids.assign(scan.names)
        state.folder = folder
        state.fingerprint = scan.fingerprint
        state.ids = ids
        state.last = undefined
        const excluded = config.excludedRelativePaths.length
          ? `已在枚举阶段排除：${config.excludedRelativePaths.join(' , ')}\n`
          : ''
        return {
          n_photos: scan.n_photos,
          fingerprint: scan.fingerprint,
          summary:
            `已扫描 ${scan.n_photos} 张照片，数据集指纹 ${scan.fingerprint}。\n` +
            excluded +
            `已建立 ${ids.size} 个匿名编号（p001…）。真实文件名只在本机，不进对话。\n` +
            `这一步没有评分、没有联网、没有花钱。\n\n` +
            `下一步：调用 rank_photos 排序。默认目标 ${config.defaultTarget} 张。`,
        }
      } catch (e) { fail(e) }
    },
  }))

  // ── 工具 2：排序 ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'rank_photos',
    description:
      '在本机对已扫描的目录排序并挑出最好的 N 张。完全免费、零模型调用、不发送任何照片。' +
      '用户没说风格就用 quality 直接跑 —— **不要卡住问**，排序 1.5 秒且不花钱，' +
      '让用户看着真实结果说「不是这个感觉」，比让他凭空回答一个分类问题容易得多。' +
      '出结果后用一句话提供切换到 mood 即可。' +
      '闭眼照会被资格门挡在名单外。同一场景组默认最多入选 2 张。结果是确定性的。',
    parameters: {
      target: { type: 'number', description: `要挑几张（默认 ${config.defaultTarget}）` },
      style: {
        type: 'string',
        description:
          'quality = 挑拍得清楚、人脸好看的（默认）；mood = 挑有氛围的（弱光、动态、颗粒、柔焦这类）。' +
          '这两种给出的名单几乎完全不同（实测重叠 0/20 和 4/20）。用户明确说了就用对应的；' +
          '没说就用 quality 跑出来给他看，再提供切换 —— 不要为了问这个而不给结果。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selected_ids: { type: 'array', items: { type: 'string' } },
          mode: { type: 'string' },
          n_candidates: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args, exec) {
      if (!state.folder) throw new Error('请先调用 scan_folder。')
      const target = args.target ?? config.defaultTarget
      try {
        if (args.style && args.style !== 'quality' && args.style !== 'mood') {
          throw new Error(`style 只能是 quality 或 mood，收到 "${args.style}"。`)
        }
        state.style = args.style ?? state.style
        let res = await ranker.rank(
          state.folder, target, config.excludedRelativePaths, state.labels, state.style, exec.signal,
        )

        // ── 阶段 2 的 VLM 复核 ──────────────────────────────────
        //
        // 排序器先用本地分跑完一遍（免费、瞬时），同时产出一份「复核计划」：
        // 哪几组的冠军进了最终名单、而且本地分前两名咬得很紧。
        // 只有这些组值得花钱 —— 全池打完擂台是 157~170 局（314+ 次调用、
        // 约 26 分钟），而绝大多数局根本不影响交给用户的那 20 张。
        //
        // 模型跑在这一侧（TS），排序器在 Python 侧拿不到它，
        // 所以是「出计划 → 这里跑 → 裁决回传 → 排序器重放」三步。
        let refineNote = ''
        let vlmCalls = 0
        const plan = (res.notes.tournament_plan ?? []) as Array<[string, string]>
        if (config.stage2Vlm && plan.length) {
          try {
            const names = [...new Set(plan.flat())]
            // 考题两张的标签在每一局里才确定（谁是甲谁是乙由 comparePairs 决定），
            // 所以这里先不烧；甲/乙 只有两个值，提示词里用「倒数第 N 幅」定位已经够。
            // 锚点不同 —— 14 张照片混在一起，必须烧。
            const { previews, faces, missing } = await ranker.preview(
              state.folder, names, config.excludedRelativePaths, 512, exec.signal, true,
            )
            if (missing.length) throw new Error(`${missing.length} 张缺少预览`)
            const anchorBlock = await buildAnchorBlock(loadAnchors(), exec.signal)
            const services: HarnessVisionServices = {
              llm: ctx.get('llm') as unknown as HarnessVisionServices['llm'],
              attachments: ctx.get('attachments') as unknown as HarnessVisionServices['attachments'],
            }
            const { verdicts, route } = await comparePairs(
              plan, previews, faces, anchorBlock, services,
              exec as unknown as HarnessVisionExecution,
            )
            const vf = join(config.workdir, `verdicts-${res.fingerprint}.json`)
            writeFileSync(vf, JSON.stringify({ verdicts }))
            res = await ranker.rank(
              state.folder, target, config.excludedRelativePaths, state.labels, state.style,
              exec.signal, vf,
            )
            vlmCalls = plan.length * 2
            const flips = verdicts.filter((v) => v.winner === 'b').length
            const cons = verdicts.filter((v) => v.consistent).length
            refineNote =
              `\n\n**阶段 2 · 视觉模型复核**（${route}）：打了 ${plan.length} 局擂台，` +
              `花了 ${plan.length * 2} 次调用，改判 ${flips} 组。\n` +
              `⚠️ 这一档**没有通过自己的验收线**：实测 AB/BA 双向一致率 ` +
              `${((cons / Math.max(verdicts.length, 1)) * 100).toFixed(0)}%（本次）、` +
              `45%（47 对的完整评测），而通过线是 60%。` +
              `也就是说它的判断有相当一部分是噪声，改判不一定是改对。`
          } catch (e) {
            refineNote = `\n\n**阶段 2 · 视觉模型复核未执行**：${e instanceof Error ? e.message : String(e)}。` +
              `已回落到本地分排序（0 次调用、结果确定）。`
          }
        }

        const ids = IdentityMap.load(config.workdir, res.fingerprint)
        ids.assign([...res.ranking].sort())
        state.ids = ids
        state.fingerprint = res.fingerprint
        state.last = res

        const n = res.notes
        const styleText = state.style === 'mood'
          ? '氛围优先 —— 把通用美学分翻转过来。实测在「按氛围挑」的那批照片上，' +
            '6 个通用美学模型全部反向（用户选的照片里有两张排全池倒数第一、第二）。' +
            '⚠️ 这一档只有 4 张金标支撑，2/4、p=0.11，不显著 —— 是可选项，不是已验证的能力。'
          : '质量优先 —— 按人脸拍摄质量排（实测交付 4/20，p=0.032 显著）'
        const modeText = {
          cold: `冷启动（0 张标注）—— 用通用质量指标 ${n.cold_strategy}`,
          blend: `过渡（${res.n_labels} 张标注）—— 个人口味与通用指标混合`,
          personal: `个人口味（${res.n_labels} 张标注）`,
        }[res.mode] ?? res.mode

        const rows = res.selected.map((name, i) => {
          const id = ids.id(name)
          return `${String(i + 1).padStart(2)}. ${id}  分数 ${res.scores[name]?.toFixed(2) ?? '?'}  场景组 F${res.families[name]}`
        }).join('\n')

        const warn = (n.warnings ?? []).map((w) => `\n⚠ ${w}`).join('')
        const gateNote = n.n_blocked
          ? `\n资格门拦下 ${n.n_blocked} 张闭眼照（仍在候选池里参与统计，只是不进名单）。` +
            `这是本机免费检测，不用视觉模型。`
          : ''
        const capNote = n.relaxed
          ? `\n⚠ 同组上限从 2 放宽到 ${n.family_cap_used} 才凑满 ${target} 张（场景组不够多）。`
          : ''
        const famCount = new Set(res.selected.map((x) => res.families[x])).size

        return {
          selected_ids: res.selected.map((x) => ids.id(x)),
          mode: res.mode,
          n_candidates: res.n_candidates,
          summary:
            `挑片风格：${styleText}\n` +
            `模式：${modeText}\n` +
            `候选 ${res.n_candidates} 张 · 场景组 ${n.n_families} 个（最大 ${n.largest_family} 张）· 耗时 ${res.elapsed_sec}s\n` +
            // 调用次数必须**算出来**，不能写死。
            //
            // 踩过的坑：这里原本硬编码「付费模型调用 0 次」。VLM 复核默认打开之后，
            // 一次真实运行花了 114 次调用，而 agent 照旧告诉用户「0 次、全在本机算完」——
            // 等于把成本瞒了下来。人设里另有五处同样的写死，一并清了。
            (vlmCalls > 0
              ? `**付费模型调用 ${vlmCalls} 次** —— 阶段 2 的组内比较用了视觉模型。\n`
              : `**付费模型调用 0 次** —— 全程在本机算完。\n`) +
            warn + gateNote + capNote + refineNote + `\n\n` +
            `选出 ${res.selected.length} 张，分布在 ${famCount} 个不同场景组：\n${rows}\n\n` +
            `分数是标准化后的相对值，不是绝对质量分：+1.8 表示明显高于这批照片的平均水平。\n` +
            `想看某几张为什么入选、或边界上差了什么，调 explain_ranking。`,
        }
      } catch (e) { fail(e) }
    },
  }))

  // ── 工具 3：解释 ────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'explain_ranking',
    description:
      '解释排序结果：某几张照片的分数、名次、所属场景组和组内排名；' +
      '不给 ID 时显示入选边界附近的照片（最后入选的和最先落选的）。免费。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '要解释的匿名编号，如 ["p012","p045"]' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { summary: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args) {
      const { res, ids } = requireRanked()
      const rank = new Map(res.ranking.map((n, i) => [n, i + 1]))
      const selectedSet = new Set(res.selected)
      const famMembers = new Map<number, string[]>()
      for (const n of res.ranking) {
        const f = res.families[n]
        if (!famMembers.has(f)) famMembers.set(f, [])
        famMembers.get(f)!.push(n)
      }

      let names: string[]
      let header: string
      if (args.ids?.length) {
        const r = ids.resolve(args.ids)
        if (r.unknown.length) {
          return { summary: `这些编号不存在：${r.unknown.join(' ')}。请只使用 rank_photos 返回过的编号。` }
        }
        names = r.names
        header = `查询 ${names.length} 张：`
      } else {
        const lastIn = res.selected.slice(-3)
        const firstOut = res.ranking.filter((n) => !selectedSet.has(n)).slice(0, 3)
        names = [...lastIn, ...firstOut]
        header = `入选边界附近（最后入选 3 张 + 最先落选 3 张）：`
      }

      const lines = names.map((n) => {
        const f = res.families[n]
        const members = famMembers.get(f) ?? []
        const inFam = members.indexOf(n) + 1
        const famSel = members.filter((m) => selectedSet.has(m)).length
        return `${ids.id(n)}  ${selectedSet.has(n) ? '✅ 入选' : '❌ 落选'}  ` +
          `全局第 ${rank.get(n)}/${res.n_candidates} 名  分数 ${res.scores[n]?.toFixed(2)}\n` +
          `      场景组 F${f}（共 ${members.length} 张，组内第 ${inFam} 名，该组已入选 ${famSel} 张）`
      }).join('\n')

      const capHint = res.notes.family_cap_used
        ? `\n\n注意：同一场景组最多入选 ${res.notes.family_cap_used} 张。` +
          `组内第 ${(res.notes.family_cap_used ?? 2) + 1} 名之后即使分数高于别组的入选者，也会被这条规则挡住 —— ` +
          `这是为了避免 20 张里一大半是同一个瞬间。`
        : ''
      return { summary: header + `\n\n` + lines + capHint }
    },
  }))

  // ── 工具 4：告诉它你喜欢哪些 ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'set_my_favorites',
    description:
      '记录用户明确说喜欢的照片（用匿名编号）。' +
      '⚠️ 重要：实测个人口味探针在**交付的前 20 张**上没有可测收益 —— ' +
      '融合后 AUC 更高（0.754 vs 0.714）但交付命中反而略差（1.57 vs 1.83，30 次划分里只赢 7 次），' +
      '所以它**默认不参与排序**。调用这个工具只是记录，不要向用户承诺效果会变好。免费。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, required: true, description: '用户喜欢的照片编号' },
      replace: { type: 'boolean', description: 'true=替换现有标注，false=追加（默认追加）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { n_labels: { type: 'number' }, summary: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args) {
      if (!state.ids) throw new Error('请先调用 scan_folder。')
      const r = state.ids.resolve(args.ids)
      if (r.unknown.length) {
        throw new Error(`这些编号不存在：${r.unknown.join(' ')}。只能使用工具返回过的编号，不要自己编。`)
      }
      state.labels = args.replace ? r.names : [...new Set([...state.labels, ...r.names])]
      const n = state.labels.length
      return {
        n_labels: n,
        summary: `已记录 ${n} 张标注。\n\n` +
          `⚠️ **必须如实告诉用户：这些标注默认不参与排序。**\n` +
          `实测个人口味探针在交付的前 20 张上没有可测收益：融合后 AUC 从 0.714 升到 0.754，` +
          `但交付命中从 1.83 降到 1.57，30 次随机划分里融合只赢 7 次、打平 13 次、落后 10 次。` +
          `AUC 变好而头部没变好 —— 这和之前融合两个通用美学指标时是同一个模式。\n\n` +
          `所以不要承诺「标了就会更准」。当前排序用的是本机人脸质量模型，确定性、不花钱。\n` +
          `下一步：重新调用 rank_photos（结果不会因为这些标注而改变）。`,
      }
    },
  }))

  // ── 工具 5：对着人工答案评测 ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'evaluate_against_answer',
    description:
      '如果用户手上有一份自己认真挑出来的精选清单（答案），用它测这次排序到底准不准：' +
      'AUC、前 K 命中、统计显著性 p 值、跨 K 的头部提升。' +
      '这是验收工具，不是选片工具。免费。',
    parameters: {
      gold_file: { type: 'string', required: true, description: '答案清单文件的绝对路径，每行一个文件名' },
      target: { type: 'number', description: '按前几张算命中（默认与上次排序一致）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          auc: { type: 'number' }, hits: { type: 'number' },
          p_value: { type: 'number' }, summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args, exec) {
      if (!state.folder) throw new Error('请先调用 scan_folder。')
      if (!existsSync(args.gold_file)) throw new Error(`答案文件不存在：${args.gold_file}`)
      const target = args.target ?? config.defaultTarget
      try {
        const r = await ranker.evaluate(
          state.folder, target, config.excludedRelativePaths, state.labels, args.gold_file, exec.signal,
        )
        // 主指标必须是**交付**的那份名单，不是按分数的前 K。
        // 排序前 K 会高估：同场景组限流会把一张金标换成非金标（实测 4/20 vs 交付 3/20）。
        const sig = r.delivered_p_value < 0.05 ? '✅ 统计显著' : '⚠ 与运气区分不开'
        const trained = r.excluded_trained.length
          ? `\n（已从评测中剔除 ${r.excluded_trained.length} 张训练标注 —— 拿训练数据自测是自欺欺人）`
          : ''
        const gap = r.hits !== r.delivered_hits
          ? `\n\n注意：按纯分数取前 ${r.k} 是 ${r.hits}/${r.n_gold}，但实际交付是 ` +
            `${r.delivered_hits}/${r.n_gold}。差的那张是被「同场景组最多入选 2 张」挡掉的。` +
            `**要报给用户的是交付数字**，排序数字只说明排序能力。`
          : ''
        return {
          auc: r.auc, hits: r.delivered_hits, p_value: r.delivered_p_value,
          summary:
            `=== 评测 · ${r.mode} 模式 ===\n\n` +
            `【实际交付的名单 —— 产品给用户的就是这个】\n` +
            `  交付命中        ${r.delivered_hits}/${r.n_gold}   共交付 ${r.delivered_n} 张   ` +
            `随机期望 ${r.random_expected}\n` +
            `  超几何 p 值     ${r.delivered_p_value.toFixed(4)}   ${sig}\n\n` +
            `【排序能力 —— 不含同场景组限流】\n` +
            `  AUC            ${r.auc.toFixed(3)}   （0.5 = 掷硬币）\n` +
            `  按分数前 ${r.k}    ${r.hits}/${r.n_gold}\n` +
            `  头部提升        ${r.lift_mean.toFixed(2)}x   （K=10/20/30/40/50 平均）\n\n` +
            `  候选 ${r.n_total} 张 · 耗时 ${r.elapsed_sec}s · **付费调用 0 次**` + trained + gap + `\n\n` +
            `对照 v3（997 次付费调用、同一批照片）：AUC 0.497、交付 3/20、p=0.130 不显著。\n` +
            `⚠️ 上面这一行是历史定值；v4 的成绩以**本次运行实测**为准，不要引用记忆里的数字。\n` +
            `v4 的默认打分器是确定性的（同一批照片每次跑都是同一份名单）。` +
            `所以不要说「v4 完胜 v3」——` +
            `确定的优势是 0 次付费调用、秒级、结果可复现。`,
        }
      } catch (e) { fail(e) }
    },
  }))

  // ── 工具 6：组内成对比较（唯一花钱的工具）────────────────────
  ctx.tools.register(defineTool({
    name: 'compare_within_groups',
    description:
      '用视觉模型比较**同一场景组内**难分高下的照片对，据此重排组内顺序。' +
      '这是整个工具集里**唯一花钱**的一个：每对花 2 次调用（正反各一次）。' +
      '为什么需要它：本地打分测的是拍摄技术质量，看不见表情、眼神、互动 —— ' +
      '而同一瞬间的连拍里，差别恰恰只在这些。实测本地打分的组内排序命中率 65%（随机 47%）。' +
      '只在用户明确要求「再精细一点」或对边界结果不满意时调用，并且**必须先说明要花多少次调用**。',
    parameters: {
      max_pairs: {
        type: 'number',
        description: '最多比较几对（默认 12，即 24 次调用）。每对 2 次调用，务必先告知用户。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          pairs_compared: { type: 'number' },
          calls_spent: { type: 'number' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args, exec) {
      const { res, ids } = requireRanked()
      const maxPairs = Math.max(1, Math.min(args.max_pairs ?? 12, 40))

      // 只比较**影响名单**的对：入选边界附近、且同组的。
      const selected = new Set(res.selected)
      const rank = new Map(res.ranking.map((n, i) => [n, i]))
      const byFam = new Map<number, string[]>()
      for (const n of res.ranking) {
        const f = res.families[n]
        if (!byFam.has(f)) byFam.set(f, [])
        byFam.get(f)!.push(n)
      }
      const pairs: Array<[string, string]> = []
      for (const [, members] of byFam) {
        if (members.length < 2) continue
        const inSel = members.filter((m) => selected.has(m))
        const outSel = members.filter((m) => !selected.has(m))
        // 组里已入选的最弱一张 vs 没入选的最强一张 —— 换掉它会直接改名单。
        if (inSel.length && outSel.length) {
          pairs.push([inSel[inSel.length - 1]!, outSel[0]!])
        }
      }
      pairs.sort((x, y) => (rank.get(x[1]) ?? 0) - (rank.get(y[1]) ?? 0))
      const use = pairs.slice(0, maxPairs)
      if (!use.length) {
        return {
          pairs_compared: 0, calls_spent: 0,
          summary: '没有找到值得比较的组内对（每个场景组要么只有一张，要么全入选/全落选）。没有花钱。',
        }
      }

      try {
        const names = [...new Set(use.flat())]
        // withFace=true：必须带高清人脸，否则模型在 30 像素的脸上判断表情，
        // 那和瞎猜没区别（v3 的重评一致率只有 30%，正是这个原因）。
        const { previews, faces, missing } = await ranker.preview(
          state.folder!, names, config.excludedRelativePaths, 512, exec.signal, true,
        )
        if (missing.length) {
          throw new Error(`这些照片没有缓存预览，无法比较：${missing.map((n) => ids.id(n)).join(' ')}`)
        }
        const services: HarnessVisionServices = {
          llm: ctx.get('llm') as unknown as HarnessVisionServices['llm'],
          attachments: ctx.get('attachments') as unknown as HarnessVisionServices['attachments'],
        }
        const { verdicts, route } = await comparePairs(
          // 生产路径不用锚点：锚点需要一批已标注的范例，而普通用户没有。
          // 它只在评测里用（run_pair_eval 那条路径）。
          use, previews, faces, null, services, exec as unknown as HarnessVisionExecution,
        )

        const swaps: string[] = []
        const lines = verdicts.map((v) => {
          const inId = ids.id(v.a)
          const outId = ids.id(v.b)
          if (v.winner === 'b') swaps.push(`${outId} 换掉 ${inId}`)
          const mark = v.winner === 'a' ? '维持原判' : v.winner === 'b' ? '⇄ 建议换' : '平局'
          return `  ${inId}（已入选） vs ${outId}（未入选）  →  ${mark}\n      ${v.reason}`
        }).join('\n')

        const flips = verdicts.filter((v) => v.winner === 'b').length
        const ties = verdicts.filter((v) => v.winner === 'tie').length
        const inconsistent = verdicts.filter((v) => !v.consistent && v.reason.includes('不一致')).length
        return {
          pairs_compared: verdicts.length,
          calls_spent: verdicts.length * 2,
          summary:
            `组内成对比较完成：${verdicts.length} 对，**花了 ${verdicts.length * 2} 次付费调用**` +
            `（每对正反各问一次）。模型路由 ${route}。\n\n` +
            lines + `\n\n` +
            `结果：维持原判 ${verdicts.length - flips - ties} 对 · 建议换 ${flips} 对 · 平局 ${ties} 对` +
            `（其中 ${inconsistent} 对是正反答案不一致被判平局 —— 位置偏好是真实存在的，单向结果不可信）。\n` +
            (swaps.length
              ? `\n建议的调整：${swaps.join('，')}。要不要我按这个改名单？`
              : `\n没有建议调整 —— 本地排序在这些边界上的判断，模型也同意。`),
        }
      } catch (e) { fail(e) }
    },
  }))

  // ── 工具 7：导出（两步确认，只复制）─────────────────────────
  ctx.tools.register(defineTool({
    name: 'export_selection',
    description:
      '把选中的照片**复制**到一个新文件夹。绝不移动、删除、改名或写回原图。\n' +
      '**两步流程，而且确认码只能由本工具生成：**\n' +
      '① 不带 confirmation_code 调用一次 → 本工具冻结名单并返回一个 6 位十六进制确认码。\n' +
      '② 把那个码原样转达给用户，等他在新消息里回复，再带 confirmation_code 调用第二次。\n' +
      '⚠️ **你不能自己编一个码。** 想告诉用户确认码，就必须先调用本工具拿到它 —— ' +
      '编造的码在第二步会被拒绝（「没有待确认的导出票据」），用户会白等一轮。',
    parameters: {
      dest: { type: 'string', required: true, description: '目标目录的绝对路径' },
      confirmation_code: { type: 'string', description: '第二次调用时传入用户回复的确认码' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { copied: { type: 'number' }, summary: { type: 'string' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary }],
    },
    async execute(args) {
      const { res, ids } = requireRanked()
      if (!config.allowedExportRoots.length) throw new Error('未配置导出授权目录，导出被禁止。')
      const dest = resolvePath(args.dest)
      const ok = config.allowedExportRoots.some((r) => {
        const root = resolvePath(r)
        return dest === root || dest.startsWith(root + '/')
      })
      if (!ok) throw new Error(`${dest} 不在授权的导出目录内。授权范围：${config.allowedExportRoots.join(' , ')}`)

      if (!args.confirmation_code) {
        const code = randomBytes(3).toString('hex').toUpperCase()
        state.exportTicket = { code, dest, names: [...res.selected] }
        return {
          copied: 0,
          summary:
            `名单已冻结：${res.selected.length} 张（${res.selected.map((n) => ids.id(n)).join(' ')}）\n` +
            `目标目录：${dest}\n\n` +
            `确认码 **${code}** ← 这是本工具刚生成的，原样转达给用户，不要改写。\n` +
            `请用户在一条新消息里回复「确认导出 ${code}」，然后你才带 confirmation_code 再调一次。\n` +
            `导出只做复制，原图不移动、不删除、不改名、不写回。`,
        }
      }

      const t = state.exportTicket
      if (!t) throw new Error('没有待确认的导出票据，请先不带 confirmation_code 调用一次。')
      if (args.confirmation_code.trim().toUpperCase() !== t.code) {
        throw new Error('确认码不匹配。请让用户重新回复正确的确认码，不要自行猜测。')
      }
      if (dest !== t.dest) throw new Error('目标目录与冻结时不一致，拒绝执行。')

      mkdirSync(dest, { recursive: true })
      let copied = 0
      for (const relName of t.names) {
        const src = join(state.folder!, relName)
        if (!existsSync(src)) continue
        copyFileSync(src, join(dest, basename(relName)))
        copied++
      }
      state.exportTicket = undefined
      return {
        copied,
        summary: `已复制 ${copied} 张到 ${dest}。原图未被移动、删除、改名或修改。`,
      }
    },
  }))

  // ── 评测专用：阶段 2 成对准确率 ─────────────────────────────
  //
  // 只在 config.evalPairsFile 非空时注册。生产 profile 不设它。
  //
  // 为什么需要这个工具而不是让 agent 自己一对对调 compare_within_groups：
  // 评测必须**跑完全部考题**且中途不许改判据。交给 agent 逐对决定要不要比，
  // 它会挑简单的比、会中途改主意 —— 那样测出来的数字没法用。
  if (config.evalPairsFile) {
    ctx.tools.register(defineTool({
      name: 'run_pair_eval',
      description:
        '【评测专用】跑完考题文件里的全部照片对，输出阶段 2 的成对准确率。' +
        `每对花 2 次调用（AB/BA 双向）。考题：${config.evalPairsFile}`,
      parameters: {
        limit: { type: 'number', description: '最多跑几对（留空=全部）' },
        out: { type: 'string', description: '结果写到哪个文件' },
        pairs: { type: 'string', description: '换一份考题：evalPairsDir 里的文件名（不是路径）' },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { summary: { type: 'string' }, calls_spent: { type: 'number' } },
        },
        render: (_a, v) => [{ type: 'text', text: v.summary }],
      },
      async execute(args, exec) {
        // 换考题只能按**文件名**在 evalPairsDir 里找。
        // 不接受 / 和 ..：这是评测工具，不是通用的读文件工具。
        let pairsFile = config.evalPairsFile
        if (args.pairs) {
          if (!config.evalPairsDir) throw new Error('没有配置 evalPairsDir，不能换考题。')
          if (args.pairs.includes('/') || args.pairs.includes('..')) {
            throw new Error(`考题只能给文件名，不能给路径：${args.pairs}`)
          }
          pairsFile = join(config.evalPairsDir, args.pairs)
          if (!existsSync(pairsFile)) throw new Error(`考题文件不存在：${pairsFile}`)
        }
        const spec = JSON.parse(readFileSync(pairsFile, 'utf8')) as {
          folder?: string
          pairs: Array<{ a: string; b: string; answer: string; kind: string; local_correct: boolean; group: number }>
          /** 锚点：文本 + 范例照片文件名。由 Python 侧切分好，这里只负责取图。
           *  folder 可以和考题不同（锚点通常来自另一个数据集，也必须如此 ——
           *  锚点和考题同源就是泄题）。 */
          anchors?: { folder?: string; text: string; photos: string[]; labels?: Record<string, string> }
        }
        // 考题文件里的 folder **也必须过 allowedRoots**。
        //
        // 这一条原来漏了：其他工具都校验（scan_folder 等），只有它直接用
        // 文件里写的路径。虽然能改这个文件的人本来就有文件系统权限，
        // 但「照片只能来自授权目录」是这个 agent 的结构性保证之一 ——
        // 有一处例外，这个保证就不成立了。
        const rawFolder = spec.folder ?? state.folder
        if (!rawFolder) throw new Error('考题文件里没有 folder，且当前会话还没扫描过文件夹。')
        const folder = assertAllowed(rawFolder, config.allowedRoots, '照片')
        const all = spec.pairs
        const use = args.limit ? all.slice(0, args.limit) : all

        const names = [...new Set(use.flatMap((p) => [p.a, p.b]))]
        const { previews, faces, missing } = await ranker.preview(
          folder, names, config.excludedRelativePaths, 512, exec.signal, true,
        )
        if (missing.length) throw new Error(`${missing.length} 张缺少缓存预览，评测中止`)

        const services: HarnessVisionServices = {
          llm: ctx.get('llm') as unknown as HarnessVisionServices['llm'],
          attachments: ctx.get('attachments') as unknown as HarnessVisionServices['attachments'],
        }
        // 锚点图另外取一次预览。**它们必须不在考题里** —— Python 侧切分时保证，
        // 这里再断言一次：泄题是静默的，跑完看数字看不出来。
        let anchorBlock: AnchorBlock | null = null
        if (spec.anchors?.photos?.length) {
          const testNames = new Set(use.flatMap((p) => [p.a, p.b]))
          const leaked = spec.anchors.photos.filter((n) => testNames.has(n))
          if (leaked.length) {
            throw new Error(`锚点和考题重叠 ${leaked.length} 张，这是泄题：${leaked.slice(0, 3).join(' ')}`)
          }
          // 和生产路径共用同一个 builder —— 不要在这里就地取图，
          // 那正是历史上三次分叉的写法。
          anchorBlock = await buildAnchorBlock({
            folder: spec.anchors.folder || folder,
            text: spec.anchors.text,
            photos: spec.anchors.photos,
            labels: spec.anchors.labels ?? {},
          }, exec.signal)
        }

        const { verdicts, route } = await comparePairs(
          use.map((p) => [p.a, p.b] as const), previews, faces, anchorBlock, services,
          exec as unknown as HarnessVisionExecution,
        )

        // 判分。tie 一律算**没答对** —— 平局不能算赢，否则模型全答平局就 100% 了。
        const rows = use.map((p, i) => {
          const v = verdicts[i]!
          return { ...p, winner: v.winner, consistent: v.consistent, ab: v.ab, ba: v.ba,
                   reason: v.reason, model_correct: v.winner === p.answer }
        })
        const n = rows.length
        const pct = (x: number) => `${((x / Math.max(n, 1)) * 100).toFixed(1)}%`
        const gold = rows.filter((r) => r.kind === 'gold')
        const eyes = rows.filter((r) => r.kind === 'eyes')
        const wrong = rows.filter((r) => !r.local_correct)   // 本地分判错的 —— 真正的增量空间
        const right = rows.filter((r) => r.local_correct)
        const hit = (rs: typeof rows) =>
          rs.length ? `${rs.filter((r) => r.model_correct).length}/${rs.length}` : '—'

        const outPath = args.out || `${pairsFile}.result.json`
        writeFileSync(outPath, JSON.stringify({ route, rows }, null, 2))

        return {
          calls_spent: n * 2,
          summary:
            `阶段 2 成对评测完成 · 模型 ${route} · ${n} 对 / ${n * 2} 次调用\n` +
            `考题 ${pairsFile}${anchorBlock ? ' · 带锚点' : ' · 不带锚点'}\n` +
            `T0 机制 · AB/BA 双向一致率  ${pct(rows.filter((r) => r.consistent).length)}\n` +
            `T1 体检 · 睁眼 vs 闭眼      ${hit(eyes)}\n` +
            `T2 增量 · 金标 vs 非金标    ${hit(gold)}（本地分 ${gold.filter((r) => r.local_correct).length}/${gold.length}）\n` +
            `  └ 本地分判错的           ${hit(wrong)}  ← 救回来的\n` +
            `  └ 本地分判对的           ${hit(right)}  ← 别毁掉的\n` +
            `明细写入 ${outPath}`,
        }
      },
    }))
  }
}
