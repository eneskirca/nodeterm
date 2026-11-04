// The pull request's people and metadata. Today it holds the requested reviewers; Assignees,
// Labels, Linked issues and Participants join it here (ticket 06).
import { useState } from 'react'
import type { GitHubPullDetail, GitHubRepoCollaboratorsResult, PullAvatarDataUrls, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import { Avatar } from './Avatar'
import { FAILURE_TEXT, REFUSAL_TEXT, WRITE_TEXT, type ViewProps } from './shared'

export function PullSidebar(props: ViewProps & { detail: GitHubPullDetail; avatars?: PullAvatarDataUrls }): React.JSX.Element {
  return <PullReviewers {...props} />
}

/**
 * The requested reviewers, and "Request review…": a pick from the repository's collaborators (read
 * on the first click), sent only on Request. A user click only; no agent verb reaches it.
 */
function PullReviewers(props: ViewProps & { detail: GitHubPullDetail; avatars?: PullAvatarDataUrls }): React.JSX.Element {
  const { api, projectId, pull, detail: d, onWritten } = props
  const [people, setPeople] = useState<GitHubRepoCollaboratorsResult | 'loading' | null>(null)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const requested = d.requestedReviewers ?? []
  const taken = new Set([d.author?.login, ...requested.map((user) => user.login)])
  const choices = people !== null && people !== 'loading' && people.status === 'ok'
    ? people.users.filter((user) => !taken.has(user.login))
    : []
  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'

  const show = () => {
    setRefusal(null)
    setPeople('loading')
    void api.repoCollaborators(projectId, pull.repository)
      .catch((): GitHubRepoCollaboratorsResult => ({ status: 'failed', reason: 'unreachable' }))
      .then(setPeople)
  }
  const request = async () => {
    const reviewer = picked || choices[0]?.login
    if (busy || !reviewer) return
    setBusy(true)
    const outcome = await api.requestPullReviewer({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, reviewer })
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) { setRefusal(outcome.reason); return }
    setPeople(null)
    setPicked('')
    onWritten()
  }

  return (
    <div className="pull-reviewers">
      <span className="pull-reviewers__label">Reviewers:</span>{' '}
      {requested.length
        ? requested.map((user) => (
          <span key={user.id} className="pull-person">
            <Avatar user={user} avatars={props.avatars} size={16} /><span className="pull-node__author">{user.login}</span>
          </span>
        ))
        : <span className="pull-node__empty">No reviewers requested.</span>}
      {open && (people === null || (people !== 'loading' && people.status !== 'ok')) && (
        <button className="pull-compose__button" onClick={show}>Request review…</button>
      )}
      {people === 'loading' && <span className="pull-node__state">Loading collaborators…</span>}
      {people !== null && people !== 'loading' && (
        people.status === 'refused'
          ? <p className="pull-node__state" role="status">{REFUSAL_TEXT[people.reason](pull.repository)}</p>
          : people.status === 'failed'
            ? <p className="pull-node__state" role="status">{FAILURE_TEXT[people.reason]}</p>
            : choices.length === 0
              ? <span className="pull-node__empty">Everyone with access is already asked.</span>
              : (
                <span className="pull-reviewers__pick">
                  <select aria-label="Reviewer" value={picked || choices[0].login} onChange={(event) => setPicked(event.target.value)}>
                    {choices.map((user) => <option key={user.id} value={user.login}>{user.login}</option>)}
                  </select>
                  <button className="pull-compose__button" disabled={busy} onClick={() => void request()}>Request</button>
                  <button className="pull-compose__button" disabled={busy} onClick={() => setPeople(null)}>Cancel</button>
                </span>
              )
      )}
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
    </div>
  )
}
