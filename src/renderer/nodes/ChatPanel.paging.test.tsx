// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import type { ChatTranscriptPageRequest } from '@shared/chat-page'
import { useAgentStatus } from '../state/agentStatus'
import { CHAT_OLDER_PAGE_BYTES, CHAT_TAIL_PAGE_BYTES } from '../lib/chatPaging'

/**
 * The ⌘M panel's progressive loading glue (the merge/attach/anchor decisions are unit-tested in
 * `lib/chatPaging.test.ts`): a small tail first, older pages on scroll-up with the scroll position
 * preserved, one older fetch at a time, a retryable failed older page, and a turn-end reload that
 * keeps the pages already loaded.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Pending {
  page: ChatTranscriptPageRequest | undefined
  resolve: (r: ChatTranscriptResult) => void
  reject: (e: unknown) => void
}

const { readTranscript, pending, session } = vi.hoisted(() => {
  const pending: Pending[] = []
  const readTranscript = vi.fn(
    (
      _s: string | undefined,
      _c: string | undefined,
      _a?: string,
      _n?: string,
      _g?: string,
      page?: ChatTranscriptPageRequest
    ) => new Promise<ChatTranscriptResult>((resolve, reject) => pending.push({ page, resolve, reject }))
  )
  const session = { api: { chat: { readTranscript }, pty: { sendText: vi.fn(async () => true as const) } } }
  return { readTranscript, pending, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'
import { ChatPanelFallback } from './ChatPanelFallback'

const NODE = 'n-chat-paging'
let host: HTMLDivElement
let root: Root

const say = (key: number, t: string): ChatMessage => ({ role: 'assistant', key, parts: [{ kind: 'text', text: t }] })
const msgs = (): HTMLDivElement => host.querySelector('.term-chat__msgs') as HTMLDivElement
const bubbles = (): string[] =>
  [...host.querySelectorAll('.term-chat__msg')].map((e) => e.textContent?.trim() ?? '')

/**
 * jsdom has no layout, so the scroller gets a tiny model of one: its height is DERIVED from what is
 * rendered (each bubble `perMsg` px, each top status row `ROW` px) — so a measurement taken before
 * a render really is the pre-render height — and scrollTop clamps like a browser's.
 */
const ROW = 30
const geo = { perMsg: 700, clientHeight: 400 }
const heightOf = (el: HTMLElement): number =>
  el.querySelectorAll('.term-chat__msg').length * geo.perMsg + el.querySelectorAll('.term-chat__older').length * ROW
function installGeometry(el: HTMLElement): void {
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => heightOf(el) })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, heightOf(el) - geo.clientHeight))
    }
  })
}

async function render(sessionId = 's1'): Promise<void> {
  const first = !host.querySelector('.term-chat__msgs')
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId={sessionId} agentId="claude" />)
  })
  if (first) installGeometry(msgs())
}

/** jsdom has no ResizeObserver; this one lets a test say "the panel's box changed". */
const observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe(): void {
    observers.push(this.cb)
  }
  unobserve(): void {}
  disconnect(): void {
    const i = observers.indexOf(this.cb)
    if (i >= 0) observers.splice(i, 1)
  }
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
async function resized(): Promise<void> {
  await act(async () => {
    for (const cb of [...observers]) cb()
  })
}
async function settle(i: number, r: Partial<ChatTranscriptResult>): Promise<void> {
  await act(async () => {
    pending[i].resolve({ messages: [], found: true, olderCursor: null, unmatchedResults: [], ...r })
  })
}
async function scrollTo(top: number): Promise<void> {
  await act(async () => {
    msgs().scrollTop = top
    msgs().dispatchEvent(new Event('scroll'))
  })
}

beforeEach(() => {
  readTranscript.mockClear()
  pending.length = 0
  observers.length = 0
  geo.perMsg = 700
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
})

