import type { CanvasNodeState } from '@shared/types'
import { SYSTEM_NODE_COLORS } from '../state/workspace'
import type { KanbanSession } from '../components/kanban/KanbanView'
import type { ModalSpawn } from '../components/kanban/ModalTerminal'

/** First-line sticky title, same rule as `toKanbanSession` — markdown heading marker is presentation. */
function stickyTitle(text: string): string {
  return text.trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note'
}

/**
 * Persisted-state counterpart to `toKanbanSession` (which reads live React Flow `CanvasNode`s).
 * This reads `CanvasNodeState` from the projects store — the source for every *non-active*
 * project's lane in the global board. The two functions derive the SAME card shape and must
 * agree on titles, colors and sticky handling; they share the title helper and spawn shape.
 * Keep them in sync when adding fields — see `ModalSpawn`.
 */
export function toKanbanSessionState(n: CanvasNodeState): KanbanSession | null {
  if (n.kind === 'browser') {
    return {
      id: n.id,
      title: n.title || 'Browser',
      color: n.color ?? SYSTEM_NODE_COLORS[0],
      kind: 'browser',
      url: n.url,
      partition: n.partition,
      spawn: {} as ModalSpawn
    }
  }
  if (n.kind === 'sticky') {
    const txt = n.text ?? ''
    return {
      id: n.id,
      title: stickyTitle(txt),
      color: n.color ?? SYSTEM_NODE_COLORS[2],
      kind: 'sticky',
      text: txt,
      textUpdatedAt: n.textUpdatedAt,
      textUpdatedBy: n.textUpdatedBy,
      spawn: {} as ModalSpawn
    }
  }
  if (n.kind !== 'terminal') return null
  // pendingLaunch is the --after DAG launch — it must fire only when dependencies report done,
  // not when a card modal opens. Mapping it to initialCommand would fire it early. And
  // initialCommand itself is transient (not in CanvasNodeState) and is delivered by the
  // canvas TerminalNode via writeWhenShellReady after switching to the project (see create-node
  // handler), so the modal has no legitimate case to deliver it.
  const spawn: ModalSpawn = {
    shell: n.shell,
    cwd: n.cwd,
    agentId: n.agentId,
    accountId: n.accountId,
    ssh: n.ssh,
    sshRemoteTmux: !!n.sshRemoteTmux
  }
  return {
    id: n.id,
    title: n.title ?? '',
    color: n.color ?? SYSTEM_NODE_COLORS[0],
    kind: 'terminal',
    agentId: n.agentId,
    spawn
  }
}
