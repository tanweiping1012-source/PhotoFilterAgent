/**
 * 匿名 ID ↔ 真实文件名的映射。
 *
 * v4 的排序链路一张照片都不往外发，所以泄漏风险比 v3 低得多。但文件名本身仍然
 * 编码信息（相机型号、序号、有时还有地名日期），而模型上下文是会被日志、
 * 被后续轮次反复携带的。所以对话里只出现 p001 这样的编号，
 * 真实文件名只存在本机的 workdir 里。
 *
 * 映射按「数据集指纹」分片。用指纹而不是文件夹路径，是因为 v3 按绝对路径分片，
 * 用户挪一次文件夹，已付费的 309 条分数全成孤儿、重付了 245 次。
 * @module
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class IdentityMap {
  private toName = new Map<string, string>()
  private toId = new Map<string, string>()

  private constructor(private readonly file: string) {}

  static load(workdir: string, fingerprint: string): IdentityMap {
    mkdirSync(workdir, { recursive: true })
    const map = new IdentityMap(join(workdir, `ids-${fingerprint}.json`))
    if (existsSync(map.file)) {
      const raw = JSON.parse(readFileSync(map.file, 'utf8')) as Record<string, string>
      for (const [id, name] of Object.entries(raw)) {
        map.toName.set(id, name)
        map.toId.set(name, id)
      }
    }
    return map
  }

  /** 按给定顺序建立编号。顺序必须是确定性的（排序器返回的就是排好序的文件名）。 */
  assign(names: string[]): void {
    const width = String(names.length).length
    names.forEach((name, i) => {
      if (this.toId.has(name)) return
      const id = `p${String(i + 1).padStart(Math.max(width, 3), '0')}`
      this.toName.set(id, name)
      this.toId.set(name, id)
    })
    this.save()
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.toName)))
  }

  id(name: string): string { return this.toId.get(name) ?? name }
  name(id: string): string | undefined { return this.toName.get(id) }
  get size(): number { return this.toName.size }

  /** 把一串 ID 翻回文件名；认不出的原样返回，由调用方判定是不是模型编造的。 */
  resolve(ids: string[]): { names: string[]; unknown: string[] } {
    const names: string[] = []
    const unknown: string[] = []
    for (const id of ids) {
      const n = this.toName.get(id)
      if (n) names.push(n)
      else unknown.push(id)
    }
    return { names, unknown }
  }
}
