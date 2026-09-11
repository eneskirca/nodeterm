// The human gate in front of a canvas-control agent's DESTRUCTIVE verbs: who may waive the
// confirm dialog, for how long, and what may never waive it.
//
// WHY THIS FILE EXISTS AT ALL. The confirm dialog raised by `write` / `close` / `open-project`
// (Canvas.tsx's control dispatch) is the only place a human stands between an agent holding
// NODETERM_CANVAS_CONTROL and the user's workspace. Per-node identity is not fully enforced until
// `NODE_IDENTITY_STRICT_AFTER` (docs/node-identity.md), so until then a `legacy` caller — one we
// cannot judge — still reaches that dispatch. Everything here loosens that gate, so every rule is
// written to fail CLOSED, and every loosening is a setting the user can see and revoke.
//
// SURFACES. This is the DESKTOP gate and only the desktop gate. Server Edition canvas control
// (opt-in, `NODETERM_SERVER_CANVAS_CONTROL=1`) is HEADLESS and has no dialog to waive: its
// `close` is gated by verified node identity plus process-local creator ownership
// (`HeadlessNodeFactory.close` — "did this caller spawn that node during this server run"), which
// is a different mechanism, not a weaker copy of this one. Nothing here loosens it, and a waiver
// must never be plumbed into it: the server's rule does not ask a human at all, so "the human
// said don't ask again" has nothing to attach to. Mobile is N/A (the phone issues no control
// verbs).
//
// IN `src/shared` for the same two-sided reason as `control-verbs.ts`: the renderer decides
// (Canvas.tsx + the Settings section) and main owns the request timeout the expiry reads, and
// `tsconfig.web` gives the renderer no path into `src/main` or `src/core`.

import type { AgentPermissionMode } from './agents/config'

/**
 * How long main waits for the renderer's answer to one control request
 * (`src/main/index.ts`, `setControlHandler`'s pending-control timer).
 *
 * MOVED HERE from a local const in main because the renderer now needs the same number: a dialog
 * whose request has already expired must collect itself instead of sitting on `confirmBusy` and
 * refusing every later request (see `confirmExpiresAt`). Two copies of this number is exactly the
 * drift this repo keeps paying for — main's timer and the dialog's deadline are one fact.
 */
export const CONTROL_REQUEST_TIMEOUT_MS = 120_000

/**
 * The deadline a control confirm dialog should collect itself at, given when the renderer received
 * the request.
 *
 * Deliberately measured from the RENDERER's receipt, which is strictly LATER than main's — the IPC
 * hop sits in between — so the dialog always expires a hair AFTER main gave up, never before. The
 * other direction would abandon a dialog whose reply main would still have accepted.
 */
export function confirmExpiresAt(receivedAt: number): number {
  return receivedAt + CONTROL_REQUEST_TIMEOUT_MS
}

/**
 * The destructive verbs whose confirm a user MAY waive — a deliberate subset of
 * `DESTRUCTIVE_VERBS`.
 *
 * `open-project` is absent ON PURPOSE and must stay absent. It is the only one of the three that
 * widens the app's blast radius rather than acting inside it: it registers a new directory as a
 * project and records a grant the caller then feeds to `--project`. It also cannot produce the
 * dialog storm this waiver exists to end — its consent is already deduped per (caller, project)
 * by `recordAttachConsent`, so a repeat registration is silent anyway. A verb here must be one
 * whose repetition is the problem; `open-project`'s repetition is already solved.
 */
export const CONFIRM_WAIVABLE_VERBS: ReadonlySet<string> = new Set(['write', 'close'])

/** May this verb's confirm be waived at all? Table-driven, so "open-project can never be waived"
 *  is a tested fact rather than a line somebody forgot to write at one of three call sites. */
export function isWaivableVerb(verb: string): boolean {
  return CONFIRM_WAIVABLE_VERBS.has(verb)
}

/**
 * The persisted (machine-local) half of the waivers — `settings.controlConfirmWaivers`.
 *
 * NEVER `project.json`. A permission mode already travels through a git-shared project file, and
 * the whole trap this feature had to close is a cloned repo turning somebody's confirms off (see
 * `bypassMode`). A waiver is a statement about THIS machine's trust in its own agents; it has no
 * business in a file a teammate can commit.
 */
export interface ControlConfirmWaivers {
  /** Verbs waived PERMANENTLY on this machine. Only ever set from Settings → Agents — the dialog
   *  itself can grant the app-run waiver and nothing more, because a permanent security waiver
   *  must not be one stray checkbox click away in a dialog that appeared under the user's hands. */
  always?: string[]
  /**
   * Skip the confirm while the resolved permission mode is `bypassPermissions` — the "I already
   * told this agent to stop asking me" case.
   *
   * OFF by default, and it is an opt-in for a measured reason, not caution. The permission mode
   * lives in `.nodeterm/project.json`, which is git-shared: `project.defaultPermissionMode =
   * 'bypassPermissions'` travels to everyone who clones the repo. Binding the confirm to the mode
   * alone would let a cloned repository silently disable a user's destructive-action gate. So
   * there are TWO locks and both must be open: this machine-local opt-in, AND the mode having
   * come from the user's own GLOBAL setting (`permissionModeSource === 'global'`). A project
   * override never waives anything, whatever this is set to.
   */
  bypassMode?: boolean
}

