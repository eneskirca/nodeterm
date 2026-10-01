// What travels inside a live link's E2E tunnel, besides raw pty frames and pty:* events.
// The viewer's namespace is `watch:` on purpose: the OWNER's IPC is `watchLink:`, which the relay
// host refuses from every peer as host-only BEFORE any policy runs (src/shared/host-control.ts).

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_EVENT_PREFIX = 'watch:'
export const WATCH_EVENT = {
  meta: 'watch:meta',
  keyframe: 'watch:keyframe',
  waiting: 'watch:waiting',
  chat: 'watch:chat',
  end: 'watch:end'
} as const
/** The one message a viewer may send (Commenter links only). */
export const WATCH_CHAT_CAST = 'watch:chat'

export type WatchLinkRole = 'viewer' | 'commenter'
export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked'] as const
export type WatchLinkEndReason = (typeof WATCH_END_REASONS)[number]
export function isWatchEndReason(x: unknown): x is WatchLinkEndReason {
  return typeof x === 'string' && (WATCH_END_REASONS as readonly string[]).includes(x)
}

export interface WatchMeta {
  v: number
  role: WatchLinkRole
  /** Sharer-supplied; render as text, marked as set by the sharer. */
  label: string
  title: string
  /** Epoch ms on the host's clock, corrected to the server's. */
  expiresAt: number
  cols: number
  rows: number
}
export interface WatchKeyframe {
  sessionId: string
  /** The visible screen with SGR, or '' when the backend has no visible-only capture. */
  screen: string
  /** tmux paints its client on the alternate screen; the viewer must switch to it BEFORE painting,
   *  or every tmux redraw scrolls into the viewer's history (CLAUDE.md, co-attach seeding). */
  altScreen: boolean
  /** The host's cursor when the screen was captured, 0-based (tmux `cursor_x` / `cursor_y`). tmux's
   *  following stream moves the cursor RELATIVE to where it believes the tty cursor is, and a capture
   *  trims trailing blanks, so without this every keyframe offsets what is typed next. Absent when
   *  the host could not read it; the viewer then leaves the cursor where the screen text ends. */
  cursor?: { x: number; y: number }
}
export interface WatchChatMessage {
  id: string
  name: string
  text: string
  at: number
  from: 'viewer' | 'sharer'
}

/** Chat caps, in UTF-16 units (what an input's `maxLength` counts), never cutting a code point. */
export const CHAT_TEXT_MAX = 500
export const CHAT_NAME_MAX = 32
// C0 and C1 controls, DEL, and the ESC that starts every sequence. A newline becomes a space: chat
// is one line, and a pasted multi-line block must not reflow the owner's popover.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g
// The directional formatting characters: ALM (U+061C), LRM/RLM (U+200E/F), the embeddings and
// overrides (U+202A–E) and the isolates (U+2066–9). Chat is text one stranger wrote for the owner and
// every other viewer to read; an RLO reorders everything drawn after it. Escaped, never literal (a
// literal one is invisible in review). The same set as @shared/presence's BIDI_CONTROL_CHARS — this
// directory imports nothing from outside itself (it is vendored byte for byte into nodeterm-web), so
// the class is restated here and src/core/watch-link/wire.test.ts pins the two equal.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
/** How much of a raw value the cleaning chain may look at, as a multiple of the cap: a cast is
 *  attacker-sized, and the regex chain must not run over megabytes to keep 500 units of it. Generous
 *  enough that whitespace and controls collapsing away never empty an honest message. */
const RAW_FACTOR = 4

/** At most `max` UTF-16 units, cut BETWEEN code points: a plain `slice` can split a surrogate pair
 *  and leave a lone surrogate, which renders as a replacement glyph. Stops reading at the cap. */
function capUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  // Bound the input BEFORE the regex chain (by code point), then cap the cleaned text the same way.
  const bounded = capUnits(raw, max * RAW_FACTOR)
  const cleaned = bounded
    .replace(/[\r\n\t]+/g, ' ')
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .trim()
  const s = capUnits(cleaned, max).trim()
  return s ? s : null
}
export const sanitizeChatText = (raw: unknown): string | null => clean(raw, CHAT_TEXT_MAX)
export const sanitizeChatName = (raw: unknown): string | null => clean(raw, CHAT_NAME_MAX)
