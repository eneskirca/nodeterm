import { useCallback, useState } from 'react'
import type { GitHubPullCommitFilesResult } from '@shared/github-pull-commits'
import type {
  GitHubPullFileContentsResult,
  GitHubPullFilesResult,
  PullAvatarDataUrls,
  PullDiffSide,
  PullFile,
  PullFileSide,
  PullFileStatus,
  PullFileUnavailable,
  PullLineComment,
  PullLineDraft,
  PullWriteReason,
  PullWriteResult
} from '@shared/github-pull-detail'
import { pullWebUrl } from '@shared/pull-node'
import type { PullHighlight } from '@shared/pull-agent-verbs'
import { NoteMarkdown } from '../../components/NoteMarkdown'
import { TextDiff, type DiffZone } from '../../editor/TextDiff'
import { openThreadsByPath, pullFileTree, type PullTreeNode } from '../../lib/pullFileTree'
import { pullLineThreads, type PullLineThread } from '../../lib/pullLineThreads'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { PullReviewPanel } from './PullReviewPanel'
import { useSendTo } from './SendTo'
import { readState, STALE_TEXT, usePullRead, useWrite, WRITE_TEXT, type Read, type ViewProps } from './shared'
import './pull-files.css'

export const FILE_STATUS_TEXT: Record<PullFileStatus, string> = {
  added: 'Added', modified: 'Modified', removed: 'Removed', renamed: 'Renamed'
}

export const UNAVAILABLE_TEXT: Record<PullFileUnavailable, string> = {
  binary: 'Cannot show this file: it is a binary file.',
  'too-large': 'Cannot show this file: it is larger than 1 MB.',
  'not-in-pull': 'Cannot show this file: the pull request no longer changes it. Refresh the file list.'
}

export type LineProps = {
  pending: readonly PullLineDraft[]
  onAddPending: (draft: PullLineDraft) => void
}

type FilesRead = GitHubPullFilesResult | GitHubPullCommitFilesResult
type ContentsRead = (projectId: string, repository: string, pullNumber: number, path: string) => Promise<GitHubPullFileContentsResult>

/** One extra Compare choice (F-10's "Since my last review"). Read-only like a commit: its own file
 *  list and diffs, no threads, no Viewed box. Pass a stable (memoized) list: the reads key on it. */
export interface PullCompareOption {
  value: string
  label: string
  files: (projectId: string, repository: string, pullNumber: number) => Promise<FilesRead>
  contents: ContentsRead
}

/** A line note for the linked agent (F-07). */
export type PullAgentNote = { path: string; side: PullDiffSide; line: number; text: string }

export type FilesTabProps = ViewProps & LineProps & {
  onSelectFile: (path: string) => void; highlight?: PullHighlight; head: string | undefined
  ownPull: boolean; onDropPending: (sent: readonly PullLineDraft[]) => void
  /** F-10 seam: Compare choices after "All changes", before the commits. */
  compareExtra?: readonly PullCompareOption[]
  /** F-07 seam: the line composer's "Note for agent". Absent = the button is off. */
  onNoteForAgent?: (note: PullAgentNote) => void
}

const ALL = 'all'
const COMMIT = 'commit:'

/** The Files changed tab (F2): a tree of the changed files (filter, viewed progress, open threads
 *  per file, Hide viewed files) beside a toolbar (Compare, Split/Unified, Finish review) and the
 *  selected file's diff under a sticky header with its Viewed box. "All changes" is the review view
 *  (threads, line comments, Viewed); a commit or an extra Compare choice shows its own diff, read-only. */
