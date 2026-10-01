// Team presence — the wire contract shared by src/core (PresenceHub), both shells, and the
// renderer. See docs/team-presence.md.
//
// Presence is TRANSIENT: nothing in this file is ever written to workspace.json / project.json /
// settings.json. The only thing that survives a reload is the local user's own {name, color}
// (localStorage, renderer side).

/** A connected UI. Electron: webContents.id. Server Edition: the ServerPlatform uiId.
 *  Relay peers (phones): minted from a high range by the hub (see allocateRelayClientId). */
export type ClientId = number

/** What a human claims to be. Unverified by design — presence is not a permissions feature. */
export interface PeerIdentity {
  name: string
  color: string
}

export interface PeerState {
  clientId: ClientId
  name: string
  color: string
  /** FLOW coordinates (screenToFlowPosition), never screen coords — so a cursor lands on the
   *  same node regardless of each viewer's zoom/pan. `null` = a cursorless peer (a phone). */
  cursor: { x: number; y: number } | null
  /** The node this peer is working in, or null. */
  focus: string | null
  /** Live cursor-chat text (broadcast per keystroke); null closes the bubble. */
  chat: string | null
  /** Last write into a node's terminal. Stage 2 populates this; Stage 1 always null. */
  typing: { nodeId: string; at: number } | null
  /** The project (canvas) this peer is looking at; null = none open (welcome screen). Each
   *  project has its OWN node set and flow coordinate space, so cursor/focus only mean anything
   *  to a viewer on the same project — see peersOnProject. */
  projectId: string | null
  /** The live dino game this peer is the AUTHORITY for, or null. Ephemeral like `chat`: cleared
   *  when the peer stops playing / closes the node / leaves. A spectator renders `snap` for the
   *  matching node id instead of running its own sim. Sanitized/clamped at the hub
   *  (sanitizeDinoPayload) so a malformed/oversized cast can never flood the wire. */
  dino: { nodeId: string; snap: DinoSnapshot } | null
  kind: 'browser' | 'phone' | 'desktop'
}

/** One on-screen obstacle in a dino snapshot (a cactus or a bird), with the sprite-sheet source
 *  rect a spectator needs to draw it (sx/sw/sh) and the bird wing phase (flap). */
export interface DinoObstacleSnap {
  kind: 'cactus' | 'bird'
  x: number
  y: number
  sx: number
  sw: number
  sh: number
  flap: number
}

/** The minimal per-frame state a spectator needs to draw one dino frame. Small (a handful of
 *  numbers + ≤ DINO_MAX_OBSTACLES obstacles); broadcast by the authority ~20 Hz, never persisted. */
export interface DinoSnapshot {
  y: number
  ducking: boolean
  crashed: boolean
  started: boolean
  score: number
  speed: number
  groundScroll: number
  obstacles: DinoObstacleSnap[]
}

/** Max obstacles a snapshot may carry. The hub clamps to this (like CHAT_MAX_LEN) so a malformed
 *  or oversized cast can't flood the wire — a real run only has a handful on screen at once. */
export const DINO_MAX_OBSTACLES = 12

export type PeerDiff =
  | { op: 'join'; peer: PeerState }
  /** `clientId` is the identity key and is carried by the diff itself — a patch can never
   *  rewrite it (that would silently reassign the peer). */
  | { op: 'update'; clientId: ClientId; patch: Partial<Omit<PeerState, 'clientId'>> }
  | { op: 'leave'; clientId: ClientId }

/** Peer colors, assigned next-free on join. Picked for contrast on the black canvas.
 *  `readonly`: color assignment is app-wide state, so no consumer may push/sort/assign into it. */
export const PRESENCE_COLORS: readonly string[] = [
  '#5ac8fa', // blue
  '#ff9f0a', // orange
  '#30d158', // green
  '#ff375f', // pink
  '#bf5af2', // purple
  '#ffd60a', // yellow
  '#64d2ff', // cyan
  '#ff6b3d' // clay
]

/** How long a typing badge stays lit after the last keystroke (Stage 2 renders this). */
export const TYPING_DECAY_MS = 2000
/** Caps: a peer cannot flood the wire with a giant name or chat line. */
export const NAME_MAX_LEN = 32
export const CHAT_MAX_LEN = 200
/** Cap for the ids a client reports (focus node, active project). Real ones are short and
 *  generated (`term-ab12`, `web-3f9c`), so this can never truncate a legitimate id — it exists
 *  because these strings are taken verbatim off the wire and reflected to EVERY peer, down the
 *  same sink pty output rides: an uncapped 10 MB `presence:focus` at cursor rate would fill every
 *  peer's send buffer and stall their terminals behind it. */
