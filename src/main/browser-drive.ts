/**
 * THE drive gate and orchestration for the `browser` verb. This is where browser driving goes live:
 * everything before PR 7 was inert machinery, and this module is the producer that attaches a lease
 * and drives a real guest. So it is the highest-stakes security surface of the set, and its whole
 * job is to REFUSE before it drives, in a fixed order, main-side, trusting no caller field.
 *
 * THE ORDER IS THE REQUIREMENT (design §2.3, Task 7.2), and every step fails closed:
 *   1. IDENTITY — a non-`verified` caller is refused before anything else, because the promise of a
 *      refusal is that nothing happened. (`browser` is verified-only via STRICT_CONTROL_VERBS, which
 *      hook-server enforces before this handler; this is the belt.)
 *   2. canControlCanvas — the source agent kind must be canvas-control-capable.
 *   3. the PER-PROJECT capability, read LIVE at drive time — a switch on at attach but now off
 *      (including a project.json hand-edit) REFUSES and REVOKES (carried obligation, PR 6/#307
 *      MINOR-2). The message is the design's verbatim sentence: the agent cannot turn it on itself.
 *   4. LEDGER OWNERSHIP — before ANY attach, `browser-control-ledger.get()` keyed on the
 *      cryptographically-verified caller node id must return this owner's entry (carried obligation,
 *      PR 5/#306 MINOR-2). "Does not exist" and "exists but is not yours" are the SAME message —
 *      a different one is a node-enumeration oracle. A node the USER stopped (#307 tombstone) is
 *      refused with the named human act and cannot re-drive until a fresh verified `claim()`.
 *   5. DISCARD — a node whose page the memory saver released is a lifecycle refusal, never a
 *      permissions one.
 *
 * Only after all five does a debugger attach (lazily, on the first send inside {@link browserNav}/
 * the reads), so a refused caller never causes an attachment. `src/main`, never Server Edition.
 */
import {
  BrowserControlLedger,
  BROWSER_USER_STOPPED,
  type AgentBrowserEntry
} from './browser-control-ledger'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import { browserDiscardedMessage } from './browser-guest-registry'
import {
  browserNav,
  browserRead,
  browserClick,
  browserType,
  browserPress,
  browserScroll,
  browserWait,
  type ActionResult,
  type Sendable,
  type Driver,
  type CdpEventBus
} from './browser-actions'
import { browserScreenshot, type ScreenshotDeps } from './browser-screenshot'
import { browserCookies } from './browser-cookies'
import type { RefTable } from './browser-refs'
import type { BrowserCall } from '../core/browser-verb'
import type { BoardLogEntry } from '../shared/types'
import { randomUUID } from 'node:crypto'

/** The design's verbatim capability-off sentence. The last clause STOPS an agent burning a turn
 *  trying to enable it. Exported so the wiring and the tests share the one string. */
export const BROWSER_CAPABILITY_OFF_MESSAGE =
  "Browser control is off for this project. The user can turn it on in the project's Agents settings; you cannot."

/** The refusal when the source node is not a control-capable agent (step 2). Same wording every
 *  other verb's renderer path uses, so the caller learns the same way. */
export const BROWSER_SOURCE_NOT_CAPABLE = 'source node is not a control-capable agent'

/** "Does not exist" AND "exists but is not yours" — ONE message, adopted verbatim from S8's
 *  requireTab, because a distinct message is a node-enumeration oracle. */
export const noDrivableNodeMessage = (id: string): string => `no drivable browser node "${id}"`

/** What the renderer alone knows, answered over the resolve round-trip: the owning project of the
 *  source, whether the source is control-capable, and the LIVE per-project capability value. Main
 *  makes the security DECISION from this; the renderer never runs a CDP command. */
export type BrowserResolve =
  | {
      ok: true
      projectId: string
      projectCwd?: string
      sourceControlCapable: boolean
      capabilityOn: boolean
      /** The owner agent node's title and the browser node's title — what the renderer alone knows,
       *  used ONLY to make the cookie-read trace human-readable (`from` / `title`). Never a security
       *  input; the gate decides from projectId/capability/ownership. */
      sourceTitle?: string
      browserTitle?: string
    }
  | { ok: false; refusal: string }

/** The resolve round-trip's own short ceiling. Kept far under main's 120s pending-control budget and
 *  the route's 130s ceiling: a canvas that does not answer is a NAMED failure in 2s, never a hang
 *  that eats the whole budget while the agent waits. */
export const BROWSER_RESOLVE_TIMEOUT_MS = 2000

/** The resolve failed to come back in time. A named, retryable refusal — not a hang, not a
 *  permissions verdict. */
export const browserResolveTimedOut = (id: string): string =>
  `browser: the canvas did not answer for ${id} in time — try again`

