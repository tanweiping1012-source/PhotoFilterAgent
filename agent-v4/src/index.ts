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

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { IdentityMap } from './identity.ts'
import { Ranker, RankerError, type RankResult } from './ranker.ts'

export const name = 'photo-filter-v4'
export const inject = ['tools']

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
  /** 摘要里直接列 ID 的上限。 */
  maxInlineIdList: number
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
  maxInlineIdList: z.number().step(1).min(0).default(60),
})

/** 一次会话内的运行状态。只存在内存里，工具之间靠它传递上下文。 */
interface RunState {
  folder?: string
  fingerprint?: string
  ids?: IdentityMap
  last?: RankResult
  labels: string[]
  exportTicket?: { code: string; dest: string; names: string[] }
}

export function apply(ctx: Context, config: Config): void {
  const ranker = new Ranker(
    config.python, config.rankerDir, config.cacheDir, config.rankerTimeoutMs,
    config.engineBinary || undefined,
  )
  const state: RunState = { labels: [] }

  /** 目录必须落在授权根目录内。这是结构约束，不靠 agent 自觉。 */
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
      '如果用户已经用 set_my_favorites 标过喜欢的照片，会自动改用「学到的个人口味」模式；' +
      '否则用通用质量指标冷启动。同一场景组默认最多入选 2 张。',
    parameters: {
      target: { type: 'number', description: `要挑几张（默认 ${config.defaultTarget}）` },
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
        const res = await ranker.rank(
          state.folder, target, config.excludedRelativePaths, state.labels, exec.signal,
        )
        const ids = IdentityMap.load(config.workdir, res.fingerprint)
        ids.assign([...res.ranking].sort())
        state.ids = ids
        state.fingerprint = res.fingerprint
        state.last = res

        const n = res.notes
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
            `模式：${modeText}\n` +
            `候选 ${res.n_candidates} 张 · 场景组 ${n.n_families} 个（最大 ${n.largest_family} 张）· 耗时 ${res.elapsed_sec}s\n` +
            `**付费模型调用 0 次** —— 全程在本机算完。\n` +
            warn + gateNote + capNote + `\n\n` +
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
      '记录用户明确说喜欢的照片（用匿名编号）。下次 rank_photos 会从这些照片里学用户的口味。' +
      '实测：标 10 张的效果远好于不标；但标注必须分散在整批照片里，' +
      '如果都来自同一段行程，排序器会检测到并拒绝使用。免费。',
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
      const advice = n < 5
        ? `还不够 5 张，排序仍会走冷启动。实测标 3 张反而不如不标（AUC 0.555 vs 0.606）。`
        : n < 12
        ? `已进入过渡区。实测标到 10 张才明显超过冷启动（0.673 vs 0.606）。`
        : `已足够启用个人口味模式（实测 15 张时 AUC 0.713）。`
      return {
        n_labels: n,
        summary: `已记录 ${n} 张标注。${advice}\n` +
          `提醒用户：标注要分散在整批照片里。实测连着标同一段行程的 10 张，AUC 只有 0.439 —— ` +
          `比不标（0.606）还差，比随机（0.5）还差，因为模型会学成「像那个地方的照片」。\n` +
          `下一步：重新调用 rank_photos。`,
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
            `对照 v3（997 次付费调用）：AUC 0.497、交付 3/20、p=0.130。\n` +
            `诚实的说法：v4 的**排序能力**明显更好（AUC 0.606 vs 0.497），但**交付的前 20 张**` +
            `在这个样本量上和 v3 打平（都是 3/20）。v4 真正确定的优势是 0 次付费调用和结果可复现。`,
        }
      } catch (e) { fail(e) }
    },
  }))

  // ── 工具 6：导出（两步确认，只复制）─────────────────────────
  ctx.tools.register(defineTool({
    name: 'export_selection',
    description:
      '把选中的照片**复制**到一个新文件夹。绝不移动、删除、改名或写回原图。' +
      '必须两步：第一次调用只冻结名单并返回确认码；用户在新消息里明确回复确认码后，' +
      '才带 confirmation_code 调用第二次。Agent 不得自行补出确认码。',
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
            `确认码 **${code}**。请在一条新消息里回复「确认导出 ${code}」，我才会执行复制。\n` +
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
}
