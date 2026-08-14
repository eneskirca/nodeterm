import type { GroupWorktree } from './worktree'
import type { BoundGroup } from './worktree-reconcile'

/**
 * One checkout the Source Control panel can operate on.
 *
 * There is deliberately no `kind: 'main' | 'worktree'` field: `id === 'main'` already IS that
 * distinction (it is the one id no group node can have), and the label already says "(worktree)".
 * A third encoding of the same fact is one more thing that can drift out of step with the other two.
 */
export interface ScmScope {
  /** 'main' for the project's own checkout, else the bound group's node id. */
  id: string
  label: string
  cwd: string
}

/**
 * The bits of a canvas node this module reasons about. Kept structural (not the renderer's
 * `CanvasNode`) so `src/shared` stays free of React Flow — every field the callers pass fits.
 */
export interface ScmScopeNode {
  id: string
  type?: string
  parentId?: string
  selected?: boolean
  data?: { worktree?: GroupWorktree }
}

/** Every group node on the canvas that carries a worktree binding, in canvas order. */
export function boundGroups(nodes: ScmScopeNode[]): BoundGroup[] {
  const out: BoundGroup[] = []
  for (const n of nodes) {
    if (n.type === 'group' && n.data?.worktree) out.push({ groupId: n.id, worktree: n.data.worktree })
  }
  return out
}

/** The main checkout first, then one scope per bound worktree. */
export function scmScopes(project: { cwd?: string; name: string }, bound: BoundGroup[]): ScmScope[] {
  if (!project.cwd) return []
  return [
    { id: 'main', label: `${project.name} (main checkout)`, cwd: project.cwd },
    ...bound.map((b) => ({
      id: b.groupId,
      label: `${b.worktree.branch} (worktree)`,
      cwd: b.worktree.path
    }))
  ]
}

/**
 * The group the canvas selection points at, which Source Control opens on: a selected group node
 * itself, else a selected node's parent chain. Nested unbound groups inherit the nearest bound
 * ancestor's Source Control scope.
 *
 * A selection can span several nodes (box-select), so the pick is made explicit rather than left to
 * array order: a candidate group that is actually BOUND to a worktree wins over any other, because
 * that is the only selection that carries scoping intent. Among equals the first in canvas order
 * wins (a stable, if arbitrary, tie-break).
 */
export function selectedScmGroupId(nodes: ScmScopeNode[]): string | null {
  const candidates: string[] = []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const n of nodes) {
    if (!n.selected) continue
    const seen = new Set<string>()
    let groupId = n.type === 'group' ? n.id : n.parentId
    while (groupId && !seen.has(groupId)) {
      seen.add(groupId)
      if (!candidates.includes(groupId)) candidates.push(groupId)
      groupId = byId.get(groupId)?.parentId
    }
  }
  if (candidates.length === 0) return null
  const boundIds = new Set(boundGroups(nodes).map((b) => b.groupId))
  return candidates.find((id) => boundIds.has(id)) ?? candidates[0]
}

/**
 * The scope to open on: the selected node's bound group, else the main checkout. A selected
 * group with no worktree is not an error — it simply means the main checkout.
 */
export function defaultScmScope(scopes: ScmScope[], selectedGroupId: string | null): ScmScope | undefined {
  const hit = selectedGroupId ? scopes.find((s) => s.id === selectedGroupId) : undefined
  return hit ?? scopes.find((s) => s.id === 'main')
}
