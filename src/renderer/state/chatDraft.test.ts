// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_DRAFTS_KEY,
  DRAFTS_MAX,
  DRAFT_MAX_AGE_MS,
  DRAFT_SAVE_DELAY_MS,
  DRAFT_STORE_MAX_CHARS,
  flushChatDrafts,
  mergeStoredDrafts,
  parseStoredDrafts,
  useChatDraft
} from './chatDraft'

const NOW = 1_800_000_000_000
const drafts = () => useChatDraft.getState().drafts
const setDraft = (nodeId: string, next: string | ((cur: string) => string)) =>
  useChatDraft.getState().setDraft(nodeId, next)
const stored = () => JSON.parse(localStorage.getItem(CHAT_DRAFTS_KEY) ?? 'null')
const storedFile = (drafts: Record<string, unknown>) => JSON.stringify({ v: 1, drafts })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  flushChatDrafts()
  localStorage.removeItem(CHAT_DRAFTS_KEY)
  useChatDraft.setState({ drafts: {} })
})
afterEach(() => {
  flushChatDrafts()
  vi.useRealTimers()
})

describe('useChatDraft in memory', () => {
  it('keeps a draft per node', () => {
    setDraft('a', 'one')
    setDraft('b', 'two')

    expect(drafts()).toEqual({ a: 'one', b: 'two' })
  })

  it('hands a function the current draft', () => {
    setDraft('a', 'one')

    setDraft('a', (cur) => `${cur} more`)

    expect(drafts().a).toBe('one more')
  })

  it('drops the entry when the draft is emptied', () => {
    setDraft('a', 'one')

    setDraft('a', '')

    expect(drafts()).toEqual({})
  })

  it('leaves the map alone when nothing changes', () => {
    setDraft('a', 'one')
    const before = drafts()

    setDraft('a', 'one')

    expect(drafts()).toBe(before)
  })
})

describe('useChatDraft storage', () => {
  it('writes half a second after the last change, not on every keystroke', () => {
    setDraft('a', 'o')
    setDraft('a', 'on')
    vi.advanceTimersByTime(DRAFT_SAVE_DELAY_MS - 1)
    const early = localStorage.getItem(CHAT_DRAFTS_KEY)

    vi.advanceTimersByTime(1)

    expect(early).toBeNull()
    expect(stored()).toEqual({ v: 1, drafts: { a: { text: 'on', at: NOW } } })
  })

  it('removes a stored draft once it is emptied', () => {
    setDraft('a', 'one')
    flushChatDrafts()

    setDraft('a', '')
    flushChatDrafts()

    expect(stored()).toEqual({ v: 1, drafts: {} })
  })

  it("keeps another window's drafts when it writes", () => {
    localStorage.setItem(CHAT_DRAFTS_KEY, storedFile({ other: { text: 'from tab B', at: NOW } }))

    setDraft('a', 'from tab A')
    flushChatDrafts()

    expect(stored().drafts).toEqual({
      other: { text: 'from tab B', at: NOW },
      a: { text: 'from tab A', at: NOW }
    })
  })

  it('keeps a draft across a restart', async () => {
    setDraft('a', 'half a thought')
    flushChatDrafts()
    vi.resetModules()

    const fresh = await import('./chatDraft')

    expect(fresh.useChatDraft.getState().drafts).toEqual({ a: 'half a thought' })
  })
})

describe('parseStoredDrafts', () => {
  it('reads well-formed entries', () => {
    expect(parseStoredDrafts(storedFile({ a: { text: 'x', at: NOW } }), NOW)).toEqual({ a: { text: 'x', at: NOW } })
  })

  it('reads anything that is not a version-1 map as empty', () => {
    for (const raw of [null, '', 'not json', '[]', '{"v":2,"drafts":{}}', '{"v":1,"drafts":[]}']) {
      expect(parseStoredDrafts(raw, NOW)).toEqual({})
    }
  })

  it('drops malformed, empty, oversized, expired and future entries', () => {
    const raw = storedFile({
      'bad id with spaces': { text: 'x', at: NOW },
      notAnObject: 'x',
      noText: { at: NOW },
      empty: { text: '', at: NOW },
      huge: { text: 'x'.repeat(DRAFT_STORE_MAX_CHARS + 1), at: NOW },
      old: { text: 'x', at: NOW - DRAFT_MAX_AGE_MS - 1 },
      future: { text: 'x', at: NOW + 10 * 60_000 },
      good: { text: 'x', at: NOW }
    })

    expect(Object.keys(parseStoredDrafts(raw, NOW))).toEqual(['good'])
  })

  it('keeps only the newest drafts', () => {
    const many = Object.fromEntries(
      Array.from({ length: DRAFTS_MAX + 5 }, (_, i) => [`n${i}`, { text: 'x', at: NOW - i }])
    )

    const kept = parseStoredDrafts(storedFile(many), NOW)

    expect(Object.keys(kept)).toHaveLength(DRAFTS_MAX)
    expect(kept[`n${DRAFTS_MAX}`]).toBeUndefined()
    expect(kept.n0).toBeDefined()
  })
})

describe('mergeStoredDrafts', () => {
  it('does not store a draft over the size cap, and drops its older stored copy', () => {
    const merged = mergeStoredDrafts(
      { a: { text: 'short', at: NOW - 1 } },
      new Map([['a', { text: 'x'.repeat(DRAFT_STORE_MAX_CHARS + 1), at: NOW }]])
    )

    expect(merged).toEqual({})
  })
})
