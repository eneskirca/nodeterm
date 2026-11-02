import type { MainUpdateMode } from '@shared/types'
import type { ProjectLocalSettings } from '@shared/project-settings'

export interface BusyCheckNode {
  id: string
  title?: string
  agentId?: unknown
  cwd?: string
}

/** Mid-turn states: an update that rewrites files under an agent at these points races its edits. */
const BUSY = new Set(['working', 'blocked', 'waiting'])

const trimSep = (p: string): string => p.replace(/[\\/]+$/, '')

/**
 * The title of an agent node that is mid-turn in `dir` (or a folder below it), else null. Read at
 * click time from the live nodes and the agent-status store, so the refusal is never stale.
 * ponytail: for a project root this also counts an agent in a worktree nested under the root;
 * refusing there is the safe side.
 */
export function busyAgentIn(
  dir: string,
  nodes: readonly BusyCheckNode[],
  statusOf: (nodeId: string) => { state?: string } | undefined
): string | null {
  const root = trimSep(dir)
  for (const n of nodes) {
    if (!n.agentId || !n.cwd) continue
    const cwd = trimSep(n.cwd)
    const inside = cwd === root || cwd.startsWith(root + '/') || cwd.startsWith(root + '\\')
    if (inside && BUSY.has(statusOf(n.id)?.state ?? '')) return n.title || n.id
  }
  return null
}

export function mainDriftText({ base, behind }: { base: string; behind: number }): string {
  return `${base.replace(/^origin\//, '')} moved ${behind} commit${behind === 1 ? '' : 's'}`
}

export function rememberedUpdateMode(local: ProjectLocalSettings | undefined): MainUpdateMode | undefined {
  const mode = local?.worktree?.updateMode
  return mode === 'merge' || mode === 'rebase' ? mode : undefined
}
