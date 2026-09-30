import { describe, expect, it } from 'vitest'
import type { GitHubPullStatus, PullLifecycle } from '../../shared/github-pull-status'
import {
  PULL_MEMORY_MAX,
  noteWaitsInMemory,
  REMEMBERED_MERGE_VISIBLE_MS,
  claimInMemory,
  emptyPullMemory,
  rememberPulls,
  rememberedForBoard,
  validPullMemory,
  waitKey
} from './pull-memory'

const status = (number: number, lifecycle: PullLifecycle, over: Partial<GitHubPullStatus> = {}): GitHubPullStatus =>
  ({ number, lifecycle, headRefName: `feat/${number}`, closes: [], ...over })
const none = new Map<number, PullLifecycle>()

describe('rememberPulls', () => {
  it('a merge counts as observed only after the PR was seen open', () => {
    const seenOpen = rememberPulls([], [status(1, 'open')], none, 10)
    expect(seenOpen).toEqual([{ number: 1, headRefName: 'feat/1', lifecycle: 'open', openSeen: true }])
    const merged = rememberPulls(seenOpen, [status(1, 'merged')], none, 20)
    expect(merged[0]).toMatchObject({ lifecycle: 'merged', openSeen: true, mergedSeenAt: 20 })
    // The time is the FIRST observation; seeing it merged again does not move it.
    expect(rememberPulls(merged, [status(1, 'merged')], none, 30)[0].mergedSeenAt).toBe(20)
  })

  it('a PR first seen already merged is remembered without an observed merge', () => {
    expect(rememberPulls([], [status(1, 'merged')], none, 10)[0]).toEqual(
      { number: 1, headRefName: 'feat/1', lifecycle: 'merged' })
  })

  it('remembers what a PR closed while open, through its merge', () => {
    const open = rememberPulls([], [status(1, 'open', { closes: [4] })], none, 10)
    const merged = rememberPulls(open, [status(1, 'merged')], none, 20)
    expect(merged[0]).toMatchObject({ lifecycle: 'merged', closes: [4] })
    expect(rememberedForBoard(merged, new Set(), 30)[0].closes).toEqual([4])
  })

  it('keeps a PR the read no longer lists — a closed one stays closed', () => {
    const closed = rememberPulls([], [status(1, 'closed')], none, 10)
    expect(rememberPulls(closed, [], none, 20)).toEqual(closed)
  })

  it('refreshes an unlisted PR from the REST harvest, observing its merge', () => {
    const open = rememberPulls([], [status(1, 'open')], none, 10)
    const merged = rememberPulls(open, [], new Map([[1, 'merged']]), 50)
    expect(merged[0]).toMatchObject({ lifecycle: 'merged', mergedSeenAt: 50, headRefName: 'feat/1' })
  })

  it('is bounded, and keeps unfinished PRs over old finished ones', () => {
    const many = Array.from({ length: PULL_MEMORY_MAX + 20 }, (_, index) => status(index + 1, 'merged'))
    const kept = rememberPulls([], [...many, status(1, 'open')], none, 1)
    expect(kept).toHaveLength(PULL_MEMORY_MAX)
    expect(kept.some((pull) => pull.number === 1 && pull.lifecycle === 'open')).toBe(true)
    expect(validPullMemory({ version: 1, pulls: kept, claims: [], waits: [] })).toBe(true)
  })
})

describe('rememberedForBoard', () => {
  it('shows unlisted open and closed PRs, and merges observed within the window', () => {
    const memory = [
      { number: 1, headRefName: 'a', lifecycle: 'closed' as const },
      { number: 2, headRefName: 'b', lifecycle: 'open' as const, openSeen: true as const },
      { number: 3, headRefName: 'c', lifecycle: 'merged' as const, openSeen: true as const, mergedSeenAt: 100 },
      { number: 4, headRefName: 'd', lifecycle: 'merged' as const },
      { number: 5, headRefName: 'e', lifecycle: 'open' as const }
    ]
    expect(rememberedForBoard(memory, new Set([5]), 200).map((pull) => pull.number)).toEqual([1, 2, 3])
    expect(rememberedForBoard(memory, new Set(), 100 + REMEMBERED_MERGE_VISIBLE_MS).map((pull) => pull.number))
      .toEqual([1, 2, 5])
  })
})

describe('claims', () => {
  it('the first claim for a key wins — and only for a card noted waiting on one of its PRs', () => {
    const noted = noteWaitsInMemory(emptyPullMemory(), [waitKey('p', 'n', 1)])
    expect(claimInMemory(emptyPullMemory(), 'p', 'n', [1]).claimed).toBe(false)
    const first = claimInMemory(noted, 'p', 'n', [1])
    expect(first.claimed).toBe(true)
    expect(claimInMemory(first.memory, 'p', 'n', [1]).claimed).toBe(false)
    // Another card is its own claim.
    expect(claimInMemory(noteWaitsInMemory(first.memory, [waitKey('p', 'm', 1)]), 'p', 'm', [1]).claimed)
      .toBe(true)
    expect(noteWaitsInMemory(noted, [waitKey('p', 'n', 1)])).toBe(noted)
  })

  it('a claim is per PR: the set shrinking or growing by a merge this card never waited on never re-moves it', () => {
    // The card waited on #1 and #2 and was moved when both merged; the user dragged it back.
    const waited = noteWaitsInMemory(emptyPullMemory(), [waitKey('p', 'n', 1), waitKey('p', 'n', 2)])
    const moved = claimInMemory(waited, 'p', 'n', [1, 2])
    expect(moved.claimed).toBe(true)
    // #2 ages off the pull board, so the linked set is now {1}: the same merge, not a new one.
    expect(claimInMemory(moved.memory, 'p', 'n', [1]).claimed).toBe(false)
    // A PR it never saw open joins the set: still no transition observed for THIS card.
    expect(claimInMemory(moved.memory, 'p', 'n', [1, 3]).claimed).toBe(false)
    // A new PR the card DID wait on merges: that is a new transition, and it moves the card again.
    const waitedOnFour = noteWaitsInMemory(moved.memory, [waitKey('p', 'n', 4)])
    expect(claimInMemory(waitedOnFour, 'p', 'n', [1, 4]).claimed).toBe(true)
  })

  it('reads a claim recorded under the older set-of-PRs key as a claim on each of its PRs', () => {
    const legacy = {
      ...noteWaitsInMemory(emptyPullMemory(), [waitKey('p', 'n', 1), waitKey('p', 'n', 2)]),
      claims: ['p\0n\x001,2']
    }
    expect(validPullMemory(legacy)).toBe(true)
    expect(claimInMemory(legacy, 'p', 'n', [1]).claimed).toBe(false)
    expect(claimInMemory(legacy, 'p', 'n', [2]).claimed).toBe(false)
    expect(claimInMemory(legacy, 'p', 'n', [1, 2]).claimed).toBe(false)
  })

  it('rejects a malformed memory file', () => {
    expect(validPullMemory({ version: 1, pulls: [{ number: -1, headRefName: 'x', lifecycle: 'open' }], claims: [], waits: [] }))
      .toBe(false)
    expect(validPullMemory({ version: 2, pulls: [], claims: [], waits: [] })).toBe(false)
    expect(validPullMemory({ version: 1, pulls: [], claims: [3], waits: [] })).toBe(false)
    expect(validPullMemory({ version: 1, pulls: [], claims: [] })).toBe(false)
  })
})