export const REF_MAX_LEN = 128

/** First palette color not already in use; wraps by count once every color is taken.
 *  `taken` is `readonly` so callers stay unconstrained (a mutable `string[]` is accepted). */
export function nextFreeColor(taken: readonly string[]): string {
  const used = new Set(taken)
  const free = PRESENCE_COLORS.find((c) => !used.has(c))
  return free ?? PRESENCE_COLORS[taken.length % PRESENCE_COLORS.length]
}

/** The name a peer carries until it sends presence:hello (a phone may never send one). */
export function defaultNameFor(kind: PeerState['kind']): string {
  return kind === 'phone' ? 'Phone' : 'Someone'
}

/**
 * The peers whose cursor / focus is meaningful to a viewer on `projectId`. THE project filter:
 * a project is a canvas with its own nodes and its own flow coordinate space, so a peer on
 * another project must not be drawn here at all (their coordinates would be meaningless and
 * their focused node id — globally unique — would chip the wrong header). With no project open
 * (`null`) nothing is drawn. The facepile deliberately does NOT use this: it shows everyone.
 */
export function peersOnProject(peers: PeerState[], projectId: string | null): PeerState[] {
  if (projectId === null) return []
  return peers.filter((p) => p.projectId === projectId)
}

/** Cap a string at `max` *code points*, not UTF-16 code units: `slice` would cut a surrogate
 *  pair (emoji, CJK extensions) in half and leave a lone surrogate, which renders as "�" in
 *  every peer's facepile / chat bubble. The single truncation rule for the whole feature — the
 *  hub caps chat (CHAT_MAX_LEN) and the focus/project ids (REF_MAX_LEN) with it, and capName caps
 *  names with it.
 *
 *  COST IS O(max), NOT O(text) — deliberately. This is a door for UNTRUSTED input (any client can
 *  cast a `presence:chat` / `presence:focus` of whatever size the socket accepts), and the obvious
 *  `[...text].slice(0, max)` spreads the WHOLE string into an array of code points BEFORE capping:
 *  a multi-MB frame would block the event loop for seconds and balloon the heap — a trivial remote
 *  DoS on the shared Server Edition process. A code point is at most 2 UTF-16 code units, so the
 *  first `max` code points always live inside the first `max * 2` code units: bound the input with
 *  a (O(1), no-copy) `slice` first, and only spread that. The bounded slice may end on a lone high
 *  surrogate, but that surrogate can only ever land at index >= max in the spread, so the cap
 *  drops it — no half-emoji can survive. */
export function capCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  // Fewer code units than the cap ⇒ fewer code points than the cap. Nothing to do.
  if (text.length <= max) return text
  const bounded = [...text.slice(0, max * 2)]
  if (bounded.length <= max) return bounded.join('')
  return bounded.slice(0, max).join('')
}

/**
 * The directional formatting characters, as a character-class BODY (escapes only — a bidi character
 * written literally makes the pattern unreadable, and a file carrying one is flagged as bidi text):
 * ALM (U+061C), LRM/RLM (U+200E/F), the embeddings and overrides (U+202A–E) and the isolates
 * (U+2066–9). ONE definition: `UNSAFE_DISPLAY_CHARS` below and the live-link owner side
 * (@shared/watch-link-types `stripBidiControls`) are built from it.
 */
const BIDI_CONTROL_CLASS = '\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069'
/** Only the directional formatting characters (see BIDI_CONTROL_CLASS) — for text where the other
 *  zero-width characters must survive (a ZWJ joins an emoji sequence). Global: use with `replace`. */
export const BIDI_CONTROL_CHARS = new RegExp(`[${BIDI_CONTROL_CLASS}]`, 'g')

/**
 * Characters a display name may never contain. Names are UNVERIFIED by design (anyone may claim
 * any name), but they must not be able to MISRENDER: a bidi override (U+202E) reverses everything
 * after it, so a name stored as "Ada" + U+202E + "gnihsihp" DISPLAYS as "Adaphishing" — one peer
 * visually impersonating another with a string that inspects as something else. The marks/isolates
 * (U+061C, U+200B-200F, U+2066-2069, U+FEFF) do the same job more quietly, and C0/C1 controls (newlines,
 * NUL, escapes) break a name out of its one-line chip. Strip them all; ordinary spaces, accents,
 * CJK and emoji are untouched.
 */
