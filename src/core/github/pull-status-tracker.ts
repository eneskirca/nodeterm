// Pull request CI + mergeability per repository: when to read it, what the board is told, and how
// an undecided PR is chased without webhooks. The GraphQL read itself is the client's; this module
// owns only the decisions, so each rule can be pressed by a test without a network.
//
// WHEN a read happens — nothing else triggers one:
//  1. The issues heartbeat reported a change. A push, a merge, a label, a comment all move the
//     repository's most recently updated item; a finished check run does NOT, which is why:
//  2. An undecided PR (mergeability UNKNOWN, or a rollup still PENDING) is CHASED — 30 s, 1 min,
//     2 min, then 5 min, at most 12 reads per episode — and only while a board is VISIBLE. The
//     renderer asserts visibility by asking (`claimChase`); a hidden or closed board stops asking.
//  3. The first heartbeat of an app run (nothing known yet), a user's own refresh, a snapshot that
//     is stale, or a read the rate budget skipped earlier (`owed`).
//
// A read the budget holds is skipped, never queued, and remembered as owed; a failed read keeps the
// last snapshot and marks it stale. Neither blanks what the board shows.
//
// Every read is also folded into the repository's persisted MEMORY (pull-memory.ts): what this
// machine has observed about each PR, and the one-time claims the merge-driven column move takes.
import {
  EMPTY_PULL_BOARD,
  PULL_CHASE_MAX,
  nextPullChase,
  pullChaseDue,
  pullStatusFrom,
  type GitHubPullBoard,
  type GitHubPullStatus,
  type PullChaseState,
  type PullLifecycle
} from '../../shared/github-pull-status'
import type { PullStatusRead } from './graphql-pulls'
import {
  claimInMemory,
  emptyPullMemory,
  noteWaitsInMemory,
  rememberPulls,
  waitKey,
  rememberedForBoard,
  withObservations,
  type PullMemory
} from './pull-memory'
import type { GitHubRequestCoordinator } from './request-coordinator'

export type PullReadReason = 'heartbeat' | 'foreground' | 'chase'

type PullRepositoryState = {
  pulls: GitHubPullStatus[]
  observedAt?: number
  /** When the read behind `pulls` STARTED (host clock). A PR wait armed after it cannot trust it. */
  readStartedAt?: number
  stale: boolean
  access: { ci: boolean; merge: boolean }
  truncated: boolean
  chase: PullChaseState | null
  /** A read was skipped by the rate budget; the next opportunity reads even if nothing changed. */
  owed: boolean
  inFlight?: Promise<void>
  /** Bumped by `forgetRepository` so nothing started before a cache clear can publish or persist. */
  generation: number
  memory?: PullMemory
  memoryLoad?: Promise<PullMemory>
  /** Saves run one after another, so the file always ends at the latest memory. */
  saving: Promise<void>
}

