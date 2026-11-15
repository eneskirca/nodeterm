// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import type { PaneOwner } from '@shared/agents/pane-owner-predicate'

/**
 * The ⌘M composer on a CODEX node asks the kernel before it types (lib/chatPaneGate.ts): codex
 * announces no session end, so after a `/quit` the store still reads `done` while a shell owns the
 * pane, and `sendText` would run the message as a command. This pins the GLUE: the probe runs at
 * send time, a shell-owned pane is refused with a toast and nothing is typed.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sendChatPrompt, paneOwner, session } = vi.hoisted(() => {
  const sendChatPrompt = vi.fn(async (_id: string, _text: string, _agent: string) => true as const)
  const paneOwner = vi.fn(async (_id: string): Promise<PaneOwner | null> => null)
  const session = {
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true }) },
      pty: { sendChatPrompt, paneOwner }
    }
  }
  return { sendChatPrompt, paneOwner, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-codex'
const CODEX: PaneOwner = { panePid: 1, tty: '/dev/pts/1', command: 'node', argv: ['node /usr/bin/codex'], pids: [2] }
const SHELL: PaneOwner = { panePid: 1, tty: '/dev/pts/1', command: 'bash', argv: ['-bash'], pids: [1] }
let host: HTMLDivElement
let root: Root
let toasts: string[]
const onToast = (e: Event): void => {
  toasts.push((e as CustomEvent<{ message: string }>).detail.message)
}

async function mount(agentId: string): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="01a0c9f4-2b7e-7c31-9d52-5e8a1f3b6c20" agentId={agentId} />)
  })
  return host.querySelector('textarea') as HTMLTextAreaElement
}
async function send(ta: HTMLTextAreaElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  sendChatPrompt.mockClear()
  paneOwner.mockReset()
  toasts = []
  window.addEventListener('nodeterm:toast', onToast)
  useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'done' } as (typeof s.byId)[string] } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.removeEventListener('nodeterm:toast', onToast)
  useAgentStatus.setState((s) => {
    const byId = { ...s.byId }
    delete byId[NODE]
    return { byId }
  })
})

describe('ChatPanel — codex send asks the kernel', () => {
  it('types the message when codex owns the pane', async () => {
    paneOwner.mockResolvedValue(CODEX)
    await send(await mount('codex'), 'run the tests')
    expect(paneOwner).toHaveBeenCalledWith(NODE)
    expect(sendChatPrompt).toHaveBeenCalledWith(NODE, 'run the tests', 'codex')
  })

  it('refuses, with a toast, when a SHELL owns the pane though the store still reads done', async () => {
    paneOwner.mockResolvedValue(SHELL)
    await send(await mount('codex'), 'rm -rf build')
    expect(sendChatPrompt).not.toHaveBeenCalled()
    expect(toasts).toEqual(['Codex is no longer running in this terminal — the message was not sent.'])
  })

  // Claude's hooks announce a clean quit, but a Claude pane was observed back at its shell while a
  // phone chat message still passed the gate (2026-11-13; likely after its project was closed).
  // So claude is probed like every agent: a claude pane sends, a shell left behind refuses.
  it('claude is probed too: its pane sends', async () => {
    paneOwner.mockResolvedValue({ panePid: 1, tty: '/dev/ttys001', command: 'claude', argv: ['claude'], pids: [2] })
    await send(await mount('claude'), 'hello')
    expect(paneOwner).toHaveBeenCalled()
    expect(sendChatPrompt).toHaveBeenCalled()
  })

  it('claude is probed too: a shell left behind refuses the send', async () => {
    paneOwner.mockResolvedValue({ panePid: 1, tty: '/dev/ttys001', command: 'zsh', argv: ['-zsh'], pids: [1] })
    await send(await mount('claude'), 'hello')
    expect(sendChatPrompt).not.toHaveBeenCalled()
  })
})
