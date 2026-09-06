// Pure halves of the `open-project` control verb and the `--project`-targeted opens
// (issue #338, spec §2.1/§2.2). Canvas.tsx's dispatch only wires these — the dialog, the store
// calls and the reply — so every decision that does not need React is unit-testable here, the
// same reasoning as controlRouting.ts / pendingLaunch.ts.
import { oneLine } from '@shared/one-line'

/** The little these helpers need to know about a project. */
export interface ProjectForOpen {
  id: string
  name: string
  cwd?: string
}

/**
 * The dedupe rule (spec B1): the exact-string match `openFolderProject` uses, with the trailing
 * slash normalized away so `/a/b/` and `/a/b` cannot mint two tabs for one directory. `--cwd`
 * arrives here ALREADY resolved by main (`path.resolve`, spec P7) — this is cosmetic-slash
 * defense, never a second resolution.
 */
export function normalizeProjectCwd(resolvedCwd: string): string {
  // Both separators: a Windows cwd arrives with backslashes, and stripping only `/` left a
  // trailing `\` in place — which then became an empty final segment for anything splitting the
  // path afterwards.
  if (resolvedCwd.length <= 1) return resolvedCwd
  const stripped = resolvedCwd.replace(/[\\/]+$/, '')
  // …but a separator is not always cosmetic. `C:\` is the drive ROOT; `C:` is the current
  // directory ON drive C — a different place, and one that would dedupe against the wrong
  // project. Likewise a path that is nothing but separators. Keep the original wherever
  // removing the separator would change what the path MEANS.
  return stripped === '' || /^[A-Za-z]:$/.test(stripped) ? resolvedCwd : stripped
}

// `folderName` lives in shared/ so the core-side project loader can use the same rule; it stays
// exported from here too, because that is where every renderer caller already imports it from.
import { folderName } from '@shared/project-name'
export { folderName }

export function findProjectByCwd<T extends { cwd?: string }>(
  projects: readonly T[],
  resolvedCwd: string
): T | undefined {
  const cwd = normalizeProjectCwd(resolvedCwd)
  return projects.find((p) => p.cwd === cwd)
}

/**
 * The renderer-session attach-consent mirror (spec §4.2 Q1, adopted): which (caller, project)
 * pairs have already passed a human decision — creating, adopting, or the lighter first-attach
 * "Allow?" — so an idempotent re-open by the SAME caller does not re-raise the dialog, while a
 * DIFFERENT caller naming the same cwd still asks. DIALOG DEDUPE ONLY: authorization is main's
 * grant ledger (src/main/project-grants.ts), keyed to main's own verified identity verdict; this
 * map decides nothing but whether a dialog is shown. In-memory, per app run — the same lifetime
 * as the grants it mirrors.
 */
const attachAsked = new Map<string, Set<string>>()

export function attachConsentRecorded(callerNodeId: string, projectId: string): boolean {
  return attachAsked.get(callerNodeId)?.has(projectId) ?? false
}

export function recordAttachConsent(callerNodeId: string, projectId: string): void {
  const set = attachAsked.get(callerNodeId) ?? new Set<string>()
  set.add(projectId)
  attachAsked.set(callerNodeId, set)
}

/** Caller-node teardown: the mirror dies with the node it asked for — the same lifetime as
 *  main's grant ledger (`clearCaller` on pty destroy/recycle), so a node id revived after a
 *  deletion faces a fresh dialog, exactly as it faces a fresh grant (review #363 M-1). */
export function clearAttachConsent(callerNodeId: string): void {
  attachAsked.delete(callerNodeId)
}

export function clearAttachConsentForTests(): void {
  attachAsked.clear()
}

/**
 * The v1 flag exclusion for `--project` (spec §2.2): `--group` and `--after` both name ids that
 * live INSIDE a project, and validating them across a project boundary is exactly the surface v1
 * excludes. Returns the named refusal, or null when neither flag is present. Pure so the guard
 * is red-capable (review #363 I-2) — the dispatch only relays the answer; an empty-string value
 * counts as "not passed" (the shim always sends a value for a bare flag).
 */
export function projectTargetFlagRefusal(args: { group?: string; after?: string }): string | null {
  if (args.group || args.after) {
    return 'project-target-flag-unsupported: --group/--after cannot be combined with --project'
  }
  return null
}

