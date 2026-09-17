/**
 * 阶段 3 视觉对决（stage3.ts）的行为测试。
 *
 * 比较那一层用**真实的 comparePairs 与真实的 HarnessVisionTransport**，只 mock 最底层的
 * llm / attachments —— 调用记录是真由 transport 发出的，读码是真按 compare.ts 解析的。
 * 排序器（preview / rank）用假的：Python 侧的计划与应用由 ranker/tests/test_stage3_wiring.py 守。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparePairs } from './compare.ts'
import type { HarnessVisionExecution, HarnessVisionServices } from './harness-vision.ts'
import type { RankResult, Stage3PlanRow } from './ranker.ts'
import { CALLS_FILE, STAGE3_VERDICTS_FILE, runStage3, type Stage3Deps, type Stage3Input } from './stage3.ts'

const img = (tag: string) => Buffer.from(tag).toString('base64')
const EXEC: HarnessVisionExecution = { agent: { options: { provider: 'mock', model: 'mock-vision' } } }
const PLAN: Stage3PlanRow[] = [
  { segment: 1, a: 'p1.JPG', b: 'p2.JPG', margin: -0.15 },
  { segment: 7, a: 'p3.JPG', b: 'p4.JPG', margin: 0.0136 },
]
const MD5 = '9798113940cfb900cc5736e731a2030d'
const CHALLENGERS = new Set(PLAN.map((p) => p.b))
const ANCHOR_JPEGS = Array.from({ length: 16 }, (_, k) => img(`anchor::${k}`))

function rankResult(notes: RankResult['notes'], selected = ['p1.JPG', 'p3.JPG']): RankResult {
  return { selected, ranking: ['p1.JPG', 'p2.JPG', 'p3.JPG', 'p4.JPG'], scores: {}, families: {}, mode: 'cold',
           n_labels: 0, fingerprint: 'fp', n_candidates: 4, elapsed_sec: 0, notes }
}

function mockHarness(opts: { throwAt?: number } = {}) {
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
        return { provider, id: model, inputModalities: ['text', 'image'] }
      },
      async prepareCall(config: Record<string, unknown> & { provider: string; model: string }) {
        return {
          config,
          async *stream(options: Record<string, unknown>) {
            const tool = (options.tools as Array<{ name: string; parameters: any }>)[0]!
            let args: Record<string, unknown>
            if (tool.name === 'photo_filter_model_preflight') {
              args = { ok: true, nonce: tool.parameters.properties.nonce.enum[0] }
            } else {
              submits++
              if (opts.throwAt && submits === opts.throwAt) throw new Error(`mock：第 ${submits} 次比较调用失败`)
              const tags = ((options.messages as Array<{ content: any[] }>)[0]!.content)
                .filter((c) => c.type === 'image').map((c) => store.get(c.attachment.attachmentId)!)
              perCallImages.push(tags.length)
              const fulls = tags.filter((t) => t.startsWith('full:'))
              const codeOf = (t: string) => t.split(':')[1]!
              const nameOf = (t: string) => t.split(':')[2]!
              const jiaTag = fulls[fulls.length - 2]!
              const yiTag = fulls[fulls.length - 1]!
              // 永远选**挑战者**那张（按文件名认，不按位置）：AB 方向它在乙位，BA 方向它在甲位。
              // 第一版按「最后一幅」答，两个方向就互相矛盾、被判成翻覆 —— 那是 mock 写错了，不是被测代码。
              const pickJia = CHALLENGERS.has(nameOf(jiaTag))
              args = { winner: pickJia ? 'JIA' : 'YI', reason: 'mock', code_jia: codeOf(jiaTag), code_yi: codeOf(yiTag),
                       winner_code: codeOf(pickJia ? jiaTag : yiTag) }
            }
            yield { type: 'block-end', block: { type: 'tool-call', name: tool.name, arguments: JSON.stringify(args) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          },
        }
      },
    },
  }
  return { services: services as unknown as HarnessVisionServices, perCallImages }
}

function setup(o: { plan?: Stage3PlanRow[]; md5?: string | null; anchors?: boolean; missing?: string[];
                    throwAt?: number; applied?: boolean } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), 'stage3-'))
  const harness = mockHarness({ throwAt: o.throwAt })
  const seen = {
    previewCalls: 0, withFace: undefined as boolean | undefined,
    codeMap: undefined as Record<string, string> | undefined,
    compareArgs: undefined as Parameters<typeof comparePairs> | undefined,
    rankFile: undefined as string | undefined,
    // 抄送给调用方的调用记录：闭包那一层靠它把账记住，跨异常还在。
    onCallRows: [] as { sent: boolean; kind: string }[],
  }
  const before = rankResult({
    stage3_plan: o.plan ?? PLAN,
    stage3_plan_md5: o.md5 === undefined ? MD5 : o.md5,
    stage3: null, stage3_judge: 'off',
  })
  const after = rankResult({
    stage3_plan: o.plan ?? PLAN, stage3_plan_md5: MD5, stage3_judge: o.applied === false ? 'off' : 'replay',
    stage3: o.applied === false ? null : { contests: 2, swapped: 2, missing: 0, refused_family_cap: 0, kept_a: 0,
                                           kept_tie: 0, kept_neither: 0, kept_inconsistent: 0, kept: 0, unused: 0 },
  }, ['p2.JPG', 'p4.JPG'])
  const deps: Stage3Deps = {
    async preview(_f, names, _e, _s, _sig, withFace, _l, codeMap) {
      seen.previewCalls++
      seen.withFace = withFace
      seen.codeMap = codeMap
      const tag = (kind: string, n: string) => img(`${kind}:${codeMap?.[n] ?? ''}:${n}`)
      return {
        previews: Object.fromEntries(names.map((n) => [n, tag('full', n)])),
        faces: Object.fromEntries(names.map((n) => [n, tag('face', n)])),
        missing: o.missing ?? [],
      }
    },
    async buildAnchorBlock(a) { return a ? { text: a.text, jpegs: ANCHOR_JPEGS } : null },
    onCall: (r) => { seen.onCallRows.push({ sent: r.sent, kind: r.kind }) },
    async rank(file) { seen.rankFile = file; return after },
    compare: (async (...args: Parameters<typeof comparePairs>) => {
      seen.compareArgs = args
      return comparePairs(...args)
    }) as typeof comparePairs,
  }
  const input: Stage3Input = {
    before, folder: '/photos', exclude: [], rubric: '判据', allowNeither: true,
    anchors: o.anchors ? { folder: '/anchors', text: '范例', photos: ['x1.JPG'], labels: {} } : null,
    services: harness.services, exec: EXEC, runDir,
  }
  const calls = () => existsSync(join(runDir, CALLS_FILE))
    ? readFileSync(join(runDir, CALLS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  return { runDir, input, deps, seen, harness, before, after, calls }
}

// ── 正常路径 ────────────────────────────────────────────────────────────
{
  const t = setup()
  const out = await runStage3(t.input, t.deps)
  assert.equal(t.seen.withFace, true, '阶段 3 取预览必须带人脸')
  assert.ok(t.seen.codeMap && Object.keys(t.seen.codeMap).length === 4, '四张待判照片都必须烧码')
  assert.equal(t.seen.compareArgs![4], '判据', 'rubric 必须原样交给 comparePairs')
  assert.equal(t.seen.compareArgs![3], null, '没配锚点时 anchorBlock 必须是 null')
  assert.equal(t.seen.compareArgs![5], true, 'allowNeither 必须原样交给 comparePairs')
  assert.deepEqual(t.seen.compareArgs![6], t.seen.codeMap, '烧在图上的码必须同一份交给 comparePairs —— 不交就退回按槽位读答案')
  assert.deepEqual(t.harness.perCallImages, [4, 4, 4, 4], '无锚点时每次比较 4 幅')

  const vf = JSON.parse(readFileSync(join(t.runDir, STAGE3_VERDICTS_FILE), 'utf8'))
  assert.equal(vf.plan_md5, MD5, '裁决文件必须带着出计划那一次的计划 md5')
  assert.deepEqual(vf.verdicts.map((v: { a: string; b: string }) => [v.a, v.b]), PLAN.map((p) => [p.a, p.b]))
  assert.ok(vf.verdicts.every((v: { winner: string }) => v.winner === 'b'), 'mock 按码答乙：两局都应判挑战者赢')
  assert.ok(vf.verdicts.every((v: { code_read_ok: boolean | null }) => v.code_read_ok === true), '读码通道必须真的启用')
  assert.equal(t.seen.rankFile, join(t.runDir, STAGE3_VERDICTS_FILE), '重排必须拿这份裁决文件')

  const rows = t.calls()
  assert.equal(rows.length, 5, '1 次预检 + 2 局 × 2 次比较')
  assert.ok(rows.every((r) => r.stage === 3), '阶段 3 的每一行调用记录都必须标 stage: 3')
  assert.deepEqual(rows.map((r) => r.kind), ['preflight', 'compare', 'compare', 'compare', 'compare'])
  assert.equal(out.comparisons, 4)
  assert.equal(out.preflights, 1)
  assert.equal(out.anchorPhotos, 0, '没配锚点时实发张数必须是 0，不是「配了几张」')
  assert.equal(out.anchorJpegs, 0)
  assert.deepEqual(t.seen.onCallRows.map((r) => r.kind),
                   ['preflight', 'structured', 'structured', 'structured', 'structured'],
                   '每条调用记录都要抄送调用方 —— 否则半路失败的运行记不住花了多少')
  assert.equal(out.result, t.after, '返回的必须是应用裁决之后的结果')
  assert.equal(out.note?.swapped, 2)
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 带锚点：每次 20 幅 ────────────────────────────────────────────────
{
  const t = setup({ anchors: true })
  const out = await runStage3(t.input, t.deps)
  assert.equal((t.seen.compareArgs![3] as { jpegs: string[] }).jpegs.length, 16)
  assert.equal(out.anchorPhotos, 1, '实发的是**照片张数**：一张锚点进两幅，记成幅数会让按 8 张核的判据全判作废')
  assert.equal(out.anchorJpegs, 16, '幅数另记一个字段，两者之比正常是 2')
  assert.deepEqual(t.harness.perCallImages, [20, 20, 20, 20], '带锚点时每次比较 16 + 4 = 20 幅')
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 没有计划：一次都不调 ──────────────────────────────────────────────
{
  const t = setup({ plan: [] })
  const out = await runStage3(t.input, t.deps)
  assert.equal(t.seen.previewCalls, 0)
  assert.equal(t.seen.rankFile, undefined)
  assert.equal(t.calls().length, 0)
  assert.equal(out.result, t.before)
  assert.equal(out.note, null)
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 有计划却没有计划 md5：拒绝，不取图不调模型 ────────────────────────
{
  const t = setup({ md5: null })
  await assert.rejects(runStage3(t.input, t.deps), /计划 md5/)
  assert.equal(t.seen.previewCalls, 0)
  assert.equal(t.calls().length, 0)
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 缺预览：0 次调用 ─────────────────────────────────────────────────
{
  const t = setup({ missing: ['p2.JPG'] })
  await assert.rejects(runStage3(t.input, t.deps), /取不到预览/)
  assert.equal(t.calls().length, 0, '缺预览时一次模型调用都不许发')
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 排序器没有应用裁决：必须报错，不能当成阶段 3 的结果 ─────────────────
{
  const t = setup({ applied: false })
  await assert.rejects(runStage3(t.input, t.deps), /没有被排序器应用/)
  rmSync(t.runDir, { recursive: true, force: true })
}

// ── 比较调用失败：失败那次也进记录，错误照常抛，不去重排 ──────────────────
{
  const t = setup({ throwAt: 2 })
  await assert.rejects(runStage3(t.input, t.deps), /第 2 次比较调用失败/)
  const rows = t.calls()
  assert.equal(rows.length, 3, '1 次预检 + 第 1 次成功 + 第 2 次失败')
  assert.equal(rows[2].ok, false)
  assert.equal(rows[2].stage, 3)
  assert.equal(t.seen.rankFile, undefined, '比较没做完就不许去重排')
  assert.equal(existsSync(join(t.runDir, STAGE3_VERDICTS_FILE)), false)
  rmSync(t.runDir, { recursive: true, force: true })
}

console.log('stage3.test.ts: 全部通过')
