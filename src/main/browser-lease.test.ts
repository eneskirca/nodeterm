import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  BrowserSession,
  BrowserLeaseManager,
  leaseIsActive,
  LEASE_IDLE_MS,
  INDICATOR_LINGER_MS,
  BROWSER_LEASE_DETACHED,
  BROWSER_NO_LIVE_SESSION,
  browserAttachFailedMessage,
  browserDevToolsOpenMessage
} from './browser-lease'
import type { DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'

class FakeDebugger implements DebuggerLike {
  attached = false
  attachCalls = 0
  detachCalls = 0
  sends: { method: string; params?: object; sessionId?: string }[] = []
  attachThrows = false
  hangNext = false
  private sessionSeq = 0
  private detachListener: ((e: unknown, reason: string) => void) | null = null

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attachCalls++
    if (this.attachThrows) throw new Error('Another debugger is already attached')
    this.attached = true
  }
  detach(): void {
    this.detachCalls++
    this.attached = false
  }
  sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
    this.sends.push({ method, params, sessionId })
    if (this.hangNext) {
      this.hangNext = false
      return new Promise<never>(() => {}) // never settles — models an in-flight command
    }
    if (method === 'Target.attachToTarget') {
      return Promise.resolve({ sessionId: `sess-${++this.sessionSeq}` })
    }
    return Promise.resolve({ ok: true })
  }
  on(event: 'detach' | 'message', listener: (...a: never[]) => void): void {
    if (event === 'detach') this.detachListener = listener as (e: unknown, reason: string) => void
  }
  fireDetach(reason = 'target closed'): void {
    this.detachListener?.(null, reason)
  }
}

const VIEWPORT: CdpContext = { viewport: { width: 1280, height: 800 } }

function makeSession(overrides: Partial<{ isDevToolsOpen: () => boolean }> = {}): {
  session: BrowserSession
  dbg: FakeDebugger
  setNow: (n: number) => void
} {
  const dbg = new FakeDebugger()
  let now = 1_000_000
  const session = new BrowserSession({
    nodeId: 'browser-3',
    debugger: dbg,
    viewport: () => VIEWPORT,
    now: () => now,
    isDevToolsOpen: overrides.isDevToolsOpen
  })
  return { session, dbg, setNow: (n) => (now = n) }
}

const nav = (url = 'https://x.test/'): ['Page.navigate', { url: string }] => ['Page.navigate', { url }]

describe('leaseIsActive + constants', () => {
  it('is active only while now < leaseActiveUntil', () => {
    expect(leaseIsActive(100, 200)).toBe(true)
    expect(leaseIsActive(200, 200)).toBe(false)
    expect(leaseIsActive(300, 200)).toBe(false)
  })
  it('the timings are the design values', () => {
    expect(LEASE_IDLE_MS).toBe(60_000)
    expect(INDICATOR_LINGER_MS).toBe(5_000)
  })
})

describe('BrowserSession attach lifecycle', () => {
  it('the first verb attaches; a second within LEASE_IDLE_MS does NOT re-attach', async () => {
    const { session, dbg, setNow } = makeSession()
    await session.send(...nav())
    expect(dbg.attachCalls).toBe(1)
    expect(dbg.sends.map((s) => s.method)).toEqual(['Page.navigate'])

    setNow(1_000_000 + LEASE_IDLE_MS - 1)
    await session.send(...nav('https://y.test/'))
    expect(dbg.attachCalls).toBe(1) // still one attachment
  })

  it('no verb for LEASE_IDLE_MS detaches; the next verb re-attaches cleanly', async () => {
    const { session, dbg, setNow } = makeSession()
    await session.send(...nav())
    expect(session.isAttached()).toBe(true)

    // Idle past the window: the sweep detaches.
    const idle = 1_000_000 + LEASE_IDLE_MS + 1
    expect(session.maybeDetachIdle(idle)).toBe(true)
    expect(dbg.detachCalls).toBe(1)
    expect(session.isAttached()).toBe(false)

    // A verb still inside the window does NOT detach.
    setNow(idle)
    await session.send(...nav())
    expect(dbg.attachCalls).toBe(2) // re-attached
    setNow(idle + 10)
    expect(session.maybeDetachIdle(idle + 10)).toBe(false)
  })

  it('release() detaches, and a send in flight rejects with a NAMED outcome, not a hang', async () => {
    const { session, dbg } = makeSession()
    dbg.hangNext = true
    const inFlight = session.send(...nav('https://hang.test/'))
    expect(session.isAttached()).toBe(true)

    session.release()
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(dbg.detachCalls).toBe(1)
    expect(session.leaseActiveUntil).toBe(0)
  })

  it('a webContents teardown (the debugger `detach` event) invalidates everything', async () => {
    const { session, dbg } = makeSession()
    await session.send(...nav())
    dbg.hangNext = true
    const inFlight = session.send(...nav('https://hang.test/'))
    dbg.fireDetach('target closed') // Electron fires this on teardown
    expect(session.isAttached()).toBe(false)
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
  })
})

describe('BrowserSession attach failure', () => {
  it('a generic attach failure is NAMED, never "not drivable"', async () => {
    const { session, dbg } = makeSession()
    dbg.attachThrows = true
    await expect(session.send(...nav())).rejects.toThrow(browserAttachFailedMessage('browser-3'))
  })

  it('attach failure while DevTools is open names DevTools (unreachable on 42.8.1 — see the probe)', async () => {
    const { session, dbg } = makeSession({ isDevToolsOpen: () => true })
    dbg.attachThrows = true
    await expect(session.send(...nav())).rejects.toThrow(browserDevToolsOpenMessage('browser-3'))
  })
})

