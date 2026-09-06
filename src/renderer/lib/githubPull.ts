import type { GitHubIssue } from '@shared/github-issues'

/** What a pull request card says it is. `merged` and `closed` both arrive as `state: 'closed'`,
 *  and only `mergedAt` separates them; `draft` outranks `open` because that is the distinction a
 *  reader is looking for. */
export type PullCardState = 'draft' | 'open' | 'merged' | 'closed'

export function pullCardState(item: Pick<GitHubIssue, 'state' | 'pull'>): PullCardState {
  if (item.state === 'closed') return item.pull?.mergedAt ? 'merged' : 'closed'
  return item.pull?.draft ? 'draft' : 'open'
}

export const PULL_STATE_LABEL: Record<PullCardState, string> = {
  draft: 'Draft',
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed'
}
