import { useEffect, useRef, useState } from 'react'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type {
  GitHubPullChecksResult,
  GitHubPullStatus,
  PullStatusFreshness
} from '@shared/github-pull-status'
import { PullRefChip, PullStatusLine } from './PullStatusBadges'
import type { KanbanColumn } from '@shared/types'
import { issueLogId, issueRefFromHtmlUrl } from '@shared/github-issue-ref'
import { useSession } from '../../session/session'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'
import { ContextMenu, type MenuItem } from '../ContextMenu'
import { openDialogCount } from '../dialog-stack'
import { NO_ISSUE_RUNS, type IssueRun } from '../../lib/issueRuns'
import { IssueRunChips } from './IssueRunChips'
import { BoardLogPanel } from './BoardLogPanel'
import { ISSUE_WORKTREE_BUTTON_LABEL, type IssueWorktreeMenuAnswer } from '../../lib/issueWorktree'

export function GitHubIssueSummaryModal({
  issue,
  columns,
  moving,
  readOnly,
  status,
  kind = 'issue',
  onMove,
  onClose,
  projectId,
  pullStatus,
  closingPulls = [],
  pullFreshness = 'fresh',
  pullObservedAt,
  startMenu,
  worktreeMenu,
  runs = NO_ISSUE_RUNS,
  onOpenRun,
  showRunHistory = false
}: {
  issue: GitHubIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  readOnly: boolean
  status?: string
  /** A pull request is read-only on the board, so its variant drops the Move control and the
   *  conflict hint — both name a write only an issue has. */
  kind?: 'issue' | 'pull'
  onMove: (columnId: string | null) => void
  onClose: () => void
  /** Needed to fetch a PR's check detail; absent = no detail section. */
  projectId?: string
  /** Pull kind: the PR's CI/merge state. Issue kind: unused. */
  pullStatus?: GitHubPullStatus
  /** Issue kind: open PRs that close this issue on merge. */
  closingPulls?: GitHubPullStatus[]
  pullFreshness?: PullStatusFreshness
  pullObservedAt?: number
  /** The "Start with agent ▸" rows (the canvas's own agent + account picker, pointed at this
   *  issue). Absent = no button — a pull request, or a board with no canvas behind it. */
  startMenu?: () => MenuItem[]
  /** "Start with agent in a new worktree": the same picker pointed at a fresh worktree frame, or
   *  the reason it cannot run here (the button is then DISABLED and says why). Absent = no button. */
  worktreeMenu?: () => IssueWorktreeMenuAnswer
  /** Sessions already working on this issue — the same live chips the card shows. */
  runs?: readonly IssueRun[]
  onOpenRun?: (nodeId: string) => void
  /** Show the issue card's read-only run history (its board-log feed). */
  showRunHistory?: boolean
}): React.JSX.Element {
  const isPull = kind === 'pull'
  const { api } = useSession()
  const [startAt, setStartAt] = useState<{ x: number; y: number } | null>(null)
  // The worktree picker's rows are built at the click that opens them, like the canvas menus: they
  // describe the canvas as it is then.
  const [worktreeAt, setWorktreeAt] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  // Read at render: whether the project can take a worktree does not change while the modal is up
  // without a re-render (a project switch unmounts the board).
  const worktreeAnswer = !isPull && worktreeMenu ? worktreeMenu() : undefined
  const worktreeRefusal = worktreeAnswer && 'refusal' in worktreeAnswer ? worktreeAnswer.refusal : undefined
  // The run history is filed under the issue card's synthetic board-log id. No id (a card whose
  // URL did not parse) = no history panel, rather than a panel keyed on something made up.
  const logId = !isPull && showRunHistory
    ? issueLogId(issueRefFromHtmlUrl(issue.htmlUrl, issue.number))
    : undefined
  const pullOpen = isPull && issue.state === 'open'
  const checks = usePullChecks(api.githubIssues, pullOpen ? projectId : undefined, issue.number,
    pullStatus?.headRefOid)
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    close.current?.focus()
    return () => opener.current?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // A dialog stacked over this modal (the close/reopen confirm, the worktree reuse-or-new
      // choice) owns its own Escape: closing the modal underneath it too took two answers for one key.
      if (event.key === 'Escape' && openDialogCount() === 0) onClose()
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )]
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="kanban-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="github-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-issue-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="github-issue-modal__header">
          <div>
            <div className="github-issue-modal__eyebrow">
              GitHub {isPull ? 'pull request' : 'issue'} #{issue.number}
            </div>
            <h2 id="github-issue-modal-title">{issue.title}</h2>
          </div>
          <button ref={close} className="github-issue-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="github-issue-modal__actions">
          {!isPull && (
            <label>
              <span>Move to</span>
              <Select
                aria-label={`Move issue #${issue.number}`}
                value={issue.columnId ?? ''}
                disabled={moving || readOnly}
                onChange={(event) => onMove(event.target.value || null)}
              >
                <option value="">Ungrouped</option>
                {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
              </Select>
            </label>
          )}
          {!isPull && startMenu && (
            <Button
              aria-haspopup="menu"
              onClick={(event) => {
                const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setStartAt({ x: r.left, y: r.bottom + 4 })
              }}
            >
              Start with agent ▾
            </Button>
          )}
          {worktreeAnswer && (
            <Button
              aria-haspopup="menu"
              disabled={!!worktreeRefusal}
              title={worktreeRefusal}
              onClick={(event) => {
                const answer = worktreeMenu?.()
                if (!answer || 'refusal' in answer) return
                const r = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setWorktreeAt({ x: r.left, y: r.bottom + 4, items: answer.items })
              }}
            >
              {ISSUE_WORKTREE_BUTTON_LABEL} ▾
            </Button>
          )}
          <Button onClick={() => void api.shell.openExternal(issue.htmlUrl)}>Open on GitHub</Button>
        </div>
        {!isPull && onOpenRun && runs.length > 0 && (
          <div className="github-issue-modal__runs">
            <IssueRunChips runs={runs} onOpen={onOpenRun} />
          </div>
        )}
        {!isPull && issue.conflict && (
          <p className="github-issue-modal__warning">
            This issue has conflicting mapped labels. Choose a column to replace them with one exact label.
          </p>
        )}
        {status && <p className="github-issue-modal__warning" role="status">{status}</p>}
        {isPull && pullOpen && (
          <PullStatusLine status={pullStatus} freshness={pullFreshness} observedAt={pullObservedAt} />
        )}
        {isPull && pullStatus && pullStatus.closes.length > 0 && (
          <p className="pull-closes">Closes {pullStatus.closes.map((number) => `#${number}`).join(', ')}</p>
        )}
        {!isPull && closingPulls.length > 0 && (
          <div className="pull-refs">
            {closingPulls.map((pull) => <PullRefChip key={pull.number} status={pull} freshness={pullFreshness} />)}
          </div>
        )}
        {isPull && pullOpen && (
          <PullChecks
            result={checks}
            expectedHead={pullStatus?.headRefOid}
            onOpen={(url) => void api.shell.openExternal(url)}
          />
        )}
        <div className="github-issue-modal__body">
          {issue.body.trim() || 'No description provided.'}
        </div>
        {logId && (
          <div className="github-issue-modal__history">
            <BoardLogPanel
              card={{ id: logId }}
              title="Agent runs"
              readOnly
              emptyText="No agent has worked on this issue from this project yet. This history stays in the project's board log and is never posted to GitHub."
            />
          </div>
        )}
        {startAt && startMenu && (
          <ContextMenu
            x={startAt.x}
            y={startAt.y}
            zIndex={60}
            items={startMenu()}
            onClose={() => setStartAt(null)}
          />
        )}
        {worktreeAt && (
          <ContextMenu
            x={worktreeAt.x}
            y={worktreeAt.y}
            zIndex={60}
            items={worktreeAt.items}
            onClose={() => setWorktreeAt(null)}
          />
        )}
      </section>
    </div>
  )
}

