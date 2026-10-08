import { describe, it, expect, vi } from 'vitest'
import { deliverSleepingWake, type SleepingWakeRequest } from './sleeping-wake'
import type { PaneOwner } from './pane-owner-predicate'

const shell: PaneOwner = { command: 'bash', panePid: 41, paneId: '%7', tty: '/dev/pts/1', argv: ['bash -i'], pids: [41] }
const request: SleepingWakeRequest = { nodeId: 'term-one', agentId: 'codex', command: 'codex resume sid --ask-for-approval never', exitedByUs: true,
  recorded: { command: 'bash', panePid: 41, paneId: '%7' } }
function setup(owner: PaneOwner | null = shell) {
  return { owned: vi.fn(() => true), owner: vi.fn(async () => owner), write: vi.fn(async (_data: string, _owner: PaneOwner) => true), platform: 'linux' }
}

describe('owned sleeping wake delivery', () => {
  it('clears the confirmed shell and submits exactly one current command', async () => {
    const io = setup()
    expect(await deliverSleepingWake(request, io)).toEqual({ delivered: true, verdict: 'resume' })
    expect(io.write).toHaveBeenCalledExactlyOnceWith('\x15codex resume sid --ask-for-approval never\r', shell)
  })
  it('requires ownership before reading and fences replacement across the async owner read', async () => {
    const io = setup()
    io.owned.mockReturnValue(false)
    expect((await deliverSleepingWake(request, io)).verdict).toBe('unreadable')
    expect(io.owner).not.toHaveBeenCalled()
    io.owned.mockReturnValueOnce(true).mockReturnValue(false)
    expect((await deliverSleepingWake(request, io)).verdict).toBe('context-changed')
    expect(io.write).not.toHaveBeenCalled()
  })
  it('rejects a running CLI, recycled pane, changed foreground, lost proof and unreadable host', async () => {
    const cases: Array<[PaneOwner | null, SleepingWakeRequest, string]> = [
      [{ ...shell, command: 'node', argv: ['node /bin/codex resume sid'] }, request, 'agent-running'],
      [{ ...shell, paneId: '%8' }, request, 'context-changed'],
      [{ ...shell, panePid: 42 }, request, 'context-changed'],
      [{ ...shell, command: 'ssh', argv: ['ssh elsewhere'] }, request, 'context-changed'],
      [shell, { ...request, recorded: null }, 'no-proof'],
      [null, request, 'unreadable']
    ]
    for (const [owner, req, verdict] of cases) {
      const io = setup(owner)
      expect((await deliverSleepingWake(req, io)).verdict).toBe(verdict)
      expect(io.write).not.toHaveBeenCalled()
    }
  })
  it('explicit deep pause accepts only a confirmed shell and keeps Windows shell clearing distinct', async () => {
    const io = setup({ ...shell, command: 'pwsh', argv: ['pwsh'] })
    // Deep pause has no prior pane proof; the existing desktop gate recognizes POSIX shells.
    expect((await deliverSleepingWake({ ...request, exitedByUs: false, recorded: null }, io)).delivered).toBe(false)
    const posix = setup()
    expect((await deliverSleepingWake({ ...request, exitedByUs: false, recorded: null }, posix)).delivered).toBe(true)
    const windows = setup({ ...shell, command: 'pwsh', argv: ['pwsh'] })
    windows.platform = 'win32'
    expect((await deliverSleepingWake({ ...request, recorded: { ...request.recorded!, command: 'pwsh' } }, windows)).delivered).toBe(true)
    expect(windows.write.mock.calls[0][0]).toMatch(/^\x1b/)
  })
  it('bounds a wedged owner read before any input and contains probe failure', async () => {
    vi.useFakeTimers()
    try {
      const io = setup(); io.owner.mockImplementation(() => new Promise(() => {}))
      const pending = deliverSleepingWake(request, io)
      await vi.advanceTimersByTimeAsync(6000)
      expect(await pending).toEqual({ delivered: false, verdict: 'unreadable' })
      expect(io.write).not.toHaveBeenCalled()
      io.owner.mockRejectedValue(new Error('disconnected'))
      expect((await deliverSleepingWake(request, io)).verdict).toBe('unreadable')
    } finally { vi.useRealTimers() }
  })
  it('rejects a malformed command before any pane read and reports uncertain write without retry', async () => {
    for (const command of ['', 'codex\nrm bad', 'codex\r', 'codex\x00']) {
      const io = setup()
      expect((await deliverSleepingWake({ ...request, command }, io)).verdict).toBe('invalid-request')
      expect(io.owner).not.toHaveBeenCalled()
    }
    const io = setup()
    io.write.mockResolvedValue(false)
    expect(await deliverSleepingWake(request, io)).toEqual({ delivered: false, verdict: 'delivery-failed' })
    expect(io.write).toHaveBeenCalledTimes(1)
  })
})
