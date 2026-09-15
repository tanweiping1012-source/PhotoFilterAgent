/**
 * run_pair_eval 的主体：取图 →（可选）烧码 → 锚点 → AB/BA 比较 → 逐对 / 逐次落盘 → 判分行 → 结果文件。
 *
 * ━━ 为什么从 index.ts 里抽出来 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 这条路径是 R2/R3 历史结论的出口，这次要给它加烧码开关和落盘。
 * 加开关最怕「缺省时悄悄变了」，而那种 bug 长在**调用点**上 ——
 * 2026-09-14 index.ts:688 的 comparePairs 参数错位就是调用点的 bug，旁边的 helper 全对。
 * 留在工具闭包里测不到调用点；抽到这里之后，测试直接看 comparePairs **收到的**实参，
 * 比较那一层用真实的 comparePairs + mock services。
 *
 * index.ts 只留：考题文件解析、allowedRoots 校验、从 ctx 取 services、汇总文字。
 */
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { STAGE2_CODE_SEED, assignCodes } from './codes.ts'
import { comparePairs, type AnchorBlock, type PairVerdict } from './compare.ts'
import type { HarnessVisionExecution, HarnessVisionServices, VisionCallRecord } from './harness-vision.ts'

export interface PairEvalPair {
  a: string
  b: string
  answer: string
  kind: string
  local_correct: boolean
  group: number
}

export interface PairEvalSpec {
  folder?: string
  pairs: PairEvalPair[]
  /** 锚点：文本 + 范例照片文件名。由 Python 侧切分好，这里只负责取图。
   *  folder 可以和考题不同（锚点通常来自另一个数据集，也必须如此 ——
   *  锚点和考题同源就是泄题）。 */
  anchors?: { folder?: string; text: string; photos: string[]; labels?: Record<string, string> }
  /** 判据文本。缺省时回落到 config.rubricFile —— AB 实验靠它区分「无提示 / 仅规则」两臂。 */
  rubric?: string
  /** 这份考题是否允许「都不要」。缺省回落到 config.allowNeither。 */
  allow_neither?: boolean
  /**
   * 给待判照片烧 4 位码，启用内容寻址的答案通道。**缺省 false。**
   *
   * 为什么写在考题里、不做成工具参数：headless agent 会忘传，而忘传的后果是静默的 ——
   * 不烧码时 compare.ts 的 `codeReadOk = !withCodes || …` 恒为 true，读码率会显示 100%，
   * 是假绿。写进考题文件，条件就跟着考题走，预登记时连同 md5 一起冻结。
   *
   * 为什么阶段 3 标定要烧：标定的是**阶段 3 的生产裁判**，而生产比较路径烧码；
   * 不烧反而偏离被测对象（owner 2026-09-14 定）。
   *
   * 缺省不烧：这条路径同时是 R2/R3 历史结论的出口，那几轮都没烧码，缺省一变就不可比。
   */
  burn_codes?: boolean
}

export interface PairEvalInput {
  spec: PairEvalSpec
  /** 要跑的考题（limit 截断之后）。下标即原考题下标。 */
  use: PairEvalPair[]
  folder: string
  exclude: string[]
  rubric: string | null
  allowNeither: boolean
  outPath: string
  services: HarnessVisionServices
  exec: HarnessVisionExecution
}

export interface PairEvalDeps {
  preview(
    folder: string, names: string[], exclude: string[], size: number,
    signal: AbortSignal | undefined, withFace: boolean,
    labelMap?: Record<string, string>, codeMap?: Record<string, string>,
  ): Promise<{ previews: Record<string, string>; faces: Record<string, string>; missing: string[] }>
  buildAnchorBlock(
    anchors: { folder: string; text: string; photos: string[]; labels: Record<string, string> } | null,
    signal: AbortSignal | undefined,
  ): Promise<AnchorBlock | null>
  /** 只为测试留的缝：包一层真实的 comparePairs 以看到实参。生产不传。 */
  compare?: typeof comparePairs
}

/** 逐对落盘：每对比完追加一行 `{ i, ...判分行 }`，i 是原考题下标。跑完即删（最终结果文件取代它）。 */
export const partialPathOf = (outPath: string): string => `${outPath}.partial.jsonl`

