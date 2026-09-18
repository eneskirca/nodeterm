import {
  BUILTIN_AGENT_IDS,
  capabilityAgentId,
  type AgentId,
  type BuiltinAgentId
} from '@shared/agents/config'
import type { AgentState } from '@shared/agents/normalize'
import type { AgentStatusSnapshot, AgentStatusSnapshotEntry } from '@shared/agents/status-snapshot'
import { readSmallTail } from './transcript-reader'
import { locateClaude, locateGemini } from './handoff/locate'
import { decideFromTranscriptTail } from './remote-ssh/agent-resync-decide'
import {
  defaultCodexAppServerSocket,
  readCodexThreadAt,
  type CodexThreadSnapshot
} from './codex-session-name'

const RECOVERY_TAIL_BYTES = 512 * 1024

export interface RecoveredAgentStatus {
  state: AgentState
  /** Timestamp of the persisted/runtime evidence, used only to order it against the ledger. */
  observedAt: number
  source: 'claude-transcript' | 'codex-app-server' | 'gemini-transcript'
}

export interface AgentStatusInspectionInput {
  agentId: AgentId
  sessionId: string
  accountId?: string
}

export type AgentStatusInspector = (
  input: AgentStatusInspectionInput
) => Promise<RecoveredAgentStatus | null>

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function lastRecordTimestamp(text: string): number | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as { timestamp?: unknown }
      const at = timestamp(record?.timestamp)
      if (at !== null) return at
    } catch {
      // A capped/torn line costs only itself; failed read is never evidence of absence.
    }
  }
  return null
}

/** Claude's measured JSONL shape: reuse the reconnect parser rather than cloning its tool rules. */
export function inspectClaudeTranscript(text: string): RecoveredAgentStatus | null {
  const verdict = decideFromTranscriptTail(text)
  const observedAt = lastRecordTimestamp(text)
  if (observedAt === null || verdict === 'undecided') return null
  return {
    state: verdict === 'ended' ? 'done' : 'working',
    observedAt,
    source: 'claude-transcript'
  }
}

interface GeminiMessage {
  type?: unknown
  timestamp?: unknown
  content?: unknown
  toolCalls?: unknown
}

function geminiMessageEvidence(message: GeminiMessage): RecoveredAgentStatus | null {
  const observedAt = timestamp(message.timestamp)
  if (observedAt === null) return null
  if (message.type === 'user') {
    return { state: 'working', observedAt, source: 'gemini-transcript' }
  }
  if (message.type !== 'gemini') return null
  // A tool-call record is not a turn end. The agent may be executing it, waiting for permission,
  // or about to make the next model call; all three make `done` an unsafe conclusion.
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return { state: 'working', observedAt, source: 'gemini-transcript' }
  }
  const hasAnswer =
    (typeof message.content === 'string' && message.content.trim().length > 0) ||
    (Array.isArray(message.content) && message.content.length > 0)
  return hasAnswer ? { state: 'done', observedAt, source: 'gemini-transcript' } : null
}

/** Fold Gemini's event-sourced JSONL, including `$set.messages` history replacement records. */
export function inspectGeminiTranscript(text: string): RecoveredAgentStatus | null {
  let latest: RecoveredAgentStatus | null = null
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let record: GeminiMessage & { $set?: { messages?: unknown } }
    try {
      record = JSON.parse(raw) as typeof record
    } catch {
      continue
    }
    const replacement = record.$set?.messages
    if (Array.isArray(replacement)) {
      latest = null
      for (const message of replacement) {
        const evidence = geminiMessageEvidence((message ?? {}) as GeminiMessage)
        if (evidence) latest = evidence
      }
      continue
    }
    const evidence = geminiMessageEvidence(record)
    if (evidence) latest = evidence
  }
  return latest
}

/** Map Codex's documented `thread/read` runtime status onto nodeterm's shared workflow states. */
export function inspectCodexThread(
  thread: CodexThreadSnapshot | null,
  observedAt: number
): RecoveredAgentStatus | null {
  const type = thread?.status?.type
  if (type === 'idle') return { state: 'done', observedAt, source: 'codex-app-server' }
  if (type !== 'active') return null
  const flags = Array.isArray(thread?.status?.activeFlags) ? thread.status.activeFlags : []
  return {
    state: flags.includes('waitingOnApproval') ? 'blocked' : 'working',
    observedAt,
    source: 'codex-app-server'
  }
}

async function inspectTranscriptAt(
  path: string | undefined,
  parse: (text: string) => RecoveredAgentStatus | null
): Promise<RecoveredAgentStatus | null> {
  if (!path) return null
  const text = await readSmallTail(path, RECOVERY_TAIL_BYTES)
  return text === undefined ? null : parse(text)
}

const DEFAULT_INSPECTORS: Partial<Record<BuiltinAgentId, AgentStatusInspector>> = {
  claude: async ({ sessionId, accountId }) =>
    inspectTranscriptAt(await locateClaude(sessionId, accountId), inspectClaudeTranscript),
  codex: async ({ sessionId }) =>
    inspectCodexThread(
      await readCodexThreadAt(defaultCodexAppServerSocket(), sessionId),
      Date.now()
    ),
  gemini: async ({ sessionId }) =>
    inspectTranscriptAt(await locateGemini(sessionId), inspectGeminiTranscript)
}

export interface RecoverSnapshotOptions {
  accountIdForNode?: (nodeId: string) => string | undefined
  isRemoteNode?: (nodeId: string) => boolean
  inspectors?: Partial<Record<BuiltinAgentId, AgentStatusInspector>>
}

/**
 * Inspect every addressable session independently. Unsupported agents and any read/shape failure
 * return no evidence, leaving their durable last-known row untouched.
 */
export async function recoverAgentStatusSnapshot(
  snapshot: AgentStatusSnapshot,
  options: RecoverSnapshotOptions = {}
): Promise<Record<string, RecoveredAgentStatus>> {
  const inspectors = options.inspectors ?? DEFAULT_INSPECTORS
  const recovered: Record<string, RecoveredAgentStatus> = {}
  await Promise.all(
    Object.entries(snapshot).map(async ([nodeId, entry]: [string, AgentStatusSnapshotEntry]) => {
      if (!entry.agentId || !entry.sessionId || options.isRemoteNode?.(nodeId)) return
      const base = capabilityAgentId(entry.agentId)
      const builtin = BUILTIN_AGENT_IDS.find((id) => id === base)
      const inspector = builtin ? inspectors[builtin] : undefined
      if (!inspector) return
      try {
        const evidence = await inspector({
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          accountId: options.accountIdForNode?.(nodeId)
        })
        if (evidence && evidence.observedAt > entry.changedAt) recovered[nodeId] = evidence
      } catch {
        // Best effort. A failed inspector is unknown, never proof that the remembered state ended.
      }
    })
  )
  return recovered
}
