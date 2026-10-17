// Antigravity's (`agy`) transcript file (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/
// logs/transcript_full.jsonl`) as the ⌘M panel's structured messages — and, through the relay's
// `chat.page`, the phone's.
//
// MEASURED against real `agy` 1.2.7 sessions (Windows 11, 2026-10-14):
// - `USER_INPUT`: user prompt wrapped in `<USER_REQUEST>...</USER_REQUEST>`, followed by
//   `<ADDITIONAL_METADATA>` and `<USER_SETTINGS_CHANGE>` (`Model Selection`).
// - `PLANNER_RESPONSE`: model text (`content`) and `tool_calls[]` (`{ id, name, args }`).
// - `GENERIC`: tool execution output (`content` or `error`), emitted in call order after the
//   preceding `PLANNER_RESPONSE.tool_calls`.
// - `ERROR_MESSAGE`: turn/API error (`error`).
// - `SYSTEM_MESSAGE` / `CHECKPOINT`: harness-internal system or compaction steps (omitted).
//
// Because steps are updated in place as their status changes (`RUNNING` → `DONE`) and tool outputs
// attach to the preceding `PLANNER_RESPONSE`, this reader uses the same capped whole-file read as
// `gemini-chat.ts` and `grok-chat.ts` (`readCappedTail`, `olderCursor: null`).
import type { ChatMessage, ChatPart, ChatTranscriptResult } from '../shared/types'
import type { ChatTranscriptPage } from '../shared/chat-page'
import { CHAT_TOOL_ARG_MAX } from '../shared/chat-command'
import {
  antigravityParse,
  extractAntigravityModelSelection,
  extractAntigravityToolArg,
  extractAntigravityUserText,
  type AntigravityChatLine
} from './context-link-render'
import { locateAntigravity } from './handoff/locate'
import { readCappedTail } from './transcript-reader'

const TOOL_RESULT_LINES = 3
const TOOL_RESULT_MAX = 500
const CHAT_META_MAX_CHARS = 100

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

export interface AntigravityChat {
  messages: ChatMessage[]
  model?: string
  skipped: number
}

function summarize(s: string): string {
  return s.split('\n').slice(0, TOOL_RESULT_LINES).join(' ').slice(0, TOOL_RESULT_MAX).trim()
}

function lineTime(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

export function chatFromAntigravity(buf: string): AntigravityChat {
  const { lines, skipped: parseSkipped } = antigravityParse(buf)
  let skipped = parseSkipped
  const messages: ChatMessage[] = []
  let pendingTools: ToolPart[] = []
  let model: string | undefined

  const push = (role: ChatMessage['role'], parts: ChatPart[], rec: AntigravityChatLine): void => {
    if (!parts.length) return
    const at = lineTime(rec.created_at)
    messages.push(at === undefined ? { role, parts } : { role, parts, at })
  }

  for (const rec of lines) {
    const rawRec = rec as Record<string, unknown>
    const inlineModel =
      typeof rawRec.modelName === 'string'
        ? rawRec.modelName.trim()
        : typeof rawRec.model === 'string'
          ? rawRec.model.trim()
          : ''
    if (inlineModel && inlineModel.length <= CHAT_META_MAX_CHARS) {
      model = inlineModel
    }

    switch (rec.type) {
      case 'USER_INPUT': {
        pendingTools = []
        const selected = extractAntigravityModelSelection(rec.content)
        if (selected && selected.length <= CHAT_META_MAX_CHARS) {
          model = selected
        }
        const text = extractAntigravityUserText(rec.content)
        if (text) push('user', [{ kind: 'text', text }], rec)
        break
      }
      case 'PLANNER_RESPONSE': {
        pendingTools = []
        const parts: ChatPart[] = []
        const text = typeof rec.content === 'string' ? rec.content.trim() : ''
        if (text) parts.push({ kind: 'text', text })
        if (Array.isArray(rec.tool_calls)) {
          for (const c of rec.tool_calls) {
            if (!c || typeof c !== 'object' || Array.isArray(c)) {
              skipped++
              continue
            }
            const part: ToolPart = {
              kind: 'tool',
              name: typeof c.name === 'string' && c.name ? c.name : 'tool',
              arg: extractAntigravityToolArg(c.args, CHAT_TOOL_ARG_MAX)
            }
            parts.push(part)
            pendingTools.push(part)
          }
        }
        push('assistant', parts, rec)
        break
      }
      case 'GENERIC': {
        const tool = pendingTools.shift()
        const raw =
          typeof rec.content === 'string' && rec.content
            ? rec.content
            : typeof rec.error === 'string'
              ? rec.error
              : ''
        if (tool && tool.result === undefined && raw) {
          const s = summarize(raw)
          if (s) tool.result = s
        }
        break
      }
      case 'ERROR_MESSAGE': {
        const err = typeof rec.error === 'string' ? rec.error.trim() : ''
        if (err) push('assistant', [{ kind: 'text', text: `[error] ${err}` }], rec)
        break
      }
      case 'SYSTEM_MESSAGE':
      case 'CHECKPOINT':
        break
      default:
        skipped++
    }
  }

  const out: AntigravityChat = { messages, skipped }
  if (model !== undefined) out.model = model
  return out
}

/**
 * The antigravity leg of `chat:read-transcript` (routed in transcript-ipc.ts BEFORE anything
 * claude-shaped runs). Local only (`CHAT_LOCAL_ONLY`): a remote node's session lives on its host
 * and there is no remote reader for it, so `remoteOnly` answers `unreadable` (paged) / not-found
 * (legacy) without touching this machine's disk.
 *
 * Located strictly by conversation id (`locateAntigravity`) with no cwd fallback.
 */
export async function readAntigravityChatTranscript(
  q: { sessionId?: string; remoteOnly?: boolean },
  page: ChatTranscriptPage | null
): Promise<ChatTranscriptResult> {
  const paging = page ? { olderCursor: null, unmatchedResults: [] } : {}
  if (q.remoteOnly) {
    return page ? { messages: [], found: false, ...paging, unreadable: true } : { messages: [], found: false }
  }
  const p = q.sessionId ? await locateAntigravity(q.sessionId) : undefined
  const buf = p ? await readCappedTail(p) : undefined
  if (buf === undefined) return { messages: [], found: false, ...paging }
  const chat = chatFromAntigravity(buf)
  return {
    messages: chat.messages,
    found: true,
    ...paging,
    ...(page && chat.model !== undefined ? { model: chat.model } : {})
  }
}
