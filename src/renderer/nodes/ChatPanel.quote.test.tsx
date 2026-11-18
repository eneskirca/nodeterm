// @vitest-environment jsdom
//
// "Add to chat" in the ⌘M thread, through the real panel and the real default deps: a selection in
// the thread lands in THIS node's draft as a quote, a read-only panel says so on its root (so a
// quote for its node does not count it as an open chat view), `quoteTargetNodeId={null}` offers no
// button, and a subagent card's quote that lands in the parent's pane says so.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { useChatDraft } from '../state/chatDraft'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { session } = vi.hoisted(() => {
  const messages = [
    { role: 'user', parts: [{ kind: 'text', text: 'fix it' }], key: 0 },
    { role: 'assistant', parts: [{ kind: 'text', text: 'The cache is stale.' }], key: 10 }
  ]
  const session = {
    api: {
      chat: {
        readTranscript: async () => ({ messages, found: true, olderCursor: null, unmatchedResults: [] })
      },
      pty: {
        sendText: vi.fn(async () => true as const),
        readChatScreen: vi.fn(async () => ({ screen: { kind: 'prompt' }, suggestion: null })),
        paneOwner: vi.fn(async () => ({ panePid: 100, tty: '/dev/pts/31', command: 'claude', argv: ['claude'], pids: [201600] }))
      }
    }
  }
  return { session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-quote'
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  session.api.pty.sendText.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { clipboard: { writeText: vi.fn() } }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  document.getSelection()?.removeAllRanges()
  await act(async () => root.unmount())
  host.remove()
  useChatDraft.getState().setDraft(NODE, '')
})

async function mount(props: Partial<Parameters<typeof ChatPanel>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" {...props} />)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Select the whole text of the first element under the thread matching `text`. */
async function selectInThread(text: string): Promise<void> {
  const msgs = host.querySelector('.term-chat__msgs')!
  const el = [...msgs.querySelectorAll('p')].find((p) => p.textContent === text)!
  await act(async () => {
    const range = document.createRange()
    range.selectNodeContents(el)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    await new Promise((r) => setTimeout(r, 0))
  })
}

const quoteButton = (): HTMLButtonElement | null => document.body.querySelector('.chat-quote-btn')

describe('ChatPanel — Add to chat', () => {
  it("adds a selection in the thread to this node's draft, and types nothing", async () => {
    await mount()
    expect(host.querySelector('.term-chat')!.hasAttribute('data-chat-readonly')).toBe(false)
    await selectInThread('The cache is stale.')
    expect(quoteButton()?.getAttribute('data-quote-target')).toBe(NODE)
    await act(async () => {
      quoteButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(useChatDraft.getState().drafts[NODE]).toBe('> The cache is stale.\n\n')
    expect(session.api.pty.sendText).not.toHaveBeenCalled()
  })

  it('marks a read-only panel, and still offers the button there', async () => {
    await mount({ readOnly: true })
    expect(host.querySelector('.term-chat')!.hasAttribute('data-chat-readonly')).toBe(true)
    await selectInThread('The cache is stale.')
    expect(quoteButton()).not.toBeNull()
  })

  it("says where a subagent card's quote went once it lands in the parent's pane", async () => {
    // A subagent card mounts the panel with the PARENT's node id and quotes to the parent; the
    // person is looking at the card, so a landed pane write gets an info toast.
    const toasts: unknown[] = []
    const on = (e: Event): void => {
      toasts.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeterm:toast', on)
    try {
      await mount({ subagent: { agentId: 'a0123456789abcdef' }, quoteTargetNodeId: NODE })
      await selectInThread('The cache is stale.')
      await act(async () => {
        quoteButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(session.api.pty.sendText).toHaveBeenCalledWith(NODE, '> The cache is stale.', { enter: false })
      expect(toasts).toEqual([{ kind: 'info', message: "Added to the agent's terminal." }])
    } finally {
      window.removeEventListener('nodeterm:toast', on)
    }
  })

  it("says nothing extra for a quote into the panel's own node's pane", async () => {
    const toasts: unknown[] = []
    const on = (e: Event): void => {
      toasts.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeterm:toast', on)
    try {
      await mount({ readOnly: true })
      await selectInThread('The cache is stale.')
      await act(async () => {
        quoteButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 0))
      })
      expect(session.api.pty.sendText).toHaveBeenCalledTimes(1)
      expect(toasts).toEqual([])
    } finally {
      window.removeEventListener('nodeterm:toast', on)
    }
  })

  it('offers no button when told there is nowhere to quote to', async () => {
    await mount({ readOnly: true, quoteTargetNodeId: null })
    await selectInThread('The cache is stale.')
    expect(quoteButton()).toBeNull()
  })
})
