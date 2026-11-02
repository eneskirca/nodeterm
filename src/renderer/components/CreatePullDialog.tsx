import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitApi } from '@shared/types'
import type { GitHubIssuesApi } from '@shared/github-issues'
import { MAX_PULL_COMMENT_BODY, MAX_PULL_TITLE, isPullBranchName } from '@shared/github-pull-detail'
import { errorText } from '@shared/error-text'
import { createPullText, pullDraftFromCommits, pullStartText } from '../lib/newPull'

interface CreatePullDialogProps {
  api: { git: GitApi; githubIssues: GitHubIssuesApi }
  projectId: string
  /** The project's approved repository (`owner/name`). */
  repository: string
  /** The checkout whose current branch becomes the PR's head: the project folder or a worktree. */
  cwd: string
  /** The PR to open as a node: the one just created, or the branch's PR that was already open. */
  onOpen: (pullNumber: number) => void
  onClose: () => void
}

type Ready = { branch: string; needsPush: boolean }

/**
 * "New pull request": base (the default branch), title and body (from the branch's commits), and a
 * draft toggle. A branch with commits the remote lacks is pushed first ("Push and create") through
 * the Source Control panel's own push. Every write here runs on a click in this dialog only.
 */
export function CreatePullDialog({ api, projectId, repository, cwd, onOpen, onClose }: CreatePullDialogProps) {
  const [ready, setReady] = useState<Ready | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [base, setBase] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const status = await api.git.status(cwd).catch(() => null)
      if (!live) return
      if (!status?.hasRepo || !isPullBranchName(status.branch) || status.branch === 'HEAD') {
        setError('Switch this checkout to a branch first.')
        return
      }
      const start = await api.githubIssues.pullForBranch(projectId, repository, status.branch)
        .catch(() => ({ status: 'failed' as const, reason: 'unreachable' as const }))
      if (!live) return
      if (start.status !== 'ok') {
        setError(pullStartText(start.reason))
        return
      }
      // The branch already has an open PR: open that one instead of a form.
      if (start.existing) {
        onOpen(start.existing)
        return
      }
      const history = await api.git.history(cwd, { limit: 30, baseRef: `origin/${start.defaultBranch}` }).catch(() => null)
      if (!live) return
      const prefill = pullDraftFromCommits(history?.items ?? [], start.defaultBranch, status.branch)
      setBase(start.defaultBranch)
      setTitle(prefill.title)
      setBody(prefill.body.slice(0, MAX_PULL_COMMENT_BODY))
      setReady({ branch: status.branch, needsPush: !status.hasUpstream || status.ahead > 0 })
    })()
    return () => {
      live = false
    }
    // Read once per open; the dialog is mounted per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const valid = !!ready && isPullBranchName(base.trim()) && base.trim() !== ready.branch && title.trim().length > 0
  const submit = async (): Promise<void> => {
    if (!ready || !valid || busy) return
    setBusy(true)
    setError(null)
    if (ready.needsPush) {
      const pushed = await api.git.push(cwd).catch((e: unknown) => ({ ok: false, message: errorText(e) }))
      if (!pushed.ok) {
        setBusy(false)
        setError(`Push failed: ${pushed.message}`)
        return
      }
      setReady({ ...ready, needsPush: false })
    }
    const result = await api.githubIssues.createPull({
      projectId, repository, head: ready.branch, base: base.trim(), title: title.trim(), body, draft
    }).catch(() => ({ ok: false as const, reason: 'network' as const }))
    setBusy(false)
    if (result.ok) onOpen(result.pullNumber)
    else setError(createPullText(result.reason))
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="confirm" role="dialog" aria-label="New pull request" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">
          {ready ? `New pull request on ${repository} from ${ready.branch}` : error ? '' : 'Reading the branch…'}
        </p>
        {ready && (
          <>
            <input
              className="confirm__input"
              aria-label="Base branch"
              placeholder="Base branch"
              spellCheck={false}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
            <input
              className="confirm__input"
              aria-label="Title"
              placeholder="Title"
              maxLength={MAX_PULL_TITLE}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="confirm__input confirm__textarea"
              aria-label="Description"
              placeholder="Description"
              maxLength={MAX_PULL_COMMENT_BODY}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <label className="confirm__option">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Create as draft
            </label>
          </>
        )}
        {error && <p className="confirm__msg" role="alert">{error}</p>}
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={onClose}>Cancel</button>
          {ready && (
            <button className="confirm__btn primary" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? 'Working…' : ready.needsPush ? 'Push and create' : 'Create'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
