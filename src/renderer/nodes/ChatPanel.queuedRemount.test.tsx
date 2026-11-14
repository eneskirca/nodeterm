// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatTranscriptResult } from '@shared/types'
import { useAgentStatus } from '../state/agentStatus'
import { clearQueuedSendsForTest } from '../state/chatQueued'

/**
 * A prompt queued into the CLI mid-turn is not in the transcript until the CLI delivers it, so a
 * panel remounted by a project switch must draw it again from `state/chatQueued.ts`. Pins the
 * remount: the bubble comes back while the transcript lacks it, and goes once the transcript has it.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { transcript, session } = vi.hoisted(() => {
  const transcript: { messages: ChatMessage[] } = { messages: [] }
  const session = {
    api: {
      chat: {
        readTranscript: async (): Promise<ChatTranscriptResult> => ({
          messages: transcript.messages,
          found: true,
          olderCursor: null
        })
      },
      // The send gate probes the pane's foreground process for every agent, so the fake pane is
      // a live claude; without it the gate refuses the send as `unverified`.
      pty: {
        sendChatPrompt: vi.fn(async () => true as const),
        paneOwner: async () => ({ panePid: 1, tty: '/dev/ttys001', command: 'claude', argv: ['claude'], pids: [2] })
      }
    }
  }
  return { transcript, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-queued-remount'
let host: HTMLDivElement
let root: Root

const say = (key: number, text: string, role: 'user' | 'assistant'): ChatMessage => ({
  role,
  key,
  parts: [{ kind: 'text', text }]
})

async function mount(): Promise<HTMLTextAreaElement> {
  root = createRoot(host)
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
  return host.querySelector('textarea') as HTMLTextAreaElement
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount())
}

async function queue(ta: HTMLTextAreaElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

const queuedTexts = (): string[] =>
  [...host.querySelectorAll('.term-chat__msg--queued')].map((el) => el.textContent ?? '')

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  clearQueuedSendsForTest()
  useAgentStatus.setState((s) => ({
    byId: { ...s.byId, [NODE]: { state: 'working' } as (typeof s.byId)[string] }
  }))
})

afterEach(async () => {
  await unmount()
  host.remove()
  transcript.messages = []
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

describe('ChatPanel queued sends across a remount', () => {
  it('draws a queued send again after a remount while the transcript does not have it', async () => {
    transcript.messages = [say(100, 'start', 'user'), say(200, 'working on it', 'assistant')]
    await queue(await mount(), 'and then this')
    await unmount()

    await mount()

    expect(queuedTexts()).toEqual([expect.stringContaining('and then this')])
  })

  it('does not draw it again once the transcript has it', async () => {
    transcript.messages = [say(100, 'start', 'user'), say(200, 'working on it', 'assistant')]
    await queue(await mount(), 'and then this')
    await unmount()
    transcript.messages = [...transcript.messages, say(300, 'and then this', 'user')]

    await mount()

    expect(queuedTexts()).toEqual([])
    expect(host.textContent?.split('and then this').length).toBe(2)
  })

  it('an identical message from before the send does not count as it', async () => {
    transcript.messages = [say(100, 'yes', 'user'), say(200, 'working on it', 'assistant')]
    await queue(await mount(), 'yes')
    await unmount()

    await mount()

    expect(queuedTexts()).toEqual([expect.stringContaining('yes')])
  })

  it('is not drawn again, and is forgotten, when the agent is no longer working', async () => {
    transcript.messages = [say(100, 'start', 'user')]
    await queue(await mount(), 'next')
    await unmount()
    useAgentStatus.setState((st) => ({
      byId: { ...st.byId, [NODE]: { state: 'done' } as (typeof st.byId)[string] }
    }))
    await mount()
    await unmount()
    useAgentStatus.setState((st) => ({
      byId: { ...st.byId, [NODE]: { state: 'working' } as (typeof st.byId)[string] }
    }))

    await mount()

    expect(queuedTexts()).toEqual([])
  })

  it('is forgotten once confirmed, so a later remount does not bring it back', async () => {
    transcript.messages = [say(100, 'start', 'user')]
    await queue(await mount(), 'next')
    await unmount()
    transcript.messages = [...transcript.messages, say(200, 'next', 'user')]
    await mount()
    await unmount()
    transcript.messages = [say(100, 'start', 'user')]

    await mount()

    expect(queuedTexts()).toEqual([])
  })
})
