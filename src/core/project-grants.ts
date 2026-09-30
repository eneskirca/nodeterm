/**
 * The session-scoped project-grant ledger + the `--project` targeting gate (issue #338, spec §3).
 *
 * WHO MAY TARGET WHAT: a control caller may aim an open verb (`open-terminal`/`open-claude`/
 * `open-agent`) at (a) its OWN project, or (b) a project id that `open-project` RETURNED TO THAT
 * SAME CALLER in this app run. Nothing else — arbitrary cross-project targeting is deliberately
 * not v1 (confused-deputy-adjacent; a future version needs the target project's own capability
 * consent via the #213 mechanism, which would be a third disjunct in `gateProjectTarget`, not a
 * redesign).
 *
 * IN MEMORY, IN THE CORE PROCESS, NEVER PERSISTED — the browser-ownership-ledger posture
 * (browser-control-ledger.ts), for the same reason: a grant is a record of consent given to a
 * RUNNING session, not a durable claim. An app restart clears every grant; a caller's node
 * teardown (pty destroy/recycle, wired in index.ts) clears that caller's. Recording happens ONLY
 * in the desktop control-handler wrapper on `result.ok && verified` — the core's identity verdict for
 * that request, never anything off the wire or out of project.json.
 *
 * PURE on purpose: no electron, no fs, no child_process (project-grants.test.ts asserts this
 * structurally). It unit-tests like agent-message-scope.ts and cannot persist anything even by
 * accident.
 */
import path from 'node:path'

/** At most this many granted project ids per caller. Beyond it `open-project` REFUSES
 *  (`open-project-grant-cap`) rather than evicting silently — an evicted grant would revoke a
 *  targeting right the human consented to without anyone being told. */
export const GRANT_CAP = 64

/** callerNodeId -> the project ids open-project returned to that caller this app run. */
const grants = new Map<string, Set<string>>()

/** Record that `open-project` returned `projectId` to `callerNodeId`. `'cap'` = refused (the set
 *  is full and `projectId` is not already in it); nothing is recorded and nothing is evicted. */
export function grant(callerNodeId: string, projectId: string): 'ok' | 'cap' {
  const set = grants.get(callerNodeId) ?? new Set<string>()
  if (!set.has(projectId) && set.size >= GRANT_CAP) return 'cap'
  set.add(projectId)
  grants.set(callerNodeId, set)
  return 'ok'
}

/** Was `projectId` granted to `callerNodeId` — THIS caller, not any caller (spec P2)? */
export function isGranted(callerNodeId: string, projectId: string): boolean {
  return grants.get(callerNodeId)?.has(projectId) ?? false
}

/** Is this caller's grant set full? Consulted BEFORE forwarding an `open-project`, so the refusal
 *  arrives before a dialog is ever shown rather than after the human already consented. */
export function atCap(callerNodeId: string): boolean {
  return (grants.get(callerNodeId)?.size ?? 0) >= GRANT_CAP
}

/** Caller-node teardown (pty destroy/recycle): that caller's grants die with its identity. */
export function clearCaller(callerNodeId: string): void {
  grants.delete(callerNodeId)
}

/** Everything gone — the app-restart lifetime, and the test seam. */
export function clearAll(): void {
  grants.clear()
}

/** The verbs that accept `--project` (spec §2.2): the three open verbs, `run` (#925), plus
 *  `settings`, whose per-project keys (@shared/settings-verb) may name a project other than the
 *  caller's — own or granted only, the same rule, decided here before anything is forwarded.
 *  `--project` on any other verb is dead weight the gate deliberately ignores (spec §7.5). */
export const PROJECT_TARGETABLE_VERBS: ReadonlySet<string> = new Set([
  'open-terminal',
  'open-claude',
  'open-agent',
  // #925: a node in another project is reached only through a granted --project.
  'run',
  'settings',
  // Read-only GitHub lane of a project (core/github/control-read.ts): own or granted, like the rest.
  'issues',
  'prs'
])

/** The flat refusal an UNVERIFIED caller's `--project` gets — one sentence, no diagnosis, no
 *  token/restart advice, same posture as the hook server's verified-only refusals. */
export const PROJECT_TARGETING_REFUSAL = 'Project targeting refused.'

/** The named refusal for an id that is neither the caller's own project nor granted. Also the
 *  answer for an id the core store does not know, AND for an ungranted id that happens to name an
 *  SSH project: every id the caller has no relationship to refuses with these SAME BYTES, so the
 *  gate is neither a project-existence oracle nor a project-KIND oracle (PR #362 review, I3 —
 *  the earlier distinct SSH wording let a verified caller learn "this id is a real SSH project"
 *  with no grant). */
