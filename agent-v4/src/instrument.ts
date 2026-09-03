/**
 * 仪器标定：测的不是 rubric 好不好，是**这台仪器准不准**。
 *
 * ━━ 为什么要单独一个模块 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 前几轮所有结论都建立在一个观测量上：AB 与 BA 是否一致。而这一个量同时被
 * 三件事驱动，三者对它的预测**完全相同**：
 *
 *     A 位置偏好      系统性偏好某个槽位
 *     B 决策边界任意  连拍近重复上模型本来就没有可靠信号
 *     C 理由是编的    文本不携带照片信息
 *
 * 一个观测量分不开三件事 —— 上一轮那个「甲乙对调后相似度反而更低」的检验
 * 就是这么退化成同义反复的：它选的子集（两次答同一槽位）本身就定死了不等号
 * 方向，A 和 B 给出一模一样的预测。安慰剂对照（把 BA 理由换成完全无关的另一对）
 * 几乎原样复现了那个差值，证明它测的是句式，不是模型行为。
 *
 * 所以这里加条件，每个条件只动一个变量：
 *
 *     AB   甲=a 乙=b                        基线
 *     AB2  甲=a 乙=b，逐字节相同的重复调用    噪声地板 ε（temp=0 应为 0）
 *     AB3  甲=a′乙=b′，重编码、肉眼无差       扰动敏感 δ
 *     BA   甲=b 乙=a                        位置效应（含 δ、ε）
 *
 *     位置效应 = d(AB,BA) − δ − ε
 *
 * ━━ 答案通道为什么要改 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * compare.ts 的答案是 enum ['JIA','YI','TIE'] —— **这三个符号本身就是槽位标签**，
 * 一个只看位置的模型不看任何一张图就能把它填满。也就是说答案通道在设计上
 * 就无法区分「看了图」和「填了槽」。
 *
 * 这里给每张物理照片烧一个随机码（加边，不覆盖画面），答案要求把码抄回来：
 *
 *     两个码都读对 + winner_code 跟着物理照片走   → 内容驱动
 *     两个码都读对 + winner_code 跟着槽位走       → 位置驱动，且 OCR 已被排除
 *     码读错                                     → 图像通道有问题，位置之争无意义
 *     winner_code 两个码都不是                   → 幻觉，直接证据
 *
 * 附带效果：**我们这边的位置映射整个消失了**。compare.ts 里那段
 * `abPick = ab.w === 'first' ? 'a' : …` 不再需要 —— 模型直接说出是哪张照片，
 * 「是不是我们自己算错了位置」这个疑问从结构上不可能再发生。
 *
 * ⚠️ 烧码 + 多要两个字段**换了被测对象**，本轮与历史轮次不可直接比较，
 *    判据单独预登记（INSTRUMENT-CHECK.md）。理由同 compare.ts 里 allowNeither 那条。
 */

import { appendFileSync } from 'node:fs'
import type { HarnessVisionExecution, HarnessVisionServices } from './harness-vision.ts'
import { HarnessVisionTransport, resolveHarnessModelRoute } from './harness-vision.ts'

/** 去掉易混字（0/O、1/I/L、2/Z、5/S、8/B）。码读错 = 测试失效，不值得省这几个字符。 */
// 码与随机源搬进 codes.ts —— 生产的比较路径也要用同一套，
// 两处各写一份迟早会分叉。这里原样再导出，外部引用不受影响。
export { makeCode, mulberry32 } from './codes.ts'

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

**每幅图的上方黑边里写着一个 4 位编码。** 同一张照片的整幅和人脸写的是
同一个码；甲和乙的码不同。回答时要把码原样抄回来 —— 这是为了让答案能对上
具体哪一张照片，不依赖「甲/乙」这两个字。

这两张在曝光、构图上通常几乎没有差别，差别主要在表情、眼神、姿态这些地方。
曝光、亮度这类整体技术指标本机已经算过了，不用你重复判断。
**但清晰度是例外** —— 如果有一张明显失焦、人脸糊掉，那是真实的淘汰理由。

你有四个答案，**它们互不重叠，别混**：

    JIA      甲更值得留下
    YI       乙更值得留下
    TIE      两张**都够格**，但谁更好分不出来
    NEITHER  两张**都不够格**，一张都不值得留

