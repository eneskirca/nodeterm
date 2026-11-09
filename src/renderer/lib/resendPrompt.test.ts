import { describe, expect, it, vi } from 'vitest'
import type { AgentState } from '@shared/agents/normalize'
import { TEXT_NOT_SUBMITTED, type TextDeliveryResult } from '@shared/text-delivery'
import type { NodePrompt } from '@shared/node-prompts'
import { resendPrompt, type ResendDeps } from './resendPrompt'

const prompt = (over: Partial<NodePrompt> = {}): NodePrompt => ({ id: 'p1', text: 'proceed', at: 1, ...over })

function deps(over: { state?: AgentState; pane?: string | null; delivered?: TextDeliveryResult } = {}): ResendDeps & {
  sendText: ReturnType<typeof vi.fn>
} {
  return {
    agentState: () => over.state,
    paneCommand: async () => (over.pane === undefined ? 'node' : over.pane),
    sendText: vi.fn(async () => over.delivered ?? true)
  }
}

describe('resendPrompt', () => {
  it('types the prompt into the live session', async () => {
    const d = deps()
    expect(await resendPrompt('n1', prompt(), d)).toEqual({ ok: true })
    expect(d.sendText).toHaveBeenCalledWith('n1', 'proceed')
  })

  it('sends the original with its line breaks, not the one-line display copy', async () => {
    const d = deps()
    await resendPrompt('n1', prompt({ text: 'fix the login bug', full: 'fix the\nlogin bug' }), d)
    expect(d.sendText).toHaveBeenCalledWith('n1', 'fix the\nlogin bug')
  })

  it('never sends a prompt only a clipped copy of survives', async () => {
    const d = deps()
    const out = await resendPrompt('n1', prompt({ text: 'aaa…', partial: true }), d)
    expect(out.ok).toBe(false)
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('refuses while a permission prompt is up, because the text would answer it', async () => {
    const d = deps({ state: 'blocked' })
    const out = await resendPrompt('n1', prompt(), d)
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('permission prompt') })
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it.each(['working', 'waiting', 'done', undefined] as const)('sends when the agent state is %s', async (state) => {
    const d = deps({ state })
    expect(await resendPrompt('n1', prompt(), d)).toEqual({ ok: true })
  })

  it.each(['zsh', '-zsh', '/bin/bash', 'fish'])('refuses when a shell (%s) owns the pane', async (pane) => {
    const d = deps({ pane })
    const out = await resendPrompt('n1', prompt(), d)
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('shell') })
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('refuses when the pane cannot be read — unknown is not safe', async () => {
    const d = deps({ pane: null })
    expect((await resendPrompt('n1', prompt(), d)).ok).toBe(false)
    expect(d.sendText).not.toHaveBeenCalled()
  })

  it('never calls a possibly-pasted prompt sent, and says to check the terminal', async () => {
    const out = await resendPrompt('n1', prompt(), deps({ delivered: 'pasted-not-submitted' }))
    expect(out).toEqual({ ok: false, reason: TEXT_NOT_SUBMITTED })
  })

  it('reports a delivery failure', async () => {
    const out = await resendPrompt('n1', prompt(), deps({ delivered: false }))
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('Could not send') })
  })
})
