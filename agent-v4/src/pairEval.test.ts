/**
 * run_pair_eval 主体的行为测试：烧码开关、逐对落盘、逐次调用落盘、判分行不假绿、幅数不变。
 *
 * 比较那一层用**真实的 comparePairs 与真实的 HarnessVisionTransport**，只 mock 最底层的
 * llm / attachments 两个服务 —— 所以「第 3 对的 BA 失败」是真从 transport 发出的调用里抛出来的，
 * 调用记录也是真由 transport 发出的，读码是真按 compare.ts 的解析走的。mock 把收到的附件
 * 解码回标签，像模型看图一样「读」出烧在上面的码。不花钱、不起 Python、不碰照片。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGE2_CODE_SEED, assignCodes } from './codes.ts'
import { comparePairs, type PairVerdict } from './compare.ts'
import {
  HarnessVisionTransport, resolveHarnessModelRoute,
  type HarnessVisionExecution, type HarnessVisionServices, type VisionCallRecord,
} from './harness-vision.ts'
import {
  callsPathOf, partialPathOf, runPairEval, toEvalRow,
  type PairEvalDeps, type PairEvalInput, type PairEvalPair, type PairEvalSpec,
} from './pairEval.ts'

/** 假图：base64 里就是 `种类:码:文件名`。Python 侧烧码 = 这里把码写进标签。 */
const img = (tag: string) => Buffer.from(tag).toString('base64')

const PAIRS: PairEvalPair[] = [
  { a: 'p1.JPG', b: 'p2.JPG', answer: 'a', kind: 'gold', local_correct: true, group: 0 },
  { a: 'p3.JPG', b: 'p4.JPG', answer: 'b', kind: 'gold', local_correct: false, group: 1 },
  { a: 'p5.JPG', b: 'p6.JPG', answer: 'a', kind: 'eyes', local_correct: true, group: 2 },
  { a: 'p7.JPG', b: 'p8.JPG', answer: 'b', kind: 'gold', local_correct: true, group: 3 },
]
const NAMES = [...new Set(PAIRS.flatMap((p) => [p.a, p.b]))]
/** 4 组锚点 × 2 张 × 2 幅 = 16 幅，与阶段 3 第三遍实发的形状一致。 */
const ANCHOR_JPEGS = Array.from({ length: 16 }, (_, k) => img(`anchor::${k}`))
const EXEC: HarnessVisionExecution = { agent: { options: { provider: 'mock', model: 'mock-vision' } } }

/** 改动前 run_pair_eval 一行的键，**连顺序**。不烧码时必须逐个相同 —— 结果文件才逐字节不变。 */
const LEGACY_KEYS = ['a', 'b', 'answer', 'kind', 'local_correct', 'group',
  'winner', 'consistent', 'ab', 'ba', 'reason', 'reason_ab', 'reason_ba', 'model_correct']
/**
 * 判据 §11.4 定死的码字段名，写成字面量钉住。算分脚本只认这一种写法 ——
 * 两边都兼容 camelCase 与 snake_case 的话，写错一边也不会红。
 */
const CODE_KEYS = ['code_a', 'code_b', 'code_read_ok', 'contradiction', 'codes_read']

