// A pull node's linked issue opens in the Issues node: Canvas listens for `ISSUE_OPEN_EVENT`, then
// focuses the repository's Issues node on that issue, or creates one already on it.
import type { CanvasNode } from '../state/workspace'

export const ISSUE_OPEN_EVENT = 'nodeterm:issue-open'

export interface IssueOpenRequest { repository: string; issueNumber: number }

/** One Issues node per repository (the add menu's rule): the existing one, moved to the issue, or none. */
export function openIssueInNodes(
  nodes: readonly CanvasNode[], { repository, issueNumber }: IssueOpenRequest
): { focus: string; nodes: CanvasNode[] } | { create: true } {
  const existing = nodes.find((n) => n.type === 'issues' && n.data.issues?.repository.toLowerCase() === repository.toLowerCase())
  if (!existing?.data.issues) return { create: true }
  const issues = { ...existing.data.issues, issueNumber }
  return {
    focus: existing.id,
    nodes: nodes.map((n) => n.id === existing.id ? { ...n, data: { ...n.data, issues } } : n)
  }
}
