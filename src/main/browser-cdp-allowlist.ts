/**
 * THE CDP allowlist. The single gate every command bound for `debugger.sendCommand` passes through
 * (the one caller is `browser-cdp-send.ts`, pinned structurally by this file's test). Default-DENY:
 * an unknown method, or a known method with a parameter the validator rejects, is REFUSED — nothing
 * falls through.
 *
 * It is NOT a set of method names. The danger in a page-side-eval command is not its name, it is one
 * parameter — and a name-keyed list also cannot express the URL check on Page.navigate. So the table
 * is (method, params-validator) pairs, each validator inspecting exactly the parameters that make its
 * method safe or not.
 *
 * Lives in `src/main`, enforced on the way into the debugger — NEVER in the renderer (the half an
 * XSS-in-a-node-title style bug lands in) and never in the shim or a skill document. Browser control
 * exists only on the Electron desktop; Server Edition / Mobile never reach here.
 *
 * Excluded outright and for stated reasons: arbitrary page-side evaluation
 * (Runtime.evaluate/compileScript/runScript/addBinding) and the whole Debugger domain (a second route
 * to it), Fetch (request interception is a proxy for the user's session), Security (can disable
 * certificate errors), Storage / IndexedDB / DOMStorage (the token stores this whole design exists to
 * keep out), DOM.getOuterHTML / getAttributes (the full-DOM read arriving by another door),
 * Page.bringToFront (a page that can raise itself can steal a click the user aimed elsewhere),
 * every Emulation method but the full-page screenshot's own sized override and its clear, and
 * Network.getAllCookies (one call empties the jar for every site the profile ever touched, and no
 * useful audit line names a domain). None of these is in the table, so default-deny refuses them.
 */
import { isNtScript } from './browser-nt-scripts'
import { normalizeAddress } from '@shared/browserUrl'
import { BROWSER_KEYS } from '../core/browser-verb'

/** What the gate needs to know about the page beyond the command itself: the viewport from the last
 *  `Page.getLayoutMetrics`, so a mouse coordinate can be bounded to what is actually on screen. */
export interface CdpContext {
  viewport: { width: number; height: number }
}

type Validator = (params: unknown, ctx: CdpContext) => boolean

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A CDP argument for the call-a-function-on-object method is safe ONLY if it carries a single scalar
 *  `value` — never an `objectId` (an agent-chosen live handle) and never a structured value (an
 *  object literal is a re-entry point for logic the NT_SCRIPTS scan never saw). */
function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}
function valueOnlyArgs(args: unknown): boolean {
  if (args === undefined) return true
  if (!Array.isArray(args)) return false
  return args.every(
    (a) =>
      isRecord(a) &&
      Object.keys(a).length === 1 &&
      Object.prototype.hasOwnProperty.call(a, 'value') &&
      isScalar(a.value)
  )
}

const MAX_SELECTOR = 1024
const MAX_INSERT_TEXT = 8192
/** The largest viewport side the full-page screenshot may request, in CSS px. A taller page is
 *  captured to this height and the reply says so (browser-screenshot.ts `FULL_PAGE_MAX_HEIGHT`). */
export const MAX_VIEWPORT_OVERRIDE = 16_384

/**
 * The cookie-JAR-MUTATING CDP methods, listed in ONE place so the decision is recorded, and pinned
 * UNREACHABLE by the verb-reachability guard in browser-cdp-allowlist.test.ts (PR 9 Task 9.4).
 *
 * `Network.setCookie` stays ADMITTED by the ALLOW table below (owner decision 5) so a future write
 * verb inherits a validated entry rather than a fresh, unreviewed one — but v1 ships NO verb that
 * emits any of these. The reason it is not merely "not built yet": a write verb needs a design nobody
 * has done — where does the agent get the cookie value, and what stops it planting an attacker's
 * session cookie for `accounts.google.com` so a later human visit to that node is a login the attacker
 * controls? A cookie write, when designed, needs a LOUDER trace than a read: a write is persistent and
 * silent, where a read is at least a one-time disclosure. So the list records the decision; the guard
 * proves no action reaches it.
 */
export const COOKIE_WRITE_METHODS = [
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Storage.setCookies',
  'Storage.clearCookies'
] as const

/** The dispatch types a key event may carry — a key-down, a key-up, or a raw key-down. There is
 *  deliberately NO `char` type: a character that types into the page belongs to `Input.insertText`
 *  (its own capped, data-only path), never to a key event. */
const KEY_EVENT_TYPES = new Set(['keyDown', 'keyUp', 'rawKeyDown'])

/** The ONLY editing commands a key event may drive — the two `--type --clear true` needs (select the
 *  field's contents, delete a selection). Anything else (`delete`, `insertText`, `moveToEndOfLine`…)
 *  is a strange, unaudited effect and is default-denied. */
const EDIT_COMMANDS = new Set(['selectAll', 'deleteBackward'])

