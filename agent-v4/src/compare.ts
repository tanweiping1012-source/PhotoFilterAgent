/**
 * 组内成对比较：本地信号唯一确定的短板。
 *
 * ━━ 为什么只做「组内」，不做全池 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * v3 的失败不是因为成对比较不成立，是因为它把模型用在**绝对打分**上
 * （0–100 无锚点标尺，重评噪声 σ=7.28 > 照片间差异 σ=6.72）。
 * 成对比较是另一回事：「这两张里哪张更好」有明确参照，不需要想象标尺。
 *
 * 实测诊断（309 张人像）：本地打分在**组内排序**上命中率 65%（随机基线 47%）——
 * 有信号但不强。大组里第二张金标常排在第 5、6、8、14 位：
 *
 *     F17 (15张)  ··★··········★·
 *     F31 (14张)  ★······★······
 *
 * 而 Apple 的人脸质量测的是**拍摄技术质量**，看不见表情、眼神、互动 ——
 * 恰恰是同一瞬间的连拍里唯一的差别。
 *
 * ━━ 三条约束 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 1. **只发无元数据的 512px 小图**，由 Python 侧从降采样缓存再缩一次生成
 *    （实测 33–35KB，EXIF 字段 0 个、无 GPS）。原图不出本机。
 * 2. **AB/BA 双向问**：同一对正反各问一次。两次答案不一致就判平局 ——
 *    位置偏好是真实存在的，单向结果不可信。
 * 3. **模型路由继承当前会话**，不允许静默回落到别的模型。
 */

import type { HarnessVisionExecution, HarnessVisionServices } from './harness-vision.ts'
import { HarnessVisionTransport, resolveHarnessModelRoute } from './harness-vision.ts'

const SYSTEM = `你在帮一个人从自己的旅行照片里挑出值得留下的几张。
现在给你同一场景、几乎同时拍的两张照片，请判断哪一张更值得留下。

**每张照片给你两幅图**：先是整幅画面（看构图、姿态、环境），
紧接着是同一张照片里**人脸放大后的高清裁切**（看表情、眼神）。
所以你会依次看到：第一张的全景、第一张的人脸、第二张的全景、第二张的人脸。

为什么要给你人脸特写：这类照片人物往往只占画面很小一块，
在缩小后的整幅画面上人脸只有**几十个像素**，表情和眼神根本看不出来。
判断表情请以人脸特写为准，判断构图和姿态请以全景为准。

这两张在曝光、构图上通常几乎没有差别 —— 真正的差别在：
- 眼神：眼睛睁开的程度，有没有落点，是不是在看镜头或看向有意义的方向
- 表情：笑是不是到眼睛里，有没有僵硬、口型怪异、被抓拍到的中间态
- 眼神：有没有落点，是不是在看镜头或看向有意义的方向
- 姿态与手：身体和手的位置自然不自然，有没有多余的动作
- 人物关系：如果有多个人，互动是不是成立

曝光、亮度这类整体技术指标本机已经算过了，不用你重复判断。
**但清晰度是例外** —— 如果有一张明显失焦、人脸糊掉，那是真实的淘汰理由，
可以据此判断。（实测照片主人 35 次判断里有 5 次用的正是「失焦」，
而早先的提示词禁止模型用清晰度做决定 —— 那是错的。）

如果两张确实分不出高下，就诚实地选 TIE，不要硬凑一个赢家。`

/** 一次比较的结果。ids 用调用方给的顺序语义（FIRST/SECOND）。 */
export interface PairVerdict {
  a: string
  b: string
  /** 归一化回 a/b 语义后的赢家；两个方向不一致时为 'tie'。 */
  winner: 'a' | 'b' | 'tie'
  /** AB 和 BA 两个方向是否给出了一致的答案。 */
  consistent: boolean
  ab: 'first' | 'second' | 'tie'
  ba: 'first' | 'second' | 'tie'
  reason: string
}

