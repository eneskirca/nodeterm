import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NO_SELECTION, clickSelection, pruneSelection, type SelectMods, type SelectionState
} from '../../lib/cardSelection'
import { openDialogCount } from '../dialog-stack'

export interface CardSelection {
  /** Selected card ids that are on the board RIGHT NOW (pick order). Stable while unchanged. */
  ids: readonly string[]
  /** The same ids as a set, for a card's `selected` prop. */
  set: ReadonlySet<string>
  /** A card was clicked: true = the click was a selection gesture (the card must not open).
   *  Identity-stable, so the memoized cards never re-render for it. */
  onSelectClick: (id: string, mods: SelectMods) => boolean
  /** Select / deselect one card (the card menu's row). */
  toggle: (id: string) => void
  clear: () => void
}

const isTextTarget = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null
  if (!t || typeof t.tagName !== 'string') return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true
}

/**
 * Multi-select state for one board's session cards (the rules are lib/cardSelection).
 *
 * `order` is the board order on screen. The selection is pruned against it on every change, and
 * what callers read is ALREADY pruned in the same render — so a bulk action can never reach a card
 * a filter just hid, even for the one frame before the state catches up.
 *
 * Escape clears the selection, but only when the key is plainly the board's: not while a dialog
 * or a context menu is up, and not from inside a text field (where Escape cancels the edit).
 */
export function useCardSelection(order: readonly string[]): CardSelection {
  const [state, setState] = useState<SelectionState>(NO_SELECTION)
  const live = useMemo(() => pruneSelection(state, order), [state, order])
  useEffect(() => {
    if (live !== state) setState(live)
  }, [live, state])
  const liveRef = useRef(live)
  liveRef.current = live
  const orderRef = useRef(order)
  orderRef.current = order

  const onSelectClick = useCallback((id: string, mods: SelectMods): boolean => {
    const next = clickSelection(liveRef.current, orderRef.current, id, mods)
    if (!next) return false
    // Read back by a second click in the same tick, before React has re-rendered.
    liveRef.current = next
    setState(next)
    return true
  }, [])
  const toggle = useCallback(
    (id: string) => void onSelectClick(id, { toggle: true, range: false }),
    [onSelectClick]
  )
  const clear = useCallback(() => {
    liveRef.current = NO_SELECTION
    setState(NO_SELECTION)
  }, [])

  const active = live.ids.length > 0
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (openDialogCount() > 0 || document.querySelector('.ctx-backdrop')) return
      if (isTextTarget(e.target)) return
      clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, clear])

  const set = useMemo(() => new Set(live.ids), [live.ids])
  return { ids: live.ids, set, onSelectClick, toggle, clear }
}
