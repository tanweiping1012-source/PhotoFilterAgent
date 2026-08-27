import { randomBytes } from 'node:crypto'

interface SessionHeaderLike {
  origin?: unknown
  parentSession?: unknown
  delegationDepth?: unknown
}

interface MessageBlockLike {
  type?: unknown
  text?: unknown
}

interface SessionMessageLike {
  id?: unknown
  role?: unknown
  source?: { kind?: unknown }
  content?: unknown
}

interface HarnessAgentLike {
  session?: {
    header?: SessionHeaderLike
    deriveMessages?: () => unknown
  }
}

export interface GenuineUserMessage {
  id: string
  text: string
}

interface ExportApprovalBindingLike {
  selectionHash?: unknown
  destination?: unknown
  confirmationCode?: unknown
}

export function exportApprovalMatches(
  approval: ExportApprovalBindingLike | undefined,
  selectionHash: string,
  destination: string,
  confirmationCode: string,
): boolean {
  return approval?.selectionHash === selectionHash
    && approval.destination === destination
    && approval.confirmationCode === confirmationCode
}

/**
 * The prompt's "main Agent must not audit itself" rule is also enforced at
 * runtime. These fields are durable Harness session lineage, not arguments the
 * model can choose when calling a tool.
 */
export function isIndependentAuditCaller(agent: unknown): boolean {
  const header = (agent as HarnessAgentLike | undefined)?.session?.header
  return header?.origin === 'subagent'
    && typeof header.parentSession === 'string'
    && header.parentSession.length > 0
    && Number.isSafeInteger(header.delegationDepth)
    && (header.delegationDepth as number) >= 1
}

function sessionMessages(agent: unknown): SessionMessageLike[] {
  const session = (agent as HarnessAgentLike | undefined)?.session
  if (typeof session?.deriveMessages !== 'function') return []
  try {
    const value = session.deriveMessages()
    return Array.isArray(value) ? value as SessionMessageLike[] : []
  } catch {
    return []
  }
}

function userMessage(value: SessionMessageLike): GenuineUserMessage | undefined {
  if (value.role !== 'user' || value.source?.kind !== 'user' || typeof value.id !== 'string') {
    return undefined
  }
  if (!Array.isArray(value.content)) return { id: value.id, text: '' }
  const text = value.content.flatMap(block => {
    const item = block as MessageBlockLike
    return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('\n')
  return { id: value.id, text }
}

export function latestGenuineUserMessage(agent: unknown): GenuineUserMessage | undefined {
  const messages = sessionMessages(agent)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = userMessage(messages[index]!)
    if (value) return value
  }
  return undefined
}

function containsExactConfirmationLine(text: string, code: string): boolean {
  const expected = `确认导出 ${code}`
  return text.split(/\r?\n/u).some(line => line.trim() === expected)
}

/**
 * Confirmation must come from a genuine user-authored message added after the
 * approval request. Model, tool, plugin and inherited/same-turn text cannot
 * satisfy this gate.
 */
export function hasGenuineExportConfirmation(
  agent: unknown,
  code: string,
  requestedAfterUserMessageId?: string,
): boolean {
  if (requestedAfterUserMessageId === undefined) return false
  const messages = sessionMessages(agent)
  const marker = messages.findIndex(message => userMessage(message)?.id === requestedAfterUserMessageId)
  if (marker < 0) return false
  const start = marker + 1
  for (let index = start; index < messages.length; index += 1) {
    const value = userMessage(messages[index]!)
    if (value && containsExactConfirmationLine(value.text, code)) return true
  }
  return false
}

/** Random, non-semantic one-time code. Injection keeps the format testable. */
export function newExportConfirmationCode(
  bytes: (size: number) => Uint8Array = randomBytes,
): string {
  const value = bytes(4)
  if (value.length !== 4) throw new Error('导出确认码生成失败')
  return `PF-${Array.from(value, item => item.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