describe('ChatPanel progressive loading', () => {
  it('shows a loading row while the first read is in flight', async () => {
    await render()
    const row = host.querySelector('.term-chat__status')
    expect(row?.textContent).toContain('Loading conversation…')
    expect(row?.getAttribute('role')).toBe('status')
    expect(row?.querySelector('.nt-spinner')).not.toBeNull()
    await settle(0, { messages: [say(100, 'hi')] })
    expect(host.querySelector('.term-chat__status')).toBeNull()
  })

  it('the initial loading row is the lazy fallback\'s row, identical DOM (no ring swap, no re-announced status)', async () => {
    const other = document.createElement('div')
    const otherRoot = createRoot(other)
    await act(async () => otherRoot.render(<ChatPanelFallback />))
    const fallbackRow = other.querySelector('.term-chat__msgs')!.innerHTML
    await act(async () => otherRoot.unmount())
    await render()
    expect(msgs().innerHTML).toBe(fallbackRow)
  })

  it('reads only a small tail window first', async () => {
    await render()
    expect(pending[0].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, thinking: true })
  })

  it('pages back on scroll-up, prepends, and keeps the viewport on the same content', async () => {
    await render()
    geo.perMsg = 1000
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    expect(msgs().scrollTop).toBe(600) // pinned to the bottom; far from the top → no fetch yet
    expect(pending).toHaveLength(1)

    await scrollTo(50)
    expect(pending).toHaveLength(2)
    expect(pending[1].page).toEqual({ before: 1000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
    expect(host.querySelector('.term-chat__older')?.textContent).toContain('Loading earlier messages…')
    // The app's one spinner, inside the row that is the status region.
    expect(host.querySelector('.term-chat__older[role="status"] .nt-spinner')).not.toBeNull()
    // The loading row appeared ABOVE the viewport: shifted by its height, not jumped.
    expect(msgs().scrollTop).toBe(50 + ROW)

    await settle(1, { messages: [say(0, 'first'), say(500, 'second')], olderCursor: null })
    expect(bubbles()).toEqual(['first', 'second', 'tail'])
    // Two bubbles added, the loading row replaced by the start marker (same height): the 'tail'
    // bubble sits exactly where it was under the viewport.
    expect(msgs().scrollTop).toBe(50 + ROW + 2 * 1000)
    expect(host.querySelector('.term-chat__older--start')?.textContent).toBe('Beginning of conversation')
  })

  it('keeps ONE older fetch in flight however many scroll events arrive', async () => {
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    await scrollTo(10)
    await scrollTo(5)
    await scrollTo(0)
    expect(pending).toHaveLength(2)
  })

  it('a failed older page keeps the thread and offers a retry — it is not a missing transcript', async () => {
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    await scrollTo(0)
    await settle(1, { found: false })
    expect(bubbles()).toEqual(['tail'])
    expect(host.textContent).not.toContain('No transcript found')
    const row = host.querySelector('.term-chat__older--error')!
    expect(row.textContent).toContain("Couldn't load earlier messages")
    // No automatic retry on the next scroll: the row owns it.
    await scrollTo(0)
    expect(pending).toHaveLength(2)
    await act(async () => row.querySelector('button')!.click())
    expect(pending).toHaveLength(3)
    expect(pending[2].page).toEqual({ before: 1000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
    await settle(2, { messages: [say(0, 'older')], olderCursor: null })
    expect(bubbles()).toEqual(['older', 'tail'])
  })

  it('an older page that lands after a newer tail reload is dropped', async () => {
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    await scrollTo(0)
    await act(async () => host.querySelector<HTMLButtonElement>('.term-chat__refresh')!.click())
    await settle(1, { messages: [say(0, 'STALE OLDER')], olderCursor: null })
    expect(bubbles()).not.toContain('STALE OLDER')
  })

  it('a turn-end reload re-reads only the tail and keeps the older pages already loaded', async () => {
    useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'working' } as never } }))
    await render()
    await settle(0, { messages: [say(1000, 'm1000')], olderCursor: 1000 })
    await scrollTo(0)
    await settle(1, { messages: [say(0, 'm0')], olderCursor: null })
    expect(bubbles()).toEqual(['m0', 'm1000'])

    await act(async () => {
      useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'done' } as never } }))
    })
    expect(pending).toHaveLength(3)
    expect(pending[2].page).toEqual({ maxBytes: CHAT_TAIL_PAGE_BYTES, thinking: true })
    await settle(2, { messages: [say(1000, 'm1000'), say(2000, 'm2000')], olderCursor: 1000 })
    expect(bubbles()).toEqual(['m0', 'm1000', 'm2000'])
  })

  it('a reload that fails to resolve does not blank a rendered thread', async () => {
    await render()
    await settle(0, { messages: [say(1000, 'kept')], olderCursor: null })
    await act(async () => host.querySelector<HTMLButtonElement>('.term-chat__refresh')!.click())
    await settle(1, { found: false })
    expect(bubbles()).toEqual(['kept'])
    expect(host.textContent).not.toContain('No transcript found')
  })

  it('the FIRST read that finds nothing still says the transcript is missing', async () => {
    await render()
    await settle(0, { found: false })
    expect(host.textContent).toContain('No transcript found for this session.')
  })

  it('a thread shorter than the viewport pages back on its own (it cannot scroll)', async () => {
    geo.perMsg = 100 // one bubble is shorter than the 400px viewport: scrollTop stays 0
    await render()
    await settle(0, { messages: [say(1000, 'short')], olderCursor: 1000 })
    expect(pending).toHaveLength(2)
    expect(pending[1].page).toEqual({ before: 1000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
  })

  it('a HIDDEN panel (collapsed node, display:none: every metric 0) never pages in the background', async () => {
    geo.perMsg = 0
    geo.clientHeight = 0
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    expect(pending).toHaveLength(1)
    await scrollTo(0)
    expect(pending).toHaveLength(1)

    // Expanded: the box gets a size. The view lands at the bottom, far from the top — no fetch.
    geo.perMsg = 1000
    geo.clientHeight = 400
    await resized()
    expect(msgs().scrollTop).toBe(600)
    expect(pending).toHaveLength(1)
    // …and paging works normally from there.
    await scrollTo(0)
    expect(pending).toHaveLength(2)
  })

  it('a panel revealed with a SHORT thread pages back as soon as it has a size', async () => {
    geo.perMsg = 0
    geo.clientHeight = 0
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    expect(pending).toHaveLength(1)
    geo.perMsg = 100
    geo.clientHeight = 400
    await resized()
    expect(pending).toHaveLength(2)
  })

  it('paging survives a rejected reload followed by a reload that finds nothing', async () => {
    geo.perMsg = 1000
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    const refresh = () => host.querySelector<HTMLButtonElement>('.term-chat__refresh')!.click()
    await act(async () => refresh())
    await act(async () => pending[1].reject(new Error('socket blip')))
    await act(async () => refresh())
    await settle(2, { found: false })
    expect(bubbles()).toEqual(['tail'])
    await scrollTo(0)
    expect(pending).toHaveLength(4)
    expect(pending[3].page).toEqual({ before: 1000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
  })

  it('switching session while an older page is in flight drops that page and starts clean', async () => {
    geo.perMsg = 1000
    await render('s1')
    await settle(0, { messages: [say(1000, 'OLD tail')], olderCursor: 1000 })
    await scrollTo(0)
    expect(pending).toHaveLength(2)
    await render('s2')
    expect(pending).toHaveLength(3)
    await settle(1, { messages: [say(0, 'OLD older')], olderCursor: null })
    await settle(2, { messages: [say(1000, 'NEW tail')], olderCursor: null })
    expect(bubbles()).toEqual(['NEW tail'])
  })

  it('a reload that cancels an in-flight older fetch removes its row WITHOUT a jump', async () => {
    geo.perMsg = 1000
    await render()
    await settle(0, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    await scrollTo(50)
    expect(msgs().scrollTop).toBe(50 + ROW) // the loading row appeared above
    await act(async () => host.querySelector<HTMLButtonElement>('.term-chat__refresh')!.click())
    expect(host.querySelector('.term-chat__older')).toBeNull()
    expect(msgs().scrollTop).toBe(50) // and went away again: same content under the viewport
    // Paging waits for the tail, then resumes (the user is still at the top).
    expect(pending).toHaveLength(3)
    await settle(2, { messages: [say(1000, 'tail')], olderCursor: 1000 })
    expect(pending).toHaveLength(4)
    expect(pending[3].page).toEqual({ before: 1000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
  })
  // A tail window can hold no message at all and still have history behind it (its records were
  // all metadata, or — before core grew such windows — one line bigger than the page). That is
  // "still loading", never "No conversation yet.": the panel pages back by itself from there.
  it('an EMPTY tail with history behind it shows the loading row, not the empty state', async () => {
    await render()
    await settle(0, { messages: [], olderCursor: 5000 })
    expect(host.textContent).not.toContain('No conversation yet.')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading conversation…')
    expect(pending).toHaveLength(2) // it paged back on its own
    expect(pending[1].page).toEqual({ before: 5000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
    await settle(1, { messages: [say(0, 'older')], olderCursor: null })
    expect(bubbles()).toEqual(['older'])
    expect(host.textContent).not.toContain('Loading conversation…')
  })

  it('an empty tail whose older page FAILS offers the retry row, not an empty conversation', async () => {
    await render()
    await settle(0, { messages: [], olderCursor: 5000 })
    await act(async () => pending[1].reject(new Error('host blip')))
    expect(host.textContent).not.toContain('No conversation yet.')
    expect(host.textContent).toContain("Couldn't load earlier messages.")
    await act(async () => host.querySelector<HTMLButtonElement>('.term-chat__older .term-chat__retry')!.click())
    expect(pending).toHaveLength(3)
    expect(pending[2].page).toEqual({ before: 5000, maxBytes: CHAT_OLDER_PAGE_BYTES, thinking: true })
  })

  it('switching session to one whose read REJECTS clears the previous session\'s thread', async () => {
    await render('s1')
    await settle(0, { messages: [say(1000, 'OLD session')], olderCursor: null })
    await render('s2')
    await act(async () => pending[1].reject(new Error('boom')))
    expect(bubbles()).toEqual([])
    expect(host.textContent).toContain("Couldn't read the transcript.")
  })
})

describe('ChatPanel Page Up / Page Down', () => {
  const press = async (target: Element, key: string): Promise<KeyboardEvent> => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => {
      target.dispatchEvent(e)
    })
    return e
  }
  const composer = (): HTMLTextAreaElement =>
    host.querySelector('.term-chat__composer-input') as HTMLTextAreaElement

  it('pages the thread from the composer', async () => {
    await render()
    await settle(0, { messages: [say(0, 'a'), say(10, 'b'), say(20, 'c')] })
    const bottom = msgs().scrollTop

    const up = await press(composer(), 'PageUp')

    expect(up.defaultPrevented).toBe(true)
    expect(msgs().scrollTop).toBe(bottom - 350)

    await press(composer(), 'PageDown')

    expect(msgs().scrollTop).toBe(bottom)
  })

  it('leaves Shift+Page Up to the composer (selection), without scrolling the thread', async () => {
    await render()
    await settle(0, { messages: [say(0, 'a'), say(10, 'b'), say(20, 'c')] })
    const bottom = msgs().scrollTop
    const e = new KeyboardEvent('keydown', { key: 'PageUp', shiftKey: true, bubbles: true, cancelable: true })

    await act(async () => {
      composer().dispatchEvent(e)
    })

    expect(e.defaultPrevented).toBe(false)
    expect(msgs().scrollTop).toBe(bottom)
  })
})