function mockHarness(opts: { throwAt?: number; preflightFail?: 'local' | 'sent' } = {}) {
  const store = new Map<string, string>()
  const perCallImages: number[] = []
  let seq = 0
  let submits = 0
  const services = {
    attachments: {
      imageLimits: { maxImagesPerMessage: 40, maxMessageImageBytes: 50_000_000, mediaTypes: ['image/jpeg'] },
      async saveImages(inputs: ReadonlyArray<{ data: Uint8Array; mediaType: 'image/jpeg' }>) {
        return inputs.map((x) => {
          const attachmentId = `att-${seq++}`
          store.set(attachmentId, Buffer.from(x.data).toString())
          return { attachmentId, mediaType: x.mediaType, bytes: x.data.byteLength, width: 1, height: 1 }
        })
      },
    },
    llm: {
      async resolveModelInfo(provider: string, model: string) {
        // preflightFail='local'：不声明 image input → 预检的本地能力校验没过，还没发出
        return { provider, id: model, inputModalities: opts.preflightFail === 'local' ? ['text'] : ['text', 'image'] }
      },
      async prepareCall(config: Record<string, unknown> & { provider: string; model: string }) {
        return {
          config,
          async *stream(options: Record<string, unknown>) {
            const tool = (options.tools as Array<{ name: string; parameters: any }>)[0]!
            let args: Record<string, unknown>
            if (tool.name === 'photo_filter_model_preflight') {
              // preflightFail='sent'：预检请求已经交给模型之后才失败
              if (opts.preflightFail === 'sent') throw new Error('mock：预检调用失败')
              args = { ok: true, nonce: tool.parameters.properties.nonce.enum[0] }
            } else {
              submits++
              // 第 k 对的 AB 是第 2k−1 次比较调用，BA 是第 2k 次
              if (opts.throwAt && submits === opts.throwAt) {
                throw new Error(`mock：第 ${submits} 次比较调用失败`)
              }
              const tags = ((options.messages as Array<{ content: any[] }>)[0]!.content)
                .filter((c) => c.type === 'image')
                .map((c) => store.get(c.attachment.attachmentId)!)
              perCallImages.push(tags.length)
              args = { winner: 'JIA', reason: 'mock' }
              if (tool.parameters.properties.code_jia) {
                // 像模型看图一样把码「读」出来：最后两幅整幅图依次是甲、乙（无脸照片也成立）
                const fulls = tags.filter((t) => t.startsWith('full:'))
                const codeOf = (t: string) => t.split(':')[1]!
                const jia = codeOf(fulls[fulls.length - 2]!)
                args = { ...args, code_jia: jia, code_yi: codeOf(fulls[fulls.length - 1]!), winner_code: jia }
              }
            }
            yield { type: 'block-end', block: { type: 'tool-call', name: tool.name, arguments: JSON.stringify(args) } }
            // finish 的 reason 必须是对象 { kind }，不是字符串 —— harness-vision.ts 的
            // failureFromFinish 对非对象一律判 INVALID_FINISH（第一版 mock 就栽在这里）。
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          },
        }
      },
    },
  }
  return { services: services as unknown as HarnessVisionServices, perCallImages }
}

function setup(spec: Partial<PairEvalSpec>, harness: ReturnType<typeof mockHarness>, opts: { noFace?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pairEval-'))
  const outPath = join(dir, 'result.json')
  const seen = {
    previewCalls: 0,
    codeMap: undefined as Record<string, string> | undefined,
    compareArgs: undefined as Parameters<typeof comparePairs> | undefined,
    verdicts: undefined as PairVerdict[] | undefined,
  }
  const deps: PairEvalDeps = {
    async preview(_folder, names, _exclude, _size, _signal, withFace, _labelMap, codeMap) {
      seen.previewCalls++
      seen.codeMap = codeMap
      const tag = (kind: string, n: string) => img(`${kind}:${codeMap?.[n] ?? ''}:${n}`)
      const withFaces = names.filter((n) => !opts.noFace?.includes(n))
      return {
        previews: Object.fromEntries(names.map((n) => [n, tag('full', n)])),
        faces: withFace ? Object.fromEntries(withFaces.map((n) => [n, tag('face', n)])) : {},
        missing: [],
      }
    },
    async buildAnchorBlock() { return { text: '范例', jpegs: ANCHOR_JPEGS } },
    compare: (async (...args: Parameters<typeof comparePairs>) => {
      seen.compareArgs = args
      const r = await comparePairs(...args)
      seen.verdicts = r.verdicts
      return r
    }) as typeof comparePairs,
  }
  const input: PairEvalInput = {
    spec: { pairs: PAIRS, anchors: { text: '范例', photos: ['x1.JPG'] }, ...spec },
    use: PAIRS, folder: '/photos', exclude: [], rubric: null, allowNeither: false,
    outPath, services: harness.services, exec: EXEC,
  }
  return { dir, outPath, seen, deps, input }
}

/**
 * 读 jsonl。**文件不存在时返回空数组**，不抛 ENOENT。
 *
 * 为什么：「该写的那一行没写」这类变异（例如预检失败不记、去掉逐对追加），原来是被
 * readFileSync 的 ENOENT 崩红的 —— 红是红了，却红在读文件那一步，而不是红在
 * 「应当正好 N 行」的断言上，分不清是断言抓到的还是崩出来的。返回空数组之后，
 * 缺文件由断言自己报出来。每个调用方都断言了具体行数或内容，所以这不会放过任何东西。
 */
const readJsonl = (f: string) =>
  existsSync(f)
    ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>)
    : []
