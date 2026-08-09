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
  onMove,
  onClose
}: {
  issue: GitHubIssueCardView
  columns: KanbanColumn[]
  moving: boolean
  onMove: (columnId: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const { api } = useSession()
  const close = useRef<HTMLButtonElement>(null)
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    close.current?.focus()
    return () => opener.current?.focus()
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="kanban-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="github-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-issue-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="github-issue-modal__header">
          <div>
            <div className="github-issue-modal__eyebrow">GitHub issue #{issue.number}</div>
            <h2 id="github-issue-modal-title">{issue.title}</h2>
          </div>
          <button ref={close} className="github-issue-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="github-issue-modal__actions">
          <label>
            <span>Move to</span>
            <Select
              aria-label={`Move issue #${issue.number}`}
              value={issue.columnId ?? ''}
              disabled={moving}
              onChange={(event) => onMove(event.target.value || null)}
            >
              <option value="">Ungrouped</option>
              {columns.map((column) => <option key={column.id} value={column.id}>{column.title}</option>)}
            </Select>
          </label>
          <Button onClick={() => void api.shell.openExternal(issue.htmlUrl)}>Open on GitHub</Button>
        </div>
        {issue.conflict && (
          <p className="github-issue-modal__warning">
            This issue has conflicting mapped labels. Choose a column to replace them with one exact label.
          </p>
        )}
        <div className="github-issue-modal__body">
          {issue.body.trim() || 'No description provided.'}
        </div>
      </section>
    </div>
  )
}