export const UNSAFE_DISPLAY_CHARS = new RegExp(
  `[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\ufeff${BIDI_CONTROL_CLASS}]`,
  'g'
)
/** The name this file has always used for it. ONE set: the board's display text strips the same
 *  characters (@shared/kanban-ops `displayText`). Global, so use it with `replace`, never `test`. */
const UNSAFE_NAME_CHARS = UNSAFE_DISPLAY_CHARS

/** Cap a name at NAME_MAX_LEN code points, after stripping the characters that could spoof or
 *  break the rendering of another peer's name (UNSAFE_NAME_CHARS). Trim runs again AFTER the cut,
 *  so a truncation landing on a space doesn't leave a trailing one. */
function capName(name: string): string {
  return capCodePoints(name.replace(UNSAFE_NAME_CHARS, '').trim(), NAME_MAX_LEN).trim()
}

/** Coerce an untrusted {name, color} off the wire into a safe identity — THE one door for
 *  client-supplied identity. Names are unverified (anyone can claim any name — documented
 *  trade-off) but they are length-capped and stripped of control/bidi characters (capName), so a
 *  peer cannot visually spoof another's name, and the color must be one of ours so it can never be
 *  injected into a style attribute as arbitrary text. */
export function sanitizeIdentity(raw: unknown, fallback: PeerIdentity): PeerIdentity {
  const r = (raw ?? {}) as Partial<PeerIdentity>
  const name = typeof r.name === 'string' ? capName(r.name) : ''
  const color =
    typeof r.color === 'string' && PRESENCE_COLORS.includes(r.color) ? r.color : fallback.color
  return { name: name || fallback.name, color }
}

/** Coerce an untrusted value into a finite number: a non-number, NaN or ±Infinity → 0. Snapshot
 *  numbers are drawn straight onto a canvas, so a NaN/Infinity off the wire must never survive. */
function finiteNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** One obstacle off the wire → a safe DinoObstacleSnap, or null to DROP it (bad/absent kind). */
function sanitizeDinoObstacle(raw: unknown): DinoObstacleSnap | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.kind !== 'cactus' && o.kind !== 'bird') return null
  return {
    kind: o.kind,
    x: finiteNum(o.x),
    y: finiteNum(o.y),
    sx: finiteNum(o.sx),
    sw: finiteNum(o.sw),
    sh: finiteNum(o.sh),
    flap: finiteNum(o.flap)
  }
}

/** THE one door for an untrusted dino cast (the hub applies ONLY this value). Returns null unless
 *  the payload is `{ nodeId: non-empty string, snap: {...} }`; caps the nodeId at REF_MAX_LEN like
 *  focus, coerces every snap number to finite (garbage → 0) and every flag to boolean, and CLAMPS
 *  obstacles to the first DINO_MAX_OBSTACLES (each sanitized; a bad-kind one is dropped). Anything
 *  malformed → null, so the flood/garbage guard cannot be bypassed. */
export function sanitizeDinoPayload(
  payload: unknown
): { nodeId: string; snap: DinoSnapshot } | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (typeof p.nodeId !== 'string' || p.nodeId === '') return null
  const nodeId = capCodePoints(p.nodeId, REF_MAX_LEN)
  if (typeof p.snap !== 'object' || p.snap === null) return null
  const s = p.snap as Record<string, unknown>
  const rawObstacles = Array.isArray(s.obstacles) ? s.obstacles : []
  const obstacles: DinoObstacleSnap[] = []
  for (const raw of rawObstacles.slice(0, DINO_MAX_OBSTACLES)) {
    const ob = sanitizeDinoObstacle(raw)
    if (ob) obstacles.push(ob)
  }
  const snap: DinoSnapshot = {
    y: finiteNum(s.y),
    ducking: Boolean(s.ducking),
    crashed: Boolean(s.crashed),
    started: Boolean(s.started),
    score: finiteNum(s.score),
    speed: finiteNum(s.speed),
    groundScroll: finiteNum(s.groundScroll),
    obstacles
  }
  return { nodeId, snap }
}
