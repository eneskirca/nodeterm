import { describe, it, expect, vi } from 'vitest'
import { BrowserControlLedger, BROWSER_USER_STOPPED } from './browser-control-ledger'
import { BrowserSession } from './browser-lease'
import type { DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'
import { NT_SCRIPTS } from './browser-nt-scripts'
import { RefTable } from './browser-refs'
import { CdpEventBus, type Sendable } from './browser-actions'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import { browserDiscardedMessage } from './browser-guest-registry'
import {
  driveBrowser,
  gateBrowserDrive,
  BROWSER_CAPABILITY_OFF_MESSAGE,
  BROWSER_SOURCE_NOT_CAPABLE,
  noDrivableNodeMessage,
  type BrowserResolve,
  type DriveDeps,
  type LiveGuest
} from './browser-drive'
import { parseBrowserArgs, type BrowserCall } from '../core/browser-verb'

const OWNER = 'claude-1'
const NODE = 'browser-3'
const okResolve: BrowserResolve = {
  ok: true,
  projectId: 'proj-1',
  sourceControlCapable: true,
  capabilityOn: true
}

/** A fake debugger that tracks whether it was ever ATTACHED — the whole point of "ledger.get before
 *  any attach" is that a refused caller causes zero attachments. */
class FakeDebugger implements DebuggerLike {
  attached = false
  attachCount = 0
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
    this.attachCount++
  }
  detach(): void {
    this.attached = false
  }
  on(): void {}
  async sendCommand(method: string, params: object = {}): Promise<unknown> {
    const p = params as Record<string, unknown>
    switch (method) {
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } }
      case 'DOM.resolveNode':
        return { object: { objectId: 'o' } }
      case 'Runtime.callFunctionOn':
        return { result: { value: p.functionDeclaration === NT_SCRIPTS.readTitle ? 'Home' : null } }
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ url: 'https://x.test/' }] }
      default:
        return {}
    }
  }
}

function freshLedgerOwning(): BrowserControlLedger {
  const ledger = new BrowserControlLedger()
  ledger.claim(NODE, { ownerNodeId: OWNER, projectId: 'proj-1', partition: 'p', navGeneration: 0, leaseActiveUntil: 0, openedAt: 0 })
  return ledger
}

function makeGuest(): { guest: LiveGuest; dbg: FakeDebugger } {
  const dbg = new FakeDebugger()
  const viewport = (): CdpContext => ({ viewport: { width: 800, height: 600 } })
  const session = new BrowserSession({ nodeId: NODE, debugger: dbg, viewport })
  return { guest: { session: session as Sendable, bus: new CdpEventBus() }, dbg }
}

function readTitleCall(): BrowserCall {
  const c = parseBrowserArgs({ node: NODE, read: 'title' })
  if ('error' in c) throw new Error(c.error)
  return c
}

// ── the pure ordering ─────────────────────────────────────────────────────────────────────────
describe('gateBrowserDrive — the refusal ORDER is the requirement', () => {
  const base = () => ({
    browserNodeId: NODE,
    ownerNodeId: OWNER,
    verified: true,
    resolve: okResolve,
    ledger: freshLedgerOwning(),
    guestPresent: true
  })

  it('1. identity first — an unverified caller is refused before anything else', () => {
    // Even with a broken everything-else, identity wins: nothing happened.
    const g = gateBrowserDrive({ ...base(), verified: false, resolve: { ok: false, refusal: 'x' }, ledger: new BrowserControlLedger(), guestPresent: false })
    expect(g).toEqual({ kind: 'refuse', message: STRICT_CONTROL_REFUSAL, revoke: false })
  })

  it('2. then canControlCanvas', () => {
    const g = gateBrowserDrive({ ...base(), resolve: { ...okResolve, sourceControlCapable: false } })
    expect(g).toEqual({ kind: 'refuse', message: BROWSER_SOURCE_NOT_CAPABLE, revoke: false })
  })

  it('3. then the per-project capability — verbatim sentence, and it REVOKES', () => {
    const g = gateBrowserDrive({ ...base(), resolve: { ...okResolve, capabilityOn: false } })
    expect(g).toEqual({ kind: 'refuse', message: BROWSER_CAPABILITY_OFF_MESSAGE, revoke: true })
  })

  it('4. then ledger ownership — "not yours" and "does not exist" are the SAME message', () => {
    const notYours = gateBrowserDrive({ ...base(), ownerNodeId: 'claude-9' })
    const notExist = gateBrowserDrive({ ...base(), browserNodeId: 'browser-9', ledger: freshLedgerOwning() })
    expect(notYours).toEqual({ kind: 'refuse', message: noDrivableNodeMessage(NODE), revoke: false })
    expect(notExist).toEqual({ kind: 'refuse', message: noDrivableNodeMessage('browser-9'), revoke: false })
  })

  it('5. finally discard — a released page is a lifecycle refusal, never a permissions one', () => {
    const g = gateBrowserDrive({ ...base(), guestPresent: false })
    expect(g).toEqual({ kind: 'refuse', message: browserDiscardedMessage(NODE), revoke: false })
  })

  it('all gates pass → drive, carrying the ledger entry', () => {
    const g = gateBrowserDrive(base())
    expect(g.kind).toBe('drive')
  })
})