/** Per-check detail for an open PR, read once when its modal opens (and again if its head moves). */
function usePullChecks(
  api: { pullChecks: (projectId: string, pullNumber: number) => Promise<GitHubPullChecksResult> },
  projectId: string | undefined,
  pullNumber: number,
  headRefOid: string | undefined
): GitHubPullChecksResult | 'loading' | null {
  const [result, setResult] = useState<GitHubPullChecksResult | 'loading' | null>(null)
  useEffect(() => {
    if (!projectId) {
      setResult(null)
      return
    }
    let live = true
    setResult('loading')
    api.pullChecks(projectId, pullNumber)
      .then((value) => { if (live) setResult(value) })
      .catch(() => { if (live) setResult({ status: 'unavailable' }) })
    return () => { live = false }
  }, [api, projectId, pullNumber, headRefOid])
  return result
}

const CHECK_GLYPH = { passed: '✓', failed: '✗', pending: '●', skipped: '–', neutral: '○' } as const

/** The checks list. A token that may not read checks (`hidden`) shows NOTHING, and a commit with no
 *  checks says so in words — never a green tick for checks that do not exist. */
export function PullChecks({
  result,
  expectedHead,
  onOpen
}: {
  result: GitHubPullChecksResult | 'loading' | null
  /** The head the status line above describes. Checks read at another commit are not shown under
   *  it (the host may answer from a read taken a few seconds before a push). */
  expectedHead?: string
  onOpen: (url: string) => void
}): React.JSX.Element | null {
  if (result === null || (result !== 'loading' && result.status === 'hidden')) return null
  if (result === 'loading') return <p className="pull-checks__note">Loading checks…</p>
  if (result.status === 'no-checks') return <p className="pull-checks__note">No checks on the head commit.</p>
  if (result.status === 'moved' || (result.status === 'ok' && expectedHead && result.headRefOid !== expectedHead)) return <p className="pull-checks__note">The branch moved while reading its checks. Reopen to see the new commit's.</p>
  if (result.status === 'unavailable') return <p className="pull-checks__note">Checks could not be read from GitHub.</p>
  return (
    <ul className="pull-checks" aria-label="Checks">
      {result.checks.map((check, index) => (
        <li key={`${check.name}:${index}`} className={`pull-checks__row pull-checks__row--${check.state}`}>
          <span className={`pull-status__ci--${check.state}`} aria-hidden="true">{CHECK_GLYPH[check.state]}</span>
          {check.url
            ? <button className="pull-checks__name" onClick={() => onOpen(check.url!)}>{check.name}</button>
            : <span className="pull-checks__name">{check.name}</span>}
          <span className="pull-checks__state">{check.state}</span>
        </li>
      ))}
      {result.truncated && <li className="pull-checks__note">More checks on GitHub.</li>}
    </ul>
  )
}
