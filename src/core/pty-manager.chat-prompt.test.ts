// `PtyManager.sendChatPrompt` — the two answers the ⌘M chat view must never misread.
//
// (1) A pane whose screen cannot be read before typing gets NOTHING typed: there is no baseline to
//     confirm the text against, so typing would end as text stranded unsubmitted in the input box.
//     The prompt goes through the paste instead, which submits in its own step.
// (2) A typed delivery already in flight into the same pane (the canvas panel and the kanban card
//     modal, or a relay peer, sending at once) answers `busy`, never `false` — the view reads `false`
//     as "this session cannot be written to" and turns read-only.
//
// The real prototype methods run against a minimal `this`, so no tmux, pty or platform is involved.
import { describe, it, expect, vi } from 'vitest'
import { PtyManager } from './pty-manager'
import { sessionName } from './tmux-naming'
import type { ChatPromptResult } from '../shared/text-delivery'

const NODE = 'n-chat-prompt'
const proto = PtyManager.prototype as unknown as {
  sendChatPrompt(this: unknown, key: string, text: string, agent: string): Promise<ChatPromptResult>
  sendTyped: unknown
}

function fakeManager(opts: { screen: string; inFlight?: boolean }) {
  const sendText = vi.fn(async () => true as const)
  const self = {
    // A path that cannot run: if anything tries to TYPE, it fails rather than touching a real tmux.
    tmuxPath: '/nonexistent/nodeterm-test/tmux',
    typedInFlight: new Set<string>(opts.inFlight ? [sessionName(NODE)] : []),
    liveSessionForPersistKey: () => undefined,
    captureSession: vi.fn(async () => opts.screen),
    sendText,
    sendTyped: proto.sendTyped
  }
  return self
}

describe('PtyManager.sendChatPrompt', () => {
  it('falls back to the paste, typing nothing, when the pane cannot be read', async () => {
    const m = fakeManager({ screen: '' })
    const result = await proto.sendChatPrompt.call(m, NODE, 'hello', 'claude')
    expect(m.sendText).toHaveBeenCalledWith(NODE, 'hello')
    expect(result).toBe(true)
  })

  it('answers busy — not false — while another typed delivery holds the pane', async () => {
    const m = fakeManager({ screen: '> ', inFlight: true })
    const result = await proto.sendChatPrompt.call(m, NODE, 'hello', 'claude')
    expect(result).toEqual({ blocked: 'busy' })
    expect(m.sendText).not.toHaveBeenCalled()
    expect(m.captureSession).not.toHaveBeenCalled()
  })
})