export const PROJECT_TARGET_REFUSED =
  'project-target-refused: you may only target your own project or a project id open-project ' +
  'returned to you in this session'

/** Targeting an SSH project is not v1 (spec B5/§6): the nodes would need host-side
 *  materialization this feature defers. Shown ONLY to a caller that already holds a GRANT for
 *  the id (where disclosing the project's kind is harmless — the caller was handed the id by
 *  open-project). A caller with no relationship to an SSH id gets PROJECT_TARGET_REFUSED like
 *  every other stranger, see above. Today this constant is pure belt: grants are only minted by
 *  local open-project, so a granted SSH id cannot exist — but if that invariant ever breaks,
 *  the target must still be refused, not opened. */
export const PROJECT_TARGET_SSH_UNSUPPORTED =
  'project-target-ssh-unsupported: opening sessions into an SSH project is not supported — do not retry'

/** `open-project` from an agent whose own project is SSH: the --cwd would be a host path (B5). */
export const OPEN_PROJECT_LOCAL_ONLY =
  'open-project-local-only: open-project is not available from an SSH project — do not retry'

/** The caller's grant set is full (see GRANT_CAP). */
export const OPEN_PROJECT_GRANT_CAP =
  'open-project-grant-cap: this session already holds the maximum number of project grants'

/** The wrapper could not resolve the caller's own project from the persisted store (a node
 *  saved seconds ago may still be inside the save debounce). Fail closed, but say it is
 *  transient — this is the one refusal here that a short wait can clear. */
export const OPEN_PROJECT_CALLER_UNRESOLVED =
  'open-project-caller-unresolved: the calling node is not in any saved project yet — wait a few seconds and retry once'

/** `--cwd` failed validation: not absolute, not existing, or not a directory. */
export const OPEN_PROJECT_CWD_INVALID =
  'open-project-cwd-invalid: --cwd must be an absolute path to an existing directory'

export type ProjectTargetGate = 'allow' | { refuse: string }

/**
 * The `--project` targeting gate (spec §3 "consumed" + §5 P1/P2/P8), run in the shell's control-handler
 * wrapper BEFORE anything is forwarded to the renderer — the renderer never sees an unauthorized
 * `--project`. Every input is core-owned data: `verified` is the hook server's identity verdict
 * for THIS request, `callerProjectId` comes from node membership in `persistedCanvases()`,
 * `targetIsSsh` from `projectMetaFor` (undefined = the store does not know the target), and
 * `granted` from this module's ledger. Nothing is read off the request except the target id
 * being judged.
 *
 * Branch order is load-bearing:
 *  - the OWN-project allow runs before the unknown-target refusal (PR #362 review, M2): both
 *    `callerProjectId` and the target meta derive from the same index scan, but if a rename
 *    mid-debounce ever let `persistedCanvases` resolve the caller one tick before
 *    `projectMetaFor` finds the entry, the caller's legitimate `--project <own-id>` must not be
 *    spuriously refused as unknown. Allowing OWN on the caller-resolution alone is still
 *    fail-closed — the id equals the caller's own project in the core store;
 *  - every id the caller has NO relationship to (unknown, local-ungranted, SSH-ungranted)
 *    refuses with the byte-identical PROJECT_TARGET_REFUSED (review I3 — no kind oracle);
 *  - the SSH refusal sits INSIDE the granted allow as pure belt: a granted SSH id cannot exist
 *    (grants are only minted by local open-project), but if that invariant ever breaks the
 *    target is refused, not opened — and only there is the kind-naming wording harmless, because
 *    a grant holder was handed the id by open-project.
 */
export function gateProjectTarget(input: {
  verified: boolean
  verb: string
  targetProjectId: string | undefined
  callerProjectId: string | undefined
  targetIsSsh: boolean | undefined
  granted: boolean
}): ProjectTargetGate {
  const { verified, verb, targetProjectId, callerProjectId, targetIsSsh, granted } = input
  if (!PROJECT_TARGETABLE_VERBS.has(verb)) return 'allow'
  if (targetProjectId === undefined) return 'allow'
  if (verified !== true) return { refuse: PROJECT_TARGETING_REFUSAL }
  if (callerProjectId !== undefined && targetProjectId === callerProjectId) return 'allow'
  if (granted && targetIsSsh !== undefined) {
    if (targetIsSsh) return { refuse: PROJECT_TARGET_SSH_UNSUPPORTED }
    return 'allow'
  }
  return { refuse: PROJECT_TARGET_REFUSED }
}

