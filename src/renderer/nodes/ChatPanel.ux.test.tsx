// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import { useAgentStatus } from '../state/agentStatus'

/**
 * The ⌘M chat panel's UX glue (the pure decisions live in `lib/chatPanel.ts`): Shift+Enter / IME,
 * the thinking disclosure, the stale-response guard, the ↻ reload, the agent-named composer copy
 * and scroll-follow. `readTranscript` is a controllable deferred per call so ordering is explicit.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Pending {
  sessionId: string | undefined
  resolve: (r: ChatTranscriptResult) => void
  reject: (e: unknown) => void
}

// ONE stable api object: `load` depends on `api`, so a fresh object per `useSession()` call would
// re-run the load effect on every render and never settle.
const { sendText, readTranscript, pending, session } = vi.hoisted(() => {
  const pending: Pending[] = []
  const sendText = vi.fn(async (_id: string, _text: string) => true as const)
  const readTranscript = vi.fn(
    (sessionId: string | undefined) =>
      new Promise<ChatTranscriptResult>((resolve, reject) => pending.push({ sessionId, resolve, reject }))
  )
  const session = { api: { chat: { readTranscript }, pty: { sendText } } }
  return { sendText, readTranscript, pending, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'
import { GROK_AMBIGUOUS_SESSION_MESSAGE } from '@shared/chat-page'

const NODE = 'n-chat-ux'
let host: HTMLDivElement
let root: Root

const text = (role: 'user' | 'assistant', t: string): ChatMessage => ({ role, parts: [{ kind: 'text', text: t }] })

async function render(props: { sessionId?: string; agentId?: string } = {}): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId={props.sessionId ?? 's1'} agentId={props.agentId ?? 'claude'} />)
  })
}

async function resolveAt(i: number, messages: ChatMessage[]): Promise<void> {
  await act(async () => {
    pending[i].resolve({ messages, found: true })
  })
}

const textarea = (): HTMLTextAreaElement => host.querySelector('textarea') as HTMLTextAreaElement
const msgs = (): HTMLDivElement => host.querySelector('.term-chat__msgs') as HTMLDivElement

function type(ta: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, value)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(ta: HTMLTextAreaElement, init: KeyboardEventInit & { isComposing?: boolean }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  ta.dispatchEvent(ev)
  return ev
}

/** jsdom has no layout: give the scroller explicit geometry the component reads. */
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.clientHeight })
}

