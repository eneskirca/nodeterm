import { useEffect, useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { Icon } from './Icon'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'

/**
 * The merge box's state header (F4) for a PR that cannot merge now: a draft (Ready for review), a
 * merged PR (Delete branch) or a closed one (Reopen). An open PR has none: Close lives in the
 * header's More actions. Delete branch shows only for a head in this repository that is not its
 * default branch (read once through "New pull request"'s read); the core checks all three again
 * before it deletes. One write at a time; the node reads again after it lands.
 */
export function PullLifecycleActions(props: ViewProps & { detail: GitHubPullDetail }): React.JSX.Element | null {
  const { api, projectId, pull, detail: d, onWritten } = props
  const write = useWrite(onWritten)
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const head = d.head.ref
  const mayDelete = d.lifecycle === 'merged' && !d.fromFork
  // The default branch, only for a merged same-repository head. Null = not known (no button).
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  // ponytail: GitHub's PR read does not say the branch is gone, so a delete is remembered for this mount only.
  const [deleted, setDeleted] = useState<string | null>(null)
  useEffect(() => {
    if (!mayDelete) return
    let live = true
    void api.pullForBranch(projectId, pull.repository, head)
      .then((result) => { if (live && result.status === 'ok') setDefaultBranch(result.defaultBranch) })
      .catch(() => undefined)
    return () => { live = false }
  }, [api, projectId, pull.repository, head, mayDelete])

  if (d.lifecycle === 'open') return null
  const showDelete = mayDelete && defaultBranch !== null && defaultBranch !== head && deleted !== head
  const state = {
    draft: { title: 'This is a draft', sub: "It can't be merged until it is marked ready." },
    merged: { title: `Merged into ${d.base.ref}`, sub: undefined },
    closed: { title: 'Closed without merging', sub: undefined }
  }[d.lifecycle]
  const actions = d.lifecycle === 'draft'
    ? <button type="button" className="pr-btn" disabled={write.busy}
        onClick={() => void write.run(() => api.markPullReady(at))}>Ready for review</button>
    : d.lifecycle === 'closed'
      ? <button type="button" className="pr-btn" disabled={write.busy}
          onClick={() => void write.run(() => api.setPullState({ ...at, open: true }))}>Reopen pull request</button>
      : showDelete && <>
          <button type="button" className="pr-btn" disabled={write.busy}
            onClick={() => void write.run(async () => {
              const outcome = await api.deleteHeadBranch(at)
              if (outcome.ok) setDeleted(head)
              return outcome
            })}><Icon name="trash" size={14} />Delete branch</button>
          <span className="pr-mstate__branch">{head}</span>
        </>
  return (
    <div className="pr-mstate" data-state={d.lifecycle}>
      <div className="pr-mstate__head">
        <span className={`pr-mstate__icon pr-state--${d.lifecycle}`}><Icon name={d.lifecycle} /></span>
        <span>
          <strong>{state.title}</strong>
          {state.sub && <span className="pr-mstate__sub">{state.sub}</span>}
        </span>
      </div>
      {actions && <div className="pr-mstate__actions">{actions}</div>}
      {deleted === head && <p className="pr-mbox__note" role="status">Branch {head} was deleted.</p>}
      {write.refusal && <p className="pr-mbox__error" role="alert">{WRITE_TEXT[write.refusal]}</p>}
    </div>
  )
}