/**
 * Ask the renderer to resolve a browser target, but never let that round-trip hang: it races the
 * renderer's answer against a 2s timeout, and a rejection (the window went away) is the same named
 * failure. This is the piece that keeps a slow/absent canvas from consuming the 120s pending-control
 * budget — injected `ask` so the timeout behaviour is unit-testable without Electron.
 */
export async function resolveBrowserTarget(
  browserNodeId: string,
  ask: () => Promise<BrowserResolve>,
  timeoutMs: number = BROWSER_RESOLVE_TIMEOUT_MS
): Promise<BrowserResolve> {
  const timedOut: BrowserResolve = { ok: false, refusal: browserResolveTimedOut(browserNodeId) }
  const timeout = new Promise<BrowserResolve>((resolve) => setTimeout(() => resolve(timedOut), timeoutMs))
  const answer = ask().catch((): BrowserResolve => timedOut)
  return Promise.race([answer, timeout])
}

export interface DriveGateInput {
  browserNodeId: string
  /** The cryptographically-verified caller node id (main's own verdict, #304). */
  ownerNodeId: string
  /** main's own `verdict === 'verified'` for THIS request — never a wire/caller field. */
  verified: boolean
  resolve: BrowserResolve
  ledger: BrowserControlLedger
  /** Is there a live canvas guest for this node (else the memory saver released it)? */
  guestPresent: boolean
}

export type DriveGate =
  | { kind: 'refuse'; message: string; revoke: boolean }
  | { kind: 'drive'; entry: AgentBrowserEntry }

/**
 * The pure decision. Returns the single refusal (with whether to also revoke) or a go-ahead carrying
 * the ledger entry. No I/O, no attach — so the ordering is unit-testable exactly.
 */
export function gateBrowserDrive(input: DriveGateInput): DriveGate {
  // 1. identity
  if (!input.verified) return { kind: 'refuse', message: STRICT_CONTROL_REFUSAL, revoke: false }
  // (resolve failed → the source is not on an open canvas at all; a named, non-revoking refusal)
  if (!input.resolve.ok) return { kind: 'refuse', message: input.resolve.refusal, revoke: false }
  // 2. canControlCanvas
  if (!input.resolve.sourceControlCapable) {
    return { kind: 'refuse', message: BROWSER_SOURCE_NOT_CAPABLE, revoke: false }
  }
  // 3. per-project capability, LIVE — and a now-off switch revokes as well as refuses.
  if (!input.resolve.capabilityOn) {
    return { kind: 'refuse', message: BROWSER_CAPABILITY_OFF_MESSAGE, revoke: true }
  }
  // 4. ledger ownership — before any attach. Tombstone (user-Stopped) is named; everything else is
  //    the one non-enumerating message.
  const entry = input.ledger.get(input.browserNodeId, input.ownerNodeId)
  if (!entry) {
    if (input.ledger.wasStoppedByUser(input.browserNodeId, input.ownerNodeId)) {
      return { kind: 'refuse', message: BROWSER_USER_STOPPED, revoke: false }
    }
    return { kind: 'refuse', message: noDrivableNodeMessage(input.browserNodeId), revoke: false }
  }
  // 5. discard
  if (!input.guestPresent) {
    return { kind: 'refuse', message: browserDiscardedMessage(input.browserNodeId), revoke: false }
  }
  return { kind: 'drive', entry }
}

/** The live control session + event bus for a node's CANVAS guest (Task 2.2: the canvas surface is
 *  the only drivable one). Attaching is LAZY inside the session, so getting one costs no debugger
 *  attach — that is what keeps "ledger.get before any attach" true. */
export interface LiveGuest {
  session: Sendable
  bus: CdpEventBus
}

