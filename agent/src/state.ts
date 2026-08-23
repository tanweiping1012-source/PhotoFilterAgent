/**
 * 一轮策展的运行状态。
 *
 * 它是“上下文经济学”的落点：工具结果进这里，不进对话历史。模型每一轮读到的是
 * 一份**渲染出来的固定大小摘要**（当前排名、切线、还剩什么没看），而不是几十条
 * 历史打分记录的重放。
 * @module
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AnalyzeReport, Candidate, Family } from './engine.ts'
import { weightedTotal, type Dimensions, type PhotoScore } from './vision.ts'

export type Category = 'people' | 'scenery'

export interface StoredScore {
  dimensions: Dimensions
  /** 打这一次分用的档位；同一张已有 ≥ 该档位的分数就不再重复付费。 */
  detail: 'low' | 'high'
  reasons: string[]
  summary: string
}

const DETAIL_RANK: Record<'low' | 'high', number> = { low: 0, high: 1 }

export class RunState {
  readonly candidates = new Map<string, Candidate>()
  readonly families = new Map<string, Family>()
  readonly scores = new Map<string, StoredScore>()
  /** 家族内已定的冠军；落选者不再进入后续候选。 */
  readonly championByFamily = new Map<string, string>()
  readonly comparisons: { ids: string[]; winner: string; reason: string }[] = []
  /** 已发生的付费调用次数，用于如实汇报花销。 */
  paidCalls = { inspect: 0, compare: 0, cached: 0 }
  folder?: string
  /** analyze 时用的取样上限；兜底选片必须用同一个值，否则两者看到的不是同一批照片。 */
  limit?: number
  targets: Record<Category, number> = { people: 6, scenery: 6 }
  proposal?: { keep: string[]; why: Record<string, string> }

  absorb(report: AnalyzeReport, folder: string, limit?: number): void {
    this.folder = folder
    this.limit = limit
    this.candidates.clear()
    this.families.clear()
    for (const candidate of report.candidates) this.candidates.set(candidate.id, candidate)
    for (const family of report.families) this.families.set(family.id, family)
  }

  /** 家族落选者：已定冠军的家族里，除冠军外的成员一律退出候选。 */
  private eliminated(): Set<string> {
    const out = new Set<string>()
    for (const [familyId, winner] of this.championByFamily) {
      for (const member of this.families.get(familyId)?.members ?? []) {
        if (member !== winner) out.add(member)
      }
    }
    return out
  }

  /** 仍在竞争的候选。
   *
   * 连拍组默认折叠：未经 compare + resolve_family 的组只露一个占位代表。
   * 实测里模型会无视"发现 78 组连拍"这句提示、对每张单独打分，而连拍恰恰是
   * "哪张睁着眼"唯一能被可靠判出来的地方。折叠让它绕不过去。
   */
  active(category?: Category): Candidate[] {
    const gone = this.eliminated()
    return [...this.candidates.values()].filter(
      (c) =>
        !gone.has(c.id)
        && !(c.collapsed && !this.championByFamily.has(c.family ?? ''))
        && (!category || c.category === category),
    )
  }

  /** 还没定代表的连拍组。 */
  openFamilies(): Family[] {
    return [...this.families.values()].filter(
      (f) => f.members.length > 1 && !this.championByFamily.has(f.id),
    )
  }

  /** 已有分数且档位足够时返回它——重发一张已付费的照片既多收钱又换一个分数。 */
  cached(id: string, detail: 'low' | 'high'): StoredScore | undefined {
    const existing = this.scores.get(id)
    if (!existing) return undefined
    return DETAIL_RANK[existing.detail] >= DETAIL_RANK[detail] ? existing : undefined
  }

  record(score: PhotoScore, detail: 'low' | 'high'): void {
    const existing = this.scores.get(score.id)
    // 高档位覆盖低档位；同档位重复以最新为准。
    if (existing && DETAIL_RANK[existing.detail] > DETAIL_RANK[detail]) return
    this.scores.set(score.id, {
      dimensions: score.dimensions,
      detail,
      reasons: score.reasons,
      summary: score.summary,
    })
  }

