export class GitHubCoordinatorError extends Error {
  constructor(readonly code: 'configuration-changed') {
    super(code)
  }
}

type RateLimit = { kind: 'primary' | 'secondary'; retryAt: number }
type ReadJob = {
  generation: number
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
type IdentityState = {
  activeReads: number
  readQueue: ReadJob[]
  mutationTail: Promise<void>
  lastMutationAt: number
  generation: number
  retryAt: number
}

type CoordinatorOptions = {
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

function noteOperationRateLimit(state: IdentityState, error: unknown): void {
  if (!error || typeof error !== 'object') return
  const value = error as { code?: unknown; retryAt?: unknown }
  if (value.code === 'rate-limited' && typeof value.retryAt === 'number' &&
      Number.isFinite(value.retryAt)) {
    state.retryAt = Math.max(state.retryAt, value.retryAt)
  }
}

export class GitHubRequestCoordinator {
  private readonly states = new Map<string, IdentityState>()
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(options: CoordinatorOptions = {}) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  runRead<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    return new Promise<T>((resolve, reject) => {
      state.readQueue.push({
        generation: state.generation,
        run: operation,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.drainReads(identity, state)
    })
  }

  runMutation<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const state = this.state(identity)
    const generation = state.generation
    let resolveResult: (value: T) => void
    let rejectResult: (error: unknown) => void
    const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    state.mutationTail = state.mutationTail.then(async () => {
      try {
        if (generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
        await this.waitForRate(state)
        const spacing = state.lastMutationAt + 1_000 - this.now()
        if (spacing > 0) await this.sleep(spacing)
        if (generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
        state.lastMutationAt = this.now()
        resolveResult(await operation())
      } catch (error) {
        noteOperationRateLimit(state, error)
        rejectResult(error)
      }
    })
    return result
  }

  noteRateLimit(identity: string, limit: RateLimit): void {
    const state = this.state(identity)
    if (Number.isFinite(limit.retryAt)) state.retryAt = Math.max(state.retryAt, limit.retryAt)
  }

  canStart(identity: string, at = this.now()): boolean {
    return at >= this.state(identity).retryAt
  }

  cancelIdentity(identity: string): void {
    const state = this.state(identity)
    state.generation += 1
    const error = new GitHubCoordinatorError('configuration-changed')
    for (const job of state.readQueue.splice(0)) job.reject(error)
  }

  private state(identity: string): IdentityState {
    let state = this.states.get(identity)
    if (!state) {
      state = {
        activeReads: 0,
        readQueue: [],
        mutationTail: Promise.resolve(),
        lastMutationAt: Number.NEGATIVE_INFINITY,
        generation: 0,
        retryAt: 0
      }
      this.states.set(identity, state)
    }
    return state
  }

  private drainReads(identity: string, state: IdentityState): void {
    while (state.activeReads < 4 && state.readQueue.length) {
      const job = state.readQueue.shift()!
      state.activeReads += 1
      void (async () => {
        try {
          if (job.generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
          await this.waitForRate(state)
          if (job.generation !== state.generation) throw new GitHubCoordinatorError('configuration-changed')
          job.resolve(await job.run())
        } catch (error) {
          noteOperationRateLimit(state, error)
          job.reject(error)
        } finally {
          state.activeReads -= 1
          this.drainReads(identity, state)
        }
      })()
    }
  }

  private async waitForRate(state: IdentityState): Promise<void> {
    const wait = state.retryAt - this.now()
    if (wait > 0) await this.sleep(wait)
  }
}