/**
 * 逐次调用记录：每一次模型调用一行 —— 比较调用 AB、BA 分开，**预检也写**（kind 区分），
 * **失败的也写**。跑完**不删**。
 *
 * 判据要求「调用数从日志数」，而 DSH 会话日志不记工具内部发出的视觉调用。
 * 记录由 transport 在调用前后发出（harness-vision.ts 的 VisionCallRecord），不从裁决反推 ——
 * 反推数不到失败的那次，又回到拿「对数 × 2」算出来的数。
 * 跑完不删：它就是那份「日志」，最终结果文件里没有它的内容（失败的调用、耗时、是否真的发出）。
 *
 * 核算口径（owner 2026-09-15 定）：对批准的调用数，数 `kind == "compare" && sent`；
 * 预检单独数，每次运行正好 1 行。sent=false 的是发出前被本地拦下的，没有花钱。
 *
 * 为什么不复用 instrument.ts 的 CallRow / appendRow：CallRow 的 phase 是仪器标定四个阶段的
 * 封闭枚举，也没有路由、错误、考题下标、「是否真的发出」这几个字段；appendRow 的 ts 是
 * 写盘时刻而不是发出时刻；而且 run_instrument_check 只在 askPair 成功之后才写一行 ——
 * 失败的调用在那边本来就不落盘。硬塞进去等于改掉另一个工具的行格式。
 */
export const callsPathOf = (outPath: string): string => `${outPath}.calls.jsonl`

function toCallRow(r: VisionCallRecord) {
  return {
    ts: r.startedAt,
    elapsed_ms: r.elapsedMs,
    route: r.route,
    // transport 的 structured 在这条路径上都是比较调用；预检原样写 preflight
    kind: r.kind === 'structured' ? 'compare' : r.kind,
    i: typeof r.meta?.pair === 'number' ? r.meta.pair : null,
    dir: typeof r.meta?.dir === 'string' ? r.meta.dir : null,
    a: typeof r.meta?.a === 'string' ? r.meta.a : null,
    b: typeof r.meta?.b === 'string' ? r.meta.b : null,
    jpegs: r.jpegs,
    sent: r.sent,
    ok: r.ok,
    ...(r.error === undefined ? {} : { error: r.error }),
  }
}

/**
 * 一对考题的判分行。tie 一律算**没答对** —— 平局不能算赢，否则模型全答平局就 100% 了。
 *
 * **不烧码时一个新字段都不加**（不是写 null）—— 结果文件与改动前逐字节相同，
 * R2/R3 的出口不动。烧码时才带码字段，字段名按判据 §11.4 定死为 snake_case。
 *
 * ⚠️ 绝不能不分情况地抄 v.codeReadOk：不烧码时它恒为 true（见 compare.ts），
 * 抄进来就是「读码率 100%」的假绿 —— 正是这次要堵的洞。
 */
export function toEvalRow(p: PairEvalPair, v: PairVerdict, burn: boolean) {
  const row = {
    ...p, winner: v.winner, consistent: v.consistent, ab: v.ab, ba: v.ba,
    reason: v.reason,
    // 双向原话都落盘 —— 不一致的对上 reason 是模板句，
    // 模型真正说了什么只在这两个字段里。
    reason_ab: v.reasonAb, reason_ba: v.reasonBa,
    model_correct: v.winner === p.answer,
    // 没问模型的那一对必须显式标出，绝不能长得像一局平局。只在为真时出现，
    // 不改变正常行的键集合。
    ...(v.skipped ? { skipped: true } : {}),
  }
  if (!burn) return row
  return {
    ...row,
    code_a: v.codeA ?? null,
    code_b: v.codeB ?? null,
    code_read_ok: v.codeReadOk ?? null,
    contradiction: v.contradiction ?? null,
    codes_read: v.codesRead ?? null,
  }
}

