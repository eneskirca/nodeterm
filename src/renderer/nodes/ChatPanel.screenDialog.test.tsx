// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPromptResult } from '@shared/text-delivery'
import { useAgentStatus } from '../state/agentStatus'
import { CHAT_SCREEN_POLL_MS } from '../lib/chatLive'

/**
 * The agent's OWN dialogs (folder trust, /model, setup questions) fire no hook, so the chat view
 * reads the pane's screen: a local pane is polled while the view is visible (composer disabled, the
 * dialog's text in the thread), and every send is refused by core before typing when one is up —
 * the draft stays. The screen reader itself is tested in shared/agents/claude-screen.test.ts.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RULE = '─'.repeat(80)
const IDLE = [RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'].join('\n')
const TRUST = [RULE, ' Accessing workspace:', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'].join(
  '\n'
)

const { screen, capture, sendChatPrompt, session } = vi.hoisted(() => {
  const screen = { now: '' }
  const capture = vi.fn(async (_id: string) => screen.now)
  const sendChatPrompt = vi.fn(async (_id: string, _t: string, _a: string): Promise<ChatPromptResult> => true)
  const session = {
    source: 'local',
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true, olderCursor: null, unmatchedResults: [] }) },
      pty: { capture, sendChatPrompt, sendText: vi.fn() }
    }
  }
  return { screen, capture, sendChatPrompt, session }
})
vi.mock('../session/session', () => ({ useSession: () => session }))

import { ChatPanel } from './ChatPanel'

const NODE = 'n-chat-screen'
let host: HTMLDivElement
let root: Root

const textarea = (): HTMLTextAreaElement => host.querySelector('textarea') as HTMLTextAreaElement
const notice = (): HTMLElement | null => host.querySelector('.term-chat__screen-block')

async function mount(props: { remote?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" remote={props.remote} />)
  })
  const el = host.querySelector('.term-chat__msgs') as HTMLDivElement
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
}
async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(CHAT_SCREEN_POLL_MS)
  })
}
async function typeAndEnter(text: string): Promise<void> {
  const ta = textarea()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  screen.now = IDLE
  capture.mockClear()
  sendChatPrompt.mockReset()
  sendChatPrompt.mockResolvedValue(true)
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
  vi.useRealTimers()
})

describe('ChatPanel — the agent\'s own dialog on screen', () => {
  it('disables the composer and shows the dialog while a local pane shows one, then recovers', async () => {
    screen.now = TRUST
    await mount()
    await tick()

    expect(textarea().disabled).toBe(true)
    expect(textarea().placeholder).toMatch(/is showing a dialog — .* to answer it in the terminal/)
    expect(notice()?.textContent).toContain('No, exit')

    screen.now = IDLE
    await tick()

    expect(textarea().disabled).toBe(false)
    expect(notice()).toBeNull()
  })

  it('never polls a remote pane', async () => {
    await mount({ remote: true })
    await tick()
    await tick()

    expect(capture).not.toHaveBeenCalled()
  })

  it('keeps the draft when core refuses the send before typing, and shows why', async () => {
    sendChatPrompt.mockResolvedValue({ blocked: 'screen', dialog: 'Set up auto mode?\n❯ Yes\n  No' })
    await mount({ remote: true })

    await typeAndEnter('do the thing')

    expect(textarea().value).toBe('do the thing')
    expect(host.querySelector('.term-chat__msg--user')).toBeNull()
    expect(notice()?.textContent).toContain('Set up auto mode?')
    // Remote: nothing will clear this notice by itself, so the draft stays editable for the resend.
    expect(textarea().disabled).toBe(false)
  })

  it('a send that gets through clears a refused-send notice', async () => {
    sendChatPrompt.mockResolvedValueOnce({ blocked: 'screen', dialog: null }).mockResolvedValueOnce(true)
    await mount({ remote: true })
    await typeAndEnter('first try')
    expect(notice()?.textContent).toMatch(/input box isn't on screen/)

    await typeAndEnter('first try')

    expect(notice()).toBeNull()
    expect(host.querySelector('.term-chat__msg--user')?.textContent).toContain('first try')
  })

  it('asks core to check the screen for THIS agent', async () => {
    await mount()

    await typeAndEnter('hello')

    expect(sendChatPrompt).toHaveBeenCalledWith(NODE, 'hello', 'claude')
  })
})
