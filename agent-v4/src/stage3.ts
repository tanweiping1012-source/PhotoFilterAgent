/**
 * 阶段 3 视觉对决：排序器出的段内边缘对局 → 视觉模型判 → 带着计划 md5 回排序器应用。
 *
 * 为什么和阶段 2 分开写成一个模块：阶段 2 的那段逻辑长在 rank_photos 的闭包里，
 * 测不到调用点（2026-09-14 index.ts:688 的参数错位就是这么漏过去的）。这里所有外部依赖
 * 都从参数注入，测试直接看 comparePairs 收到的实参和排序器收到的裁决文件。
 *
 * 规则在 Python 侧（ranker/photofilter_rank/stage3.py）：只有挑战者正反两次都赢才换人，
 * 平局 / 翻覆 / 都不够格一律维持本地排序。本模块不做任何判定，只负责把裁决原样交回去。
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STAGE2_CODE_SEED, assignCodes } from './codes.ts'
import { comparePairs, type AnchorBlock, type PairVerdict } from './compare.ts'
import type { HarnessVisionExecution, HarnessVisionServices } from './harness-vision.ts'
import { toCallRow } from './pairEval.ts'
import type { RankResult, Stage3Note, Stage3PlanRow } from './ranker.ts'

export interface Stage3Anchors {
  folder: string
  text: string
  photos: string[]
  labels: Record<string, string>
}

export interface Stage3Input {
  /** 阶段 2 应用之后的排序结果。计划与计划 md5 都取自它的 notes。 */
  before: RankResult
  folder: string
  exclude: string[]
  rubric: string | null
  anchors: Stage3Anchors | null
  allowNeither: boolean
  services: HarnessVisionServices
  exec: HarnessVisionExecution
  /** 这一次运行的记录目录（调用方建好）。裁决文件与 calls.jsonl 都写在这里。 */
  runDir: string
}

export interface Stage3Deps {
  preview(
    folder: string, names: string[], exclude: string[], size: number,
    signal: AbortSignal | undefined, withFace: boolean,
    labelMap?: Record<string, string>, codeMap?: Record<string, string>,
  ): Promise<{ previews: Record<string, string>; faces: Record<string, string>; missing: string[] }>
  buildAnchorBlock(anchors: Stage3Anchors | null, signal: AbortSignal | undefined): Promise<AnchorBlock | null>
  /**
   * 用这份阶段 3 裁决文件重排。调用方负责把阶段 2 的裁决也一起带上。
   *
   * 计划变了才会被计划 md5 拦下来；没变的时候 md5 照样对得上 —— 阶段 2 改的要是名单里
   * 非边缘的那一席，对局计划一字不变，丢了阶段 2 的裁决只会静默少掉它的改判。
   * 那种情况只有**交付名单**看得出来。
   */
  rank(stage3VerdictsFile: string): Promise<RankResult>
  /** 只为测试留的缝：包一层真实的 comparePairs 以看到实参。生产不传。 */
  compare?: typeof comparePairs
  /**
   * 每条调用记录额外抄送调用方。本模块自己写 calls.jsonl，这个只为让计数活在调用方那一层 ——
   * 局部变量里的计数一抛就没了，而半路失败的运行照样花了钱。
   */
  onCall?(record: Parameters<typeof toCallRow>[0]): void
}

export interface Stage3Outcome {
  result: RankResult
  plan: Stage3PlanRow[]
  planMd5: string | null
  verdicts: PairVerdict[]
  route: string | null
  /** 真正发出去的比较调用次数（不含预检），从调用记录数出来。 */
  comparisons: number
  /** 真正发出去的预检次数。 */
  preflights: number
  /** 每次调用真正附上的锚点照片张数（没带锚点是 0）。核「这一组真的带了 8 张」只能看它。 */
  anchorPhotos: number
  note: Stage3Note | null
  verdictsFile: string | null
}

/** 阶段 3 的调用记录与阶段 2 写在同一份 calls.jsonl 里，用 stage 区分。 */
export const CALLS_FILE = 'calls.jsonl'
export const STAGE3_VERDICTS_FILE = 'stage3-verdicts.json'

export async function runStage3(input: Stage3Input, deps: Stage3Deps): Promise<Stage3Outcome> {
  const { before, runDir, exec } = input
  const plan = before.notes.stage3_plan ?? []
  if (!plan.length) {
    // 没有合法挑战者的数据集（段内凑不出第三张）就没有阶段 3。不花钱，名单原样。
    return { result: before, plan, planMd5: before.notes.stage3_plan_md5 ?? null, verdicts: [], route: null,
             comparisons: 0, preflights: 0, anchorPhotos: 0, note: null, verdictsFile: null }
  }
  const planMd5 = before.notes.stage3_plan_md5
  if (!planMd5) {
    throw new Error('排序器给了阶段 3 计划却没有计划 md5（stage3_plan_md5）—— 排序器与 agent 版本不一致，不发任何调用。')
  }

  const names = [...new Set(plan.flatMap((p) => [p.a, p.b]))]
  // 与阶段 2、第三轮标定同一个种子：码跟着照片走，跨运行稳定。
  const codes = assignCodes(names, STAGE2_CODE_SEED)
  const { previews, faces, missing } = await deps.preview(
    input.folder, names, input.exclude, 512, exec.signal, true, undefined, codes,
  )
  if (missing.length) throw new Error(`阶段 3 有 ${missing.length} 张照片取不到预览，不发任何调用。`)
  const anchorBlock = input.anchors ? await deps.buildAnchorBlock(input.anchors, exec.signal) : null

  let comparisons = 0
  let preflights = 0
  const calls = join(runDir, CALLS_FILE)
  const compare = deps.compare ?? comparePairs
  const { verdicts, route } = await compare(
    plan.map((p) => [p.a, p.b] as const), previews, faces, anchorBlock,
    input.rubric, input.allowNeither, codes, input.services, exec,
    {
      onCall: (r) => {
        if (r.sent) {
          if (r.kind === 'preflight') preflights++
          else comparisons++
        }
        deps.onCall?.(r)
        appendFileSync(calls, JSON.stringify({ stage: 3, ...toCallRow(r) }) + '\n', 'utf8')
      },
    },
  )

  const verdictsFile = join(runDir, STAGE3_VERDICTS_FILE)
  writeFileSync(verdictsFile, JSON.stringify({
    plan_md5: planMd5,
    plan,
    route,
    verdicts: verdicts.map((v) => ({
      a: v.a, b: v.b, winner: v.winner, consistent: v.consistent, ab: v.ab, ba: v.ba,
      reason_ab: v.reasonAb, reason_ba: v.reasonBa,
      code_a: v.codeA ?? null, code_b: v.codeB ?? null,
      code_read_ok: v.codeReadOk ?? null, contradiction: v.contradiction ?? null,
    })),
  }, null, 2))

  const result = await deps.rank(verdictsFile)
  // 给了裁决文件却没用上，读起来和「没开阶段 3」一模一样 —— 阶段 2 的 --verdicts 就这样静默失效过。
  if (result.notes.stage3_judge !== 'replay' || !result.notes.stage3) {
    throw new Error(
      `阶段 3 裁决没有被排序器应用（stage3_judge=${String(result.notes.stage3_judge)}）。` +
      '名单与不开阶段 3 相同，这次运行不能当作阶段 3 的结果。',
    )
  }
  return { result, plan, planMd5, verdicts, route, comparisons, preflights,
           anchorPhotos: anchorBlock?.jpegs.length ?? 0, note: result.notes.stage3, verdictsFile }
}
