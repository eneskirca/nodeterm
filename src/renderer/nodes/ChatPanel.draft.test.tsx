// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useChatDraft } from '../state/chatDraft'

/**
 * The ⌘M draft outlives the panel. A project switch unmounts every node's panel; the draft used to
 * be component state and went with it.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { sendChatPrompt, session } = vi.hoisted(() => {
  const sendChatPrompt = vi.fn(async (_id: string, _text: string, _agent: string) => true as const)
  const session = {
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true }) },
      pty: { sendChatPrompt, paneOwner: async () => ({ panePid: 1, tty: '/dev/ttys001', command: 'claude', argv: ['claude'], pids: [2] }) }
    }
  }
  return { sendChatPrompt, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-draft'
let host: HTMLDivElement
let root: Root

async function mount(nodeId = NODE): Promise<HTMLTextAreaElement> {
  await act(async () => {
    root.render(<ChatPanel nodeId={nodeId} sessionId="s1" agentId="claude" />)
  })
  return host.querySelector('textarea') as HTMLTextAreaElement
}

async function unmount(): Promise<void> {
  await act(async () => root.unmount())
  root = createRoot(host)
}

async function type(ta: HTMLTextAreaElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  useChatDraft.setState({ drafts: {} })
  sendChatPrompt.mockClear()
  useAgentStatus.setState((s) => ({
    byId: { ...s.byId, [NODE]: { ...(s.byId[NODE] ?? {}), state: 'done' } as (typeof s.byId)[string] }
  }))
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

describe('ChatPanel draft', () => {
  it('keeps a draft across an unmount, as on a project switch', async () => {
    await type(await mount(), 'half a thought')
    await unmount()

    const ta = await mount()

    expect(ta.value).toBe('half a thought')
  })

  it("keeps one node's draft out of another node's composer", async () => {
    await type(await mount(), 'for n-draft only')
    await unmount()

    const ta = await mount('n-other')

    expect(ta.value).toBe('')
  })

  it('clears the kept draft once it is sent', async () => {
    const first = await mount()
    await type(first, 'send me')
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await unmount()

    const ta = await mount()

    expect(sendChatPrompt).toHaveBeenCalledWith(NODE, 'send me', 'claude')
    expect(ta.value).toBe('')
    expect(useChatDraft.getState().drafts).toEqual({})
  })
})