export async function runPairEval(input: PairEvalInput, deps: PairEvalDeps) {
  const { spec, use, folder, exclude, outPath, services, exec } = input
  const burn = spec.burn_codes === true
  const partial = partialPathOf(outPath)
  const calls = callsPathOf(outPath)
  // 开跑之前就查，早于任何取图和调用：上一次运行留下的落盘文件还在，就不许静默覆盖或续写。
  const leftover = [partial, calls].filter((f) => existsSync(f))
  if (leftover.length) {
    throw new Error(
      `上一次运行留下的落盘文件还在：${leftover.join('、')}。先归档再跑 —— `
      + '它们可能是一次中断留下的、已经花过钱的数据，这里不静默覆盖。',
    )
  }

  const names = [...new Set(use.flatMap((p) => [p.a, p.b]))]
  // 烧码与生产阶段 2 同一套：同一个种子常量、同一个 assignCodes、同样经 preview 的 codeMap 烧在图上。
  // 不烧码时 codes 必须是 undefined 而不是 {} —— 交给 preview 和 comparePairs 的实参才与改动前逐字相同。
  const codes = burn ? assignCodes(names, STAGE2_CODE_SEED) : undefined
  const { previews, faces, missing } = await deps.preview(
    folder, names, exclude, 512, exec.signal, true, undefined, codes,
  )
  if (missing.length) throw new Error(`${missing.length} 张缺少缓存预览，评测中止`)

  // 锚点图另外取一次预览。**它们必须不在考题里** —— Python 侧切分时保证，
  // 这里再断言一次：泄题是静默的，跑完看数字看不出来。
  //
  // 锚点只烧名字标签、不烧码 —— 与生产阶段 2 一致（两边都走同一个 buildAnchorBlock）。
  let anchorBlock: AnchorBlock | null = null
  if (spec.anchors?.photos?.length) {
    const testNames = new Set(use.flatMap((p) => [p.a, p.b]))
    const leaked = spec.anchors.photos.filter((n) => testNames.has(n))
    if (leaked.length) {
      throw new Error(`锚点和考题重叠 ${leaked.length} 张，这是泄题：${leaked.slice(0, 3).join(' ')}`)
    }
    // 和生产路径共用同一个 builder —— 不要在这里就地取图，
    // 那正是历史上三次分叉的写法。
    anchorBlock = await deps.buildAnchorBlock({
      folder: spec.anchors.folder || folder,
      text: spec.anchors.text,
      photos: spec.anchors.photos,
      labels: spec.anchors.labels ?? {},
    }, exec.signal)
  }

  const compare = deps.compare ?? comparePairs
  const { verdicts, route } = await compare(
    use.map((p) => [p.a, p.b] as const), previews, faces, anchorBlock,
    input.rubric, input.allowNeither,
    codes, services, exec,
    {
      // 逐对落盘：每对 AB/BA 都问完就追加一行，崩在第 k 对时前 k−1 对还在。
      // comparePairs 是顺序的，第 done 次回调就是第 done−1 号考题；仍然核对 a/b，
      // 对不上就炸 —— 下标错位是静默的，落进盘里就再也分不出来。
      // 这里**不接**任何异常：抛出来的错照常往上走，不许吞成平局或跳过。
      onPair: (done, _total, v) => {
        const i = done - 1
        const p = use[i]
        if (!p || p.a !== v.a || p.b !== v.b) {
          throw new Error(`逐对落盘下标对不上：第 ${i} 号考题是 ${p?.a} vs ${p?.b}，回调给的是 ${v.a} vs ${v.b}`)
        }
        appendFileSync(partial, JSON.stringify({ i, ...toEvalRow(p, v, burn) }) + '\n', 'utf8')
      },
      // 逐次调用：transport 在真正发出调用的地方回调，失败的也回调。
      onCall: (r) => {
        appendFileSync(calls, JSON.stringify(toCallRow(r)) + '\n', 'utf8')
      },
    },
  )

  const rows = use.map((p, i) => toEvalRow(p, verdicts[i]!, burn))
  writeFileSync(outPath, JSON.stringify({ route, rows }, null, 2))
  // 最终文件写成功之后才删逐对文件 —— 两份同时在没关系，两份都没有才要命。
  // 逐次调用记录不删，理由见 callsPathOf。
  if (existsSync(partial)) unlinkSync(partial)
  return { route, rows, outPath, callsPath: calls, withAnchors: anchorBlock !== null }
}
