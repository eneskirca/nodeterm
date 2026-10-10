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
 * `settings` is absent ON PURPOSE and must stay absent: a settings change can GRANT a capability
 * (`agentMessaging`, @shared/settings-verb), and a standing "don't ask again" that covered it would
 * let an agent hand itself a power on the strength of an answer the human gave about something
 * else. A CLI that could waive its own consent would make the consent decorative.
 *
 * `open-project` WAS absent, on the claim that it "cannot produce the dialog storm this waiver
 * exists to end — its consent is already deduped per (caller, project) by `recordAttachConsent`".
 * Read what that dedupe is keyed on: the caller's NODE id, in memory, for one app run
 * (`lib/projectOpen.ts`). So every new orchestrator session asks again, every station a team
 * spawns that calls `open-project` asks again, and every restart asks again, about the same two
 * projects the user already said yes to — which is the field report (2026-10): an orchestrator in
 * one project opening sessions in another, a dialog each time, and no box to stop it. The dedupe
 * stays (it still silences an idempotent repeat by the same caller); it was never a reason to
 * withhold the box.
 *
 * Waiving it does not widen what the verb CAN do, only whether the human is asked. Everything that
 * bounds it is enforced before the renderer sees the request and is untouched: a verified caller,
 * local projects only, an absolute existing `--cwd`, the per-caller grant cap, and a registration
 * that never focuses a tab. Its waiver is keyed on the CALLER's project like `write`/`close` — the
 * trust being expressed is "the agents in that repo", and for a create/adopt there is no target
 * project yet to key on — and a waived registration still announces itself (`waivedNotice`).
 */
export const CONFIRM_WAIVABLE_VERBS: ReadonlySet<string> = new Set(['write', 'close', 'open-project'])

/** May this verb's confirm be waived at all? Table-driven, so "settings can never be waived" is a
 *  tested fact rather than a line somebody forgot to write at one of the call sites. */
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
  /** Verbs waived PERMANENTLY on this machine, in EVERY project. Only ever set from Settings →
   *  Agents — the dialog itself may not grant this one, because a permanent MACHINE-WIDE security
   *  waiver must not be one stray checkbox click away in a dialog that appeared under the user's
   *  hands. That reasoning is about the SCOPE, not about permanence: see `projects` below. */
  always?: string[]
  /**
   * Verbs waived permanently but only inside ONE project — `{ [projectId]: verbs }`.
   *
   * The narrower grant that makes the dialog's offer honest. "Don't ask again" that lasts only
   * until the next restart is not what a user who ticks it means, and the only durable answer used
   * to be a machine-wide switch buried in Settings — so the realistic choices were "be asked
   * forever" or "turn it off everywhere". A user who trusts the orchestrator in one repo should be
   * able to say exactly that, and this is the scope the DIALOG may therefore grant: it is bounded
   * by a project the user is looking at, revocable from Settings, and it cannot follow them into
   * the repo where they do not trust it. The project tab's "Agents may, without asking" menu sets
   * the same entries up front, before any dialog has appeared; every writer goes through
   * `withProjectWaiver`.
   *
   * SHAPE follows `settings.sidebarCollapsedItems`, the established per-project machine-local
   * state, PRUNING INCLUDED (`pruneControlConfirmWaivers`): settings.json is forever and project
   * ids are not, so without it the file accumulates an entry per project that ever existed, each
   * one a live security waiver keyed to an id nothing can show the user any more.
   *
   * MACHINE-LOCAL, like everything else in this interface. A per-project waiver is emphatically
   * NOT `.nodeterm/project.json`: that file is git-shared, and a cloned repo must never be able to
   * turn somebody's confirms off — the same trap `bypassMode` needs two locks for. Keying on the
   * project ID in `settings.json` is what keeps "in this project" a statement this machine's user
   * made about this machine.
   */
  projects?: Record<string, string[]>
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
 *  action still announces itself and names the waiver that let it through. Losing the dialog must
 *  not mean losing the record, and "which of my four waivers did this" is the part of the record a
 *  user needs in order to revoke the right one. */
