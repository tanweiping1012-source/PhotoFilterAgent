/**
 * 内容寻址答案通道的行为测试。用 node --experimental-strip-types 直接跑。
 *
 * 为什么要真跑而不是文本断言：resolvePick 是「答案到底指哪张照片」的唯一裁决点。
 * 它错了，整个阶段 2 的结论就都错了，而这种错在文本里看不出来。
 */
import assert from 'node:assert/strict'
import { assignCodes } from './codes.ts'
import { resolvePick, type RawVerdict } from './compare.ts'

const V = (o: Partial<RawVerdict>): RawVerdict => ({
  w: 'first', reason: '', readJia: '', readYi: '', winnerCode: '', ...o,
})

// ── 码必须唯一且确定 ────────────────────────────────────────────
{
  const names = ['p1', 'p2', 'p3', 'p4', 'p5']
  const c = assignCodes(names, 42)
  const vals = Object.values(c)
  assert.equal(new Set(vals).size, vals.length, '码撞了 —— winner_code 就指不出是哪张')
  assert.ok(vals.every((v) => v.length === 4))
  assert.deepEqual(assignCodes(names, 42), c, '同一种子必须出同一批码（断点续跑不能换码）')
  assert.notDeepEqual(assignCodes(names, 43), c)
  assert.ok(vals.every((v) => !/[01258BILOSZ]/.test(v)), '易混字会被读错，等于这次调用作废')
}

// ── 没烧码：行为与以前逐字节一致 ────────────────────────────────
{
  const r = resolvePick(V({ w: 'second' }), undefined, undefined)
  assert.equal(r.pick, 'second')
  assert.equal(r.contradiction, false)
}

// ── 烧了码：以码为准，位置说了不算 ──────────────────────────────
{
  // 模型说「甲赢」（槽位），但给的是**乙的码**。码赢。
  const r = resolvePick(V({ w: 'first', winnerCode: 'BBBB' }), 'AAAA', 'BBBB')
  assert.equal(r.pick, 'second', '烧码之后必须以 winner_code 为准，不能听槽位')
  assert.equal(r.contradiction, true, '槽位与码矛盾是一条真实信息，必须记下来')
}
{
  const r = resolvePick(V({ w: 'first', winnerCode: 'AAAA' }), 'AAAA', 'BBBB')
  assert.equal(r.pick, 'first')
  assert.equal(r.contradiction, false)
}

// ── 幻觉码：这一次调用作废，绝不猜 ──────────────────────────────
{
  const r = resolvePick(V({ w: 'first', winnerCode: 'ZZZZ' }), 'AAAA', 'BBBB')
  assert.equal(r.pick, 'bad-code',
    '码对不上任何一张就是没读到图；猜一个等于把「没读到」洗成正常答案')
}

// ── 平局与都不要是位置无关的，本来就没有 winner_code ────────────
for (const w of ['tie', 'neither'] as const) {
  const r = resolvePick(V({ w, winnerCode: '' }), 'AAAA', 'BBBB')
  assert.equal(r.pick, w, `${w} 不该因为没有 winner_code 就被判作废`)
  assert.equal(r.contradiction, false)
}

// ── 大小写与空白：readVerdict 已经归一化过，这里确认不被空格坑 ──
{
  const r = resolvePick(V({ w: 'second', winnerCode: 'BBBB' }), 'AAAA', 'BBBB')
  assert.equal(r.pick, 'second')
}

console.log('codes.test.ts: 全部通过')