export function PullFilesTab(props: FilesTabProps): React.JSX.Element {
  const { api, pull, compareExtra, head } = props
  const all = usePullRead(api.pullFiles, props)
  const commits = usePullRead(api.pullCommits, props)
  const [compare, setCompare] = useState(ALL)
  // ponytail: the layout is view state only; saving it in the node ref would widen the persisted shape.
  const [split, setSplit] = useState(true)
  const [finishing, setFinishing] = useState(false)
  const extra = compareExtra?.find((option) => option.value === compare)
  const sha = compare.startsWith(COMMIT) ? compare.slice(COMMIT.length) : undefined
  const commitFiles = useCallback(
    (projectId: string, repository: string, pullNumber: number) => api.pullCommitFiles(projectId, repository, pullNumber, sha!),
    [api, sha])
  const commitContents = useCallback<ContentsRead>(
    (projectId, repository, pullNumber, path) => api.pullCommitFileContents(projectId, repository, pullNumber, sha!, path),
    [api, sha])
  const commitList = commits !== 'loading' && commits.status === 'ok' ? commits.commits : []
  const toolbar = (
    <div className="pf-toolbar">
      <label className="pf-toolbar__compare">
        Compare
        <select className="pf-select" value={compare} onChange={(e) => setCompare(e.target.value)}>
          <option value={ALL}>All changes</option>
          {compareExtra?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          {commitList.map((commit) => (
            <option key={commit.oid} value={`${COMMIT}${commit.oid}`}>{`${commit.oid.slice(0, 7)} ${commit.headline}`}</option>
          ))}
        </select>
      </label>
      <span role="group" aria-label="Diff layout" className="pf-seg">
        <button className="pf-seg__btn" aria-pressed={split} onClick={() => setSplit(true)}>Split</button>
        <button className="pf-seg__btn" aria-pressed={!split} onClick={() => setSplit(false)}>Unified</button>
      </span>
      {head && (
        <span className="pf-toolbar__finish">
          <button className="pr-btn pr-btn--primary pf-small" aria-expanded={finishing} onClick={() => setFinishing(!finishing)}>
            Finish review <span className="pf-count">{props.pending.length}</span><Icon name="chevron" size={14} />
          </button>
          {finishing && <PullReviewPanel {...props} headSha={head} onClose={() => setFinishing(false)} />}
        </span>
      )}
    </div>
  )
  if (all === 'loading' || all.status !== 'ok') return readState(all, pull.repository)
  const body = { ...props, toolbar, split, all, review: compare === ALL }
  if (compare === ALL) return <FilesBody {...body} list={all} contents={api.pullFileContents} />
  if (extra) return <SourceList key={compare} {...body} read={extra.files} contents={extra.contents} />
  return <SourceList key={compare} {...body} read={commitFiles} contents={commitContents}
    webUrl={`${pullWebUrl(pull.repository, pull.pullNumber)}/commits/${sha}`} />
}

type BodyProps = FilesTabProps & {
  toolbar: React.ReactNode; split: boolean; review: boolean
  all: Extract<GitHubPullFilesResult, { status: 'ok' }>; contents: ContentsRead; webUrl?: string
}

/** A read-only Compare choice: its own file list (remounted per choice, so it starts loading). */
function SourceList(props: BodyProps & { read: (projectId: string, repository: string, pullNumber: number) => Promise<FilesRead> }): React.JSX.Element {
  const list = usePullRead(props.read, props)
  return <FilesBody {...props} list={list} />
}

function FilesBody(props: BodyProps & { list: Read<FilesRead> }): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal, onSelectFile, highlight, list, all, review, toolbar } = props
  const conversation = usePullRead(api.pullConversation, props)
  const [filter, setFilter] = useState('')
  const [hideViewed, setHideViewed] = useState(false)
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  // The boxes the user ticked here, ahead of the next read. ponytail: no reload after the write (it
  // would read the whole node again per tick); the core dropped its held list, so the next read is fresh.
  const [ticked, setTicked] = useState<Readonly<Record<string, boolean>>>({})
  const [viewRefusal, setViewRefusal] = useState<PullWriteReason | null>(null)
  // The viewed file whose diff the user opened again.
  const [reopened, setReopened] = useState<string | null>(null)
  const convo = conversation !== 'loading' && conversation.status === 'ok' ? conversation : undefined
  const lineComments = convo?.lineComments ?? []
  const threadCounts = convo && openThreadsByPath(lineComments, convo.resolvedThreads)
  const viewedOnGitHub = new Set(all.files.filter((f) => f.viewerViewedState === 'VIEWED').map((f) => f.path))
  const isViewed = (path: string) => ticked[path] ?? viewedOnGitHub.has(path)
  const viewedCount = all.files.filter((f) => isViewed(f.path)).length
  const setViewed = async (path: string, viewed: boolean) => {
    setTicked((t) => ({ ...t, [path]: viewed }))
    setViewRefusal(null)
    const outcome = await api.setFileViewed({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, path, viewed })
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    if (outcome.ok) return
    setTicked((t) => ({ ...t, [path]: !viewed }))
    setViewRefusal(outcome.reason)
  }
  const ok = list !== 'loading' && list.status === 'ok' ? list : undefined
  const files = ok?.files ?? []
  // ponytail: a read-only view opens its first file, as the Commits tab does; All changes waits for a pick.
  const selected = files.find((f) => f.path === pull.selectedFile) ?? (review ? undefined : files[0])
  const tree = pullFileTree(files, filter, hideViewed ? (f) => isViewed(f.path) && f !== selected : undefined)
  const filesUrl = props.webUrl ?? `${pullWebUrl(pull.repository, pull.pullNumber)}/files`
  const rows = (nodes: readonly PullTreeNode[], depth: number): React.JSX.Element[] => nodes.flatMap((node) => {
    const level = Math.min(depth, 6)
    if (node.kind === 'folder') {
      const open = !closed.has(node.path)
      return [
        <button key={`d:${node.path}`} className="pf-dir" data-depth={level} aria-expanded={open}
          onClick={() => setClosed((set) => { const next = new Set(set); if (open) next.add(node.path); else next.delete(node.path); return next })}>
          <Icon name={open ? 'chevron' : 'chevron-right'} size={12} />{node.name}
        </button>,
        ...(open ? rows(node.children, depth + 1) : [])
      ]
    }
    const f = node.file
    const threads = threadCounts?.get(f.path)
    return [
      <button key={f.path} className={`pf-file${isViewed(f.path) ? ' pf-file--viewed' : ''}`} data-depth={level}
        title={f.path} aria-current={f === selected ? 'true' : undefined} onClick={() => onSelectFile(f.path)}>
        <span className="sr-only">{FILE_STATUS_TEXT[f.status]}</span>
        <span className="pf-mono pf-file__name">{f.previousPath && <>{f.previousPath} → </>}{node.name}</span>
        {!!threads && (
          <span className="pf-file__threads" title={`${threads} open thread${threads === 1 ? '' : 's'}`}>
            <Icon name="thread" size={12} />{threads}
          </span>
        )}
        {isViewed(f.path)
          ? <span className="pf-file__end pf-file__check"><Icon name="check" size={14} label="Viewed" /></span>
          : <span className="pf-file__end pf-mono"><span className="pr-add">+{f.additions}</span> <span className="pr-del">−{f.deletions}</span></span>}
      </button>
    ]
  })
  return (
    <div className="pf">
      <nav aria-label="Changed files" className="pf-nav">
        <label className="pf-filter">
          <Icon name="search" size={14} />
          <input type="search" aria-label="Filter files" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <div className="pf-progress">
          <span className="pf-progress__count">{`${viewedCount} of ${all.files.length} viewed`}</span>
          <progress className="pf-progress__bar" aria-label="Files viewed" value={viewedCount} max={Math.max(all.files.length, 1)} />
        </div>
        <div className="pf-tree">
          {list === 'loading' || list.status !== 'ok'
            ? null
            : files.length === 0
              ? <p className="pf-muted">No changed files.</p>
              : tree.length === 0
                ? <p className="pf-muted">{filter.trim() ? 'No file matches the filter.' : 'Every file is viewed.'}</p>
                : rows(tree, 0)}
        </div>
        <div className="pf-nav__foot">
          <label><input type="checkbox" checked={hideViewed} onChange={(e) => setHideViewed(e.target.checked)} /> Hide viewed files</label>
        </div>
      </nav>
      <div className="pf-main">
        {toolbar}
        {all.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[all.stale]}</p>}
        {viewRefusal && <p className="pf-error" role="alert">{WRITE_TEXT[viewRefusal]}</p>}
        {!review && <p className="pf-muted pf-pad">This view is read-only. Comments and Viewed marks are on All changes.</p>}
        {list === 'loading' || list.status !== 'ok'
          ? <div className="pf-pad">{readState(list, pull.repository)}</div>
          : <>
            {list.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[list.stale]}</p>}
            {list.truncated && (
              <p className="pf-muted pf-pad pf-truncated">
                Showing the first 300 files only.{' '}
                <button className="pull-node__web" onClick={() => onOpenExternal(filesUrl)}>Open on GitHub</button> for the rest.
              </p>
            )}
            {selected
              ? (
                <>
                  <FileHeader file={selected} viewed={isViewed(selected.path)} review={review}
                    open={!isViewed(selected.path) || reopened === selected.path || highlight?.file === selected.path}
                    onToggle={(open) => setReopened(open ? selected.path : null)}
                    onViewed={(viewed) => { void setViewed(selected.path, viewed); setReopened(null) }} />
                  {isViewed(selected.path) && reopened !== selected.path && highlight?.file !== selected.path
                    ? (
                      <p className="pf-muted pf-pad">
                        {`${selected.path} is marked viewed.`}{' '}
                        <button className="pull-node__web" onClick={() => setReopened(selected.path)}>Show the diff</button>
                      </p>
                    )
                    : <PullFileDiff key={selected.path} {...props} file={selected} filesUrl={filesUrl}
                        highlight={review && highlight?.file === selected.path ? highlight : undefined}
                        lineComments={review ? lineComments : []} resolvedThreads={convo?.resolvedThreads}
                        avatars={convo?.avatarDataUrls} />}
                </>
              )
              : files.length > 0 && <p className="pf-muted pf-pad">Select a file to see its diff.</p>}
          </>}
      </div>
    </div>
  )
}

