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
 * A primitive that changes whenever `subagentRowsFor` would draw something else — what the row
 * components subscribe with, never the store's whole `byId` (whose identity changes on every hook
 * event of every node; the canvas `armedDepSig` rule). It carries more than id and state because a
 * running card is RELABELLED under its own id: Claude's lifecycle pairs a label with a child by
 * guess and corrects it later (core/claude-subagent-lifecycle.ts), and a signature blind to the
 * label would leave the sidebar showing the guess.
 *
 * Built from the RAW fields, in store order, with no regex and no sort: it runs on every store
 * update for every subscribed row, so it costs one pass and one concatenation. The start time is in
 * it, so a change of the drawn ORDER changes it too (the order is a function of store order and the
 * start times). A raw field may change where the drawn row does not (whitespace in a task, an
 * absent type vs `'subagent'`); that costs one redundant render, never a missed one. The free-text
 * fields are length-prefixed, so a task holding the separators cannot read as another card. `''` =
 * no cards (the common case, which allocates nothing).
 */
export function subagentRowsSig(byId: Record<string, SubagentViz>, parentNodeId: string): string {
  let sig = ''
  for (const id in byId) {
    const v = byId[id]
    if (v.parentNodeId !== parentNodeId) continue
    const type = v.type ?? ''
    const label = v.label ?? ''
    sig += `${id.length}:${id}${v.state === 'working' ? 'w' : 'd'}${v.startedAt}:${type.length}:${type}${label.length}:${label}`
  }
  return sig
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

/** Said when a row opens a card that the canvas does not draw (see `parentHidesFanout`). */
export const SUBAGENT_FANOUT_HIDDEN_TEXT =
  "Opened the subagent, but this session's cards are hidden. Click the eye in its header (Show cards & connections) to see it."

/**
 * Whether the parent hides its cards and connections (the header's eye, `data.hideFanout`): the
 * canvas then draws none of its subagent cards, so a row that opens one must say so. The live
 * canvas's copy wins when it holds the parent (the flag the person last toggled); otherwise the
 * stored copy of the project that owns it. Truthy, exactly as the canvas's card merge tests it.
 * The open never clears the flag itself: it is persisted node data, and showing the cards is the
 * person's choice.
 */
export function parentHidesFanout(
  parentNodeId: string,
  live: ReadonlyArray<{ id: string; data?: { hideFanout?: unknown } }>,
  stored: ReadonlyArray<{ id: string; hideFanout?: unknown }> | undefined
): boolean {
  const onCanvas = live.find((n) => n.id === parentNodeId)
  if (onCanvas) return !!onCanvas.data?.hideFanout
  return !!stored?.find((n) => n.id === parentNodeId)?.hideFanout
}