type TrackerOptions = {
  coordinator: GitHubRequestCoordinator
  now?: () => number
  /** Something the board shows changed for this repository key. */
  onChanged: (key: string, changedPullNumbers: number[]) => void
  /** Persistence for the memory; absent = memory lives for this process only. */
  memory?: {
    load(userId: string, repository: string): Promise<PullMemory>
    save(userId: string, repository: string, memory: PullMemory): Promise<void>
  }
  /** Every PR's lifecycle from the REST issues harvest, for remembered PRs the GraphQL read no
   *  longer lists. */
  harvest?: (key: string) => ReadonlyMap<number, PullLifecycle>
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

/** Repository keys are `${userId}\0${repository}` — the issue service's own key. */
function splitKey(key: string): [string, string] {
  const at = key.indexOf('\0')
  return [key.slice(0, at), key.slice(at + 1)]
}

export class GitHubPullStatusTracker {
  private readonly states = new Map<string, PullRepositoryState>()
  private readonly now: () => number

  constructor(private readonly options: TrackerOptions) {
    this.now = options.now ?? Date.now
  }

  board(key: string): GitHubPullBoard {
    const state = this.states.get(key)
    const repository = splitKey(key)[1]
    // The host's clock, so a renderer can record when it armed the move in the same clock the host
    // stamps `mergedSeenAt` with (a Server Edition browser's clock may be minutes off).
    const now = this.now()
    if (!state) return { ...EMPTY_PULL_BOARD, access: { ...EMPTY_PULL_BOARD.access }, repository, now }
    return {
      repository,
      now,
      pulls: state.pulls.map((pull) => ({ ...pull, closes: [...pull.closes] })),
      ...(state.observedAt !== undefined ? { observedAt: state.observedAt } : {}),
      ...(state.readStartedAt !== undefined ? { readStartedAt: state.readStartedAt } : {}),
      stale: state.stale,
      access: { ...state.access },
      undecided: !!state.chase && state.chase.attempts < PULL_CHASE_MAX,
      truncated: state.truncated
    }
  }

  /** Should the heartbeat that just ran be followed by a pull status read? */
  wantsReadAfterHeartbeat(key: string, input: { changed: boolean; foreground: boolean }): boolean {
    const state = this.states.get(key)
    return input.changed || input.foreground || !state || state.observedAt === undefined ||
      state.stale || state.owed
  }

  /**
   * Claims one chase read, synchronously, so two boards asking at once cannot both spend it. True
   * means the caller must now `read(…, 'chase')`. The attempt is counted HERE, before the read: a
   * chase read that fails still spends one of the twelve. The claim that spends the last one tells
   * the boards at once, so they stop asking.
   */
  claimChase(key: string): boolean {
    const state = this.states.get(key)
    if (!state || state.inFlight || !pullChaseDue(state.chase, this.now())) return false
    state.chase = { ...state.chase!, attempts: state.chase!.attempts + 1, lastReadAt: this.now() }
    if (state.chase.attempts >= PULL_CHASE_MAX) this.options.onChanged(key, [])
    return true
  }

  /**
   * The one-time permission to move a card for a set of merged PRs. The first caller wins, whichever
   * window it comes from, and the claim is persisted PER PR — a card the user dragged back is not
   * moved again for the same merges, even when the linked set later shrinks or grows. Refused unless
   * the set holds a PR that has not moved this card yet and that this card was noted WAITING on while
   * it was open (`noteWaits`): a card that first appeared after the merge never moves.
   */
  async claimMove(key: string, projectId: string, cardId: string, pulls: number[]): Promise<boolean> {
    const state = this.stateFor(key)
    const generation = state.generation
    const memory = await this.memoryFor(key, state)
    if (generation !== state.generation) return false
    const { memory: next, claimed } = claimInMemory(state.memory ?? memory, projectId, cardId, pulls)
    if (!claimed) return false
    state.memory = next
    this.persist(key, state)
    return true
  }

  /**
   * "This card is linked to these PRs, and they are still open." Recorded only for PRs the host
   * itself currently holds as open or a draft — the note is the evidence a later claim rests on, so
   * the host does not take the caller's word for the state. Returns how many notes were new.
   */
  async noteWaits(key: string, projectId: string, cardId: string, pulls: number[]): Promise<number> {
    const state = this.states.get(key)
    if (!state) return 0
    const generation = state.generation
    const memory = await this.memoryFor(key, state)
    if (generation !== state.generation) return 0
    const open = new Set(state.pulls
      .filter((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')
      .map((pull) => pull.number))
    const keys = pulls.filter((pull) => open.has(pull)).map((pull) => waitKey(projectId, cardId, pull))
    const current = state.memory ?? memory
    const next = noteWaitsInMemory(current, keys)
    if (next === current) return 0
    state.memory = next
    this.persist(key, state)
    return next.waits.length - current.waits.length
  }

  /**
   * Drops every repository state for `repository` (a cache clear or revoke). Resolves once any save
   * already under way has finished, so a caller deleting the file afterwards cannot have it written
   * back by a save that started before.
   */
  forgetRepository(repository: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const [key, state] of this.states) {
      if (!key.endsWith(`\0${repository}`)) continue
      state.generation += 1
      pending.push(state.saving)
      this.states.delete(key)
    }
    return Promise.all(pending).then(() => undefined)
  }

  /**
   * Reads now. `run` performs the GraphQL read (through the coordinator and the caller's epoch
   * checks); `userId` names the identity whose `graphql` budget it spends. Single-flight per key:
   * a read already in flight answers every caller that arrives meanwhile.
   */
  read(
    key: string,
    userId: string,
    reason: PullReadReason,
    run: () => Promise<PullStatusRead>
  ): Promise<void> {
    const state = this.stateFor(key)
    if (state.inFlight) return state.inFlight
    // Background reads (heartbeat, chase) respect the whole budget, including the floor kept for
    // the user's own tools. A read the user asked for respects only a hard limit.
    const throttle = this.options.coordinator.throttle(userId, this.now(), 'graphql')
    if (throttle && (reason !== 'foreground' || throttle.kind === 'rate-limited')) {
      state.owed = true
      return Promise.resolve()
    }
    const generation = state.generation
    const work = this.perform(key, state, generation, userId, run, reason)
    state.inFlight = work
    void work.finally(() => { if (state.inFlight === work) delete state.inFlight })
    return work
  }

  private async perform(
    key: string,
    state: PullRepositoryState,
    generation: number,
    userId: string,
    run: () => Promise<PullStatusRead>,
    reason: PullReadReason
  ): Promise<void> {
    const startedAt = this.now()
    let result: PullStatusRead
    try {
      result = await run()
    } catch (error) {
      if (generation !== state.generation) return
      const code = errorCode(error)
      if (code === 'configuration-changed') return
      if (code === 'rate-limited') {
        // The coordinator has recorded the hold; nothing was learned about the pull requests.
        state.owed = true
        return
      }
      if (code === 'insufficient-permission') {
        await this.publish(key, state, generation, {
          open: [], recent: [], access: { ci: false, merge: false }, truncated: false
        }, userId, startedAt, reason)
        return
      }
      const wasStale = state.stale
      state.stale = true
      // A failed chase read still waits its turn: the next one follows the schedule, not a retry loop.
      if (state.chase) state.chase = { ...state.chase, lastReadAt: this.now() }
      if (!wasStale) this.options.onChanged(key, [])
      return
    }
    if (generation !== state.generation) return
    await this.publish(key, state, generation, result, userId, startedAt, reason)
  }

  private async publish(
    key: string,
    state: PullRepositoryState,
    generation: number,
    result: PullStatusRead,
    userId: string,
    startedAt: number,
    reason: PullReadReason
  ): Promise<void> {
    const memory = await this.memoryFor(key, state)
    if (generation !== state.generation) return
    const now = this.now()
    if (result.rateLimit) {
      // The body's own reading, in case a proxy stripped the headers the client already fed in.
      this.options.coordinator.noteRateSample(userId, {
        resource: 'graphql',
        limit: result.rateLimit.limit,
        remaining: result.rateLimit.remaining,
        resetAt: result.rateLimit.resetAt
      })
    }
    const previous = new Map(state.pulls.map((pull) => [pull.number, pull]))
    const open = result.open.map((facts) => pullStatusFrom(facts, result.access, previous.get(facts.number)))
    const openNumbers = new Set(open.map((pull) => pull.number))
    const finished = result.recent
      .filter((pull) => !openNumbers.has(pull.number))
      .map((pull): GitHubPullStatus => ({
        number: pull.number,
        lifecycle: pull.lifecycle,
        headRefName: pull.headRefName,
        ...(pull.crossRepository ? { crossRepository: true as const } : {}),
        closes: []
      }))
    const listed = [...open, ...finished]
    const remembered = rememberPulls(memory.pulls, listed, this.options.harvest?.(key) ?? new Map(), now)
    if (JSON.stringify(remembered) !== JSON.stringify(memory.pulls)) {
      state.memory = { ...(state.memory ?? memory), pulls: remembered }
      this.persist(key, state)
    }
    const rememberedByNumber = new Map(remembered.map((pull) => [pull.number, pull]))
    const pulls = [
      ...listed.map((pull) => withObservations(pull, rememberedByNumber.get(pull.number))),
      ...rememberedForBoard(remembered, new Set(listed.map((pull) => pull.number)), now)
    ]
    const nextNumbers = new Set(pulls.map((pull) => pull.number))
    const changed = [
      ...pulls.filter((pull) => JSON.stringify(pull) !== JSON.stringify(previous.get(pull.number)))
        .map((pull) => pull.number),
      ...state.pulls.filter((pull) => !nextNumbers.has(pull.number)).map((pull) => pull.number)
    ]
    const accessChanged = state.access.ci !== result.access.ci || state.access.merge !== result.access.merge
    const wasStale = state.stale
    const chaseBefore = state.chase
    state.pulls = pulls
    state.observedAt = now
    state.readStartedAt = startedAt
    state.stale = false
    state.owed = false
    state.access = { ...result.access }
    state.truncated = result.truncated
    state.chase = nextPullChase(state.chase, open, now)
    const chaseChanged = !!chaseBefore !== !!state.chase
    // A FOREGROUND read was asked for (the board's refresh, or a pull request wait that needs a read
    // taken after it was armed): its answer is news even when nothing in it changed.
    if (changed.length || accessChanged || wasStale || chaseChanged || reason === 'foreground') {
      this.options.onChanged(key, changed)
    }
  }

  private memoryFor(key: string, state: PullRepositoryState): Promise<PullMemory> {
    if (state.memory) return Promise.resolve(state.memory)
    if (!state.memoryLoad) {
      const [userId, repository] = splitKey(key)
      state.memoryLoad = (this.options.memory
        ? this.options.memory.load(userId, repository)
        : Promise.resolve(emptyPullMemory())).catch(() => emptyPullMemory())
    }
    return state.memoryLoad.then((loaded) => {
      if (!state.memory) state.memory = loaded
      return state.memory
    })
  }

  private persist(key: string, state: PullRepositoryState): void {
    const save = this.options.memory?.save
    if (!save) return
    const [userId, repository] = splitKey(key)
    const generation = state.generation
    state.saving = state.saving.then(async () => {
      // Written at its turn with the LATEST memory, and never after the repository was forgotten.
      if (generation !== state.generation || !state.memory) return
      await save(userId, repository, state.memory)
    }).catch(() => undefined)
  }

  private stateFor(key: string): PullRepositoryState {
    let state = this.states.get(key)
    if (!state) {
      state = {
        pulls: [], stale: false, access: { ci: true, merge: true }, truncated: false,
        chase: null, owed: false, generation: 0, saving: Promise.resolve()
      }
      this.states.set(key, state)
    }
    return state
  }
}
