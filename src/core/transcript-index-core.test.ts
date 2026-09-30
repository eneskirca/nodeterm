import { describe, expect, it } from 'vitest'
import {
  extractEntryFields,
  makeSnippet,
  searchEntries,
  planRefresh,
  INDEX_TEXT_CAP_BYTES,
  type ScanFile,
  type TranscriptIndexEntry
} from './transcript-index-core'

const raw = [
  JSON.stringify({ type: 'user', cwd: '/Users/me/proj', message: { content: 'fix the tmux config please' } }),
  JSON.stringify({ type: 'assistant', cwd: '/Users/me/proj', message: { content: [{ type: 'text', text: 'editing tmux.conf now' }] } })
].join('\n')

describe('extractEntryFields', () => {
  it('pulls cwd, first-user-message title, and concatenated text', () => {
    const f = extractEntryFields(raw)
    expect(f.cwd).toBe('/Users/me/proj')
    expect(f.title).toBe('fix the tmux config please')
    expect(f.text).toContain('fix the tmux config')
    expect(f.text).toContain('editing tmux.conf now')
  })

  it('trims a long title to ~80 chars and caps text at INDEX_TEXT_CAP_BYTES', () => {
    const long = 'x'.repeat(500)
    const big = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ type: 'user', cwd: '/c', message: { content: long } })
    ).join('\n')
    const f = extractEntryFields(big)
    expect(f.title.length).toBeLessThanOrEqual(80)
    expect(f.text.length).toBeLessThanOrEqual(INDEX_TEXT_CAP_BYTES)
  })

  it('returns empty fields for unparseable input', () => {
    expect(extractEntryFields('garbage\n{bad json')).toEqual({ cwd: '', title: '', text: '' })
  })
})

describe('makeSnippet', () => {
  it('centers on the match and trims', () => {
    const s = makeSnippet('a'.repeat(300) + 'NEEDLE' + 'b'.repeat(300), 'needle')
    expect(s.toLowerCase()).toContain('needle')
    expect(s.length).toBeLessThanOrEqual(170)
  })
})

describe('searchEntries', () => {
  const entries: TranscriptIndexEntry[] = [
    { sessionId: 's1', transcriptPath: '/p/s1.jsonl', cwd: '/Users/me/alpha', mtime: 100, title: 'old tmux work', text: 'tmux mouse mode' },
    { sessionId: 's2', transcriptPath: '/p/s2.jsonl', cwd: '/Users/me/beta', mtime: 200, title: 'recent', text: 'something about TMUX clipboard' }
  ]

  it('matches title+text case-insensitively, newest first, capped', () => {
    const hits = searchEntries(entries, 'tmux', 20)
    expect(hits.map((h) => h.sessionId)).toEqual(['s2', 's1'])
    expect(hits[0].projectLabel).toBe('beta')
    expect(hits[0].snippet.toLowerCase()).toContain('tmux')
  })

  it('returns nothing for queries shorter than 2 chars', () => {
    expect(searchEntries(entries, 't')).toEqual([])
  })

  it('respects the limit', () => {
    expect(searchEntries(entries, 'tmux', 1)).toHaveLength(1)
  })

  it('names the account whose root holds a hit, so its resume runs under that login', () => {
    const hits = searchEntries(entries, 'tmux', 20, (p) => (p === '/p/s1.jsonl' ? 'work' : undefined))
    expect(hits.find((h) => h.sessionId === 's1')?.accountId).toBe('work')
    expect('accountId' in hits.find((h) => h.sessionId === 's2')!).toBe(false)
  })
})

describe('planRefresh', () => {
  const prior: TranscriptIndexEntry[] = [
    { sessionId: 'a', transcriptPath: '/p/a.jsonl', cwd: '/c', mtime: 100, title: 't', text: 'x' },
    { sessionId: 'b', transcriptPath: '/p/b.jsonl', cwd: '/c', mtime: 100, title: 't', text: 'x' }
  ]

  it('re-reads new and changed files, keeps unchanged, drops vanished', () => {
    const scan: ScanFile[] = [
      { sessionId: 'a', transcriptPath: '/p/a.jsonl', mtime: 100 }, // unchanged -> keep
      { sessionId: 'b', transcriptPath: '/p/b.jsonl', mtime: 200 }, // changed -> read
      { sessionId: 'c', transcriptPath: '/p/c.jsonl', mtime: 50 }   // new -> read
    ]
    const plan = planRefresh(prior, scan)
    expect(plan.keep.map((e) => e.sessionId)).toEqual(['a'])
    expect(plan.toRead.map((f) => f.sessionId).sort()).toEqual(['b', 'c'])
  })

  it('drops entries whose file is gone (not in scan)', () => {
    const plan = planRefresh(prior, [{ sessionId: 'a', transcriptPath: '/p/a.jsonl', mtime: 100 }])
    expect(plan.keep.map((e) => e.sessionId)).toEqual(['a'])
    expect(plan.toRead).toEqual([])
  })
})
