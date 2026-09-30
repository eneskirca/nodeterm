/**
 * The board's transient status filter chips — Running / Needs you / Unread — and the ONE badge
 * rule the session card and the chips both read, so a chip can never select cards whose badge
 * says something else.
 *
 * Two rules come with it:
 *
 * 1. **Derived signature, never `byId`.** The board subscribes to `statusChipSig(byId, cards)`, a
 *    primitive string that changes only when a chip-relevant fact of a card ON THIS BOARD changes.
 *    Subscribing to the map would re-render the whole board on every hook event of every node —
 *    the churn Canvas's `armedDepSig` / `loopSig` exist to avoid.
 * 2. **Never persisted.** The chips filter on second-by-second agent state. A filter like that
 *    surviving a restart (or a saved view carrying it) shows a board that is wrong before anyone
 *    has looked at it, so the chips live in component state and nowhere else.
 */
import type { AgentNodeStatus } from '../state/agentStatus'

export type StatusChip = 'running' | 'needs' | 'unread'

export const STATUS_CHIPS: ReadonlyArray<{ id: StatusChip; label: string }> = [
  { id: 'running', label: 'Running' },
  { id: 'needs', label: 'Needs you' },
  { id: 'unread', label: 'Unread' }
]

export type CardBadge = 'dropped' | 'running' | 'needs' | 'paused' | 'sleeping'

/**
 * The status badge a session card shows. DROPPED ranks first (the CLI died unannounced — the
 * strongest claim on the card, and only ever raised on a `done` node, so it cannot actually
 * collide with the others); SLEEPING last (a hibernated node is idle by definition, so `working`
 * or `waiting` there can only mean the wake landed and the hooks are ahead of the flag). A sticky
 * note has no agent and never carries one.
 */
export function cardBadge(kind: string, status: AgentNodeStatus | undefined): CardBadge | null {
  if (kind === 'sticky' || !status) return null
  if (status.dropped) return 'dropped'
  if (status.state === 'working') return 'running'
  if (status.state === 'waiting' || status.state === 'blocked') return 'needs'
  if (status.paused) return 'paused'
  if (status.hibernated) return 'sleeping'
  return null
}

export interface StatusChipCard {
  id: string
  kind: string
}

/** One `[id, flags]` entry per card with at least one chip fact (`r|.` `n|.` `u|.`), written with
 *  `JSON.stringify` — node ids come from a git-shared, hand-editable project file, and an id joined
 *  raw with a separator (`x|victim`) used to split into a forged entry for another card. `''` when
 *  no card has a fact. */
export function statusChipSig(
  byId: Readonly<Record<string, AgentNodeStatus | undefined>>,
  cards: readonly StatusChipCard[]
): string {
  const entries: Array<[string, string]> = []
  for (const card of cards) {
    const status = byId[card.id]
    if (!status) continue
    const badge = cardBadge(card.kind, status)
    const r = badge === 'running'
    const n = badge === 'needs'
    const u = !!status.unread
    if (!r && !n && !u) continue
    entries.push([card.id, `${r ? 'r' : '.'}${n ? 'n' : '.'}${u ? 'u' : '.'}`])
  }
  return entries.length ? JSON.stringify(entries) : ''
}

export interface StatusChipFacts {
  running: Set<string>
  needs: Set<string>
  unread: Set<string>
}

export function parseStatusChipSig(sig: string): StatusChipFacts {
  const facts: StatusChipFacts = { running: new Set(), needs: new Set(), unread: new Set() }
  if (!sig) return facts
  let entries: unknown
  try {
    entries = JSON.parse(sig)
  } catch {
    return facts
  }
  if (!Array.isArray(entries)) return facts
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue
    const [id, flags] = entry as [string, string]
    if (flags[0] === 'r') facts.running.add(id)
    if (flags[1] === 'n') facts.needs.add(id)
    if (flags[2] === 'u') facts.unread.add(id)
  }
  return facts
}

/** Does this card pass the active chips? No chip = everything; several = any of them (OR). */
export function matchesStatusChips(facts: StatusChipFacts, id: string, active: readonly StatusChip[]): boolean {
  if (!active.length) return true
  return active.some((chip) => facts[chip].has(id))
}

export function chipCounts(facts: StatusChipFacts): Record<StatusChip, number> {
  return { running: facts.running.size, needs: facts.needs.size, unread: facts.unread.size }
}