**不要硬凑一个赢家。** 一组连拍整组都不值得留是常见情况，
遇到就答 NEITHER，那是一个正常答案，不是弃权。`

const TOOL = {
  name: 'submit_comparison',
  description: '提交这两张照片的比较结论',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['code_jia', 'code_yi', 'winner', 'winner_code', 'reason'],
    properties: {
      // 先抄码再判断：两个码读对不对，是「模型到底有没有看图」的前置检查。
      // 读不对的话，位置驱动 vs 内容驱动之争没有意义 —— 先修图像通道。
      code_jia: { type: 'string', description: '照片甲上方黑边里的 4 位编码，原样抄' },
      code_yi: { type: 'string', description: '照片乙上方黑边里的 4 位编码，原样抄' },
      winner: {
        type: 'string',
        enum: ['JIA', 'YI', 'TIE', 'NEITHER'],
        description: '哪一张更值得留下：JIA=甲，YI=乙；都好但分不出用 TIE；都不值得留用 NEITHER',
      },
      // 和 winner 同时要，是**故意冗余**：两者矛盾（说 JIA 却给乙的码）本身
      // 就是一条直接证据，比任何聚合统计都硬。
      winner_code: {
        type: 'string',
        description: '你选中那张照片的 4 位编码。答 TIE 或 NEITHER 时填 NONE',
      },
      face_box: {
        type: 'array',
        items: { type: 'number' },
        description: '可选：你选中那张的人脸特写里，让你做出判断的区域，'
          + '归一化坐标 [x0,y0,x1,y1]，取值 0–1。判不了就不填',
      },
      reason: { type: 'string', description: '一句话，不超过 40 字' },
    },
  },
}

/** grounding 探针：只给一幅图，问它上方那条黑边在哪。真值是精确已知的。 */
const PROBE_TOOL = {
  name: 'submit_box',
  description: '提交你框出的区域',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['bar_box', 'code'],
    properties: {
      // 用黑边而不是人脸做探针，因为**黑边的真值是精确的**（0,0,宽,条高），
      // 不需要另一套人脸检测来提供真值。如果连一条高对比度的黑边都框不准，
      // 就更不可能框准「让它做判断的那块脸」。
      bar_box: {
        type: 'array', items: { type: 'number' },
        description: '图片上方那条写着编码的黑边，归一化坐标 [x0,y0,x1,y1]，取值 0–1',
      },
      code: { type: 'string', description: '黑边里写的 4 位编码' },
    },
  },
}

export interface CallRow {
  phase: 'probe' | 'matrix' | 'aa' | 'sanity'
  condition?: string
  pair?: string
  a?: string
  b?: string
  slot_jia?: string
  slot_yi?: string
  code_jia?: string
  code_yi?: string
  read_jia?: string
  read_yi?: string
  winner?: string
  winner_code?: string
  winner_photo?: string | null
  winner_slot?: 'jia' | 'yi' | null
  contradiction?: boolean
  face_box?: number[] | null
  bbox?: number[] | null
  bbox_on_face?: boolean
  face_box_truth?: number[] | null
  correct?: boolean
  reason?: string
  ts?: number
}

/** 逐次调用落盘。用 jsonl 而不是跑完写一个大 json —— 936 次那轮中断过，
 *  中断之后已经花掉的调用必须留得下来，而且进度页要能逐次刷新。 */
export function appendRow(file: string, row: CallRow): void {
  appendFileSync(file, JSON.stringify({ ...row, ts: Date.now() }) + '\n', 'utf8')
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 框可能给 0–1，也可能给 0–1000（两种约定都常见）。按量级判，别猜。 */
export function normBox(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null
  const v = raw.slice(0, 4).map(num)
  if (v.some((x) => x === null)) return null
  const b = v as number[]
  const scale = b.some((x) => x > 1.5) ? (b.some((x) => x > 100) ? 1000 : 100) : 1
  return b.map((x) => x / scale)
}

export function iou(p: number[], q: number[]): number {
  const x0 = Math.max(p[0], q[0]), y0 = Math.max(p[1], q[1])
  const x1 = Math.min(p[2], q[2]), y1 = Math.min(p[3], q[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const ap = Math.max(0, p[2] - p[0]) * Math.max(0, p[3] - p[1])
  const aq = Math.max(0, q[2] - q[0]) * Math.max(0, q[3] - q[1])
  const u = ap + aq - inter
  return u > 0 ? inter / u : 0
}

export interface Slots {
  jia: { photo: string; full: string; face?: string; code: string }
  yi: { photo: string; full: string; face?: string; code: string }
}

export async function askPair(
  transport: HarnessVisionTransport, slots: Slots, signal?: AbortSignal,
): Promise<Partial<CallRow>> {
  // 一次调用里两个码必须不同，否则 winner_code 指不出是哪一张，
  // 整对数据静默作废。碰撞概率约 1/390625，但静默作废的代价太大，断言掉。
  if (slots.jia.code === slots.yi.code) {
    throw new Error(`甲乙拿到了同一个码 ${slots.jia.code}，这一对无法判别`)
  }
  const bundle = (full: string, face?: string) => (face ? [full, face] : [full])
  const raw = await transport.invokeStructured({
    system: SYSTEM,
    user: '照片甲和照片乙，哪一张更值得留下？先把两张图上方黑边里的编码抄下来，再回答。',
    jpegs: [...bundle(slots.jia.full, slots.jia.face), ...bundle(slots.yi.full, slots.yi.face)],
    tool: TOOL,
    maxTokens: 2000,
  }, signal)
  const readJia = String(raw.code_jia ?? '').trim().toUpperCase()
  const readYi = String(raw.code_yi ?? '').trim().toUpperCase()
  const winner = String(raw.winner ?? '').trim().toUpperCase()
  const wcode = String(raw.winner_code ?? '').trim().toUpperCase()
  // 归一化到**物理照片**，不经过槽位。这是这一轮唯一的映射，而且是模型自己给的。
  const winnerPhoto = wcode === slots.jia.code ? slots.jia.photo
    : wcode === slots.yi.code ? slots.yi.photo : null
  const winnerSlot = wcode === slots.jia.code ? 'jia' : wcode === slots.yi.code ? 'yi' : null
  // 冗余字段互相矛盾 = 直接证据，单独记下来，不要在这里"修正"它。
  const contradiction = (winner === 'JIA' && winnerSlot === 'yi')
    || (winner === 'YI' && winnerSlot === 'jia')
  return {
    slot_jia: slots.jia.photo, slot_yi: slots.yi.photo,
    code_jia: slots.jia.code, code_yi: slots.yi.code,
    read_jia: readJia, read_yi: readYi,
    winner, winner_code: wcode,
    winner_photo: winnerPhoto, winner_slot: winnerSlot,
    contradiction,
    face_box: normBox(raw.face_box),
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : '',
  }
}

export async function probeGrounding(
  transport: HarnessVisionTransport, full: string, code: string,
  barFraction: number, signal?: AbortSignal,
): Promise<Partial<CallRow>> {
  const raw = await transport.invokeStructured({
    system: '你在看一幅图。图的**最上方**有一条黑边，里面写着一个 4 位编码。',
    user: '把那条黑边的位置框出来，并把里面的编码抄下来。',
    jpegs: [full],
    tool: PROBE_TOOL,
    maxTokens: 2000,
  }, signal)
  const box = normBox(raw.bar_box)
  const truth = [0, 0, 1, barFraction]
  return {
    bbox: box,
    face_box_truth: truth,
    // 阈值 0.5：框对一条横贯全宽的边并不难，达不到 0.5 说明 grounding 不能用。
    bbox_on_face: box ? iou(box, truth) >= 0.5 : false,
    read_jia: String(raw.code ?? '').trim().toUpperCase(),
    code_jia: code,
    reason: box ? `IoU=${iou(box, truth).toFixed(2)}` : '没返回框',
  }
}

export function newTransport(
  services: HarnessVisionServices, exec: HarnessVisionExecution,
): { transport: HarnessVisionTransport; route: string } {
  const route = resolveHarnessModelRoute(exec)
  return {
    transport: new HarnessVisionTransport(services, route, exec.agent?.session?.id),
    route: `${route.provider}/${route.model}`,
  }
}