function FileHeader({ file, viewed, review, open, onToggle, onViewed }: {
  file: PullFile; viewed: boolean; review: boolean; open: boolean; onToggle: (open: boolean) => void; onViewed: (viewed: boolean) => void
}): React.JSX.Element {
  return (
    <div className="pf-head">
      <button className="pr-btn pr-btn--ghost pr-btn--small" aria-expanded={open} aria-label={open ? 'Hide the diff' : 'Show the diff'}
        onClick={() => onToggle(!open)}>
        <Icon name={open ? 'chevron' : 'chevron-right'} size={14} />
      </button>
      <span className="pf-mono pf-head__path">{file.previousPath && <>{file.previousPath} → </>}{file.path}</span>
      <span className="pf-mono pr-add">+{file.additions}</span>
      <span className="pf-mono pr-del">−{file.deletions}</span>
      {review && (
        <label className="pf-head__viewed">
          <input type="checkbox" aria-label={`Viewed ${file.path}`} checked={viewed} onChange={(e) => onViewed(e.target.checked)} /> Viewed
        </label>
      )}
    </div>
  )
}

const sideText = (side: PullFileSide): string => side.kind === 'text' ? side.text : ''

const SIDE_OF = { LEFT: 'original', RIGHT: 'modified' } as const

function PullFileDiff(props: BodyProps & {
  file: PullFile; filesUrl: string; lineComments: readonly PullLineComment[]
  resolvedThreads?: readonly number[]; avatars?: PullAvatarDataUrls
}): React.JSX.Element {
  const { pull, file, filesUrl, onOpenExternal, highlight, head, lineComments, pending, onAddPending, review, contents: readContents, split } = props
  const path = file.path
  // The line the user clicked, where the new-comment box opens.
  const [composing, setComposing] = useState<{ side: PullDiffSide; line: number } | null>(null)
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) => readContents(projectId, repository, pullNumber, path),
    [readContents, path]
  )
  const result = usePullRead(read, props)
  if (result === 'loading' || result.status !== 'ok') return <div className="pf-pad">{readState(result, pull.repository)}</div>
  const { contents } = result
  const threads = pullLineThreads(lineComments, path)
  const zones: DiffZone[] = review ? [
    ...threads.flatMap((thread) => thread.line === null ? [] : [{
      key: `thread-${thread.id}`, side: SIDE_OF[thread.side], line: thread.line,
      content: <PullLineThreadView {...props} thread={thread} />
    }]),
    ...pending.flatMap((draft, index) => draft.path !== path ? [] : [{
      key: `pending-${index}`, side: SIDE_OF[draft.side], line: draft.line,
      content: <p className="pf-card pf-card__pending"><strong>Pending</strong> (sent with your review): {draft.body}</p>
    }]),
    ...(composing ? [{
      key: `new-${composing.side}-${composing.line}`, side: SIDE_OF[composing.side], line: composing.line,
      content: <PullLineComposer {...props} head={head} draft={{ path, ...composing }}
        onAdd={(draft) => { onAddPending(draft); setComposing(null) }} onClose={() => setComposing(null)} />
    }] : [])
  ] : []
  const offLine = threads.filter((thread) => thread.line === null)
  if (contents.kind === 'unavailable') {
    return (
      <p className="pf-muted pf-pad pf-unavailable" role="status">
        {UNAVAILABLE_TEXT[contents.reason]}{' '}
        <button className="pull-node__web" onClick={() => onOpenExternal(filesUrl)}>Open on GitHub</button>
      </p>
    )
  }
  return (
    <>
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      <TextDiff className="pf-diff" path={path} original={sideText(contents.base)} modified={sideText(contents.head)}
        highlight={highlight} zones={zones} sideBySide={split}
        onLineClick={review ? (side, line) => setComposing({ side: side === 'original' ? 'LEFT' : 'RIGHT', line }) : undefined} />
      {review && (
        <p className="pf-muted pf-pad pf-hint">
          Click a line number to comment on that line. GitHub takes comments only on changed lines and the lines next to them.
        </p>
      )}
      {offLine.length > 0 && (
        <div className="pf-off">
          <p className="pf-muted">Not on a current line of this diff:</p>
          {offLine.map((thread) => <PullLineThreadView key={thread.id} {...props} thread={thread} />)}
        </div>
      )}
    </>
  )
}