export type ConfirmWaiverVia = 'session' | 'project' | 'always' | 'bypass'

/**
 * What the user picked under an agent-requested confirm: no waiver (`ask`), the durable
 * per-project one, or the app-run one.
 */
export type ConfirmWaiveChoice = 'ask' | 'project' | 'session'

/**
 * The "don't ask again" choices an agent-requested confirm offers, in display order — ONE
 * definition, because each label is a promise the grant in Canvas's `onConfirm` has to keep.
 *
 * Shown as radios from the start, with `ask` selected. It used to be a checkbox whose reaches
 * appeared only once it was ticked, defaulting to the app-run one — so the per-project answer
 * ("stop asking me about the agents in this repo") was invisible until the user had already said
 * yes to something else, which is how it read as missing (2026-10 report). Radios keep the old
 * guarantee that an untouched dialog grants nothing: `ask` is pre-selected and is not a waiver.
 *
 * The labels say exactly what each reach covers, because the two are not the same shape: the
 * project choice is keyed on the CALLER's project and survives restarts; the app-run choice is
 * per VERB in every project (`state/controlConfirm.ts`) and dies with the process. A label that
 * hung "until nodeterm quits" under "for agents in A" would promise a project bound the app-run
 * waiver does not have.
 *
 * The project is NAMED, never "this project": canvas control answers a background agent in its
 * own project without moving the user's tab (@shared/control-off-screen), so "this" would point at
 * whatever canvas the user happens to be looking at. With no project to name (the call's project
 * could not be resolved) the per-project choice is not offered at all — offering it would promise a
 * grant `waiveControlConfirmForProject` would then refuse.
 */
export function waiveChoices(project?: {
  id?: string
  name?: string
}): { value: ConfirmWaiveChoice; label: string }[] {
  const out: { value: ConfirmWaiveChoice; label: string }[] = [
    { value: 'ask', label: 'Ask me again next time' }
  ]
  if (project?.id) {
    out.push({
      value: 'project',
      label: `Don\u2019t ask again for agents in "${project.name || 'this project'}"`
    })
  }
  out.push({ value: 'session', label: 'Don\u2019t ask again in any project until nodeterm quits' })
  return out
}

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
 * `settings` rule, applied before anything else is even read), a hand-edited `always` entry
 * naming an unwaivable verb is ignored rather than honoured, and the bypass lock demands both keys.
 */