export type OpenProjectPlan =
  | { kind: 'silent'; project: ProjectForOpen }
  | {
      kind: 'confirm'
      confirmKind: 'attach' | 'adopt' | 'create'
      message: string
      confirmLabel: string
      /** Set for `attach` — the existing project the caller is asking into. */
      project?: ProjectForOpen
    }

/**
 * The whole consent decision for one `open-project` request (spec §2.1 steps 2–4 + Q1). Pure:
 * the caller has already resolved the cwd (main), looked for a probe result (only needed when no
 * cwd hit exists), and passes everything in. Every dialog message shows the RESOLVED path (P5) —
 * the raw argument never reaches the renderer at all (main rewrites args.cwd).
 *
 * Q1 (adopted): an idempotent hit is silent ONLY for a caller that already passed a human
 * decision for this project. The first attach confirms with lighter copy, so every grant main
 * records traces back to exactly one human decision — a silent hit would let a verified caller
 * reach BY CWD the very targeting rights B3 forbids reaching by id.
 */
export function planOpenProject(input: {
  projects: readonly ProjectForOpen[]
  callerNodeId: string
  srcTitle: string
  resolvedCwd: string
  /** The probed .nodeterm project's name, when `probeFolder` answered (adopt path). */
  probedName?: string
  requestedName?: string
}): OpenProjectPlan {
  const { projects, callerNodeId, srcTitle, resolvedCwd, probedName, requestedName } = input
  const existing = findProjectByCwd(projects, resolvedCwd)
  if (existing) {
    if (attachConsentRecorded(callerNodeId, existing.id)) return { kind: 'silent', project: existing }
    return {
      kind: 'confirm',
      confirmKind: 'attach',
      // `oneLine` on every interpolated name (review #363 M-2): a project/probe/--name string is
      // caller- or repo-supplied, and a newline in it would let it inject lines into the consent
      // dialog. The resolved path's own line breaks are the dialog's structure; nothing else adds
      // lines. (The stored name stays the raw create-only string, like the human addProject path
      // — this flattening is dialog copy only.)
      message: `Agent "${srcTitle}" wants to open sessions in project "${oneLine(existing.name)}". Allow?`,
      confirmLabel: 'Allow',
      project: existing
    }
  }
  if (probedName !== undefined) {
    return {
      kind: 'confirm',
      confirmKind: 'adopt',
      message:
        `Agent "${srcTitle}" wants to add the existing project at\n${resolvedCwd}\n` +
        `to your workspace ("${oneLine(probedName)}"). Add it?`,
      confirmLabel: 'Add project'
    }
  }
  const name = oneLine(
    (requestedName ?? '').trim() ||
      (folderName(normalizeProjectCwd(resolvedCwd)) || 'Project')
  )
  return {
    kind: 'confirm',
    confirmKind: 'create',
    message:
      `Agent "${srcTitle}" wants to create a project for\n${resolvedCwd}\n` +
      `(name "${name}"). Create it?`,
    confirmLabel: 'Create project'
  }
}

/**
 * The success reply (spec §2.1): `result` carries `{ projectId, name, cwd, created }` — the id is
 * what the caller feeds `--project`, and `created` is true for anything that added a new
 * workspace entry (create AND adopt; an idempotent hit answers false). The message carries the
 * project's REAL name, so an agent whose `--name` was ignored on a hit learns what it is.
 */
export function openProjectReply(
  project: ProjectForOpen,
  created: boolean,
  adopted: boolean
): {
  message: string
  result: { projectId: string; name: string; cwd: string; created: boolean }
} {
  const verb = created ? 'created' : adopted ? 'added' : 'opened'
  const cwd = project.cwd ?? ''
  return {
    message: `${verb} project "${project.name}" (${project.id}) for ${cwd}`,
    result: { projectId: project.id, name: project.name, cwd, created: created || adopted }
  }
}

/**
 * Re-arm a freshly-built node for a COLD open (spec §2.2): its composed launch command is MOVED —
 * never copied — from `initialCommand` into `pendingLaunch: { after: [], command }`.
 * `initialCommand` is deliberately never serialized (workspace.ts), while `pendingLaunch` is: a
 * command left in `initialCommand` on the store path would be silently dropped by serialization
 * and the node would never start; a copy left behind would double-deliver if that ever changed.
 * An empty `after` is vacuously ready (`launchesToFire`), so the armed-launch effect fires it on
 * the target project's first view — the cold-open contract.
 */
