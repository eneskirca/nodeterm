// "New pull request": the form's prefill from the branch's commits, and the sentence for each
// reason a create did not land. The dialog is components/CreatePullDialog.tsx.
import type { GitHistoryItem } from '@shared/git-history'
import { MAX_PULL_TITLE, type PullReadFailure, type PullRefusal, type PullWriteReason } from '@shared/github-pull-detail'
import { thisMachine } from './machineName'

/**
 * Title and body from the commits on the branch since `base`, as GitHub's own form fills them: one
 * commit gives its subject and message body, several give the branch name and a list of subjects.
 * `items` is the history read from HEAD (newest first). The walk stops at the first commit that
 * carries the base branch (local or remote-tracking).
 */
export function pullDraftFromCommits(items: readonly GitHistoryItem[], base: string, branch: string): { title: string; body: string } {
  const isBase = (item: GitHistoryItem): boolean => (item.references ?? []).some((ref) =>
    ref.id === `refs/heads/${base}` || (ref.id.startsWith('refs/remotes/') && ref.id.endsWith(`/${base}`)))
  const stop = items.findIndex(isBase)
  // ponytail: a base that moved on is not decorated in this walk, so only the head commit is used.
  const commits = stop === -1 ? items.slice(0, 1) : items.slice(0, stop)
  if (commits.length !== 1) {
    return { title: branch.slice(0, MAX_PULL_TITLE), body: commits.map((c) => `- ${c.subject}`).reverse().join('\n') }
  }
  const [only] = commits
  return { title: only.subject.slice(0, MAX_PULL_TITLE), body: only.message.split('\n').slice(1).join('\n').trim() }
}

/** One sentence per reason a create did not land. */
export function createPullText(reason: PullWriteReason): string {
  return reason === 'not-approved'
    ? `This repository is not allowed on ${thisMachine()}. Open "Pull request…" once to allow it.`
    : CREATE_PULL_TEXT[reason]
}

const CREATE_PULL_TEXT: Record<Exclude<PullWriteReason, 'not-approved'>, string> = {
  validation: 'GitHub refused it. Check that the base exists, the branch has commits it lacks, and no pull request for the branch is open.',
  forbidden: 'This GitHub token may not open pull requests here. It needs Pull requests write access.',
  'signed-out': 'Sign in to GitHub again, then retry.',
  throttled: 'GitHub is rate limiting this token. Try again in a minute.',
  network: 'GitHub could not be reached. Try again.',
  'head-moved': 'The branch moved. Try again.',
  'not-mergeable': 'GitHub refused it. Try again on GitHub.',
  'own-pull': 'GitHub refused it. Try again on GitHub.',
  // A create never gets these (Apply suggestion and Delete branch only).
  'suggestion-stale': 'GitHub refused it. Try again on GitHub.',
  'from-fork': 'GitHub refused it. Try again on GitHub.',
  'branch-protected': 'GitHub refused it. Try again on GitHub.'
}

/** Why the form could not start: the core's own reason for the read, never a guess. */
export function pullStartText(reason: PullRefusal | PullReadFailure): string {
  if (reason === 'throttled') return CREATE_PULL_TEXT.throttled
  if (reason === 'signed-out') return CREATE_PULL_TEXT['signed-out']
  if (reason === 'not-approved' || reason === 'repository-mismatch' || reason === 'not-configured') return createPullText('not-approved')
  return CREATE_PULL_TEXT.network
}