const readRows = (outPath: string) => JSON.parse(readFileSync(outPath, 'utf8')).rows as Array<Record<string, unknown>>
const DIRS_4 = PAIRS.flatMap((_, i) => [[i, 'AB'], [i, 'BA']])

// ── 1. 缺省不烧码：codes 实参是 undefined，判分行一个新字段都没有 ──
{
  const h = mockHarness()
  const s = setup({}, h)
  try {
    await runPairEval(s.input, s.deps)
    assert.equal(s.seen.codeMap, undefined, 'preview 收到的 codeMap 必须是 undefined')
    assert.ok(s.seen.compareArgs, 'comparePairs 应当被调用')
    // comparePairs 的第 7 个实参是 codes（pairs, previews, faces, anchors, rubric, allowNeither, codes, …）
    assert.strictEqual(s.seen.compareArgs![6], undefined, 'codes 实参必须是 undefined，不能是 {}')
    // 前提：源头确实是假绿 —— 不烧码时 verdict.codeReadOk 恒为 true。前提不成立，这条测试就是空转。
    assert.ok(s.seen.verdicts!.every((v) => v.codeReadOk === true), '前提：不烧码时源头 codeReadOk 恒为 true')
    for (const row of readRows(s.outPath)) {
      assert.deepEqual(Object.keys(row), LEGACY_KEYS, '不烧码时行的键（连顺序）必须与改动前逐个相同')
      assert.ok(!CODE_KEYS.some((k) => k in row), `不烧码时不许出现任何码字段：${JSON.stringify(row)}`)
    }
    assert.ok(!existsSync(partialPathOf(s.outPath)), '跑完之后逐对落盘文件应当已删除')
    const calls = readJsonl(callsPathOf(s.outPath))
    assert.deepEqual(calls.map((c) => c.kind), ['preflight', ...DIRS_4.map(() => 'compare')],
      '跑完之后逐次调用记录保留：开头 1 行预检，之后每对 AB、BA 各一行')
    const pre = calls[0]!
    assert.deepEqual([pre.i, pre.dir, pre.a, pre.b, pre.jpegs], [null, null, null, null, 0],
      '预检那一行没有考题下标与方向，也不带图')
    assert.deepEqual(calls.slice(1).map((c) => [c.i, c.dir]), DIRS_4)
    assert.ok(calls.every((c) => c.ok === true && c.sent === true && c.route === 'mock/mock-vision'))
    // 核算口径（owner 定）：比较调用数 kind == compare && sent；预检每次运行正好 1 行
    assert.equal(calls.filter((c) => c.kind === 'compare' && c.sent).length, PAIRS.length * 2)
    assert.equal(calls.filter((c) => c.kind === 'preflight').length, 1)
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
}

// ── 2. burn_codes=true：每张待判照片都有码，与生产同种子同函数，码字段是 snake_case ──
{
  const h = mockHarness()
  const s = setup({ burn_codes: true }, h)
  try {
    await runPairEval(s.input, s.deps)
    const cm = s.seen.codeMap
    assert.ok(cm && Object.keys(cm).length > 0, '烧码时 preview 必须收到非空 codeMap')
    assert.deepEqual(Object.keys(cm!).sort(), [...NAMES].sort(), '每张待判照片都要有码')
    assert.ok(Object.values(cm!).every((c) => /^[A-Z0-9]{4}$/.test(c)), '码是 4 位')
    assert.deepEqual(cm, assignCodes(NAMES, STAGE2_CODE_SEED), '码必须与生产阶段 2 同一个种子、同一个函数生成')
    assert.deepEqual(s.seen.compareArgs![6], cm, '烧在图上的码与交给 comparePairs 的码必须是同一份')
    for (const row of readRows(s.outPath)) {
      assert.deepEqual(Object.keys(row), [...LEGACY_KEYS, ...CODE_KEYS], '烧码时在原有键之后追加 snake_case 码字段')
      assert.equal(row.code_read_ok, true, 'mock 如实抄回了码，读码应当成功')
      assert.equal(typeof row.code_a, 'string')
      assert.ok(row.codes_read && typeof row.codes_read === 'object')
      for (const camel of ['codeA', 'codeB', 'codeReadOk', 'codesRead']) {
        assert.ok(!(camel in row), `不许同时写 camelCase（${camel}）—— 两种写法并存，写错一边也不会红`)
      }
    }
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
}

// ── 3. 第 3 对的 BA 失败：逐对 2 行、逐次 6 行（失败那行带错误），错误照常向上抛 ──
for (const burn of [false, true]) {
  const h = mockHarness({ throwAt: 6 })
  const s = setup({ burn_codes: burn }, h)
  try {
    await assert.rejects(() => runPairEval(s.input, s.deps), /第 6 次比较调用失败/,
      '错误必须照常向上抛，不许吞成平局或跳过')

    const pairs = readJsonl(partialPathOf(s.outPath))
    assert.equal(pairs.length, 2, `逐对落盘应当正好 2 行，实际 ${pairs.length}`)
    assert.deepEqual(pairs.map((l) => [l.i, l.a, l.b]), [[0, PAIRS[0]!.a, PAIRS[0]!.b], [1, PAIRS[1]!.a, PAIRS[1]!.b]])
    if (!burn) {
      assert.ok(pairs.every((l) => !CODE_KEYS.some((k) => k in l)), '不烧码时逐对落盘的行里也不许有码字段')
    } else {
      assert.ok(pairs.every((l) => l.code_read_ok === true), '烧码时逐对落盘的行带真实的读码结果')
    }

    const calls = readJsonl(callsPathOf(s.outPath))
    assert.equal(calls.length, 7,
      `逐次调用应当正好 7 行（1 预检 + 前两对 4 行 + 第 3 对 AB 成功 + BA 失败），实际 ${calls.length}`)
    assert.equal(calls[0]!.kind, 'preflight', '第一行是预检')
    const cmp = calls.slice(1)
    assert.ok(cmp.every((c) => c.kind === 'compare'), '之后全是比较调用')
    assert.deepEqual(cmp.map((c) => [c.i, c.dir]), DIRS_4.slice(0, 6))
    assert.ok(calls.slice(0, 6).every((c) => c.ok === true && c.error === undefined))
    const bad = calls[6]!
    assert.equal(bad.ok, false, '失败的调用也要写，并且标明失败')
    assert.match(bad.error, /第 6 次比较调用失败/, '失败那行要带错误信息')
    assert.equal(bad.sent, true, '这次已经交给了模型才失败 —— 算一次真实发出的调用')
    assert.ok(calls.every((c) => typeof c.ts === 'number' && c.route === 'mock/mock-vision'), '每行带时间戳与模型路由')

    assert.ok(!existsSync(s.outPath), '中途崩了不该写出最终结果文件')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
}

// ── 4. 上一次的落盘文件还在：开跑前就拒绝，一张图都不取，原数据原样保留 ──
for (const which of ['partial', 'calls'] as const) {
  const h = mockHarness()
  const s = setup({}, h)
  try {
    const f = which === 'partial' ? partialPathOf(s.outPath) : callsPathOf(s.outPath)
    writeFileSync(f, '{"i":0}\n')
    await assert.rejects(() => runPairEval(s.input, s.deps), (e: Error) => {
      assert.ok(e.message.includes(f), `报错要带上完整路径：${e.message}`)
      assert.ok(e.message.includes('先归档'), `报错要说「先归档」：${e.message}`)
      return true
    })
    assert.equal(s.seen.previewCalls, 0, '拒绝必须早于任何取图')
    assert.equal(readFileSync(f, 'utf8'), '{"i":0}\n', '上一次留下的数据原样保留')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
}

// ── 5. comparePairs 层：「缺少预览图，跳过」的那对也要回调，并且显式标 skipped ──
{
  const h = mockHarness()
  const seen: Array<[number, string, boolean]> = []
  const got: PairVerdict[] = []
  const previews = Object.fromEntries(['p1.JPG', 'p2.JPG', 'p5.JPG', 'p6.JPG'].map((n) => [n, img(`full::${n}`)]))
  await comparePairs(
    [['p1.JPG', 'p2.JPG'], ['p3.JPG', 'p4.JPG'], ['p5.JPG', 'p6.JPG']], previews, {}, null, null, false,
    undefined, h.services, EXEC,
    { onPair: (done, _total, v) => { seen.push([done, v.a, v.skipped === true]); got.push(v) } },
  )
  assert.deepEqual(seen, [[1, 'p1.JPG', false], [2, 'p3.JPG', true], [3, 'p5.JPG', false]],
    '跳过的那对也要回调、顺序与考题一致，并且只有它标 skipped')
  const row = toEvalRow(PAIRS[1]!, got[1]!, false) as Record<string, unknown>
  assert.equal(row.skipped, true, '没问模型的那一对在落盘行里必须显式标出')
  assert.notEqual(row.winner, 'tie', '没问模型的那一对绝不能长得像一局平局')
}

// ── 6. 幅数：烧码画在图上，烧与不烧每次调用的幅数相等，且等于锚点幅数 + 每张待判的实际幅数 ──
{
  const noFace = ['p3.JPG']       // 一张检不到脸：只发整幅。写死 20 的实现会在这里假红
  const expected = PAIRS.flatMap((p) => {
    const n = ANCHOR_JPEGS.length + (noFace.includes(p.a) ? 1 : 2) + (noFace.includes(p.b) ? 1 : 2)
    return [n, n]
  })
  assert.ok(expected.includes(19) && expected.includes(20), '夹具里必须同时有 20 幅和 19 幅的调用')
  const counts: number[][] = []
  for (const burn of [false, true]) {
    const h = mockHarness()
    const s = setup({ burn_codes: burn }, h, { noFace })
    try {
      await runPairEval(s.input, s.deps)
      counts.push([...h.perCallImages])
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }
  assert.deepEqual(counts[0], expected, `不烧码的幅数：${counts[0]}`)
  assert.deepEqual(counts[1], counts[0], `烧码与否每次调用的幅数必须相等：${counts[1]} vs ${counts[0]}`)
}

// ── 7. transport 层：被本地拦下的那次也记（sent=false），真发出的记 sent=true，预检也记（kind=preflight）──
{
  const h = mockHarness()
  const recs: VisionCallRecord[] = []
  const t = new HarnessVisionTransport(h.services, resolveHarnessModelRoute(EXEC), undefined, (r) => { recs.push(r) })
  await t.preflight()
  const tool = { name: 'submit_comparison', description: 'mock', parameters: { type: 'object', properties: {} } }
  await assert.rejects(
    () => t.invokeStructured({ system: 's', user: 'u', jpegs: [], tool, maxTokens: 10 }, undefined, { pair: 0, dir: 'AB' }),
    /JPEG/,
  )
  await t.invokeStructured({ system: 's', user: 'u', jpegs: [img('full::x.JPG')], tool, maxTokens: 10 }, undefined, { pair: 0, dir: 'BA' })
  assert.equal(recs.length, 3, '预检一行 + 两次比较调用各一行（被拦下的那次也记）')
  assert.deepEqual(recs.map((r) => [r.kind, r.ok, r.sent, r.meta?.dir]), [
    ['preflight', true, true, undefined],
    ['structured', false, false, 'AB'],
    ['structured', true, true, 'BA'],
  ])
  assert.match(recs[1]!.error ?? '', /JPEG/, '被拦下的那次带着拦下它的原因')
}

// ── 8. 预检失败：calls 正好 1 行（kind=preflight、ok=false，带错误），错误照常抛，一次比较都没发 ──
for (const how of ['sent', 'local'] as const) {
  const h = mockHarness({ preflightFail: how })
  const s = setup({}, h)
  try {
    await assert.rejects(() => runPairEval(s.input, s.deps),
      how === 'sent' ? /mock：预检调用失败/ : /image input/, '预检失败必须照常抛出，整轮停下')
    const calls = readJsonl(callsPathOf(s.outPath))
    assert.equal(calls.length, 1, `预检失败时逐次调用应当正好 1 行，实际 ${calls.length}`)
    const c = calls[0]!
    assert.equal(c.kind, 'preflight')
    assert.equal(c.ok, false)
    assert.ok(typeof c.error === 'string' && c.error.length > 0, '预检失败那行要带错误 —— 它说明整轮停在哪')
    // sent 与比较调用同一个判法：进了 stream 才失败是 true；本地能力校验没过、还没发出是 false
    assert.equal(c.sent, how === 'sent', `预检「${how}」失败时 sent 应为 ${how === 'sent'}`)
    assert.equal(h.perCallImages.length, 0, '预检失败时一次比较调用都不能发')
    assert.ok(!existsSync(partialPathOf(s.outPath)) && !existsSync(s.outPath), '没有逐对行，也没有结果文件')
  } finally { rmSync(s.dir, { recursive: true, force: true }) }
}

console.log('pairEval.test.ts: 全部通过')
