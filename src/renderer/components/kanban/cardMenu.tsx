/**
 * The kanban card right-click menu, for BOTH boards (per-project and the Omni lanes) — one list,
 * so the two views of a card cannot offer different things.
 *
 * Board-only rows come first (open, move, select, rename); then the node's own rows from the shared node
 * builder (`nodeActions`: lib/nodeActionItems, narrowed to `BOARD_NODE_ACTION_IDS` by Canvas);
 * then Delete, which goes through the board's own confirm.
 *
 * Hide lists: "Open card in chat / markdown view" follows the `markdown-view` id (it replaces the
 * canvas row of that name on a card). Rename is in no inventory and stays unhideable. "Name with
 * AI" is NOT gated by the header's `ai-name` id, because the card modal's ✦ button never was:
 * hiding one and not the other would make the same action vanish from half of the board.
 */
import type { ProjectKanban } from '@shared/types'
import type { MenuItem } from '../ContextMenu'
import { IconCheck, IconClose, IconEditor, IconExternal, IconMarkdown, IconSparkle, IconSwitch, IconTrash } from '../icons'
import { promptDialog } from '../promptDialog'
import { assignNode, assignNodes, columnForNode } from '../../lib/kanban'
import { isHidden } from '../../lib/ui-visibility'
import { tidySeparators } from '../../lib/tidySeparators'
import type { KanbanSession } from './KanbanView'

export interface CardMenuArgs {
  card: Pick<KanbanSession, 'id' | 'kind' | 'title'>
  board: ProjectKanban
  /** `settings.hiddenNodeMenuItems`. */
  hidden: readonly string[]
  /** The board's pruned commit. */
  commit: (next: ProjectKanban) => void
  /** Open the card modal; `'md'` opens it on its chat / markdown view. */
  openCard: (nodeId: string, view?: 'md') => void
  openOnCanvas: (nodeId: string) => void
  rename: (nodeId: string, title: string) => void
  /** Absent = no "Name with AI" row (a board with no canvas behind it). */
  aiName?: (nodeId: string) => void
  /** The node's rows from the shared builder. Absent = none. */
  nodeActions?: (nodeId: string) => MenuItem[]
  /** The board's Delete — routed through the canvas confirm. */
  remove: (nodeId: string) => void
  /** Multi-select: whether this card is selected, and the toggle. Absent = no Select row. */
  select?: { selected: boolean; toggle: (nodeId: string) => void }
}

export function buildCardMenuItems(a: CardMenuArgs): MenuItem[] {
  const { card, board } = a
  const isTerminal = card.kind === 'terminal'
  const curColId = columnForNode(board, card.id)?.id ?? null
  const moveTargets: MenuItem[] = [
    ...(curColId !== null
      ? [{ label: 'Ungrouped', onClick: () => a.commit(assignNode(board, card.id, null, null)) }]
      : []),
    ...board.columns
      .filter((c) => c.id !== curColId)
      .map((c) => ({ label: c.title, onClick: () => a.commit(assignNode(board, card.id, c.id, null)) }))
  ]
  return tidySeparators([
    { label: 'Open card', icon: <IconExternal />, onClick: () => a.openCard(card.id) },
    ...(isTerminal && !isHidden('markdown-view', a.hidden)
      ? [
          {
            label: 'Open card in chat / markdown view',
            icon: <IconMarkdown />,
            onClick: () => a.openCard(card.id, 'md')
          }
        ]
      : []),
    { label: 'Open on canvas', icon: <IconExternal />, onClick: () => a.openOnCanvas(card.id) },
    ...(moveTargets.length
      ? ([{ type: 'submenu', label: 'Move to', icon: <IconSwitch />, children: moveTargets }] as MenuItem[])
      : []),
    // The way into multi-select for someone who does not know the ⌘/Ctrl-click gesture.
    ...(a.select
      ? [
          {
            label: a.select.selected ? 'Deselect' : 'Select',
            icon: <IconCheck />,
            hint: 'Select several cards to move or delete them together (⌘/Ctrl-click, Shift-click for a range)',
            onClick: () => a.select!.toggle(card.id)
          }
        ]
      : []),
    { type: 'separator' },
    // Not on a sticky: a note's label IS its first line (the card modal does not rename it either).
    ...(card.kind !== 'sticky'
      ? [
          {
            label: 'Rename…',
            icon: <IconEditor />,
            onClick: () => {
              void promptDialog({ message: 'Rename session', initialValue: card.title }).then((t) => {
                if (t && t.trim()) a.rename(card.id, t.trim())
              })
            }
          }
        ]
      : []),
    ...(isTerminal && a.aiName
      ? [{ label: 'Name with AI', icon: <IconSparkle />, onClick: () => a.aiName!(card.id) }]
      : []),
    { type: 'separator' },
    ...(a.nodeActions?.(card.id) ?? []),
    { type: 'separator' },
    { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => a.remove(card.id) }
  ])
}

/** "card" / "cards" — the one place the bulk wording counts. */
export const cardCount = (n: number): string => `${n} ${n === 1 ? 'card' : 'cards'}`

/**
 * Where a SELECTION can be moved: Ungrouped and every column, minus a destination that already
 * holds every selected card (moving there would change nothing). `ids` are in board order, which
 * is the order they keep in the destination (lib/kanban `assignNodes`; unanchored = the top).
 */
export function bulkMoveTargets(
  board: ProjectKanban,
  ids: readonly string[],
  commit: (next: ProjectKanban) => void
): MenuItem[] {
  const homes = new Set(ids.map((id) => columnForNode(board, id)?.id ?? null))
  const allIn = (columnId: string | null): boolean => homes.size === 1 && homes.has(columnId)
  return [
    ...(allIn(null) ? [] : [{ label: 'Ungrouped', onClick: () => commit(assignNodes(board, ids, null, null)) }]),
    ...board.columns
      .filter((c) => !allIn(c.id))
      .map((c) => ({ label: c.title, onClick: () => commit(assignNodes(board, ids, c.id, null)) }))
  ]
}

export interface BulkCardMenuArgs {
  /** The selected cards, in board order. */
  ids: readonly string[]
  board: ProjectKanban
  commit: (next: ProjectKanban) => void
  clear: () => void
  /** Delete every selected card — ONE confirm for all of them. Absent = no Delete row. */
  remove?: (nodeIds: string[]) => void
}

/** The right-click menu of a card that is part of a multi-card selection: it acts on ALL of them,
 *  so it offers only what makes sense for several cards at once. */
export function buildBulkCardMenuItems(a: BulkCardMenuArgs): MenuItem[] {
  const targets = bulkMoveTargets(a.board, a.ids, a.commit)
  return tidySeparators([
    { type: 'label', label: `${cardCount(a.ids.length)} selected` },
    ...(targets.length
      ? ([{ type: 'submenu', label: 'Move to', icon: <IconSwitch />, children: targets }] as MenuItem[])
      : []),
    { label: 'Clear selection', icon: <IconClose />, onClick: a.clear },
    { type: 'separator' },
    ...(a.remove
      ? [
          {
            label: `Delete ${cardCount(a.ids.length)}`,
            icon: <IconTrash />,
            danger: true,
            onClick: () => a.remove!([...a.ids])
          }
        ]
      : [])
  ])
}
