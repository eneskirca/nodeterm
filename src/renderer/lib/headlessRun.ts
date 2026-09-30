// Canvas-control headless start (#925): `open-* --run-now` and `run --node`. Pure planners plus
// one orchestrator with injected effects, so Canvas.tsx only wires. See the spec (§4) for the flow:
// write-ahead claim → launch through main → patch the node wherever it lives NOW.
// Headless starts are local-only: a remote (SSH) node is refused here, before any claim
// (`remote-unsupported`, the primary fence), and `headlessPtyOptions` sets `requireRemote` for an
// SSH-project node as core's belt behind it.
import type { CanvasNodeState, PendingLaunch, Project, PtyCreateOptions } from '@shared/types'
import type { HeadlessLaunchFailure, HeadlessLaunchResult } from '@shared/headless-launch'
import { HEADLESS_COLS, HEADLESS_ROWS, localNodePtyOptions } from '@shared/node-pty-options'

export type RunVerbPlan =
  | 'nothing-queued'
  | 'already-starting'
  | 'mounted'
  | 'wait-for-mount'
  | 'refuse-not-mounted'
  | 'headless'

/** What `run --node` does. A project on screen never starts headless: its node either has a
 *  mounted writer (the ▶ path) or starts through the ordinary path when its terminal next mounts.
 *  That ordinary path only fires a plain, never-attempted launch with no dependencies: a
 *  `manualOnly` launch waits for an explicit Run now and an `--after` launch waits for its deps.
 *  Telling the caller either one "starts when mounted" would promise a start that never comes, so
 *  those are refused instead (`refuse-not-mounted`). */
export function planRunVerb(input: {
  pending?: PendingLaunch
  inFlight: boolean
  projectActive: boolean
  hasWriter: boolean
}): RunVerbPlan {
  if (!input.pending?.command) return 'nothing-queued'
  if (input.inFlight) return 'already-starting'
  if (input.projectActive) {
    if (input.hasWriter) return 'mounted'
    // `after` is required by the type, but the launch comes out of hand-editable project JSON.
    // A pull request wait (`--after-pr`) is a dependency too: the mount does not fire it. So is a
    // success wait (`--after-success`), whose stations are normally in `after` as well — checked on
    // its own because a hand-edited file need not keep the two in step.
    const waitsOnDeps =
      (input.pending.after?.length ?? 0) > 0 || !!input.pending.afterPr || !!input.pending.afterSuccess
    return input.pending.manualOnly || waitsOnDeps ? 'refuse-not-mounted' : 'wait-for-mount'
  }
  return 'headless'
}

/** The write-ahead claim, saved before any spawn: a crash mid-start can never auto-start twice
 *  (`launchesToFire` skips manualOnly, on every build). */
export function claimForHeadless(p: PendingLaunch): PendingLaunch {
  return { ...p, executor: 'core', attempted: true, manualOnly: true }
}

export function headlessStartNoticeText(projectName: string, count: number): string {
  const what = count === 1 ? 'a session' : `${count} sessions`
  return `An agent started ${what} in "${projectName}". That project is not on screen.`
}

/**
 * The PtyCreateOptions of a headless start: the shared local builder at the headless size, plus
 * `requireRemote` for an SSH-project node. `startHeadless` refuses such a node before any claim
 * (`remote-unsupported`) — that is the primary fence. This is core's belt behind it: if a remote
 * node ever reached the launcher, core's `spawnNew` refuses it (`unavailable:'ssh'`) instead of
 * starting a LOCAL `nt-<id>` wearing the remote node's identity. `desktopHeadlessRequest` keeps
 * the flag. Set here and not in `localNodePtyOptions`, whose key set is pinned and which the
 * Server Edition shares.
 */
export function headlessPtyOptions(
  project: Pick<Project, 'id' | 'cwd'>,
  node: CanvasNodeState
): PtyCreateOptions {
  return {
    ...localNodePtyOptions(project, node, { cols: HEADLESS_COLS, rows: HEADLESS_ROWS }),
    ...(node.sshRemoteTmux ? { requireRemote: true } : {})
  }
}

