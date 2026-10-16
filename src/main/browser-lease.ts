/**
 * The debugger LEASE: attach on the first verb, detach after {@link LEASE_IDLE_MS} of idleness,
 * re-attach on the next verb. The attachment is deliberately NOT the indicator — an attach is
 * invisible by itself and a detach-on-idle would blank a chip for a lease that is still live — so the
 * chip binds to the ledger's `leaseActiveUntil` instead (PR 6). Every command routes through the one
 * send wrapper ({@link import('./browser-cdp-send').sendCdp}) and therefore through the allowlist.
 *
 * PROBE (Task 5.0, docs/superpowers/probes/2026-08-browser-debugger.md), measured on Electron 42.8.1:
 * a programmatic `webContents.debugger.attach()` and a user-opened DevTools window on the same
 * <webview> guest are NOT mutually exclusive — attach succeeds with DevTools already open, and
 * DevTools opens while a programmatic attachment stays live. So on this version the DevTools-specific
 * attach-failure sentence ({@link browserDevToolsOpenMessage}) is UNREACHABLE: it stays wired behind
 * an injected `isDevToolsOpen` check (design §2.3 rule 1 — name the cause, never "not drivable") in
 * case a future Electron bump reintroduces the single-client rule, but attach does not fail for that
 * reason today. The generic named attach-failure path is the one that runs.
 *
 * CDP child-session bookkeeping is lifted from PR #112's S8 with credit to @Corvin (proteus-dev) —
 * the flat-mode `Target.attachToTarget`, the per-target session map, and BOTH invalidation points.
 * Its THIRD invalidation trigger — a handoff to a different controlling session — is designed away
 * rather than reimplemented: there is no handoff in this design (Task 4.3), so removing the feature
 * that needed the care beats reimplementing the care.
 *
 * Electron-adjacent (holds a debugger on a page with real logins) → `src/main`, never Server Edition.
 */
import type { CdpContext } from './browser-cdp-allowlist'
import type { LayoutMetrics } from './browser-actions'
import { type DebuggerLike, sendCdp } from './browser-cdp-send'
// The indicator's linger now lives in `src/shared` (PR 6 consumes it from the renderer too, and a
// renderer→main import is forbidden — global constraint 4). Re-exported here so the debugger-lease
// timings still read together at this one call site and every existing importer is unaffected.
import { INDICATOR_LINGER_MS } from '@shared/browser-indicator'

/** The viewport override `--screenshot --full true` uses, and its clear. Named once so the session's
 *  lifecycle bookkeeping and the screenshot cannot disagree about which methods they mean. */
export const METRICS_OVERRIDE = 'Emulation.setDeviceMetricsOverride'
export const METRICS_OVERRIDE_CLEAR = 'Emulation.clearDeviceMetricsOverride'

/** The lease outlives the last verb by this long; a verb within the window does not re-attach. */
export const LEASE_IDLE_MS = 60_000
export { INDICATOR_LINGER_MS }

/** Pure, so the ledger, the indicator and the discard-suppression sweep all agree on "still live". */
export function leaseIsActive(now: number, leaseActiveUntil: number): boolean {
  return leaseActiveUntil > now
}

/** Name the cause — a DevTools window, not a permissions failure. UNREACHABLE on Electron 42.8.1
 *  (see the probe above); kept for a future Electron that restores the single-client rule. */
export const browserDevToolsOpenMessage = (id: string): string =>
  `browser: ${id} has DevTools open; close them to let an agent drive it`

/** A generic, NAMED attach failure — the page likely just closed. Never "not drivable" (that reads
 *  as a permissions verdict and sends the next debugger to the identity code). */
export const browserAttachFailedMessage = (id: string): string =>
  `browser: ${id} could not be attached for control (its page may have just closed); ` +
  `bring it on screen or open a new one`

/** The named outcome for a command still in flight when the lease detaches — never a hang. */
export const BROWSER_LEASE_DETACHED =
  'browser: the control lease detached while a command was in flight; the page was released — try again'

/** The named outcome for a child-target command with no live session (invalid after a detach). */
export const BROWSER_NO_LIVE_SESSION =
  'browser: that page target is no longer attached (the page navigated or was released); re-read it'

