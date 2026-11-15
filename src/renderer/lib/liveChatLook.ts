// The live-link viewer page's chat look, for the owner's Live chat drawer. COPIED from nodeterm-web
// `src/lib/watch-viewer/chat-panel.ts` (chatNameColor, VIEWER_NAME_COLORS, nearBottom,
// NEAR_BOTTOM_PX, newMessagesLabel, chatClock) — never imported across repositories.
//
// WHY the drawer and the web page must match: the same viewer gets the same colour on both. The owner
// reads a viewer as "the orange one" in the drawer while everyone watching sees that viewer's lines in
// orange on the page; a drift splits one person into two colours. `liveChatLook.test.ts` pins the
// hash against values computed with the web page's own function — change either side and re-run it.
//
// The hex table is a deliberate exception to "semantic tokens only" (CLAUDE.md, Semantic colours), the
// same class as the agent brand colours: it is ANOTHER surface's palette, and copying it verbatim is
// the point. The drawer hands a colour to CSS as `--live-name`, where the light theme darkens it toward
// the ink (styles.css). The sharer's colour is NOT copied: the drawer marks the owner's lines with a
// token and the "Sharer" badge, and — as on the page — no viewer name is ever drawn in it (the badge is
// the host's word, never a name's).

/** Viewer name colours, readable on the page's near-black. No green near the sharer's. */
export const VIEWER_NAME_COLORS = [
  '#ff7b72', '#ffa657', '#f2cc60', '#79c0ff', '#58a6ff', '#a5a0ff',
  '#d2a8ff', '#ff9bce', '#f778ba', '#56d4dd', '#ffb4a1', '#c9b6ff'
] as const

/** One colour per name, the same on every viewer's page (FNV-1a over the UTF-16 units). Hash the
 *  name as the viewer sent it, before any display cleaning, so it matches the page. */
export function chatNameColor(name: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return VIEWER_NAME_COLORS[(h >>> 0) % VIEWER_NAME_COLORS.length]
}

/** How close to the end counts as "reading the newest message" (a fractional scroll position, a line
 *  still settling). */
export const NEAR_BOTTOM_PX = 32

export function nearBottom(m: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= NEAR_BOTTOM_PX
}

/** "14:02" in the owner's own clock and locale; nothing for a time that cannot be read. */
export function chatClock(at: unknown, locale?: string): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at)
}
