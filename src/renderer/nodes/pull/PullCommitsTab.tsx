import { useCallback, useState } from 'react'
import type { PullCommit } from '@shared/github-pull-commits'
import type { PullAvatarDataUrls, PullFileSide } from '@shared/github-pull-detail'
import { pullWebUrl } from '@shared/pull-node'
import { TextDiff } from '../../editor/TextDiff'
import { relativeTime } from '../../lib/relativeTime'
import { ChatCopyButton } from '../ChatCopyButton'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { UNAVAILABLE_TEXT } from './PullFilesTab'
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

const CI_ICON = { passed: 'check', failed: 'x', pending: 'sync' } as const
const CI_TEXT = { passed: 'Checks passed', failed: 'Checks failed', pending: 'Checks running' } as const
// ponytail: an agent co-author is told apart by name only, which is how its trailer names it.
const AGENT_NAME = /^(claude|codex|copilot|gemini|cursor|grok|opencode)\b/i

/** "a", "a and b", "a, b and c". */
function Authors({ names }: { names: string[] }): React.JSX.Element {
  return (
    <>
      {names.map((name, i) => (
        <span key={`${name}:${i}`}>
          {i > 0 && (i === names.length - 1 ? ' and ' : ', ')}
          <span className={AGENT_NAME.test(name) ? 'pr-commits__agent' : undefined}>{name}</span>
        </span>
      ))}
    </>
  )
}

/** The Commits tab (F3): the PR's commits by day; a click opens that commit's own diff below the list. */
export function PullCommitsTab(props: ViewProps): React.JSX.Element {
  const { api, pull, onOpenExternal } = props
  const result = usePullRead(api.pullCommits, props)
  // ponytail: the open commit is view state only; a restart opens the list again.
  const [open, setOpen] = useState<string | null>(null)
  if (result === 'loading' || result.status !== 'ok') return readState(result, pull.repository)
  const commit = result.commits.find((item) => item.oid === open)
  return (
    <div className="pr-commits">
      {result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {result.commits.length === 0 && <p className="pull-node__empty">No commits.</p>}
      {commitDays(result.commits).map(({ day, commits }) => (
        <section key={day} className="pr-commits__group">
          <h3 className="pr-commits__day"><Icon name="commit" size={14} />Commits on {day}</h3>
          <ul className="pr-commits__list">
            {commits.map((item) => (
              <li key={item.oid}>
                <PullCommitRow commit={item} avatars={result.avatarDataUrls} selected={item.oid === open}
                  onOpen={() => setOpen(item.oid === open ? null : item.oid)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {commit && <PullCommitDiff key={commit.oid} {...props} commit={commit} onBack={() => setOpen(null)} />}
      {result.truncated && (
        <p className="pr-commits__note">
          Showing the first {result.commits.length} commits only.{' '}
          <button className="pull-node__web" onClick={() => onOpenExternal(`${pullWebUrl(pull.repository, pull.pullNumber)}/commits`)}>
            Open on GitHub
          </button> for the rest.
        </p>
      )}
    </div>
  )
}

function PullCommitRow({ commit, avatars, selected, onOpen }: {
  commit: PullCommit; avatars?: PullAvatarDataUrls; selected: boolean; onOpen: () => void
}): React.JSX.Element {
  const name = commit.author?.login ?? (commit.authorName || 'unknown')
  const short = commit.oid.slice(0, 7)
  const at = Date.parse(commit.committedAt)
  return (
    // The whole row opens the diff (GitHub's own list does); its buttons keep their own click.
    <div className={selected ? 'pr-commits__row pr-commits__row--selected' : 'pr-commits__row'}
      onClick={(event) => { if (!(event.target as Element).closest('button, a')) onOpen() }}>
      {/* ponytail: an unlinked git author gets a stand-in user (id 0 has no avatar), so its letter is the name's. */}
      <Avatar user={commit.author ?? { id: 0, login: name, avatarUrl: '' }} avatars={avatars} size={24} />
      <span className="pr-commits__main">
        <button className="pr-commits__headline" aria-expanded={selected} onClick={onOpen}>{commit.headline}</button>
        <span className="pr-commits__meta">
          <span className="pr-commits__author"><Authors names={[name, ...(commit.coAuthors ?? [])]} /></span>
          {Number.isFinite(at) && <> · {relativeTime(at, Date.now())}</>}
        </span>
      </span>
      <span className="pr-commits__end">
        {commit.verified && <span className="pr-commits__verified" title="GitHub verified this commit's signature">Verified</span>}
        {commit.ci && <Icon name={CI_ICON[commit.ci]} size={14} className={`pr-commits__ci pr-commits__ci--${commit.ci}`} label={CI_TEXT[commit.ci]} />}
        <button className="pr-commits__sha" title={`Show the changes of ${short}`} onClick={onOpen}><code>{short}</code></button>
        <ChatCopyButton text={() => commit.oid} label={`Copy the full SHA of ${short}`} title="Copy full SHA" />
      </span>
    </div>
  )
}

/** One commit's own diff, under the list: the files it changed, then the picked one (the first by
 *  default) against the commit's first parent. Read-only: line comments belong to the Files tab. */
function PullCommitDiff(props: ViewProps & { commit: PullCommit; onBack: () => void }): React.JSX.Element {
  const { api, pull, commit, onBack, onOpenExternal } = props
  const sha = commit.oid
  const [picked, setPicked] = useState<string | null>(null)
  const read = useCallback(
    (projectId: string, repository: string, pullNumber: number) => api.pullCommitFiles(projectId, repository, pullNumber, sha),
    [api, sha]
  )
  const result = usePullRead(read, props)
  const commitUrl = `${pullWebUrl(pull.repository, pull.pullNumber)}/commits/${sha}`
  const files = result !== 'loading' && result.status === 'ok' ? result.files : undefined
  const shown = files?.find((file) => file.path === picked) ?? files?.[0]
  return (
    <div className="pr-commits__diff" aria-label={`Changes of ${sha.slice(0, 7)}`}>
      <div className="pr-commits__diff-head">
        <button className="pr-btn" onClick={onBack}>All commits</button>
        <span className="pr-commits__muted">
          Showing {sha.slice(0, 7)}{files && ` · ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
        </span>
      </div>
      {(result === 'loading' || result.status !== 'ok') && readState(result, pull.repository)}
      {result !== 'loading' && result.status === 'ok' && result.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[result.stale]}</p>}
      {files?.length === 0 && <p className="pull-node__empty">This commit changes no files.</p>}
      {files && files.length > 0 && (
        <ul className="pr-commits__files">
          {files.map((file) => (
            <li key={file.path}>
              <button className="pr-commits__file" aria-current={file === shown ? 'true' : undefined} onClick={() => setPicked(file.path)}>
                <span className="pr-commits__path">{file.previousPath && <>{file.previousPath} → </>}{file.path}</span>
                <span className="pr-commits__add">+{file.additions}</span>
                <span className="pr-commits__del">−{file.deletions}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {result !== 'loading' && result.status === 'ok' && result.truncated && (
        <p className="pr-commits__note">
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
