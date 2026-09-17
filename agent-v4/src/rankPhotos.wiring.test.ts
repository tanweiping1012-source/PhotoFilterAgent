/**
 * rank_photos 闭包的接线行为测试。**0 次付费调用**，不用 key，约 10 秒。
 *
 * 为什么要有这一份：stage3.test.ts 测的是 runStage3 这个模块，而**运行记录、交付名单、摘要、
 * 调用计数**全都长在 index.ts 的 rank_photos 闭包里 —— 那一层此前只有「读源码正则」的守卫
 * （ranker/tests/test_stage3_agent_wiring.py）。正则守得住调用点写没写对，守不住它到底做了什么：
 * 2026-09-18 的独立复审用这个台子抓到 8 个变异，其中 T4「阶段 3 读了阶段 2 的 rubric」、
 * T5「阶段 3 的锚点回落到阶段 2 的」两条，正则和 stage3.test.ts 都是绿的。
 *
 * 真的：index.ts 的 apply / scan_folder / rank_photos、comparePairs、HarnessVisionTransport、runStage3。
 * 假的只有两样：
 *   · 排序器进程 —— test-fixtures/fake-ranker，按 Ranker 的进程协议（scan / preview / pick，--json 落盘）应答
 *   · 最底层的 llm / attachments —— 与 stage3.test.ts 同一种 mock，答案按**文件名**认人，不按位置
 *
 * 跑：node --experimental-transform-types src/rankPhotos.wiring.test.ts
 * （transform-types 而不是 strip-types：链路里的 ranker.ts 用了参数属性）
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_RANKER = resolve(HERE, '../test-fixtures/fake-ranker')
const PYTHON = process.env.PHOTOFILTER_TEST_PYTHON ?? 'python3'
/** mock 判官偏爱这几张（按文件名认，两个方向一致）；其余按位置作答 → 正反翻覆。 */
const PREFER = new Set(['P02.JPG', 'P08.JPG', 'P09.JPG'])
const S2_ANCHORS = 2         // 阶段 2 的锚点张数（假锚点文件里放了 2 张）
const S3_ANCHORS = 3         // 阶段 3 的锚点张数
/** 锚点每张进两幅（整幅 + 人脸特写）：run.json 里张数与幅数分开记，两个都核。 */
const jpegsOf = (photos: number) => photos * 2

