// COLD OPEN — answering canvas-control's node-opening verbs out of a project's SERIALIZED nodes,
// so a background agent's `open-claude` never yanks the user's screen to another project.
//
// WHY IT EXISTS. `routeControlSource` resolves the OWNING project of the source node, and Canvas
// then travelled to it (`travelToProjectRef`) because React Flow holds only the ACTIVE project's
// nodes. Travelling is correct for a verb that needs live canvas state; for an OPEN it is a
// screen hijack on a background agent's say-so — the tab switches and the target project's saved
// viewport is applied, so the camera appears to jump and zoom (present since 2026-08-11, cecb4dfe,
// first shipped in v0.2.43). What cecb4dfe fixed must not regress: an agent in another project is
// still ANSWERED, never rejected as "not a control-capable agent".
//
// The mechanism is not new. `--project`-targeted opens (issue #338, spec §2.2) already insert into
// a non-active project without travelling: build the node, MOVE its launch command into
// `pendingLaunch` (`armForColdOpen`), upsert it through `applyNodeMutation`, persist with
// `writeDisk`, and tell the caller the session starts when that project is next viewed. This
// module is the pure half of applying that same path to an open whose OWN project is not active.
//
// Everything here is a decision, never a mutation: Canvas wires the store calls. Same reasoning as
// controlRouting.ts / projectOpen.ts / pendingLaunch.ts — vitest runs in the node environment, so
// the React component is not testable and these are.

import { rootPositionIn, type PlacedNode } from './projectOpen'

/** A serialized node, as the projects store keeps them for non-active projects. Structural subset
 *  of `CanvasNodeState` — deliberately not the type itself, so tests can build one in a line. */
export interface ColdNode {
  id: string
  kind?: string
  title?: string
  parentId?: string
  position: { x: number; y: number }
  size?: { width: number; height: number }
  cwd?: string
  agentId?: string
  accountId?: string
  tags?: string[]
  worktree?: { path?: string }
}

const asPlaced = (n: ColdNode): PlacedNode => ({
  id: n.id,
  parentId: n.parentId,
  position: n.position,
  size: n.size
})

const widthOf = (n: ColdNode): number => n.size?.width ?? 600
const heightOf = (n: ColdNode): number => n.size?.height ?? 400

/**
 * Which agent (if any) runs in a stored node — the serialized counterpart of Canvas's `agentIdOf`,
 * including its legacy `tags:['claude']` leg and its agent-status fallback (a hand-launched CLI in
 * a plain terminal is known nowhere else). The status lookup is injected rather than imported so
 * this stays pure.
 */
export function storedAgentIdOf(
  node: ColdNode | undefined,
  statusAgentId?: (id: string) => string | undefined
): string | undefined {
  if (!node || (node.kind ?? 'terminal') !== 'terminal') return undefined
  return (
    node.agentId ??
    ((node.tags ?? []).includes('claude') ? 'claude' : undefined) ??
    statusAgentId?.(node.id)
  )
}

/**
 * `--group` against a project that is not on screen. It must name an existing GROUP FRAME in the
 * SAME project as the source — the ids `--group` and `--after` speak are project-local, and here
 * (unlike `--project`, which refuses both flags outright) the target project IS the caller's own,
 * so they are resolvable rather than out of reach.
 */
export function coldResolveGroup(
  nodes: readonly ColdNode[],
  groupId: string | undefined,
  verb: string
): { ok: true; groupId?: string } | { ok: false; error: string } {
  if (!groupId) return { ok: true }
  const g = nodes.find((n) => n.id === groupId)
  if (!g || (g.kind ?? 'terminal') !== 'group') {
    return { ok: false, error: `${verb}: --group must name an existing group frame` }
  }
  return { ok: true, groupId }
}

/**
 * The cwd a node opened into a frame inherits, read off the SERIALIZED tree: the nearest ancestor
 * frame that states a worktree path, else one that states a cwd. Mirrors Canvas's
 * `cwdForNewNodeIn`, with two deliberate differences, both forced by the frame not being on screen:
 *
 *  - **No staleness check.** `useWorktrees` is epoch-scoped to the ACTIVE project, so for any other
 *    project we simply do not know whether a bound worktree directory still exists. Answering
 *    "unknown ⇒ not stale" is the same answer the persisted nodes already carry (every node created
 *    in that frame before today holds the same path), so a cold open is no worse off than the
 *    canvas it is writing into.
 *  - **No SSH exclusion by project.** The caller passes `sshProject`; a worktree path was computed
 *    from the LOCAL data dir and means nothing on a host, exactly as `cwdForNewNodeIn` says.
 */
export function coldGroupCwd(
  nodes: readonly ColdNode[],
  groupId: string | undefined,
  sshProject: boolean
): string | undefined {
  const seen = new Set<string>()
  let currentId = groupId
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const parent = nodes.find((n) => n.id === currentId)
    if (!parent) return undefined
    if (parent.worktree?.path && !sshProject) return parent.worktree.path
    if (parent.cwd) return parent.cwd
    currentId = parent.parentId
  }
  return undefined
}

/**
 * `--after` against a stored project. Same guardrail as Canvas's `resolveAfter`, and it is the
 * whole point of the flag: only a node running a hook-REPORTING agent may be waited on, because
 * `launchesToFire` cannot tell "will never report" from "has not reported yet" — waiting on a plain
 * terminal would hold the dependent forever. Deduped, since `--after a,a` is one wait and two dep
 * ropes for one pair would collide on a single id.
 */