export interface DriveDeps {
  ledger: BrowserControlLedger
  refs: RefTable
  /** The canvas guest's session+bus, or null when its page was released (discard). MUST NOT attach. */
  sessionFor(browserNodeId: string): LiveGuest | null
  /** Detach + drop ownership + tombstone — invoked when a live capability read comes back OFF. */
  revoke(browserNodeId: string): void
  /** Append one line to a project's board log, in-process (no IPC round-trip) — the cookie-read
   *  trace (PR 9). Returns false when there is no reachable log or the write failed; the cookie read
   *  is refused in that case (fail-closed). Absent ⇒ tracing is unavailable and `--cookies` refuses. */
  appendBoardLog?(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /** The filesystem the screenshot path-jail + write use (PR 9). Absent ⇒ `--screenshot` refuses. */
  screenshotIO?: ScreenshotDeps
}

/** What only the resolve knows, threaded to the two PR-9 actions: the project the trace/screenshot
 *  belong to, its cwd (the screenshot jail root), and the titles the cookie trace reads. */
interface RunContext {
  browserNodeId: string
  ownerNodeId: string
  projectId: string
  projectCwd?: string
  sourceTitle?: string
  browserTitle?: string
}

/** Build the cookie-read trace entry: it files under the OWNER agent node's card (`nodeId`), names
 *  the owner in `from`, the domain in `to`, and the browser node in `title`. */
function cookieTraceEntry(ctx: RunContext, domain: string): BoardLogEntry {
  const from = ctx.sourceTitle || ctx.ownerNodeId
  return {
    id: randomUUID(),
    ts: Date.now(),
    author: { name: from, color: '#c2703d' },
    nodeId: ctx.ownerNodeId,
    kind: 'event',
    event: {
      type: 'agent-read-cookies',
      from,
      to: domain,
      title: ctx.browserTitle || ctx.browserNodeId
    }
  }
}

async function runAction(
  call: BrowserCall,
  guest: LiveGuest,
  refs: RefTable,
  ctx: RunContext,
  deps: DriveDeps
): Promise<ActionResult> {
  const a = call.action
  const nodeId = ctx.browserNodeId
  // The pointer verbs need the viewport-refreshing capability; the session is a Driver at runtime.
  const driver = guest.session as Driver
  switch (a.kind) {
    case 'nav':
      return browserNav(guest.session, guest.bus, nodeId, a.url, call.timeoutMs)
    case 'read':
      return browserRead(guest.session, guest.bus, refs, nodeId, a.mode, {
        selector: call.selector,
        max: call.max
      })
    case 'click':
      return browserClick(driver, refs, nodeId, a.target)
    case 'type':
      return browserType(driver, refs, nodeId, { text: a.text, into: call.into, clear: call.clear })
    case 'press':
      return browserPress(guest.session, nodeId, a.key, call.times ?? 1)
    case 'scroll':
      return browserScroll(driver, nodeId, a.where)
    case 'wait':
      return browserWait(guest.session, refs, nodeId, a.target, call.timeoutMs)
    case 'screenshot':
      if (!deps.screenshotIO) return { ok: false, message: 'browser: screenshots are unavailable in this build' }
      return browserScreenshot(driver, nodeId, ctx.projectCwd, a.path, { full: call.full }, deps.screenshotIO)
    case 'cookies':
      // The trace goes through the board log; if there is no appender wired, the read cannot be
      // recorded, so it must not happen (fail-closed, same as an append that returns false).
      return browserCookies(guest.session, nodeId, a.domain, {
        recordTrace: (domain) =>
          deps.appendBoardLog
            ? deps.appendBoardLog(ctx.projectId, cookieTraceEntry(ctx, domain))
            : Promise.resolve(false)
      })
  }
}

/**
 * Gate, then drive. The one entry point main wires the verb to. A refusal that carries `revoke`
 * detaches+drops first; a go-ahead runs the action, converting any thrown allowlist/lease refusal
 * into a named `ok:false` (never a hang, never a raw Electron error).
 */
const activeActions = new WeakSet<Sendable>()

export async function driveBrowser(
  input: { call: BrowserCall; ownerNodeId: string; verified: boolean; resolve: BrowserResolve },
  deps: DriveDeps
): Promise<ActionResult> {
  const guest = deps.sessionFor(input.call.node)
  const gate = gateBrowserDrive({
    browserNodeId: input.call.node,
    ownerNodeId: input.ownerNodeId,
    verified: input.verified,
    resolve: input.resolve,
    ledger: deps.ledger,
    guestPresent: guest !== null
  })
  if (gate.kind === 'refuse') {
    if (gate.revoke) deps.revoke(input.call.node)
    return { ok: false, message: gate.message }
  }
  // guestPresent was true, so `guest` is non-null; the check keeps the type honest.
  if (!guest) return { ok: false, message: browserDiscardedMessage(input.call.node) }
  // Do not measure/click a target while another action is still scrolling the same page.
  if (activeActions.has(guest.session)) return { ok: false, message: 'browser: another action is still running on this page; wait for it to finish' }
  activeActions.add(guest.session)
  const ctx: RunContext = {
    browserNodeId: input.call.node,
    ownerNodeId: input.ownerNodeId,
    projectId: gate.entry.projectId,
    projectCwd: input.resolve.ok ? input.resolve.projectCwd : undefined,
    sourceTitle: input.resolve.ok ? input.resolve.sourceTitle : undefined,
    browserTitle: input.resolve.ok ? input.resolve.browserTitle : undefined
  }
  try {
    return await runAction(input.call, guest, deps.refs, ctx, deps)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'browser: the command failed' }
  } finally {
    activeActions.delete(guest.session)
  }
}