const TOOL = {
  name: 'submit_comparison',
  description: '提交这两张照片的比较结论',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['winner', 'reason'],
    properties: {
      winner: {
        type: 'string',
        enum: ['FIRST', 'SECOND', 'TIE'],
        description: '哪一张更值得留下；确实分不出就 TIE',
      },
      reason: {
        type: 'string',
        description: '30 字以内，必须指出具体差别（表情/眼神/姿态/互动），不要说「更清晰」',
      },
    },
  },
} as const

function readVerdict(raw: Record<string, unknown>): { w: 'first' | 'second' | 'tie'; reason: string } {
  const w = String(raw.winner ?? '').toUpperCase()
  return {
    w: w === 'FIRST' ? 'first' : w === 'SECOND' ? 'second' : 'tie',
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : '',
  }
}

/**
 * 对一批照片对做 AB/BA 双向比较。
 *
 * 每对花 2 次模型调用。调用方负责控制对数 —— 这是整条链路里唯一花钱的地方。
 */
export async function comparePairs(
  pairs: ReadonlyArray<readonly [string, string]>,
  previews: Record<string, string>,
  /**
   * 每张照片的高清人脸裁切（base64 JPEG）。
   *
   * 为什么必须有：512px 的整幅小图上，环境人像的人脸只剩约 **30 像素**，
   * 91% 的照片不足 48 像素。而提示词却在要求模型判断「笑是不是到眼睛里」——
   * 它看不见，只能猜。v3 那 997 次调用的重评一致率只有 30%，
   * 正是瞎猜该有的样子。
   *
   * 没有人脸裁切的照片（没检出脸、脸太小）只发整幅图，不阻塞比较。
   */
  faces: Record<string, string>,
  services: HarnessVisionServices,
  exec: HarnessVisionExecution,
  onProgress?: (done: number, total: number) => void,
): Promise<{ verdicts: PairVerdict[]; route: string }> {
  const route = resolveHarnessModelRoute(exec)
  const transport = new HarnessVisionTransport(services, route, exec.agent?.session?.id)
  // 预检不通过就整轮停下 —— 不允许静默回落到别的模型。
  await transport.preflight(exec.signal)

  const out: PairVerdict[] = []
  for (const [a, b] of pairs) {
    const ja = previews[a]
    const jb = previews[b]
    if (!ja || !jb) {
      out.push({ a, b, winner: 'tie', consistent: false, ab: 'tie', ba: 'tie', reason: '缺少预览图，跳过' })
      continue
    }
    const fa = faces[a]
    const fb = faces[b]
    // 顺序：X 全景 → X 人脸 → Y 全景 → Y 人脸。提示词里说明了这个顺序。
    const bundle = (full: string, face: string | undefined) =>
      face ? [full, face] : [full]
    const ask = async (
      firstFull: string, firstFace: string | undefined,
      secondFull: string, secondFace: string | undefined,
    ) => readVerdict(
      await transport.invokeStructured({
        system: SYSTEM,
        user: '第一张和第二张，哪一张更值得留下？',
        jpegs: [...bundle(firstFull, firstFace), ...bundle(secondFull, secondFace)],
        tool: TOOL,
        maxTokens: 400,
      }, exec.signal),
    )
    const ab = await ask(ja, fa, jb, fb)
    const ba = await ask(jb, fb, ja, fa)
    // BA 的 first 指的是 b，所以要翻回 a/b 语义再比。
    const abPick = ab.w === 'first' ? 'a' : ab.w === 'second' ? 'b' : 'tie'
    const baPick = ba.w === 'first' ? 'b' : ba.w === 'second' ? 'a' : 'tie'
    const consistent = abPick === baPick && abPick !== 'tie'
    out.push({
      a, b,
      winner: consistent ? (abPick as 'a' | 'b') : 'tie',
      consistent,
      ab: ab.w, ba: ba.w,
      reason: consistent ? (ab.reason || ba.reason) : `两个方向不一致（AB=${ab.w} / BA=${ba.w}），判平局`,
    })
    onProgress?.(out.length, pairs.length)
  }
  return { verdicts: out, route: `${route.provider}/${route.model}` }
}