describe('BrowserSession child sessions (salvaged from S8, with credit)', () => {
  it('attachToTarget records a flat-mode session id under (target)', async () => {
    const { session, dbg } = makeSession()
    const id = await session.attachTarget('t1')
    expect(id).toBe('sess-1')
    expect(session.sessionFor('t1')).toBe('sess-1')
    expect(session.isValidSession('t1', 'sess-1')).toBe(true)
    // It went out in flat mode.
    const attach = dbg.sends.find((s) => s.method === 'Target.attachToTarget')
    expect(attach?.params).toMatchObject({ targetId: 't1', flatten: true })
  })

  it('an explicit detach (idle) clears child sessions; a reused post-reattach id is REFUSED', async () => {
    const { session, setNow } = makeSession()
    await session.attachTarget('t1')
    expect(session.isValidSession('t1', 'sess-1')).toBe(true)

    // Idle detach — the attachment and its session ids die.
    const idle = 1_000_000 + LEASE_IDLE_MS + 1
    session.maybeDetachIdle(idle)
    expect(session.sessionFor('t1')).toBeUndefined()
    expect(session.isValidSession('t1', 'sess-1')).toBe(false)

    // Re-attach and re-attach the target: a NEW id. The OLD id stays refused.
    setNow(idle)
    const fresh = await session.attachTarget('t1')
    expect(fresh).toBe('sess-2')
    expect(session.isValidSession('t1', 'sess-1')).toBe(false)
    expect(session.isValidSession('t1', 'sess-2')).toBe(true)
  })

  it('a webContents teardown clears child sessions too', async () => {
    const { session, dbg } = makeSession()
    await session.attachTarget('t1')
    session.handleTeardown()
    expect(session.sessionFor('t1')).toBeUndefined()
    // handleTeardown must NOT call detach() on a gone target.
    expect(dbg.detachCalls).toBe(0)
  })

  it('sendToTarget refuses when the target has no live session', async () => {
    const { session } = makeSession()
    await expect(session.sendToTarget('t1', 'Page.getLayoutMetrics', {})).rejects.toThrow(
      BROWSER_NO_LIVE_SESSION
    )
  })
})

describe('there is NO handoff-invalidation path (the feature was removed, not the care)', () => {
  it('the source states the third S8 trigger is designed away', () => {
    const src = readFileSync(new URL('./browser-lease.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/no handoff/i)
    expect(src).toMatch(/removed the feature that[\s*/]+needed the care/i)
    expect(src).toMatch(/designed away/i)
    // And there is no handoff/claim machinery — the S8 names for it are gone.
    expect(src).not.toMatch(/invalidateOnHandoff|onHandoff|claimUserTab|transferControl/)
  })
})

describe('BrowserLeaseManager', () => {
  it('owns sessions by node id, sweeps idle ones, and releases all on teardown', async () => {
    const mgr = new BrowserLeaseManager()
    const dbg = new FakeDebugger()
    let now = 500
    const s = new BrowserSession({ nodeId: 'browser-1', debugger: dbg, viewport: () => VIEWPORT, now: () => now })
    mgr.set('browser-1', s)
    expect(mgr.get('browser-1')).toBe(s)

    await s.send(...nav())
    expect(s.isAttached()).toBe(true)

    now = 500 + LEASE_IDLE_MS + 1
    mgr.sweepIdle(now)
    expect(s.isAttached()).toBe(false)

    mgr.releaseAll()
    expect(mgr.get('browser-1')).toBeUndefined()
  })
})

describe('a viewport override never outlives the lease (#539)', () => {
  const OVERRIDE = { width: 1280, height: 3000, deviceScaleFactor: 0, mobile: false }
  const methods = (dbg: FakeDebugger) => dbg.sends.map((x) => x.method)

  it('release() clears an unconfirmed override BEFORE it detaches', async () => {
    const { session, dbg } = makeSession()
    dbg.hangNext = true
    void session.send('Emulation.setDeviceMetricsOverride', OVERRIDE).catch(() => {})
    let clearedWhileAttached = false
    const orig = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = (m, p, sid) => {
      if (m === 'Emulation.clearDeviceMetricsOverride') clearedWhileAttached = dbg.attached
      return orig(m, p, sid)
    }
    session.release()
    expect(methods(dbg)).toContain('Emulation.clearDeviceMetricsOverride')
    expect(clearedWhileAttached).toBe(true)
    expect(dbg.attached).toBe(false)
    expect(dbg.attachCalls).toBe(1)
  })

  it('a confirmed clear means the next detach sends nothing extra', async () => {
    const { session, dbg } = makeSession()
    await session.send('Emulation.setDeviceMetricsOverride', OVERRIDE)
    await session.send('Emulation.clearDeviceMetricsOverride', {})
    await Promise.resolve()
    const before = dbg.sends.length
    session.release()
    expect(dbg.sends.length).toBe(before)
  })

  it('a detach we did not make leaves the clear for the FIRST command of the next attach', async () => {
    const { session, dbg } = makeSession()
    await session.send('Emulation.setDeviceMetricsOverride', OVERRIDE)
    dbg.attached = false
    dbg.fireDetach('canceled_by_user')
    expect(dbg.attachCalls).toBe(1) // nothing reattaches by itself
    await session.send('Page.getLayoutMetrics', {})
    const tail = methods(dbg).slice(-2)
    expect(tail).toEqual(['Emulation.clearDeviceMetricsOverride', 'Page.getLayoutMetrics'])
  })
})
