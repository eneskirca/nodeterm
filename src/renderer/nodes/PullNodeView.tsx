import { useCallback, useEffect, useId, useState } from 'react'
import type { GitHubIssuesApi } from '@shared/github-issues'
import type {
  GitHubPullConversationResult,
  GitHubPullDetail,
  GitHubPullDetailResult,
  GitHubPullFileContentsResult,
  GitHubPullFilesResult,
  GitHubRepoCollaboratorsResult,
  GitHubRepoMergeMethodsResult,
  PullFile,
  PullFileSide,
  PullDiffSide,
  PullLineComment,
  PullLineDraft,
  PullFileStatus,
  PullFileUnavailable,
  PullMergeMethod,
  PullReadFailure,
  PullRefusal,
  PullReviewEvent,
  PullReviewVerdict,
  PullWriteReason,
  PullWriteResult
} from '@shared/github-pull-detail'
import type { PullLifecycle } from '@shared/github-pull-status'
import { pullWebUrl, type PullNodeRef, type PullNodeTab } from '@shared/pull-node'
import type { PullHighlight, PullProposal, ShownProposal } from '@shared/pull-agent-verbs'
import { NoteMarkdown } from '../components/NoteMarkdown'
import { PullChecks, usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { mergeLabel } from '../components/kanban/PullStatusBadges'
import { TextDiff, type DiffZone } from '../editor/TextDiff'
import { pullLineThreads, type PullLineThread } from '../lib/pullLineThreads'
import { mergeBlock, type PullChecksRead } from '../lib/pullMergeBlock'
import { pullFeedbackItems, pullFeedbackMessage } from '../lib/pullFeedback'

export type PullNodeApi = Pick<
  GitHubIssuesApi,
  'pullDetail' | 'pullChecks' | 'pullConversation' | 'pullFiles' | 'pullFileContents' | 'commentOnPull' | 'reviewPull' | 'mergePull' | 'repoMergeMethods' |
  'repoCollaborators' | 'requestPullReviewer' | 'commentOnPullLine' | 'updatePullBranch' | 'enablePullAutoMerge' |
  'disablePullAutoMerge'
>

/** Each refusal names what is wrong and the one step that fixes it. No request was made. */
const REFUSAL_TEXT: Record<PullRefusal, (repository: string) => string> = {
  'not-approved': () =>
    'This repository is not approved on this machine. Open the board, then approve the repository in its GitHub settings.',
  'signed-out': () => 'You are not signed in to GitHub. Open the board, then sign in from its GitHub settings.',
  'repository-mismatch': (repository) =>
    `This node points at ${repository}, which is not this project's repository. Open the pull request again from this project's board.`,
  'not-configured': () =>
    "This project has no GitHub repository connected. Connect one in the board's GitHub settings."
}

const FAILURE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'GitHub is throttling requests. Refresh again in a minute.',
  unreachable: 'GitHub could not be reached. Check the connection, then refresh.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.'
}

const STALE_TEXT: Record<PullReadFailure, string> = {
  throttled: 'Throttled by GitHub: showing the last loaded version.',
  unreachable: 'GitHub could not be reached: showing the last loaded version.',
  'signed-out': 'GitHub refused the token: showing the last loaded version.'
}

/** One sentence per write refusal. */
const WRITE_TEXT: Record<PullWriteReason, string> = {
  'head-moved': 'The pull request changed since you loaded it, so nothing was merged. It has been reloaded: check the new commits, then merge again.',
  'not-mergeable': 'GitHub says this pull request cannot be merged right now. Check its merge state on GitHub, then try again.',
  'own-pull': 'GitHub does not let you approve or request changes on your own pull request. Leave a comment instead.',
  forbidden: 'Your GitHub token may not write to this repository. Give it Pull requests write access, then try again.',
  throttled: 'GitHub is throttling requests. Try again in a minute.',
  'signed-out': 'GitHub refused the token. Sign in again from the board\'s GitHub settings.',
  'not-approved': 'This repository is not approved on this machine. Approve it in the board\'s GitHub settings.',
  validation: 'GitHub refused the request. Refresh the pull request, then try again.',
  network: 'GitHub could not be reached. Check the connection, then try again.'
}

const AUTO_MOVED_TEXT = 'GitHub did not turn on auto-merge: the pull request changed since you loaded it, or it can merge now. It has been reloaded: check it, then try again.'

const UPDATE_MOVED_TEXT = 'The pull request changed since you loaded it, so the branch was not updated. It has been reloaded: check it, then update again.'

const METHOD_TEXT: Record<PullMergeMethod, string> = {
  merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge'
}

/** A branch name the conflict terminal can type unquoted. ponytail: any other name gets no button. */
const PLAIN_BRANCH = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/

const LIFECYCLE_TEXT: Record<PullLifecycle, string> = {
  open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed'
}

const VERDICT_TEXT: Record<PullReviewVerdict, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', commented: 'Commented', dismissed: 'Dismissed'
}

const TABS: ReadonlyArray<[PullNodeTab, string]> = [['overview', 'Overview'], ['files', 'Files'], ['conversation', 'Conversation']]

const FILE_STATUS_TEXT: Record<PullFileStatus, string> = {
  added: 'Added', modified: 'Modified', removed: 'Removed', renamed: 'Renamed'
}

const UNAVAILABLE_TEXT: Record<PullFileUnavailable, string> = {
  binary: 'Cannot show this file: it is a binary file.',
  'too-large': 'Cannot show this file: it is larger than 1 MB.',
  'not-in-pull': 'Cannot show this file: the pull request no longer changes it. Refresh the file list.'
}

