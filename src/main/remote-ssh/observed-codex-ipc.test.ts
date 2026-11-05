import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { registerObservedCodexResumeIpc } from './observed-codex-ipc'
import type { PaneObservedResumeReply } from '../../shared/agents/pane-adoption'

type Event = { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }
describe('observed SSH resume IPC boundary', () => {
  function fixture(windowId: number | undefined) {
    const resume = vi.fn(async (): Promise<PaneObservedResumeReply> => ({ ok: false, code: 'cancelled', error: 'cancelled' }))
    let handler!: (event: Event, raw: unknown) => Promise<unknown>
    registerObservedCodexResumeIpc({ handle: (channel, listener) => {
      expect(channel).toBe(IPC.paneOwnershipResumeObserved); handler = listener
    } }, () => windowId, { resume })
    return { handler, resume }
  }
  it.each(['foreign-window', 'subframe', 'missing-frame', 'no-main-window'])('refuses %s before any launch service', async kind => {
    const { handler, resume } = fixture(kind === 'no-main-window' ? undefined : 7)
    const frame = {}, event: Event = { sender: { id: kind === 'foreign-window' ? 8 : 7, mainFrame: frame },
      senderFrame: kind === 'missing-frame' ? undefined : kind === 'subframe' ? {} : frame }
    expect(await handler(event, { nodeId: 'n1', projectId: 'p1', senderId: 7 })).toMatchObject({ ok: false, code: 'not-permitted' })
    expect(resume).not.toHaveBeenCalled()
  })
  it('passes a live denial guard which notices a frame replacement across awaits', async () => {
    let saved!: () => boolean
    let handler!: (event: Event, raw: unknown) => Promise<unknown>
    registerObservedCodexResumeIpc({ handle: (_channel, callback) => { handler = callback } }, () => 7, {
      resume: async (_sender, _raw, current) => { saved = current!; return { ok: false, code: 'cancelled', error: 'cancelled' } }
    })
    const frame = {}, event: Event = { sender: { id: 7, mainFrame: frame }, senderFrame: frame }
    await handler(event, { nodeId: 'n1', projectId: 'p1' })
    expect(saved()).toBe(true);event.sender.mainFrame = {};expect(saved()).toBe(false)
  })
  it('forwards actual Electron identity and leaves native consent/runtime derivation to the main service', async () => {
    const { handler, resume } = fixture(7), frame = {}, request = { nodeId: 'n1', projectId: 'p1' }
    await handler({ sender: { id: 7, mainFrame: frame }, senderFrame: frame }, request)
    expect(resume).toHaveBeenCalledWith(7, request, expect.any(Function))
  })
})
