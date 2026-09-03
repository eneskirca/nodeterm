// Which canvas-control verbs may be answered for a project that is NOT on screen.
//
// WHY IT EXISTS: routing is by SOURCE (`routeControlSource`), and React Flow holds only the ACTIVE
// project's nodes — so a verb declared `needsLiveCanvas` used to TRAVEL to the calling agent's
// project before it ran. For an agent that renders its output as a node (a report as `show-web`, a
// screenshot as `show-image`, a fan-out as `open-claude`) that meant a background session yanked
// the human's view out of the project they were typing in, at a moment they did not choose. That
// is the same G5 objection `send`/`reply`/`sticky`/`open-project` are already exempt for; those
// verbs simply never needed a canvas, while these ones needed a PLACE TO PUT A NODE — which the
// owning project's serialized nodes can be, exactly as the `--project` cold-open branch already
// writes into another project's store.
//
// WHAT THIS FILE DECIDES: only whether the off-canvas answer is available. Canvas.tsx does the
// staging (it runs the verb against the owning project's serialized nodes and commits the result
// through the projects store), and every verb outside this set keeps travelling as before.

/** The little of a React Flow node this decision needs. */
export interface OffCanvasNode {
  id: string
  type?: string
  parentId?: string
  data?: { worktree?: unknown; cwd?: unknown }
}

/**
 * Verbs whose whole effect is "put a node on the owning project's canvas", and which therefore
 * have a truthful answer without that canvas being on screen. The node is written into the
 * project's serialized nodes and appears the moment that project is next shown.
 *
 * Deliberately NOT here: everything that reads or drives something LIVE — `browser` needs a
 * mounted `<webview>` guest, `write`/`close` address a running pane, `focus`/`goto` move a camera
 * that by definition belongs to the active project, and the layout verbs (`group`, `move`,
 * `arrange`, `align`) are refinements a human is watching. Those still travel; a verb joining this
 * set owes the staging path in Canvas.tsx the state it reads.
 */
export const OFF_CANVAS_VERBS: ReadonlySet<string> = new Set([
  'show-image',
  'show-video',
  'show-web',
  'open-browser',
  'open-terminal',
  'open-claude',
  'open-agent'
])

/**
 * Does the chain from `groupId` upward state a git worktree?
 *
 * `cwdForNewNodeIn` answers `--group`'s cwd from the nearest ancestor frame's `data.worktree`, and
 * it subtracts the worktree store's `staleGroupIds` — which is scoped to the ACTIVE project. Off
 * canvas that subtraction cannot be made, and the fail-open direction is the dangerous one: a
 * worktree deleted outside the app would hand the new node a cwd that is not there. So a
 * worktree-bound `--group` is not answered off canvas at all; it takes the old travelling path,
 * where the staleness IS known.
 */
export function groupChainHasWorktree(
  nodes: readonly OffCanvasNode[],
  groupId: string | undefined
): boolean {
  const seen = new Set<string>()
  let currentId = groupId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const parent = nodes.find((n) => n.id === currentId)
    if (!parent) {
      return false
    }
    if (parent.data?.worktree) {
      return true
    }
    currentId = parent.parentId
  }
  return false
}

/** May this call be answered against `nodes` (the owning project's serialized canvas)? */
export function answersOffCanvas(
  verb: string,
  args: Record<string, string | undefined>,
  nodes: readonly OffCanvasNode[]
): boolean {
  if (!OFF_CANVAS_VERBS.has(verb)) {
    return false
  }
  return !groupChainHasWorktree(nodes, args.group?.trim() || undefined)
}

/** The notice shown when a node was created in a project the human is not looking at. It says
 *  where the work went; travelling there stays the human's choice, which is the whole point. */
export function offCanvasNoticeText(projectName: string, count: number): string {
  const what = count === 1 ? 'A node' : `${count} nodes`
  return `${what} opened by an agent in "${projectName}" — that project is not on screen.`
}
