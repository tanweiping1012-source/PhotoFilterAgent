import { createHash } from 'node:crypto'
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  PHOTO_ANCHOR_LAB_CODEX_ID,
} from './anchor-lab-codex-identity.ts'

const OWNER_SCHEMA = 'photo-anchor-lab-codex-state-owner/v1' as const
const HASH_PATTERN = /^[a-f0-9]{64}$/u

export class AnchorLabStateCoordinationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AnchorLabStateCoordinationError'
    this.code = code
  }
}

interface StateOwnerRecord {
  readonly schemaVersion: typeof OWNER_SCHEMA
  readonly technicalId: typeof PHOTO_ANCHOR_LAB_CODEX_ID
  readonly stateNamespaceHash: string
  readonly ownerSessionId: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.includes('\u0000')
}

function assertInputs(input: Readonly<{
  stateFile: string
  stateNamespaceHash: string
  ownerSessionId: string
}>): void {
  if (!validToken(input.stateFile) || !HASH_PATTERN.test(input.stateNamespaceHash)
    || !validToken(input.ownerSessionId)) {
    throw new AnchorLabStateCoordinationError(
      'STATE_COORDINATOR_INPUT_INVALID',
      'Anchor Lab state coordinator 输入无效。',
    )
  }
}

function ownerFileFor(stateFile: string): string {
  return join(dirname(stateFile), 'owner.json')
}

function ownerRecord(input: Readonly<{
  stateNamespaceHash: string
  ownerSessionId: string
}>): StateOwnerRecord {
  return Object.freeze({
    schemaVersion: OWNER_SCHEMA,
    technicalId: PHOTO_ANCHOR_LAB_CODEX_ID,
    stateNamespaceHash: input.stateNamespaceHash,
    ownerSessionId: input.ownerSessionId,
  })
}

function validateOwnerRecord(value: unknown): StateOwnerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnchorLabStateCoordinationError(
      'STATE_OWNER_RECORD_CORRUPT',
      '实验 owner 记录损坏；为避免跨会话重复付费，已阻止恢复。',
    )
  }
  const row = value as Partial<StateOwnerRecord>
  if (row.schemaVersion !== OWNER_SCHEMA
    || row.technicalId !== PHOTO_ANCHOR_LAB_CODEX_ID
    || !HASH_PATTERN.test(String(row.stateNamespaceHash ?? ''))
    || !validToken(row.ownerSessionId)
    || Object.keys(row).sort().join('\u0000') !== [
      'ownerSessionId', 'schemaVersion', 'stateNamespaceHash', 'technicalId',
    ].sort().join('\u0000')) {
    throw new AnchorLabStateCoordinationError(
      'STATE_OWNER_RECORD_CORRUPT',
      '实验 owner 记录字段无效；为避免跨会话重复付费，已阻止恢复。',
    )
  }
  return Object.freeze({
    schemaVersion: row.schemaVersion,
    technicalId: row.technicalId,
    stateNamespaceHash: row.stateNamespaceHash!,
    ownerSessionId: row.ownerSessionId,
  })
}

async function readStateHash(stateFile: string): Promise<string | null> {
  try {
    return sha256(await readFile(stateFile))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AnchorLabStateCoordinationError(
      'STATE_VERSION_UNREADABLE',
      '实验状态无法读取；为避免覆盖并发 checkpoint，已阻止继续。',
    )
  }
}

/**
 * Bind one state namespace to the DSH parent session that first created it.
 * A service restart may resume the same session id; another session must use a
 * new seed/namespace instead of sharing paid-operation state.
 */