export type HeadlessStartReason =
  | HeadlessLaunchFailure
  | 'already-starting'
  | 'claim-not-saved'
  | 'nothing-queued'
  | 'remote-unsupported'

export type HeadlessStartOutcome =
  | { id: string; started: true }
  | { id: string; started: false; reason: HeadlessStartReason }

/** One `startNodesHeadless` call: each node's outcome, plus whether the call restored the
 *  project's tab (`unhidesForHeadlessStart`). The reply needs the second fact: only a restored tab
 *  makes the cold open's "reopen it from the welcome screen" hint false. */
export interface HeadlessStartBatch {
  outcomes: HeadlessStartOutcome[]
  unhidden: boolean
}

/**
 * Whether a headless start restores a CLOSED project's tab (#925 spec §2.5): the tab comes back,
 * never the focus. The one definition; Canvas acts on it and reports it back in the batch.
 * - Not while no project is active (the welcome screen): un-closing one there flips `hasProjects`
 *   and renders a canvas with no active project. The session still starts; the project stays in
 *   Recently closed.
 * - Not for an SSH project: `startHeadless` refuses every one of its nodes (`remote-unsupported`)
 *   before any claim, so nothing would start and no claim write would persist the tab.
 */
export function unhidesForHeadlessStart(
  project: { closed?: boolean; ssh?: Project['ssh'] },
  activeProjectId: string
): boolean {
  return !!project.closed && !project.ssh && activeProjectId !== ''
}

export interface HeadlessStartDeps {
  launch(req: { ptyOptions: PtyCreateOptions; command: string }): Promise<HeadlessLaunchResult>
  /** Persist `pending` (undefined = cleared) on the node wherever it lives NOW; true = on disk. */
  savePending(nodeId: string, pending: PendingLaunch | undefined): Promise<boolean>
  markStarting(nodeId: string): void
  markFailed(nodeId: string): void
  clearDelivery(nodeId: string): void
  /** Shared across calls: one start per node at a time. */
  inFlight: Set<string>
}

export async function startHeadless(
  deps: HeadlessStartDeps,
  input: { project: Pick<Project, 'id' | 'cwd' | 'ssh'>; node: CanvasNodeState }
): Promise<HeadlessStartOutcome> {
  const { node, project } = input
  const id = node.id
  const original = node.pendingLaunch
  if (!original?.command) return { id, started: false, reason: 'nothing-queued' }
  // A remote node is NEVER spawned locally. The launcher only spawns locally, so refuse before
  // touching anything (the primary fence): the untouched pending launch starts on view, over SSH.
  // The project is asked too, not only the node's flags: a node of an SSH project that carries
  // neither flag is still remote. `headlessPtyOptions` also sets `requireRemote` for a node with
  // `sshRemoteTmux`, core's belt behind this.
  if (project.ssh || node.ssh || node.sshRemoteTmux) {
    return { id, started: false, reason: 'remote-unsupported' }
  }
  if (deps.inFlight.has(id)) return { id, started: false, reason: 'already-starting' }
  deps.inFlight.add(id)
  try {
    if (!(await deps.savePending(id, claimForHeadless(original)))) {
      // Never spawn on an unsaved claim: a crash would re-deliver on the next view.
      await deps.savePending(id, original)
      return { id, started: false, reason: 'claim-not-saved' }
    }
    deps.markStarting(id)
    let result: HeadlessLaunchResult
    try {
      result = await deps.launch({
        ptyOptions: headlessPtyOptions(project, node),
        command: original.command
      })
    } catch {
      result = { outcome: 'failed', reason: 'spawn-failed' }
    }
    if (result.outcome === 'delivered') {
      deps.clearDelivery(id)
      await deps.savePending(id, undefined)
      return { id, started: true }
    }
    if (result.reason === 'not-persistent') {
      // Nothing was typed and no session survives. Normally nothing was spawned at all (refused
      // before the spawn); in the race where the backend went away between core's probe and the
      // spawn, the plain shell it got was released, which kills it. Hand the node back exactly as
      // it was, so a cold open starts on view and an already-attempted node keeps its manual Run now.
      deps.clearDelivery(id)
      await deps.savePending(id, original)
    } else {
      deps.markFailed(id)
    }
    return { id, started: false, reason: result.reason }
  } finally {
    deps.inFlight.delete(id)
  }
}

