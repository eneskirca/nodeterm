import { describe, it, expect, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { branchClaudeSession } from './claudeBranch'

const fakeApi = (over: { sendText?: unknown; capture?: unknown }): NodeTerminalApi =>
  ({ pty: { sendText: over.sendText, capture: over.capture } }) as unknown as NodeTerminalApi

describe('branchClaudeSession', () => {
  it('does not create a branch or poll after an unsubmitted paste', async () => {
    const capture = vi.fn()
    const sendText = vi.fn(async () => 'pasted-not-submitted')
    const result = await branchClaudeSession(fakeApi({ sendText, capture }), 'node-1')
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Do not resend') })
    expect(capture).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledTimes(1)
  })
  it('sends /branch through the passed api, not the global', async () => {
    const sendText = vi.fn(async () => true)
    const capture = vi.fn(async () => 'run claude -r abcdef12-3456 in a new terminal')
    const res = await branchClaudeSession(fakeApi({ sendText, capture }), 'node-1')
    expect(sendText).toHaveBeenCalledWith('node-1', '/branch')
    expect(capture).toHaveBeenCalledWith('node-1')
    expect(res).toEqual({ ok: true, originalId: 'abcdef12-3456' })
  })

  it('fails without polling when the session is not persistent (sendText false)', async () => {
    const capture = vi.fn()
    const res = await branchClaudeSession(fakeApi({ sendText: vi.fn(async () => false), capture }), 'node-1')
    expect(res.ok).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })
})
