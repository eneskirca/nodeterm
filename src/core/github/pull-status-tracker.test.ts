import { describe, expect, it } from 'vitest'
import { GitHubPullStatusTracker } from './pull-status-tracker'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { PullStatusRead } from './graphql-pulls'
import { PULL_CHASE_MAX } from '../../shared/github-pull-status'
import type { PullStatusFacts } from '../../shared/github-pull-status'
import { emptyPullMemory, type PullMemory } from './pull-memory'

const HEAD = 'a'.repeat(40)
const KEY = 'user-1\0o/r'

function facts(number: number, over: Partial<PullStatusFacts> = {}): PullStatusFacts {
  return {
    number, headRefName: `feat/${number}`, headRefOid: HEAD, crossRepository: false, isDraft: false, mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', rollup: 'SUCCESS', rollupOid: HEAD, closes: [], ...over
  }
}

function read(open: PullStatusFacts[], over: Partial<PullStatusRead> = {}): PullStatusRead {
  return { open, recent: [], access: { ci: true, merge: true }, truncated: false, ...over }
}

/** An on-disk memory stand-in shared across tracker instances (an app restart = a new tracker). */
function memoryStore() {
  const files = new Map<string, PullMemory>()
  const saves: PullMemory[] = []
  return {
    files,
    saves,
    load: async (userId: string, repository: string) =>
      structuredClone(files.get(`${userId}\0${repository}`) ?? emptyPullMemory()),
    save: async (userId: string, repository: string, memory: PullMemory) => {
      saves.push(structuredClone(memory))
      files.set(`${userId}\0${repository}`, structuredClone(memory))
    }
  }
}

function tracker(start = 0, store = memoryStore()) {
  let now = start
  const changes: number[][] = []
  const coordinator = new GitHubRequestCoordinator({ now: () => now })
  const subject = new GitHubPullStatusTracker({
    coordinator, now: () => now, onChanged: (_key, numbers) => changes.push(numbers), memory: store
  })
  return { subject, coordinator, changes, store, advance: (ms: number) => { now += ms }, at: () => now }
}

