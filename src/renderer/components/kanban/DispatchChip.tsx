import { memo, useMemo } from 'react'
import { issueKey, issueRefFromHtmlUrl } from '@shared/github-issue-ref'
import { dispatchChipSig, useBoardDispatch } from '../../state/boardDispatch'

/**
 * Board dispatch's line on an issue card: queued (with its place), starting, or why a dispatch did
 * not start. Nothing at all when the card was never dispatched — a started run shows through the
 * card's run chips, like any other bound session.
 */
export const DispatchChip = memo(function DispatchChip({
  htmlUrl,
  number
}: {
  htmlUrl: string
  number: number
}): React.JSX.Element | null {
  const key = useMemo(() => issueKey(issueRefFromHtmlUrl(htmlUrl, number)), [htmlUrl, number])
  const sig = useBoardDispatch((s) => dispatchChipSig(s, key))
  if (!sig) return null
  const [status, reason, position] = sig.split('|')
  const text =
    status === 'queued'
      ? `Queued for an agent${Number(position) > 1 ? ` (#${position})` : ''}`
      : status === 'starting'
        ? 'Dispatching an agent…'
        : 'Not dispatched'
  return (
    <div
      className={`dispatch-chip dispatch-chip--${status}`}
      role="status"
      title={status === 'refused' ? reason : 'Board dispatch (Settings → GitHub Issues)'}
    >
      {text}
      {status === 'refused' && reason ? <span className="dispatch-chip__reason">: {reason}</span> : null}
    </div>
  )
})
