import type { SshConnection } from '@shared/ssh'
import type { NodeIcon } from '@shared/node-icon'
import { NODE_COLORS, type CanvasNode } from '../state/workspace'
import type { KanbanSession } from '../components/kanban/KanbanView'

/** One canvas node as a board card, or null when this kind is not a card at all (a group frame, an
 *  editor, a diff). The board derives its cards from the canvas live, so this is the single
 *  definition of that mapping — the card list and the board-log's `cardTitle` lookup must agree on
 *  what a node is called, or a title change would log as a card appearing and disappearing. */
export function toKanbanSession(n: CanvasNode): KanbanSession | null {
  if (n.type === 'browser') {
    return {
      id: n.id,
      title: (n.data.title as string) || 'Browser',
      color: (n.data.color as string) ?? NODE_COLORS[0],
      kind: 'browser',
      url: n.data.url as string | undefined,
      partition: n.data.partition as string | undefined,
      spawn: {}
    }
  }
  if (n.type === 'sticky') {
    // The card modal's textarea is CONTROLLED by this text: it must be the node's raw value.
    // Trimming here strips the trailing space/newline the user just typed on every round-trip,
    // which reads as "the space key doesn't work" in the kanban note editor (issue #285).
    const text = (n.data.text as string) ?? ''
    return {
      id: n.id,
      // A note has no title of its own — its trimmed first line is the card label. Bodies are
      // markdown, so a leading heading marker is presentation, not part of the label.
      title: text.trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note',
      color: (n.data.color as string) ?? NODE_COLORS[2],
      kind: 'sticky',
      text,
      textUpdatedAt: n.data.textUpdatedAt as number | undefined,
      textUpdatedBy: n.data.textUpdatedBy as string | undefined,
      // Sticky cards never open a live terminal — the modal reads no spawn info.
      spawn: {}
    }
  }
  if (n.type !== 'terminal') return null
  return {
    id: n.id,
    title: (n.data.title as string) ?? '',
    color: (n.data.color as string) ?? NODE_COLORS[0],
    kind: 'terminal',
    agentId: n.data.agentId as string | undefined,
    icon: n.data.icon as NodeIcon | undefined,
    // The launch record, so both kanban ContextMeter surfaces show the model and denominator the
    // session was launched with (the transcript trails a switch — see lib/contextMeterModel.ts).
    agentModel: n.data.agentLaunchModel as string | undefined,
    agentLaunchContextWindow: n.data.agentLaunchContextWindow as number | undefined,
    // What the card modal's co-attach terminal needs to join THIS node's session the same way the
    // canvas TerminalNode does.
    spawn: {
      shell: n.data.shell as string | undefined,
      cwd: n.data.cwd as string | undefined,
      agentId: n.data.agentId as string | undefined,
      accountId: n.data.accountId as string | undefined,
      ssh: n.data.ssh as SshConnection | undefined,
      sshRemoteTmux: !!n.data.sshRemoteTmux
    }
  }
}
