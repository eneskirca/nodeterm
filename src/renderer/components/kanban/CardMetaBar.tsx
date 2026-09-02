import { useMemo, useState } from 'react'
import type { BoardLogAuthor, BoardLogEvent, KanbanPriority, ProjectKanban } from '@shared/types'
import type { GitHubLink } from '@shared/github-issues'
import { githubLinkUrl } from '@shared/github-link'
import { linkToBoardTitle, removeLink } from '../../lib/githubLinks'
import { cardMeta, labelsForCard, setCardDue, setCardPriority, toggleAssignee } from '../../lib/kanban'
import { LabelChips } from './LabelChips'
import { LabelPicker } from './LabelPicker'
import { useShallow } from 'zustand/react/shallow'
import { loadIdentity, selectFaces, usePresence } from '../../state/presence'
import { useBoardLog } from '../../state/boardLog'
import { useProjects } from '../../state/projects'

const initialOf = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

export const PRIORITIES: Array<{ id: KanbanPriority; label: string; color: string }> = [
  { id: 'low', label: 'Low', color: '#8e8e93' },
  { id: 'medium', label: 'Medium', color: '#ffd60a' },
  { id: 'high', label: 'High', color: '#ff9f0a' },
  { id: 'urgent', label: 'Urgent', color: '#ff453a' }
]

/** Local-wallclock value for a datetime-local input (its value is timezone-less). */
function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

interface CardMetaBarProps {
  nodeId: string
  board: ProjectKanban
  onChange: (next: ProjectKanban) => void
  /** This node's GitHub links, and the write-back for the × on each row. */
  links: GitHubLink[]
  onChangeLinks: (next: GitHubLink[] | undefined, event?: BoardLogEvent) => void
  /** Opens the board's attach picker anchored at the button. Absent repository = no group at all. */
  onAttachLink: (anchor: { x: number; y: number }) => void
  githubRepository?: string
}

/** Trello-style Members / Due date strip under the modal header. The assignable pool is
 *  everyone the session can NAME: me (presence identity), live presence peers, and every
 *  author already seen in the board log — no separate membership system. */
export function CardMetaBar({
  nodeId, board, onChange, links, onChangeLinks, onAttachLink, githubRepository
}: CardMetaBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const meta = cardMeta(board, nodeId)
  const labels = labelsForCard(board, nodeId)
  const projectId = useProjects((s) => s.activeProjectId)
  const logEntries = useBoardLog((s) => s.entriesFor(projectId))
  // selectFaces + useShallow, NOT selectOthers: the pool only needs name+color, and applyDiff
  // replaces the whole PeerState on every cursor patch (~20/s per peer) — subscribing to
  // PeerState re-rendered the open card modal at cursor rate. Faces are cursor-immune.
  const peers = usePresence(useShallow(selectFaces))

  const pool = useMemo(() => {
    const seen = new Map<string, BoardLogAuthor>()
    const add = (a: { name?: string; color?: string } | null | undefined): void => {
      if (a?.name && a.color && !seen.has(a.name)) seen.set(a.name, { name: a.name, color: a.color })
    }
    add(loadIdentity() ?? { name: 'you', color: '#8e8e93' })
    for (const p of peers) add(p)
    for (const e of logEntries) add(e.author)
    return [...seen.values()]
  }, [peers, logEntries])

  const assignees = meta?.assignees ?? []
  const due = meta?.dueAt
  const overdue = due !== undefined && due < Date.now()
  const priority = meta?.priority

  return (
    <div className="kanban-meta">
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Members</span>
        <div className="kanban-meta__row">
          {assignees.map((a) => (
            <button
              key={a.name}
              className="kanban-avatar"
              style={{ background: a.color }}
              title={`${a.name} — click to unassign`}
              onClick={() => onChange(toggleAssignee(board, nodeId, a))}
            >
              {initialOf(a.name)}
            </button>
          ))}
          <button
            className="kanban-avatar kanban-avatar--add"
            title="Assign a member"
            onClick={() => setPickerOpen((v) => !v)}
          >
            +
          </button>
          {pickerOpen && (
            <div className="kanban-meta__picker">
              {pool.map((p) => {
                const on = assignees.some((a) => a.name === p.name)
                return (
                  <button key={p.name} onClick={() => onChange(toggleAssignee(board, nodeId, p))}>
                    <span className="kanban-avatar" style={{ background: p.color }}>
                      {initialOf(p.name)}
                    </span>
                    <span className="kanban-meta__pname">{p.name}</span>
                    {on && <span className="kanban-meta__check">✓</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Labels</span>
        <div className="kanban-meta__row kanban-meta__row--labels">
          <LabelChips labels={labels} size="md" />
          <button
            className="kanban-avatar kanban-avatar--add"
            title="Add label"
            onClick={() => setLabelsOpen((v) => !v)}
          >
            +
          </button>
          {labelsOpen && (
            <>
              <div className="label-picker__scrim" onMouseDown={() => setLabelsOpen(false)} />
              <div className="label-picker__pop">
                <LabelPicker board={board} nodeId={nodeId} onChange={onChange} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Due date</span>
        <div className="kanban-meta__row">
          <input
            type="datetime-local"
            className="kanban-meta__due"
            value={due !== undefined ? toLocalInput(due) : ''}
            onChange={(e) =>
              onChange(
                setCardDue(board, nodeId, e.target.value ? new Date(e.target.value).getTime() : null)
              )
            }
          />
          {overdue && <span className="kanban-due kanban-due--overdue">Overdue</span>}
          {due !== undefined && (
            <button
              className="kanban-meta__clear"
              title="Clear due date"
              onClick={() => onChange(setCardDue(board, nodeId, null))}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {githubRepository && (
        <div className="kanban-meta__group">
          <span className="kanban-meta__label">GitHub</span>
          <div className="kanban-meta__row">
            {links.map((link) => (
              <span key={`${link.kind}#${link.number}`} className="kanban-meta__ghlink">
                <a
                  href={githubLinkUrl(githubRepository, link)}
                  onClick={(event) => {
                    event.preventDefault()
                    window.nodeTerminal.shell.openExternal(githubLinkUrl(githubRepository, link))
                  }}
                >
                  {linkToBoardTitle(link)}
                </a>
                <button
                  className="kanban-meta__clear"
                  title={`Detach #${link.number}`}
                  onClick={() =>
                    onChangeLinks(removeLink(links, link), {
                      type: 'github-detached',
                      to: link.kind,
                      title: linkToBoardTitle(link)
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              className="kanban-avatar kanban-avatar--add"
              title="Attach an issue or pull request"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                onAttachLink({ x: rect.left, y: rect.bottom + 4 })
              }}
            >
              +
            </button>
          </div>
        </div>
      )}
      <div className="kanban-meta__group">
        <span className="kanban-meta__label">Priority</span>
        <div className="kanban-meta__row">
          {PRIORITIES.map((pr) => (
            <button
              key={pr.id}
              className={`kanban-prio${priority === pr.id ? ' kanban-prio--on' : ''}`}
              style={priority === pr.id ? { background: `${pr.color}2e`, borderColor: pr.color, color: pr.color } : undefined}
              title={priority === pr.id ? `${pr.label} — click to clear` : pr.label}
              onClick={() => onChange(setCardPriority(board, nodeId, priority === pr.id ? null : pr.id))}
            >
              {pr.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