type ViewProps = {
  api: PullNodeApi
  projectId: string
  pull: PullNodeRef
  refreshTick: number
  onOpenExternal: (url: string) => void
  /** A write landed: the node reads again (the core dropped its held reads for this PR). */
  onWritten: () => void
  /** Open a terminal node in the project that runs `command` (the conflict's "Open terminal on this branch"). */
  onOpenTerminal?: (command: string) => void
  /** "Work on this PR": the PR's head in a fresh worktree with the default agent (Canvas does it). */
  onWork?: (detail: GitHubPullDetail) => void
  /** The agent nodes joined to this node: who "Send to agent" may send to. */
  agents?: readonly { id: string; title: string }[]
  /** Why "Send to agent" is off on this surface (a relay tab). */
  sendUnavailable?: string
  /** Sends the message to that agent; answers null when sent, else the sentence to show. */
  onSendToAgent?: (agentId: string, message: string) => Promise<string | null>
}

/** A bridge call that rejected (a dropped socket) reads as unreachable. */
type Read<R> = R | { status: 'failed'; reason: 'unreachable' } | 'loading'

/** Reads when the tab first mounts and whenever `refreshTick` moves; the core answers from memory
 *  inside its 30 s floor, so a fast Refresh costs no request. */
function usePullRead<R>(
  read: (projectId: string, repository: string, pullNumber: number) => Promise<R>,
  { projectId, pull, refreshTick }: ViewProps
): Read<R> {
  const [result, setResult] = useState<Read<R>>('loading')
  const { repository, pullNumber } = pull
  useEffect(() => {
    let live = true
    read(projectId, repository, pullNumber)
      .then((value) => { if (live) setResult(value) })
      .catch(() => { if (live) setResult({ status: 'failed', reason: 'unreachable' }) })
    return () => { live = false }
  }, [read, projectId, repository, pullNumber, refreshTick])
  return result
}

/** The loading, refused and failed states every tab shows the same way. */
function readState(
  result: Read<Exclude<
    GitHubPullDetailResult | GitHubPullConversationResult | GitHubPullFilesResult | GitHubPullFileContentsResult,
    { status: 'ok' }
  >>,
  repository: string
): React.JSX.Element {
  if (result === 'loading') return <p className="pull-node__state">Loading pull request…</p>
  if (result.status === 'refused') {
    return <p className="pull-node__state" role="status">{REFUSAL_TEXT[result.reason](repository)}</p>
  }
  return <p className="pull-node__state" role="status">{FAILURE_TEXT[result.reason]}</p>
}

type TabsProps = ViewProps & {
  onTab: (tab: PullNodeTab) => void
  /** The Files tab picked a file; the frame persists it as `selectedFile`. */
  onSelectFile: (path: string) => void
  /** The linked agent's pending action (`pr-propose`). Only Confirm here sends it. */
  proposal?: ShownProposal
  onDismiss?: () => void
  /** Lines the linked agent pointed at (`pr-show --lines`), in one file of the Files tab. */
  highlight?: PullHighlight
}

/**
 * The pull request node's body (nodes/PullNode.tsx is the canvas frame around it). Takes the bridge
 * as a prop so a test can hand it a fake.
 */
export function PullNodeView({
  pull,
  projectId,
  ...rest
}: Omit<TabsProps, 'pull' | 'projectId'> & {
  projectId: string | null
  pull: PullNodeRef | undefined
}): React.JSX.Element {
  if (!pull || !projectId) {
    return <p className="pull-node__state" role="status">This node has no valid pull request reference.</p>
  }
  return <PullTabs {...rest} pull={pull} projectId={projectId} />
}

/** A tab mounts the first time it is shown and then stays mounted (hidden when not shown), so a
 *  switch back costs no read and a draft typed in a tab survives the switch. */
function PullTabs({ onTab, onSelectFile, proposal, onDismiss, highlight, ...props }: TabsProps): React.JSX.Element {
  const { pull, onOpenExternal } = props
  const shownTab = pull.tab
  const [opened, setOpened] = useState<readonly PullNodeTab[]>([shownTab])
  if (!opened.includes(shownTab)) setOpened([...opened, shownTab])
  // The pull request the Overview last showed: its head is the one a review is tied to.
  const [seen, setSeen] = useState<GitHubPullDetail | undefined>()
  const seenHead = seen?.head.sha
  // The Overview's checks read: the merge sentence uses it, so the proposal bar says what the node says.
  const [seenChecks, setSeenChecks] = useState<PullChecksRead>(null)
  const [ownPull, setOwnPull] = useState(false)
  // New line comments waiting for the next review submit. ponytail: kept in memory only; closing
  // the node drops them (nothing was sent).
  const [pending, setPending] = useState<readonly PullLineDraft[]>([])
  const addPending = useCallback((draft: PullLineDraft) => setPending((list) => [...list, draft]), [])
  // Drops only the drafts named: one added while a review was on its way stays for the next.
  const dropPending = useCallback((sent: readonly PullLineDraft[]) =>
    setPending((list) => list.filter((draft) => !sent.includes(draft))), [])
  return (
    <>
      {proposal && (
        <PullProposalBar key={proposal.seq} {...props} proposal={proposal} seen={seen} seenChecks={seenChecks} ownPull={ownPull}
          onDismiss={() => onDismiss?.()} />
      )}
      <div className="pull-node__tabs" role="tablist">
        {TABS.map(([tab, label]) => (
          <button key={tab} role="tab" aria-selected={tab === shownTab} className="pull-node__tab"
            onClick={() => onTab(tab)}>{label}</button>
        ))}
        <span className="term-node__spacer" />
        <button className="pull-node__web" onClick={() => onOpenExternal(pullWebUrl(pull.repository, pull.pullNumber))}>
          Open on GitHub
        </button>
      </div>
      {opened.includes('overview') && (
        <div hidden={shownTab !== 'overview'}><PullOverview {...props} onDetail={setSeen} onOwnPull={setOwnPull} onChecks={setSeenChecks} /></div>
      )}
      {opened.includes('files') && (
        <div hidden={shownTab !== 'files'}>
          <PullFiles {...props} onSelectFile={onSelectFile} highlight={highlight} pending={pending} onAddPending={addPending} />
        </div>
      )}
      {opened.includes('conversation') && (
        <div hidden={shownTab !== 'conversation'}>
          <PullConversation {...props} seenHead={seenHead} ownPull={ownPull} pending={pending} onDropPending={dropPending} />
        </div>
      )}
    </>
  )
}

