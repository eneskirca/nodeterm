import type { ProjectKanban } from '@shared/types'

/** Where a board card can come from. Sources are a membership list plus one concrete leaf each
 *  (the card component and the list path that feeds it) — the same discipline `AGENT_CONFIG`
 *  uses for agents, so no consumer spells a source id to decide how a card behaves. */
export type KanbanSourceId = 'github' | 'pulls' | 'sessions'

/** The board's source filter: everything, or exactly one source. */
export type KanbanSourceFilter = 'all' | KanbanSourceId

export interface KanbanSourceDef {
  id: KanbanSourceId
  /** Button label in the source filter. */
  label: string
  /** Where a card's column comes from.
   *  `assignment` — the board's own `assignments` list, persisted in `.nodeterm/project.json`
   *  and reorderable within a column.
   *  `provider` — the provider reports the column; the board persists nothing for the card and
   *  a move is the provider's write, not a board edit. */
  placement: 'assignment' | 'provider'
  /** In-column stacking order, low first. */
  lane: number
  /** The board never writes this source: its cards do not drag and carry no move control.
   *  Distinct from `placement: 'provider'`, which only says who OWNS the column — a provider
   *  source can still be writable (an issue drag closes it on GitHub). */
  readOnly?: boolean
  /** Whether this source can contribute cards to a given board at all. */
  configured: (board: ProjectKanban) => boolean
}

/** Declaration order IS the source filter's button order; `lane` is the in-column stacking
 *  order. The two genuinely differ on the board today (the filter reads All · GitHub · Sessions
 *  while a column stacks its sessions above its issues and its issues above its pull requests),
 *  and pinning both here is what keeps either of them from being re-spelled at a call site. */
export const KANBAN_SOURCES: readonly KanbanSourceDef[] = [
  {
    id: 'github',
    label: 'Issues',
    placement: 'provider',
    lane: 1,
    configured: (board) => !!board.github
  },
  {
    id: 'pulls',
    label: 'Pull requests',
    placement: 'provider',
    lane: 2,
    readOnly: true,
    configured: (board) => !!board.github
  },
  {
    id: 'sessions',
    label: 'Sessions',
    placement: 'assignment',
    lane: 0,
    configured: () => true
  }
]

const BY_ID = new Map(KANBAN_SOURCES.map((source) => [source.id, source]))

export function kanbanSource(id: KanbanSourceId): KanbanSourceDef {
  const source = BY_ID.get(id)
  if (!source) throw new Error(`unknown kanban source: ${id}`)
  return source
}

/** Does the current filter show this source's cards? */
export function sourceVisible(filter: KanbanSourceFilter, id: KanbanSourceId): boolean {
  return filter === 'all' || filter === id
}

/** Sorts lanes into their in-column stacking order. Callers hand lanes over in whatever order
 *  they built them; the registry decides what a column shows first. */
export function byLane<T extends { sourceId: KanbanSourceId }>(lanes: T[]): T[] {
  return [...lanes].sort((a, b) => kanbanSource(a.sourceId).lane - kanbanSource(b.sourceId).lane)
}
