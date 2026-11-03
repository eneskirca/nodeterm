import { describe, expect, it } from 'vitest'
import type { ChatGateStatus } from './chatSendGate'
import { sendPullFeedback, type PullFeedbackSendDeps } from './pullFeedbackSend'

function deps(over: Partial<PullFeedbackSendDeps> = {}): PullFeedbackSendDeps & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    edges: () => [{ source: 'pull', target: 'a1' }],
    nodes: () => [
      { id: 'pull', type: 'pull', data: {} },
      { id: 'a1', type: 'terminal', data: { title: 'Fixer', agentId: 'claude' } },
      { id: 'a2', type: 'terminal', data: { title: 'Other', agentId: 'claude' } }
    ],
    relay: false,
    status: (): ChatGateStatus => ({ state: 'done' }),
    paneOwner: async () => ({ panePid: 1, tty: 't', command: 'claude', argv: ['claude'] }) as never,
    sendChatPrompt: async (id, text) => { sent.push(`${id}: ${text}`); return true },
    guard: async (_id, run) => run(),
    ...over
  }
}

const req = { pullId: 'pull', targetId: 'a1', message: 'fix it' }

describe('sendPullFeedback', () => {
  it('sends the message to the joined agent through the chat send path', async () => {
    const d = deps()
    expect(await sendPullFeedback(d, req)).toBeNull()
    expect(d.sent).toEqual(['a1: fix it'])
  })

  it('refuses an agent not joined to this pull node, and a relay tab, with nothing sent', async () => {
    const d = deps()
    expect(await sendPullFeedback(d, { ...req, targetId: 'a2' })).toMatch(/no longer linked/)
    const relay = deps({ relay: true })
    expect(await sendPullFeedback(relay, req)).toMatch(/relay tab/)
    expect([...d.sent, ...relay.sent]).toEqual([])
  })

  it('refuses an agent that is asking something, or held by a restart, with nothing sent', async () => {
    const asking = deps({ status: () => ({ state: 'waiting' }) })
    expect(await sendPullFeedback(asking, req)).toMatch(/cannot take a message/)
    const held = deps({ guard: async () => 'not-eligible' })
    expect(await sendPullFeedback(held, req)).toMatch(/restarting or waking/)
    expect([...asking.sent, ...held.sent]).toEqual([])
  })

  it('says when core found a dialog on screen', async () => {
    const d = deps({ sendChatPrompt: async () => ({ blocked: 'screen', dialog: null }) })
    expect(await sendPullFeedback(d, req)).toMatch(/dialog or no input box/)
  })
})
