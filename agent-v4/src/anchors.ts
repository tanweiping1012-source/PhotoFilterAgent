/**
 * 锚点图完整性断言。
 *
 * ━━ 为什么需要它 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * `8099ffa` 修掉的是「一张范例图都没附上」：排除清单里正好是那 10 张锚点自己，
 * preview 一张都取不回来，而提示词照旧写着「范例图排在最前面」——
 * 模型被要求看不存在的图，于是改用散文作答。那一次靠 `!jpegs.length` 拦住了。
 *
 * 但那道检查只在**一张都没取到**时触发。**少取到一部分是静默的**：
 * 提示词写着「例1…例4」四组范例，实际只附了 3 组，模型会对着不存在的
 * 「例4甲/例4乙」作答，而所有指标全绿。同一个形状，从「全没有」降成了「少了几张」。
 *
 * ━━ 一处结构脆弱点，让它更值得断言 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 4 张「留」的锚点在 `me自然瀑布线/me-pick/` 子目录，4 张「弃」在顶层，
 * 全靠 `list_photos` 的 rglob 才一起取得到。**一旦有人给取锚点图加上类似
 * `--exclude me-pick` 的规则，四组瞬间变两组，且不报错。**
 * 目前挡住它的只有「`index.ts` 里传的排除清单是 `[]`」这一处正确，
 * 没有任何断言兜底 —— 这个函数就是那个兜底。
 *
 * ━━ 为什么单独成文件 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 埋在 `buildAnchorBlock` 这个闭包里就没法测，而**没有测试的守卫**正是
 * 这个项目反复踩的那一类。拆出来之后 `anchors.test.ts` 能直接跑它，
 * 跟 `codes.ts` / `codes.test.ts` 是同一个安排。
 */

export type AnchorPreview = {
  previews: Record<string, string>
  faces: Record<string, string>
  /** preview 侧报告的「这张照片根本没找到」。 */
  missing: string[]
}

/**
 * 每张锚点必须同时有**整幅**和**人脸特写**，缺一幅就抛。
 *
 * 不抛的话，提示词与实际附件会对不上，而那种残废状态下测出来的
 * 「锚点没用」是假的 —— 指标一切正常，没有任何东西会红。
 *
 * 报错要分开三种成因。压成一句「图不够」，下一个人还得自己去查是哪张、为什么：
 *   · 整幅都取不到          → 目录或排除清单的问题
 *   · 全部有整幅、全部没人脸 → 优先查 Swift 引擎
 *   · 只有几张没人脸        → 那几张检不到脸，换锚点或改提示词
 */
export function assertAnchorImagesComplete(
  photos: string[], ap: AnchorPreview, folder: string,
): void {
  const want = photos.length * 2          // 每张 = 整幅 + 人脸特写
  const got = photos.reduce(
    (n, x) => n + (ap.previews[x] ? 1 : 0) + (ap.faces[x] ? 1 : 0), 0)
  if (got === want) return

  const noPreview = photos.filter((x) => !ap.previews[x])
  const noFace = photos.filter((x) => !ap.faces[x])
  const lines = [
    `锚点图幅数不对：期望 ${want} 幅（${photos.length} 张 × 整幅+人脸），实际 ${got} 幅。`
    + `提示词会引用不存在的范例图，而指标不会报任何异常 —— 所以这里直接停。`,
  ]
  if (noPreview.length) {
    lines.push(
      `· 取不到整幅 ${noPreview.length} 张：${noPreview.join(' ')}`
      + `（preview 报「没找到」：${ap.missing.length ? ap.missing.join(' ') : '无'}）`
      + `。查 anchorsFile 的 folder，以及取锚点图那一步有没有被加上排除规则 ——`
      + `「留」的那几张在 me-pick/ 子目录，排除它就会只剩一半。`)
  }
  if (noFace.length) {
    lines.push(
      `· 有整幅但没有人脸特写 ${noFace.length} 张：${noFace.join(' ')}`
      + (noFace.length === photos.length && !noPreview.length
        ? `。一张都没裁出人脸 —— 优先查 Swift 引擎是否可用（--engine 路径）。`
        : `。这几张大概检不到人脸，换一张锚点，或把提示词里对应的那组去掉。`))
  }
  lines.push(`· anchorsFile 的 folder：${folder}`)
  throw new Error(lines.join('\n'))
}
