// The issues node (renderer/nodes/IssuesNode.tsx): its persisted reference and the "Work on this"
// prompt. The reference names a repository and the issue the user left selected, nothing else: issue
// text never lands in the git-shared project file, and every load re-validates it.
//
// The prompt carries the REFERENCE only, like every board start (`github-issue-ref.ts`): the agent
// reads the issue's text itself with `gh` (CONTRIBUTING.md: never interpolate issue.title/body).

import type { GitHubIssueCardView } from './github-issues'
import { issueLaunchPrompt, issueUrl, normalizeIssueRef, parseRepository, type IssueRef } from './github-issue-ref'

export interface IssuesNodeRef {
  /** `owner/name`. The core refuses it unless it is the project's approved repository. */
  repository: string
  /** The issue shown in the detail pane. */
  issueNumber?: number
}

/** The reference if it is well formed, else undefined. Copies exactly the two fields. */
export function normalizeIssuesRef(value: unknown): IssuesNodeRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { repository, issueNumber } = value as Record<string, unknown>
  if (typeof repository !== 'string' || !parseRepository(repository)) return undefined
  const number = typeof issueNumber === 'number' && Number.isSafeInteger(issueNumber) && issueNumber >= 1 &&
    issueNumber <= 2_147_483_647 ? issueNumber : undefined
  return { repository, ...(number ? { issueNumber: number } : {}) }
}

/** Where the repository's issues live on github.com. */
export function issuesWebUrl(repository: string): string {
  return `https://github.com/${repository}/issues`
}

/** One line of inert text: no C0/C1 control, no DEL, no bidi override, no `[BEGIN|END <label> TEXT]`
 *  marker, bounded. Used by the pull node's "Send to…" and review feedback prompts. */
export function inert(text: string, max: number, label = 'ISSUE'): string {
  // eslint-disable-next-line no-control-regex
  let flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ')
  // Until nothing changes: removing one marker must not join the halves of another into a new one.
  for (let before = ''; before !== flat;) {
    before = flat
    flat = flat.replace(new RegExp(`\\[\\s*(BEGIN|END)\\s+${label}\\s+TEXT\\s*\\]`, 'gi'), ' ').replace(/\s+/g, ' ')
  }
  flat = flat.trim()
  return flat.length > max ? `${flat.slice(0, max)} (truncated: read the rest with gh)` : flat
}

/** "Work on this": the board start's prompt (reference, `gh` read, the hard limits) plus the issue's
 *  link. Undefined for a malformed reference. */
export function issueWorkPrompt(ref: IssueRef): string | undefined {
  const r = normalizeIssueRef(ref)
  const start = r && issueLaunchPrompt(r)
  return r && start ? `${start} Link: ${issueUrl(r)}.` : undefined
}

/** The node's "Work on this" asks Canvas to start the agent (detail: `IssueWorkRequest`). */
export const ISSUE_WORK_EVENT = 'nodeterm:issue-work'

export interface IssueWorkRequest {
  /** The issues node: the new agent opens beside it, with a rope from it. */
  nodeId: string
  /** The issue as the node read it (the board's card shape). */
  issue: GitHubIssueCardView
  /** Open the agent in a new worktree (the board's "Start with agent in a new worktree"). */
  worktree: boolean
}
