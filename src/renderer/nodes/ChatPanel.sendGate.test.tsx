// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'

/**
 * The composer must never type into a TUI dialog: `sendText` pastes and presses Enter, and Enter
 * answers a permission / AskUserQuestion dialog the transcript view does not show. The pure rule
 * is `lib/chatSendGate.ts`; this file pins the GLUE — the textarea is disabled in a dialog state,
 * and `send` re-reads the store at send time, so a dialog that arrives between the last render and
 * the keypress still blocks.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ONE stable api object: `load` depends on `api`, so a fresh object per `useSession()` call would
// re-run the load effect on every render and never settle.
const { sendText, session } = vi.hoisted(() => {
  const sendText = vi.fn(async (_id: string, _text: string) => true as const)
  const session = {
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true }) },
      pty: { sendText }
    }
  }
  return { sendText, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-gate'
let host: HTMLDivElement
let root: Root

function setAgentState(
  state: 'working' | 'waiting' | 'blocked' | 'done' | undefined,
  extra: { hibernated?: boolean; sessionEnded?: boolean } = {}
): void {
  useAgentStatus.setState((s) => ({
    byId: { ...s.byId, [NODE]: { ...(s.byId[NODE] ?? {}), state, ...extra } as (typeof s.byId)[string] }
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

const enter = (ta: HTMLTextAreaElement): void => {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

beforeEach(() => {
  sendText.mockClear()
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

describe('ChatPanel send gate', () => {
  it('sends when the turn is done', async () => {
    setAgentState('done')
    const ta = await mount()
    expect(ta.disabled).toBe(false)
    await act(async () => type(ta, 'hello'))
    await act(async () => enter(ta))
    expect(sendText).toHaveBeenCalledWith(NODE, 'hello', { typed: true })
  })

  it.each(['waiting', 'blocked'] as const)('disables the composer and explains while %s', async (state) => {
    setAgentState(state)
    const ta = await mount()
    expect(ta.disabled).toBe(true)
    expect(ta.placeholder).toMatch(/waiting for an answer in the terminal/)
  })

  it('re-reads the state at send time: a dialog that arrived after the last render still blocks', async () => {
    setAgentState('done')
    const ta = await mount()
    await act(async () => type(ta, 'yes please'))
    // Store flips to a dialog state and the keypress lands in the SAME act, before React commits
    // the re-render — the handler's render-time `state` is still 'done'.
    await act(async () => {
      setAgentState('waiting')
      enter(ta)
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('disables the composer on a hibernated node: its state still reads done, but a SHELL owns the pane', async () => {
    setAgentState('done', { hibernated: true })
    const ta = await mount()
    expect(ta.disabled).toBe(true)
    expect(ta.placeholder).toMatch(/asleep to save memory/)
  })

  it('re-reads hibernation at send time too', async () => {
    setAgentState('done')
    const ta = await mount()
    await act(async () => type(ta, 'ls -la'))
    await act(async () => {
      setAgentState('done', { hibernated: true })
      enter(ta)
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('disables the composer after the CLI exited (/exit, Ctrl+D): state undefined, a SHELL owns the pane', async () => {
    setAgentState(undefined, { sessionEnded: true })
    const ta = await mount()
    expect(ta.disabled).toBe(true)
    expect(ta.placeholder).toMatch(/has exited/)
  })

  it('re-reads the exit at send time too', async () => {
    setAgentState('done')
    const ta = await mount()
    await act(async () => type(ta, 'rm -rf build'))
    await act(async () => {
      setAgentState(undefined, { sessionEnded: true })
      enter(ta)
    })
    expect(sendText).not.toHaveBeenCalled()
  })
})
