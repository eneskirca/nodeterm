// The Conversation tab's right column (F1): Agent, Reviewers (with state), Assignees, Labels,
// Development (linked issues) and Participants. One read fills it: `detail.sidebar` (core
// `pullDetail`). A part the read could not answer is left out; without any sidebar read the
// requested reviewers still show. Reviewers, Assignees and Labels edit through an F4 picker.
import type { GitHubIssueUser } from '@shared/github-issues'
import type { GitHubPullDetail, PullAvatarDataUrls } from '@shared/github-pull-detail'
import type { PullClosingIssue, PullReviewer, PullReviewerState } from '@shared/github-pull-sidebar'
import type { AgentState } from '@shared/agents/normalize'
import { ISSUE_OPEN_EVENT, type IssueOpenRequest } from '../../lib/openIssueNode'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { LabelChip } from './LabelChip'
import { PullSendToAgent } from './PullSendToAgent'
import { EditPicker, type EditChoices } from './PullSidebarEdit'
import { useWrite, WRITE_TEXT, type ViewProps } from './shared'

type SidebarProps = ViewProps & {
  detail: GitHubPullDetail; avatars?: PullAvatarDataUrls
  /** For Send review's failing checks. */
  checks?: PullChecksRead
  /** The first linked agent's live state. */
  agentState?: AgentState
}

const STATE_TEXT: Record<PullReviewerState, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed', pending: 'Pending'
}

const AGENT_TEXT: Record<AgentState, string> = { working: 'working', waiting: 'waiting', blocked: 'blocked', done: 'idle' }

export function PullSidebar(props: SidebarProps): React.JSX.Element {
  const { sidebar } = props.detail
  const { avatars, api, projectId, pull, onWritten } = props
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const people = () => api.repoCollaborators(projectId, pull.repository)
    .then((r): EditChoices => r.status === 'ok' ? { status: 'ok', items: r.users.map((user) => ({ name: user.login, user })) } : r)
  return (
    <aside className="pr-sidebar" data-pull-section="details" aria-label="Details">
      <AgentSection {...props} />
      <PullReviewers {...props} people={people} />
      {sidebar?.assignees && (
        <Section label="Assignees" edit={
          <EditPicker label="Assignees" repository={pull.repository} load={people} onWritten={onWritten}
            state={(login) => ({ checked: sidebar.assignees!.some((user) => user.login === login) })}
            write={(login, add) => api.setPullAssignees({ ...at, login, add })} />
        }>
          {sidebar.assignees.length
            ? sidebar.assignees.map((user) => <Person key={user.id} user={user} avatars={avatars} />)
            : <Empty>No one assigned.</Empty>}
        </Section>
      )}
      {sidebar?.labels && (
        <Section label="Labels" edit={
          <EditPicker label="Labels" repository={pull.repository} onWritten={onWritten}
            load={() => api.repoLabels(projectId, pull.repository)
              .then((r): EditChoices => r.status === 'ok' ? { status: 'ok', items: r.labels.map(({ name, color }) => ({ name, color })) } : r)}
            state={(name) => ({ checked: sidebar.labels!.some((label) => label.name === name) })}
            write={(label, add) => api.setPullLabels({ ...at, label, add })} />
        }>
          {sidebar.labels.length
            ? <div className="pr-side__labels">{sidebar.labels.map((label) => <LabelChip key={label.name} {...label} />)}</div>
            : <Empty>None yet.</Empty>}
        </Section>
      )}
      {sidebar?.closingIssues && (
        <Section label="Development">
          {sidebar.closingIssues.length
            ? sidebar.closingIssues.map((issue) => <LinkedIssue key={`${issue.repository}#${issue.number}`} issue={issue} {...props} />)
            : <Empty>No linked issues.</Empty>}
        </Section>
      )}
      {sidebar?.participants && sidebar.participants.length > 0 && (
        <Section label="Participants">
          <div className="pr-side__avatars">
            {sidebar.participants.map((user) => <Avatar key={user.id} user={user} avatars={avatars} size={24} />)}
          </div>
        </Section>
      )}
    </aside>
  )
}

