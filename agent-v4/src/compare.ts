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

要比较的是**两张照片**，这里叫**照片甲**和**照片乙**。

每张照片给你两幅图：整幅画面（看构图、姿态、环境）+ 人脸放大后的高清裁切
（看表情、眼神）。

**要判的这两张永远在最后四幅**，倒着数最清楚：

    倒数第 4 幅 = 照片甲的整幅画面
    倒数第 3 幅 = 照片甲的人脸特写    ← 这两幅是**同一张照片**
    倒数第 2 幅 = 照片乙的整幅画面
    倒数第 1 幅 = 照片乙的人脸特写    ← 这两幅是**同一张照片**

前面可能还有若干幅范例图（如果有，开头会说明），**不要拿它们跟甲乙比**。

**注意：甲的整幅和甲的人脸是同一张照片的两个视角，不要拿它们互相比。**
要比的是「甲」和「乙」这两张照片。

为什么要给你人脸特写：这类照片人物往往只占画面很小一块，
在缩小后的整幅画面上人脸只有**几十个像素**，表情和眼神根本看不出来。
判断表情请以人脸特写为准，判断构图和姿态请以全景为准。

这两张在曝光、构图上通常几乎没有差别。下面的判据**按重要性排列**，
顺序来自照片主人自己 35 次判断的实际频次 —— 不是猜的：

- **眼神（27/35 次）**：睁开到位没有、有没有落点。
  他的标准比「能看见眼睛」严得多 —— 眯着、半睁、无神、瞪眼，他都算不合格。
  这一条压倒性重要，其余几条加起来都没它多。
- **脸型与光影（8/35）**：这个角度、这束光下，脸型五官顺不顺，
  脸上的光影层次乱不乱
- **失焦（5/35）**：主体是不是实的
- **构图引导物（4/35）**：人在低头或看向别处时，画面里有没有对应的视觉落点。
  单纯低头看路、没有引导物，他认为没有意义
- **姿态与手（2/35）**：身体和手自然不自然
- **表情（2/35）**：僵硬、口型怪异、被抓拍到的中间态

曝光、亮度这类整体技术指标本机已经算过了，不用你重复判断。
**但清晰度是例外** —— 如果有一张明显失焦、人脸糊掉，那是真实的淘汰理由，
可以据此判断。（实测照片主人 35 次判断里有 5 次用的正是「失焦」，
而早先的提示词禁止模型用清晰度做决定 —— 那是错的。）

如果两张确实分不出高下，就诚实地选 TIE，不要硬凑一个赢家。`

/** 一次比较的结果。ids 用调用方给的顺序语义（FIRST/SECOND）。 */
/** 锚点块：提示词文本 + 按顺序附上的图片。 */
export interface AnchorBlock {
  /** 由 photofilter_rank.anchors.build_anchor_block 生成的说明文本。 */
  text: string
  /** 范例照片的 base64 JPEG，顺序必须与 text 里的编号一致。 */
  jpegs: string[]
}

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
        // 枚举也不能用序数 —— FIRST/SECOND 同样有「第几幅图」的歧义。
        enum: ['JIA', 'YI', 'TIE'],
        description: '哪一张照片更值得留下：JIA=照片甲，YI=照片乙；确实分不出就 TIE',
      },
      reason: {
        type: 'string',
        // 「不要说更清晰」这句已删 —— 它和上面刚撤销的清晰度禁令自相矛盾。
        // 照片主人 35 次判断里有 5 次正是因为失焦淘汰的。
        description: '30 字以内，必须指出具体差别（眼神/脸型光影/失焦/构图/姿态），不要泛泛说「更好看」',
      },
    },
  },
} as const

function readVerdict(raw: Record<string, unknown>): { w: 'first' | 'second' | 'tie'; reason: string } {
  const w = String(raw.winner ?? '').toUpperCase()
  return {
    // 内部仍用 first/second 表示「这次调用里排前/排后的那张照片」，
    // 只是问模型时不再用序数措辞。
    w: w === 'JIA' ? 'first' : w === 'YI' ? 'second' : 'tie',
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
  /**
   * 锚点：几组「这个人自己怎么挑的」范例，连图带原话放进提示词。
   *
   * 为什么需要：提示词里的判据清单原先是猜的，既没有「失焦」也没有「头歪」，
   * 而且还禁止模型用清晰度做判断 —— 正好和照片主人的第一条理由相反。
   * 范例能直接把他的标准示范出来，比任何描述都准。
   *
   * **锚点组必须与考题组互斥**，否则是泄题 —— 模型在提示词里见过答案了。
   * 切分由 photofilter_rank.anchors 负责，这里只负责把它拼进提示词。
   *
   * 传空数组 = 不用锚点。
   */
  anchors: AnchorBlock | null,
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
        // 锚点拼在系统提示词末尾，范例图排在待比较的图之前 ——
        // 模型先看懂这个人在意什么，再回答问题。
        system: anchors ? `${SYSTEM}\n\n${anchors.text}` : SYSTEM,
        // 绝不能用「第一张/第二张」这种序数。
        //
        // 踩过的坑：一次调用有 18 幅图（14 幅锚点 + 4 幅考题），说「第一张和第二张」
        // 时模型完全可以理解成「最后四幅里的第 1、2 幅」—— 而那两幅
        // **都属于照片甲**（甲的全景 + 甲的人脸）。也就是说它在拿一张照片
        // 跟它自己比。这能解释体检题里 40% 的平局和那些自相矛盾的理由。
        user: anchors
          ? '按上面那个人的标准，照片甲和照片乙，哪一张更值得留下？'
          : '照片甲和照片乙，哪一张更值得留下？',
        jpegs: [
          ...(anchors?.jpegs ?? []),
          ...bundle(firstFull, firstFace), ...bundle(secondFull, secondFace),
        ],
        tool: TOOL,
        // 400 太小。MiniMax-M3 这类会先推理再输出的模型，思考 token 也算在输出里，
        // 18 张图 + 6 条判据的题目上经常没写到工具调用就用光了 ——
        // 表现是「结构化视觉输出达到 maxTokens，结果未接受」，整轮中断。
        //
        // 实测：47 对的那轮 400 勉强够（没中断），换成体检题就撞上了。
        // 边界这么近说明本来就该放宽，不是运气问题。
        maxTokens: 2000,
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