export async function claimAnchorLabStateOwner(input: Readonly<{
  stateFile: string
  stateNamespaceHash: string
  ownerSessionId: string
}>): Promise<void> {
  assertInputs(input)
  const expected = ownerRecord(input)
  const ownerFile = ownerFileFor(input.stateFile)
  await mkdir(dirname(ownerFile), { recursive: true, mode: 0o700 })
  const serialized = JSON.stringify(expected)
  try {
    const persisted = validateOwnerRecord(JSON.parse(await readFile(ownerFile, 'utf8')))
    if (persisted.stateNamespaceHash !== expected.stateNamespaceHash
      || persisted.ownerSessionId !== expected.ownerSessionId) {
      throw new AnchorLabStateCoordinationError(
        'STATE_NAMESPACE_OWNED_BY_ANOTHER_SESSION',
        '同一实验 namespace 已由另一个 DSH 父会话占用；请使用新的 seed 创建独立运行。',
      )
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof AnchorLabStateCoordinationError) throw error
      throw new AnchorLabStateCoordinationError(
        'STATE_OWNER_RECORD_CORRUPT',
        '实验 owner 记录不可解析；为避免重复付费，已阻止继续。',
      )
    }
  }

  // A checkpoint without an owner could have been written by an older or
  // crashed process. Never adopt it merely because the owner file is absent.
  if (await readStateHash(input.stateFile) !== null) {
    throw new AnchorLabStateCoordinationError(
      'STATE_OWNER_MISSING_FOR_EXISTING_STATE',
      '发现没有 owner 身份的既有 checkpoint；为避免跨会话接管和重复付费，已阻止恢复。',
    )
  }
  try {
    await writeFile(ownerFile, serialized, { flag: 'wx', mode: 0o600 })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new AnchorLabStateCoordinationError(
        'STATE_OWNER_CLAIM_FAILED',
        '无法原子写入实验 owner；为避免重复付费，已阻止继续。',
      )
    }
  }

  let persisted: StateOwnerRecord
  try {
    persisted = validateOwnerRecord(JSON.parse(await readFile(ownerFile, 'utf8')))
  } catch (error) {
    if (error instanceof AnchorLabStateCoordinationError) throw error
    throw new AnchorLabStateCoordinationError(
      'STATE_OWNER_RECORD_CORRUPT',
      '实验 owner 记录不可解析；为避免重复付费，已阻止继续。',
    )
  }
  if (persisted.stateNamespaceHash !== expected.stateNamespaceHash
    || persisted.ownerSessionId !== expected.ownerSessionId) {
    throw new AnchorLabStateCoordinationError(
      'STATE_NAMESPACE_OWNED_BY_ANOTHER_SESSION',
      '同一实验 namespace 已由另一个 DSH 父会话占用；请使用新的 seed 创建独立运行。',
    )
  }
}

/**
 * Cross-process, fail-closed state serialization. The lock directory is never
 * auto-broken: after a crash an operator must inspect it, because guessing that
 * a paid request did not leave the process could cause a duplicate charge.
 */
export class AnchorLabStateCoordinator {
  readonly stateFile: string
  readonly stateNamespaceHash: string
  readonly ownerSessionId: string
  readonly lockDirectory: string
  #expectedHash: string | null | undefined
  #poisoned = false

  constructor(input: Readonly<{
    stateFile: string
    stateNamespaceHash: string
    ownerSessionId: string
  }>) {
    assertInputs(input)
    this.stateFile = input.stateFile
    this.stateNamespaceHash = input.stateNamespaceHash
    this.ownerSessionId = input.ownerSessionId
    this.lockDirectory = `${input.stateFile}.lock`
  }

  get expectedHash(): string | null | undefined {
    return this.#expectedHash
  }

  async initialize(): Promise<string | null> {
    await claimAnchorLabStateOwner(this)
    this.#expectedHash = await readStateHash(this.stateFile)
    return this.#expectedHash
  }

  async transact<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#poisoned) {
      throw new AnchorLabStateCoordinationError(
        'STATE_COORDINATOR_POISONED',
        '本进程的实验状态协调器已失效；必须重新加载 checkpoint 后再继续。',
      )
    }
    if (this.#expectedHash === undefined) {
      throw new AnchorLabStateCoordinationError(
        'STATE_COORDINATOR_NOT_INITIALIZED',
        '实验状态协调器尚未初始化。',
      )
    }
    // Revalidate the durable owner on every transaction, not only on initial
    // load. Later owner-file replacement must fail before state mutation or a
    // paid provider dispatch can begin.
    await claimAnchorLabStateOwner(this)
    try {
      await mkdir(this.lockDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AnchorLabStateCoordinationError(
          'STATE_LOCK_HELD',
          '实验状态正被另一个执行者占用；本次不会发送任何模型请求。',
        )
      }
      throw new AnchorLabStateCoordinationError(
        'STATE_LOCK_ACQUIRE_FAILED',
        '无法取得实验状态锁；本次不会发送任何模型请求。',
      )
    }

    const leaseFile = join(this.lockDirectory, 'lease.json')
    try {
      await writeFile(leaseFile, JSON.stringify(ownerRecord(this)), { flag: 'wx', mode: 0o600 })
      const actual = await readStateHash(this.stateFile)
      if (actual !== this.#expectedHash) {
        this.#poisoned = true
        throw new AnchorLabStateCoordinationError(
          'STATE_COMPARE_AND_SWAP_MISMATCH',
          '磁盘 checkpoint 已被其他执行者修改；当前内存状态已失效，必须重新加载。',
        )
      }
      try {
        return await operation()
      } finally {
        this.#expectedHash = await readStateHash(this.stateFile)
      }
    } catch (error) {
      if (!(error instanceof AnchorLabStateCoordinationError)
        || error.code === 'STATE_VERSION_UNREADABLE') {
        // An unreadable post-operation state cannot be safely reconciled.
        if (error instanceof AnchorLabStateCoordinationError) this.#poisoned = true
      }
      throw error
    } finally {
      await unlink(leaseFile).catch(() => undefined)
      await rmdir(this.lockDirectory).catch(() => undefined)
    }
  }
}
