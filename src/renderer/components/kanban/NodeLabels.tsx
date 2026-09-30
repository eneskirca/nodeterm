import { useMemo, useState, type ReactNode } from 'react'
import type { ProjectKanban } from '@shared/types'
import { useProjects } from '../../state/projects'
import { markWorkspaceDirty } from '../../state/workspaceDirty'
import { defaultKanban, labelsForCard } from '../../lib/kanban'
import { LabelChips } from './LabelChips'
import { LabelPicker } from './LabelPicker'

/**
 * The canvas node's label row — the SAME board labels as the kanban card (unified: a node's
 * "tags" are now board labels). Shows the colored chips and a "+" that opens the Notion picker to
 * create/assign/edit labels. Edits go to the active project's kanban and persist via the shared
 * workspace-dirty seam (this component lives outside Canvas). A node only ever renders in the
 * active project, so the active project's board is the right one.
 *
 * `trailing` is an optional slot at the row's RIGHT end (the terminal node's ⌘M hint). It is a
 * slot rather than something the caller positions over the row, so the row's own flex layout owns
 * the placement — and that layout guarantees the slot can never add a line or move a chip: it only
 * occupies width the chips left unused, clipped to it (see `.term-node__labeltrail`).
 */
export function NodeLabels({ nodeId, trailing }: { nodeId: string; trailing?: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const kanban = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId)?.kanban)
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // Adding the first label seeds the default board (To Do / In Progress / Done), exactly like the
  // board's own lazy default — so a node-side label add never leaves an empty column-less board.
  // The SAME board, ids included: the lazy default is deterministic per project.
  const board = useMemo(() => kanban ?? defaultKanban(activeProjectId ?? ''), [kanban, activeProjectId])
  const labels = labelsForCard(board, nodeId)

  const commit = (next: ProjectKanban): void => {
    const pid = useProjects.getState().activeProjectId
    if (!pid) return
    useProjects.getState().setProjectKanban(pid, next)
    markWorkspaceDirty()
  }

  return (
    <div className="term-node__labelrow nodrag">
      {/* The chips + "+ Label" wrap inside their OWN group; the row never wraps. That is what
          keeps the trailing slot out of the wrap flow — see `.term-node__labeltrail`. */}
      <div className="term-node__labelmain">
        <LabelChips labels={labels} size="sm" />
        <button
          className="term-node__labeladd"
          title="Add label"
          onClick={() => setOpen((v) => !v)}
        >
          + Label
        </button>
      </div>
      {trailing != null && <span className="term-node__labeltrail">{trailing}</span>}
      {open && (
        <>
          <div className="label-picker__scrim" onMouseDown={() => setOpen(false)} />
          <div className="label-picker__pop">
            <LabelPicker board={board} nodeId={nodeId} onChange={commit} />
          </div>
        </>
      )}
    </div>
  )
}