export function armForColdOpen<
  T extends { data: { initialCommand?: string; pendingLaunch?: unknown } }
>(node: T): T {
  const command = node.data.initialCommand
  if (!command) return node
  return {
    ...node,
    data: { ...node.data, initialCommand: undefined, pendingLaunch: { after: [], command } }
  }
}

/** A node as either the serialized store or the live canvas holds it — enough for placement. */
export interface PlacedNode {
  id?: string
  parentId?: string
  position: { x: number; y: number }
  size?: { width: number; height: number }
  width?: number | null
  height?: number | null
}

const placedW = (n: PlacedNode): number => n.size?.width ?? (n.width as number) ?? 0
const placedH = (n: PlacedNode): number => n.size?.height ?? (n.height as number) ?? 0

/** A node's position in ROOT space: its own plus every ancestor frame's origin (a group child's
 *  stored position is frame-relative). Cycle-guarded like every other parent walk. */
function rootPosition(n: PlacedNode, byId: Map<string, PlacedNode>): { x: number; y: number } {
  let x = n.position.x
  let y = n.position.y
  const seen = new Set<string>(n.id ? [n.id] : [])
  let parentId = n.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * Where a node opened INTO another project lands (spec §2.2): centered below the lowest existing
 * node, because `placeBelow(src)` is meaningless in a project that does not contain the source.
 * Returns a CENTER point (the factories' `center` parameter — `placeAt` converts to top-left).
 * Guaranteed non-overlapping: everything else ends above the returned rect's top edge. Positions
 * are resolved to root space first, so a group child poking below its frame still counts.
 */
export function nextFreePosition(
  nodes: readonly PlacedNode[],
  size: { width: number; height: number } = { width: 640, height: 440 }
): { x: number; y: number } {
  if (!nodes.length) return { x: 40 + size.width / 2, y: 40 + size.height / 2 }
  const byId = new Map<string, PlacedNode>()
  for (const n of nodes) if (n.id) byId.set(n.id, n)
  let left = Infinity
  let bottom = -Infinity
  for (const n of nodes) {
    const at = rootPosition(n, byId)
    if (Number.isFinite(at.x)) left = Math.min(left, at.x)
    const b = at.y + placedH(n)
    if (Number.isFinite(b)) bottom = Math.max(bottom, b)
  }
  if (!Number.isFinite(left) || !Number.isFinite(bottom)) {
    return { x: 40 + size.width / 2, y: 40 + size.height / 2 }
  }
  return { x: left + size.width / 2, y: bottom + 80 + size.height / 2 }
}

/**
 * What an explicit "Open folder…" should do when it lands on a project already showing the
 * `unavailable` placeholder (issue #385).
 *
 * The placeholder is minted at load time when the ref can't be read, and a save deliberately
 * emits a header-only ref for it — never a file — so a stale placeholder can't clobber a source
 * that might come back. Correct, but it also means a project whose file the user DELETED can
 * never write one again: nothing clears the flag for a local project, so it stays unreadable at
 * every later load. The tab goes inert (`tabClickAction` → 'ignore') while the sessions sidebar,
 * which knows nothing of `unavailable`, still switches to it — the asymmetry issue #385 reports.
 *
 * Opening the folder is a deliberate act, so it is the right moment to break the loop — but only
 * on evidence:
 *   - `absent`  → the file really is gone. Clear the flag so the next save recreates it; an empty
 *                 canvas is the truthful state, since that is what deleting the file left.
 *   - `present` → it reads again (restored, a git checkout). Rehydrate from disk rather than
 *                 clearing the flag, or an empty placeholder would be saved over real nodes.
 *   - `unreadable` → we cannot tell. Change nothing; the placeholder is exactly the right answer.
 */
export type UnavailableRecovery = 'clear' | 'rehydrate' | 'keep'

export function unavailableRecovery(
  project: { unavailable?: boolean; ssh?: unknown },
  fileState: 'present' | 'absent' | 'unreadable'
): UnavailableRecovery {
  // Remote projects are not ours to judge from a local stat — their file lives on the host, and
  // their placeholder is cleared by the reconnect path instead.
  if (!project.unavailable || project.ssh) return 'keep'
  if (fileState === 'absent') return 'clear'
  if (fileState === 'present') return 'rehydrate'
  return 'keep'
}
