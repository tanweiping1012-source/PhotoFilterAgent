/**
 * 视觉模型 API Key 的解析顺序。
 *
 * 顺序：环境变量 → `$DSH_HOME/.credentials.yaml` → Keychain。
 *
 * Keychain 放在最后且默认关闭：从一个不拥有该条目的进程读取会弹出图形授权框并阻塞，
 * 在无人值守运行里那等于挂死。要用它必须显式打开 `allowKeychain`，
 * 并且接受第一次会弹窗。
 *
 * Key 只在内存里传递：不写文件、不进 session log、不进模型可见的任何一步。
 * @module
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** macOS Keychain 里存放 MiniMax Key 的 service 名（沿用旧 App 的条目）。 */
export const KEYCHAIN_SERVICE = 'com.photocurator.local.ai-api-key.minimax'

export interface KeyLookup {
  /** 解析到的 Key；未找到时为 undefined。 */
  key?: string
  /** 来源，用于日志与诊断——只说来源，不说值。 */
  source: 'env' | 'credentials' | 'keychain' | 'missing'
}

/**
 * 从 `$DSH_HOME/.credentials.yaml` 取一个凭据条目。
 *
 * 这是 harness 自己的凭据面：文件由用户拥有，读取不触发任何图形授权，
 * 因此它是无人值守运行下唯一可靠的来源。
 */
async function fromCredentialsFile(names: readonly string[]): Promise<string | undefined> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  let text: string
  try {
    text = await readFile(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  for (const name of names) {
    // 条目嵌在 `refs:` 之下并带缩进，所以不能用行首锚点直接顶到名字。
    const match = new RegExp(`^\\s*${name}\\s*:\\s*["']?([^"'\\s#]+)`, 'mu').exec(text)
    if (match?.[1]) return match[1]
  }
  return undefined
}

export interface ResolveOptions {
  /** 读取的环境变量名，按顺序尝试。 */
  envNames?: readonly string[]
  /** 是否允许回落到 Keychain（会弹授权框）。默认 false。 */
  allowKeychain?: boolean
  /** Keychain 读取超时；超时视为不可用，绝不无限等待授权框。 */
  keychainTimeoutMs?: number
}

/**
 * 按 env → Keychain 的顺序解析 Key。
 *
 * @param options - 解析来源与超时。
 * @returns 解析结果；`source` 说明它从哪来，`key` 未找到时为 undefined。
 */
export async function resolveVisionApiKey(options: ResolveOptions = {}): Promise<KeyLookup> {
  const envNames = options.envNames
    ?? ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY', 'PHOTO_FILTER_VISION_KEY']
  for (const name of envNames) {
    const value = process.env[name]?.trim()
    if (value) return { key: value, source: 'env' }
  }

  const fromFile = await fromCredentialsFile(envNames)
  if (fromFile) return { key: fromFile, source: 'credentials' }

  if (!options.allowKeychain) return { source: 'missing' }

  try {
    const { stdout } = await run(
      'security',
      ['find-generic-password', '-w', '-s', KEYCHAIN_SERVICE],
      { timeout: options.keychainTimeoutMs ?? 8_000, encoding: 'utf8' },
    )
    const value = stdout.trim()
    return value ? { key: value, source: 'keychain' } : { source: 'missing' }
  } catch {
    // 超时、被拒绝、条目不存在——对调用方是同一件事：拿不到 Key，走本地兜底。
    return { source: 'missing' }
  }
}
