import { useState } from 'react'
import type { GitHubPullDetail, PullLineDraft, PullReviewEvent, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import { OWN_PULL_TEXT, useWrite, WRITE_TEXT, type ViewProps } from './shared'

/** The comment box at the end of the Conversation tab (F1 card): Close or Reopen pull request
 *  (`lifecycle` given), Request changes, Approve and Comment. The
 *  draft lives here (the tab stays mounted), so it survives a tab switch; it is never persisted.
 *  `reviewPanel`: the Files tab's "Review changes" panel, where the box is the review summary and an
 *  own PR shows Approve and Request changes off, with the reason. */
export function PullComposer(props: ViewProps & {
  headSha: string; ownPull: boolean; pending: readonly PullLineDraft[]; onDropPending: (sent: readonly PullLineDraft[]) => void
  reviewPanel?: true
  /** The Conversation tab's box: the PR's state, for its Close or Reopen button. */
  lifecycle?: GitHubPullDetail['lifecycle']
}): React.JSX.Element {
  const { api, projectId, pull, onWritten, headSha, ownPull, pending, onDropPending, reviewPanel, lifecycle } = props
  const state = useWrite(onWritten)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }

  const run = async (write: () => Promise<PullWriteResult>, sent: readonly PullLineDraft[] = []) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write().catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setDraft('')
    onDropPending(sent)
    onWritten()
  }
  // A review is tied to the head the node shows, so GitHub refuses it if the PR moved since. The
  // pending line comments ride the review.
  const review = (event: PullReviewEvent) => {
    const sent = [...pending]
    return run(() =>
      api.reviewPull({ ...at, event, body: draft, headSha, ...(sent.length ? { comments: sent } : {}) }), sent)
  }

  return (
    <div className="pull-compose">
      <textarea className="pull-compose__box" aria-label={reviewPanel ? 'Review summary' : 'Comment'}
        placeholder={reviewPanel ? 'Leave a review summary' : 'Add a comment'}
        value={draft} onChange={(event) => setDraft(event.target.value)} />
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      {state.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[state.refusal]}</p>}
      <div className="pull-compose__foot">
        {!reviewPanel && <span className="pull-compose__hint">Markdown · @ to mention</span>}
        {!reviewPanel && (lifecycle === 'open' || lifecycle === 'draft' || lifecycle === 'closed') && (
          <button className="pull-compose__button" disabled={busy || state.busy}
            onClick={() => void state.run(() => api.setPullState({ ...at, open: lifecycle === 'closed' }))}>
            {lifecycle === 'closed' ? 'Reopen pull request' : 'Close pull request'}
          </button>
        )}
        <div className="pull-compose__actions">
          {(!ownPull || reviewPanel) && (
            <>
              <button className="pull-compose__button" disabled={busy || ownPull || !draft.trim()} title={ownPull ? OWN_PULL_TEXT : undefined}
                onClick={() => void review('REQUEST_CHANGES')}>Request changes</button>
              <button className="pull-compose__button" disabled={busy || ownPull} title={ownPull ? OWN_PULL_TEXT : undefined}
                onClick={() => void review('APPROVE')}>Approve</button>
            </>
          )}
          {/* With pending line comments, Comment submits them as a comment review. */}
          <button className="pull-compose__button pull-compose__button--primary" disabled={busy || (!pending.length && !draft.trim())}
            onClick={() => void (pending.length ? review('COMMENT') : run(() => api.commentOnPull({ ...at, body: draft })))}>Comment</button>
        </div>
      </div>
      {pending.length > 0 && (
        <p className="pull-node__empty">
          {pending.length === 1 ? '1 line comment waits' : `${pending.length} line comments wait`} for your review: Comment,
          Approve or Request changes sends {pending.length === 1 ? 'it' : 'them'}.{' '}
          <button className="pull-compose__button" disabled={busy} onClick={() => onDropPending(pending)}>Discard</button>
        </p>
      )}
      {ownPull && <p className="pull-node__empty">{OWN_PULL_TEXT}</p>}
    </div>
  )
}
