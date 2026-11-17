import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import { addQuoteToNode, defaultQuoteDeps } from '../lib/addQuoteToNode'
import { agentProcessInPane } from './live-work'
import { useQuoteOffer } from './useQuoteOffer'

/** What the gate reads about the node at the moment of a copy (its agent-status entry). */
type PaneStatus = Parameters<typeof agentProcessInPane>[1] & { agentId?: string }

export interface TerminalQuote {
  /** The text on offer, or null. */
  offer: string | null
  /** A copy happened in this terminal. Stable identity (a module-level registry compares it). */
  notify(text: string): void
  /** Withdraw the offer. Stable identity. */
  clear(): void
  /** The pill was clicked: withdraw the offer and add the text as a quote for the node. */
  add(text: string): void
}

/**
 * "Add to chat" at a terminal's copy moment — the one piece of glue BOTH terminal surfaces use (the
 * canvas node and the kanban card modal's live viewer), so one session seen twice offers the same
 * thing by the same rules. The offer is `useQuoteOffer`'s; this adds:
 *
 * - the pane gate, read AT THE COPY: a node whose agent's CLI has left the pane (asleep, paused,
 *   dropped, exited — `agentProcessInPane`) offers nothing, since the funnel would only refuse it.
 *   The agent is the created one, else the one its hooks reported — the funnel's own derivation;
 * - the funnel: a click goes through `addQuoteToNode` for `nodeId`, over the session's own api (a
 *   relay tab's write goes to its host's pane);
 * - `covered`: the node's ⌘M face over the terminal ends an offer made for the terminal.
 */
export function useTerminalQuote(opts: {
  api: NodeTerminalApi
  /** The node a quote goes to: the canvas node, or the card modal's card. */
  nodeId: string
  /** The agent the node was created to run, if any. */
  agentId: string | undefined
  /** The node is an agent node and may take a quote at all (not a hosted read-only seat). */
  enabled: boolean
  /** The terminal is covered (its ⌘M face is up). */
  covered: boolean
  /** The node's agent-status entry, read at the moment of a copy. */
  readStatus: () => PaneStatus | undefined
}): TerminalQuote {
  const { api, nodeId, agentId, enabled, covered, readStatus } = opts
  const offer = useQuoteOffer({ enabled })
  // Read through a ref so `notify` keeps one identity whatever the props do.
  const gate = useRef({ agentId, readStatus })
  gate.current = { agentId, readStatus }
  const offerNotify = offer.notify
  const notify = useCallback(
    (text: string): void => {
      const status = gate.current.readStatus()
      if (!agentProcessInPane(gate.current.agentId ?? status?.agentId, status)) return
      offerNotify(text)
    },
    [offerNotify]
  )
  const clear = offer.clear
  const quoteDeps = useMemo(
    () => defaultQuoteDeps(api, { agentIdOf: (id) => (id === nodeId ? agentId : undefined) }),
    [api, nodeId, agentId]
  )
  const add = useCallback(
    (text: string): void => {
      clear()
      void addQuoteToNode(quoteDeps, nodeId, text)
    },
    [clear, quoteDeps, nodeId]
  )
  useEffect(() => {
    if (covered) clear()
  }, [covered, clear])
  return { offer: offer.offer, notify, clear, add }
}