beforeEach(() => {
  sendText.mockClear()
  readTranscript.mockClear()
  pending.length = 0
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

describe('ChatPanel composer keys', () => {
  it('Shift+Enter does not send and keeps the textarea default (a newline)', async () => {
    await render()
    await resolveAt(0, [])
    await act(async () => type(textarea(), 'line one'))
    let ev!: KeyboardEvent
    await act(async () => {
      ev = key(textarea(), { key: 'Enter', shiftKey: true })
    })
    expect(sendText).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('an Enter committing an IME composition does not send', async () => {
    await render()
    await resolveAt(0, [])
    await act(async () => type(textarea(), 'こんにちは'))
    await act(async () => {
      key(textarea(), { key: 'Enter', isComposing: true })
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('plain Enter still sends', async () => {
    await render()
    await resolveAt(0, [])
    await act(async () => type(textarea(), 'hi'))
    await act(async () => {
      key(textarea(), { key: 'Enter' })
    })
    expect(sendText).toHaveBeenCalledWith(NODE, 'hi', { typed: true })
  })
})

describe('ChatPanel rendering', () => {
  it('renders an ExitPlanMode plan as an expanded card with the markdown plan and the answer', async () => {
    await render()
    await resolveAt(0, [
      {
        role: 'assistant',
        parts: [
          { kind: 'tool', name: 'ToolSearch', arg: '' },
          {
            kind: 'tool',
            name: 'ExitPlanMode',
            arg: '',
            body: '# Fix the chat\n\n1. Parse **the plan**\n2. Render it',
            result: 'User approved the plan'
          }
        ]
      }
    ])
    const card = host.querySelector('.term-chat__tool-card') as HTMLElement
    expect(card).not.toBeNull()
    // Expanded, not a collapsed disclosure.
    expect(card.tagName).not.toBe('DETAILS')
    expect(card.closest('details')).toBeNull()
    expect(card.querySelector('.term-chat__tool-card-title')?.textContent).toBe('Plan')
    const md = card.querySelector('.term-chat__text') as HTMLElement
    expect(md.querySelector('h1')?.textContent).toBe('Fix the chat')
    expect(md.querySelector('strong')?.textContent).toBe('the plan')
    expect([...md.querySelectorAll('ol > li')].length).toBe(2)
    expect(card.querySelector('.term-chat__tool-result')?.textContent).toBe('User approved the plan')
    // A tool with no body is still today's collapsed chip.
    const chip = host.querySelector('details.term-chat__tool') as HTMLDetailsElement
    expect(chip.querySelector('.term-chat__tool-name')?.textContent).toBe('ToolSearch')
    expect(host.querySelectorAll('details.term-chat__tool').length).toBe(1)
  })

  it('renders an AskUserQuestion question with its options as an expanded "Question" card', async () => {
    await render()
    await resolveAt(0, [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            name: 'AskUserQuestion',
            arg: '',
            body: '**Database**\n\nWhich database?\n\n- **Postgres** — Relational\n- **SQLite**'
          }
        ]
      }
    ])
    const card = host.querySelector('.term-chat__tool-card') as HTMLElement
    expect(card.querySelector('.term-chat__tool-card-title')?.textContent).toBe('Question')
    const items = [...card.querySelectorAll('.term-chat__text li')].map((li) => li.textContent)
    expect(items).toEqual(['Postgres — Relational', 'SQLite'])
    expect(card.querySelector('.term-chat__tool-result')).toBeNull()
  })

  it('renders a thinking part as a collapsed "Thinking" disclosure, not as answer text', async () => {
    await render()
    await resolveAt(0, [{ role: 'assistant', parts: [{ kind: 'thinking', text: 'pondering' }, { kind: 'text', text: 'answer' }] }])
    const d = host.querySelector('details.term-chat__thinking') as HTMLDetailsElement
    expect(d).not.toBeNull()
    expect(d.open).toBe(false)
    expect(d.querySelector('summary')?.textContent).toBe('Thinking')
    expect(d.textContent).toContain('pondering')
    // The answer stays ordinary text, outside the disclosure.
    const answers = [...host.querySelectorAll('.term-chat__msg > .term-chat__text')].map((e) => e.textContent?.trim())
    expect(answers).toEqual(['answer'])
  })

  it('names the node agent in the composer, not Claude', async () => {
    await render({ agentId: 'grok' })
    await resolveAt(0, [])
    expect(textarea().placeholder).toMatch(/^Message Grok…/)
  })
})

describe('ChatPanel loading', () => {
  it('ignores an older transcript read that resolves after a newer one', async () => {
    await render({ sessionId: 's-old' })
    await render({ sessionId: 's-new' })
    expect(pending.map((p) => p.sessionId)).toEqual(['s-old', 's-new'])
    await resolveAt(1, [text('assistant', 'NEW')])
    await resolveAt(0, [text('assistant', 'OLD')])
    expect(msgs().textContent).toContain('NEW')
    expect(msgs().textContent).not.toContain('OLD')
  })

  it('the ↻ button in the bar reloads the transcript', async () => {
    await render()
    await resolveAt(0, [text('assistant', 'one')])
    const btn = host.querySelector('.term-chat__bar .term-chat__refresh') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => btn.click())
    expect(readTranscript).toHaveBeenCalledTimes(2)
    await resolveAt(1, [text('assistant', 'one'), text('assistant', 'two')])
    expect(msgs().textContent).toContain('two')
  })
})

describe('ChatPanel empty states', () => {
  // A read that FAILED (the host did not answer, a remote node with no reachable master) is not the
  // same sentence as "there is no transcript": one heals on retry, the other never will.
  it('an unreadable first read says it could not read the transcript', async () => {
    await render()
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    })
    expect(msgs().textContent).toContain("Couldn't read the transcript.")
    expect(msgs().textContent).toContain("The agent's host may not be reachable")
    expect(msgs().textContent).not.toContain('No transcript found')
    expect(host.querySelector('.term-chat__retry')).not.toBeNull()
  })

  it('an unreadable REMOTE grok read is a host failure like any other: it says so and offers Retry', async () => {
    // Grok has a remote reader now (core/remote-grok-chat.ts): `unreadable` means the HOST did not
    // answer, which a retry can heal — not "remote grok is unsupported", which it never could.
    await render({ agentId: 'grok' })
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    })
    expect(msgs().textContent).toContain("Couldn't read the transcript.")
    expect(msgs().textContent).not.toContain("isn't supported yet")
    expect(host.querySelector('.term-chat__retry')).not.toBeNull()
  })

  it('a grok session id that matches two host sessions says so, with NO Retry (a retry cannot fix it)', async () => {
    await render({ agentId: 'grok' })
    // Over Electron IPC only the message survives a rejection (the `code` is dropped), wrapped in
    // Electron's own prefix — the panel must recognise it from the message alone.
    await act(async () => {
      pending[0].reject(
        new Error(`Error invoking remote method 'chat:read-transcript': Error: ${GROK_AMBIGUOUS_SESSION_MESSAGE}`)
      )
    })
    expect(msgs().textContent).toContain(GROK_AMBIGUOUS_SESSION_MESSAGE)
    expect(msgs().textContent).not.toContain('may not be reachable')
    expect(msgs().textContent).not.toContain("can't be read on this surface")
    expect(host.querySelector('.term-chat__retry')).toBeNull()
  })

  it('an unreadable REMOTE gemini read names Gemini, not Grok, and offers no Retry', async () => {
    await render({ agentId: 'gemini' })
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    })
    expect(msgs().textContent).toContain("Reading a remote Gemini session's transcript isn't supported yet.")
    expect(msgs().textContent).not.toContain('Grok')
    expect(host.querySelector('.term-chat__retry')).toBeNull()
  })

  it('an unreadable REMOTE copilot read says so in copilot\'s own name, with no Retry', async () => {
    // Core's copilot leg is local-only too (core/copilot-chat.ts): its `unreadable` can only be the
    // remote refusal, which no retry heals.
    await render({ agentId: 'copilot' })
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    })
    expect(msgs().textContent).toContain("Reading a remote GitHub Copilot session's transcript isn't supported yet.")
    expect(msgs().textContent).not.toContain('Grok')
    expect(host.querySelector('.term-chat__retry')).toBeNull()
  })

  it('an unreadable opencode read names BOTH causes it can have, and keeps Retry', async () => {
    // opencode's reader sets `unreadable` for a local `opencode export` that failed (heals on retry)
    // AND for a remote node it refuses (never heals). No wire field tells them apart, so the copy
    // says both rather than guessing — and never blames an unreachable host for a local failure.
    await render({ agentId: 'opencode' })
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [], unreadable: true })
    })
    expect(msgs().textContent).toContain("Couldn't read this opencode session.")
    expect(msgs().textContent).toContain('opencode export')
    expect(msgs().textContent).toContain('remote host')
    expect(msgs().textContent).not.toContain("The agent's host may not be reachable")
    expect(host.querySelector('.term-chat__retry')).not.toBeNull()
  })

  it('a clean miss still says no transcript was found', async () => {
    await render()
    await act(async () => {
      pending[0].resolve({ messages: [], found: false, olderCursor: null, unmatchedResults: [] })
    })
    expect(msgs().textContent).toContain('No transcript found for this session.')
    expect(msgs().textContent).toContain("hasn't written one yet")
  })
})

