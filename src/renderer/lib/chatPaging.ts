import type { ChatMessage, ChatPart, ChatTranscriptResult } from '@shared/types'
import { BASH_COMMAND_TOOL, sentCommand } from '@shared/chat-command'

/**
 * Pure paging state for the ⌘M chat panel (`nodes/ChatPanel.tsx`). The panel reads a SMALL tail
 * window first and older windows as the user scrolls up (`chat.readTranscript`'s `page` argument —
 * see `shared/chat-page.ts` and the ⌘M bullet in CLAUDE.md). Everything that decides what the
 * thread looks like after a read lives here so it is unit-tested without a DOM.
 */

/** First (and every turn-end / ↻) read: the newest window only. Small on purpose — it is what the
 *  user waits for, and on an SSH project it crosses the network on every open and every turn end. */
export const CHAT_TAIL_PAGE_BYTES = 256 * 1024
/** Each older page fetched on scroll-up. Larger than the tail: the user is already reading. */
export const CHAT_OLDER_PAGE_BYTES = 512 * 1024
/** Within this many px of the top, the next older page is fetched. */
export const CHAT_OLDER_FETCH_THRESHOLD_PX = 200

export interface ChatThread {
  /** Which transcript these messages came from. Keys are byte offsets INTO ONE FILE, so a thread
   *  of another session/node must never be merged by key with this one. */
  identity: string
  messages: ChatMessage[]
  /** Cursor of the OLDEST loaded page: pass as `before` to fetch the next older one. `null` = the
   *  start of the transcript is loaded (or the reader does not page — grok). */
  olderCursor: number | null
  /** Tool results whose `tool_use` has not been loaded yet (it is in an older page), by id. */
  pending: ReadonlyMap<string, string>
}

export const emptyThread = (identity: string): ChatThread => ({
  identity,
  messages: [],
  olderCursor: null,
  pending: new Map()
})

type ToolPart = Extract<ChatPart, { kind: 'tool' }>

/**
 * Attach held results to the tool parts they belong to. Returns a new array in which ONLY the
 * messages that changed are new objects (the rest keep identity, so their bubbles don't
 * re-render), plus what is still unclaimed. A tool that already has a result keeps it.
 */
export function attachCarried(
  messages: ChatMessage[],
  pending: ReadonlyMap<string, string>
): { messages: ChatMessage[]; pending: Map<string, string> } {
  const left = new Map(pending)
  if (left.size === 0) return { messages, pending: left }
  const out = messages.map((m) => {
    let changed = false
    const parts = m.parts.map((p) => {
      if (p.kind !== 'tool' || !p.id || p.result || !left.has(p.id)) return p
      const withResult: ToolPart = { ...p, result: left.get(p.id)! }
      left.delete(p.id)
      changed = true
      return withResult
    })
    return changed ? { ...m, parts } : m
  })
  return { messages: out, pending: left }
}

/** Held results whose tool is ALREADY loaded can never be claimed (the tool has its own result —
 *  `attachCarried` never overwrites one), so holding them until the start of the file is waste. */
function pruneLoaded(messages: ChatMessage[], pending: Map<string, string>): Map<string, string> {
  if (pending.size === 0) return pending
  for (const m of messages) for (const p of m.parts) if (p.kind === 'tool' && p.id) pending.delete(p.id)
  return pending
}

const carriedOf = (res: ChatTranscriptResult): Array<[string, string]> =>
  (res.unmatchedResults ?? []).map((r) => [r.id, r.result])

/**
 * Apply a TAIL read (first open, turn-end reload, ↻) to the thread.
 *
 * - Another identity, or a reader that returned the whole thing (`olderCursor` null — grok, a
 *   small file, a legacy-shaped result): replace.
 * - Otherwise merge by key: every loaded message older than the tail window is KEPT (older pages
 *   the user already scrolled through survive a turn end), everything from the window on is
 *   replaced by the tail — so nothing duplicates, and the optimistic unkeyed "just sent" bubble
 *   is dropped because the transcript now carries the real one (a LIVE read passes
 *   `carryUnconfirmed` and keeps it until the transcript does — see `unconfirmedSends`).
 * - Unless no loaded message reaches into the new window: then the turn wrote more than a whole
 *   window, and the bytes between what is rendered and the new window were never read. Stitching
 *   would hide them silently, so the thread resets to the tail and pages back normally.
 */
