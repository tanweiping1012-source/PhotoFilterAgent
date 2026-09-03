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

const SYSTEM_TMPL = `你在帮一个人从自己的旅行照片里挑出值得留下的几张。
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

<<CODES>>这两张在曝光、构图上通常几乎没有差别，差别主要在表情、眼神、姿态这些地方。

曝光、亮度这类整体技术指标本机已经算过了，不用你重复判断。
**但清晰度是例外** —— 如果有一张明显失焦、人脸糊掉，那是真实的淘汰理由。

你有四个答案，**它们互不重叠，别混**：

    JIA      甲更值得留下
    YI       乙更值得留下
    TIE      两张**都够格**，但谁更好分不出来
    NEITHER  两张**都不够格**，一张都不值得留

TIE 和 NEITHER 最容易混：
  · 两张都拍得不错、难分高下     → TIE
  · 两张都有硬伤、留哪张都不合适  → NEITHER

**不要硬凑一个赢家。** 一组连拍整组都不值得留是常见情况，
遇到就答 NEITHER，那是一个正常答案，不是弃权。`

/**
 * 烧码那一段。**只在真的烧了码时才放进提示词** ——
 * 没烧码却叫模型「把黑边里的码抄回来」，它只能编一个，
 * 那不是内容寻址，是给自己造幻觉。
 *
 * 措辞与 instrument.ts 逐字相同：99.4% 的读码率是在这个措辞下测出来的，
 * 改字等于换了被测对象。
 */
const CODES_BLOCK = `**每幅图的上方黑边里写着一个 4 位编码。** 同一张照片的整幅和人脸写的是
同一个码；甲和乙的码不同。回答时要把码原样抄回来 —— 这是为了让答案能对上
具体哪一张照片，不依赖「甲/乙」这两个字。

`

const makeSystem = (withCodes: boolean) =>
  SYSTEM_TMPL.replace('<<CODES>>', withCodes ? CODES_BLOCK : '')

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
  winner: 'a' | 'b' | 'tie' | 'neither' | 'inconsistent'
  /** AB 和 BA 两个方向是否给出了一致的答案。 */
  consistent: boolean
  ab: 'first' | 'second' | 'tie' | 'neither'
  ba: 'first' | 'second' | 'tie' | 'neither'
  /** 两个方向各自的模型原话。不一致时 reason 是模板句，原文只在这里。 */
  reasonAb?: string
  reasonBa?: string
  reason: string
  /** 烧在两张照片上的码（没烧码时缺省）。 */
  codeA?: string
  codeB?: string
  /** 四个码位（两方向 × 甲乙）是否都抄对了。 */
  codeReadOk?: boolean
  /**
   * 模型**实际抄回来**的四个码，原样保留。
   *
   * 为什么要存：只存 codeReadOk 这个布尔值，抄错时就查不下去了 ——
   * 分不清是 OCR 糊了、串了行、还是抄成了锚点图上的码。
   * 2026-09-04 生产实测 68/70 抄对，剩下那 2 次正是因为没存原文而无法归因。
   * 一次比较的文本量很小，不值得为省这点体积放弃可诊断性。
   */
  codesRead?: { abJia: string; abYi: string; baJia: string; baYi: string }
  /** 模型的槽位答案与它给的码互相矛盾（说甲却给乙的码）。 */
  contradiction?: boolean
}

