import { describe, expect, it } from 'vitest'
import type { BoardLogEntry, BoardLogEvent } from '@shared/types'
import { BOARD_LOG_COLLAPSE_WINDOW_MS, NEVER_COLLAPSE, collapseFeed } from './boardLogCollapse'

const ME = { name: 'enes', color: '#0a84ff' }
const AGENT = { name: 'claude-1', color: '#d97757' }
let n = 0
const ev = (ts: number, type: BoardLogEvent['type'], author = ME, extra: Partial<BoardLogEvent> = {}): BoardLogEntry => ({
  id: `e${n++}`,
  ts,
  author,
  nodeId: 'card',
  kind: 'event',
  event: { type, ...extra }
})
const comment = (ts: number, author = ME): BoardLogEntry => ({
  id: `c${n++}`,
  ts,
  author,
  nodeId: 'card',
  kind: 'comment',
  text: 'hi'
})
const MIN = 60_000
const shape = (items: ReturnType<typeof collapseFeed>): Array<number> =>
  items.map((i) => (i.kind === 'group' ? i.entries.length : 1))

describe('collapseFeed (render-time only — the log itself is never rewritten)', () => {
  it('folds consecutive same-author same-type events within 2 minutes into one ×N row', () => {
    // newest-first, like the feed
    const feed = [ev(10 * MIN, 'card-moved'), ev(9.5 * MIN, 'card-moved'), ev(9 * MIN, 'card-moved')]
    const out = collapseFeed(feed)
    expect(shape(out)).toEqual([3])
    expect(out[0].kind === 'group' && out[0].entries.map((e) => e.id)).toEqual(feed.map((e) => e.id))
  })

  it('keeps the entries it folds, newest first, so the row can expand', () => {
    const feed = [ev(2 * MIN, 'due-set'), ev(1 * MIN, 'due-set')]
    const out = collapseFeed(feed)
    expect(out[0].kind).toBe('group')
  })

  it('the window is anchored at the group’s NEWEST row — a ×N never spans more than 2 minutes', () => {
    // 90 s apart each: a chained window would fold all four; an anchored one cannot.
    const feed = [ev(6 * MIN, 'card-moved'), ev(4.5 * MIN, 'card-moved'), ev(3 * MIN, 'card-moved'), ev(1.5 * MIN, 'card-moved')]
    expect(shape(collapseFeed(feed))).toEqual([2, 2])
  })

  it('does not fold across a different author, a different type, or a comment between them', () => {
    expect(shape(collapseFeed([ev(3, 'card-moved'), ev(2, 'card-moved', AGENT), ev(1, 'card-moved')]))).toEqual([1, 1, 1])
    expect(shape(collapseFeed([ev(3, 'card-moved'), ev(2, 'due-set'), ev(1, 'card-moved')]))).toEqual([1, 1, 1])
    expect(shape(collapseFeed([ev(3, 'card-moved'), comment(2), ev(1, 'card-moved')]))).toEqual([1, 1, 1])
  })

  it('never folds comments', () => {
    expect(shape(collapseFeed([comment(3), comment(2), comment(1)]))).toEqual([1, 1, 1])
  })

  // run-started / run-ended are an issue's run history, and station-failed names a station: each
  // row names a DIFFERENT session, so a "×3" would hide exactly which sessions ran (or stopped) —
  // the thing that panel exists to show.
  it('never folds the audit types or the run history, however alike the rows are', () => {
    expect([...NEVER_COLLAPSE].sort()).toEqual(['agent-message', 'agent-read-cookies', 'run-ended', 'run-started', 'station-failed', 'station-reported'])
    for (const type of NEVER_COLLAPSE) {
      const feed = [ev(3, type, AGENT), ev(2, type, AGENT), ev(1, type, AGENT)]
      expect(shape(collapseFeed(feed))).toEqual([1, 1, 1])
    }
  })

  it('an author with the same name but a different colour is someone else', () => {
    const other = { name: 'enes', color: '#ff0000' }
    expect(shape(collapseFeed([ev(2, 'card-moved'), ev(1, 'card-moved', other)]))).toEqual([1, 1])
  })

  it('exactly 2 minutes still folds; a millisecond more does not', () => {
    expect(shape(collapseFeed([ev(BOARD_LOG_COLLAPSE_WINDOW_MS, 'card-moved'), ev(0, 'card-moved')]))).toEqual([2])
    expect(shape(collapseFeed([ev(BOARD_LOG_COLLAPSE_WINDOW_MS + 1, 'card-moved'), ev(0, 'card-moved')]))).toEqual([1, 1])
  })

  it('tolerates an event entry with no event payload (renders it alone)', () => {
    const broken = { ...ev(2, 'card-moved'), event: undefined }
    expect(shape(collapseFeed([broken, broken]))).toEqual([1, 1])
  })

  it('does not mutate its input', () => {
    const feed = [ev(2, 'card-moved'), ev(1, 'card-moved')]
    const copy = JSON.parse(JSON.stringify(feed))
    collapseFeed(feed)
    expect(feed).toEqual(copy)
  })
})