export interface PendingStoreEnv {
  activeProjectId(): string
  patchLive(nodeId: string, pending: PendingLaunch | undefined): boolean
  patchStored(projectId: string, nodeId: string, pending: PendingLaunch | undefined): boolean
  writeDisk(): Promise<boolean>
  markDirty(): void
}

/** React Flow is the truth for the ACTIVE project, the store for every other one. Decided at the
 *  moment of each write, because the user may switch projects while a start is in flight. */
export async function savePendingAnywhere(
  env: PendingStoreEnv,
  projectId: string,
  nodeId: string,
  pending: PendingLaunch | undefined
): Promise<boolean> {
  if (env.activeProjectId() === projectId) {
    if (!env.patchLive(nodeId, pending)) return false
    env.markDirty()
    return true
  }
  if (!env.patchStored(projectId, nodeId, pending)) return false
  return env.writeDisk()
}

const STARTS_ON_VIEW = / — queued; starts when that project is next viewed/
const CLOSED_HINT = / \(that project is closed — reopen it from the welcome screen\)/

/** Failures after which the node's launch is exactly what the cold open left: never claimed
 *  (`remote-unsupported`), or handed back unchanged (`not-persistent`, `claim-not-saved`). Such a
 *  launch still starts when its project is next viewed. Every other failure keeps the write-ahead
 *  claim (manualOnly), so that node waits for Run now instead. */
const LAUNCH_LEFT_AS_IS: ReadonlySet<HeadlessStartReason> = new Set([
  'remote-unsupported',
  'not-persistent',
  'claim-not-saved'
])

/**
 * Turn a cold-open reply (`coldOpenMessage` + result) into the `--run-now` reply. Each clause of
 * the cold-open sentence is dropped only when this batch made it false:
 * - "queued; starts when that project is next viewed" goes once a node started, or once a node's
 *   launch now waits for Run now. It stays when every launch was left as it was.
 * - The closed-project hint goes only when the tab was actually restored (`batch.unhidden`).
 * Every queued id is reported with its own reason (`reasons`, grouped in the message); `reason`
 * is the first one, kept for callers that read a single field.
 */
export function mergeRunNow<T extends { ok: true; message: string; result: Record<string, unknown> }>(
  base: T,
  batch: HeadlessStartBatch
): T {
  const startedIds = batch.outcomes.filter((o) => o.started).map((o) => o.id)
  const failed = batch.outcomes.filter(
    (o): o is Extract<HeadlessStartOutcome, { started: false }> => !o.started
  )
  const queuedIds = failed.map((o) => o.id)
  const reason = failed[0]?.reason
  const reasons: Record<string, HeadlessStartReason> = {}
  const byReason = new Map<HeadlessStartReason, string[]>()
  for (const o of failed) {
    reasons[o.id] = o.reason
    byReason.set(o.reason, [...(byReason.get(o.reason) ?? []), o.id])
  }
  const startsOnViewStillTrue =
    startedIds.length === 0 && failed.every((o) => LAUNCH_LEFT_AS_IS.has(o.reason))
  let head = base.message
  if (!startsOnViewStillTrue) head = head.replace(STARTS_ON_VIEW, '')
  if (batch.unhidden) head = head.replace(CLOSED_HINT, '')
  const message =
    head +
    (startedIds.length ? ` — started: ${startedIds.join(', ')}` : '') +
    [...byReason].map(([r, ids]) => ` — queued (${r}): ${ids.join(', ')}`).join('')
  return {
    ...base,
    message,
    result: {
      ...base.result,
      started: startedIds.length > 0,
      startedIds,
      queued: queuedIds.length > 0,
      queuedIds,
      ...(reason ? { reason } : {}),
      reasons
    }
  }
}