export function decideControlConfirm(input: {
  verb: string
  /** Verbs waived for THIS APP RUN. In-memory only (renderer/state/controlConfirm.ts): a waiver
   *  the user granted in a dialog dies with the process, which is what makes it the safe default. */
  sessionWaived?: ReadonlySet<string>
  persisted?: ControlConfirmWaivers
  /**
   * The project this request ACTS ON — the caller's own project, which is not necessarily the one
   * on screen: canvas control routes by source, and a background agent's `write`/`close` is now
   * answered in its own project without the user's tab moving (@shared/control-off-screen). The
   * waiver that applies is the one the user granted for THAT project; reading the active project
   * here would let a waiver granted in the repo they trust cover a call made from the one they do
   * not. Absent (or unknown) simply means no per-project waiver applies — fail closed.
   */
  projectId?: string
  /** The mode a session launched right now would start in, and who chose it. */
  permissionMode?: AgentPermissionMode
  permissionModeSource?: PermissionModeSource
}): ControlConfirmDecision {
  const { verb, sessionWaived, persisted, projectId, permissionMode, permissionModeSource } = input
  // The gate that outranks every waiver: this verb's confirm is not the user's to waive.
  if (!isWaivableVerb(verb)) return ASK
  if (sessionWaived?.has(verb)) return { skip: true, via: 'session' }
  // Narrowest persisted grant before the widest: a user with both set has said something true
  // about this project AND something true about the machine, and naming the narrower one in the
  // notice points them at the waiver they most likely want back. `projectId` must be a real id —
  // `undefined` would otherwise index the map with the string "undefined" and match a hand-edited
  // entry of that name.
  if (projectId && persisted?.projects?.[projectId]?.includes(verb)) {
    return { skip: true, via: 'project' }
  }
  // No second table check here: the `isWaivableVerb(verb)` gate above already refuses a
  // hand-edited `always: ["settings"]` before this line is reached (proven by the
  // settings test's `always` case, and by mutating that gate). A duplicate check would be
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
  const o = raw as { always?: unknown; projects?: unknown; bypassMode?: unknown }
  const verbs = (v: unknown): string[] =>
    Array.isArray(v)
      ? [...new Set(v.filter((x): x is string => typeof x === 'string' && isWaivableVerb(x)))]
      : []
  const always = verbs(o.always)
  const out: ControlConfirmWaivers = {}
  if (always.length) out.always = always
  // Per-project entries get the SAME treatment as `always` — the verb table decides, so a
  // hand-edited `{"p1":["settings"]}` is dropped rather than honoured — plus a key check the
  // flat list does not need. An empty verb list is dropped with its key: an entry that waives
  // nothing is indistinguishable from no entry to every reader, and keeping it would leave a row
  // in Settings offering to revoke a waiver that does not exist.
  if (o.projects && typeof o.projects === 'object' && !Array.isArray(o.projects)) {
    const projects: Record<string, string[]> = {}
    for (const [id, list] of Object.entries(o.projects as Record<string, unknown>)) {
      if (!id) continue
      const kept = verbs(list)
      if (kept.length) projects[id] = kept
    }
    if (Object.keys(projects).length) out.projects = projects
  }
  if (o.bypassMode === true) out.bypassMode = true
  return out
}

/**
 * Drop per-project waivers whose project no longer exists — the rule
 * `pruneCollapsedItems`/`liveCollapseKeys` states for `settings.sidebarCollapsedItems`, applied to
 * a map whose stale entries are worse than clutter: each one is a live security waiver keyed to an
 * id nothing in the UI can name any more, and a project id is reused by nothing, so it can only
 * ever rot.
 *
 * `live` is EVERY project the store holds, CLOSED ones included — `closeProject` keeps the project
 * and its nodes on disk and its sessions running, so a closed project is parked, not gone. Pruning
 * on the open tabs would silently revoke a waiver the user still has a canvas for.
 *
 * Returns the SAME object when nothing would change, so a no-op write never marks settings dirty.
 */
export function pruneControlConfirmWaivers(
  waivers: ControlConfirmWaivers,
  live: ReadonlySet<string>
): ControlConfirmWaivers {
  const projects = waivers.projects
  if (!projects) return waivers
  const dead = Object.keys(projects).filter((id) => !live.has(id))
  if (dead.length === 0) return waivers
  const kept: Record<string, string[]> = {}
  for (const [id, verbs] of Object.entries(projects)) if (live.has(id)) kept[id] = verbs
  const out: ControlConfirmWaivers = { ...waivers }
  if (Object.keys(kept).length) out.projects = kept
  else delete out.projects
  return out
}

/**
 * Turn ONE verb's per-project waiver on or off — the single write every surface goes through: the
 * dialog's "Don't ask again for agents in …", the project tab menu's per-project toggle, and the
 * revoke row in Settings → Agents. One merge, so the three cannot drift apart on the prune or the
 * sanitize — the kind of drift this file exists to prevent.
 *
 * Prunes dead projects first (see `pruneControlConfirmWaivers`); the target project survives the
 * prune because the merge happens after it, so a project that went away while a dialog was open
 * still gets the answer the user gave. An unwaivable verb or a missing project id changes nothing.
 * The result is sanitized, so no writer can persist a shape the readers would then drop in silence.
 */