const makeTool = (allowNeither: boolean, withCodes: boolean) => ({
  name: 'submit_comparison',
  description: '提交这两张照片的比较结论',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: withCodes
      ? ['code_jia', 'code_yi', 'winner', 'winner_code', 'reason']
      : ['winner', 'reason'],
    properties: {
      // ── 内容寻址的答案通道 ───────────────────────────────────
      //
      // 只有 winner（JIA/YI）时，答案本身就是**槽位标签** ——
      // 一个不看图、只按位置作答的模型也能把它填满，我们分辨不出来。
      // 让它把码抄回来，答案就指向具体那张照片，与位置无关。
      //
      // winner 和 winner_code 同时要，是**故意冗余**：两者矛盾
      // （说 JIA 却给了乙的码）本身就是一条信息，见 resolvePick。
      ...(withCodes ? {
        code_jia: { type: 'string', description: '照片甲上方黑边里的 4 位编码，原样抄' },
        code_yi: { type: 'string', description: '照片乙上方黑边里的 4 位编码，原样抄' },
        winner_code: {
          type: 'string',
          description: '你选中那张照片的 4 位编码，原样抄；答 TIE 或 NEITHER 时填空字符串',
        },
      } : {}),
      winner: {
        type: 'string',
        // 枚举也不能用序数 —— FIRST/SECOND 同样有「第几幅图」的歧义。
        // NEITHER 是**可选**的第四个答案，由 allowNeither 开关控制。
        //
        // 为什么需要它：标注者 75 组判断里有 26 组（35%）是「整组都不要」，
        // 而三选一的答案空间没有这个格子 —— 模型即使想说也只能塞进 TIE，
        // 于是「两张一样好」和「两张都不行」被压成同一个符号。
        // 这不是提示词写得不够清楚，是接口里没有那个位置。
        //
        // 默认关闭：开了它就换了被测对象，不能和之前几轮直接比。
        enum: allowNeither ? ['JIA', 'YI', 'TIE', 'NEITHER'] : ['JIA', 'YI', 'TIE'],
        description: allowNeither
          ? '哪一张更值得留下：JIA=甲，YI=乙；两张都好但分不出高下用 TIE；'
            + '**两张都不值得留下用 NEITHER** —— TIE 和 NEITHER 是不同的答案，别混'
          : '哪一张照片更值得留下：JIA=照片甲，YI=照片乙；确实分不出就 TIE',
      },
      reason: {
        type: 'string',
        // 「不要说更清晰」这句已删 —— 它和上面刚撤销的清晰度禁令自相矛盾。
        // 照片主人 35 次判断里有 5 次正是因为失焦淘汰的。
        description: '30 字以内，必须指出具体差别（眼神/脸型光影/失焦/构图/姿态），不要泛泛说「更好看」',
      },
    },
  },
}) as const

export interface RawVerdict {
  /** 模型按**槽位**给的答案。烧码时它只作为矛盾检测的一边，不作准。 */
  w: 'first' | 'second' | 'tie' | 'neither'
  reason: string
  /** 模型抄回来的三个码（大写去空白）。没烧码时都是空串。 */
  readJia: string
  readYi: string
  winnerCode: string
}

function readVerdict(raw: Record<string, unknown>): RawVerdict {
  const w = String(raw.winner ?? '').toUpperCase()
  const up = (x: unknown) => String(x ?? '').trim().toUpperCase()
  return {
    // 内部仍用 first/second 表示「这次调用里排前/排后的那张照片」，
    // 只是问模型时不再用序数措辞。
    w: w === 'JIA' ? 'first' : w === 'YI' ? 'second' : w === 'NEITHER' ? 'neither' : 'tie',
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : '',
    readJia: up(raw.code_jia), readYi: up(raw.code_yi), winnerCode: up(raw.winner_code),
  }
}

/**
 * 把一次调用的原始答案解析成「排在前的那张 / 排在后的那张 / 平局 / 都不要」。
 *
 * **烧了码就以码为准。** 这是这套机制的全部意义：
 * winner（JIA/YI）是槽位标签，一个只按位置作答的模型也能填满它；
 * 而 winner_code 指向具体那张照片，位置换了码不换。
 *
 * 两者矛盾（说 JIA 却给了乙的码）时取码，并把矛盾记下来 —— 它是一条真实信息，
 * 不是噪声。码对不上任何一张（幻觉码）时这一次调用作废，
 * 不能猜：猜就等于把「没读到图」洗成一个正常答案。
 */
