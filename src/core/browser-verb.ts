/**
 * The `browser` verb's PURE argument table — the whole flag surface, decided once, in `src/core` so
 * both shells compile it and every consumer (the main drive path here in PR 7, the interaction and
 * cookie verbs in PRs 8-9) reads ONE parser rather than re-deriving the rules.
 *
 * WHY IT IS PURE AND SEPARATE FROM THE DRIVE. The security decision — owner, capability, the CDP
 * allowlist — is main-side and must never be reachable from the renderer or a shim (global
 * constraint 4, design §3.3). This file decides only the SHAPE of a request: which single action it
 * is, whether `--node` is present and safe, the timeout clamp, and the per-flag value rules. Nothing
 * here attaches a debugger, reads a page or trusts a caller field; a malformed call is a NAMED error,
 * never a guess.
 *
 * TWO RULES THAT OUTLIVE THE SHIM BUG (design §2.1). The canvas-control shim consumes the token after
 * a bare `--flag` (fixed in PR 1, but an already-connected SSH host keeps the old loop until it
 * reconnects — a stale window with no signal on the wire), so this verb is designed to parse
 * IDENTICALLY under both loops:
 *   1. every flag takes a value — there are no bare switches. `--clear`/`--full` take the literal
 *      string `"true"`, and `--press <key>` exists because `--enter true` would be a bare switch.
 *   2. exactly ONE action per call — zero is an empty request and two is an ambiguous one; both are
 *      refused rather than guessed, because a guess that drives a logged-in page is the wrong kind.
 *
 * `--node` is ALWAYS required and never inferred ("the one you have" is a guess), and it is validated
 * with `isSafeNodeId` BEFORE it is ever used to index a map — the salvage from S8's
 * requiredTabId/requiredString, which validated after the lookup.
 */
import { isSafeNodeId } from './remote-safety'
import { normalizeAddress } from '@shared/browserUrl'

/** The default and the hard ceiling for a per-verb timeout. The route's own ceiling is
 *  CONTROL_CEILING_MS (130s) and main's pending-control timeout is 120s, so a verb must never
 *  approach either — 60s leaves a wide margin. */
export const BROWSER_TIMEOUT_DEFAULT_MS = 15_000
export const BROWSER_TIMEOUT_MAX_MS = 60_000

/** The named keys `--press` accepts. No function keys, no chords — only what a real form needs
 *  (Enter/Tab to move and submit, the arrows/paging to move a caret or a list selection). A key
 *  outside this set is a NAMED refusal, never passed through to `Input.dispatchKeyEvent`. */
export const BROWSER_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End'
] as const
export type BrowserKey = (typeof BROWSER_KEYS)[number]

/** The four read modes. There is deliberately NO `html` mode and no full-DOM mode (design §2.4,
 *  enforced again at the allowlist): innerText semantics exclude the hidden inputs, data-* attributes
 *  and inline <script> blobs where sites keep tokens; an HTML mode re-includes all of it. */
export const BROWSER_READ_MODES = ['text', 'map', 'links', 'title'] as const
export type BrowserReadMode = (typeof BROWSER_READ_MODES)[number]

/** The valid `--scroll` targets: a named edge/step or a signed pixel count. */
const SCROLL_WORDS = ['up', 'down', 'top', 'bottom'] as const

/** Exactly one of these is the call's action. The order is the refusal-listing order, but presence,
 *  not order, is what "exactly one" counts. */
export const BROWSER_ACTION_KEYS = [
  'nav',
  'read',
  'click',
  'type',
  'press',
  'scroll',
  'wait',
  'screenshot',
  'cookies'
] as const

export const BROWSER_FLAGS: ReadonlySet<string> = new Set([
  ...BROWSER_ACTION_KEYS, 'node', 'timeout', 'clear', 'full', 'into', 'selector', 'max', 'times'
])

export type BrowserAction =
  | { kind: 'nav'; url: string }
  | { kind: 'read'; mode: BrowserReadMode }
  | { kind: 'click'; target: string }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: BrowserKey }
  | { kind: 'scroll'; where: string }
  | { kind: 'wait'; target: string }
  | { kind: 'screenshot'; path: string }
  | { kind: 'cookies'; domain: string }

export interface BrowserCall {
  /** The drivable browser node. Required, safe-id-validated, never inferred. */
  node: string
  /** The single action this call performs. */
  action: BrowserAction
  /** The clamped timeout, always in `[_, BROWSER_TIMEOUT_MAX_MS]`, defaulting to the default. */
  timeoutMs: number
  /** `--clear true` — clear a field before `--type`. A modifier, never an action. */
  clear: boolean
  /** `--full true` — a full-page variant (read/screenshot). A modifier, never an action. */
  full: boolean
  /** `--into <ref>` — the field `--type` targets. */
  into?: string
  /** `--selector <css>` — scopes `--read text`; also a click/wait handle. */
  selector?: string
  /** `--max <n>` — the `--read text` cap (drive-side clamps to its own ceiling). */
  max?: number
  /** `--times <n>` — repeat count for `--press`. */
  times?: number
}