// ── carried obligation: ledger-gated ATTACH (PR 5/#306 MINOR-2) ─────────────────────────────────
describe('the ledger gates the ATTACH, not just the reply', () => {
  it('an unowned caller cannot drive AND never causes a debugger attach', async () => {
    const ledger = new BrowserControlLedger() // nobody owns NODE
    const { guest, dbg } = makeGuest()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r).toEqual({ ok: false, message: noDrivableNodeMessage(NODE) })
    expect(dbg.attachCount).toBe(0) // the debugger was NEVER attached for a non-owner
  })

  it('the ledger-confirmed owner drives, and only THEN does the debugger attach', async () => {
    const ledger = freshLedgerOwning()
    const { guest, dbg } = makeGuest()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r.ok).toBe(true)
    expect(dbg.attachCount).toBe(1)
  })
})

// ── carried obligation: DRIVE-TIME live capability read + revoke (PR 6/#307 MINOR-2) ─────────────
describe('capability is read LIVE at drive time and a now-off switch refuses AND revokes', () => {
  it('a valid-at-attach lease is re-checked each drive; capability now off → refuse + revoke + no attach', async () => {
    const ledger = freshLedgerOwning()
    const { guest, dbg } = makeGuest()
    const revoke = vi.fn()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke }

    // First drive: capability ON → drives.
    const on = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: { ...okResolve, capabilityOn: true } }, deps)
    expect(on.ok).toBe(true)

    // Same lease, next verb: a project.json hand-edit flipped the switch OFF (a FRESH resolve says so).
    const off = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: { ...okResolve, capabilityOn: false } }, deps)
    expect(off).toEqual({ ok: false, message: BROWSER_CAPABILITY_OFF_MESSAGE })
    expect(revoke).toHaveBeenCalledWith(NODE) // detaches + drops + tombstones
    // The off-drive attempts no new attach of its own.
    expect(dbg.attachCount).toBe(1)
  })
})

// ── carried obligation: honor the #307 tombstone ────────────────────────────────────────────────
describe('a user-Stopped node refuses to re-drive until a fresh verified claim (#307 tombstone)', () => {
  it('after the USER stops control, its owner is refused with the named human act — not a retryable null', async () => {
    const ledger = freshLedgerOwning()
    ledger.stopByUser(NODE) // chip / menu / Settings / switch-off
    const { guest, dbg } = makeGuest()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r).toEqual({ ok: false, message: BROWSER_USER_STOPPED })
    expect(dbg.attachCount).toBe(0)
  })

  it('the tombstone clears ONLY via a fresh claim — then the same owner drives again', async () => {
    const ledger = freshLedgerOwning()
    ledger.stopByUser(NODE)
    expect(ledger.wasStoppedByUser(NODE, OWNER)).toBe(true)
    // A fresh, verified open-browser re-claims the node (ids are not reused in practice, but the
    // tombstone-clear on claim is the contract).
    ledger.claim(NODE, { ownerNodeId: OWNER, projectId: 'proj-1', partition: 'p', navGeneration: 0, leaseActiveUntil: 0, openedAt: 0 })
    expect(ledger.wasStoppedByUser(NODE, OWNER)).toBe(false)
    const { guest } = makeGuest()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r.ok).toBe(true)
  })
})

// ── PR 9: --cookies drives through the SAME gate and is loudly traced ───────────────────────────
describe('--cookies drives through the gate and traces BEFORE it reads (Task 9.3)', () => {
  function cookiesCall(): BrowserCall {
    const c = parseBrowserArgs({ node: NODE, cookies: 'github.com' })
    if ('error' in c) throw new Error(c.error)
    return c
  }

  it('the owner reads cookies, and the board-log trace is appended before the read', async () => {
    const ledger = freshLedgerOwning()
    const { guest, dbg } = makeGuest()
    const order: string[] = []
    const origSend = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (m: string, p?: object) => {
      if (m === 'Network.getCookies') order.push('read')
      return m === 'Network.getCookies' ? { cookies: [{}, {}, {}, {}] } : origSend(m, p)
    }
    const appendBoardLog = vi.fn(async (_projectId: string, _entry: unknown) => {
      order.push('trace')
      return true
    })
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn(), appendBoardLog }
    const r = await driveBrowser(
      { call: cookiesCall(), ownerNodeId: OWNER, verified: true, resolve: { ...okResolve, sourceTitle: 'claude-1', browserTitle: 'browser-3' } },
      deps
    )
    expect(r).toEqual({ ok: true, message: "read 4 cookies for github.com — this was recorded in the project's activity log." })
    expect(order).toEqual(['trace', 'read']) // the trace strictly precedes the read
    // The entry files under the OWNER's card, names the owner in `from`, the domain in `to`.
    const entry = appendBoardLog.mock.calls[0][1]
    expect(entry).toMatchObject({
      nodeId: OWNER,
      kind: 'event',
      event: { type: 'agent-read-cookies', from: 'claude-1', to: 'github.com', title: 'browser-3' }
    })
  })

  it('if the trace cannot be recorded, the read does not happen (fail-closed)', async () => {
    const ledger = freshLedgerOwning()
    const { guest, dbg } = makeGuest()
    const reads: string[] = []
    const origSend = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (m: string, p?: object) => {
      if (m === 'Network.getCookies') reads.push(m)
      return origSend(m, p)
    }
    // No appendBoardLog wired at all ⇒ the read cannot be recorded ⇒ refuse without reading.
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: cookiesCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r.ok).toBe(false)
    expect(reads).toEqual([]) // the jar was never read
  })
})