export function applyTail(
  t: ChatThread,
  identity: string,
  res: ChatTranscriptResult,
  opts: { carryUnconfirmed?: boolean } = {}
): ChatThread {
  const next = mergeTail(t, identity, res)
  if (!opts.carryUnconfirmed || t.identity !== identity) return next
  const carry = unconfirmedSends(t, res)
  return carry.length === 0 ? next : { ...next, messages: [...next.messages, ...carry] }
}

function mergeTail(t: ChatThread, identity: string, res: ChatTranscriptResult): ChatThread {
  const cursor = res.olderCursor ?? null
  const fresh = (): ChatThread => ({
    identity,
    messages: res.messages,
    olderCursor: cursor,
    pending: cursor === null ? new Map() : new Map(carriedOf(res))
  })
  if (t.identity !== identity || cursor === null) return fresh()
  const keyed = t.messages.filter((m) => m.key !== undefined)
  if (!keyed.some((m) => m.key! >= cursor)) return fresh()
  const kept = keyed.filter((m) => m.key! < cursor)
  // A result written this turn for a tool rendered from an earlier read arrives as carried.
  const attached = attachCarried(kept, new Map([...t.pending, ...carriedOf(res)]))
  const messages = [...attached.messages, ...res.messages]
  return {
    identity,
    messages,
    olderCursor: t.olderCursor,
    pending: t.olderCursor === null ? new Map() : pruneLoaded(messages, attached.pending)
  }
}

const userText = (m: ChatMessage): string =>
  m.parts
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('')
    .trim()

// Whitespace-insensitive, for matching a send against its transcript copy, which is not always
// byte-identical to what was sent — a typed send turns tabs into spaces (core/typed-input.ts), and a
// multi-line paste is recorded with its line breaks doubled and trailing spaces kept. Not for
// commands: `sentCommand` parses `userText` as typed.
const matchText = (m: ChatMessage): string => userText(m).replace(/\s+/g, ' ')

/** The thread's TRAILING unkeyed user messages — the optimistic sends a live read may still carry. */
function trailingSends(t: ChatThread): ChatMessage[] {
  const trailing: ChatMessage[] = []
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]
    if (m.key !== undefined || m.role !== 'user') break
    trailing.unshift(m)
  }
  return trailing
}

/**
 * Would a LIVE read (`applyTail` with `carryUnconfirmed`) confirm every optimistic send the thread
 * is waiting on? False when nothing was waiting, or for another transcript. The panel uses it to
 * retire its optimistic working row when no hook will: a local command (`/model`, `!ls`) is
 * confirmed only by its command record, and fires no state change.
 */
export function tailConfirmsSends(t: ChatThread, identity: string, res: ChatTranscriptResult): boolean {
  return t.identity === identity && trailingSends(t).length > 0 && unconfirmedSends(t, res).length === 0
}

/** A command message's tool part (`/model`, `!`), as the reader renders a command record. */
function commandPart(m: ChatMessage): { name: string; arg: string } | null {
  if (m.role !== 'assistant' || m.parts.length !== 1) return null
  const p = m.parts[0]
  if (p.kind !== 'tool' || (p.name !== BASH_COMMAND_TOOL && !p.name.startsWith('/'))) return null
  return { name: p.name, arg: p.arg.trim() }
}

/**
 * The optimistic "just sent" bubbles a LIVE tail read must not drop. A live read fires on the very
 * hook event the send caused (UserPromptSubmit), racing the agent's own transcript write — so the
 * tail it returns often does not contain the prompt yet, and a plain merge (which keeps only keyed
 * messages) would erase the user's own words for the rest of the turn.
 *
 * Carried: the thread's TRAILING unkeyed `user` messages (in a paged thread only sends are
 * unkeyed; grok's thread is unkeyed throughout, but its whole-file read contains every prompt it
 * rendered, so each one is matched and dropped). Each one is dropped when the new read contains a
 * user message with the same text (whitespace-insensitive — `matchText`), ONE-FOR-ONE, and only
 * among messages NEWER than anything the thread had keyed — an older identical "yes" already on
 * screen must not confirm a new "yes". A sent slash command / `!` line is confirmed the same way by
 * a command tool part (`sentCommand`): same name, and the same trimmed arg when both sides have one.
 *
 * A plain reload (↻, and the LAST turn-end settle reload — `turnEndReloadCarries`) never carries: a
 * send whose transcript line never matches (a CLI that rewrites the prompt, a queued prompt removed
 * from the CLI's queue) must not stay duplicated. Earlier turn-end reloads do carry: a prompt queued
 * mid-turn reaches the transcript only when the CLI takes it from its queue.
 */
