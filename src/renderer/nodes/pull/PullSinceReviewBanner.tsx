// "Since my last review" (F-10): the Conversation banner and the Files tab's extra Compare choice,
// both from one `pullSinceReview` read in the shell.
import { useMemo } from 'react'
import type { GitHubPullSinceReviewResult, PullSinceReview } from '@shared/github-pull-since-review'
import { Icon } from './Icon'
import type { PullCompareOption } from './PullFilesTab'
import { usePullRead, type ViewProps } from './shared'
import './PullSinceReviewBanner.css'

/** The Compare value of "Since my last review". */
export const SINCE_REVIEW = 'since-review'

const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

// ponytail: a bridge slice without this read (a test fake written before F-10) reads as "not
// configured", so the shell never throws for it; the real bridges always carry it.
const NO_READ = async (): Promise<GitHubPullSinceReviewResult> => ({ status: 'refused', reason: 'not-configured' })

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The comparison to the viewer's last review, and the Compare choice for it: only once the viewer
 *  reviewed and the head moved since. The list is memoized on the read, as PullFilesTab asks. */
export function useSinceReview(props: ViewProps): { since?: PullSinceReview; compareExtra?: readonly PullCompareOption[] } {
  const { api } = props
  const read = usePullRead(api.pullSinceReview ?? NO_READ, props)
  const since = read !== 'loading' && read.status === 'ok' ? read.since : undefined
  const compareExtra = useMemo((): readonly PullCompareOption[] | undefined => {
    if (read === 'loading' || read.status !== 'ok' || read.since.kind !== 'moved') return undefined
    const { files, truncated } = read.since
    const answer = { status: 'ok' as const, files, truncated, observedAt: read.observedAt }
    return [{
      value: SINCE_REVIEW,
      label: `Since my last review (${plural(files.length, 'file')})`,
      files: async () => answer,
      contents: api.pullSinceReviewFileContents
    }]
  }, [read, api])
  return { since, compareExtra }
}

/** Above the Conversation timeline: the new commits since the viewer's last review, with a button
 *  that opens Files changed on that comparison; or, after a force-push, why it cannot. */
export function PullSinceReviewBanner({ since, onDiff }: {
  since: PullSinceReview | undefined; onDiff: () => void
}): React.JSX.Element | null {
  if (since?.kind === 'unavailable') {
    return (
      <div className="pr-since pr-since--muted" role="status">
        <Icon name="sync" size={16} />
        <span>{`Cannot show the changes since your last review on ${dayOf(since.submittedAt)}: the branch was force-pushed.`}</span>
      </div>
    )
  }
  if (since?.kind !== 'moved' || since.commits < 1) return null
  return (
    <div className="pr-since" role="status">
      <Icon name="commit" size={16} />
      <span>{`${plural(since.commits, 'new commit')} since your last review on ${dayOf(since.submittedAt)}`}</span>
      <button className="pr-btn pr-since__diff" onClick={onDiff}>Diff since review</button>
    </div>
  )
}