// ── PR 9: --screenshot is jailed to the project dir end-to-end ───────────────────────────────────
describe('--screenshot is jailed to the project dir through the gate (Task 9.1)', () => {
  function shotCall(p: string): BrowserCall {
    const c = parseBrowserArgs({ node: NODE, screenshot: p })
    if ('error' in c) throw new Error(c.error)
    return c
  }
  const screenshotIO = () => ({
    realpath: async (p: string) => p, // identity: no symlinks in this unit
    lstat: async () => ({ isSymbolicLink: () => false }),
    writeFile: vi.fn(async () => {})
  })

  it('a path inside the project writes and replies with the show-image line', async () => {
    const ledger = freshLedgerOwning()
    const { guest, dbg } = makeGuest()
    const origSend = dbg.sendCommand.bind(dbg)
    dbg.sendCommand = async (m: string, p?: object) =>
      m === 'Page.captureScreenshot' ? { data: Buffer.from('PNG').toString('base64') } : origSend(m, p)
    const io = screenshotIO()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn(), screenshotIO: io }
    const r = await driveBrowser(
      { call: shotCall('shot.png'), ownerNodeId: OWNER, verified: true, resolve: { ...okResolve, projectCwd: '/proj' } },
      deps
    )
    expect(r.ok).toBe(true)
    expect(r.message).toContain('/proj/shot.png')
    expect(r.message).toContain('show-image /proj/shot.png')
    expect(io.writeFile).toHaveBeenCalled()
  })

  it('a traversal path is refused and never writes', async () => {
    const ledger = freshLedgerOwning()
    const { guest } = makeGuest()
    const io = screenshotIO()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn(), screenshotIO: io }
    const r = await driveBrowser(
      { call: shotCall('../../etc/x.png'), ownerNodeId: OWNER, verified: true, resolve: { ...okResolve, projectCwd: '/proj' } },
      deps
    )
    expect(r).toEqual({ ok: false, message: 'browser: --screenshot path must be inside the project directory' })
    expect(io.writeFile).not.toHaveBeenCalled()
  })
})

describe('driveBrowser end-to-end refusals', () => {
  it('a discarded guest (sessionFor → null) is the named discard refusal', async () => {
    const ledger = freshLedgerOwning()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => null, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }, deps)
    expect(r).toEqual({ ok: false, message: browserDiscardedMessage(NODE) })
  })

  it('an unverified caller is refused with the flat strict sentence', async () => {
    const ledger = freshLedgerOwning()
    const { guest } = makeGuest()
    const deps: DriveDeps = { ledger, refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const r = await driveBrowser({ call: readTitleCall(), ownerNodeId: OWNER, verified: false, resolve: okResolve }, deps)
    expect(r).toEqual({ ok: false, message: STRICT_CONTROL_REFUSAL })
  })
})

describe('actions cannot share a temporary viewport', () => {
  it('refuses overlap and releases the lock after failure', async () => {
    const { guest } = makeGuest()
    let reject!: (e: Error) => void
    const send = vi.spyOn(guest.session, 'send').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const deps: DriveDeps = { ledger: freshLedgerOwning(), refs: new RefTable(), sessionFor: () => guest, revoke: vi.fn() }
    const input = { call: readTitleCall(), ownerNodeId: OWNER, verified: true, resolve: okResolve }
    const first = driveBrowser(input, deps)
    const second = await driveBrowser(input, deps)
    expect(second).toEqual({ ok: false, message: expect.stringContaining('another action') })
    expect(send).toHaveBeenCalledTimes(1)
    reject(new Error('fixture failed'))
    expect((await first).ok).toBe(false)
    expect((await driveBrowser(input, deps)).ok).toBe(true)
  })
})
