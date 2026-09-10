/**
 * Human identity for a terminal: a short callsign (A, B, C … AA) that stays put
 * while the opaque node id (tmux session name) keeps changing under the hood.
 *
 * The canvas used to identify sessions by those ids. People cannot tell `term-m8k2-a1f3`
 * from `term-m8k3-b9c0`, and the per-node token layer then refused the wrong sibling.
 * A letter on the chrome is what you point at when you say "talk to B".
 */

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function callsignAt(index: number): string {
  if (index < 0 || !Number.isFinite(index)) return 'A'
  let n = Math.floor(index)
  let out = ''
  do {
    out = ALPHA[n % 26] + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

export function parseCallsign(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toUpperCase()
  if (!s || s.length > 4 || !/^[A-Z]+$/.test(s)) return null
  return s
}

/** Next unused callsign, scanning A, B, … then AA. */
export function nextCallsign(used: Iterable<string>): string {
  const taken = new Set(
    [...used].map(parseCallsign).filter((s): s is string => !!s)
  )
  for (let i = 0; i < 26 * 27; i++) {
    const c = callsignAt(i)
    if (!taken.has(c)) return c
  }
  return callsignAt(Date.now() % 676)
}

export interface CallsignNode {
  id: string
  type?: string
  data: { callsign?: unknown } & Record<string, unknown>
}

/**
 * Stamp a unique callsign onto every terminal that is missing one.
 * Returns the same array identity when nothing changed.
 */
export function ensureCallsigns<T extends CallsignNode>(nodes: T[]): T[] {
  const used: string[] = []
  for (const n of nodes) {
    if (n.type && n.type !== 'terminal') continue
    const c = parseCallsign(n.data.callsign)
    if (c) used.push(c)
  }
  let changed = false
  const next = nodes.map((n) => {
    if (n.type && n.type !== 'terminal') return n
    if (parseCallsign(n.data.callsign)) return n
    const callsign = nextCallsign(used)
    used.push(callsign)
    changed = true
    return { ...n, data: { ...n.data, callsign } }
  })
  return changed ? next : nodes
}

export function callsignOf(node: CallsignNode | undefined): string {
  if (!node) return '?'
  return parseCallsign(node.data.callsign) ?? '?'
}
