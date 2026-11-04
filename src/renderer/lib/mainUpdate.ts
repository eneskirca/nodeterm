import type { MainUpdateMode } from '@shared/types'

export interface BusyCheckNode {
  id: string
  title?: string
  agentId?: unknown
  cwd?: string
}

/** Mid-turn states: an update that rewrites files under an agent at these points races its edits. */
const BUSY = new Set(['working', 'blocked', 'waiting'])

// One spelling for comparison: `/` separators, no trailing one, and a Windows drive path lowercased
// (its filesystem ignores case). ponytail: a POSIX name holding `\` reads as a separator; that can
// only find MORE busy agents, so the check errs toward refusing.
const norm = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s
}

/** The agent nodes in `dir` or a folder below it. */
export function agentsIn(dir: string, nodes: readonly BusyCheckNode[]): BusyCheckNode[] {
  const root = norm(dir)
  return nodes.filter((n) => {
    if (!n.agentId || !n.cwd) return false
    const cwd = norm(n.cwd)
    return cwd === root || cwd.startsWith(root + '/')
  })
}

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
  const n = agentsIn(dir, nodes).find((a) => BUSY.has(statusOf(a.id)?.state ?? ''))
  return n ? n.title || n.id : null
}

export function mainDriftText({ base, behind }: { base: string; behind: number }): string {
  return `${base.replace(/^origin\//, '')} moved ${behind} commit${behind === 1 ? '' : 's'}`
}

/** What an agent in the checkout is told once main landed under it, so it does not edit from a stale read. */
export function mainUpdatedNote(u: { mode: MainUpdateMode; base: string; branch: string; behind: number; cwd: string }): string {
  const base = u.base.replace(/^origin\//, '')
  const what = u.mode === 'merge' ? `merged ${base} into ${u.branch}` : `rebased ${u.branch} onto ${base}`
  return `nodeterm: the user ${what} in ${u.cwd} (${u.behind} new commit${u.behind === 1 ? '' : 's'} from ${base}). ` +
    (u.mode === 'rebase' ? 'The branch history was rewritten. ' : '') +
    'Files here may have changed since you last read them: read a file again before you edit it. ' +
    'Reply in one line and do not start other work.'
}
