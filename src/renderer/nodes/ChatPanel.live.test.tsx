// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import type { ChatTranscriptPageRequest } from '@shared/chat-page'
import { useAgentStatus } from '../state/agentStatus'
import { CHAT_TAIL_PAGE_BYTES } from '../lib/chatPaging'
import { CHAT_LIVE_RELOAD_MIN_MS, CHAT_OPTIMISTIC_WORKING_MS, TURN_END_RELOAD_DELAYS_MS } from '../lib/chatLive'

/**
 * The ⌘M panel's live progress glue (the decisions are unit-tested in `lib/chatLive.test.ts`): a
 * working row at the end of the thread (optimistic right after a send), and a throttled,
 * single-flight tail refresh on every hook event while the agent works — never for a hidden panel.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Pending {
  page: ChatTranscriptPageRequest | undefined
  resolve: (r: ChatTranscriptResult) => void
  reject: (e: unknown) => void
}

const { pending, session, sendChatPrompt } = vi.hoisted(() => {
  const pending: Pending[] = []
  const readTranscript = (
    _s: string | undefined,
    _c: string | undefined,
    _a?: string,
    _n?: string,
    _g?: string,
    page?: ChatTranscriptPageRequest
  ) => new Promise<ChatTranscriptResult>((resolve, reject) => pending.push({ page, resolve, reject }))
  const sendChatPrompt = vi.fn(async (_id: string, _t: string, _agent: string) => true as const)
  const session = { api: { chat: { readTranscript }, pty: { sendChatPrompt } } }
  return { pending, session, sendChatPrompt }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-live'
let host: HTMLDivElement
let root: Root
const geo = { clientHeight: 400 }

const say = (key: number, t: string): ChatMessage => ({ role: 'assistant', key, parts: [{ kind: 'text', text: t }] })
const bubbles = (): string[] => [...host.querySelectorAll('.term-chat__msg')].map((e) => e.textContent?.trim() ?? '')
const activity = (): HTMLElement | null => host.querySelector('.term-chat__activity')

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
  const el = host.querySelector('.term-chat__msgs') as HTMLDivElement
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 10_000 })
}
async function settle(i: number, r: Partial<ChatTranscriptResult>): Promise<void> {
  await act(async () => {
    pending[i].resolve({ messages: [], found: true, olderCursor: null, unmatchedResults: [], ...r })
  })
}
async function hook(state: 'working' | 'waiting' | 'blocked' | 'done' | undefined, newTurn = false): Promise<void> {
  await act(async () => {
    useAgentStatus.getState().setState(NODE, state, 'claude', newTurn)
  })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  sendChatPrompt.mockClear()
  geo.clientHeight = 400
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
  vi.useRealTimers()
})

describe('ChatPanel live progress', () => {
  it('a send shows the working row at once, before any hook event — and the working state keeps it', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')] })
    expect(activity()).toBeNull()
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'do it')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(sendChatPrompt).toHaveBeenCalledOnce()
    const row = activity()!
    expect(row.textContent).toBe('Claude Code is working…')
    expect(row.getAttribute('role')).toBe('status')
    expect(row.getAttribute('aria-live')).toBe('polite')
    expect(row.querySelector('.nt-spinner')).not.toBeNull()
    // The row sits at the END of the thread, after the optimistic prompt bubble.
    expect(host.querySelector('.term-chat__msgs')!.lastElementChild).toBe(row)
    await hook('working', true)
    expect(activity()?.textContent).toBe('Claude Code is working…')
  })

  it('an optimistic row with no working event behind it clears after a bounded timeout', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')] })
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'x')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(activity()).not.toBeNull()
    await advance(CHAT_OPTIMISTIC_WORKING_MS)
    expect(activity()).toBeNull()
  })

  it('hook events while working drive throttled, single-flight tail reloads that append', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')], olderCursor: null })
    expect(activity()?.querySelector('.nt-spinner')).not.toBeNull()

    // First event: nothing ran for a while? The initial read just started — so it waits the rest.
    await hook('working')
    expect(pending).toHaveLength(1)
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending).toHaveLength(2)
    expect(pending[1].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, background: true })

    // A burst while that read is in flight: held, never overlapped…
    await hook('working')
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending).toHaveLength(2)
    await settle(1, { messages: [say(0, 'q'), say(100, 'part 1')], olderCursor: null })
    expect(bubbles()).toEqual(['q', 'part 1'])
    // …and served by ONE trailing read once it settles (the interval had already elapsed).
    expect(pending).toHaveLength(3)
    await settle(2, { messages: [say(0, 'q'), say(100, 'part 1'), say(200, 'part 2')], olderCursor: null })
    expect(bubbles()).toEqual(['q', 'part 1', 'part 2'])
    // The row stays at the end, under the new message.
    expect(host.querySelector('.term-chat__msgs')!.lastElementChild).toBe(activity())
    // Nothing pending: no further reads.
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending).toHaveLength(3)
  })

  it('a live reload never cancels an older page the user is scrolling back to — it waits for it', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    // Scroll to the top: an older page is requested.
    const el = host.querySelector('.term-chat__msgs') as HTMLDivElement
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: () => {} })
    await act(async () => {
      el.dispatchEvent(new Event('scroll'))
    })
    expect(pending).toHaveLength(2)
    expect(pending[1].page).toMatchObject({ before: 1000 })
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending).toHaveLength(2) // held behind the older page
    await settle(1, { messages: [say(0, 'older')], olderCursor: null })
    expect(bubbles()).toEqual(['older', 'tail'])
    expect(pending).toHaveLength(3) // …then served once it landed
    expect(pending[2].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, background: true })
  })

  it('the live read the send itself triggers does not erase the prompt the transcript lacks yet', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 2) // the initial read is long past: the next one runs at once
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'do it')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(bubbles()).toEqual(['hello', 'do it'])
    await hook('working', true) // UserPromptSubmit
    expect(pending).toHaveLength(2)
    // The agent has not written the prompt line yet.
    await settle(1, { messages: [say(0, 'hello')], olderCursor: 0 })
    expect(bubbles()).toEqual(['hello', 'do it'])
    // Once it has, exactly one copy — the transcript's.
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    await settle(2, {
      messages: [say(0, 'hello'), { role: 'user', key: 50, parts: [{ kind: 'text', text: 'do it' }] }],
      olderCursor: 0
    })
    expect(bubbles()).toEqual(['hello', 'do it'])
    expect(host.querySelectorAll('.term-chat__msg--user')).toHaveLength(1)
  })

  it('a live read leaves a failed older page\'s retry row alone', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    const el = host.querySelector('.term-chat__msgs') as HTMLDivElement
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 0, set: () => {} })
    await act(async () => {
      el.dispatchEvent(new Event('scroll'))
    })
    await act(async () => pending[1].reject(new Error('host blip')))
    expect(host.querySelector('.term-chat__older--error')).not.toBeNull()
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending).toHaveLength(3)
    expect(pending[2].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, background: true })
    expect(host.querySelector('.term-chat__older--error')).not.toBeNull()
    await settle(2, { messages: [say(1000, 'tail'), say(2000, 'more')], olderCursor: 1000 })
    expect(host.querySelector('.term-chat__older--error')).not.toBeNull()
    expect(pending).toHaveLength(3) // no re-armed older fetch
  })

  it('a live read never flips an empty state to "Loading conversation…"', async () => {
    await hook('working', true)
    await render()
    await settle(0, { found: false })
    expect(host.textContent).toContain('No transcript found')
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending).toHaveLength(2)
    expect(host.textContent).not.toContain('Loading conversation…')
    expect(host.textContent).toContain('No transcript found')
  })

  it('a surface that cannot read transcripts takes no live reads', async () => {
    await hook('working', true)
    await render()
    await act(async () => pending[0].reject(Object.assign(new Error('nope'), { code: 'E_UNSUPPORTED' })))
    expect(host.textContent).toContain("Transcripts can't be read on this surface.")
    await hook('working')
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending).toHaveLength(1)
  })

  it('done clears the row, takes a read at once and the settle reloads — then stops', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    expect(activity()).not.toBeNull()
    await hook('done')
    expect(activity()).toBeNull()
    expect(pending).toHaveLength(2)
    await settle(1, { messages: [say(0, 'q'), say(100, 'answer')] })
    expect(bubbles()).toEqual(['q', 'answer'])

    await advance(TURN_END_RELOAD_DELAYS_MS[TURN_END_RELOAD_DELAYS_MS.length - 1])
    expect(pending).toHaveLength(2 + TURN_END_RELOAD_DELAYS_MS.length)
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)

    expect(pending).toHaveLength(2 + TURN_END_RELOAD_DELAYS_MS.length)
  })

  it('shows a reply written AFTER the Stop hook without reopening the view', async () => {
    // Claude Code fires Stop ~50 ms before it appends the final reply, so the read at `done` misses
    // it; the first settle reload is what finds it.
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    await hook('done')
    await settle(1, { messages: [say(0, 'q')] })
    expect(bubbles()).toEqual(['q'])

    await advance(TURN_END_RELOAD_DELAYS_MS[0])
    await settle(2, { messages: [say(0, 'q'), say(100, 'the reply')] })

    expect(bubbles()).toEqual(['q', 'the reply'])
  })

  it('a new turn does not cancel the settle reloads of the one that just ended', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    await hook('done')
    await settle(1, { messages: [say(0, 'q')] })
    // The next prompt starts a turn right away.
    await hook('working', true)

    await advance(TURN_END_RELOAD_DELAYS_MS[0])
    await settle(pending.length - 1, { messages: [say(0, 'q'), say(100, 'first reply')] })

    expect(bubbles()).toContain('first reply')
  })

  it('a prompt sent as the turn ends is kept until the last settle read, which drops it if it never landed', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    await hook('done')
    await settle(1, { messages: [say(0, 'q'), say(100, 'a')] })
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'never landed')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await advance(TURN_END_RELOAD_DELAYS_MS[0])
    await settle(pending.length - 1, { messages: [say(0, 'q'), say(100, 'a')] })
    expect(bubbles()).toContain('never landed')

    await advance(TURN_END_RELOAD_DELAYS_MS[TURN_END_RELOAD_DELAYS_MS.length - 1])
    await settle(pending.length - 1, { messages: [say(0, 'q'), say(100, 'a')] })

    expect(bubbles()).not.toContain('never landed')
  })

  it('unmounting cancels the settle reloads', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    await hook('done')
    await act(async () => root.unmount())
    root = createRoot(host)

    await advance(TURN_END_RELOAD_DELAYS_MS[TURN_END_RELOAD_DELAYS_MS.length - 1])

    expect(pending).toHaveLength(2)
  })

  it('a dialog state says the agent is waiting for an answer, with no spinner', async () => {
    await hook('working', true)
    await render()
    await settle(0, { messages: [say(0, 'q')] })
    await hook('waiting')
    const row = activity()!
    expect(row.textContent).toContain('Claude Code is waiting for an answer in the terminal')
    expect(row.querySelector('.nt-spinner')).toBeNull()
    // It is the composer placeholder's own sentence, not a second copy.
    expect(row.textContent).toBe(host.querySelector('textarea')!.getAttribute('placeholder'))
  })

  it('a HIDDEN panel takes no live reloads — and catches up once when it gets a box', async () => {
    const observers: Array<() => void> = []
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(private cb: () => void) {}
      observe(): void {
        observers.push(this.cb)
      }
      disconnect(): void {}
    }
    try {
      geo.clientHeight = 0
      await hook('working', true)
      await render()
      await settle(0, { messages: [say(0, 'q')] })
      await hook('working')
      await hook('working')
      await advance(CHAT_LIVE_RELOAD_MIN_MS * 5)
      expect(pending).toHaveLength(1)
      geo.clientHeight = 400
      await act(async () => {
        for (const cb of observers) cb()
      })
      expect(pending).toHaveLength(2)
    } finally {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    }
  })

  it('a hidden DOCUMENT takes no live reloads', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    try {
      await hook('working', true)
      await render()
      await settle(0, { messages: [say(0, 'q')] })
      await hook('working')
      await advance(CHAT_LIVE_RELOAD_MIN_MS * 5)
      expect(pending).toHaveLength(1)
      hidden.mockReturnValue(false)
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(pending).toHaveLength(2)
    } finally {
      hidden.mockRestore()
    }
  })
})

// A local command (`/model`, `!ls`) fires NO hook: the state never changes, so nothing would retire
// the optimistic working row but its 15 s timeout, and no live read runs (the agent is not working).
// A command send therefore schedules ONE tail read, and a read that confirms the send retires the row.
describe('ChatPanel — a sent local command', () => {
  const cmd = (key: number, name: string, arg = ''): ChatMessage => ({
    role: 'assistant',
    key,
    parts: [{ kind: 'tool', name, arg }]
  })
  async function type(text: string): Promise<void> {
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('/model: one tail read after the throttle interval confirms it and retires the working row', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/model')
    expect(activity()).not.toBeNull()
    await advance(CHAT_LIVE_RELOAD_MIN_MS - 1)
    expect(pending.length).toBe(1)
    await advance(1)
    expect(pending.length).toBe(2)
    expect(pending[1].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, background: true })
    await settle(1, { messages: [say(0, 'hello'), cmd(100, '/model')], olderCursor: 0 })
    expect(activity()).toBeNull()
    // Exactly one read: nothing else is scheduled.
    await advance(CHAT_OPTIMISTIC_WORKING_MS)
    expect(pending.length).toBe(2)
  })

  it('`!ls` is a command send too', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('!ls')
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending.length).toBe(2)
    await settle(1, { messages: [say(0, 'hello'), cmd(100, '!', 'ls')], olderCursor: 0 })
    expect(activity()).toBeNull()
  })

  it('a read that does NOT confirm the command leaves the row to its timeout', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/model')
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    await settle(1, { messages: [say(0, 'hello')], olderCursor: 0 })
    expect(activity()).not.toBeNull()
    // A LIVE read: the unconfirmed send stays on screen (a non-live read would drop it).
    expect(bubbles().some((b) => b.includes('/model'))).toBe(true)
  })

  it('a command that starts a real turn (/compact) keeps the working row through its working state', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/compact keep notes')
    await hook('working', true)
    // Settle every read (the hook's live read and the command read), each confirming the command.
    for (let i = 0; i < 4; i++) {
      await advance(CHAT_LIVE_RELOAD_MIN_MS)
      for (let j = 1; j < pending.length; j++)
        await settle(j, { messages: [say(0, 'hello'), cmd(100, '/compact', 'keep notes')], olderCursor: 0 })
    }
    expect(pending.length).toBeGreaterThan(1)
    expect(activity()?.textContent).toBe('Claude Code is working…')
    // The draft stays editable while the turn runs; for claude, Enter queues (chatSendMode).
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.disabled).toBe(false)
    expect(ta.placeholder).toBe('Claude Code is working — Enter queues your message')
  })

  it('a tail read already in flight defers the command read instead of cancelling it', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/model')
    await act(async () => (host.querySelector('.term-chat__bar .term-chat__refresh') as HTMLButtonElement).click())
    expect(pending.length).toBe(2) // ↻, in flight
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending.length).toBe(2) // deferred, not started over it
    await settle(1, { messages: [say(0, 'hello')], olderCursor: 0 })
    await advance(CHAT_LIVE_RELOAD_MIN_MS)
    expect(pending.length).toBe(3)
  })

  it('a plain text send schedules no read', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('just a question')
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending.length).toBe(1)
  })

  it('the scheduled read is cancelled on unmount', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/model')
    await act(async () => root.unmount())
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending.length).toBe(1)
    root = createRoot(host) // afterEach unmounts again
  })

  it('the scheduled read is cancelled when the transcript identity changes', async () => {
    await hook('done')
    await render()
    await settle(0, { messages: [say(0, 'hello')], olderCursor: 0 })
    await type('/model')
    await act(async () => {
      root.render(<ChatPanel nodeId={NODE} sessionId="s2" agentId="claude" />)
    })
    const after = pending.length // the new session's own initial read
    await advance(CHAT_LIVE_RELOAD_MIN_MS * 3)
    expect(pending.length).toBe(after)
  })
})

describe('ChatPanel — a sent built-in that opens a dialog in the TUI', () => {
  async function renderWith(onShowTerminal: () => void): Promise<void> {
    await act(async () => {
      root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" onShowTerminal={onShowTerminal} />)
    })
  }
  async function send(text: string): Promise<void> {
    const ta = host.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('/rewind is sent, THEN the view flips to the terminal (the dialog is there, and the next Enter would answer it)', async () => {
    const onShowTerminal = vi.fn(() => {
      // The flip happens only after the pane accepted the text.
      expect(sendChatPrompt).toHaveBeenCalledWith(NODE, '/rewind', 'claude')
    })
    await hook('done')
    await renderWith(onShowTerminal)
    await settle(0, { messages: [say(0, 'hello')] })
    await send('/rewind')
    expect(onShowTerminal).toHaveBeenCalledOnce()
  })

  it('a built-in that runs with no dialog (/compact) and a plain message stay in the view', async () => {
    const onShowTerminal = vi.fn()
    await hook('done')
    await renderWith(onShowTerminal)
    await settle(0, { messages: [say(0, 'hello')] })
    await send('/compact')
    await send('please rewind the file')
    expect(sendChatPrompt).toHaveBeenCalledTimes(2)
    expect(onShowTerminal).not.toHaveBeenCalled()
  })

  it('a refused send (pane not writable) never flips', async () => {
    const onShowTerminal = vi.fn()
    sendChatPrompt.mockResolvedValueOnce(false as never)
    await hook('done')
    await renderWith(onShowTerminal)
    await settle(0, { messages: [say(0, 'hello')] })
    await send('/model')
    expect(onShowTerminal).not.toHaveBeenCalled()
  })
})