/**
 * Where the resolved permission mode came from. `resolvePermissionMode` answers WHAT the mode is;
 * this answers WHO said so, which is the only thing that makes the bypass waiver safe.
 */
export type PermissionModeSource = 'project' | 'global' | 'default'

/** Why a confirm was skipped — carried into the user-visible notice, so a waived destructive
 *  action still announces itself and names the waiver that let it through. */
export type ConfirmWaiverVia = 'session' | 'always' | 'bypass'

export interface ControlConfirmDecision {
  /** True = apply the verb without a dialog. */
  skip: boolean
  /** Which waiver decided it (null when `skip` is false). */
  via: ConfirmWaiverVia | null
}

const ASK: ControlConfirmDecision = { skip: false, via: null }

/**
 * Does this destructive verb still need a dialog?
 *
 * Pure, and the ONLY place the three waivers are weighed — the dispatch cases call this and do as
 * they are told, so there is one table to audit rather than three `if`s in an 11,000-line
 * component.
 *
 * Order is precedence, and it is fail-closed at every step: an unwaivable verb never skips (the
 * `open-project` rule, applied before anything else is even read), a hand-edited `always` entry
 * naming an unwaivable verb is ignored rather than honoured, and the bypass lock demands both keys.
 */
export function decideControlConfirm(input: {
  verb: string
  /** Verbs waived for THIS APP RUN. In-memory only (renderer/state/controlConfirm.ts): a waiver
   *  the user granted in a dialog dies with the process, which is what makes it the safe default. */
  sessionWaived?: ReadonlySet<string>
  persisted?: ControlConfirmWaivers
  /** The mode a session launched right now would start in, and who chose it. */
  permissionMode?: AgentPermissionMode
  permissionModeSource?: PermissionModeSource
}): ControlConfirmDecision {
  const { verb, sessionWaived, persisted, permissionMode, permissionModeSource } = input
  // The gate that outranks every waiver: this verb's confirm is not the user's to waive.
  if (!isWaivableVerb(verb)) return ASK
  if (sessionWaived?.has(verb)) return { skip: true, via: 'session' }
  // No second table check here: the `isWaivableVerb(verb)` gate above already refuses a
  // hand-edited `always: ["open-project"]` before this line is reached (proven by the
  // open-project test's `always` case, and by mutating that gate). A duplicate check would be
  // unreachable code claiming to be a safeguard — this repo has shipped that mistake, and a
  // safeguard no test can turn red is a comment, not a mechanism.
  if (persisted?.always?.includes(verb)) return { skip: true, via: 'always' }
  // BOTH locks, per the `bypassMode` doc above: the machine-local opt-in and a mode the user set
  // globally. A `bypassPermissions` that arrived in a cloned `project.json` opens neither.
  if (
    persisted?.bypassMode === true &&
    permissionMode === 'bypassPermissions' &&
    permissionModeSource === 'global'
  ) {
    return { skip: true, via: 'bypass' }
  }
  return ASK
}

/**
 * Read `settings.controlConfirmWaivers` the way the gates must read it: hand-editable JSON,
 * sanitized at READ, exactly as `sanitizeKeybindingOverrides` is (`settings.json` is a file users
 * edit, and a garbage value there must degrade to "ask", never to "skip").
 *
 * Returns a fresh normalized object: unknown/unwaivable verb names dropped, duplicates collapsed,
 * `bypassMode` only ever the literal `true`.
 */
export function sanitizeControlConfirmWaivers(raw: unknown): ControlConfirmWaivers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as { always?: unknown; bypassMode?: unknown }
  const always = Array.isArray(o.always)
    ? [...new Set(o.always.filter((v): v is string => typeof v === 'string' && isWaivableVerb(v)))]
    : []
  const out: ControlConfirmWaivers = {}
  if (always.length) out.always = always
  if (o.bypassMode === true) out.bypassMode = true
  return out
}

/**
 * The user-visible line a dialog raises when it collects itself unanswered — ONE sentence for every
 * expiring dialog (`useExpiringDialog`), because a session that raises two differently-worded
 * notices for the same event reads as two different events.
 *
 * It says "nothing was done" and means it: every expiry path drops the dialog without performing
 * its action. A dialog whose expiry could leave work half-finished must not use this sentence.
 */
export function expiredDialogNotice(requestedBy?: string): string {
  return `The request from ${requestedBy ?? 'an agent'} expired before it was answered — nothing was done.`
}

/** The user-visible line a WAIVED destructive action raises (Canvas's info banner). A waiver
 *  makes the dialog go away — it must not make the ACTION go quiet, which is why this exists and
 *  why it names the waiver that let the action through. */
export function waivedNotice(action: string, via: ConfirmWaiverVia): string {
  const because =
    via === 'session'
      ? 'confirm waived for this app run'
      : via === 'always'
        ? 'confirm waived permanently'
        : 'confirm waived while the global permission mode is Bypass'
  return `${action} — ${because} (Settings → Agents).`
}
