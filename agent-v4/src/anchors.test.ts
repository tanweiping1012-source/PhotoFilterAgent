/**
 * 锚点图完整性断言的行为测试。用 node --experimental-strip-types 直接跑。
 *
 * 为什么要真跑：这道断言拦的是「提示词说有 4 组范例、实际只附了 3 组」——
 * 那种状态下**所有指标都正常**，没有任何别的东西会红。它自己错了就没人兜底了。
 */
import assert from 'node:assert/strict'
import { assertAnchorImagesComplete, type AnchorPreview } from './anchors.ts'

const P8 = ['a1.JPG', 'a2.JPG', 'b1.JPG', 'b2.JPG',
            'c1.JPG', 'c2.JPG', 'd1.JPG', 'd2.JPG']
const full = (xs: string[]): Record<string, string> =>
  Object.fromEntries(xs.map((x) => [x, 'base64...']))
const ap = (o: Partial<AnchorPreview>): AnchorPreview =>
  ({ previews: {}, faces: {}, missing: [], ...o })

/** assert.throws 不回传异常，这里自己接住 —— 要对错误信息本身下断言。 */
const grab = (fn: () => void): Error => {
  try { fn() } catch (e) { return e as Error }
  throw new assert.AssertionError({ message: '应当抛出，但没有抛' })
}

// ── 全取到不许误报（实测 8 张锚点就是这个形状：整幅 8 + 人脸 8）──
{
  assertAnchorImagesComplete(
    P8, ap({ previews: full(P8), faces: full(P8) }), '/photos/x')
}

// ── 少一组：4 组变 3 组，正是 8099ffa 那个 bug 的低一档版本 ──
{
  const kept = P8.slice(0, 6)
  const e = grab(() => assertAnchorImagesComplete(
    P8, ap({ previews: full(kept), faces: full(kept), missing: ['d1.JPG', 'd2.JPG'] }),
    '/photos/x'))
  assert.match(e.message, /期望 16 幅/)
  assert.match(e.message, /实际 12 幅/)
  // 断言到**具体那一行**上。只写 /d1 d2/ 是不够的：这两张既没有整幅也没有人脸，
  // 名字在「没人脸」那行也会出现 —— 于是把「取不到整幅」那行的名字删掉，
  // 测试照样绿。变异测试抓到过这一点。
  assert.match(e.message, /取不到整幅 2 张：d1\.JPG d2\.JPG/,
    '必须点名是哪几张，只报数字查不下去')
  assert.match(e.message, /有整幅但没有人脸特写 2 张：d1\.JPG d2\.JPG/)
  assert.match(e.message, /me-pick/, '要提示排除规则这个最可能的成因')
}

// ── 全部有整幅、全部没人脸 → 指向引擎，而不是「换锚点」──
{
  const e = grab(() => assertAnchorImagesComplete(
    P8, ap({ previews: full(P8) }), '/photos/x'))
  assert.match(e.message, /实际 8 幅/)
  assert.match(e.message, /引擎/, '一张脸都没裁出来，最可能是引擎没接上')
  assert.doesNotMatch(e.message, /取不到整幅/, '整幅都在，不该报这一条')
}

// ── 只有一张没人脸 → 不该甩锅给引擎 ──
{
  const e = grab(() => assertAnchorImagesComplete(
    P8, ap({ previews: full(P8), faces: full(P8.slice(0, 7)) }),
    '/photos/x'))
  assert.match(e.message, /实际 15 幅/)
  assert.match(e.message, /d2\.JPG/)
  assert.doesNotMatch(e.message, /引擎/, '只缺一张时指向引擎会把人带偏')
  assert.match(e.message, /换一张锚点/)
}

// ── 旧检查放过的那一档：非空但不足。这条是这次修复的核心 ──
{
  const one = P8.slice(0, 1)
  const bad = ap({ previews: full(one), faces: full(one) })
  const jpegs = P8.flatMap((x) => [bad.previews[x], bad.faces[x]].filter(Boolean))
  assert.equal(jpegs.length, 2)
  assert.ok(jpegs.length > 0, '旧的 !jpegs.length 在这里是 false —— 会静默发出去')
  assert.throws(() => assertAnchorImagesComplete(P8, bad, '/photos/x'),
    /期望 16 幅.*实际 2 幅/s, '新断言必须拦住它')
}

// ── 边界：没有锚点时不抛（buildAnchorBlock 在更早就返回 null 了）──
{
  assertAnchorImagesComplete([], ap({}), '/photos/x')
}

console.log('anchors.test.ts: 全部通过')
