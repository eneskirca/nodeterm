// Renders cursor's conversation to full Markdown. The input is the transcript text
// `cursorTranscriptText` builds from the chat's SQLite store: one message JSON per line (see
// core/cursor-chat.ts for the shapes). Unlike the summarised chat view this keeps every tool call's
// arguments and every result in full. A user message that is not a `<user_query>` is harness context
// (rules, skills, environment), never something the human said, so it is left out; so is reasoning.
import { cursorUserText, parseCursorNdjson } from '../../core/cursor-chat'
import { blockText, fenceJson } from './format'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function renderCursorTranscript(raw: string): string {
  const out: string[] = []
  for (const m of parseCursorNdjson(raw)) {
    if (!isObj(m) || !Array.isArray(m.content)) continue
    for (const c of m.content as unknown[]) {
      if (!isObj(c)) continue
      if (m.role === 'user' && c.type === 'text' && typeof c.text === 'string') {
        const t = cursorUserText(c.text)
        if (t !== undefined) out.push(`## User\n\n${t}`)
      } else if (m.role === 'assistant' && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.push(`## Assistant\n\n${c.text}`)
      } else if (m.role === 'assistant' && c.type === 'tool-call') {
        out.push(`### Tool call: ${String(c.toolName ?? 'tool')}\n\n${fenceJson(c.args)}`)
      } else if (m.role === 'tool' && c.type === 'tool-result') {
        out.push('### Tool result\n\n```\n' + blockText(c.result) + '\n```')
      }
    }
  }
  return out.join('\n\n')
}