const failures: string[] = []
const check = (scen: string, what: string, cond: boolean, detail = '') => {
  if (!cond) failures.push(`[${scen}] ${what}${detail ? ` —— ${detail}` : ''}`)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function mockHarness(opts: { throwAtCompare?: number; overrides?: Record<string, string> }) {
  const store = new Map<string, string>()
  const calls: Array<{ kind: string; system: string; images: string[] }> = []
  let seq = 0
  let compares = 0
  const services = {
    attachments: {
      imageLimits: { maxImagesPerMessage: 40, maxMessageImageBytes: 50_000_000, mediaTypes: ['image/jpeg'] },
      async saveImages(inputs: Array<{ data: Uint8Array; mediaType: string }>) {
        return inputs.map((x) => {
          const attachmentId = `att-${seq++}`
          store.set(attachmentId, Buffer.from(x.data).toString())
          return { attachmentId, mediaType: x.mediaType, bytes: x.data.byteLength, width: 1, height: 1 }
        })
      },
    },
    llm: {
      async resolveModelInfo(provider: string, model: string) {
        return { provider, id: model, inputModalities: ['text', 'image'] }
      },
      async prepareCall(config: Record<string, unknown>) {
        return {
          config,
          async *stream(options: any) {
            const tool = options.tools[0]
            let args: Record<string, unknown>
            if (tool.name === 'photo_filter_model_preflight') {
              calls.push({ kind: 'preflight', system: String(options.system), images: [] })
              args = { ok: true, nonce: tool.parameters.properties.nonce.enum[0] }
            } else {
              compares++
              const images = options.messages[0].content
                .filter((c: { type: string }) => c.type === 'image')
                .map((c: { attachment: { attachmentId: string } }) => store.get(c.attachment.attachmentId)!)
              calls.push({ kind: 'compare', system: String(options.system), images })
              if (opts.throwAtCompare && compares === opts.throwAtCompare) {
                throw new Error(`mock：第 ${compares} 次比较调用失败（模拟 429）`)
              }
              const fulls = images.filter((t: string) => t.startsWith('full:'))
              const jia = fulls[fulls.length - 2]!
              const yi = fulls[fulls.length - 1]!
              const code = (t: string) => t.split(':')[1]!
              const name = (t: string) => t.split(':')[2]!
              const rule = opts.overrides?.[[name(jia), name(yi)].sort().join('|')]
              let winner: string
              let wcode = ''
              if (rule === 'TIE' || rule === 'NEITHER') winner = rule
              else {
                const want = rule ?? (PREFER.has(name(jia)) ? name(jia) : PREFER.has(name(yi)) ? name(yi) : null)
                if (want === null) { winner = 'JIA'; wcode = code(jia) }      // 按位置答 → 两个方向翻覆
                else { winner = want === name(jia) ? 'JIA' : 'YI'; wcode = code(want === name(jia) ? jia : yi) }
              }
              args = { winner, reason: 'mock', code_jia: code(jia), code_yi: code(yi), winner_code: wcode }
            }
            yield { type: 'block-end', block: { type: 'tool-call', name: tool.name, arguments: JSON.stringify(args) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          },
        }
      },
    },
  }
  return { services, calls }
}

interface Scen {
  name: string
  stage2: boolean
  stage3: boolean
  rubric2?: boolean
  anchors2?: 'ok' | 'leak'
  rubric3?: 'ok' | 'missing' | 'empty'
  anchors3?: 'ok' | 'leak' | 'bad'
  throwAtCompare?: number
  overrides?: Record<string, string>
  fake?: Record<string, unknown>
}

async function run(s: Scen) {
  const work = mkdtempSync(join(tmpdir(), `rp-${s.name}-`))
  const photos = join(work, 'photos')
  const files = join(work, 'files')
  mkdirSync(photos)
  mkdirSync(files)
  const put = (n: string, body: string) => { const p = join(files, n); writeFileSync(p, body); return p }
  const rubric2 = s.rubric2 ? put('rubric2.txt', '阶段二判据：同组连拍里挑眼神好的\n') : ''
  const anchors2 = s.anchors2 ? put('anchors2.json', JSON.stringify({
    folder: join(work, 'a2'), text: '阶段二范例文字',
    photos: s.anchors2 === 'leak' ? ['A1.JPG', 'P04.JPG'] : ['A1.JPG', 'A2.JPG'],
    labels: { 'A1.JPG': '例一甲', 'A2.JPG': '例一乙', 'P04.JPG': '例一乙' },
  })) : ''
  const rubric3 = s.rubric3 === 'ok' ? put('rubric3.txt', '  阶段三判据：跨场景比较\n')
    : s.rubric3 === 'empty' ? put('rubric3.txt', ' \n\t ')
    : s.rubric3 === 'missing' ? join(files, 'nope.txt') : ''
  const anchors3 = s.anchors3 === 'bad' ? put('anchors3.json', '{"text": "x", "photos": []}')
    : s.anchors3 ? put('anchors3.json', JSON.stringify({
      folder: join(work, 'a3'), text: '阶段三范例文字',
      photos: s.anchors3 === 'leak' ? ['B1.JPG', 'P11.JPG', 'B3.JPG'] : ['B1.JPG', 'B2.JPG', 'B3.JPG'],
      labels: { 'B1.JPG': '例1甲', 'B2.JPG': '例1乙', 'B3.JPG': '例2甲', 'P11.JPG': '例1乙' },
    })) : ''
  const config = {
    rankerDir: FAKE_RANKER, python: PYTHON, workdir: join(work, 'wd'), cacheDir: join(work, 'cache'),
    allowedRoots: [work], excludedRelativePaths: ['me-pick'], allowedExportRoots: [], engineBinary: '',
    rankerTimeoutMs: 60_000, defaultTarget: 4, anchorsFile: anchors2, rubricFile: rubric2, allowNeither: true,
    stage2Vlm: s.stage2, stage3Vlm: s.stage3, stage3RubricFile: rubric3, stage3AnchorsFile: anchors3,
    maxInlineIdList: 60, evalPairsFile: '', evalPairsDir: '',
  }
  process.env.FAKE_LOG = join(work, 'ranker-argv.jsonl')
  process.env.FAKE_SCEN = JSON.stringify({ anchor_names: ['A1.JPG', 'A2.JPG', 'B1.JPG', 'B2.JPG', 'B3.JPG'], ...(s.fake ?? {}) })
  const mock = mockHarness({ throwAtCompare: s.throwAtCompare, overrides: s.overrides })
  const tools = new Map<string, any>()
  const ctx = {
    tools: { register(t: { name: string }) { tools.set(t.name, t); return () => {} } },
    get(n: string) { return n === 'llm' ? mock.services.llm : n === 'attachments' ? mock.services.attachments : undefined },
  }
  apply(ctx as never, config as never)
  const exec = { agent: { options: { provider: 'mock', model: 'mock-vision' } } }
  await tools.get('scan_folder').execute({ folder: photos }, exec)
  let summary: string | null = null
  let error: string | null = null
  try {
    summary = (await tools.get('rank_photos').execute({ target: 4, style: 'quality' }, exec)).summary
  } catch (e) { error = String((e as Error)?.message ?? e) }
  const runsDir = join(config.workdir, 'runs')
  const runs = existsSync(runsDir) ? readdirSync(runsDir) : []
  const runDir = runs.length === 1 ? join(runsDir, runs[0]!) : null
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
  const argv = (read(process.env.FAKE_LOG) ?? '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return {
    s, work, summary, error, runs, runDir,
    runJson: runDir && read(join(runDir, 'run.json')) ? JSON.parse(read(join(runDir, 'run.json'))!) : null,
    rows: runDir && read(join(runDir, 'calls.jsonl'))
      ? read(join(runDir, 'calls.jsonl'))!.trim().split('\n').map((l) => JSON.parse(l)) : [],
    picks: argv.filter((a: string[]) => a[0] === 'pick'),
    previews: argv.filter((a: string[]) => a[0] === 'preview'),
    workdirFiles: existsSync(config.workdir) ? readdirSync(config.workdir) : [],
    mock,
  }
}

const argOf = (argv: string[], flag: string) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1] }

const SCENARIOS: Scen[] = [
  { name: 'off', stage2: false, stage3: false },
  { name: 's2-only', stage2: true, stage3: false, rubric2: true, anchors2: 'ok' },
  { name: 'b1', stage2: true, stage3: true, rubric2: true, anchors2: 'ok' },
  { name: 'b2', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'ok' },
  { name: 'b3', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'ok', anchors3: 'ok' },
  // 阶段 2 改的是名单里**非边缘**的那一席：计划一字不变、md5 照样对上，
  // 丢了阶段 2 的裁决只有交付名单看得出来
  { name: 'plan-same', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', overrides: { 'P07.JPG|P08.JPG': 'P07.JPG' } },
  { name: 'b2-rubric-missing', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'missing' },
  { name: 'b2-rubric-empty', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'empty' },
  { name: 'b3-anchors-bad', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'ok', anchors3: 'bad' },
  { name: 'leak3', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', rubric3: 'ok', anchors3: 'leak' },
  { name: 'leak2', stage2: true, stage3: true, rubric2: true, anchors2: 'leak' },
  { name: 's2-fail', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', throwAtCompare: 2 },
  { name: 's3-fail', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', throwAtCompare: 7 },
  { name: 's3-mismatch', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', fake: { force_mismatch: true } },
  { name: 'no-contests', stage2: true, stage3: true, rubric2: true, anchors2: 'ok', fake: { no_stage3_plan: true } },
  { name: 's2-skipped', stage2: true, stage3: true, fake: { t2: [] } },
]

for (const s of SCENARIOS) {
  const r = await run(s)
  const n = s.name
  const rj = r.runJson
  const st3Rows = r.rows.filter((x: { stage: number }) => x.stage === 3)
  const st2Rows = r.rows.filter((x: { stage: number }) => x.stage === 2)
  const isS3 = (c: { images: string[] }) => c.images.some((t) => /:(P09|P10)\.JPG$/.test(t))
  const st2Calls = r.mock.calls.filter((c) => c.kind === 'compare' && !isS3(c))
  const st3Calls = r.mock.calls.filter((c) => c.kind === 'compare' && isS3(c))
  const paid = /\*\*付费模型调用 (\d+) 次\*\*/.exec(r.summary ?? '')?.[1]
  check(n, 'rank_photos 没有抛错', r.error === null, r.error ?? '')
  if (r.error) continue
  const sentRows = r.rows.filter((x: { sent: boolean }) => x.sent)
  check(n, '摘要报的付费调用数 = calls.jsonl 里 sent 的行数（含预检）',
    paid === undefined ? sentRows.length === 0 : Number(paid) === sentRows.length,
    `摘要 ${paid ?? '（0 次那一支）'}，记录 ${sentRows.length}`)

  switch (n) {
    case 'off':
      check(n, '两个开关都关：不建运行记录目录', r.runs.length === 0)
      check(n, '排序器只调 1 次、模型 0 次、摘要写 0 次',
        r.picks.length === 1 && r.mock.calls.length === 0 && r.summary!.includes('**付费模型调用 0 次** —— 全程在本机算完'))
      break
    case 's2-only':
      check(n, 'run.json：stage3 是 off，但计划与 plan_md5 照样记下来（A 组白拿）',
        rj?.stage3?.status === 'off' && Array.isArray(rj?.stage3?.plan) && rj.stage3.plan.length === 2
        && typeof rj?.stage3?.plan_md5 === 'string' && rj?.stage3_inputs === null, JSON.stringify(rj?.stage3))
      check(n, 'run.json：交付₂ = 交付₃ = 阶段 2 重排后的名单',
        same(rj?.delivered_after_stage2, ['P02.JPG', 'P03.JPG', 'P05.JPG', 'P08.JPG'])
        && same(rj?.delivered_final, rj?.delivered_after_stage2), JSON.stringify(rj?.delivered_final))
      check(n, 'run.json：阶段 2 的调用数就是发出去的那些', rj?.stage2?.comparisons === 4 && rj?.stage2?.preflights === 1,
        JSON.stringify(rj?.stage2))
      check(n, 'calls.jsonl：预检 1 + 比较 4，全部 stage=2', st2Rows.length === 5 && r.rows.length === 5)
      check(n, '排序器 2 次，第 2 次带运行记录里那份裁决',
        r.picks.length === 2 && argOf(r.picks[1], '--verdicts') === join(r.runDir!, 'stage2-verdicts.json'))
      check(n, '交付路径上不再有按指纹命名的裁决文件',
        !r.workdirFiles.some((f) => f.startsWith('verdicts-')), JSON.stringify(r.workdirFiles))
      check(n, '摘要：付费 5 次（比较 4 + 预检 1），阶段 2 那句话照旧',
        r.summary!.includes('**付费模型调用 5 次**（比较 4 次 + 路由预检 1 次）')
        && r.summary!.includes('阶段 2 的组内比较用了视觉模型'))
      break
    case 'b1': case 'b2': case 'b3': case 'plan-same': {
      const p3 = r.picks[2]
      check(n, '排序器 3 次；第 3 次同时带阶段 2 与阶段 3 的裁决，两个文件都在',
        r.picks.length === 3 && !!p3
        && argOf(p3, '--verdicts') === join(r.runDir!, 'stage2-verdicts.json')
        && argOf(p3, '--stage3-verdicts') === join(r.runDir!, 'stage3-verdicts.json')
        && existsSync(join(r.runDir!, 'stage2-verdicts.json')), JSON.stringify(p3))
      check(n, 'run.json：stage3 ran，比较 4 次、预检 1 次',
        rj?.stage3?.status === 'ran' && rj?.stage3?.comparisons === 4 && rj?.stage3?.preflights === 1,
        JSON.stringify(rj?.stage3))
      const after2 = n === 'plan-same' ? ['P02.JPG', 'P03.JPG', 'P05.JPG', 'P07.JPG'] : ['P02.JPG', 'P03.JPG', 'P05.JPG', 'P08.JPG']
      const final3 = n === 'plan-same' ? ['P02.JPG', 'P09.JPG', 'P05.JPG', 'P07.JPG'] : ['P02.JPG', 'P09.JPG', 'P05.JPG', 'P08.JPG']
      check(n, 'run.json：交付₂ 是阶段 3 之前那一刻的名单', same(rj?.delivered_after_stage2, after2), JSON.stringify(rj?.delivered_after_stage2))
      check(n, 'run.json：交付₃ 带着阶段 2 的改判，再加阶段 3 的换人', same(rj?.delivered_final, final3), JSON.stringify(rj?.delivered_final))
      const wantIn = {
        rubric_chars: n === 'b2' || n === 'b3' ? '阶段三判据：跨场景比较'.length : 0,
        rubric_md5: n === 'b2' || n === 'b3' ? md5('阶段三判据：跨场景比较') : null,
        anchor_photos_configured: n === 'b3' ? S3_ANCHORS : 0,
      }
      check(n, 'run.json：stage3_inputs 记的是实际读到的（rubric 按 trim 之后算）',
        same(rj?.stage3_inputs, wantIn), JSON.stringify(rj?.stage3_inputs))
      check(n, 'run.json：阶段 3 真发出去的锚点张数与幅数（幅数 = 张数 × 2）',
        rj?.stage3?.anchor_photos_sent === (n === 'b3' ? S3_ANCHORS : 0)
        && rj?.stage3?.anchor_jpegs_sent === (n === 'b3' ? jpegsOf(S3_ANCHORS) : 0), JSON.stringify(rj?.stage3))
      check(n, 'run.json：阶段 2 配了几张、真发了几张、几幅，三个分开记',
        rj?.stage2?.anchor_photos_configured === S2_ANCHORS && rj?.stage2?.anchor_photos_sent === S2_ANCHORS
        && rj?.stage2?.anchor_jpegs_sent === jpegsOf(S2_ANCHORS), JSON.stringify(rj?.stage2))
      const imgs3 = n === 'b3' ? 4 + jpegsOf(S3_ANCHORS) : 4
      check(n, `阶段 3 每次比较 ${imgs3} 幅`, st3Calls.length === 4 && st3Calls.every((c) => c.images.length === imgs3),
        JSON.stringify(st3Calls.map((c) => c.images.length)))
      check(n, `阶段 2 每次比较 ${4 + jpegsOf(S2_ANCHORS)} 幅`,
        st2Calls.length === 4 && st2Calls.every((c) => c.images.length === 4 + jpegsOf(S2_ANCHORS)))
      check(n, '阶段 3 的提示词里没有阶段 2 的 rubric / 锚点文字，附的也不是阶段 2 的锚点图',
        st3Calls.every((c) => !c.system.includes('阶段二判据') && !c.system.includes('阶段二范例文字')
          && !c.images.some((t) => /:A[12]\.JPG$/.test(t))))
      check(n, '阶段 2 的提示词里没有阶段 3 的 rubric / 锚点',
        st2Calls.every((c) => !c.system.includes('阶段三判据') && !c.system.includes('阶段三范例文字')))
      if (n === 'b2' || n === 'b3') {
        check(n, '阶段 3 的提示词里有阶段 3 自己的 rubric', st3Calls.every((c) => c.system.includes('阶段三判据：跨场景比较')))
      }
      if (n === 'b3') {
        check(n, '阶段 3 的提示词里有阶段 3 自己的锚点文字，附的是 B1~B3',
          st3Calls.every((c) => c.system.includes('阶段三范例文字')
            && ['B1', 'B2', 'B3'].every((b) => c.images.some((t) => t.endsWith(`:${b}.JPG`)))))
      }
      check(n, '取锚点图时不带排除清单（排除清单管候选池，不管范例），带 --label-map',
        r.previews.filter((a: string[]) => a.includes('A1.JPG') || a.includes('B1.JPG'))
          .every((a: string[]) => !a.includes('--exclude') && a.includes('--label-map')))
      check(n, '取候选照片预览时带排除清单、带烧码、带人脸',
        r.previews.filter((a: string[]) => a.includes('P01.JPG') || a.includes('P03.JPG'))
          .every((a: string[]) => a.includes('--exclude') && a.includes('--code-map') && a.includes('--with-face')))
      check(n, '摘要：两个阶段都列出，换人 1 局，写了运行记录目录',
        r.summary!.includes('阶段 2 的组内比较与阶段 3 的边缘对决用了视觉模型')
        && r.summary!.includes('换人 1 局') && r.summary!.includes(`运行记录：${r.runDir}`))
      break
    }
    case 'b2-rubric-missing': case 'b2-rubric-empty': case 'b3-anchors-bad': case 'leak3': {
      const reason = n === 'b3-anchors-bad' ? '阶段 3 锚点文件读不出来'
        : n === 'leak3' ? '阶段 3 的锚点照片有 1 张也在候选池里' : '阶段 3 判据文件读不出来'
      check(n, `run.json：stage3 failed，原因「${reason}」`,
        rj?.stage3?.status === 'failed' && String(rj?.stage3?.error).includes(reason), JSON.stringify(rj?.stage3))
      check(n, '阶段 3 一次调用都没发', st3Rows.length === 0 && st3Calls.length === 0
        && rj?.stage3?.comparisons === 0 && rj?.stage3?.preflights === 0)
      check(n, '交付₃ = 交付₂（名单保留阶段 2 之后的结果）',
        same(rj?.delivered_final, rj?.delivered_after_stage2)
        && same(rj?.delivered_after_stage2, ['P02.JPG', 'P03.JPG', 'P05.JPG', 'P08.JPG']))
      check(n, '摘要写明阶段 3 未执行及原因，且不谎报花了钱',
        r.summary!.includes('**阶段 3 · 视觉对决未执行**') && r.summary!.includes(reason)
        && !r.summary!.includes('失败前已经发出'))
      check(n, '阶段 2 照常跑完', rj?.stage2?.status === 'ran')
      break
    }
    case 'leak2':
      check(n, 'run.json：stage2 failed，原因是泄题',
        rj?.stage2?.status === 'failed' && String(rj?.stage2?.error).includes('阶段 2 的锚点照片有 1 张也在候选池里'),
        JSON.stringify(rj?.stage2))
      check(n, '阶段 3 因阶段 2 失败而不开跑',
        rj?.stage3?.status === 'failed' && String(rj?.stage3?.error).includes('阶段 2 视觉复核这次没有执行成功'))
      check(n, '一次模型调用都没发；锚点一幅都没发出去',
        r.mock.calls.length === 0 && r.rows.length === 0 && rj?.stage2?.anchor_photos_sent === 0
        && rj?.stage2?.anchor_photos_configured === S2_ANCHORS && rj?.stage2?.anchor_jpegs_sent === 0,
        JSON.stringify(rj?.stage2))
      check(n, '交付₂ = 交付₃ = 本地排序', same(rj?.delivered_after_stage2, ['P01.JPG', 'P03.JPG', 'P05.JPG', 'P07.JPG'])
        && same(rj?.delivered_final, rj?.delivered_after_stage2))
      break
    case 's2-fail':
      check(n, 'run.json：stage2 failed，stage3 因此不开跑',
        rj?.stage2?.status === 'failed' && rj?.stage3?.status === 'failed'
        && String(rj?.stage3?.error).includes('阶段 2 视觉复核这次没有执行成功'))
      check(n, '阶段 3 一次调用都没发，排序器只调 1 次', st3Rows.length === 0 && r.picks.length === 1)
      // 失败的那一次也是发出去的（进了 stream 才失败，sent=true），所以是比较 2 次 + 预检 1 次
      check(n, 'run.json：失败的阶段 2 也记下已经发出的调用',
        rj?.stage2?.comparisons === 2 && rj?.stage2?.preflights === 1, JSON.stringify(rj?.stage2))
      check(n, '摘要把失败前花掉的调用报出来',
        r.summary!.includes('失败前已经发出 3 次调用（比较 2 次 + 路由预检 1 次）'), r.summary ?? '')
      break
    case 's3-fail': case 's3-mismatch': {
      const reason = n === 's3-fail' ? '第 7 次比较调用失败' : '计划 md5'
      check(n, `run.json：stage3 failed，原因含「${reason}」`,
        rj?.stage3?.status === 'failed' && String(rj?.stage3?.error).includes(reason), JSON.stringify(rj?.stage3))
      check(n, 'run.json：失败的阶段 3 也记下已经发出的调用',
        rj?.stage3?.comparisons === (n === 's3-fail' ? 3 : 4) && rj?.stage3?.preflights === 1, JSON.stringify(rj?.stage3))
      check(n, '交付₃ = 交付₂', same(rj?.delivered_final, rj?.delivered_after_stage2)
        && same(rj?.delivered_after_stage2, ['P02.JPG', 'P03.JPG', 'P05.JPG', 'P08.JPG']))
      check(n, '摘要写明未执行、原因，以及失败前花掉的调用',
        r.summary!.includes('**阶段 3 · 视觉对决未执行**') && r.summary!.includes(reason)
        && r.summary!.includes(`失败前已经发出 ${(n === 's3-fail' ? 3 : 4) + 1} 次调用`))
      break
    }
    case 'no-contests':
      check(n, 'run.json：没有可挑战的边缘名额 → no_contests，0 次调用',
        rj?.stage3?.status === 'no_contests' && st3Rows.length === 0 && r.picks.length === 2, JSON.stringify(rj?.stage3))
      check(n, '摘要如实说没有可挑战的名额', r.summary!.includes('这批照片没有可以挑战的边缘名额，0 次调用'))
      break
    case 's2-skipped':
      check(n, 'run.json：stage2 skipped、stage3 照跑', rj?.stage2?.status === 'skipped' && rj?.stage3?.status === 'ran',
        JSON.stringify([rj?.stage2?.status, rj?.stage3?.status]))
      check(n, '阶段 2 没有裁决时，阶段 3 重排不带 --verdicts',
        r.picks.length === 2 && argOf(r.picks[1], '--verdicts') === undefined && !!argOf(r.picks[1], '--stage3-verdicts'))
      check(n, '交付₃：段 1 换人、段 2 正反翻覆不换',
        same(rj?.delivered_final, ['P01.JPG', 'P09.JPG', 'P05.JPG', 'P07.JPG'])
        && rj?.stage3?.note?.kept_inconsistent === 1, JSON.stringify(rj?.delivered_final))
      break
  }
  rmSync(r.work, { recursive: true, force: true })
}

assert.ok(failures.length === 0, `rank_photos 接线有 ${failures.length} 条不成立：\n  ${failures.join('\n  ')}`)
console.log(`rankPhotos.wiring.test.ts: 全部通过（${SCENARIOS.length} 个场景）`)