function PullOverview(props: ViewProps & {
  onDetail: (detail: GitHubPullDetail) => void; onOwnPull: (own: boolean) => void
  onChecks: (checks: PullChecksRead) => void
}): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal, onDetail, onOwnPull, onChecks } = props
  const result = usePullRead(api.pullDetail, props)
  const detail = result !== 'loading' && result.status === 'ok' ? result.detail : undefined
  useEffect(() => { if (detail) onDetail(detail) }, [detail, onDetail])
  const ownPull = result !== 'loading' && result.status === 'ok' && result.ownPull === true
  useEffect(() => { onOwnPull(ownPull) }, [ownPull, onOwnPull])
  const readsChecks = detail && (detail.lifecycle === 'open' || detail.lifecycle === 'draft')
  const checks = usePullChecks(api, readsChecks ? projectId : undefined, pull.pullNumber, detail?.head.sha, props.refreshTick)
  useEffect(() => { onChecks(checks) }, [checks, onChecks])

  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const { detail: d } = result
  const merge = d.lifecycle === 'open' || d.lifecycle === 'draft' ? mergeLabel(d.merge) : null
  return (
    <div className="pull-node__overview">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      <h3 className="pull-node__title">
        {d.title} <span className="pull-node__number">#{d.number}</span>
      </h3>
      <div className="pull-node__meta">
        <span className={`pull-node__lifecycle pull-node__lifecycle--${d.lifecycle}`}>{LIFECYCLE_TEXT[d.lifecycle]}</span>
        {d.author && <span className="pull-node__author">{d.author.login}</span>}
        <span className="pull-node__branches">
          <code>{d.base.ref}</code> ← <code>{d.head.ref}</code>
        </span>
        <span className="pull-node__size">
          +{d.additions} −{d.deletions} · {d.changedFiles} {d.changedFiles === 1 ? 'file' : 'files'}
        </span>
        {merge && <span className={`pull-status__merge pull-status__merge--${d.merge}`}>{merge}</span>}
      </div>
      {props.onWork && (d.lifecycle === 'open' || d.lifecycle === 'draft') && (
        <button className="pull-compose__button" onClick={() => props.onWork?.(d)}>Work on this PR</button>
      )}
      {props.onSendToAgent && (d.lifecycle === 'open' || d.lifecycle === 'draft') && <PullSendToAgent {...props} detail={d} checks={checks} />}
      <PullReviewers {...props} detail={d} />
      <PullMerge {...props} detail={d} checks={checks} />
      {d.body.trim()
        ? <NoteMarkdown text={d.body} className="sticky-node__md pull-node__md" />
        : <p className="pull-node__empty">No description provided.</p>}
      <PullChecks result={checks} expectedHead={d.head.sha} onOpen={onOpenExternal} />
    </div>
  )
}

type LineProps = {
  pending: readonly PullLineDraft[]
  onAddPending: (draft: PullLineDraft) => void
}

/** The Files tab: the changed files, then the selected one as a side-by-side diff with its line
 *  comments. The detail read gives the head a new line comment is tied to; the conversation read
 *  gives the comments. Both answer from the core's memory inside its floor. */
