// Cursor subagent cards: the END the hooks never send, and the child's live activity.
//
// MEASURED on cursor-agent 2026.10.01 (interactive TUI, three runs: two built-in `explore`
// children, one custom `.cursor/agents` child; `__fixtures__/cursor/subagent-payloads.json`):
//  - `subagentStart` / `subagentStop` never fired, although subscribed.
//  - the parent's `Task` tool gets a `preToolUse` (the card's start, in normalizeCursor) and NO
//    `postToolUse`. The child ran synchronously every time: all its events landed before the
//    parent's `stop`. So the parent's `stop` (or `sessionEnd`) is the end, emitted here.
//  - the child's tool events carry the CHILD's chat id (`isCursorChildToolEvent`) and, from its
//    first `postToolUse` on, its own `transcript_path`:
//    `<config>/projects/<slug>/agent-transcripts/<childId>/<childId>.jsonl`, append-only JSONL
//    `{role, message:{content:[text | tool_use]}}` lines ending `{"type":"turn_ended",status}`.
//    Its assistant text is often `[REDACTED]`; tool calls and the final answer are kept.
//  - the hook payloads hold NO key linking child to parent (no `parent_tool_call_id`). The child's
//    store.db meta does (`subagentInfo.toolCallId`), but a child is claimed here only when exactly
//    ONE of the node's open Tasks is unclaimed. note: parallel Tasks get cards without a tail;
//    read the child meta's toolCallId if that ever matters.
//
// One definition for both shells (CLAUDE.md rule 10): src/main/index.ts and
// src/server/agent-status.ts each call `onRaw` from their raw hook listener.
import path from 'node:path'
import { isCursorBackgroundEvent, isCursorChildToolEvent, type NormalizedAgentEvent } from '../shared/agents/normalize'
import type { AgentId } from '../shared/agents/config'
import type { SubagentTail } from './subagent-tail'
import { CURSOR_CHAT_ID_RE, cursorConfigDir, cursorToolArg, cursorUserText } from './cursor-chat'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const REDACTED = '[REDACTED]'

/** One chunk of a child's agent-transcript JSONL as card text. Stateless, fresh per card. */
export function createCursorSubagentFormatter(): (text: string) => string {
  return (text: string): string => {
    const out: string[] = []
    for (const line of text.split('\n')) {
      let o: unknown
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObj(o)) continue
      if (o.type === 'turn_ended') {
        out.push(o.status === 'success' ? '✓ done' : `✗ ${typeof o.status === 'string' ? o.status : 'ended'}`)
        continue
      }
      const content = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : []
      for (const c of content) {
        if (!isObj(c)) continue
        if (c.type === 'text' && typeof c.text === 'string') {
          const t = o.role === 'user' ? cursorUserText(c.text) : c.text.replaceAll(REDACTED, '').trim()
          if (t) out.push(t)
        } else if (c.type === 'tool_use' && typeof c.name === 'string') {
          const arg = cursorToolArg(c.input)
          out.push(`$ ${c.name}${arg ? ` ${arg}` : ''}`)
        }
      }
    }
    return out.join('\n')
  }
}

/** The child's own transcript path, or undefined: absolute, under `<config>/projects/`, and named
 *  `<childId>/<childId>.jsonl`. The path comes from a hook POST, so it is jailed like any other. */
export function cursorChildTranscript(p: unknown, childId: string, configDir: string = cursorConfigDir()): string | undefined {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) return undefined
  if (!CURSOR_CHAT_ID_RE.test(childId)) return undefined
  const root = path.join(configDir, 'projects') + path.sep
  if (!p.startsWith(root)) return undefined
  if (path.basename(p) !== `${childId}.jsonl` || path.basename(path.dirname(p)) !== childId) return undefined
  return p
}

interface NodeEntry {
  /** Task tool_use_ids started in this turn, in order. */
  open: string[]
  /** child chat id → the Task tool_use_id whose card it feeds. */
  children: Map<string, string>
}

export interface CursorSubagentTracker {
  onRaw(agentId: AgentId, nodeId: string | undefined, payload: unknown): void
  /** The node closed or was recycled mid-Task: no `stop` will come, so drop its entry and tails. */
  release(nodeId: string): void
}

export function createCursorSubagentTracker(deps: {
  tail: SubagentTail
  emit: (e: NormalizedAgentEvent) => void
  configDir?: () => string
}): CursorSubagentTracker {
  const nodes = new Map<string, NodeEntry>()
  return {
    onRaw(agentId, nodeId, payload) {
      if (!nodeId || !isObj(payload)) return
      const ev = payload.hook_event_name
      const conv = typeof payload.conversation_id === 'string' ? payload.conversation_id : undefined
      const isTool = ev === 'preToolUse' || ev === 'postToolUse' || ev === 'postToolUseFailure'
      if (isTool && isCursorChildToolEvent(payload)) {
        const e = nodes.get(nodeId)
        if (!e || !conv || e.children.has(conv)) return
        const claimed = new Set(e.children.values())
        const free = e.open.filter((id) => !claimed.has(id))
        if (free.length !== 1) return
        const file = cursorChildTranscript(payload.transcript_path, conv, deps.configDir?.())
        if (!file) return // a child's first preToolUse has no path yet; its postToolUse does
        e.children.set(conv, free[0])
        deps.tail.trackFile(free[0], file, createCursorSubagentFormatter)
        return
      }
      if (ev === 'preToolUse' && payload.tool_name === 'Task' && typeof payload.tool_use_id === 'string') {
        const e: NodeEntry = nodes.get(nodeId) ?? { open: [], children: new Map() }
        if (!e.open.includes(payload.tool_use_id)) e.open.push(payload.tool_use_id)
        nodes.set(nodeId, e)
        return
      }
      if (ev === 'stop' || ev === 'sessionEnd') {
        // A background agent's end, or a claimed child's own, is not the parent's: it must not end
        // the parent's cards or stand in as its session id (normalizeCursor drops it the same way).
        if (isCursorBackgroundEvent(payload)) return
        const e = nodes.get(nodeId)
        if (!e || (conv && e.children.has(conv))) return
        nodes.delete(nodeId)
        for (const toolUseId of e.open) {
          deps.emit({ nodeId, agentId, sessionId: conv, kind: 'subagent-end', toolUseId })
          deps.tail.finish(toolUseId)
        }
      }
    },
    release(nodeId) {
      const e = nodes.get(nodeId)
      if (!e) return
      nodes.delete(nodeId)
      for (const toolUseId of e.open) deps.tail.finish(toolUseId)
    }
  }
}