  total(id: string): number | undefined {
    const score = this.scores.get(id)
    return score ? weightedTotal(score.dimensions) : undefined
  }

  /** 按已知总分排出的当前名次。没有分数的排在最后。 */
  ranking(category: Category): { id: string; total?: number }[] {
    return this.active(category)
      .map((c) => ({ id: c.id, total: this.total(c.id) }))
      .sort((a, b) => {
        if (a.total === undefined && b.total === undefined) return a.id.localeCompare(b.id)
        if (a.total === undefined) return 1
        if (b.total === undefined) return -1
        return b.total - a.total || a.id.localeCompare(b.id)
      })
  }

  /**
   * 第 N 名与第 N+1 名的分差。
   *
   * 这个数字直接回答“还要不要继续花钱”：差 15 分就别看了，差 1 分说明切线不稳。
   */
  cutlineGap(category: Category): number | undefined {
    const ranked = this.ranking(category).filter((r) => r.total !== undefined)
    const target = this.targets[category]
    if (ranked.length <= target) return undefined
    return (ranked[target - 1].total ?? 0) - (ranked[target].total ?? 0)
  }

  /** 每轮交给模型的固定大小摘要。历史留在这里，不留在对话里。 */
  render(): string {
    const lines: string[] = []
    for (const category of ['people', 'scenery'] as Category[]) {
      const pool = this.active(category)
      if (!pool.length) continue
      const scored = pool.filter((c) => this.scores.has(c.id)).length
      const ranked = this.ranking(category).slice(0, this.targets[category])
      const gap = this.cutlineGap(category)
      const openFamilies = [...this.families.values()].filter(
        (f) => f.members.some((m) => pool.some((c) => c.id === m)) && !this.championByFamily.has(f.id),
      )
      lines.push(
        `【${category === 'people' ? '人物' : '风景'}】目标 ${this.targets[category]} 张 · ` +
          `候选 ${pool.length} · 已看 ${scored}`,
      )
      lines.push(
        `  当前前 ${this.targets[category]}: ` +
          (ranked.every((r) => r.total === undefined)
            ? '（还没有任何分数）'
            : ranked.map((r) => `${r.id}(${r.total ?? '—'})`).join(' ')),
      )
      if (gap !== undefined) {
        lines.push(`  切线分差 ${gap}${gap <= 3 ? '  ⚠ 不稳，值得再看' : '  稳定'}`)
      }
      if (openFamilies.length) {
        lines.push(
          `  ⚠ 待定连拍组 ${openFamilies.length} 组仍被折叠，组内其余照片不在候选里：`,
        )
        lines.push(
          `    ${openFamilies.slice(0, 8).map((f) => `${f.id}[${f.members.join(' ')}]`).join('  ')}`,
        )
        lines.push('    先 compare 再 resolve_family，否则这些瞬间只有占位代表参与竞争。')
      }
    }
    lines.push(
      `已花费：打分 ${this.paidCalls.inspect} 次 · 比较 ${this.paidCalls.compare} 次 · ` +
        `命中缓存省下 ${this.paidCalls.cached} 次`,
    )
    return lines.join('\n')
  }
}

/** 落盘形态。分数是花过钱的资产，必须跨会话活下来。 */
interface Persisted {
  folder: string
  limit?: number
  targets: Record<Category, number>
  candidates: Candidate[]
  families: Family[]
  scores: [string, StoredScore][]
  championByFamily: [string, string][]
  comparisons: { ids: string[]; winner: string; reason: string }[]
  paidCalls: { inspect: number; compare: number; cached: number }
  proposal?: { keep: string[]; why: Record<string, string> }
}

/**
 * 状态文件按目录+取样上限分片。
 *
 * 每次 `dsh` 都是全新会话，不落盘的话每一次都要为同一批照片重新付费打分。
 */