/** A comment carries a GitHub suggestion block (the core reads its lines). */
const SUGGESTION = /^[ \t]*```suggestion[ \t]*\r?$/m

/** One thread card (F2): its comments, then Commit suggestion (a suggestion on a current head
 *  line), Reply, Ask agent (Send to…) and Resolve / Unresolve (when the read said which threads are
 *  resolved). */
function PullLineThreadView(props: ViewProps & {
  thread: PullLineThread; head?: string; resolvedThreads?: readonly number[]; avatars?: PullAvatarDataUrls
}): React.JSX.Element {
  const { api, projectId, pull, thread, onWritten, head, resolvedThreads, avatars } = props
  const [reply, setReply] = useState<string | null>(null)
  const { busy, refusal, run } = useWrite(() => { setReply(null); onWritten() })
  const action = useWrite(onWritten)
  const { sendTo, why } = useSendTo()
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  const resolved = resolvedThreads?.includes(thread.id)
  // ponytail: one Commit suggestion per thread, for its latest suggestion.
  const suggestion = thread.side === 'RIGHT' && thread.line !== null && head
    ? [...thread.comments].reverse().find((comment) => SUGGESTION.test(comment.body)) : undefined
  const sendThread = { id: thread.id, path: thread.comments[0]?.path ?? '', line: thread.line }
  return (
    <div className="pf-card">
      {(thread.outdated || resolved) && (
        <div className="pf-card__tags">
          {thread.outdated && <span className="pf-tag">Outdated</span>}
          {resolved && <span className="pf-tag pf-tag--resolved">Resolved</span>}
        </div>
      )}
      {thread.comments.map((comment) => (
        <div key={comment.id} className="pf-card__comment">
          <div className="pf-card__who">
            <Avatar user={comment.author} avatars={avatars} />
            <strong>{comment.author?.login ?? 'ghost'}</strong>
            <time className="pf-muted" dateTime={comment.at}>{new Date(comment.at).toLocaleString()}</time>
          </div>
          <NoteMarkdown text={comment.body} className="sticky-node__md pull-node__md pf-card__md" />
        </div>
      ))}
      {reply !== null && (
        <textarea className="pf-box" aria-label="Reply" placeholder="Reply" autoFocus
          value={reply} onChange={(e) => setReply(e.target.value)} />
      )}
      {refusal && <p className="pf-error" role="alert">{WRITE_TEXT[refusal]}</p>}
      {action.refusal && <p className="pf-error" role="alert">{WRITE_TEXT[action.refusal]}</p>}
      <div className="pf-card__actions">
        {reply === null
          ? (
            <>
              {suggestion && (
                <button className="pr-btn pr-btn--primary pf-small" disabled={action.busy} onClick={() => void action.run(async () => {
                  const outcome = await api.applySuggestion({ ...at, headSha: head!, commentId: suggestion.id })
                  // The core dropped its held reads: read again so the user sees the new lines.
                  if (!outcome.ok && outcome.reason === 'suggestion-stale') onWritten()
                  return outcome
                })}>Commit suggestion</button>
              )}
              <button className="pr-btn pf-small" onClick={() => setReply('')}>Reply</button>
              <button className="pr-btn pf-small" disabled={!sendTo} title={why}
                onClick={() => sendTo?.(suggestion ? { kind: 'suggestion', thread: sendThread } : { kind: 'threads', threads: [sendThread] })}>
                <Icon name="agent" size={14} className="pf-agent" />Ask agent
              </button>
            </>
          )
          : (
            <>
              <button className="pr-btn pf-small" disabled={busy} onClick={() => setReply(null)}>Cancel</button>
              <button className="pr-btn pr-btn--primary pf-small" disabled={busy || !reply.trim()} onClick={() => void run(() =>
                api.commentOnPullLine({ ...at, inReplyTo: thread.id, body: reply }))}>Reply</button>
            </>
          )}
        {resolved !== undefined && (
          <button className="pr-btn pf-small pf-end" disabled={action.busy} onClick={() => void action.run(() =>
            api.setReviewThreadResolved({ ...at, threadId: thread.id, resolved: !resolved }))}>
            {resolved ? 'Unresolve' : 'Resolve'}
          </button>
        )}
      </div>
    </div>
  )
}

/** The new-comment box under a clicked line: Cancel, Note for agent (F-07), Comment now, or Add to
 *  review (kept for the next review). */
function PullLineComposer(props: ViewProps & {
  head: string | undefined; draft: Omit<PullLineDraft, 'body'>; onAdd: (draft: PullLineDraft) => void; onClose: () => void
  onNoteForAgent?: (note: PullAgentNote) => void
}): React.JSX.Element {
  const { api, projectId, pull, head, draft, onAdd, onClose, onWritten, onNoteForAgent } = props
  const [body, setBody] = useState('')
  const { busy, refusal, run } = useWrite(() => { onClose(); onWritten() })
  const comment = { ...draft, body }
  const empty = !body.trim()
  return (
    <div className="pf-card pf-card--new">
      <textarea className="pf-box pf-box--bare" aria-label="Line comment" autoFocus rows={2}
        placeholder={`Comment on line ${draft.line}`} value={body} onChange={(e) => setBody(e.target.value)} />
      {refusal && <p className="pf-error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pf-card__actions">
        <button className="pr-btn pf-small" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pr-btn pf-small pf-end" disabled={busy || empty || !onNoteForAgent}
          title={onNoteForAgent ? 'A private note the agent reads; not posted to GitHub' : 'Notes for agents are not available yet.'}
          onClick={() => { onNoteForAgent?.({ path: draft.path, side: draft.side, line: draft.line, text: body }); onClose() }}>
          <Icon name="note" size={14} className="pf-agent" />Note for agent
        </button>
        <button className="pr-btn pf-small" disabled={busy || empty || !head} onClick={() => void run(() =>
          api.commentOnPullLine({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, headSha: head!, comment }))}>
          Comment now
        </button>
        <button className="pr-btn pr-btn--primary pf-small" disabled={busy || empty} onClick={() => onAdd(comment)}>Add to review</button>
      </div>
    </div>
  )
}