export function coldResolveAfter(
  nodes: readonly ColdNode[],
  after: string | undefined,
  verb: string,
  hasHooksFor: (agentId: string) => boolean,
  statusAgentId?: (id: string) => string | undefined
): { ok: true; after?: string[] } | { ok: false; error: string } {
  if (!after) return { ok: true }
  const ids = [...new Set(after.split(',').map((s) => s.trim()).filter(Boolean))]
  if (!ids.length) return { ok: true }
  for (const depId of ids) {
    const dep = nodes.find((n) => n.id === depId)
    if (!dep) return { ok: false, error: `${verb}: --after names no existing node (${depId})` }
    const agent = storedAgentIdOf(dep, statusAgentId)
    if (!agent || !hasHooksFor(agent)) {
      return {
        ok: false,
        error: `${verb}: --after ${depId} is not an agent session that reports when it is done`
      }
    }
  }
  return { ok: true, after: ids }
}

/**
 * Where the i-th opened node lands when the source IS in this project: the same geometry the live
 * path's `placeBelow` uses (below the source, fanned right), computed from the source's PERSISTED
 * size and resolved to ROOT space so a source sitting inside a frame still places correctly.
 * Returns a CENTER point — the factories' `center` parameter.
 */
export function coldPlaceBelow(
  nodes: readonly ColdNode[],
  source: ColdNode,
  i: number
): { x: number; y: number } {
  const abs = rootPositionIn(nodes.map(asPlaced), asPlaced(source))
  return {
    x: abs.x + widthOf(source) / 2 + i * 460,
    y: abs.y + heightOf(source) + 80 + 210
  }
}

// Grid geometry for nodes opened INTO a group frame. Exported so Canvas's LIVE path uses these
// exact numbers too — the cold and live placements are the same layout, and two copies of a
// magic-number grid drift into two layouts.
export const GROUP_PAD_X = 24
export const GROUP_PAD_TOP = 56
export const GROUP_GAP = 24

export function groupSlot(slot: number, w: number, h: number): { x: number; y: number } {
  return {
    x: GROUP_PAD_X + (slot % 2) * (w + GROUP_GAP),
    y: GROUP_PAD_TOP + Math.floor(slot / 2) * (h + GROUP_GAP)
  }
}

export function groupSizeFor(
  children: number,
  w: number,
  h: number
): { width: number; height: number } {
  const cols = Math.min(2, Math.max(1, children))
  const rows = Math.max(1, Math.ceil(children / 2))
  return {
    width: GROUP_PAD_X * 2 + cols * w + (cols - 1) * GROUP_GAP,
    height: GROUP_PAD_TOP + rows * h + (rows - 1) * GROUP_GAP + GROUP_PAD_X
  }
}

/** How many direct children a stored frame already holds — the `existing` offset for `groupSlot`. */
export function coldGroupChildCount(nodes: readonly ColdNode[], groupId: string): number {
  return nodes.filter((n) => n.parentId === groupId).length
}

/**
 * The reply sentence for a session that was opened into a project the user is not looking at.
 *
 * ONE builder, used by BOTH cold-open sites (`--project` into another project, and this module's
 * own-project cold open), so an orchestrator never has to learn two phrasings for one outcome. The
 * `closed` clause is the only variation and it is additive: a closed project's canvas is still
 * "next viewed", it just has to be reopened first, and an agent that is told nothing would report a
 * session as started that has no process behind it.
 */
export function coldOpenMessage(
  count: number,
  what: string,
  projectName: string,
  ids: readonly string[],
  opts: { closed?: boolean } = {}
): string {
  return (
    `opened ${count} ${what} session(s) in "${projectName}" (${ids.join(', ')}) — ` +
    'queued; starts when that project is next viewed' +
    (opts.closed ? ' (that project is closed — reopen it from the welcome screen)' : '')
  )
}

/**
 * The clause appended to a display verb's own reply when the node landed in a project the user is
 * not looking at.
 *
 * A CLAUSE rather than a whole sentence, because the verb already said what it made ("showing web
 * nt-3f2a") and only the WHERE is new — so the four case bodies need to know nothing about
 * routing. Deliberately not `coldOpenMessage`: that one reports a session which has not started,
 * while a web page, a video or an image is COMPLETE the moment it is written, and telling a caller
 * its screenshot is "queued; starts when that project is next viewed" invites it to wait for
 * something that already happened. The `closed` clause is additive for the same reason it is
 * there: a caller told nothing would report the node as visible.
 */
export function offCanvasReplyClause(projectName: string, opts: { closed?: boolean } = {}): string {
  return (
    ` — placed in "${projectName}"; that project is not on screen` +
    (opts.closed ? ' and is closed (reopen it from the welcome screen)' : '')
  )
}

/**
 * The HUMAN half of the same event: a strip naming the project a background agent just wrote to.
 *
 * The reply above goes to the agent. Without this the person sees nothing at all, and the whole
 * point of not travelling is that the choice to go and look stays theirs — a choice they can only
 * make if they are told there is something to look at.
 *
 * Active voice and a full sentence. "A node opened by an agent in X." is a noun phrase, and the
 * passive repair ("was opened by") buries the actor the reader needs.
 */
export function offCanvasNoticeText(projectName: string, count: number): string {
  const what = count === 1 ? 'a node' : `${count} nodes`
  return `An agent opened ${what} in "${projectName}". That project is not on screen.`
}
