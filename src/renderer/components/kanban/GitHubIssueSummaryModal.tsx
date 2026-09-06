import { useEffect, useRef } from 'react'
import type { GitHubIssueCardView } from '@shared/github-issues'
import type { KanbanColumn } from '@shared/types'
import { useSession } from '../../session/session'
import { Button } from '@renderer/ui/Button'
import { Select } from '@renderer/ui/Select'

export function GitHubIssueSummaryModal({
  issue,
  columns,
  moving,
  readOnly,
  status,
  kind = 'issue',
  onMove,
  onClose
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
}): React.JSX.Element {
  const isPull = kind === 'pull'
  const { api } = useSession()
  const close = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    close.current?.focus()
    return () => opener.current?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
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
          <Button onClick={() => void api.shell.openExternal(issue.htmlUrl)}>Open on GitHub</Button>
        </div>
        {!isPull && issue.conflict && (
          <p className="github-issue-modal__warning">
            This issue has conflicting mapped labels. Choose a column to replace them with one exact label.
          </p>
        )}
        {status && <p className="github-issue-modal__warning" role="status">{status}</p>}
        <div className="github-issue-modal__body">
          {issue.body.trim() || 'No description provided.'}
        </div>
      </section>
    </div>
  )
}
