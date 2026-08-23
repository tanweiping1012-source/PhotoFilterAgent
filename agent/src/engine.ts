/**
 * `photofilter` 本地分析进程的调用封装。
 *
 * 引擎是 agent 的“免费工具”：分类、相似家族、技术质量全部在本机算完，一次网络都不走。
 * 它返回的候选表里没有绝对路径、文件名和绝对拍摄时间——匿名 ID 到真实路径的映射
 * 只存在于引擎自己的工作目录，模型永远拿不到。
 * @module
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 一张候选照片的本地事实。全部来自本机分析，不含任何可识别信息。 */
export interface Candidate {
  /** 本轮稳定的匿名 ID，例如 `p042`。 */
  id: string
  /** 本地判定的类型。 */
  category: 'people' | 'scenery'
  /** 清晰度在 0–100 的归一化值。 */
  sharp: number
  /** 动态范围 0–100。 */
  range: number
  /** 过曝与欠曝合计占比 0–100，越低越好。 */
  clip: number
  /** 技术风险标记。 */
  risk: string[]
  /** 所属相似家族；独立照片没有这个字段。 */
  family?: string
  /** 相对本批第一张的拍摄秒数。绝对时间不出本机。 */
  t?: number
  /** 本地技术排序认为它是同家族里的优等生。 */
  local_top: boolean
  /** 人脸事实摘要，例如「脸质量53 眼睛闭」；没有人脸时缺席。 */
  face?: string
  /** Apple 人脸拍摄质量分 0–100。 */
  face_quality?: number
  /** 本机判定眼睛明显闭合。这是硬伤，不是风格。 */
  eyes_closed?: boolean
  /** 属于某个连拍组且不是占位代表——默认不参与竞争，要 compare 才拆得开。 */
  collapsed?: boolean
}

/** 一组画面高度相似的照片。最终结果里同一家族最多留一张。 */
export interface Family {
  id: string
  members: string[]
}

export interface AnalyzeReport {
  workdir: string
  photo_count: number
  people_count: number
  scenery_count: number
  family_count: number
  families: Family[]
  candidates: Candidate[]
  collapsed_by_family: string[]
}

export interface SelectionBlock {
  target: number
  selected: string[]
  pool_size: number
  all_scores: Record<string, number>
  selected_scores: { id: string; score: number }[]
}

export interface SelectReport {
  workdir: string
  photo_count: number
  keep: string[]
  method: string
  people: SelectionBlock
  scenery: SelectionBlock
}

export class EngineError extends Error {}

/** 单张预览：无元数据 JPEG 的 base64 与实际字节数。 */
export interface Preview {
  id: string
  detail: string
  max_pixel: number
  bytes: number
  jpeg_base64: string
}

/**
 * 调用 `photofilter` 并解析它的 JSON 输出。
 *
 * @param binary - 引擎可执行文件路径。
 * @param args - 子命令与参数。
 * @param signal - 取消信号；触发时子进程被终止。
 * @returns 解析后的 JSON。
 * @throws {EngineError} 子进程失败或输出不是合法 JSON。
 */
async function invoke<T>(binary: string, args: string[], signal?: AbortSignal): Promise<T> {
  let stdout: string
  try {
    // 候选表可以到几百 KB，预览的 base64 更大，默认 1MB 的缓冲不够用。
    const result = await run(binary, args, { maxBuffer: 256 * 1024 * 1024, signal, encoding: 'utf8' })
    stdout = result.stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new EngineError(`photofilter ${args[0]} 执行失败: ${detail}`)
  }
  try {
    return JSON.parse(stdout) as T
  } catch {
    throw new EngineError(`photofilter ${args[0]} 的输出不是合法 JSON`)
  }
}

export class PhotoEngine {
  constructor(
    private readonly binary: string,
    private readonly workdir: string,
  ) {}

  /** 递归分析一个目录，产出候选表。 */
  analyze(folder: string, limit?: number, signal?: AbortSignal): Promise<AnalyzeReport> {
    const args = ['analyze', folder, '--workdir', this.workdir]
    if (limit && limit > 0) args.push('--limit', String(limit))
    return invoke<AnalyzeReport>(this.binary, args, signal)
  }

  /** 确定性选片。它是无 Key 时的产品路径，也是 agent 失败时的兜底。 */
  select(
    folder: string,
    people: number,
    scenery: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SelectReport> {
    const args = [
      'select', folder,
      '--workdir', this.workdir,
      '--people', String(people),
      '--scenery', String(scenery),
    ]
    if (limit && limit > 0) args.push('--limit', String(limit))
    return invoke<SelectReport>(this.binary, args, signal)
  }

  /** 生成一张照片的无元数据缩放 JPEG。原图只读。 */
  preview(id: string, detail: 'low' | 'standard' | 'high', signal?: AbortSignal): Promise<Preview> {
    return invoke<Preview>(
      this.binary,
      ['preview', id, '--workdir', this.workdir, '--detail', detail],
      signal,
    )
  }

  /** 只复制到目标目录；原图不移动、不删除、不改名。 */
  export(ids: string[], destination: string, signal?: AbortSignal): Promise<{
    destination: string
    count: number
    copied: { id: string; filename: string }[]
  }> {
    return invoke(this.binary, ['export', ...ids, '--workdir', this.workdir, '--to', destination], signal)
  }
}
