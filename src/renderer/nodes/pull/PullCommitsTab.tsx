import { useCallback, useState } from 'react'
import type { PullCommit } from '@shared/github-pull-commits'
import type { PullAvatarDataUrls, PullFileSide } from '@shared/github-pull-detail'
import { pullWebUrl } from '@shared/pull-node'
import { TextDiff } from '../../editor/TextDiff'
import { ChatCopyButton } from '../ChatCopyButton'
import { Avatar } from './Avatar'
import { FILE_STATUS_TEXT, UNAVAILABLE_TEXT } from './PullFilesTab'
import { readState, STALE_TEXT, usePullRead, type ViewProps } from './shared'

const dayOf = (at: string): string =>
  new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** Runs of commits made on one local day, in list order (oldest first), as GitHub groups them. */
export function commitDays(commits: readonly PullCommit[]): Array<{ day: string; commits: PullCommit[] }> {
  const days: Array<{ day: string; commits: PullCommit[] }> = []
  for (const commit of commits) {
    const day = dayOf(commit.committedAt)
    if (days.at(-1)?.day === day) days.at(-1)!.commits.push(commit)
    else days.push({ day, commits: [commit] })
  }
  return days
}

/** The Commits tab: the PR's commits by day; a click opens that commit's own diff in place. */
export function PullCommitsTab(props: ViewProps): React.JSX.Element {
  const { api, pull, onOpenExternal } = props
  const result = usePullRead(api.pullCommits, props)
  // ponytail: the open commit is view state only; a restart opens the list again.
  const [open, setOpen] = useState<string | null>(null)
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const commit = result.commits.find((item) => item.oid === open)
  if (commit) {
    return <PullCommitDiff {...props} commit={commit} avatars={result.avatarDataUrls} onBack={() => setOpen(null)} />
  }
  return (
    <div className="pull-commits">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.commits.length === 0 && <p className="pull-node__empty">No commits.</p>}
      {commitDays(result.commits).map(({ day, commits }) => (
        <section key={day} className="pull-commits__day">
          <h3 className="pull-commits__date">Commits on {day}</h3>
          <ul className="pull-commits__list">
            {commits.map((item) => (
              <li key={item.oid}>
                <PullCommitRow commit={item} avatars={result.avatarDataUrls} onOpen={() => setOpen(item.oid)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {result.truncated && (
        <p className="pull-files__truncated">
          Showing the first {result.commits.length} commits only.{' '}
          <button className="pull-node__web" onClick={() => onOpenExternal(`${pullWebUrl(pull.repository, pull.pullNumber)}/commits`)}>
            Open on GitHub
          </button> for the rest.
        </p>
      )}
    </div>
  )
}

function PullCommitRow({ commit, avatars, onOpen }: {
  commit: PullCommit; avatars?: PullAvatarDataUrls; onOpen?: () => void
}): React.JSX.Element {
  const name = commit.author?.login ?? (commit.authorName || 'unknown')
  return (
    <div className="pull-commits__row">
      {/* ponytail: an unlinked git author gets a stand-in user (id 0 has no avatar), so its letter is the name's. */}
      <Avatar user={commit.author ?? { id: 0, login: name, avatarUrl: '' }} avatars={avatars} />
      {onOpen
        ? <button className="pull-commits__headline" onClick={onOpen}>{commit.headline}</button>
        : <span className="pull-commits__headline">{commit.headline}</span>}
      <span className="pull-commits__author">{name}</span>
      {commit.verified && <span className="pull-commits__verified" title="GitHub verified this commit's signature">Verified</span>}
      <code className="pull-commits__sha">{commit.oid.slice(0, 7)}</code>
      <ChatCopyButton text={() => commit.oid} label={`Copy the full SHA of ${commit.oid.slice(0, 7)}`} title="Copy full SHA" />
    </div>
  )
}

/** One commit's own diff: the files it changed, then the picked one (the first by default) against
 *  the commit's first parent. Read-only: line comments belong to the Files changed tab. */
function PullCommitDiff(props: ViewProps & { commit: PullCommit; avatars?: PullAvatarDataUrls; onBack: () => void }): React.JSX.Element {
  const { api, pull, commit, avatars, onBack, onOpenExternal } = props
  const sha = commit.oid
  const [picked, setPicked] = useState<string | null>(null)
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) => api.pullCommitFiles(projectId, repository, pullNumber, sha),
    [api, sha]
  )
  const result = usePullRead(read, props)
  const commitUrl = `${pullWebUrl(pull.repository, pull.pullNumber)}/commits/${sha}`
  const head = (
    <div className="pull-commits__open">
      <button className="pull-node__web" onClick={onBack}>← All commits</button>
      <PullCommitRow commit={commit} avatars={avatars} />
    </div>
  )
  if (result === 'loading' || result.status !== 'ok') return <>{head}{readState(result, pull.repository)}</>
  const shown = result.files.find((file) => file.path === picked) ?? result.files[0]
  return (
    <div className="pull-files">
      {head}
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.files.length === 0
        ? <p className="pull-node__empty">This commit changes no files.</p>
        : (
          <ul className="pull-files__list">
            {result.files.map((file) => (
              <li key={file.path}>
                <button className="pull-files__file" aria-current={file === shown ? 'true' : undefined} onClick={() => setPicked(file.path)}>
                  <span className={`pull-files__status pull-files__status--${file.status}`}>{FILE_STATUS_TEXT[file.status]}</span>
                  <span className="pull-files__path">{file.previousPath && <>{file.previousPath} → </>}{file.path}</span>
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
          <button className="pull-node__web" onClick={() => onOpenExternal(commitUrl)}>Open on GitHub</button> for the rest.
        </p>
      )}
      {shown && <PullCommitFileDiff key={shown.path} {...props} path={shown.path} commitUrl={commitUrl} />}
    </div>
  )
}

const sideText = (side: PullFileSide): string => side.kind === 'text' ? side.text : ''

function PullCommitFileDiff(props: ViewProps & { commit: PullCommit; path: string; commitUrl: string }): React.JSX.Element {
  const { api, pull, commit, path, commitUrl, onOpenExternal } = props
  const sha = commit.oid
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) =>
      api.pullCommitFileContents(projectId, repository, pullNumber, sha, path),
    [api, sha, path]
  )
  const result = usePullRead(read, props)
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const { contents } = result
  if (contents.kind === 'unavailable') {
    return (
      <p className="pull-files__unavailable" role="status">
        {UNAVAILABLE_TEXT[contents.reason]}{' '}
        <button className="pull-node__web" onClick={() => onOpenExternal(commitUrl)}>Open on GitHub</button>
      </p>
    )
  }
  return (
    <>
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      <TextDiff className="pull-files__diff" path={path} original={sideText(contents.base)} modified={sideText(contents.head)} />
    </>
  )
}