function stateFile(workdir: string, folder: string, limit?: number): string {
  const digest = createHash('sha256').update(`${folder}#${limit ?? 'all'}`).digest('hex').slice(0, 16)
  return join(workdir, `state-${digest}.json`)
}

/** 把已花过钱的结果写到工作目录。失败不抛：丢缓存比中断策展轻。 */
export async function saveState(state: RunState, workdir: string): Promise<void> {
  if (!state.folder) return
  const payload: Persisted = {
    folder: state.folder,
    limit: state.limit,
    targets: state.targets,
    candidates: [...state.candidates.values()],
    families: [...state.families.values()],
    scores: [...state.scores.entries()],
    championByFamily: [...state.championByFamily.entries()],
    comparisons: state.comparisons,
    paidCalls: state.paidCalls,
    proposal: state.proposal,
  }
  try {
    await mkdir(workdir, { recursive: true })
    await writeFile(stateFile(workdir, state.folder, state.limit), JSON.stringify(payload), 'utf8')
  } catch {
    // 下一次重新打分即可，不值得让整轮策展失败。
  }
}

/** 恢复同一目录、同一取样上限下已有的分数与家族结论。 */
export async function loadState(
  state: RunState,
  workdir: string,
  folder: string,
  limit?: number,
): Promise<boolean> {
  let payload: Persisted
  try {
    payload = JSON.parse(await readFile(stateFile(workdir, folder, limit), 'utf8')) as Persisted
  } catch {
    return false
  }
  state.folder = payload.folder
  state.limit = payload.limit
  state.targets = payload.targets
  state.candidates.clear()
  state.families.clear()
  state.scores.clear()
  state.championByFamily.clear()
  for (const candidate of payload.candidates) state.candidates.set(candidate.id, candidate)
  for (const family of payload.families) state.families.set(family.id, family)
  for (const [id, score] of payload.scores) state.scores.set(id, score)
  for (const [family, winner] of payload.championByFamily) state.championByFamily.set(family, winner)
  state.comparisons.splice(0, state.comparisons.length, ...payload.comparisons)
  state.paidCalls = payload.paidCalls
  state.proposal = payload.proposal
  return true
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

/**
 * 提议的五条后置条件。
 *
 * 第 4 条（每张都必须被看过）是防幻觉的关键：模型不能推荐一张它从没打开过的照片。
 */
export function validateProposal(state: RunState, keep: string[]): ValidationResult {
  if (!keep.length) return { ok: false, reason: '提议为空' }
  const unique = new Set(keep)
  if (unique.size !== keep.length) return { ok: false, reason: '提议里有重复照片' }

  const active = new Set(state.active().map((c) => c.id))
  const outside = keep.filter((id) => !active.has(id))
  if (outside.length) {
    return { ok: false, reason: `这些照片不在候选池里（或已被家族淘汰）：${outside.join(' ')}` }
  }

  const unseen = keep.filter((id) => !state.scores.has(id))
  if (unseen.length) {
    return { ok: false, reason: `这些照片你还没有 inspect 过，不能推荐：${unseen.join(' ')}` }
  }

  const byFamily = new Map<string, string[]>()
  for (const id of keep) {
    const family = state.candidates.get(id)?.family
    if (!family) continue
    byFamily.set(family, [...(byFamily.get(family) ?? []), id])
  }
  const conflict = [...byFamily.entries()].find(([, ids]) => ids.length > 1)
  if (conflict) {
    return { ok: false, reason: `同一连拍组 ${conflict[0]} 里选了多张：${conflict[1].join(' ')}` }
  }

  for (const category of ['people', 'scenery'] as Category[]) {
    const count = keep.filter((id) => state.candidates.get(id)?.category === category).length
    if (count > state.targets[category]) {
      return { ok: false, reason: `${category} 超出目标：选了 ${count} 张，目标 ${state.targets[category]} 张` }
    }
  }
  return { ok: true }
}
