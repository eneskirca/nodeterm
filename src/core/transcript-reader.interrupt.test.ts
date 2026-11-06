// An interrupted turn in the ⌘M thread (opt-in `rich`). Claude Code saves its interrupt marker as a
// USER record, but the user did not type it: it becomes an `interrupt` part on the assistant side,
// and a tool call it cancelled shows "Interrupted" instead of Claude's canned rejection. Read from
// the captured transcripts (`__fixtures__/claude/interrupt-capture.json`, Claude Code 2.1.285).
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { INTERRUPTED_TOOL_RESULT, parseChatMessages } from './transcript-reader'
import type { ChatMessage } from '../shared/types'

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../shared/agents/__fixtures__/claude/interrupt-capture.json'), 'utf8')
) as { scenarios: Record<string, { transcript: unknown[] }> }
const lines = (scenario: string): string[] => fixture.scenarios[scenario].transcript.map((r) => JSON.stringify(r))

const shape = (ms: ChatMessage[]): string[] =>
  ms.map(
    (m) =>
      `${m.role}:${m.parts
        .map((p) => (p.kind === 'tool' ? `tool(${p.name}|${p.result ?? ''})` : p.kind === 'text' ? p.text : p.kind))
        .join('+')}`
  )

describe('interrupt markers in the chat thread', () => {
  it('rich: an interrupt mid-reply is an interrupt part, not a user bubble', () => {
    const ms = parseChatMessages(lines('esc_streaming'), { rich: true })

    const last = ms.at(-1)
    expect(last).toMatchObject({ role: 'assistant', parts: [{ kind: 'interrupt' }] })
    expect(shape(ms).some((s) => s.includes('[Request interrupted'))).toBe(false)
  })

  it.each(['esc_tool_call', 'esc_permission_prompt'])(
    'rich: a cancelled tool call (%s) says Interrupted, then the interrupt part',
    (scenario) => {
      const ms = parseChatMessages(lines(scenario), { rich: true })

      expect(shape(ms).slice(-2)).toEqual([`assistant:tool(Bash|${INTERRUPTED_TOOL_RESULT})`, 'assistant:interrupt'])
    }
  )

  it('without rich, the marker and the rejection stay as before (the phone reads this)', () => {
    const ms = parseChatMessages(lines('esc_tool_call'))

    const s = shape(ms)
    expect(s.at(-1)).toBe('user:[Request interrupted by user for tool use]')
    expect(s.at(-2)).toMatch(/^assistant:tool\(Bash\|The user doesn't want to proceed/)
  })

  it('a rejection with no interrupt after it keeps its own text', () => {
    const all = lines('esc_tool_call')
    const withoutMarker = all.filter((l) => !l.includes('[Request interrupted'))

    const ms = parseChatMessages(withoutMarker, { rich: true })

    expect(shape(ms).at(-1)).toMatch(/^assistant:tool\(Bash\|The user doesn't want to proceed/)
  })

  it('a user who types the marker text as a plain prompt is still the user', () => {
    const typed = JSON.stringify({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } })

    const ms = parseChatMessages([typed], { rich: true })

    expect(shape(ms)).toEqual(['user:[Request interrupted by user]'])
  })
})