function unconfirmedSends(t: ChatThread, res: ChatTranscriptResult): ChatMessage[] {
  const trailing = trailingSends(t)
  if (trailing.length === 0) return []
  let newest = -Infinity
  for (const m of t.messages) if (m.key !== undefined && m.key > newest) newest = m.key
  // Known limitation: "newer than anything keyed" is all this can know. A line written after the
  // last read by someone ELSE — the same command (or, on the exact-text path, the same text) typed
  // in the TERMINAL — is indistinguishable from the composer's own send and confirms it early. The
  // transcript records no sender to tell them apart.
  const fresh = res.messages.filter((m) => m.key === undefined || m.key > newest)
  const available = fresh.filter((m) => m.role === 'user').map(matchText)
  // A slash command / `!` line is recorded as a command, which the reader renders as an assistant
  // tool part — never as the typed text — so a send of one is confirmed by that part instead.
  const commands = fresh.map(commandPart).filter((c): c is { name: string; arg: string } => c !== null)
  return trailing.filter((m) => {
    const i = available.indexOf(matchText(m))
    if (i >= 0) {
      available.splice(i, 1)
      return false
    }
    const sent = sentCommand(userText(m))
    if (!sent) return true
    const j = commands.findIndex((c) => c.name === sent.name && (!c.arg || !sent.arg || c.arg === sent.arg))
    if (j < 0) return true
    commands.splice(j, 1)
    return false
  })
}

/**
 * Prepend an OLDER page (a read with `before` = the thread's cursor). Held results claim their
 * tools in it; its own carried results (tools older still) join the held set; at the start of the
 * file whatever is still held is dropped — nothing older can ever claim it.
 *
 * Defensive: messages at or after the oldest loaded key are skipped (no duplicate), and a cursor
 * that did not move backwards ends paging rather than re-requesting the same window forever.
 */
export function applyOlder(t: ChatThread, res: ChatTranscriptResult): ChatThread {
  let oldest = Infinity
  for (const m of t.messages) if (m.key !== undefined && m.key < oldest) oldest = m.key
  const older = res.messages.filter((m) => m.key === undefined || m.key < oldest)
  let cursor = res.olderCursor ?? null
  if (cursor !== null && t.olderCursor !== null && cursor >= t.olderCursor) cursor = null
  const attached = attachCarried(older, new Map([...t.pending, ...carriedOf(res)]))
  return {
    identity: t.identity,
    messages: [...attached.messages, ...t.messages],
    olderCursor: cursor,
    pending: cursor === null ? new Map() : pruneLoaded(attached.messages, attached.pending)
  }
}

/** Scroll position that keeps the same content under the viewport after content was inserted
 *  ABOVE it: shift by exactly the height that was added. */
export function anchoredScrollTop(prev: { scrollTop: number; scrollHeight: number }, nextScrollHeight: number): number {
  return prev.scrollTop + (nextScrollHeight - prev.scrollHeight)
}

/**
 * Fetch the next older page? Only near the top — or when the content is shorter than the viewport
 * (it cannot scroll, so "near the top" would never be reached by a user) — only when there is one,
 * one at a time, never on its own after a failure (the retry row owns that), and never before the
 * first read landed.
 *
 * And never WITHOUT A LAYOUT BOX: a collapsed node keeps its ⌘M panel mounted under
 * `display:none`, where scrollTop, scrollHeight and clientHeight all read 0. Zero looks exactly
 * like "at the top", and every page landing re-triggers the check — so an ungated hidden panel
 * paged the whole history in the background (one ssh read per page on an SSH project). Paging
 * resumes when the panel gets a size again.
 */
export function shouldFetchOlder(s: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  olderCursor: number | null
  inFlight: boolean
  failed: boolean
  loaded: boolean
}, threshold = CHAT_OLDER_FETCH_THRESHOLD_PX): boolean {
  if (!s.loaded || s.inFlight || s.failed || s.olderCursor === null) return false
  if (s.clientHeight <= 0) return false
  return s.scrollHeight <= s.clientHeight || s.scrollTop <= threshold
}