/**
 * The whole record-side decision for a finished `open-project` request (spec §3 "recorded", made
 * pure in the PR #362 fix round so the cap race — review M1 — is behaviorally testable).
 * `'recorded'` = the grant now exists; `'not-applicable'` = the reply mints nothing (not ok, not
 * verified, or no usable projectId — all fail closed); `'cap'` = the reply LOOKED grantable but a
 * concurrent open-project from the same caller filled the last slot while this one was in flight
 * (the pre-forward `atCap` check passed for both). On `'cap'` the wrapper must NOT relay the
 * success reply — the caller would hear ok while holding no targeting right — it answers
 * OPEN_PROJECT_GRANT_CAP instead; nothing is lost, because open-project is idempotent (B1) and a
 * re-run after grants clear returns the same id and records the grant.
 */
export function recordOpenProjectGrant(
  callerNodeId: string,
  reply: { ok: boolean; result?: unknown },
  verified: boolean
): 'recorded' | 'not-applicable' | 'cap' {
  if (verified !== true || reply.ok !== true) return 'not-applicable'
  const projectId = (reply.result as { projectId?: unknown } | undefined)?.projectId
  if (typeof projectId !== 'string' || !projectId) return 'not-applicable'
  return grant(callerNodeId, projectId) === 'cap' ? 'cap' : 'recorded'
}

/**
 * The whole main-side pre-forward gate for an `open-project` request (issue #338 Task 1.4, made
 * pure in the PR #362 fix round — review I1/I2 proved the SSH-caller and unresolved-caller
 * branches had no red-capable coverage while they lived inline in index.ts's wrapper). The
 * wrapper resolves the inputs from core-owned stores (caller project by node membership in
 * `persistedCanvases`, SSH-ness via `projectMetaFor`, the cap from this module's ledger) and
 * routes EVERY open-project through here; a `refuse` answer is returned to the caller without
 * anything being forwarded to the renderer, so no dialog can be shown (PR 2) and no grant can be
 * minted for a request that failed these rules.
 *
 * Branch order: caller-unresolved (fail closed per GC 10 — a node inside the save debounce, the
 * one transient refusal here) → SSH caller (B5 local-only) → cap (refused BEFORE any consent
 * could be collected) → cwd validation (P7, resolved once). Identity is NOT re-checked here: the
 * hook-server's `requiresVerified` refuses an unverified open-project before any handler, and
 * the wrapper keeps its own belt in front of this call.
 */
export function gateOpenProject(input: {
  callerProjectId: string | undefined
  callerIsSsh: boolean | undefined
  atCap: boolean
  rawCwd: string
  statFn: (p: string) => { isDirectory(): boolean }
}): { resolvedCwd: string } | { refuse: string } {
  if (input.callerProjectId === undefined) return { refuse: OPEN_PROJECT_CALLER_UNRESOLVED }
  if (input.callerIsSsh) return { refuse: OPEN_PROJECT_LOCAL_ONLY }
  if (input.atCap) return { refuse: OPEN_PROJECT_GRANT_CAP }
  const cwd = validateOpenProjectCwd(input.rawCwd, input.statFn)
  if ('error' in cwd) return { refuse: cwd.error }
  return { resolvedCwd: cwd.resolved }
}

/**
 * Validate + normalize an `open-project --cwd` argument (spec §2.1 step 1, P7). The caller's path
 * is hostile input: it must be absolute, is resolved ONCE (`path.resolve` collapses `..`/`.`),
 * and the RESOLVED form is statted ONCE (single fd — no TOCTOU re-walk; `statFn` follows
 * symlinks, so the directory check is on the real target). The resolved path — never the raw
 * argument — is what every later step sees: the PR 2 confirm dialog shows it, the dedupe compares
 * it, the store records it.
 *
 * `statFn` is injected (main passes `fs.statSync`) so the rules stay pure and unit-testable.
 */
export function validateOpenProjectCwd(
  raw: string,
  statFn: (p: string) => { isDirectory(): boolean }
): { resolved: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0 || !path.isAbsolute(raw)) {
    return { error: OPEN_PROJECT_CWD_INVALID }
  }
  const resolved = path.resolve(raw)
  try {
    if (!statFn(resolved).isDirectory()) return { error: OPEN_PROJECT_CWD_INVALID }
  } catch {
    return { error: OPEN_PROJECT_CWD_INVALID }
  }
  return { resolved }
}
