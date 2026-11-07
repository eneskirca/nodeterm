// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useChatDraft } from '../state/chatDraft'
import type { ChatInterruptResult } from '@shared/text-delivery'

/**
 * Esc in the ⌘M chat view interrupts a working agent (lib/chatEscInterrupt.ts holds the rule). This
 * file pins the GLUE: the keypress reaches core with the panel's last send, a prompt core took back
 * out of the agent's input box lands in the composer, and a refusal is said out loud.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { interruptChat, readTranscript, sendChatPrompt, session } = vi.hoisted(() => {
  const readTranscript = vi.fn(async (): Promise<{ messages: unknown[]; found: boolean }> => ({ messages: [], found: true }))
  const interruptChat = vi.fn(
    async (_id: string, _agent: string, _sent?: string): Promise<ChatInterruptResult> => ({ sent: true, restored: null })
  )
  const sendChatPrompt = vi.fn(async (_id: string, _text: string, _agent: string) => true as const)
  const session = {
    api: {
      chat: { readTranscript },
      pty: { interruptChat, sendChatPrompt, paneOwner: async () => null }
    }
  }
  return { interruptChat, readTranscript, sendChatPrompt, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-esc'
let host: HTMLDivElement
let root: Root

function setAgentState(state: 'working' | 'done'): void {
  useAgentStatus.setState((s) => ({
    byId: { ...s.byId, [NODE]: { ...(s.byId[NODE] ?? {}), state } as (typeof s.byId)[string] }
  }))
}

async function mount(): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" />)
  })
  return host.querySelector('textarea') as HTMLTextAreaElement
}

function type(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const press = (ta: HTMLTextAreaElement, key: string): void => {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

beforeEach(() => {
  // Drafts outlive a panel (state/chatDraft.ts); one test's text must not reach the next.
  useChatDraft.setState({ drafts: {} })
  interruptChat.mockClear()
  sendChatPrompt.mockClear()
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

describe('ChatPanel Esc interrupt', () => {
  it('interrupts a working agent from an empty composer', async () => {
    setAgentState('working')
    const ta = await mount()

    await act(async () => press(ta, 'Escape'))

    expect(interruptChat).toHaveBeenCalledWith(NODE, 'claude', undefined)
  })

  it('does nothing when the turn is done', async () => {
    setAgentState('done')
    const ta = await mount()

    await act(async () => press(ta, 'Escape'))

    expect(interruptChat).not.toHaveBeenCalled()
  })

  it('does nothing with a draft in the composer', async () => {
    setAgentState('working')
    const ta = await mount()
    await act(async () => type(ta, 'half a thought'))

    await act(async () => press(ta, 'Escape'))

    expect(interruptChat).not.toHaveBeenCalled()
  })

  it('passes the last send, and puts a prompt core took back into the composer', async () => {
    setAgentState('done')
    const ta = await mount()
    await act(async () => type(ta, 'Write a story'))
    await act(async () => press(ta, 'Enter'))
    expect(sendChatPrompt).toHaveBeenCalledWith(NODE, 'Write a story', 'claude')
    expect(host.textContent).toContain('Write a story')
    interruptChat.mockResolvedValueOnce({ sent: true, restored: 'Write a story' })
    setAgentState('working')

    await act(async () => press(ta, 'Escape'))

    expect(interruptChat).toHaveBeenCalledWith(NODE, 'claude', 'Write a story')
    expect(ta.value).toBe('Write a story')
  })

  it("draws an interrupt as Claude's own line, not as a user bubble", async () => {
    setAgentState('done')
    readTranscript.mockResolvedValueOnce({
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'Write a story' }], key: 1 },
        { role: 'assistant', parts: [{ kind: 'text', text: 'Once upon' }], key: 2 },
        { role: 'assistant', parts: [{ kind: 'interrupt' }], key: 3 }
      ],
      found: true
    })

    await mount()

    const line = host.querySelector('.term-chat__interrupt')
    expect(line?.textContent).toBe('⎿Interrupted · What should Claude do instead?')
    expect(line?.closest('.term-chat__bubble')).toBeNull()
  })

  it('says why when the Esc was refused', async () => {
    setAgentState('working')
    const ta = await mount()
    const toasts: string[] = []
    const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message)
    window.addEventListener('nodeterm:toast', onToast)
    interruptChat.mockResolvedValueOnce({ sent: false, reason: 'unsupported-backend' })

    await act(async () => press(ta, 'Escape'))

    window.removeEventListener('nodeterm:toast', onToast)
    expect(toasts).toEqual([expect.stringMatching(/Esc can't be sent to Claude Code from here/)])
  })
})