async function settleSaves(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe('GitHubPullStatusTracker', () => {
  it('publishes open pull requests and recent merges', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)], {
      recent: [{ number: 2, headRefName: 'feat/2', crossRepository: false, lifecycle: 'merged' }]
    }))
    const board = subject.board(KEY)
    expect(board.pulls.map((pull) => [pull.number, pull.lifecycle, pull.ci, pull.merge])).toEqual([
      [1, 'open', 'passed', 'ready'], [2, 'merged', undefined, undefined]
    ])
    expect(board.stale).toBe(false)
    expect(board.observedAt).toBe(0)
    expect(board.repository).toBe('o/r')
  })

  it('says when the read behind the board STARTED, on the host clock (an --after-pr wait needs a read taken after it was armed)', async () => {
    const { subject, advance } = tracker(1_000)
    expect(subject.board(KEY).readStartedAt).toBeUndefined()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => {
      advance(700) // the read takes time: the start is what counts, not the finish
      return read([facts(1)])
    })
    expect(subject.board(KEY).readStartedAt).toBe(1_000)
    expect(subject.board(KEY).observedAt).toBe(1_700)
  })

  it('a FOREGROUND read tells the boards even when nothing changed; a background one does not', async () => {
    // Someone asked for a fresh answer (the board's refresh, or a PR wait that needs a read taken
    // after it was armed): an unchanged answer is still an answer they are waiting for.
    const { subject, changes } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    const before = changes.length
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    expect(changes.length).toBe(before)
    await subject.read(KEY, 'user-1', 'foreground', async () => read([facts(1)]))
    expect(changes.length).toBe(before + 1)
  })

  it('a failed read keeps the last snapshot and marks it stale instead of going blank', async () => {
    const { subject, changes } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    changes.length = 0
    await subject.read(KEY, 'user-1', 'heartbeat', async () => {
      throw Object.assign(new Error('request-failed'), { code: 'request-failed', status: 502 })
    })
    const board = subject.board(KEY)
    expect(board.stale).toBe(true)
    expect(board.pulls.map((pull) => pull.ci)).toEqual(['passed'])
    expect(changes).toEqual([[]])
    // A stale snapshot is worth re-reading at the next heartbeat even when nothing changed.
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    expect(subject.board(KEY).stale).toBe(false)
  })

  it('reads after a heartbeat only when something changed, once it knows the repository', async () => {
    const { subject } = tracker()
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(false)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: true, foreground: false })).toBe(true)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: true })).toBe(true)
  })

  it('chases an undecided PR on the schedule and stops after 12 reads', async () => {
    const { subject, advance } = tracker()
    const undecided = async () => read([facts(1, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })])
    await subject.read(KEY, 'user-1', 'heartbeat', undecided)
    expect(subject.board(KEY).undecided).toBe(true)
    let reads = 0
    for (let tick = 0; tick < 400; tick++) {
      advance(15_000)
      if (!subject.claimChase(KEY)) continue
      reads += 1
      await subject.read(KEY, 'user-1', 'chase', undecided)
    }
    expect(reads).toBe(PULL_CHASE_MAX)
    expect(subject.board(KEY).undecided).toBe(false)
  })

  it('does not chase before the first delay, and a failed chase read still spends its attempt', async () => {
    const { subject, advance } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () =>
      read([facts(1, { rollup: 'PENDING' })]))
    advance(29_999)
    expect(subject.claimChase(KEY)).toBe(false)
    advance(1)
    expect(subject.claimChase(KEY)).toBe(true)
    await subject.read(KEY, 'user-1', 'chase', async () => { throw Object.assign(new Error('x'), { code: 'request-failed' }) })
    // The next step is one minute after the failed read, not an immediate retry.
    advance(59_999)
    expect(subject.claimChase(KEY)).toBe(false)
    advance(1)
    expect(subject.claimChase(KEY)).toBe(true)
  })

  it('stops chasing once the PR settles', async () => {
    const { subject, advance } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1, { rollup: 'PENDING' })]))
    advance(30_000)
    expect(subject.claimChase(KEY)).toBe(true)
    await subject.read(KEY, 'user-1', 'chase', async () => read([facts(1)]))
    advance(3_600_000)
    expect(subject.claimChase(KEY)).toBe(false)
  })

  it('a background read the graphql budget holds is skipped and owed; REST budget does not hold it', async () => {
    const { subject, coordinator } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)]))
    coordinator.noteRateSample('user-1', { resource: 'core', limit: 5_000, remaining: 10, resetAt: 60_000 })
    let ran = 0
    await subject.read(KEY, 'user-1', 'heartbeat', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(1)
    coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 10, resetAt: 60_000 })
    await subject.read(KEY, 'user-1', 'heartbeat', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(1)
    expect(subject.wantsReadAfterHeartbeat(KEY, { changed: false, foreground: false })).toBe(true)
    // The user's own refresh is not held by the floor — only by a hard limit.
    await subject.read(KEY, 'user-1', 'foreground', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(2)
    coordinator.noteRateSample('user-1', { resource: 'graphql', limit: 5_000, remaining: 0, resetAt: 60_000 })
    await subject.read(KEY, 'user-1', 'foreground', async () => { ran += 1; return read([facts(1)]) })
    expect(ran).toBe(2)
  })

  it('a token without permission hides CI and mergeability instead of marking anything stale', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => {
      throw Object.assign(new Error('insufficient-permission'), { code: 'insufficient-permission', status: 403 })
    })
    expect(subject.board(KEY)).toMatchObject({ pulls: [], stale: false, access: { ci: false, merge: false } })
  })

  it('a read in flight when the cache is cleared publishes nothing', async () => {
    const { subject } = tracker()
    let release!: (value: PullStatusRead) => void
    const pending = subject.read(KEY, 'user-1', 'heartbeat', () => new Promise((resolve) => { release = resolve }))
    subject.forgetRepository('o/r')
    release(read([facts(1)]))
    await pending
    expect(subject.board(KEY).pulls).toEqual([])
  })

  it('never carries a CI result from an older head across reads', async () => {
    const { subject } = tracker()
    await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1, { rollup: 'SUCCESS' })]))
    const pushed = 'c'.repeat(40)
    await subject.read(KEY, 'user-1', 'heartbeat', async () =>
      read([facts(1, { headRefOid: pushed, rollup: 'SUCCESS', rollupOid: HEAD })]))
    expect(subject.board(KEY).pulls[0]).toMatchObject({ headRefOid: pushed, ci: 'pending' })
  })

  describe('memory', () => {
    it('a PR closed without merging stays on the board after it leaves the recent list', async () => {
      const { subject } = tracker()
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([], {
        recent: [{ number: 12, headRefName: 'feat/x', crossRepository: false, lifecycle: 'closed' }]
      }))
      // Thirty newer PRs closed: #12 is no longer in the read at all.
      await subject.read(KEY, 'user-1', 'foreground', async () => read([]))
      expect(subject.board(KEY).pulls).toEqual([
        { number: 12, lifecycle: 'closed', headRefName: 'feat/x', closes: [] }
      ])
    })

    it('marks a merge as observed only when it had seen the PR open, and remembers it across a restart', async () => {
      const store = memoryStore()
      const first = tracker(100, store)
      await first.subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1, { headRefName: 'feat/x' })]))
      await settleSaves()
      // An app restart: a new tracker over the same stored memory, and #1 has merged meanwhile.
      const second = tracker(500, store)
      await second.subject.read(KEY, 'user-1', 'heartbeat', async () => read([], {
        recent: [{ number: 1, headRefName: 'feat/x', crossRepository: false, lifecycle: 'merged' }]
      }))
      expect(second.subject.board(KEY).pulls[0]).toMatchObject({ number: 1, lifecycle: 'merged', openSeen: true, mergedSeenAt: 500 })
      // A merge this machine never saw open carries no observation.
      await second.subject.read(KEY, 'user-1', 'foreground', async () => read([], {
        recent: [{ number: 2, headRefName: 'feat/y', crossRepository: false, lifecycle: 'merged' }]
      }))
      expect(second.subject.board(KEY).pulls.find((pull) => pull.number === 2)).not.toHaveProperty('mergedSeenAt')
    })

    it('a claim is won once, across concurrent asks and across a restart', async () => {
      const store = memoryStore()
      const { subject } = tracker(0, store)
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1), facts(2)]))
      expect(await subject.noteWaits(KEY, 'p', 'n', [1, 2])).toBe(2)
      const answers = await Promise.all([subject.claimMove(KEY, 'p', 'n', [1]), subject.claimMove(KEY, 'p', 'n', [1])])
      expect(answers.sort()).toEqual([false, true])
      await settleSaves()
      const restarted = tracker(0, store)
      expect(await restarted.subject.claimMove(KEY, 'p', 'n', [1])).toBe(false)
      expect(await restarted.subject.claimMove(KEY, 'p', 'n', [2])).toBe(true)
      // Both merges have moved it now; the set shrinking back to one of them is not a new merge.
      expect(await restarted.subject.claimMove(KEY, 'p', 'n', [2])).toBe(false)
      expect(await restarted.subject.claimMove(KEY, 'p', 'n', [1, 2])).toBe(false)
    })

    it('a dragged-back card stays put when one of its merged PRs ages off the pull board', async () => {
      const { subject } = tracker()
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1), facts(2)]))
      expect(await subject.noteWaits(KEY, 'p', 'n', [1, 2])).toBe(2)
      expect(await subject.claimMove(KEY, 'p', 'n', [1, 2])).toBe(true)
      // The user drags the card back; #2 later leaves the board, so the planner now asks for {1}.
      expect(await subject.claimMove(KEY, 'p', 'n', [1])).toBe(false)
    })

    it('a card that first appears after the merge never wins a claim', async () => {
      const { subject } = tracker()
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(12, { headRefName: 'feat/x' })]))
      expect(await subject.noteWaits(KEY, 'p', 'first-card', [12])).toBe(1)
      await subject.read(KEY, 'user-1', 'foreground', async () => read([], {
        recent: [{ number: 12, headRefName: 'feat/x', crossRepository: false, lifecycle: 'merged' }]
      }))
      // The card that was there while #12 was open moves; one that appears only now (a follow-up
      // terminal in the same worktree group, a teammate's card via git pull) never does.
      expect(await subject.claimMove(KEY, 'p', 'first-card', [12])).toBe(true)
      expect(await subject.noteWaits(KEY, 'p', 'late-card', [12])).toBe(0)
      expect(await subject.claimMove(KEY, 'p', 'late-card', [12])).toBe(false)
    })

    it('notes a wait only for a PR the host itself holds as open', async () => {
      const { subject } = tracker()
      expect(await subject.noteWaits(KEY, 'p', 'n', [1])).toBe(0)
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1)], {
        recent: [{ number: 2, headRefName: 'x', crossRepository: false, lifecycle: 'merged' }]
      }))
      expect(await subject.noteWaits(KEY, 'p', 'n', [1, 2, 3])).toBe(1)
      expect(await subject.claimMove(KEY, 'p', 'n', [2])).toBe(false)
    })

    it('a save queued behind a slow one is dropped once the repository is forgotten', async () => {
      const store = memoryStore()
      let releaseSlow!: () => void
      const slowSave = new Promise<void>((resolve) => { releaseSlow = resolve })
      let slow = false
      const save = store.save
      let calls = 0
      store.save = async (...args) => {
        calls += 1
        if (slow) await slowSave
        return save(...args)
      }
      const { subject } = tracker(0, store)
      await subject.read(KEY, 'user-1', 'heartbeat', async () => read([facts(1), facts(2)]))
      await settleSaves()
      calls = 0
      slow = true
      await subject.noteWaits(KEY, 'p', 'n', [1, 2])      // save #1 starts and hangs
      expect(await subject.claimMove(KEY, 'p', 'n', [1])).toBe(true) // save #2 queues behind it
      const forgotten = subject.forgetRepository('o/r')
      releaseSlow()
      await forgotten
      expect(calls).toBe(1)
    })

    it('nothing started before a cache clear writes the memory back', async () => {
      const store = memoryStore()
      const { subject } = tracker(0, store)
      let release!: (value: PullStatusRead) => void
      const pending = subject.read(KEY, 'user-1', 'heartbeat', () => new Promise((resolve) => { release = resolve }))
      await subject.forgetRepository('o/r')
      release(read([facts(1)]))
      await pending
      await settleSaves()
      expect(store.saves).toEqual([])
    })
  })

  it('the chase read that spends the last attempt tells the boards at once', async () => {
    const { subject, advance, changes } = tracker()
    const undecided = async () => read([facts(1, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })])
    await subject.read(KEY, 'user-1', 'heartbeat', undecided)
    for (let attempt = 0; attempt < PULL_CHASE_MAX - 1; attempt++) {
      advance(300_000)
      expect(subject.claimChase(KEY)).toBe(true)
      await subject.read(KEY, 'user-1', 'chase', undecided)
    }
    changes.length = 0
    advance(300_000)
    expect(subject.claimChase(KEY)).toBe(true)
    expect(changes).toEqual([[]])
    expect(subject.board(KEY).undecided).toBe(false)
  })
})
