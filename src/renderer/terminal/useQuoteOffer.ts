import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * "Add to chat" at a terminal's copy moment: the text the person just copied, offered for a few
 * seconds as a quote for the node's agent (`QuotePill`, then `addQuoteToNode`).
 *
 * The moment is the only one there is. In a tmux pane the selection is tmux's and is CLEARED as it
 * copies, so the text exists on this side only inside the OSC 52 handler (and, for a selection xterm
 * owns — Option/Shift drag, or a pane with no tmux — at the release that finished it). Holding the
 * text here is what lets a click a second later still quote it.
 *
 * `notify` and `clear` keep one identity for the component's lifetime: TerminalNode publishes
 * `notify` in a module-level map (its OSC 52 handler outlives a park) and compares identity on
 * cleanup, as it does for the copy receipt. A newer copy replaces the offer and restarts its time;
 * a click or a dismiss clears it; it lapses after `QUOTE_OFFER_MS`.
 */

/** How long a copy stays on offer. */
export const QUOTE_OFFER_MS = 6000

export interface QuoteOfferApi {
  /** The text on offer, or null. */
  offer: string | null
  /** A copy happened in this terminal. Stable identity. */
  notify(text: string): void
  /** Withdraw the offer (clicked, dismissed, or no longer applicable). Stable identity. */
  clear(): void
}

/** `enabled`: the node is an agent node (a plain terminal has no message box to quote into). */
export function useQuoteOffer(opts: { enabled: boolean }): QuoteOfferApi {
  const { enabled } = opts
  const [offer, setOffer] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read through a ref so `notify` keeps one identity whatever `enabled` does.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const clear = useCallback((): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setOffer(null)
  }, [])

  const notify = useCallback((text: string): void => {
    // A copy of nothing but whitespace would quote nothing; `/\S/` stops at the first character
    // that counts, so a large copy costs nothing here.
    if (!enabledRef.current || !/\S/.test(text)) return
    if (timer.current) clearTimeout(timer.current)
    setOffer(text)
    timer.current = setTimeout(() => {
      timer.current = null
      setOffer(null)
    }, QUOTE_OFFER_MS)
  }, [])

  // A node that stops being an agent node (its agent changed) has nothing to quote into.
  useEffect(() => {
    if (!enabled) clear()
  }, [enabled, clear])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return { offer, notify, clear }
}