function PullFiles(props: ViewProps & LineProps & { onSelectFile: (path: string) => void; highlight?: PullHighlight }): React.JSX.Element {
  const { api, pull, onOpenExternal, onSelectFile, highlight } = props
  const result = usePullRead(api.pullFiles, props)
  const detail = usePullRead(api.pullDetail, props)
  const conversation = usePullRead(api.pullConversation, props)
  const head = detail !== 'loading' && detail.status === 'ok' ? detail.detail.head.sha : undefined
  const lineComments = conversation !== 'loading' && conversation.status === 'ok' ? conversation.lineComments : []
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const filesUrl = `${pullWebUrl(pull.repository, pull.pullNumber)}/files`
  const selected = result.files.find((file) => file.path === pull.selectedFile)
  return (
    <div className="pull-files">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.files.length === 0
        ? <p className="pull-node__empty">No changed files.</p>
        : (
          <ul className="pull-files__list">
            {result.files.map((file) => (
              <li key={file.path}>
                <button className="pull-files__file" aria-current={file === selected ? 'true' : undefined}
                  onClick={() => onSelectFile(file.path)}>
                  <span className={`pull-files__status pull-files__status--${file.status}`}>{FILE_STATUS_TEXT[file.status]}</span>
                  <span className="pull-files__path">
                    {file.previousPath && <>{file.previousPath} → </>}{file.path}
                  </span>
                  <span className="pull-files__add">+{file.additions}</span>
                  <span className="pull-files__del">−{file.deletions}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {result.truncated && (
        <p className="pull-files__truncated">
          Showing the first 300 files only.{' '}
          <button className="pull-node__web" onClick={() => onOpenExternal(filesUrl)}>Open on GitHub</button> for the rest.
        </p>
      )}
      {selected
        ? <PullFileDiff key={selected.path} {...props} file={selected} filesUrl={filesUrl}
            highlight={highlight?.file === selected.path ? highlight : undefined} head={head} lineComments={lineComments} />
        : result.files.length > 0 && <p className="pull-node__empty">Select a file to see its diff.</p>}
    </div>
  )
}

const sideText = (side: PullFileSide): string => side.kind === 'text' ? side.text : ''

const SIDE_OF = { LEFT: 'original', RIGHT: 'modified' } as const

function PullFileDiff(props: ViewProps & LineProps & {
  file: PullFile; filesUrl: string; highlight?: PullHighlight; head: string | undefined; lineComments: readonly PullLineComment[]
}): React.JSX.Element {
  const { api, pull, file, filesUrl, onOpenExternal, highlight, head, lineComments, pending, onAddPending } = props
  const path = file.path
  // The line the user clicked, where the new-comment box opens.
  const [composing, setComposing] = useState<{ side: PullDiffSide; line: number } | null>(null)
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) => api.pullFileContents(projectId, repository, pullNumber, path),
    [api, path]
  )
  const result = usePullRead(read, props)
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const { contents } = result
  const threads = pullLineThreads(lineComments, path)
  const zones: DiffZone[] = [
    ...threads.flatMap((thread) => thread.line === null ? [] : [{
      key: `thread-${thread.id}`, side: SIDE_OF[thread.side], line: thread.line,
      content: <PullLineThreadView {...props} thread={thread} />
    }]),
    ...pending.flatMap((draft, index) => draft.path !== path ? [] : [{
      key: `pending-${index}`, side: SIDE_OF[draft.side], line: draft.line,
      content: <p className="pull-line__pending"><strong>Pending</strong> (sent with your review): {draft.body}</p>
    }]),
    ...(composing ? [{
      key: `new-${composing.side}-${composing.line}`, side: SIDE_OF[composing.side], line: composing.line,
      content: <PullLineComposer {...props} head={head} draft={{ path, ...composing }}
        onAdd={(draft) => { onAddPending(draft); setComposing(null) }} onClose={() => setComposing(null)} />
    }] : [])
  ]
  const offLine = threads.filter((thread) => thread.line === null)
  if (contents.kind === 'unavailable') {
    return (
      <p className="pull-files__unavailable" role="status">
        {UNAVAILABLE_TEXT[contents.reason]}{' '}
        <button className="pull-node__web" onClick={() => onOpenExternal(filesUrl)}>Open on GitHub</button>
      </p>
    )
  }
  return (
    <>
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      <p className="pull-node__empty">
        Click a line number to comment on that line. GitHub takes comments only on changed lines and the lines next to them.
      </p>
      <TextDiff className="pull-files__diff" path={path} original={sideText(contents.base)} modified={sideText(contents.head)}
        highlight={highlight} zones={zones}
        onLineClick={(side, line) => setComposing({ side: side === 'original' ? 'LEFT' : 'RIGHT', line })} />
      {offLine.length > 0 && (
        <div className="pull-line__off">
          <p className="pull-node__empty">Not on a current line of this diff:</p>
          {offLine.map((thread) => <PullLineThreadView key={thread.id} {...props} thread={thread} />)}
        </div>
      )}
    </>
  )
}

/** A write's busy flag and refusal sentence; `run` sends it and calls `done` when it landed. */
function useWrite(done: () => void): {
  busy: boolean; refusal: PullWriteReason | null; run: (write: () => Promise<PullWriteResult>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const run = async (write: () => Promise<PullWriteResult>) => {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    const outcome = await write().catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (outcome.ok) done()
    else setRefusal(outcome.reason)
  }
  return { busy, refusal, run }
}

/** One thread under its line (or below the diff when it is not on a current line), with a reply box. */
function PullLineThreadView(props: ViewProps & { thread: PullLineThread }): React.JSX.Element {
  const { api, projectId, pull, thread, onWritten } = props
  const [reply, setReply] = useState('')
  const { busy, refusal, run } = useWrite(() => { setReply(''); onWritten() })
  return (
    <div className="pull-line">
      {thread.outdated && <span className="pull-line__outdated">Outdated</span>}
      {thread.comments.map((comment) => (
        <div key={comment.id} className="pull-line__comment">
          <div className="pull-convo__head">
            <span className="pull-node__author">{comment.author?.login ?? 'ghost'}</span>
            <time className="pull-convo__time" dateTime={comment.at}>{new Date(comment.at).toLocaleString()}</time>
          </div>
          <NoteMarkdown text={comment.body} className="sticky-node__md pull-node__md" />
        </div>
      ))}
      <textarea className="pull-compose__box pull-line__box" aria-label="Reply" placeholder="Reply"
        value={reply} onChange={(event) => setReply(event.target.value)} />
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pull-compose__actions">
        <button className="pull-compose__button" disabled={busy || !reply.trim()} onClick={() => void run(() =>
          api.commentOnPullLine({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, inReplyTo: thread.id, body: reply }))}>
          Reply
        </button>
      </div>
    </div>
  )
}

/** The new-comment box under a clicked line: send it now, or keep it for the next review. */
function PullLineComposer(props: ViewProps & {
  head: string | undefined; draft: Omit<PullLineDraft, 'body'>; onAdd: (draft: PullLineDraft) => void; onClose: () => void
}): React.JSX.Element {
  const { api, projectId, pull, head, draft, onAdd, onClose, onWritten } = props
  const [body, setBody] = useState('')
  const { busy, refusal, run } = useWrite(() => { onClose(); onWritten() })
  const comment = { ...draft, body }
  return (
    <div className="pull-line pull-line--new">
      <textarea className="pull-compose__box pull-line__box" aria-label="Line comment" autoFocus
        placeholder={`Comment on line ${draft.line}`} value={body} onChange={(event) => setBody(event.target.value)} />
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pull-compose__actions">
        <button className="pull-compose__button" disabled={busy || !body.trim() || !head} onClick={() => void run(() =>
          api.commentOnPullLine({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: head!, comment }))}>
          Comment
        </button>
        <button className="pull-compose__button" disabled={busy || !body.trim()} onClick={() => onAdd(comment)}>Add to review</button>
        <button className="pull-compose__button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

const PROPOSAL_TEXT: Record<PullProposal['action'], string> = {
  approve: 'Approve', 'request-changes': 'Request changes on', comment: 'Comment on', merge: 'Merge'
}

/** Confirm stays off this long after a proposal is shown or replaced, so an agent cannot swap the
 *  action under a click already on its way (security review of #19). */
const PROPOSAL_ARM_MS = 1_000

const OWN_PULL_TEXT = 'This is your own pull request, so you can comment but not approve or request changes.'

/**
 * The linked agent's proposed action (`pr-propose`), shown above the tabs. It names exactly what will
 * be sent; nothing is sent until Confirm, which runs the same write, behind the same guards, as the
 * node's own buttons. A review and a merge are tied to the head the Overview showed, as there.
 */
function PullProposalBar(props: ViewProps & {
  proposal: PullProposal; seen: GitHubPullDetail | undefined; seenChecks: PullChecksRead
  ownPull: boolean; onDismiss: () => void
}): React.JSX.Element {
  const { api, projectId, pull, proposal, seen, seenChecks, ownPull, onDismiss, onWritten } = props
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const [methods, setMethods] = useState<GitHubRepoMergeMethodsResult | 'loading'>('loading')
  const isMerge = proposal.action === 'merge'
  // The bar remounts per proposal (keyed by its seq), so this runs once per shown proposal.
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), PROPOSAL_ARM_MS)
    return () => clearTimeout(timer)
  }, [])
  // One read of the allowed methods serves both a proposal that names one and one that does not.
  useEffect(() => {
    if (!isMerge) return
    let live = true
    void api.repoMergeMethods(projectId, pull.repository)
      .catch((): GitHubRepoMergeMethodsResult => ({ status: 'failed', reason: 'unreachable' }))
      .then((result) => { if (live) setMethods(result) })
    return () => { live = false }
  }, [isMerge, api, projectId, pull.repository])
  const allowed = methods !== 'loading' && methods.status === 'ok' ? methods.methods : null
  const method = proposal.action !== 'merge' || !allowed
    ? null
    : proposal.method ? (allowed.includes(proposal.method) ? proposal.method : null) : allowed[0] ?? null
  const seenHead = seen?.head.sha
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }

  const confirm = async () => {
    if (busy || !armed) return
    let write: Promise<PullWriteResult>
    if (proposal.action === 'merge') {
      if (!method || !seenHead) return
      write = api.mergePull({ ...at, method, headSha: seenHead })
    } else if (proposal.action === 'comment') {
      write = api.commentOnPull({ ...at, body: proposal.message })
    } else {
      if (!seenHead || ownPull) return
      write = api.reviewPull({
        ...at, event: proposal.action === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES', body: proposal.message, headSha: seenHead
      })
    }
    setBusy(true)
    setRefusal(null)
    const outcome = await write.catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) {
      setRefusal(outcome.reason)
      if (outcome.reason === 'head-moved') onWritten()
      return
    }
    onDismiss()
    onWritten()
  }

  // Why Confirm is off, in the same words the node's own buttons use. `refused` = no Confirm at all.
  const needsOverview = 'Open the Overview tab first: the action is tied to the commit it shows.'
  let blocked: string | null = null
  let refused: string | null = null
  if (proposal.action === 'merge') {
    const why = seen ? mergeBlock(seen, seenChecks)?.text ?? null : needsOverview
    if (why) blocked = why
    else if (methods === 'loading') blocked = null
    else if (methods.status === 'refused') refused = REFUSAL_TEXT[methods.reason](pull.repository)
    else if (methods.status === 'failed') refused = FAILURE_TEXT[methods.reason]
    else if (proposal.method && !methods.methods.includes(proposal.method)) {
      refused = `This repository does not allow ${METHOD_TEXT[proposal.method]}. Merge with another method, or on GitHub.`
    } else if (!method) refused = 'This repository allows no merge method for your GitHub token. Merge on GitHub instead.'
  } else if (proposal.action !== 'comment') {
    // A comment is not tied to a head, as in the Conversation tab; a review is.
    blocked = ownPull ? OWN_PULL_TEXT : !seenHead ? needsOverview : null
  }
  const waiting = isMerge && methods === 'loading'
  return (
    <div className="pull-proposal" role="region" aria-label="Agent proposal">
      <p className="pull-proposal__what">
        Your agent proposes:{' '}
        {isMerge && seen
          ? <>Merge <strong>#{seen.number} {seen.title}</strong> into <code>{seen.base.ref}</code></>
          : <strong>{PROPOSAL_TEXT[proposal.action]} #{pull.pullNumber}</strong>}
        {method && <> ({METHOD_TEXT[method]})</>}
      </p>
      {proposal.action !== 'merge' && proposal.message.trim() && (
        <blockquote className="pull-proposal__message">{proposal.message}</blockquote>
      )}
      {(blocked ?? refused) && <p className="pull-node__empty">{blocked ?? refused}</p>}
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pull-compose__actions">
        {!refused && (
          <button className="pull-compose__button pull-merge__confirm" disabled={busy || !armed || !!blocked || waiting}
            onClick={() => void confirm()}>Confirm</button>
        )}
        <button className="pull-compose__button" disabled={busy} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}

/**
 * The requested reviewers, and "Request review…": a pick from the repository's collaborators (read
 * on the first click), sent only on Request. A user click only; no agent verb reaches it.
 */
/** "Send to agent…": a checklist of the unresolved line comment threads and the failing checks, the
 *  linked agent to send to (picked when there are several), then Send. Nothing is written to GitHub. */
function PullSendToAgent(props: ViewProps & { detail: GitHubPullDetail; checks: PullChecksRead }): React.JSX.Element {
  const { agents = [], sendUnavailable, onSendToAgent } = props
  const [open, setOpen] = useState(false)
  const why = sendUnavailable ?? (agents.length === 0
    ? 'No agent is linked to this node. Use Work on this PR, or draw a context link from an agent.'
    : undefined)
  return (
    <div className="pull-send">
      {!open && (
        <button className="pull-compose__button" disabled={!!why || !onSendToAgent} onClick={() => setOpen(true)}>
          Send to agent…
        </button>
      )}
      {!open && why && <span className="pull-node__empty">{why}</span>}
      {open && !why && <PullSendPanel {...props} agents={agents} onClose={() => setOpen(false)} />}
    </div>
  )
}

function PullSendPanel(props: ViewProps & {
  detail: GitHubPullDetail; checks: PullChecksRead; agents: readonly { id: string; title: string }[]; onClose: () => void
}): React.JSX.Element {
  const { pull, detail: d, checks, agents, onSendToAgent, onClose } = props
  const conversation = usePullRead(props.api.pullConversation, props)
  // The user's ticks over the defaults (outdated threads start unticked).
  const [ticks, setTicks] = useState<Record<string, boolean>>({})
  const [target, setTarget] = useState(agents.length === 1 ? agents[0].id : '')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  if (conversation === 'loading' || conversation.status !== 'ok') return readState(conversation, pull.repository)
  const items = pullFeedbackItems(conversation.lineComments, conversation.resolvedThreads, checks, d.head.sha)
    .map((item) => item.key in ticks ? { ...item, checked: ticks[item.key] } : item)
  const message = pullFeedbackMessage({ repository: pull.repository, number: pull.pullNumber }, items)
  const to = agents.find((agent) => agent.id === target)
  const send = async () => {
    if (busy || !message || !to || !onSendToAgent) return
    setBusy(true)
    const refused = await onSendToAgent(to.id, message).catch(() => 'The message could not be sent.')
    setBusy(false)
    setOutcome(refused ? { ok: false, text: refused } : { ok: true, text: `Sent to ${to.title}.` })
  }
  return (
    <div className="pull-send__panel">
      <p className="pull-node__empty">
        Pick what to send. Comment text goes to the agent as quoted data; nothing is written to GitHub.
        {conversation.resolvedThreads ? '' : ' Could not read which threads are resolved, so all are listed.'}
      </p>
      {items.length === 0
        ? <p className="pull-node__empty">No unresolved line comments and no failing checks.</p>
        : (
          <ul className="pull-send__items">
            {items.map((item) => (
              <li key={item.key}>
                <label className="pull-send__item">
                  <input type="checkbox" checked={item.checked}
                    onChange={(event) => setTicks((t) => ({ ...t, [item.key]: event.target.checked }))} />
                  {item.kind === 'check'
                    ? <span>Failing check: <code>{item.name}</code></span>
                    : (
                      <span>
                        <code>{item.path}{item.thread.line !== null ? `:${item.thread.line}` : ''}</code>
                        {item.thread.outdated && ' (outdated)'}{' '}
                        {item.thread.comments[0]?.author?.login ?? 'someone'}: {item.thread.comments[0]?.body.slice(0, 120)}
                        {item.thread.comments.length > 1 && ` (+${item.thread.comments.length - 1} more)`}
                      </span>
                    )}
                </label>
              </li>
            ))}
          </ul>
        )}
      <div className="pull-compose__actions">
        {agents.length > 1 && (
          <select aria-label="Agent" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="" disabled>Pick an agent…</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
          </select>
        )}
        <button className="pull-compose__button" disabled={busy || !message || !to} onClick={() => void send()}>
          {to && agents.length === 1 ? `Send to ${to.title}` : 'Send'}
        </button>
        <button className="pull-compose__button" disabled={busy} onClick={onClose}>Close</button>
      </div>
      {outcome && <p className={outcome.ok ? 'pull-node__empty' : 'pull-compose__error'} role={outcome.ok ? 'status' : 'alert'}>{outcome.text}</p>}
    </div>
  )
}

function PullReviewers(props: ViewProps & { detail: GitHubPullDetail }): React.JSX.Element {
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
        ? requested.map((user) => <span key={user.id} className="pull-node__author">{user.login}</span>)
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

/**
 * The Merge button and its confirmation, a modal over the node. Nothing merges without Confirm. The
 * merge is tied to the head the Overview shows, so GitHub refuses it (head-moved) if the PR moved;
 * the node then says so and reloads.
 */
function PullMerge(props: ViewProps & { detail: GitHubPullDetail; checks: PullChecksRead }): React.JSX.Element {
  const { api, projectId, pull, detail: d, checks, onWritten, onOpenTerminal } = props
  const name = useId()
  // Which confirmation is open: a merge now, or "Merge when ready" (GitHub's auto-merge).
  const [open, setOpen] = useState<'merge' | 'auto' | null>(null)
  const [methods, setMethods] = useState<GitHubRepoMergeMethodsResult | 'loading' | null>(null)
  const [method, setMethod] = useState<PullMergeMethod | null>(null)
  const [busy, setBusy] = useState(false)
  // The confirmation's refused write: a merge, or (`auto`) turning on auto-merge.
  const [refusal, setRefusal] = useState<{ reason: PullWriteReason; auto: boolean } | null>(null)
  const block = mergeBlock(d, checks)
  // The head an update was started from: GitHub updates in the background (202), so until the
  // node reads a new head the button stays off and the node says it is under way.
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null)
  const updating = updatedFrom === d.head.sha && block?.kind === 'behind'
  const update = useWrite(() => { setUpdatedFrom(d.head.sha); onWritten() })
  const cancelAuto = useWrite(onWritten)
  // Auto-merge waits for the reviews and checks branch protection asks for. It does not update a
  // branch, so a PR behind its base (or one that can merge now, or never can) gets none.
  const offersAuto = !d.autoMerge && block?.kind === 'blocked'

  const show = (mode: 'merge' | 'auto') => {
    setOpen(mode)
    setRefusal(null)
    // ponytail: the allowed methods are read once per node (the Overview stays mounted); only a
    // failed read is read again, on the next open.
    if (methods === 'loading' || methods?.status === 'ok') return
    setMethods('loading')
    void api.repoMergeMethods(projectId, pull.repository)
      .catch((): GitHubRepoMergeMethodsResult => ({ status: 'failed', reason: 'unreachable' }))
      .then((result) => {
        setMethods(result)
        if (result.status === 'ok') setMethod(result.methods[0] ?? null)
      })
  }
  const confirm = async () => {
    if (busy || !method || !open) return
    setBusy(true)
    const request = { projectId, repository: pull.repository, pullNumber: pull.pullNumber, method, headSha: d.head.sha }
    const outcome = await (open === 'auto' ? api.enablePullAutoMerge(request) : api.mergePull(request))
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    setOpen(null)
    if (!outcome.ok) setRefusal({ reason: outcome.reason, auto: open === 'auto' })
    if (outcome.ok || outcome.reason === 'head-moved') onWritten()
  }

  const ready = methods !== null && methods !== 'loading' && methods.status === 'ok' ? methods.methods : null
  const confirmable = !!ready?.length && (open !== 'auto' || (methods as { autoMerge?: true }).autoMerge === true)
  return (
    <div className="pull-merge">
      <button className="pull-compose__button" disabled={!!block || busy} onClick={() => show('merge')}>Merge…</button>
      {offersAuto && (
        <button className="pull-compose__button" disabled={busy} onClick={() => show('auto')}>Merge when ready…</button>
      )}
      {block && <p className="pull-merge__reason">{block.text}</p>}
      {d.autoMerge && (d.lifecycle === 'open' || d.lifecycle === 'draft') && (
        <>
          <p className="pull-node__state" role="status">
            Auto-merge is on ({METHOD_TEXT[d.autoMerge.method]}). GitHub merges it when the required reviews and checks pass.
          </p>
          <button className="pull-compose__button" disabled={cancelAuto.busy}
            onClick={() => void cancelAuto.run(() => api.disablePullAutoMerge({
              projectId, repository: pull.repository, pullNumber: pull.pullNumber
            }))}>Cancel auto-merge</button>
        </>
      )}
      {cancelAuto.refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[cancelAuto.refusal]}</p>}
      {block?.kind === 'behind' && (
        <button className="pull-compose__button" disabled={update.busy || updating}
          onClick={() => void update.run(async () => {
            const outcome = await api.updatePullBranch({
              projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: d.head.sha
            })
            if (!outcome.ok && outcome.reason === 'head-moved') onWritten()
            return outcome
          })}>Update branch</button>
      )}
      {block?.kind === 'conflict' && onOpenTerminal && PLAIN_BRANCH.test(d.head.ref) && (
        // ponytail: switches the project's own checkout; a fork's branch is not on origin.
        <button className="pull-compose__button" onClick={() => onOpenTerminal(`git fetch origin && git switch ${d.head.ref}`)}>
          Open terminal on this branch
        </button>
      )}
      {updating && <p className="pull-node__state" role="status">GitHub is updating the branch. Refresh in a moment to see the new commit.</p>}
      {update.refusal && (
        <p className="pull-compose__error" role="alert">
          {update.refusal === 'head-moved' ? UPDATE_MOVED_TEXT : WRITE_TEXT[update.refusal]}
        </p>
      )}
      {refusal && (
        <p className="pull-compose__error" role="alert">
          {refusal.auto && refusal.reason === 'head-moved' ? AUTO_MOVED_TEXT : WRITE_TEXT[refusal.reason]}
        </p>
      )}
      {open && (
        <div className="pull-merge__backdrop">
          <div className="pull-merge__dialog" role="dialog" aria-modal="true"
            aria-label={open === 'auto' ? 'Merge pull request when ready' : 'Merge pull request'}>
            <p className="pull-merge__what">
              Merge <strong>#{d.number} {d.title}</strong> into <code>{d.base.ref}</code>
              {open === 'auto' ? ' when ready? GitHub merges it once the required reviews and checks pass.' : '?'}
            </p>
            {methods === null || methods === 'loading'
              ? <p className="pull-node__state">Loading the allowed merge methods…</p>
              : methods.status === 'refused'
                ? <p className="pull-node__state" role="status">{REFUSAL_TEXT[methods.reason](pull.repository)}</p>
                : methods.status === 'failed'
                  ? <p className="pull-node__state" role="status">{FAILURE_TEXT[methods.reason]}</p>
                  : open === 'auto' && !methods.autoMerge
                    ? <p className="pull-node__state" role="status">
                        This repository does not allow auto-merge. Turn on Allow auto-merge in its GitHub settings (General), or merge on GitHub.
                      </p>
                  : methods.methods.length === 0
                    ? <p className="pull-node__state" role="status">
                        This repository allows no merge method for your GitHub token. Merge on GitHub instead.
                      </p>
                    : (
                      <fieldset className="pull-merge__methods">
                        <legend>Merge method</legend>
                        {methods.methods.map((item) => (
                          <label key={item} className="pull-merge__method">
                            <input type="radio" name={name} value={item} checked={method === item}
                              onChange={() => setMethod(item)} />
                            {METHOD_TEXT[item]}
                          </label>
                        ))}
                      </fieldset>
                    )}
            <div className="pull-compose__actions">
              {confirmable && (
                <button className="pull-compose__button pull-merge__confirm" disabled={busy || !method}
                  onClick={() => void confirm()}>{open === 'auto' ? 'Enable auto-merge' : 'Confirm merge'}</button>
              )}
              <button className="pull-compose__button" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** The Conversation tab: comments and reviews, oldest first, then the composer. The draft lives here
 *  (the tab stays mounted), so it survives a tab switch; it is never persisted. */
function PullConversation(props: ViewProps & {
  seenHead: string | undefined; ownPull: boolean; pending: readonly PullLineDraft[]; onDropPending: (sent: readonly PullLineDraft[]) => void
}): React.JSX.Element {
  const { api, projectId, pull, onWritten, seenHead, ownPull, pending, onDropPending } = props
  const result = usePullRead(api.pullConversation, props)
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
  // A review is tied to the head the Overview showed, so GitHub refuses it if the PR moved since.
  // ponytail: no head seen yet (Overview never opened) disables review rather than reading one here.
  // The pending line comments ride the review.
  const review = (event: PullReviewEvent) => {
    const sent = [...pending]
    return seenHead && run(() =>
      api.reviewPull({ ...at, event, body: draft, headSha: seenHead, ...(sent.length ? { comments: sent } : {}) }), sent)
  }

  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  return (
    <div className="pull-node__conversation">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.truncated && <p className="pull-node__empty">Showing the first items only. Open on GitHub for the rest.</p>}
      {result.items.length === 0
        ? <p className="pull-node__empty">No comments or reviews yet.</p>
        : (
          <ol className="pull-convo">
            {result.items.map((item) => (
              <li key={`${item.kind}-${item.id}`} className={`pull-convo__item pull-convo__item--${item.kind}`}>
                <div className="pull-convo__head">
                  <span className="pull-node__author">{item.author?.login ?? 'ghost'}</span>
                  {item.kind === 'review' && (
                    <span className={`pull-convo__verdict pull-convo__verdict--${item.verdict}`}>{VERDICT_TEXT[item.verdict]}</span>
                  )}
                  <time className="pull-convo__time" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
                </div>
                {item.body.trim() && <NoteMarkdown text={item.body} className="sticky-node__md pull-node__md" />}
                {item.kind === 'review' && (
                  <ul className="pull-convo__lines">
                    {result.lineComments.filter((line) => line.reviewId === item.id).map((line) => (
                      <li key={line.id}>
                        <code>{line.path}{line.line !== null && `:${line.line}`}</code>
                        {line.outdated && <span className="pull-line__outdated">Outdated</span>}
                        <NoteMarkdown text={line.body} className="sticky-node__md pull-node__md" />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      <div className="pull-compose">
        <textarea className="pull-compose__box" aria-label="Comment" placeholder="Write a comment or a review message"
          value={draft} onChange={(event) => setDraft(event.target.value)} />
        {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
        <div className="pull-compose__actions">
          {/* With pending line comments, Comment submits them as a comment review. */}
          <button className="pull-compose__button" disabled={busy || (pending.length ? !seenHead : !draft.trim())}
            onClick={() => void (pending.length ? review('COMMENT') : run(() => api.commentOnPull({ ...at, body: draft })))}>Comment</button>
          {!ownPull && (
            <>
              <button className="pull-compose__button" disabled={busy || !seenHead}
                onClick={() => void review('APPROVE')}>Approve</button>
              <button className="pull-compose__button" disabled={busy || !seenHead || !draft.trim()}
                onClick={() => void review('REQUEST_CHANGES')}>Request changes</button>
            </>
          )}
        </div>
        {pending.length > 0 && (
          <p className="pull-node__empty">
            {pending.length === 1 ? '1 line comment waits' : `${pending.length} line comments wait`} for your review: Comment,
            Approve or Request changes sends {pending.length === 1 ? 'it' : 'them'}.{' '}
            <button className="pull-compose__button" disabled={busy} onClick={() => onDropPending(pending)}>Discard</button>
          </p>
        )}
        {ownPull && <p className="pull-node__empty">{OWN_PULL_TEXT}</p>}
        {!seenHead && !ownPull && <p className="pull-node__empty">Open the Overview tab to review: a review is tied to the commit it shows.</p>}
      </div>
    </div>
  )
}