describe('ChatPanel scroll-follow', () => {
  it('pins to the bottom on a load when the user was already at the bottom', async () => {
    await render()
    const el = msgs()
    geometry(el, { scrollHeight: 1000, clientHeight: 400 })
    await resolveAt(0, [text('assistant', 'a')])
    expect(el.scrollTop).toBe(1000)
  })

  it('keeps the position of a user who scrolled up to read history', async () => {
    await render()
    const el = msgs()
    geometry(el, { scrollHeight: 1000, clientHeight: 400 })
    await resolveAt(0, [text('assistant', 'a')])
    // User scrolls up, far past the threshold.
    await act(async () => {
      el.scrollTop = 100
      el.dispatchEvent(new Event('scroll'))
    })
    geometry(el, { scrollHeight: 1600, clientHeight: 400 })
    await act(async () => host.querySelector<HTMLButtonElement>('.term-chat__refresh')!.click())
    await resolveAt(1, [text('assistant', 'a'), text('assistant', 'b')])
    expect(el.scrollTop).toBe(100)
  })

  it('follows after the user sends, even when scrolled up', async () => {
    await render()
    const el = msgs()
    geometry(el, { scrollHeight: 1000, clientHeight: 400 })
    await resolveAt(0, [text('assistant', 'a')])
    await act(async () => {
      el.scrollTop = 100
      el.dispatchEvent(new Event('scroll'))
    })
    geometry(el, { scrollHeight: 1200, clientHeight: 400 })
    await act(async () => type(textarea(), 'go'))
    await act(async () => {
      key(textarea(), { key: 'Enter' })
    })
    expect(el.scrollTop).toBe(1200)
  })
})