export interface BrowserSessionOpts {
  /** The browser node this session drives (validated upstream in the guest registry). */
  nodeId: string
  /** Injected `webContents.debugger`. */
  debugger: DebuggerLike
  /** The current viewport, refreshed by PR 7 from `Page.getLayoutMetrics`; read at send time so a
   *  resize between verbs is reflected in the coordinate bound. */
  viewport: () => CdpContext
  /** Clock, injected for tests. */
  now?: () => number
  /** Does the user have DevTools open on this guest? Only consulted on an attach failure. */
  isDevToolsOpen?: () => boolean
  /** Push the new `leaseActiveUntil` to the ledger (drives the indicator + discard suppression). */
  onLeaseChange?: (leaseActiveUntil: number) => void
}

/**
 * One guest's control session. Owns the attach lifecycle, the flat-mode child sessions, and the
 * in-flight rejection on detach. Pure enough to unit-test with a fake {@link DebuggerLike}; the real
 * attach/detach is exercised in the Electron harness.
 */
export class BrowserSession {
  private readonly nodeId: string
  private readonly dbg: DebuggerLike
  private readonly viewport: () => CdpContext
  private readonly now: () => number
  private readonly isDevToolsOpen: () => boolean
  private readonly onLeaseChange: (until: number) => void

  private attached = false
  private _leaseActiveUntil = 0
  /**
   * The last viewport measured from `Page.getLayoutMetrics` ({@link refreshViewport}). PR 8's pointer
   * verbs bound a mouse coordinate to what is actually on screen, and the constructor-injected
   * viewport is a 0×0 placeholder until then — so once a real measurement lands, it OVERRIDES the
   * injected closure at send time (see {@link currentCtx}). Reset on any detach: a released/re-navigated
   * page's old size must never bound a coordinate on the next one.
   */
  private _viewport: { width: number; height: number } | null = null
  /**
   * CDP child-session ids are scoped to the debugger attachment. They are invalid after either an
   * explicit detach or webContents teardown and must never survive a reattach.
   */
  private readonly targets = new Map<string, string>()
  private readonly detachRejectors = new Set<(e: Error) => void>()
  /**
   * Did we send `Emulation.setDeviceMetricsOverride` without a confirmed clear? (#539 full-page
   * screenshots.) MEASURED on Electron 42.9.1: an override SURVIVES `debugger.detach()` and even a
   * page reload, so a detach that forgets it leaves the user's page rendered at the full content
   * height. Hence: every detach WE make sends the clear first (a clear sent immediately before
   * `detach()` was measured to take effect), and a detach we did NOT make keeps this set so the next
   * attach clears it before anything else. Never a reattach just to clear: a revoked lease stays
   * detached.
   */
  private metricsOverridden = false

  constructor(opts: BrowserSessionOpts) {
    this.nodeId = opts.nodeId
    this.dbg = opts.debugger
    this.viewport = opts.viewport
    this.now = opts.now ?? Date.now
    this.isDevToolsOpen = opts.isDevToolsOpen ?? (() => false)
    this.onLeaseChange = opts.onLeaseChange ?? (() => {})
    // A detach from ANY cause — our own detach, an idle detach, or a webContents teardown (which
    // fires `detach` with reason "target closed") — invalidates the attachment and every child
    // session, and must reject anything still in flight. One handler covers all of them.
    this.dbg.on('detach', () => this.onDetached())
  }

  get leaseActiveUntil(): number {
    return this._leaseActiveUntil
  }

  isAttached(): boolean {
    return this.attached
  }

  /** The live session id for a target, or undefined. A caller must ALWAYS read this fresh — never
   *  cache a session id across a possible detach. */
  sessionFor(targetId: string): string | undefined {
    return this.targets.get(targetId)
  }

  /** Is this exact session id still the live one for this target? False after any detach — which is
   *  how a reused post-reattach session id is refused. */
  isValidSession(targetId: string, sessionId: string): boolean {
    return this.targets.get(targetId) === sessionId
  }

