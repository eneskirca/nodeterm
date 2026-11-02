import { describe, expect, it } from 'vitest'
import type { PullLineComment } from '@shared/github-pull-detail'
import { pullLineThreads } from './pullLineThreads'

const comment = (id: number, over: Partial<PullLineComment> = {}): PullLineComment => ({
  id, reviewId: 1, author: null, body: `c${id}`, at: `2026-10-01T10:00:0${id % 10}Z`,
  url: `https://github.com/o/r/pull/7#discussion_r${id}`, path: 'a.ts', side: 'RIGHT', line: 5, outdated: false, ...over
})

describe('pullLineThreads', () => {
  it('groups replies under their first comment, oldest first, and keeps the first comment\'s place', () => {
    const threads = pullLineThreads([
      comment(3, { inReplyTo: 1, line: null, outdated: true }),
      comment(1, { side: 'LEFT', line: 9 }),
      comment(2, { line: 2 }),
      comment(4, { inReplyTo: 3 })
    ], 'a.ts')
    expect(threads.map(({ id, side, line, comments }) => ({ id, side, line, ids: comments.map((c) => c.id) }))).toEqual([
      { id: 2, side: 'RIGHT', line: 2, ids: [2] },
      { id: 1, side: 'LEFT', line: 9, ids: [1, 3, 4] }
    ])
  })

  it('keeps only the file asked for, puts threads off a current line last, and starts an orphan reply its own thread', () => {
    const threads = pullLineThreads([
      comment(1, { path: 'b.ts' }),
      comment(2, { line: null, outdated: true }),
      comment(3, { inReplyTo: 99, line: 1 })
    ], 'a.ts')
    expect(threads.map(({ id, line, outdated }) => ({ id, line, outdated }))).toEqual([
      { id: 3, line: 1, outdated: false },
      { id: 2, line: null, outdated: true }
    ])
  })

  it('survives a reply loop', () => {
    const threads = pullLineThreads([comment(1, { inReplyTo: 2 }), comment(2, { inReplyTo: 1 })], 'a.ts')
    expect(threads.flatMap((thread) => thread.comments.map((c) => c.id)).sort()).toEqual([1, 2])
  })
})
