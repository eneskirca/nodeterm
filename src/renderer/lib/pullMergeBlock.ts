import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { GitHubPullChecksResult } from '@shared/github-pull-status'

/** Why Merge is off. `conflict` offers Resolve conflicts with agent, `behind` offers Update branch. */
export type MergeBlockKind = 'draft' | 'closed' | 'merged' | 'conflict' | 'behind' | 'blocked'
export interface MergeBlock { kind: MergeBlockKind; text: string }
/** The Overview's checks read, as `usePullChecks` answers it. */
export type PullChecksRead = GitHubPullChecksResult | 'loading' | null

const BLOCKED_UNKNOWN = 'Branch protection blocked this merge. Get the required reviews and checks first.'

/**
 * Why Merge is off, in one line: the lifecycle, then the shared pull-status merge state, and for a
 * protected branch the review decision and the head's checks (from the Overview's checks read).
 * Null = it may be tried (undecided and unstable included: GitHub then answers, a 405 says so).
 * ponytail: "checks" are all of the head's checks; GitHub does not say which ones are required.
 */
export function mergeBlock(
  d: Pick<GitHubPullDetail, 'lifecycle' | 'merge' | 'base' | 'head'>,
  checks?: PullChecksRead
): MergeBlock | null {
  if (d.lifecycle === 'draft') {
    return { kind: 'draft', text: 'A draft pull request cannot be merged. Mark it ready for review on GitHub first.' }
  }
  if (d.lifecycle === 'closed') return { kind: 'closed', text: 'This pull request is closed.' }
  if (d.lifecycle === 'merged') return { kind: 'merged', text: 'This pull request is already merged.' }
  if (d.merge === 'conflict') {
    return { kind: 'conflict', text: `This pull request has conflicts with ${d.base.ref}. Resolve them on its branch, then push.` }
  }
  if (d.merge === 'behind') {
    return {
      kind: 'behind',
      text: `This branch is behind ${d.base.ref}, and branch protection needs it up to date. Update the branch first.`
    }
  }
  if (d.merge !== 'blocked') return null
  const read = checks && checks !== 'loading' ? checks : undefined
  const why: string[] = []
  const review = read && (read.status === 'ok' || read.status === 'no-checks') ? read.review : undefined
  if (review === 'required') why.push('Branch protection needs an approving review.')
  if (review === 'changes-requested') why.push('A reviewer requested changes. Their approval is needed first.')
  const states = read?.status === 'ok' && read.headRefOid === d.head.sha ? read.checks.map((check) => check.state) : []
  if (states.includes('failed')) why.push('Checks are failing.')
  else if (states.includes('pending')) why.push('Checks are still running.')
  return { kind: 'blocked', text: why.length ? why.join(' ') : BLOCKED_UNKNOWN }
}