export function resolvePick(
  r: RawVerdict, firstCode: string | undefined, secondCode: string | undefined,
): { pick: 'first' | 'second' | 'tie' | 'neither' | 'bad-code'; contradiction: boolean } {
  // 没烧码：退回槽位语义，与烧码之前逐字节一致。
  if (!firstCode || !secondCode) return { pick: r.w, contradiction: false }
  // 平局与都不要是位置无关的判断，本来就没有 winner_code。
  if (r.w === 'tie' || r.w === 'neither') return { pick: r.w, contradiction: false }
  const byCode = r.winnerCode === firstCode ? 'first' as const
    : r.winnerCode === secondCode ? 'second' as const : null
  if (byCode === null) return { pick: 'bad-code', contradiction: false }
  return { pick: byCode, contradiction: byCode !== r.w }
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
  /**
   * 用户的判据文本（rubric）。拼在系统提示词里，排在锚点之前 ——
   * 先给规则，再给演示规则的范例。
   *
   * 它和 anchors **相互独立**：可以只给规则不给范例（AB 实验的「仅规则」臂），
   * 也可以两个都给。别把它塞进 AnchorBlock —— 那样「仅规则」就没法表达了。
   */
  rubric: string | null,
  /**
   * 允许模型回答「两张都不值得留下」。
   *
   * 默认 false —— 开了它就换了被测对象（答案空间从 3 个变 4 个），
   * 与之前几轮不可直接比。要开就单独跑一轮、单独预登记判据。
   */
  allowNeither: boolean,
  /**
   * 照片名 → 烧在图上的 4 位码。**给了才启用内容寻址的答案通道。**
   *
   * 不给（undefined 或空）时行为与以前逐字节相同 —— 提示词不提码、
   * 工具不要码、按槽位解析。评测路径（run_pair_eval）保持不给，
   * 这样它与历史轮次仍然可比；生产阶段 2 给。
   */
  codes: Record<string, string> | undefined,
  services: HarnessVisionServices,
  exec: HarnessVisionExecution,
  onProgress?: (done: number, total: number) => void,
): Promise<{ verdicts: PairVerdict[]; route: string }> {
  const withCodes = !!codes && Object.keys(codes).length > 0
  const route = resolveHarnessModelRoute(exec)
  const transport = new HarnessVisionTransport(services, route, exec.agent?.session?.id)
  // 预检不通过就整轮停下 —— 不允许静默回落到别的模型。
  await transport.preflight(exec.signal)

  const out: PairVerdict[] = []
  for (const [a, b] of pairs) {
    const ja = previews[a]
    const jb = previews[b]
    if (!ja || !jb) {
      out.push({ a, b, winner: 'inconsistent', consistent: false, ab: 'tie', ba: 'tie', reason: '缺少预览图，跳过' })
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
        system: [makeSystem(withCodes), rubric || null, anchors ? anchors.text : null]
          .filter(Boolean).join('\n\n'),
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
        tool: makeTool(allowNeither, withCodes),
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
    const ca = codes?.[a]
    const cb = codes?.[b]
    // AB 这次排前的是 a；BA 这次排前的是 b。码要按**这次调用的排法**去对。
    const abR = resolvePick(ab, ca, cb)
    const baR = resolvePick(ba, cb, ca)
    // 幻觉码：模型给的码两张都不是。这一次调用没有可信答案。
    if (abR.pick === 'bad-code' || baR.pick === 'bad-code') {
      out.push({
        a, b, winner: 'inconsistent', consistent: false,
        ab: ab.w, ba: ba.w, reasonAb: ab.reason, reasonBa: ba.reason,
        codeA: ca, codeB: cb, codeReadOk: false, contradiction: false,
        codesRead: { abJia: ab.readJia, abYi: ab.readYi, baJia: ba.readJia, baYi: ba.readYi },
        reason: `模型给的编码对不上任何一张（AB=${ab.winnerCode || '空'} / `
          + `BA=${ba.winnerCode || '空'}，实际 ${ca}/${cb}），本对作废`,
      })
      onProgress?.(out.length, pairs.length)
      continue
    }
    // BA 的 first 指的是 b，所以要翻回 a/b 语义再比。
    const abPick = abR.pick === 'first' ? 'a' : abR.pick === 'second' ? 'b'
      : abR.pick === 'neither' ? 'neither' : 'tie'
    const baPick = baR.pick === 'first' ? 'b' : baR.pick === 'second' ? 'a'
      : baR.pick === 'neither' ? 'neither' : 'tie'
    // 四个码位是否都抄对了。抄错不作废（答案仍由 winner_code 定），
    // 但它是「这次看清了没有」的直接证据，必须留档。
    const codeReadOk = !withCodes
      || (ab.readJia === ca && ab.readYi === cb && ba.readJia === cb && ba.readYi === ca)
    // 「都不要」是位置无关的判断，所以两个方向都答 neither 才算一致 ——
    // 和 tie 不同：tie 也位置无关，但它表示「分不出」，
    // 而 neither 表示「都不够格」。两次都说都不够格，是真的一致。
    //
    // ⚠️ tie 这里**故意**排除在 consistent 之外：两次都答 tie 不代表判断稳定，
    // 只代表两次都放弃。但下面 winner 的赋值必须把它和「翻覆」分开 —— 见注释。
    const consistent = abPick === baPick && abPick !== 'tie'
    // 两次都**主动**答平局。它和「翻覆」是完全不同的事，不能记成同一个值。
    const bothTie = abPick === 'tie' && baPick === 'tie'
    out.push({
      a, b,
      // 翻覆必须有自己的值，不能记成 'tie'。
      //
      // 踩过的坑（2026-09-03 实测）：原来翻覆一律记成 'tie'，
      // 而同层档的真值就是 'tie' —— 于是**越不自洽，那一档分数越高**。
      // 实测「答对率 ≡ 1 − 双向一致率」三组逐个恒等；
      // 判对的 37/36/43 对里，真正两次都主动答平局的只有 1/1/2 对。
      // 那一档没有测到任何关于平局识别的东西，还反过来奖励了不稳定。
      //
      // 拆开之后：'tie' 只表示「两次都主动说分不出」，
      // 'inconsistent' 表示翻覆，它在**任何**真值下都判错。
      winner: consistent ? (abPick as 'a' | 'b' | 'neither')
        : (bothTie ? 'tie' : 'inconsistent'),
      consistent,
      ab: ab.w, ba: ba.w,
      // 两个方向的**原话**都留下。
      //
      // 原来只有一个 reason 字段，不一致时被「两个方向不一致（…），判平局」
      // 这句自动生成的话覆盖掉 —— 模型说过什么就没了。
      // 按项目历史双向一致率只有 45%，那等于一半以上的调用**没有留下推理过程**，
      // 而「模型到底怎么想的」正是这一轮要交付的东西之一：
      // 指代用不用烧入的名字、有没有引用范例、答案有没有漏进理由，
      // 这几项在不一致的对上就全都查不了。
      reasonAb: ab.reason,
      reasonBa: ba.reason,
      codeA: ca, codeB: cb, codeReadOk,
      codesRead: withCodes
        ? { abJia: ab.readJia, abYi: ab.readYi, baJia: ba.readJia, baYi: ba.readYi }
        : undefined,
      // 任一方向出现「说甲却给乙的码」都记为矛盾。
      contradiction: abR.contradiction || baR.contradiction,
      // 保留 reason 供既有的展示逻辑用；不一致时它是模板句，
      // 要看原文一律去 reasonAb / reasonBa。
      reason: consistent ? (ab.reason || ba.reason) : `两个方向不一致（AB=${ab.w} / BA=${ba.w}），判平局`,
    })
    onProgress?.(out.length, pairs.length)
  }
  return { verdicts: out, route: `${route.provider}/${route.model}` }
}
