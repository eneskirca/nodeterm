/** What to do with an outside edit to the active project's `.nodeterm/project.json`.
 *
 *  Two very different things arrive on the SAME broadcast (`workspaceExternalChange`):
 *
 *  1. A **git pull / another machine** rewrote the file. The disk side and the local side can
 *     genuinely disagree about the same nodes, so the user has to pick — that is the conflict bar,
 *     and it is re-fetchable: whatever is discarded is still in the remote/branch.
 *  2. The **phone registered a session it just started** (`appendProjectNode`, or the SSH poll
 *     picking that up). That is purely ADDITIVE — a node id nothing here has ever seen, backed by
 *     a tmux session that is already running. Nothing re-emits it: parking it behind a bar and
 *     then answering "Keep my version" (or merely switching projects, which drops the bar and lets
 *     the next whole-workspace save write our canvas over disk) DELETES a live session, headless.
 *
 *  So an incoming node we do not have is adopted ALWAYS — in the merge case and in the conflict
 *  case alike. It cannot collide with a local edit (no local node carries that id), and it is the
 *  only part of the payload nobody can produce a second time. The bar then decides only the REST,
 *  keeping its documented meaning ("the disk side is re-fetchable") intact.
 */
import type { CanvasNodeState, Project } from '@shared/types'

export type ExternalChangeDecision =
  /** No unsaved local edits: take the disk version wholesale (the pre-existing behavior). */
  | { kind: 'reload'; added: CanvasNodeState[] }
  /** Dirty, and the file differs from our last-known disk state ONLY by added nodes. */
  | { kind: 'merge'; added: CanvasNodeState[] }
  /** Dirty, and something we also hold changed on disk: adopt `added`, ask about the rest. */
  | { kind: 'conflict'; added: CanvasNodeState[] }
  /** Dirty, and nothing we care about differs (a self-write echo, a rev-only touch). */
  | { kind: 'ignore'; added: CanvasNodeState[] }

export interface ExternalChangeInput {
  /** Are there unsaved canvas edits? (`dirtyRef` — the whole reason a bar exists.) */
  dirty: boolean
  /** Our last-known DISK state for this project: the projects-store copy, which is written by
   *  a load or a commit+save. Missing (unknown project) ⇒ we cannot classify ⇒ conflict. */
  base: Project | undefined
  /** The version that just landed from disk / the SSH poll. */
  incoming: Project
  /** Node ids React Flow currently holds — including ones created locally and not yet saved. */
  liveNodeIds: Iterable<string>
}

/** Fields that are allowed to differ without meaning "the disk side changed something of ours":
 *  `nodes` is compared separately; `viewport`/`defaultAccountId` are machine-local (they come from
 *  our own index, not the shared file); `id` is the join key; the rest are runtime-only flags. */
const NOT_SHARED_STATE: ReadonlySet<string> = new Set([
  'id',
  'nodes',
  'viewport',
  'defaultAccountId',
  'closed',
  'unavailable',
  'remote'
])

/** Stable JSON (object keys sorted at every depth) so two structurally equal values compare equal
 *  regardless of the order the serializers happened to emit their keys in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : v
  )
}

function projectShell(project: Project): string {
  return canonicalJson(
    Object.fromEntries(Object.entries(project).filter(([k]) => !NOT_SHARED_STATE.has(k)))
  )
}

export function decideExternalChange(input: ExternalChangeInput): ExternalChangeDecision {
  const { dirty, base, incoming } = input
  const live = new Set(input.liveNodeIds)
  const baseNodes = new Map((base?.nodes ?? []).map((n) => [n.id, n]))
  // A node is "added" only when NEITHER the canvas nor our last-known disk state has its id. The
  // base check is what keeps a locally DELETED (not yet saved) node from being resurrected by the
  // file that still lists it.
  const added = incoming.nodes.filter((n) => !live.has(n.id) && !baseNodes.has(n.id))

  if (!dirty) return { kind: 'reload', added }
  if (!base) return { kind: 'conflict', added }

  const incomingNodes = new Map(incoming.nodes.map((n) => [n.id, n]))
  const nodesUntouched = [...baseNodes].every(([id, node]) => {
    const other = incomingNodes.get(id)
    return !!other && canonicalJson(node) === canonicalJson(other)
  })
  const additiveOnly = nodesUntouched && projectShell(base) === projectShell(incoming)
  if (!additiveOnly) return { kind: 'conflict', added }
  return added.length ? { kind: 'merge', added } : { kind: 'ignore', added }
}

/** Append incoming nodes to the live canvas, skipping any id it already holds (the SSH poll
 *  re-delivers the same file until the next save, and a double-added node would be a duplicate
 *  React Flow id — two views onto one tmux session). Generic over the canvas node shape so the
 *  helper stays pure and testable. */
export function mergeIncomingNodes<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const have = new Set(current.map((n) => n.id))
  const fresh = incoming.filter((n) => !have.has(n.id))
  return fresh.length ? [...current, ...fresh] : current
}

/**
 * The one clause both surfaces use to describe adopted sessions, so they cannot drift.
 *
 * It deliberately does NOT say "from another device (your phone, or another machine)". Nothing that
 * reaches this point knows the source: the adopting side is a diff against the project file, and
 * that file can hold a session this canvas never had for reasons that have no device behind them —
 * an SSH mirror write that was acked and then dropped, a git pull, a stale server copy. The 2026-09-06
 * field report was exactly that: 16 terminals deleted on a slow SSH link came straight back claiming
 * a phone had registered them, and the user owns no phone. A wrong attribution is worse than none —
 * it sends the reader looking for a device instead of at the file — so this names the FILE, which is
 * the only thing actually observed, and offers the possibilities without asserting one.
 */
function adoptedClause(addedCount: number): string {
  const s = addedCount === 1 ? '' : 's'
  const verb = addedCount === 1 ? 'was' : 'were'
  return (
    `${addedCount} session${s} in the project file ${verb} not on this canvas and ${verb} added ` +
    `(from another device, or from an older copy of the file).`
  )
}

/** The conflict strip's sentence. Derived from what actually arrived so the bar cannot claim
 *  something vague while a real session sits on the canvas behind it. */
export function conflictBarMessage(addedCount: number): string {
  // Every wording ends on the same clause, because the bar's most important fact is not what
  // changed on disk — it is that the autosave is SUSPENDED until one of the two buttons is
  // pressed, and stays suspended for as long as the bar is ignored. A user who read this strip as
  // an FYI about someone else's git pull had no way to know their own canvas had stopped being
  // written (the 2026-09-02 silent freeze: two and a half hours, eight unsaved cards).
  const paused = ' Your canvas is not being saved until you choose.'
  if (addedCount <= 0)
    return 'Project file changed on disk (git pull or another machine).' + paused
  return (
    `${adoptedClause(addedCount)} Other parts of the project file also changed on disk — ` +
    `choose which version of those to keep.` +
    paused
  )
}

/** The one-off note shown when an incoming session was adopted with no bar at all. */
export function adoptedNodesNotice(addedCount: number): string {
  return adoptedClause(addedCount)
}
