// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPromptResult } from '@shared/text-delivery'
import { useAgentStatus } from '../state/agentStatus'
import {
  CHAT_SCREEN_POLL_MS,
  REMOTE_SUGGESTION_READ_DELAYS_MS,
  SUGGESTION_BURST_MS,
  SUGGESTION_BURST_WINDOW_MS
} from '../lib/chatLive'

/**
 * The agent's OWN dialogs (folder trust, /model, setup questions) fire no hook, so the chat view
 * reads the pane's screen: a local pane is polled while the view is visible (composer disabled, the
 * dialog's text in the thread), and every send is refused by core before writing when one is up —
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
  // The panel's one screen read (`pty.readChatScreen`), answered by the REAL readers over the screen.
  const capture = vi.fn(async (_id: string, _agent: string) => {
    const { readClaudeScreen, readClaudeSuggestion } = await import('@shared/agents/claude-screen')
    return { screen: readClaudeScreen(screen.now), suggestion: readClaudeSuggestion(screen.now) }
  })
  const sendChatPrompt = vi.fn(async (_id: string, _t: string, _a: string): Promise<ChatPromptResult> => true)
  const session = {
    source: 'local',
    api: {
      chat: { readTranscript: async () => ({ messages: [], found: true, olderCursor: null, unmatchedResults: [] }) },
      pty: { readChatScreen: capture, sendChatPrompt, sendText: vi.fn() }
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

// An SSH node is the one whose panel gets `sshProjectId` (TerminalNode / CardModal).
async function mount(props: { remote?: boolean } = {}): Promise<void> {
  const sshProjectId = props.remote === true ? 'ssh-project' : undefined
  await act(async () => {
    root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="claude" sshProjectId={sshProjectId} />)
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

// jsdom's `hasFocus()` is false (nothing focused the test window), and the poll skips unfocused
// windows — so every test starts with a focused window, and the focus tests flip it.
let focused = true

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
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
  vi.restoreAllMocks()
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

  it('never polls a remote pane: it reads it only twice after a turn, for the suggestion', async () => {
    await mount({ remote: true })

    for (let i = 0; i < 20; i++) await tick()

    expect(capture).toHaveBeenCalledTimes(REMOTE_SUGGESTION_READ_DELAYS_MS.length)
  })

  it('never polls a relay tab (the pane is on the peer)', async () => {
    session.source = 'relay'
    try {
      await mount()
      await tick()

      expect(capture).not.toHaveBeenCalled()
    } finally {
      session.source = 'local'
    }
  })

  it('never polls for an agent whose screen it cannot read', async () => {
    await act(async () => {
      root.render(<ChatPanel nodeId={NODE} sessionId="s1" agentId="codex" />)
    })
    await tick()

    expect(capture).not.toHaveBeenCalled()
  })

  it('keeps the draft when core refuses the send before writing, and shows why', async () => {
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

  it('shows the dialog\'s own lines in the thread', async () => {
    screen.now = TRUST
    await mount()
    await tick()

    expect(notice()?.querySelector('.term-chat__screen-block-text')?.textContent).toContain('Yes, I trust this folder')
  })

  it('asks core to check the screen for THIS agent', async () => {
    await mount()

    await typeAndEnter('hello')

    expect(sendChatPrompt).toHaveBeenCalledWith(NODE, 'hello', 'claude')
  })

  it('skips ticks while the window is unfocused, and re-reads the moment it is focused', async () => {
    focused = false
    screen.now = TRUST
    await mount()
    await tick()
    await tick()

    // ~30 tmux spawns a minute per chat view while nobody can type into it — none now.
    expect(capture).not.toHaveBeenCalled()
    expect(notice()).toBeNull()

    focused = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    // No waiting for the next interval: the dialog is on screen before anyone types.
    expect(capture).toHaveBeenCalledTimes(1)
    expect(textarea().disabled).toBe(true)
    expect(notice()?.textContent).toContain('No, exit')
  })

  it('polls when the window cannot say whether it is focused (the hint fails toward polling)', async () => {
    vi.spyOn(document, 'hasFocus').mockImplementation(() => {
      throw new Error('no focus source')
    })
    screen.now = TRUST
    await mount()
    await tick()

    expect(capture).toHaveBeenCalled()
    expect(textarea().disabled).toBe(true)
  })
})

describe('ChatPanel — the prompt Claude suggests next', () => {
  const SUGGESTING = [RULE, `\x1b[39m❯ \x1b[2mrun it in the background\x1b[0m`, RULE, '  ? for shortcuts'].join('\n')
  const TIP = [RULE, `\x1b[39m❯ \x1b[2mTry "fix lint errors"\x1b[0m`, RULE, '  ? for shortcuts'].join('\n')
  const arrowRight = (): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    textarea().dispatchEvent(e)
    return e
  }

  it('shows the suggestion as the placeholder, and → puts it in the composer with the caret at the end', async () => {
    screen.now = SUGGESTING
    await mount()
    await tick()
    expect(textarea().placeholder).toBe('run it in the background')

    let e: KeyboardEvent | undefined
    await act(async () => {
      e = arrowRight()
    })
    await tick()

    expect(e?.defaultPrevented).toBe(true)
    expect(textarea().value).toBe('run it in the background')
    expect(textarea().selectionStart).toBe('run it in the background'.length)
    expect(sendChatPrompt).not.toHaveBeenCalled()
  })

  it('leaves → alone with a draft in the composer', async () => {
    screen.now = SUGGESTING
    await mount()
    await tick()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), 'my own')
      textarea().dispatchEvent(new Event('input', { bubbles: true }))
    })

    let e: KeyboardEvent | undefined
    await act(async () => {
      e = arrowRight()
    })

    expect(e?.defaultPrevented).toBe(false)
    expect(textarea().value).toBe('my own')
  })

  it('does not offer a fresh-session tip', async () => {
    screen.now = TIP
    await mount()
    await tick()

    expect(textarea().placeholder).not.toContain('fix lint errors')
  })

  it('hides the suggestion while the agent works', async () => {
    screen.now = SUGGESTING
    await mount()
    await tick()

    await act(async () => {
      useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'working' } as (typeof s.byId)[string] } }))
    })

    expect(textarea().placeholder).not.toBe('run it in the background')
  })

  const endTurn = async (): Promise<void> => {
    await act(async () => {
      useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'working' } as (typeof s.byId)[string] } }))
    })
    await act(async () => {
      useAgentStatus.setState((s) => ({ byId: { ...s.byId, [NODE]: { state: 'done' } as (typeof s.byId)[string] } }))
    })
  }
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('reads fast right after a turn ends, so the suggestion shows within one fast read', async () => {
    await mount()
    await endTurn()
    screen.now = SUGGESTING

    await advance(SUGGESTION_BURST_MS)

    expect(textarea().placeholder).toBe('run it in the background')
  })

  it('goes back to the regular poll once the fast window is over', async () => {
    await mount()
    await endTurn()
    await advance(SUGGESTION_BURST_WINDOW_MS + SUGGESTION_BURST_MS)
    capture.mockClear()

    for (let i = 0; i < 3; i++) await advance(CHAT_SCREEN_POLL_MS)

    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('stops reading fast at the first suggestion', async () => {
    await mount()
    await endTurn()
    screen.now = SUGGESTING
    await advance(SUGGESTION_BURST_MS)
    capture.mockClear()

    await advance(CHAT_SCREEN_POLL_MS - SUGGESTION_BURST_MS)

    // Only the regular poll's tick, not a fast read every 300 ms.
    expect(capture.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('drops the suggestion once a message is sent', async () => {
    screen.now = SUGGESTING
    await mount()
    await tick()

    await typeAndEnter('something else')

    expect(sendChatPrompt).toHaveBeenCalled()
    expect(textarea().placeholder).not.toBe('run it in the background')
  })
})
