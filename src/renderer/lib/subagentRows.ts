import type { SubagentViz } from '../state/agentNodes'

/**
 * The subagents of one agent node, as the sessions sidebar and the kanban card list them: one row
 * per subagent card the canvas draws for that node (`useAgentNodes`, the same store). Nothing here
 * is persisted, and a node with no cards has no rows.
 */
export interface SubagentRow {
  /** The card's key (a Claude child's `agent_id`, or a tool_use_id). */
  id: string
  /** The subagent type, e.g. 'general-purpose'. */
  type: string
  /** Its task, on one line. Empty when the card has none. */
  label: string
  state: 'working' | 'done'
}

/** A row draws one line; a task prompt can run to pages. */
const LABEL_MAX = 200

function oneLine(s: string | undefined): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat
}

/** The rows of `parentNodeId`'s subagents, in the order they started. */
export function subagentRowsFor(byId: Record<string, SubagentViz>, parentNodeId: string): SubagentRow[] {
  const found: { row: SubagentRow; startedAt: number }[] = []
  for (const id of Object.keys(byId)) {
    const v = byId[id]
    if (v.parentNodeId !== parentNodeId) continue
    found.push({
      row: {
        id,
        type: oneLine(v.type) || 'subagent',
        label: oneLine(v.label),
        state: v.state === 'working' ? 'working' : 'done'
      },
      startedAt: v.startedAt
    })
  }
  // Stable: two cards started in the same millisecond keep the store's order.
  found.sort((a, b) => a.startedAt - b.startedAt)
  return found.map((f) => f.row)
}

/**
 * A primitive that changes exactly when `subagentRowsFor` would draw something else — what the
 * row components subscribe with, never the store's whole `byId` (whose identity changes on every
 * hook event of every node; the canvas `armedDepSig` rule). It carries more than id and state
 * because a running card is RELABELLED under its own id: Claude's lifecycle pairs a label with a
 * child by guess and corrects it later (core/claude-subagent-lifecycle.ts), and a signature blind
 * to the label would leave the sidebar showing the guess. `''` = no cards (the common case, which
 * allocates nothing).
 */
export function subagentRowsSig(byId: Record<string, SubagentViz>, parentNodeId: string): string {
  let any = false
  for (const id in byId) {
    if (byId[id].parentNodeId === parentNodeId) {
      any = true
      break
    }
  }
  if (!any) return ''
  // Fields joined by a tab, rows by a newline: `oneLine` leaves neither inside a field.
  return subagentRowsFor(byId, parentNodeId)
    .map((r) => `${r.id}\t${r.state}\t${r.type}\t${r.label}`)
    .join('\n')
}

/** The ask a subagent row makes: go to `parentNodeId` and open its card `cardId`. */
export interface OpenSubagentDetail {
  parentNodeId: string
  cardId: string
}

/**
 * Ask the canvas to open a subagent's card (Canvas holds the one listener). The canvas travels to
 * the parent node the way every "go to node" does — switching or reopening its project — then
 * opens and selects the card.
 */
export function requestOpenSubagent(parentNodeId: string, cardId: string): void {
  const detail: OpenSubagentDetail = { parentNodeId, cardId }
  window.dispatchEvent(new CustomEvent('nodeterm:open-subagent', { detail }))
}

/** The part of the card store an open needs (`useAgentNodes.getState()`). */
export interface SubagentCardStore {
  byId: Record<string, SubagentViz>
  expanded: Record<string, boolean>
  toggleExpanded(id: string): void
  select(id: string | null): void
}

/**
 * Open (never close) and select the card, if it is still there and still this parent's — a row
 * can outlive its card by a render. Opening pins it (`toggleExpanded`), so the turn boundary cannot
 * take it while the canvas travels to another project; only the parent going away can, and that
 * clears the card's flags with it. Returns whether the card was opened.
 */
export function openSubagentCard(store: SubagentCardStore, parentNodeId: string, cardId: string): boolean {
  const card = store.byId[cardId]
  if (!card || card.parentNodeId !== parentNodeId) return false
  if (!store.expanded[cardId]) store.toggleExpanded(cardId)
  store.select(cardId)
  return true
}
