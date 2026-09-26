// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { useAgentStatus } from '../state/agentStatus'

/**
 * The claude.ai thread look (pure half: lib/chatThread.ts). Pins the glue: the user message is a
 * bubble and the assistant's is not, one quiet action row per assistant turn with Copy (the app's
 * clipboard channel + "Copied") and a relative time from the transcript's `at`.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session, reads } = vi.hoisted(() => {
  const reads: { messages: unknown[] } = { messages: [] }
  const session = {
    api: {
      chat: {
        readTranscript: async () => ({ messages: reads.messages, found: true, olderCursor: null, unmatchedResults: [] })
      },
      pty: { sendText: vi.fn(async () => true as const) }
    }
  }
  return { session, reads }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-thread'
const MIN = 60_000
let host: HTMLDivElement
let root: Root
const writeText = vi.fn()

beforeEach(() => {
  writeText.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { clipboard: { writeText } }
  useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'done' } as (typeof s.byId)[string] } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

async function mount(messages: ChatMessage[]): Promise<void> {
  reads.messages = messages
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const now = Date.now()
const thread: ChatMessage[] = [
  { role: 'user', parts: [{ kind: 'text', text: 'fix it' }], key: 0, at: now - 10 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Looking **now**.' }], key: 10, at: now - 9 * MIN },
  { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 20, at: now - 8 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Done.' }], key: 30, at: now - 5 * MIN },
  { role: 'user', parts: [{ kind: 'text', text: 'thanks' }], key: 40, at: now - 3 * MIN },
  { role: 'assistant', parts: [{ kind: 'text', text: 'Anytime.' }], key: 50, at: now - 2 * MIN }
]

describe('⌘M thread look', () => {
  it('a user message is a bubble; an assistant message is not', async () => {
    await mount(thread)
    const user = host.querySelector('.term-chat__msg--user')!
    const assistant = host.querySelector('.term-chat__msg--assistant')!
    expect(user.classList.contains('term-chat__bubble')).toBe(true)
    expect(assistant.classList.contains('term-chat__bubble')).toBe(false)
    // The link guard's sink is unchanged: markdown still renders into `.term-chat__text`.
    expect(assistant.querySelector('.term-chat__text strong')?.textContent).toBe('now')
  })

  it('keeps single line breaks, as Claude Code renders them — in prompts and in quoted replies', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'This is a test\nof a multiline message' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'text', text: '> This is a test\n> of a multiline message' }], key: 10 }
    ])

    const user = host.querySelector('.term-chat__msg--user .term-chat__text')!
    const quote = host.querySelector('.term-chat__msg--assistant .term-chat__text blockquote')!

    expect(user.querySelector('br')).not.toBeNull()
    expect(quote.querySelector('br')).not.toBeNull()
  })

  it('one action row per assistant TURN (not per tool line), the latest always shown', async () => {
    await mount(thread)
    const rows = [...host.querySelectorAll('.term-chat__actions')]
    expect(rows).toHaveLength(2)
    expect(rows[0].closest('.term-chat__msg')?.textContent).toContain('Done.')
    expect(rows[0].classList.contains('term-chat__actions--latest')).toBe(false)
    expect(rows[1].classList.contains('term-chat__actions--latest')).toBe(true)
  })

  it('Copy writes the turn\'s markdown source through the app clipboard and says so', async () => {
    await mount(thread)
    const copy = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy message"]')[0]
    expect(copy.tabIndex).not.toBe(-1)
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith('Looking **now**.\n\nDone.')
    expect(copy.closest('.term-chat__actions')?.textContent).toMatch(/Copied/)
  })

  it('shows the relative time from `at`, the absolute one in the tooltip', async () => {
    await mount(thread)
    const times = [...host.querySelectorAll('.term-chat__actions time')]
    expect(times.map((t) => t.textContent)).toEqual(['5 min ago', '2 min ago'])
    expect(times[1].getAttribute('dateTime')).toBe(new Date(now - 2 * MIN).toISOString())
    expect(times[1].getAttribute('title')).toBeTruthy()
  })

  it('no time when the transcript stated none, and no Copy for a turn of tool calls only', async () => {
    await mount([
      { role: 'user', parts: [{ kind: 'text', text: 'q' }], key: 0 },
      { role: 'assistant', parts: [{ kind: 'tool', name: 'Bash', arg: 'ls' }], key: 10 }
    ])
    expect(host.querySelector('.term-chat__actions time')).toBeNull()
    expect(host.querySelector('button[aria-label="Copy message"]')).toBeNull()
  })
})