/**
 * The table. Every entry is a (method, validator) pair. A Map — not a plain object — so a method
 * named `__proto__` / `constructor` can never resolve a validator off Object.prototype.
 */
const ALLOW = new Map<string, Validator>([
  // ---- Agent-facing verbs (PRs 7-8). Each validator inspects the parameters that make it safe. ----

  // The only navigation the agent can drive is to an http(s) URL, decided by the SAME
  // `normalizeAddress` the address bar uses — javascript:/file:/data: all normalize to null.
  ['Page.navigate', (p) => isRecord(p) && typeof p.url === 'string' && normalizeAddress(p.url) !== null],

  // Page-side logic runs ONLY as an NT_SCRIPTS entry, by identity, returning a value, with scalar
  // arguments. This is where the exclusion of arbitrary evaluation is actually enforced.
  [
    'Runtime.callFunctionOn',
    (p) =>
      isRecord(p) &&
      typeof p.functionDeclaration === 'string' &&
      isNtScript(p.functionDeclaration) &&
      p.returnByValue === true &&
      valueOnlyArgs(p.arguments)
  ],

  // A synthesized mouse event must land inside the reported viewport — a coordinate off-screen is
  // either a bug or an attempt to reach chrome the user cannot see. This one entry covers the click
  // (mousePressed/mouseReleased, Task 8.1) AND the scroll (a `mouseWheel` at the viewport centre,
  // Task 8.4): `Input.synthesizeScrollGesture` stays EXCLUDED (it is in the refused list), so the
  // wheel translation is the only scroll door and it is bounded by the same viewport check.
  [
    'Input.dispatchMouseEvent',
    (p, ctx) =>
      isRecord(p) &&
      typeof p.type === 'string' &&
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      p.x >= 0 &&
      p.y >= 0 &&
      p.x <= ctx.viewport.width &&
      p.y <= ctx.viewport.height
  ],

  // Typed text is capped; the text goes to insertText, never to a shell and never spliced anywhere.
  ['Input.insertText', (p) => isRecord(p) && typeof p.text === 'string' && p.text.length <= MAX_INSERT_TEXT],

  // A key event is NOT free key injection (PR 8, Tasks 8.2-8.3). It is default-deny in three ways at
  // once, and any one of them failing is a refusal:
  //   - `key`, if present, must be one of the fixed BROWSER_KEYS `--press` accepts (the SAME table the
  //     verb parser gates on — one source of truth) — never an arbitrary key;
  //   - `commands`, if present, must be a NON-EMPTY subset of the two editing commands `--clear` needs
  //     — never `insertText`/`delete`/a caret walk;
  //   - `text` is FORBIDDEN outright: a character that reaches the page is `Input.insertText`'s
  //     capped, data-only job, so a key event may never smuggle one.
  // At least one of key/commands must be present — an empty key event is meaningless — and the type
  // must be a real key-event type (no `char`).
  [
    'Input.dispatchKeyEvent',
    (p) => {
      if (!isRecord(p)) return false
      if (typeof p.type !== 'string' || !KEY_EVENT_TYPES.has(p.type)) return false
      if (p.text !== undefined) return false
      const keyOk = p.key === undefined || (typeof p.key === 'string' && (BROWSER_KEYS as readonly string[]).includes(p.key))
      if (!keyOk) return false
      const cmds = p.commands
      const hasCmds = cmds !== undefined
      const cmdsOk =
        !hasCmds || (Array.isArray(cmds) && cmds.length > 0 && cmds.every((c) => typeof c === 'string' && EDIT_COMMANDS.has(c)))
      if (!cmdsOk) return false
      return p.key !== undefined || (Array.isArray(cmds) && cmds.length > 0)
    }
  ],

  // A bounded selector against a known node.
  [
    'DOM.querySelector',
    (p) =>
      isRecord(p) &&
      typeof p.nodeId === 'number' &&
      typeof p.selector === 'string' &&
      p.selector.length <= MAX_SELECTOR
  ],

  // A shallow document read only (0 <= depth <= 1, no pierce) — the deep read is the full-DOM door
  // that getOuterHTML/getAttributes are excluded to keep shut. NEGATIVE depth is refused too: in CDP
  // `depth: -1` means the ENTIRE subtree, the same full-DOM read arriving by a signed-number door
  // (Task 7.6). Our own read code passes depth:0; this is the belt.
  [
    'DOM.getDocument',
    (p) =>
      isRecord(p) &&
      (p.depth === undefined || (typeof p.depth === 'number' && p.depth >= 0 && p.depth <= 1)) &&
      p.pierce !== true
  ],

  // A cookie READ must name at least one URL — never the whole jar (that is getAllCookies, excluded).
  [
    'Network.getCookies',
    (p) => isRecord(p) && Array.isArray(p.urls) && p.urls.length > 0 && p.urls.every((u) => typeof u === 'string')
  ],

  // Cookie WRITES stay LISTED so the allowlist records owner decision 5, but no verb reaches them in
  // v1 (pinned by PR 9 Task 9.4). A write needs one explicit domain — never a jar-wide write.
  [
    'Network.setCookie',
    (p) =>
      isRecord(p) &&
      typeof p.name === 'string' &&
      typeof p.value === 'string' &&
      typeof p.domain === 'string' &&
      p.domain.length > 0
  ],

  // A screenshot is PNG-only and its clip comes from OUR OWN box model (the layout metrics), never
  // from agent input — the path the agent supplies is jailed to the project dir in browser-screenshot.ts
  // and never reaches CDP. So the only agent influence here is "take a picture"; format is pinned to
  // png (no pdf/jpeg surface), and a clip, if present, must be numeric — a well-formed rectangle we
  // authored, not a structured re-entry point.
  [
    'Page.captureScreenshot',
    (p) => {
      if (!isRecord(p)) return false
      if (p.format !== undefined && p.format !== 'png') return false
      if (p.captureBeyondViewport !== undefined && typeof p.captureBeyondViewport !== 'boolean') return false
      if (p.clip !== undefined) {
        const c = p.clip
        if (!isRecord(c)) return false
        for (const k of ['x', 'y', 'width', 'height']) {
          if (typeof c[k] !== 'number') return false
        }
        if (c.scale !== undefined && typeof c.scale !== 'number') return false
      }
      return true
    }
  ],

  // `--screenshot --full true` (#539) sizes the page's viewport to its content for ONE capture, then
  // clears it. `captureBeyondViewport` alone is not a full-page render: MEASURED on Electron 42.9.1, a
  // scrolled page's sticky header came out at the stale scroll offset and a fixed footer mid-page.
  // The surface is the narrowest one that capture needs, and NO agent value reaches it — width and
  // height come from our own layout metrics (browser-screenshot.ts): exactly these four keys, a
  // bounded integer size, `deviceScaleFactor: 0` (keep the page's own) and `mobile: false`. No
  // screen orientation, no `viewport` sub-rect, no positions, no device emulation. A caller-chosen
  // size (a resize verb) would be a separate decision with its own validator. The override survives
  // a debugger detach, so its lifecycle lives in the lease (browser-lease.ts `metricsOverridden`).
  [
    'Emulation.setDeviceMetricsOverride',
    (p) => {
      if (!isRecord(p)) return false
      const keys = Object.keys(p).sort().join(',')
      if (keys !== 'deviceScaleFactor,height,mobile,width') return false
      const size = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_VIEWPORT_OVERRIDE
      return size(p.width) && size(p.height) && p.deviceScaleFactor === 0 && p.mobile === false
    }
  ],
  ['Emulation.clearDeviceMetricsOverride', (p) => isRecord(p) && Object.keys(p).length === 0],

  // ---- Session lifecycle (issued by the lease, browser-lease.ts, not by an agent verb). Still gated
  //      here so the "single gate" property is literal: every sendCommand, infra or not, is checked. ----

  ['Page.enable', () => true],
  ['DOM.enable', () => true],
  ['Runtime.enable', () => true],
  ['Page.getLayoutMetrics', () => true],
  // Enable the Network domain so `--nav` can read the MAIN-FRAME response status from
  // Network.responseReceived (an event feeding our own state — nothing is streamed to the agent,
  // asserted in browser-actions.test.ts). It carries no read power itself; getAllCookies stays out.
  ['Network.enable', () => true],
  // The final URL after a `--nav` (redirects resolved). Read-only, no parameters that matter.
  ['Page.getNavigationHistory', () => true],
  // The read family's chain: getDocument(depth<=1) → resolveNode(nodeId) → callFunctionOn → releaseObject.
  // resolveNode turns OUR shallow document node into an execution-context object handle for the frozen
  // NT_SCRIPTS reader; the nodeId comes from our own getDocument, never from the agent.
  ['DOM.resolveNode', (p) => isRecord(p) && typeof p.nodeId === 'number'],
  // Free the object handle callFunctionOn ran against. objectId is our own, from resolveNode.
  ['Runtime.releaseObject', (p) => isRecord(p) && typeof p.objectId === 'string' && p.objectId.length > 0],
  // Flat-mode child attach only (S8): a nested/auto-attach mode is a different, unaudited surface.
  [
    'Target.attachToTarget',
    (p) => isRecord(p) && p.flatten === true && typeof p.targetId === 'string' && p.targetId.length > 0
  ],
  ['Target.detachFromTarget', (p) => isRecord(p) && typeof p.sessionId === 'string']
])

/**
 * Is this exact (method, params) pair allowed, for this page context? Default-deny: an unknown
 * method returns false with NO per-method detail (an allowlist that explains itself is a probing
 * aid), and a validator that throws on a malformed payload is treated as a refusal.
 */
export function checkCdpCommand(method: string, params: unknown, ctx: CdpContext): boolean {
  const validate = ALLOW.get(method)
  if (!validate) return false
  try {
    return validate(params, ctx) === true
  } catch {
    return false
  }
}
