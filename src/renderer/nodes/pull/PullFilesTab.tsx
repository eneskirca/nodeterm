import { useCallback, useState } from 'react'
import type {
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
import { pullFileTree, type PullTreeNode } from '../../lib/pullFileTree'
import { pullLineThreads, type PullLineThread } from '../../lib/pullLineThreads'
import { PullComposer } from './PullComposer'
import { readState, STALE_TEXT, usePullRead, useWrite, WRITE_TEXT, type ViewProps } from './shared'

const FILE_STATUS_TEXT: Record<PullFileStatus, string> = {
  added: 'Added', modified: 'Modified', removed: 'Removed', renamed: 'Renamed'
}

const UNAVAILABLE_TEXT: Record<PullFileUnavailable, string> = {
  binary: 'Cannot show this file: it is a binary file.',
  'too-large': 'Cannot show this file: it is larger than 1 MB.',
  'not-in-pull': 'Cannot show this file: the pull request no longer changes it. Refresh the file list.'
}

export type LineProps = {
  pending: readonly PullLineDraft[]
  onAddPending: (draft: PullLineDraft) => void
}

/** The Files changed tab: a filter, the "N of M viewed" count and the "Review changes" panel, the
 *  changed files as a tree with a Viewed box each, then the selected one as a side-by-side diff
 *  with its line comments (collapsed once viewed). `head` (the node's detail read) is the commit a
 *  new line comment and the review are tied to; the conversation read gives the comments, from the
 *  core's memory inside its floor. */
export function PullFilesTab(props: ViewProps & LineProps & {
  onSelectFile: (path: string) => void; highlight?: PullHighlight; head: string | undefined
  ownPull: boolean; onDropPending: (sent: readonly PullLineDraft[]) => void
}): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal, onSelectFile, highlight, head } = props
  const result = usePullRead(api.pullFiles, props)
  const conversation = usePullRead(api.pullConversation, props)
  const [filter, setFilter] = useState('')
  const [reviewing, setReviewing] = useState(false)
  // The boxes the user ticked here, ahead of the next read. ponytail: no reload after the write (it
  // would read the whole node again per tick); the core dropped its held list, so the next read is fresh.
  const [ticked, setTicked] = useState<Readonly<Record<string, boolean>>>({})
  const [viewRefusal, setViewRefusal] = useState<PullWriteReason | null>(null)
  // The viewed file whose diff the user opened again.
  const [reopened, setReopened] = useState<string | null>(null)
  const lineComments = conversation !== 'loading' && conversation.status === 'ok' ? conversation.lineComments : []
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const filesUrl = `${pullWebUrl(pull.repository, pull.pullNumber)}/files`
  const selected = result.files.find((file) => file.path === pull.selectedFile)
  const isViewed = (file: PullFile) => ticked[file.path] ?? file.viewerViewedState === 'VIEWED'
  const viewedCount = result.files.filter(isViewed).length
  const setViewed = async (path: string, viewed: boolean) => {
    setTicked((list) => ({ ...list, [path]: viewed }))
    setViewRefusal(null)
    const outcome = await api.setFileViewed({ projectId, repository: pull.repository, pullNumber: pull.pullNumber, path, viewed })
      .catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    if (outcome.ok) return
    setTicked((list) => ({ ...list, [path]: !viewed }))
    setViewRefusal(outcome.reason)
  }
  const tree = pullFileTree(result.files, filter)
  const rows = (nodes: readonly PullTreeNode[]): React.JSX.Element => (
    <ul className="pull-files__tree">
      {nodes.map((node) => node.kind === 'folder'
        ? (
          <li key={`d:${node.path}`}>
            <div className="pull-files__folder">
              <span className="pull-files__path">{node.name}/</span>
              <span className="pull-files__add">+{node.additions}</span>
              <span className="pull-files__del">−{node.deletions}</span>
            </div>
            {rows(node.children)}
          </li>
        )
        : (
          <li key={node.file.path} className={`pull-files__row${isViewed(node.file) ? ' pull-files__row--viewed' : ''}`}>
            <input type="checkbox" className="pull-files__viewed" aria-label={`Viewed ${node.file.path}`} title="Viewed"
              checked={isViewed(node.file)} onChange={(event) => void setViewed(node.file.path, event.target.checked)} />
            <button className="pull-files__file" title={node.file.path} aria-current={node.file === selected ? 'true' : undefined}
              onClick={() => onSelectFile(node.file.path)}>
              <span className={`pull-files__status pull-files__status--${node.file.status}`}>{FILE_STATUS_TEXT[node.file.status]}</span>
              <span className="pull-files__path">
                {node.file.previousPath && <>{node.file.previousPath} → </>}{node.name}
              </span>
              <span className="pull-files__add">+{node.file.additions}</span>
              <span className="pull-files__del">−{node.file.deletions}</span>
            </button>
          </li>
        ))}
    </ul>
  )
  return (
    <div className="pull-files">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      <div className="pull-files__bar">
        <input type="search" className="pull-files__filter" aria-label="Filter files" placeholder="Filter files"
          value={filter} onChange={(event) => setFilter(event.target.value)} />
        <span className="pull-files__count">{`${viewedCount} of ${result.files.length} viewed`}</span>
        {head && (
          <button className="pull-compose__button" aria-expanded={reviewing} onClick={() => setReviewing(!reviewing)}>
            Review changes
          </button>
        )}
      </div>
      {reviewing && head && (
        <div className="pull-files__review">
          <PullComposer {...props} headSha={head} reviewPanel />
        </div>
      )}
      {viewRefusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[viewRefusal]}</p>}
      {result.files.length === 0
        ? <p className="pull-node__empty">No changed files.</p>
        : tree.length === 0
          ? <p className="pull-node__empty">No file matches the filter.</p>
          : <div className="pull-files__list">{rows(tree)}</div>}
      {result.truncated && (
        <p className="pull-files__truncated">
          Showing the first 300 files only.{' '}
          <button className="pull-node__web" onClick={() => onOpenExternal(filesUrl)}>Open on GitHub</button> for the rest.
        </p>
      )}
      {selected && isViewed(selected) && reopened !== selected.path && highlight?.file !== selected.path
        ? (
          <p className="pull-node__empty">
            {`${selected.path} is marked viewed.`}{' '}
            <button className="pull-node__web" onClick={() => setReopened(selected.path)}>Show the diff</button>
          </p>
        )
        : selected
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
        Click a line number (or the + beside it) to comment on that line. GitHub takes comments only on changed lines and the lines next to them.
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
