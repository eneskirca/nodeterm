import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSessionMemory, HOST_POLL_MS } from './sessionMemory'
import { createSession, resetSessionsForTest, setActiveSession } from '../session/session'
import type { NodeTerminalApi } from '@shared/types'

const host = vi.fn()
const read = vi.fn()

/** Let the pending microtasks (an awaited api call) settle without advancing the clock. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  host.mockReset().mockResolvedValue({ availableMb: 1000, totalMb: 64000 })
  read.mockReset().mockResolvedValue({ ok: true, rows: [], mem: null })
  // The store reads through the ACTIVE SESSION's api (the same route state/worktrees.ts takes), so
  // register a session whose api carries the mocks. Store construction touches no wire.
  resetSessionsForTest()
  setActiveSession(
    createSession('local', { sessionMemory: { host, read } } as unknown as NodeTerminalApi, 'test')
      .id
  )
  useSessionMemory.setState({ ok: true, rows: [], mem: null, loading: false, loadedScope: null })
})

afterEach(() => {
  useSessionMemory.getState().stopHostPoll()
  vi.useRealTimers()
})

describe('host poll cadence', () => {
  it('polls repeatedly for a LOCAL scope', async () => {
    useSessionMemory.getState().startHostPoll('', 'p1')
    await vi.advanceTimersByTimeAsync(HOST_POLL_MS * 2 + 10)
    // one immediate read + two ticks
    expect(host.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('reads ONCE and schedules nothing for an SSH scope', async () => {
    useSessionMemory.getState().startHostPoll('user@host', 'p1')
    await vi.advanceTimersByTimeAsync(HOST_POLL_MS * 3)
    // Each read is an ssh exec on someone else's machine — never on a timer.
    expect(host).toHaveBeenCalledTimes(1)
  })

  it('stops the local timer when the scope becomes an SSH host', async () => {
    useSessionMemory.getState().startHostPoll('', 'p1')
    await vi.advanceTimersByTimeAsync(HOST_POLL_MS + 10)
    host.mockClear()
    useSessionMemory.getState().startHostPoll('user@host', 'ssh1')
    await vi.advanceTimersByTimeAsync(HOST_POLL_MS * 3)
    // Only the one immediate read the switch itself performed — the local interval must be gone.
    expect(host).toHaveBeenCalledTimes(1)
  })
})

describe('the query the shell is handed', () => {
  it('tells the shell an SSH scope is remote, with the project that names the host', async () => {
    useSessionMemory.getState().startHostPoll('user@host', 'ssh1')
    await flush()
    await useSessionMemory.getState().refreshFull('user@host', 'ssh1')
    // `remote` is one of the two independent sources the service routes on — dropping it would let
    // an SSH scope be answered with the local machine's sessions.
    expect(host).toHaveBeenCalledWith({ projectId: 'ssh1', remote: true })
    expect(read).toHaveBeenCalledWith({ projectId: 'ssh1', remote: true })
  })

  it('marks a local scope not-remote', async () => {
    await useSessionMemory.getState().refreshFull('', 'p1')
    expect(read).toHaveBeenCalledWith({ projectId: 'p1', remote: false })
  })
})

describe('scope guarding', () => {
  it('discards a response whose scope we have since left', async () => {
    let release: (v: unknown) => void = () => {}
    read.mockReturnValueOnce(new Promise((r) => (release = r)))
    const p = useSessionMemory.getState().refreshFull('user@host', 'ssh1')
    // Switch to the local machine while the SSH read is still in flight.
    useSessionMemory.getState().startHostPoll('', 'p1')
    release({ ok: true, rows: [{ nodeId: 'ghost' }], mem: null })
    await p
    expect(useSessionMemory.getState().rows).toEqual([])
    expect(useSessionMemory.getState().loadedScope).not.toBe('user@host')
  })

  it('discards a HOST reading from a scope we have since left', async () => {
    let release: (v: unknown) => void = () => {}
    host.mockReturnValueOnce(new Promise((r) => (release = r)))
    useSessionMemory.getState().startHostPoll('user@host', 'ssh1')
    // Back to this machine; its own read answers with the default 64 GB fixture.
    useSessionMemory.getState().startHostPoll('', 'p1')
    await flush()
    release({ availableMb: 7, totalMb: 7 })
    await flush()
    // The host's 7 MB must never be shown under the local machine's label.
    expect(useSessionMemory.getState().mem).toEqual({ availableMb: 1000, totalMb: 64000 })
  })

  it('drops the previous scope´s rows the moment the scope changes', async () => {
    read.mockResolvedValueOnce({
      ok: true,
      rows: [{ nodeId: 'remote-node' }],
      mem: { availableMb: 5, totalMb: 10 }
    })
    await useSessionMemory.getState().refreshFull('user@host', 'ssh1')
    expect(useSessionMemory.getState().rows).toHaveLength(1)
    useSessionMemory.getState().startHostPoll('', 'p1')
    // Not "stale rows under a new label" — no rows at all until the local machine answers.
    expect(useSessionMemory.getState().rows).toEqual([])
    expect(useSessionMemory.getState().loadedScope).toBeNull()
  })
})

describe('failure semantics', () => {
  it('keeps ok:false and no rows — never an empty success', async () => {
    read.mockResolvedValueOnce({ ok: false, rows: [], mem: null })
    await useSessionMemory.getState().refreshFull('', 'p1')
    expect(useSessionMemory.getState().ok).toBe(false)
    expect(useSessionMemory.getState().rows).toEqual([])
  })

  it('reports a rejected read as ok:false, not as an empty session list', async () => {
    read.mockRejectedValueOnce(new Error('bridge down'))
    await useSessionMemory.getState().refreshFull('', 'p1')
    expect(useSessionMemory.getState().ok).toBe(false)
  })

  it('leaves mem null when the host read throws, rather than reporting zero', async () => {
    // Start from a KNOWN reading, so "still null" cannot pass just because null is the initial
    // state — the assertion has to prove the failure actually cleared it.
    await useSessionMemory.getState().refreshHost('', 'p1')
    expect(useSessionMemory.getState().mem).toEqual({ availableMb: 1000, totalMb: 64000 })
    host.mockRejectedValueOnce(new Error('nope'))
    await useSessionMemory.getState().refreshHost('', 'p1')
    expect(useSessionMemory.getState().mem).toBeNull()
  })

  it('clears loading after refreshFull', async () => {
    await useSessionMemory.getState().refreshFull('', 'p1')
    expect(useSessionMemory.getState().loading).toBe(false)
  })

  it('leaves no spinner behind when the scope changes mid-read', async () => {
    let release: (v: unknown) => void = () => {}
    read.mockReturnValueOnce(new Promise((r) => (release = r)))
    const p = useSessionMemory.getState().refreshFull('user@host', 'ssh1')
    useSessionMemory.getState().startHostPoll('', 'p1')
    release({ ok: true, rows: [], mem: null })
    await p
    expect(useSessionMemory.getState().loading).toBe(false)
  })
})
