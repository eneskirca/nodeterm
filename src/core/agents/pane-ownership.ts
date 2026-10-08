/**
 * The runtime pane-ownership ledger: nodeId → the project that actually SPAWNED that node's pane,
 * this process run. It exists because the persisted store cannot be trusted to answer "who owns
 * this pane?" — `.nodeterm/project.json` is git-shared and hand-editable, so a hostile/cloned
 * project can LIST any node id, including one a different project is really running. A messaging
 * grant is per project, and panes are keyed by the BARE node id globally (tmux `nt-<nodeId>`), so
 * ownership derived from the file is a confused-deputy hole: PR #237's re-review drove it end to
 * end (a granted project A delivered into ungranted project B's live pane just by listing B's id).
 *
 * THE ONE FACT THAT IS NOT FORGEABLE BY A CLONED FILE is which project's `create()` actually
 * brought the tmux session into being. That is what this records, and only that:
 *
 *  - Recorded ONLY on a GENUINE FRESH SPAWN (`PtyManager.spawnNew` with `fresh === true` — no live
 *    session existed to reattach to). An attach/co-attach to a session someone else spawned never
 *    records, so a second project that merely OPENS a node id another project is running cannot
 *    claim it. `fresh` is the manager's own signal, not anything off the wire or the file.
 *    The one other spawn path is a session the PHONE starts over the relay (`PtyManager.
 *    attachDetached`, audit A72): recorded only when the relay host's probe of the same manager
 *    (`sessionExists`, fail-safe toward "exists") found no session AND this process holds no live
 *    generation of the node — the same "genuinely brought into being" fact, asked the only way a
 *    synchronous attach can ask it.
 *  - The owner value is the machine-local project id the renderer passed at the create call
 *    (`PtyCreateOptions.ownerProjectId`) — the entry id (`IndexEntryV3.id`), never the file's
 *    git-copied `id`. A cloned repo gets a fresh entry id, so it cannot inherit another copy's
 *    ownership either. For a phone-started session the relay host resolves that same entry id from
 *    its own index (`createHostNewSessions`) — the phone names a project, it never supplies an owner.
 *
 * ── COLD STATE / RESTART (stated honestly) ──────────────────────────────────────────────────────
 * This ledger is IN-MEMORY and starts empty every run. After an app restart the tmux SERVER
 * usually survives, so the renderer's re-open of a node ATTACHES (`fresh === false`) and records
 * nothing — the pane is then UNPROVEN and messaging to it is REFUSED (fail-closed) until the
 * session is truly respawned (or the machine reboots, killing the tmux server, after which the
 * next open is a real fresh spawn and records correctly). We do NOT repopulate on attach: there is
 * no cheap cross-restart signal a hostile agent could not also write (a tmux session-env var is
 * settable from any pane's shell), and guessing the owner on attach is exactly how the attacker
 * would re-acquire ownership by opening the victim's id first. Fail-closed is the safe direction
 * and is pinned by a test (`ownerOf` empty ⇒ the delivery gate refuses).
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────────
 * This is scoped to tmux-pane messaging ownership but is intentionally feature-neutral: S8 PR 4's
 * BrowserControlLedger and messaging PR 7's deliver-on-idle queue want the same "who really spawned
 * this node" answer and can consume `paneOwnerProject` directly. It lives in `src/core` (no
 * electron, no main import) so it ships on both shells; the opt-in Server Edition control runtime
 * now records and reads it through the same PtyManager and messaging service as desktop.
 */

/** nodeId → owning projectId (machine-local entry id), for panes freshly spawned THIS run. */
const owners = new Map<string, string>()

/**
 * THE FRESH-GATE, pure and pinned: may this create() record pane ownership? True ONLY for a
 * genuine fresh spawn (`fresh === true`) of a persistent node (`persistKey`) whose owner is known
 * (`ownerProjectId`). This is the load-bearing security property — recording on an ATTACH
 * (`fresh === false`) would let a project claim a pane it merely re-opened after a restart, which
 * is exactly the confused deputy this ledger closes. Extracted so the gate has its own unit test
 * (`pane-ownership.test.ts`) rather than living only inside `spawnNew`.
 */
export function shouldRecordOwnership(
  fresh: boolean,
  persistKey: string | undefined,
  ownerProjectId: string | undefined
): boolean {
  return fresh === true && !!persistKey && !!ownerProjectId
}

/**
 * Record the owner of a node whose pane was just GENUINELY spawned. Call sites: `spawnNew`, guarded
 * by `fresh === true` and a present `persistKey` + `ownerProjectId`, and `attachDetached` for a
 * session the relay host creates (see the header). A fresh spawn for an id that
 * somehow already has an entry OVERWRITES it — the live pane is the one that just came into being.
 * A missing owner is a no-op (old callers / tests that pass no `ownerProjectId` simply leave the
 * pane unproven, which fails closed downstream — the correct direction).
 */
export function recordFreshSpawnOwner(nodeId: string, ownerProjectId: string | undefined): void {
  if (!nodeId || !ownerProjectId) return
  owners.set(nodeId, ownerProjectId)
}

/** The project that provably spawned this node's pane this run, or `undefined` when unproven
 *  (never spawned here, or only ever attached — e.g. after a restart). Undefined MUST fail closed
 *  at every gate: an unprovable owner is not an absent restriction. */
export function paneOwnerProject(nodeId: string): string | undefined {
  return owners.get(nodeId)
}

/** Drop a node's ownership — its session is ending (delete or recycle). A later genuine respawn
 *  re-records; until then the id is unproven again, which fails closed. */
export function forgetPaneOwner(nodeId: string): void {
  owners.delete(nodeId)
}

/** Test seam only: wipe the ledger between cases. Never called in production. */
export function resetPaneOwnershipForTests(): void {
  owners.clear()
}