  /** Send a root-target command: attach if needed, extend the lease, and race the send against a
   *  detach so it can never hang past a release. */
  send(method: string, params: object): Promise<unknown> {
    return this.dispatch(method, params, undefined)
  }

  /**
   * Measure the page from `Page.getLayoutMetrics`, cache the viewport size so subsequent bounded
   * pointer events ({@link import('./browser-actions').browserClick}/`browserScroll`) validate against
   * the REAL page, and return the full scroll geometry (viewport + current scroll offset + content
   * size) the scroll reply reads back. A pointer verb calls this immediately before it dispatches, so
   * a resize/scroll between verbs is always reflected.
   */
  async refreshViewport(): Promise<LayoutMetrics> {
    const raw = (await this.send('Page.getLayoutMetrics', {})) as {
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number }
      cssContentSize?: { width?: number; height?: number }
    }
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const lv = raw?.cssLayoutViewport
    const vv = raw?.cssVisualViewport
    const cs = raw?.cssContentSize
    const width = num(lv?.clientWidth) ?? num(vv?.clientWidth) ?? 0
    const height = num(lv?.clientHeight) ?? num(vv?.clientHeight) ?? 0
    this._viewport = { width, height }
    return {
      width,
      height,
      scrollX: num(vv?.pageX) ?? 0,
      scrollY: num(vv?.pageY) ?? 0,
      contentWidth: num(cs?.width) ?? width,
      contentHeight: num(cs?.height) ?? height
    }
  }

  /** Send a command to a flat-mode child target, using its LIVE session id (never a caller-supplied
   *  one). Refused with a named outcome if the target has no live session. */
  sendToTarget(targetId: string, method: string, params: object): Promise<unknown> {
    const sessionId = this.targets.get(targetId)
    if (!sessionId) return Promise.reject(new Error(BROWSER_NO_LIVE_SESSION))
    return this.dispatch(method, params, sessionId)
  }

  /** Attach to a child target in FLAT mode, record its session id, return it. */
  async attachTarget(targetId: string): Promise<string> {
    const res = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId?: string
    }
    const sessionId = res?.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(BROWSER_NO_LIVE_SESSION)
    }
    this.targets.set(targetId, sessionId)
    return sessionId
  }

  /** Detach a child target and forget its session id. No-op if it has none. */
  async detachTarget(targetId: string): Promise<void> {
    const sessionId = this.targets.get(targetId)
    if (!sessionId) return
    // Delete FIRST: even if the detach send rejects, the id must not stay usable.
    this.targets.delete(targetId)
    await this.send('Target.detachFromTarget', { sessionId })
  }

  /** Detach if the lease has gone idle. Returns whether it detached (for the sweep's logging). */
  maybeDetachIdle(now: number = this.now()): boolean {
    if (this.attached && !leaseIsActive(now, this._leaseActiveUntil)) {
      this.detachInternal()
      return true
    }
    return false
  }

  /** The session is ending (owner gone, project closed, app teardown): detach and reject in-flight. */
  release(): void {
    this.detachInternal()
    this._leaseActiveUntil = 0
    this.onLeaseChange(0)
  }

  /** The webContents was torn down under us: the attachment and every session id are already dead —
   *  forget them and reject in-flight, but do NOT call `detach()` on a gone target. (This is the
   *  second of the two invalidation points; the `detach` event usually beats us here, and this makes
   *  the teardown path correct even if it does not.) */
  handleTeardown(): void {
    this.onDetached()
    this._leaseActiveUntil = 0
    this.onLeaseChange(0)
  }

  // There is deliberately NO handoff-invalidation path: this design has no handoff (Task 4.3), so the
  // class of bug S8's third trigger guarded against cannot occur here. We removed the feature that
  // needed the care rather than reimplementing the care.

  private dispatch(method: string, params: object, sessionId: string | undefined): Promise<unknown> {
    try {
      this.ensureAttached()
    } catch (e) {
      return Promise.reject(e)
    }
    this.extendLease()
    const sent = sendCdp(this.dbg, method, params, this.currentCtx(), sessionId)
    if (sessionId === undefined && method === METRICS_OVERRIDE) {
      // Possibly applied from the moment it is sent, so the flag goes up BEFORE the reply.
      this.metricsOverridden = true
    } else if (sessionId === undefined && method === METRICS_OVERRIDE_CLEAR) {
      // Only a confirmed clear lowers it: one still in flight when a detach lands may never apply.
      void sent.then(() => { this.metricsOverridden = false }, () => {})
    }
    return this.race(sent)
  }

  /** The viewport the allowlist bounds a coordinate against: the last real measurement when we have
   *  one, else the injected placeholder. */
  private currentCtx(): CdpContext {
    return this._viewport ? { viewport: this._viewport } : this.viewport()
  }

  private ensureAttached(): void {
    if (this.attached) return
    try {
      this.dbg.attach('1.3')
    } catch {
      const msg = this.isDevToolsOpen()
        ? browserDevToolsOpenMessage(this.nodeId)
        : browserAttachFailedMessage(this.nodeId)
      throw new Error(msg)
    }
    this.attached = true
    // A detach we did not make (see `metricsOverridden`) left an override behind: clear it first.
    if (this.metricsOverridden) this.sendClearBestEffort()
  }

  /** Send the override clear without waiting (it is ordered before anything sent after it, and
   *  before a `detach()` that follows it). Errors are ignored: the page may already be gone. */
  private sendClearBestEffort(): void {
    this.metricsOverridden = false
    sendCdp(this.dbg, METRICS_OVERRIDE_CLEAR, {}, this.currentCtx(), undefined).catch(() => {})
  }

  private extendLease(): void {
    this._leaseActiveUntil = this.now() + LEASE_IDLE_MS
    this.onLeaseChange(this._leaseActiveUntil)
  }

  private detachInternal(): void {
    if (this.attached) {
      if (this.metricsOverridden) this.sendClearBestEffort()
      try {
        this.dbg.detach()
      } catch {
        // A detach on an already-gone target throws; the state cleanup below is what matters.
      }
    }
    this.onDetached()
  }

  private onDetached(): void {
    this.attached = false
    this.targets.clear()
    // A measured viewport belongs to the page we were attached to; drop it so it can never bound a
    // coordinate on a different page after a reattach.
    this._viewport = null
    this.rejectInFlight()
  }

  private rejectInFlight(): void {
    const rejectors = [...this.detachRejectors]
    this.detachRejectors.clear()
    for (const reject of rejectors) reject(new Error(BROWSER_LEASE_DETACHED))
  }

  private race<T>(p: Promise<T>): Promise<T> {
    let rejector!: (e: Error) => void
    const guard = new Promise<never>((_, reject) => {
      rejector = reject
      this.detachRejectors.add(rejector)
    })
    return Promise.race([p, guard]).finally(() => {
      this.detachRejectors.delete(rejector)
    }) as Promise<T>
  }
}

/**
 * Owns every live {@link BrowserSession}, keyed by node id. index.ts holds one of these (PR 7 wires
 * real guests to it; in PR 5 it is inert but real). Its `targetSessions` view — nodeId → (targetId →
 * sessionId) — is the S8 aggregate the child-session bookkeeping lives under.
 */
export class BrowserLeaseManager {
  private readonly sessions = new Map<string, BrowserSession>()

  get(nodeId: string): BrowserSession | undefined {
    return this.sessions.get(nodeId)
  }

  set(nodeId: string, session: BrowserSession): void {
    this.sessions.set(nodeId, session)
  }

  /** Release + drop one node's session (its guest is gone or its owner was released). */
  release(nodeId: string): void {
    const session = this.sessions.get(nodeId)
    if (!session) return
    session.release()
    this.sessions.delete(nodeId)
  }

  /** Idle sweep: detach every session whose lease has expired. Sessions stay in the map (they
   *  re-attach on the next verb); only the debugger attachment is dropped. */
  sweepIdle(now: number): void {
    for (const session of this.sessions.values()) session.maybeDetachIdle(now)
  }

  /** App teardown: release everything. */
  releaseAll(): void {
    for (const session of this.sessions.values()) session.release()
    this.sessions.clear()
  }
}
