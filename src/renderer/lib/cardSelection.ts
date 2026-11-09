/**
 * Pure multi-select over the kanban board's session cards: which cards a click selects, and what
 * survives when the board under the selection changes.
 *
 * `order` is always BOARD ORDER — the session cards on screen, column by column, top to bottom
 * (the same list the board's J/K keys walk). A selection only ever names cards in it: a card a
 * filter hid, a column the user collapsed away, or a node that was deleted is dropped, because a
 * bulk action must never reach a card the user cannot see.
 */

/** What a click on a card asked for. */
export interface SelectMods {
  /** ⌘/Ctrl held: add or remove this one card. */
  toggle: boolean
  /** Shift held: extend from the anchor to this card. */
  range: boolean
}

export interface SelectionState {
  /** Selected card ids, in the order they were picked. */
  ids: readonly string[]
  /** The card a Shift-click extends from (the last card toggled by hand). */
  anchor: string | null
}

export const NO_SELECTION: SelectionState = { ids: [], anchor: null }

/**
 * The selection after a click on `id`, or NULL when the click is not a selection gesture and the
 * card should do what a click always did (open).
 *
 *  - ⌘/Ctrl-click toggles the card and makes it the anchor;
 *  - Shift-click adds every card between the anchor and this one (board order, inclusive) — with
 *    no usable anchor it just selects this card;
 *  - a PLAIN click toggles too, but only while something is already selected: once you are picking
 *    cards, a click keeps picking instead of opening a modal over the selection.
 */
export function clickSelection(
  state: SelectionState,
  order: readonly string[],
  id: string,
  mods: SelectMods
): SelectionState | null {
  if (!order.includes(id)) return null
  if (mods.range) {
    const from = state.anchor === null ? -1 : order.indexOf(state.anchor)
    if (from === -1) return { ids: state.ids.includes(id) ? state.ids : [...state.ids, id], anchor: id }
    const to = order.indexOf(id)
    const span = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    const have = new Set(state.ids)
    return { ids: [...state.ids, ...span.filter((x) => !have.has(x))], anchor: state.anchor }
  }
  if (!mods.toggle && state.ids.length === 0) return null
  return state.ids.includes(id)
    ? { ids: state.ids.filter((x) => x !== id), anchor: id }
    : { ids: [...state.ids, id], anchor: id }
}

/** Drop everything no longer on the board. Returns the SAME state when nothing was dropped. */
export function pruneSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const live = new Set(order)
  const ids = state.ids.filter((id) => live.has(id))
  const anchor = state.anchor !== null && live.has(state.anchor) ? state.anchor : null
  if (ids.length === state.ids.length && anchor === state.anchor) return state
  return ids.length === 0 && anchor === null ? NO_SELECTION : { ids, anchor }
}

/** The selected cards in BOARD order — the order a bulk move keeps them in. */
export function inBoardOrder(order: readonly string[], ids: readonly string[]): string[] {
  const picked = new Set(ids)
  return order.filter((id) => picked.has(id))
}

/**
 * The cards a drag of `draggedId` carries: the whole selection when the dragged card is part of
 * it, else just that card (dragging an unselected card never drags the selection along).
 */
export function dragGroup(order: readonly string[], ids: readonly string[], draggedId: string): string[] {
  return ids.length > 1 && ids.includes(draggedId) ? inBoardOrder(order, ids) : [draggedId]
}
