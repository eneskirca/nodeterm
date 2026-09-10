/**
 * How the Mesa (table) view groups terminals: one column per group frame, plus a
 * drop-target "Libre" column for ungrouped sessions. Pure — the view just renders it.
 */

export interface MesaNode {
  id: string
  type?: string
  parentId?: string
  data: { title?: unknown; color?: unknown; callsign?: unknown; agentId?: unknown }
}

export interface MesaColumn {
  /** Group node id, or null for the ungrouped bucket. */
  id: string | null
  title: string
  color: string
  nodeIds: string[]
}

export const LIBRE_TITLE = 'Libre'

const DEFAULT_COLOR = '#0a84ff'

export function isTerminalNode(n: MesaNode): boolean {
  return !n.type || n.type === 'terminal'
}

export function mesaColumns(nodes: readonly MesaNode[]): MesaColumn[] {
  const groups = nodes.filter((n) => n.type === 'group')
  const terminals = nodes.filter(isTerminalNode)
  const byParent = new Map<string | null, string[]>()
  for (const t of terminals) {
    const parent = t.parentId ?? null
    const list = byParent.get(parent) ?? []
    list.push(t.id)
    byParent.set(parent, list)
  }
  const cols: MesaColumn[] = groups.map((g) => ({
    id: g.id,
    title: typeof g.data.title === 'string' && g.data.title.trim() ? g.data.title : 'Grupo',
    color: typeof g.data.color === 'string' ? g.data.color : DEFAULT_COLOR,
    nodeIds: byParent.get(g.id) ?? []
  }))
  const ungrouped = byParent.get(null) ?? []
  // Always keep a Libre column when there are groups — that's how you drag a session out.
  // With no groups, skip the header and the view renders a flat grid of `ungrouped`.
  if (groups.length > 0) {
    cols.push({
      id: null,
      title: LIBRE_TITLE,
      color: '#6ac4dc',
      nodeIds: ungrouped
    })
  } else if (ungrouped.length) {
    cols.push({
      id: null,
      title: LIBRE_TITLE,
      color: '#6ac4dc',
      nodeIds: ungrouped
    })
  }
  return cols
}

export function mesaHasGroups(nodes: readonly MesaNode[]): boolean {
  return nodes.some((n) => n.type === 'group')
}
