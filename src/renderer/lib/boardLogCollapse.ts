/**
 * Render-time folding of the card activity feed: consecutive rows by the same author, of the same
 * event type, within two minutes, show as ONE "×N" row that expands to the rows it holds.
 *
 * The log itself (`.nodeterm/board-log.jsonl`, append-only and git-shared) is NEVER rewritten —
 * this is a view over it, so a teammate on an older build, and this user expanding the row, still
 * see every entry exactly as it was written.
 *
 * Rules:
 *  - comments never fold (each one is something a person wrote);
 *  - `NEVER_COLLAPSE` types never fold — `agent-message` and `agent-read-cookies` are AUDIT rows:
 *    a trace whose rows can be folded away is a trace a reader can miss one row of — and neither do
 *    an issue's `run-started` / `run-ended` rows, which each name a different session;
 *  - the window is anchored at the group's NEWEST row, so a "×N" never spans more than two
 *    minutes. A chained window (each row within 2 min of the previous one) would let a card dragged
 *    back and forth every 90 seconds for an hour collapse into a single row claiming one moment;
 *  - "same author" is name AND colour: that pair is the presence identity the feed attributes by.
 */
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'

export const BOARD_LOG_COLLAPSE_WINDOW_MS = 2 * 60_000

/** Always one row each: the audit types, and an issue's run history (each run row names a
 *  different session — a "×N" would hide exactly which sessions ran). */
export const NEVER_COLLAPSE: ReadonlySet<BoardLogEvent['type']> = new Set<BoardLogEvent['type']>([
  'agent-message',
  'agent-read-cookies',
  'run-started',
  'run-ended',
  // Each names a different station — a "×N" would hide exactly which stations stopped.
  'station-failed',
  // A report is superseded by the next one, so which came LAST is the fact a reader needs — a
  // "×N" row would hide it.
  'station-reported'
])

export type FeedItem =
  | { kind: 'single'; entry: BoardLogEntry }
  /** Two or more foldable rows, newest first. `key` is the newest row's id. */
  | { kind: 'group'; key: string; entries: BoardLogEntry[] }

const foldable = (e: BoardLogEntry): boolean =>
  e.kind === 'event' && !!e.event && !NEVER_COLLAPSE.has(e.event.type)

const sameRun = (head: BoardLogEntry, e: BoardLogEntry): boolean =>
  foldable(e) &&
  e.author?.name === head.author?.name &&
  e.author?.color === head.author?.color &&
  e.event?.type === head.event?.type &&
  Math.abs(head.ts - e.ts) <= BOARD_LOG_COLLAPSE_WINDOW_MS

/** Folds a newest-first, card-scoped feed. Pure; never mutates its input. */
export function collapseFeed(feed: readonly BoardLogEntry[]): FeedItem[] {
  const out: FeedItem[] = []
  let i = 0
  while (i < feed.length) {
    const head = feed[i]
    let j = i + 1
    if (foldable(head)) while (j < feed.length && sameRun(head, feed[j])) j++
    out.push(
      j - i > 1
        ? { kind: 'group', key: head.id, entries: feed.slice(i, j) }
        : { kind: 'single', entry: head }
    )
    i = j
  }
  return out
}
