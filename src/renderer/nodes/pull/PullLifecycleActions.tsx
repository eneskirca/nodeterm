import { useEffect, useState } from 'react'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'

/**
 * The merge box's lifecycle buttons: Ready for review (a draft), Close or Reopen, and Delete branch after
 * a merge. Delete branch shows only for a head in this repository that is not its default branch (read
 * once through "New pull request"'s read); the core checks all three again before it deletes.
 * One write at a time: every button is off while one runs, and the node reads again after it lands.
 */
export function PullLifecycleActions(props: ViewProps & { detail: GitHubPullDetail }): React.JSX.Element {
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

  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const showDelete = mayDelete && defaultBranch !== null && defaultBranch !== head && deleted !== head
  return (
    <>
      <div className="pull-merge__row">
        {d.lifecycle === 'draft' && (
          <button className="pull-compose__button" disabled={write.busy}
            onClick={() => void write.run(() => api.markPullReady(at))}>Ready for review</button>
        )}
        {open && (
          <button className="pull-compose__button" disabled={write.busy}
            onClick={() => void write.run(() => api.setPullState({ ...at, open: false }))}>Close pull request</button>
        )}
        {d.lifecycle === 'closed' && (
          <button className="pull-compose__button" disabled={write.busy}
            onClick={() => void write.run(() => api.setPullState({ ...at, open: true }))}>Reopen pull request</button>
        )}
        {showDelete && (
          <button className="pull-compose__button" disabled={write.busy}
            onClick={() => void write.run(async () => {
              const outcome = await api.deleteHeadBranch(at)
              if (outcome.ok) setDeleted(head)
              return outcome
            })}>Delete branch {head}</button>
        )}
      </div>
      {deleted === head && <p className="pull-node__state" role="status">Branch {head} was deleted.</p>}
      {write.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[write.refusal]}</p>}
    </>
  )
}
