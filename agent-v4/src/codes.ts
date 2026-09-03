/**
 * 烧进图里的随机短码,以及生成它们的确定性随机源。
 *
 * 为什么单独一个模块：生产的比较路径（compare.ts）和仪器标定
 * （instrument.ts）**必须用同一套码**。两处各写一份的话，
 * 哪天字母表改了而另一边没跟上，标定结论就不再适用于生产。
 *
 * 这是本仓库反复吃过亏的那类 bug：同一条判据两处实现，改一处忘另一处。
 */

/** 去掉了易混字（0/O、1/I/L、2/Z、5/S、8/B）。码要被**准确读回来**，
 *  读错就等于这次调用作废，所以宁可字母表小一点。 */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'

export function makeCode(rnd: () => number): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
  return s
}

/** 确定性随机源：同一个 seed 出同一批码，跑挂了续跑不会换码。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 给一批照片各分配一个**互不相同**的码。
 *
 * 必须全局唯一，不能只保证「同一局里两个不同」：擂台赛里同一张照片
 * 会作为擂主打好几局，码得跟着照片走、跨局稳定，答案才是内容寻址的。
 * 一旦两张照片撞了码，winner_code 就指不出是哪一张。
 */
export function assignCodes(names: readonly string[], seed: number): Record<string, string> {
  const rnd = mulberry32(seed)
  const used = new Set<string>()
  const out: Record<string, string> = {}
  for (const n of names) {
    let c = makeCode(rnd)
    // 25^4 = 390625 种，几十张照片撞车概率极低，但撞了必须换 —— 不能靠概率。
    let guard = 0
    while (used.has(c)) {
      c = makeCode(rnd)
      if (++guard > 1000) throw new Error('码空间耗尽，无法为每张照片分配唯一码')
    }
    used.add(c)
    out[n] = c
  }
  return out
}
