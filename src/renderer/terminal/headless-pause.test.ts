import { describe, it, expect, vi } from 'vitest'
import { pauseNodeHeadless, runWithHostCap, createHostLimiter } from './headless-pause'

const SID = '11111111-2222-3333-4444-555555555555'
const OWNER = { panePid: 100, tty: 'pts/1', command: 'claude', argv: ['claude'], paneId: '%1' }
const TIMING = { pollMs: 1, timeoutMs: 200 }
function deps(over: Partial<Record<string, unknown>> = {}) {
  let pane = 'claude'
  return {
    sendPaneKeys: vi.fn(async () => { pane = 'zsh'; return { ok: true } as const }),
    paneCommand: vi.fn(async () => pane),
    paneOwner: vi.fn(async () => OWNER as never),
    status: vi.fn(() => ({ state: 'done', sessionId: SID }) as never),
    binaries: vi.fn(() => ['claude']),
    stillExists: vi.fn(() => true),
    markPaused: vi.fn(),
    ...over
  }
}
const T = { nodeId: 'n1', agentId: 'claude', relay: false, hostKey: 'local' }

describe('pauseNodeHeadless', () => {
  it('exits and marks paused', async () => {
    const d = deps()
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('paused')
    expect(d.markPaused).toHaveBeenCalledWith('n1', expect.objectContaining({ alreadyExited: false }))
  })
  it('defers a node that turned busy before the first key', async () => {
    const d = deps({ status: vi.fn(() => ({ state: 'working', sessionId: SID })) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('deferred')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
  })
  it('alreadyExited writes nothing and marks', async () => {
    const d = deps()
    await expect(pauseNodeHeadless(T, true, d as never, TIMING)).resolves.toBe('paused')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
    expect(d.markPaused).toHaveBeenCalled()
  })
  it('refuses when the pane owner is unreadable (null)', async () => {
    const d = deps({ paneOwner: vi.fn(async () => null) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('not-eligible')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
  })
  it('refuses when a shell, not the agent, owns the pane (not-in-this-pane)', async () => {
    const d = deps({ paneOwner: vi.fn(async () => ({ ...OWNER, command: 'zsh', argv: ['zsh'] })) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('not-eligible')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
  })
  it('pre-exit paneOwner rejection is not-eligible, no keys', async () => {
    const d = deps({ paneOwner: vi.fn(async () => { throw new Error('x') }) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('not-eligible')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
  })
  it('post-exit paneOwner rejection still marks paused with wake null', async () => {
    let n = 0
    const d = deps({ paneOwner: vi.fn(async () => { if (n++) throw new Error('x'); return OWNER as never }) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('paused')
    expect(d.markPaused).toHaveBeenCalledWith('n1', { alreadyExited: false, wake: null })
  })
  it('a hung paneOwner does not hang the pause', async () => {
    const d = deps({ paneOwner: vi.fn(() => new Promise(() => {})) })
    await expect(
      pauseNodeHeadless(T, false, d as never, { ...TIMING, ownerTimeoutMs: 10 })
    ).resolves.toBe('not-eligible')
  })
  it('refuses a node whose CLI announced its exit, before any key', async () => {
    const d = deps({ status: vi.fn(() => ({ state: undefined, sessionId: SID, sessionEnded: true })) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('not-eligible')
    expect(d.sendPaneKeys).not.toHaveBeenCalled()
  })
  it('reports unreachable when keys cannot be sent, marks nothing', async () => {
    const d = deps({ sendPaneKeys: vi.fn(async () => ({ ok: false, reason: 'not-connected' })) })
    await expect(pauseNodeHeadless(T, false, d as never, TIMING)).resolves.toBe('unreachable')
    expect(d.markPaused).not.toHaveBeenCalled()
  })
  it('a second concurrent pause of the same node is not-eligible (shared guard)', async () => {
    const d = deps()
    const [a, b] = await Promise.all([
      pauseNodeHeadless(T, false, d as never, TIMING),
      pauseNodeHeadless(T, false, d as never, TIMING)
    ])
    expect([a, b].sort()).toEqual(['not-eligible', 'paused'])
  })
})

describe('runWithHostCap', () => {
  it('a throwing item does not stop the others and the call resolves', async () => {
    const seen: number[] = []
    await expect(
      runWithHostCap([1, 2, 3, 4], () => 'h', 2, async (i) => { if (i === 1) throw new Error('x'); seen.push(i) })
    ).resolves.toBeUndefined()
    expect(seen.sort()).toEqual([2, 3, 4])
  })
  it('never runs more than cap per host at once', async () => {
    let live = 0, peak = 0
    await runWithHostCap(Array.from({ length: 10 }, (_, i) => i), () => 'h', 3, async () => {
      live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--
    })
    expect(peak).toBe(3)
  })
  it('hosts run independently', async () => {
    let peak = 0, live = 0
    await runWithHostCap([1, 2, 3, 4], (i) => (i % 2 ? 'a' : 'b'), 1, async () => {
      live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--
    })
    expect(peak).toBe(2)
  })
})

describe('createHostLimiter', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

  it('two callers sharing one limiter never exceed the cap on a host', async () => {
    const lim = createHostLimiter(3)
    let inFlight = 0
    let peak = 0
    const job = async (): Promise<void> => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight--
    }
    // A batch and a stream of single fires (the pending watcher), both on host 'h'.
    const batch = Promise.all(Array.from({ length: 6 }, () => lim.run('h', job)))
    const singles = Promise.all(Array.from({ length: 4 }, () => lim.run('h', job)))
    await Promise.all([batch, singles])
    expect(peak).toBe(3)
  })

  it('a throwing fn rejects only its own promise and frees its slot', async () => {
    const lim = createHostLimiter(1)
    const bad = lim.run('h', async () => { throw new Error('x') })
    const good = lim.run('h', async () => 'ok')
    await expect(bad).rejects.toThrow('x')
    await expect(good).resolves.toBe('ok')
  })

  it('different hosts are independent', async () => {
    const lim = createHostLimiter(1)
    let release: () => void = () => {}
    const blockA = lim.run('a', () => new Promise<void>((r) => { release = r }))
    const b = await lim.run('b', async () => 'b-done') // must not wait on host a
    expect(b).toBe('b-done')
    release()
    await blockA
  })
})