function Section({ label, edit, className, section, children }: {
  label: string; edit?: React.ReactNode; className?: string; section?: 'agent'; children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={className ? `pr-side ${className}` : 'pr-side'} aria-label={label} data-pull-section={section}>
      <h3 className="pr-side__title">{label}{edit}</h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="pull-node__empty">{children}</span>
}

function Person({ user, avatars, children }: { user: GitHubIssueUser; avatars?: PullAvatarDataUrls; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pr-side__person">
      <Avatar user={user} avatars={avatars} size={20} />
      <span className="pull-node__author">{user.login}</span>
      {children}
    </div>
  )
}

/** The linked agent and its status, the Watch switch (F-08 wires it), Work on this PR and Send review. */
function AgentSection(props: SidebarProps): React.JSX.Element {
  const { agents, agentState, detail: d, onWork, onSendToAgent, checks } = props
  const agent = agents?.[0]
  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'
  return (
    <Section label="Agent" section="agent">
      {agent
        ? (
          <div className="pr-side__agent">
            <span className="pr-side__dot" />
            <span className="pr-side__name">{agent.title}</span>
            <span className="pr-side__status">{AGENT_TEXT[agentState ?? 'done']}</span>
          </div>
        )
        : <Empty>No agent linked.</Empty>}
      {/* ponytail: a placeholder until Watch (F-08) wires it. */}
      <div className="pr-switch">
        <button className="pr-switch__track" role="switch" aria-checked={false} aria-label="Watch checks and conflicts" disabled
          title="Watch is not available yet."><span className="pr-switch__knob" /></button>
        <span>Watch checks and conflicts</span>
      </div>
      {open && (onWork || onSendToAgent) && (
        <div className="pr-side__actions">
          {onWork && <button className="pr-btn pr-btn--sm" onClick={() => onWork(d)}>Work on this PR</button>}
          {onSendToAgent && <PullSendToAgent {...props} detail={d} checks={checks ?? null} />}
        </div>
      )}
    </Section>
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
      <Icon name={issue.state === 'open' ? 'issue' : 'check'} size={14}
        className={`pull-sidebar__issue-state pull-sidebar__issue-state--${issue.state}`} label={issue.state === 'open' ? 'Open' : 'Closed'} />
      <span>{here ? '' : issue.repository}#{issue.number} {issue.title}</span>
    </button>
  )
}

/** The reviewer's state as an icon; the words stay for screen readers and the tooltip. */
function ReviewState({ state, previous }: Pick<PullReviewer, 'state' | 'previous'>): React.JSX.Element {
  const text = `${STATE_TEXT[state]}${previous ? ` (was ${STATE_TEXT[previous].toLowerCase()})` : ''}`
  return (
    <span className={`pr-side__state pr-side__state--${state}`} title={text}>
      {state === 'approved' && <Icon name="check" size={14} />}
      {(state === 'changes-requested' || state === 'dismissed') && <Icon name="x" size={14} />}
      {state === 'commented' && <Icon name="thread" size={14} />}
      {state === 'pending' && <span className="pr-side__pending" />}
      <span className="sr-only">{text}</span>
    </span>
  )
}

/**
 * The reviewers with their latest state and a re-request button for one who answered; Edit picks
 * from the repository's collaborators (read on the first click). A user click only; no agent verb
 * reaches it.
 */
function PullReviewers(props: SidebarProps & { people: () => Promise<EditChoices> }): React.JSX.Element {
  const { api, projectId, pull, detail: d, onWritten, people } = props
  const write = useWrite(onWritten)
  const reviewers: PullReviewer[] = d.sidebar?.reviewers ??
    (d.requestedReviewers ?? []).map((user): PullReviewer => ({ user, state: 'pending' }))
  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const request = (reviewer: string) => api.requestPullReviewer({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, reviewer })
  return (
    <Section label="Reviewers" className="pull-reviewers" edit={open && (
      <EditPicker label="Reviewers" repository={pull.repository} onWritten={onWritten}
        load={() => people().then((r) => r.status === 'ok' ? { ...r, items: r.items.filter((item) => item.name !== d.author?.login) } : r)}
        state={(login) => {
          const r = reviewers.find((x) => x.user.login === login)
          // Who already reviewed may be asked again (re-request); a pending request may not be sent twice.
          if (!r) return { checked: false }
          return r.state === 'pending' ? { checked: true, disabled: true, note: 'requested' } : { checked: true, note: STATE_TEXT[r.state].toLowerCase() }
        }}
        write={(login) => request(login)} />
    )}>
      {reviewers.length
        ? reviewers.map(({ user, state, previous }) => (
          <Person key={user.id} user={user} avatars={props.avatars}>
            <ReviewState state={state} previous={previous} />
            {open && state !== 'pending' && user.login !== d.author?.login && (
              <button className="pr-btn pr-btn--ghost pr-btn--small" disabled={write.busy} aria-label={`Re-request review from ${user.login}`}
                title={`Re-request review from ${user.login}`} onClick={() => void write.run(() => request(user.login))}>
                <Icon name="refresh" size={14} />
              </button>
            )}
          </Person>
        ))
        : <Empty>No reviewers requested.</Empty>}
      {write.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[write.refusal]}</p>}
    </Section>
  )
}
