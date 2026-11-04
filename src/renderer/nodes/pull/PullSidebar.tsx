// The pull request's people and metadata: Reviewers (with state), Assignees, Labels, Linked issues
// and Participants. One read fills it: `detail.sidebar` (core `pullDetail`). A part the read could
// not answer is left out; without any sidebar read the requested reviewers still show.
import { useState } from 'react'
import type { GitHubIssueUser } from '@shared/github-issues'
import type { GitHubPullDetail, GitHubRepoCollaboratorsResult, PullAvatarDataUrls, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import type { PullClosingIssue, PullReviewer, PullReviewerState } from '@shared/github-pull-sidebar'
import { ISSUE_OPEN_EVENT, type IssueOpenRequest } from '../../lib/openIssueNode'
import { Avatar } from './Avatar'
import { LabelChip } from './LabelChip'
import { EditRow, type EditChoices } from './PullSidebarEdit'
import { FAILURE_TEXT, REFUSAL_TEXT, WRITE_TEXT, type ViewProps } from './shared'

type SidebarProps = ViewProps & { detail: GitHubPullDetail; avatars?: PullAvatarDataUrls }

const STATE_TEXT: Record<PullReviewerState, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed', pending: 'Pending'
}

export function PullSidebar(props: SidebarProps): React.JSX.Element {
  const { sidebar } = props.detail
  const { avatars, api, projectId, pull } = props
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  return (
    <div className="pull-sidebar">
      <PullReviewers {...props} />
      {sidebar?.assignees && (
        <EditRow label="Assignees" noun="assignee" items={sidebar.assignees} nameOf={(user) => user.login}
          render={(user) => <People users={[user]} avatars={avatars} named />} empty="No one assigned." repository={pull.repository}
          load={() => api.repoCollaborators(projectId, pull.repository)
            .then((r): EditChoices => r.status === 'ok' ? { status: 'ok', names: r.users.map((user) => user.login) } : r)}
          write={(login, add) => api.setPullAssignees({ ...at, login, add })} onWritten={props.onWritten} />
      )}
      {sidebar?.labels && (
        <EditRow label="Labels" noun="label" items={sidebar.labels} nameOf={(label) => label.name}
          render={(label) => <LabelChip {...label} />} empty="None yet." repository={pull.repository}
          load={() => api.repoLabels(projectId, pull.repository)
            .then((r): EditChoices => r.status === 'ok' ? { status: 'ok', names: r.labels.map((label) => label.name) } : r)}
          write={(label, add) => api.setPullLabels({ ...at, label, add })} onWritten={props.onWritten} />
      )}
      {sidebar?.closingIssues && (
        <Row label="Linked issues">
          {sidebar.closingIssues.length
            ? sidebar.closingIssues.map((issue) => <LinkedIssue key={`${issue.repository}#${issue.number}`} issue={issue} {...props} />)
            : <Empty>None.</Empty>}
        </Row>
      )}
      {sidebar?.participants && sidebar.participants.length > 0 && (
        <Row label="Participants"><People users={sidebar.participants} avatars={avatars} /></Row>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pull-sidebar__row">
      <span className="pull-reviewers__label">{label}:</span>{' '}{children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="pull-node__empty">{children}</span>
}

function People({ users, avatars, named }: { users: GitHubIssueUser[]; avatars?: PullAvatarDataUrls; named?: true }): React.JSX.Element {
  return (
    <>
      {users.map((user) => (
        <span key={user.id} className="pull-person">
          <Avatar user={user} avatars={avatars} size={named ? 16 : 20} />
          {named && <span className="pull-node__author">{user.login}</span>}
        </span>
      ))}
    </>
  )
}

/** An issue in this repository opens in the Issues node (Canvas); one elsewhere opens on GitHub. */
function LinkedIssue({ issue, pull, onOpenExternal }: SidebarProps & { issue: PullClosingIssue }): React.JSX.Element {
  const here = issue.repository.toLowerCase() === pull.repository.toLowerCase()
  const open = () => here
    ? window.dispatchEvent(new CustomEvent<IssueOpenRequest>(ISSUE_OPEN_EVENT, { detail: { repository: pull.repository, issueNumber: issue.number } }))
    : onOpenExternal(`https://github.com/${issue.repository}/issues/${issue.number}`)
  return (
    <button className="pull-sidebar__issue" onClick={open} title={here ? 'Open in the Issues node' : 'Open on GitHub'}>
      <span className={`pull-sidebar__issue-state pull-sidebar__issue-state--${issue.state}`}>{issue.state === 'open' ? 'Open' : 'Closed'}</span>
      {' '}{here ? '' : issue.repository}#{issue.number} {issue.title}
    </button>
  )
}

/**
 * The reviewers with their latest state, "Re-request" for one who answered, and "Request review…": a pick from the repository's collaborators (read
 * on the first click), sent only on Request. A user click only; no agent verb reaches it.
 */
function PullReviewers(props: SidebarProps): React.JSX.Element {
  const { api, projectId, pull, detail: d, onWritten } = props
  const [people, setPeople] = useState<GitHubRepoCollaboratorsResult | 'loading' | null>(null)
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const reviewers: PullReviewer[] = d.sidebar?.reviewers ??
    (d.requestedReviewers ?? []).map((user): PullReviewer => ({ user, state: 'pending' }))
  // Who already reviewed may be asked again (re-request); a pending request may not be sent twice.
  const taken = new Set([d.author?.login, ...reviewers.filter((r) => r.state === 'pending').map((r) => r.user.login)])
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
  const request = async (login?: string) => {
    const reviewer = login ?? (picked || choices[0]?.login)
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
      {reviewers.length
        ? reviewers.map(({ user, state, previous }) => (
          <span key={user.id} className="pull-person" data-state={state}>
            <Avatar user={user} avatars={props.avatars} size={16} /><span className="pull-node__author">{user.login}</span>
            <span className={`pull-reviewer__state pull-reviewer__state--${state}`}>
              {STATE_TEXT[state]}{previous ? ` (was ${STATE_TEXT[previous].toLowerCase()})` : ''}
            </span>
            {open && state !== 'pending' && user.login !== d.author?.login && (
              <button className="pull-compose__button" disabled={busy} aria-label={`Re-request review from ${user.login}`}
                onClick={() => void request(user.login)}>Re-request</button>
            )}
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
