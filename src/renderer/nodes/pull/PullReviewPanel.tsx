import { useRef, useState } from 'react'
import type { PullLineDraft, PullReviewEvent } from '@shared/github-pull-detail'
import { OWN_PULL_TEXT, useWrite, WRITE_TEXT, type ViewProps } from './shared'

const VERDICTS: ReadonlyArray<{ event: PullReviewEvent; label: string; hint: string }> = [
  { event: 'COMMENT', label: 'Comment', hint: 'General feedback, no verdict.' },
  { event: 'APPROVE', label: 'Approve', hint: 'Ready to merge.' },
  { event: 'REQUEST_CHANGES', label: 'Request changes', hint: 'Blocks the merge until resolved.' }
]

/** The Files tab's "Finish your review" panel (F2): a summary, one verdict, then one review write
 *  tied to `headSha` that carries every pending line comment. An own PR keeps Approve and Request
 *  changes off, with the reason. */
export function PullReviewPanel(props: ViewProps & {
  headSha: string; ownPull: boolean; pending: readonly PullLineDraft[]
  onDropPending: (sent: readonly PullLineDraft[]) => void; onClose: () => void
}): React.JSX.Element {
  const { api, projectId, pull, onWritten, headSha, ownPull, pending, onDropPending, onClose } = props
  const [body, setBody] = useState('')
  const [event, setEvent] = useState<PullReviewEvent>('COMMENT')
  // The drafts this submit carries: only those go once it lands (one added meanwhile stays).
  const sent = useRef<readonly PullLineDraft[]>([])
  const { busy, refusal, run } = useWrite(() => { onDropPending(sent.current); onClose(); onWritten() })
  // GitHub refuses an empty Request changes, and an empty Comment with no line comments.
  const ready = event === 'APPROVE' || !!body.trim() || (event === 'COMMENT' && pending.length > 0)
  const submit = () => {
    const comments = [...pending]
    sent.current = comments
    void run(() => api.reviewPull({
      projectId, repository: pull.repository, pullNumber: pull.pullNumber, event, body, headSha,
      ...(comments.length ? { comments } : {})
    }))
  }
  return (
    <div role="dialog" aria-label="Finish your review" className="pf-review">
      <strong className="pf-review__title">Finish your review</strong>
      <textarea className="pf-box" rows={3} aria-label="Review summary" placeholder="Summary (optional)" autoFocus
        value={body} onChange={(e) => setBody(e.target.value)} />
      <fieldset className="pf-review__verdicts">
        <legend className="sr-only">Verdict</legend>
        {VERDICTS.map((v) => {
          const off = ownPull && v.event !== 'COMMENT'
          return (
            <label key={v.event} className="pf-review__radio" aria-disabled={off || undefined} title={off ? OWN_PULL_TEXT : undefined}>
              <input type="radio" name={`verdict-${pull.pullNumber}`} checked={event === v.event} disabled={off}
                onChange={() => setEvent(v.event)} />
              <span>{v.label}<small>{v.hint}</small></span>
            </label>
          )
        })}
      </fieldset>
      {ownPull && <p className="pf-muted">{OWN_PULL_TEXT}</p>}
      {refusal && <p className="pf-error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pf-review__foot">
        <span className="pf-muted">
          {pending.length === 1 ? '1 line comment included' : `${pending.length} line comments included`}
        </span>
        <button className="pr-btn pr-btn--primary" disabled={busy || !ready} onClick={submit}>Submit review</button>
      </div>
    </div>
  )
}