export function withProjectWaiver(
  waivers: ControlConfirmWaivers,
  projectId: string | undefined,
  verb: string,
  on: boolean,
  live: ReadonlySet<string>
): ControlConfirmWaivers {
  if (!projectId || !isWaivableVerb(verb)) return sanitizeControlConfirmWaivers(waivers)
  const pruned = pruneControlConfirmWaivers(waivers, live)
  const current = pruned.projects?.[projectId] ?? []
  const nextVerbs = on ? [...new Set([...current, verb])] : current.filter((v) => v !== verb)
  const projects = { ...(pruned.projects ?? {}) }
  if (nextVerbs.length) projects[projectId] = nextVerbs
  else delete projects[projectId]
  return sanitizeControlConfirmWaivers({ ...pruned, projects })
}

/**
 * What a per-project toggle (the project tab menu's "Agents may, without asking" row) can honestly
 * show for one verb: whether THIS project's waiver is granted, and whether the verb would still
 * skip its dialog WITHOUT that grant — because of the app-run, machine-wide or bypass waiver.
 *
 * Asked through `decideControlConfirm` itself, never re-derived: a row that read only the
 * `projects` map would promise "agents here ask you first" while an app-run waiver or the
 * global-Bypass lock still waives the dialog, and "click to ask again" when removing the project
 * grant restores nothing. `otherVia` is the waiver that would still apply, so the row can name it
 * and send the user to the control that revokes it (`otherWaiverHint`).
 */
export function projectWaiverState(
  input: Omit<Parameters<typeof decideControlConfirm>[0], 'projectId'> & { projectId: string }
): { granted: boolean; skips: boolean; otherVia: ConfirmWaiverVia | null } {
  const { verb, projectId, persisted } = input
  const granted = !!sanitizeControlConfirmWaivers(persisted).projects?.[projectId]?.includes(verb)
  const without = withProjectWaiver(persisted ?? {}, projectId, verb, false, new Set([projectId]))
  const otherVia = decideControlConfirm({ ...input, persisted: without }).via
  return { granted, skips: granted || otherVia !== null, otherVia }
}

/** Why a verb skips its dialog even without the project's own waiver — the tooltip on that row. */
export function otherWaiverHint(via: ConfirmWaiverVia): string {
  switch (via) {
    case 'session':
      return 'Waived in every project until nodeterm quits — revoke it in Settings → Agents.'
    case 'always':
      return 'Waived permanently in every project on this computer — change it in Settings → Agents.'
    case 'bypass':
      return 'Not asked while your global permission mode is Bypass and the Bypass waiver is on — Settings → Agents.'
    default:
      return 'Waived for this project.'
  }
}

/**
 * What each waivable verb lets an agent do, phrased for the project tab menu's per-project toggle
 * ("Agents may, without asking: Close nodes"). The menu iterates `CONFIRM_WAIVABLE_VERBS` and a
 * test asserts every member has a label here, so a verb joining that table cannot render as a
 * blank row.
 */
export const WAIVABLE_VERB_ACTIONS: Readonly<Record<string, string>> = {
  close: 'Close nodes',
  write: 'Type into terminals',
  'open-project': 'Open or add projects'
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
export function waivedNotice(
  action: string,
  via: ConfirmWaiverVia,
  /** The project a `project` waiver belongs to. Named in the sentence because the whole point of
   *  that scope is that it does NOT apply everywhere — a user reading "waived for this project"
   *  while looking at a different project's canvas (which canvas control now makes routine) would
   *  read it as covering the one in front of them. */
  projectName?: string
): string {
  const because =
    via === 'session'
      ? 'confirm waived for this app run'
      : via === 'project'
        ? `confirm waived for ${projectName ? `"${projectName}"` : 'that project'}`
        : via === 'always'
          ? 'confirm waived permanently'
          : 'confirm waived while the global permission mode is Bypass'
  return `${action} — ${because} (Settings → Agents).`
}
