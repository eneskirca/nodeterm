// The merge box's status rows (F1): review, checks, unresolved threads, merge state. Pure: derived
// in render from the reads the shell already holds. Each row's link jumps to where it is acted on.
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { mergeBlock, type PullChecksRead } from '../../lib/pullMergeBlock'
import type { IconName } from './Icon'
import { headChecks } from './PullChecksTab'
import type { PullJump, ReadinessTone } from './readiness'

export interface MergeRow {
  key: 'review' | 'checks' | 'threads' | 'merge'
  tone: ReadinessTone
  icon: IconName
  title: string
  sub?: string
  link?: { label: string; jump: PullJump }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The rows for an open or draft PR, top to bottom. A fact the reads do not know yet has no row. */
export function mergeRows(d: GitHubPullDetail, checks: PullChecksRead | undefined, openThreads: number | undefined): MergeRow[] {
  const rows: MergeRow[] = []
  const read = checks && checks !== 'loading' ? checks : undefined
  if (read && (read.status === 'ok' || read.status === 'no-checks')) {
    // "Request review" lands on the sidebar's Reviewers, whose Edit asks someone.
    const link = { label: 'Request review', jump: { tab: 'conversation', section: 'details' } } as const
    const by = (state: 'approved' | 'changes-requested') => {
      const logins = (d.sidebar?.reviewers ?? []).filter((r) => r.state === state).map((r) => r.user.login)
      return logins.length ? `by ${logins.join(', ')}` : undefined
    }
    if (read.review === 'approved') rows.push({ key: 'review', tone: 'ok', icon: 'check', title: 'Approved', sub: by('approved'), link })
    else if (read.review === 'changes-requested') {
      rows.push({ key: 'review', tone: 'danger', icon: 'x', title: 'Changes requested', sub: by('changes-requested') ?? 'A reviewer must approve before it can merge.', link })
    } else if (read.review === 'required') {
      rows.push({ key: 'review', tone: 'attention', icon: 'eye', title: 'Review required', sub: 'At least one approving review is needed.', link })
    } else rows.push({ key: 'review', tone: 'muted', icon: 'eye', title: 'No review required', link })
  }
  const runs = headChecks(checks, d.head.sha)
  const show = { label: 'Show', jump: { tab: 'checks' } } as const
  if (runs) {
    const failed = runs.filter((check) => check.state === 'failed').length
    const pending = runs.filter((check) => check.state === 'pending').length
    if (failed) rows.push({ key: 'checks', tone: 'danger', icon: 'x', title: plural(failed, 'failing check'), sub: `of ${runs.length}`, link: show })
    else if (pending) rows.push({ key: 'checks', tone: 'attention', icon: 'sync', title: 'Checks running', sub: `${runs.length - pending}/${runs.length} done`, link: show })
    else rows.push({ key: 'checks', tone: 'ok', icon: 'check', title: 'All checks passed', sub: `${runs.length} successful`, link: show })
  } else if (read?.status === 'no-checks') rows.push({ key: 'checks', tone: 'muted', icon: 'check', title: 'No checks', link: show })
  if (openThreads !== undefined) {
    rows.push(openThreads
      ? {
          key: 'threads', tone: 'attention', icon: 'thread', title: `${plural(openThreads, 'conversation')} unresolved`,
          // GitHub says it may merge: branch protection does not require resolved conversations.
          sub: d.merge === 'ready' || d.merge === 'unstable' || d.merge === 'hooks' ? 'merging is still allowed' : undefined,
          link: { label: 'Jump', jump: { tab: 'files' } }
        }
      : { key: 'threads', tone: 'ok', icon: 'check', title: 'All conversations resolved' })
  }
  const base = d.base.ref
  if (d.merge === 'conflict') rows.push({ key: 'merge', tone: 'danger', icon: 'conflict', title: `Conflicts with ${base}`, sub: 'Resolve them on the branch before it can merge.' })
  else if (d.merge === 'behind') rows.push({ key: 'merge', tone: 'attention', icon: 'sync', title: `Behind ${base}`, sub: 'Branch protection needs it up to date. Update the branch first.' })
  else if (d.merge === 'blocked') rows.push({ key: 'merge', tone: 'attention', icon: 'x', title: 'Merging is blocked', sub: mergeBlock({ ...d, lifecycle: 'open' }, checks)?.text })
  else if (d.merge === 'undecided') rows.push({ key: 'merge', tone: 'muted', icon: 'sync', title: 'Checking for conflicts', sub: 'GitHub has not decided yet. Refresh in a moment.' })
  else if (d.merge) rows.push({ key: 'merge', tone: 'ok', icon: 'check', title: 'No conflicts', sub: `with ${base}` })
  return rows
}
