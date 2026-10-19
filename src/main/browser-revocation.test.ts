import { describe, it, expect } from 'vitest'
import {
  revokeBrowserNode,
  revokeBrowserByOwner,
  revokeBrowserByProject,
  revokeAllBrowser,
  type RevocationTargets
} from './browser-revocation'
import { BrowserControlLedger, BROWSER_USER_STOPPED } from './browser-control-ledger'
import { BrowserSession, BrowserLeaseManager, BROWSER_LEASE_DETACHED } from './browser-lease'
import type { DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'

// A debugger that records attach/detach and can hold a command in flight — the same shape
// browser-lease.test.ts drives, because a revocation is only proven if it hits a REAL
// BrowserSession's real detach/reject, not a stub.
class FakeDebugger implements DebuggerLike {
  attached = false
  detachCalls = 0
  hangNext = false
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  detach(): void {
    this.detachCalls++
    this.attached = false
  }
  sendCommand(_m: string, _p?: object): Promise<unknown> {
    if (this.hangNext) {
      this.hangNext = false
      return new Promise<never>(() => {}) // never settles — an in-flight verb
    }
    return Promise.resolve({ ok: true })
  }
  on(): void {}
}

const VIEWPORT: CdpContext = { viewport: { width: 1280, height: 800 } }

/** A ledger + lease manager wired to one DRIVEN node: entry claimed, a live BrowserSession attached,
 *  and a command left in flight so the rejection is observable. */
function drivenNode(opts: {
  browserNodeId: string
  ownerNodeId: string
  projectId: string
}): { targets: RevocationTargets; dbg: FakeDebugger; inFlight: Promise<unknown>; ledger: BrowserControlLedger } {
  const ledger = new BrowserControlLedger()
  ledger.claim(opts.browserNodeId, {
    ownerNodeId: opts.ownerNodeId,
    projectId: opts.projectId,
    partition: `persist:nt-agent-browser-${opts.projectId}`,
    navGeneration: 0,
    leaseActiveUntil: 0,
    openedAt: 1_000
  })
  const leases = new BrowserLeaseManager()
  const dbg = new FakeDebugger()
  const session = new BrowserSession({
    nodeId: opts.browserNodeId,
    debugger: dbg,
    viewport: () => VIEWPORT,
    now: () => 1_000_000
  })
  leases.set(opts.browserNodeId, session)
  // Drive it: attaches, and leaves a command hanging so revocation must reject it.
  dbg.hangNext = true
  const inFlight = session.send('Page.navigate', { url: 'https://x.test/' })
  ledger.touchLease(opts.browserNodeId, 1_000_000 + 60_000)
  expect(session.isAttached()).toBe(true)
  return { targets: { leases, ledger }, dbg, inFlight, ledger }
}

const NODE = { browserNodeId: 'browser-3', ownerNodeId: 'claude-2', projectId: 'p-1' }

describe('Stop actually revokes — every surface drops the entry, detaches, and cancels in flight', () => {
  it('1. Stop in the chip / context menu: entry gone, debugger detached, in-flight rejected', async () => {
    const { targets, dbg, inFlight, ledger } = drivenNode(NODE)

    revokeBrowserNode(NODE.browserNodeId, targets, { userStopped: true })

    // The lease is provably GONE, not merely hidden:
    expect(dbg.detachCalls).toBe(1) // the debugger let go of the page
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED) // the pending verb was cancelled
    expect(ledger.get(NODE.browserNodeId, NODE.ownerNodeId)).toBe(null) // ownership dropped
  })

  it('and every subsequent call from that owner answers the human-act refusal, not a retry', () => {
    const { targets, ledger, inFlight } = drivenNode(NODE)
    inFlight.catch(() => {}) // this test asserts the refusal, not the (also-cancelled) in-flight verb
    revokeBrowserNode(NODE.browserNodeId, targets, { userStopped: true })

    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(true)
    expect(BROWSER_USER_STOPPED).toBe('browser-3: the user stopped agent control of this node')
    // Owner-scoped: a DIFFERENT agent gets no signal that the node ever existed.
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, 'claude-9')).toBe(false)
  })

  it('2. closing the node (lifecycle): detaches + drops, but leaves NO human-act tombstone', async () => {
    const { targets, dbg, inFlight, ledger } = drivenNode(NODE)

    revokeBrowserNode(NODE.browserNodeId, targets, { userStopped: false })

    expect(dbg.detachCalls).toBe(1)
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(ledger.get(NODE.browserNodeId, NODE.ownerNodeId)).toBe(null)
    // Closing a node is not "the user stopped control" — no browser-3 tombstone.
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(false)
  })

  it('4. the project switch off: revoke-by-project detaches, drops, and IS a human act (tombstone)', async () => {
    const { targets, dbg, inFlight, ledger } = drivenNode(NODE)

    revokeBrowserByProject(NODE.projectId, targets)

    expect(dbg.detachCalls).toBe(1)
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(ledger.get(NODE.browserNodeId, NODE.ownerNodeId)).toBe(null)
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(true)
  })

  it('5. the owner node closing/restarting: revoke-by-owner detaches + drops (lifecycle, no tombstone)', async () => {
    const { targets, dbg, inFlight, ledger } = drivenNode(NODE)

    revokeBrowserByOwner(NODE.ownerNodeId, targets)

    expect(dbg.detachCalls).toBe(1)
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(ledger.get(NODE.browserNodeId, NODE.ownerNodeId)).toBe(null)
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(false)
  })

  it('6. app quit: revoke-all detaches + drops every claimed node', async () => {
    const { targets, dbg, inFlight, ledger } = drivenNode(NODE)

    revokeAllBrowser(targets, { userStopped: false })

    expect(dbg.detachCalls).toBe(1)
    await expect(inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(ledger.get(NODE.browserNodeId, NODE.ownerNodeId)).toBe(null)
  })

  it('the Settings kill row Stop-all detaches EVERY driven node and tombstones each', async () => {
    // Two owners, two projects, both driven — Stop-all is the one obvious place.
    const a = drivenNode({ browserNodeId: 'browser-1', ownerNodeId: 'claude-1', projectId: 'p-1' })
    // Reuse a's ledger + leases so allIds() spans both.
    const ledger = a.ledger
    const leases = a.targets.leases
    ledger.claim('browser-2', {
      ownerNodeId: 'codex-4',
      projectId: 'p-2',
      partition: 'persist:nt-agent-browser-p-2',
      navGeneration: 0,
      leaseActiveUntil: 0,
      openedAt: 1_000
    })
    const dbg2 = new FakeDebugger()
    const s2 = new BrowserSession({ nodeId: 'browser-2', debugger: dbg2, viewport: () => VIEWPORT, now: () => 1_000_000 })
    ;(leases as BrowserLeaseManager).set('browser-2', s2)
    dbg2.hangNext = true
    const inFlight2 = s2.send('Page.navigate', { url: 'https://y.test/' })

    const stopped = revokeAllBrowser({ leases, ledger }, { userStopped: true })

    expect(new Set(stopped)).toEqual(new Set(['browser-1', 'browser-2']))
    expect(a.dbg.detachCalls).toBe(1)
    expect(dbg2.detachCalls).toBe(1)
    await expect(a.inFlight).rejects.toThrow(BROWSER_LEASE_DETACHED)
    await expect(inFlight2).rejects.toThrow(BROWSER_LEASE_DETACHED)
    expect(ledger.allIds()).toEqual([])
    expect(ledger.wasStoppedByUser('browser-1', 'claude-1')).toBe(true)
    expect(ledger.wasStoppedByUser('browser-2', 'codex-4')).toBe(true)
  })

  it('a fresh verified claim clears a prior user-stop tombstone (a genuine re-open is drivable)', () => {
    const { targets, ledger, inFlight } = drivenNode(NODE)
    inFlight.catch(() => {}) // the cancelled verb is proven elsewhere; here we test re-claim
    revokeBrowserNode(NODE.browserNodeId, targets, { userStopped: true })
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(true)

    ledger.claim(NODE.browserNodeId, {
      ownerNodeId: NODE.ownerNodeId,
      projectId: NODE.projectId,
      partition: 'persist:nt-agent-browser-p-1',
      navGeneration: 0,
      leaseActiveUntil: 0,
      openedAt: 2_000
    })
    expect(ledger.wasStoppedByUser(NODE.browserNodeId, NODE.ownerNodeId)).toBe(false)
  })
})