const err = (message: string): { error: string } => ({ error: message })

function presentActionKeys(args: Record<string, string>): string[] {
  return BROWSER_ACTION_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(args, k))
}

/** `--timeout`: absent/invalid → the default; anything valid clamped to the ceiling. Never below
 *  1ms and never above the ceiling, so a caller can neither hang the route nor pass 0. */
function clampTimeout(raw: string | undefined): number {
  if (raw === undefined) return BROWSER_TIMEOUT_DEFAULT_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return BROWSER_TIMEOUT_DEFAULT_MS
  return Math.min(n, BROWSER_TIMEOUT_MAX_MS)
}

/** A positive integer flag (`--max`, `--times`), or undefined when absent/invalid — the drive path
 *  supplies its own default rather than trusting a partial parse. */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function buildAction(key: string, value: string): BrowserAction | { error: string } {
  switch (key) {
    case 'nav': {
      // The SAME scheme check the address bar and the allowlist use — javascript:/file:/data: all
      // normalize to null, so this refuses them here with a readable message rather than at the gate.
      if (normalizeAddress(value) === null) {
        return err('browser: --nav needs an http(s) URL')
      }
      return { kind: 'nav', url: value }
    }
    case 'read': {
      if (!(BROWSER_READ_MODES as readonly string[]).includes(value)) {
        // The exact wording is a contract (the tests pin it): text|map|links|title.
        return err('browser: --read takes text|map|links|title')
      }
      return { kind: 'read', mode: value as BrowserReadMode }
    }
    case 'click': {
      if (!value) return err('browser: --click takes a @ref or a CSS selector')
      return { kind: 'click', target: value }
    }
    case 'type': {
      // Empty text is allowed (a --clear with no new text is a legitimate call); the drive path caps
      // the length at the allowlist's 8192.
      return { kind: 'type', text: value }
    }
    case 'press': {
      if (!(BROWSER_KEYS as readonly string[]).includes(value)) {
        return err(`browser: --press takes one of: ${BROWSER_KEYS.join(', ')}`)
      }
      return { kind: 'press', key: value as BrowserKey }
    }
    case 'scroll': {
      const named = (SCROLL_WORDS as readonly string[]).includes(value)
      const pixels = /^[+-]?\d+$/.test(value)
      if (!named && !pixels) {
        return err('browser: --scroll takes up, down, top, bottom, or a signed pixel count')
      }
      return { kind: 'scroll', where: value }
    }
    case 'wait': {
      if (!value) return err('browser: --wait takes a @ref or a CSS selector')
      return { kind: 'wait', target: value }
    }
    case 'screenshot': {
      if (!value) return err('browser: --screenshot takes a file path')
      return { kind: 'screenshot', path: value }
    }
    case 'cookies': {
      // The PR 9 wording, kept here so the parser owns the whole table and the message never drifts.
      if (!value) return err('browser: --cookies takes one domain (use "current" for the page\'s own)')
      return { kind: 'cookies', domain: value }
    }
    default:
      return err(`browser: unknown action --${key}`)
  }
}

/**
 * Validate a raw `browser` arg map into a {@link BrowserCall}, or return `{ error }`. Pure and
 * total — every path returns one or the other, and a throw inside a value check is impossible because
 * every value is already a string off the form body.
 *
 * Order matters and is asserted: `--node` presence, then `--node` SAFETY (before any map lookup can
 * ever use it), then the exactly-one-action count, then the single action's own value rule. A caller
 * missing `--node` is told about `--node` even when it also passed a valid action, because the node
 * is the thing that decides WHICH logged-in page this drives.
 */
export function parseBrowserArgs(args: Record<string, string>): BrowserCall | { error: string } {
  const node = args.node
  if (!node) return err('browser: --node <id> is required')
  if (!isSafeNodeId(node)) return err(`browser: --node "${node}" is not a valid node id`)

  const unknown = Object.keys(args).find((key) => !BROWSER_FLAGS.has(key))
  if (unknown) return err(`browser: unknown flag --${unknown}`)

  const actions = presentActionKeys(args)
  if (actions.length !== 1) {
    return err('browser: pass exactly one action (--nav, --read, --click, --type, --press, --scroll, --wait, --screenshot or --cookies)')
  }

  const action = buildAction(actions[0], args[actions[0]] ?? '')
  if ('error' in action) return action

  return {
    node,
    action,
    timeoutMs: clampTimeout(args.timeout),
    clear: args.clear === 'true',
    full: args.full === 'true',
    into: args.into || undefined,
    selector: args.selector || undefined,
    max: positiveInt(args.max),
    times: positiveInt(args.times)
  }
}
