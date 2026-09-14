/**
 * Ranker 参数构造与失败描述的行为测试。
 *
 * ⚠️ 用 `node --experimental-transform-types` 跑，**不能**用 strip-types：
 * ranker.ts 里 RankerError 的构造函数用了参数属性（`readonly detail: string`），
 * strip-only 模式直接拒绝加载（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。
 *
 * 为什么要钉 preview() 带 gate()：人脸框只有本地分析引擎给得出。preview() 从 92a68ef
 * 起就带着 `...this.gate()`，但**没有任何测试守着它** —— 2026-09-14 连 owner 都一度以为
 * 它没带。哪天重构 preview() 顺手丢了，CLI 那头会明确失败（方案 A），而生产的视觉比较
 * 会被 catch 接住、回落本地分 —— 指标照出，没人发现。
 */
import assert from 'node:assert/strict'
import { Ranker, RankerError, describeRankerFailure } from './ranker.ts'

const ENGINE = '/opt/engine/photofilter'

/** 桩掉 runJson：只看 preview() 往 CLI 传了什么，不起 Python、不碰照片。 */
async function argvOf(engine: string | undefined, withFace: boolean): Promise<string[]> {
  const r = new Ranker('python', '/ranker', '/cache', 1000, engine)
  let seen: string[] = []
  ;(r as any).runJson = async (args: string[]) => {
    seen = args
    return { value: { previews: {}, faces: {}, missing: [] }, stdout: '' }
  }
  await r.preview('/photos', ['a.JPG'], [], 512, undefined, withFace)
  return seen
}

// ── 配了引擎：要人脸时必须把引擎传下去，而且路径紧跟在 --engine 后面 ──
{
  const argv = await argvOf(ENGINE, true)
  const i = argv.indexOf('--engine')
  assert.ok(i >= 0, `要人脸却没传 --engine：${argv.join(' ')}`)
  assert.equal(argv[i + 1], ENGINE, '--engine 后面必须紧跟引擎路径')
  assert.ok(argv.includes('--with-face'))
}

// ── 没配引擎：不传 --engine（CLI 会明确失败 —— 那是方案 A 的设计，不是这里的 bug）──
{
  const argv = await argvOf(undefined, true)
  assert.ok(!argv.includes('--engine'))
}

// ── CLI 主动报的一行人话必须出现在描述里 ──
{
  const e = new RankerError('排序器退出码 2', '要了人脸（--with-face），但没给 --engine。\n')
  const s = describeRankerFailure(e)
  assert.ok(s.includes('排序器退出码 2'))
  assert.ok(s.includes('没给 --engine'), `人话被丢了：${s}`)
  // 报告模板是「视觉模型复核未执行：${describe}。」—— 描述自己再带句号就成了「。。」
  assert.ok(!`视觉模型复核未执行：${s}。`.includes('。。'), `句末标点没去掉：${s}`)
}

// ── 未处理异常：取栈的最后一行（XxxError: 原因），不塞整段栈 ──
{
  const tb = 'Traceback (most recent call last):\n  File "x.py", line 1\n    boom()\n'
    + "AttributeError: 'NoneType' object has no attribute 'exists'\n"
  const s = describeRankerFailure(new RankerError('排序器退出码 1', tb))
  assert.ok(s.endsWith("AttributeError: 'NoneType' object has no attribute 'exists'"), s)
  assert.ok(!s.includes('Traceback'), '整段栈不该塞进给用户的报告')
}

// ── 不是排序器的错：原样给 message ──
{
  assert.equal(describeRankerFailure(new Error('别的错')), '别的错')
  assert.equal(describeRankerFailure('字符串'), '字符串')
}

console.log('ranker.test.ts: 全部通过')
