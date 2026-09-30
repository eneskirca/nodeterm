import type { Project } from '../../shared/types'
import type {
  CreateIssueInput,
  CreateMappedLabelsResult,
  GitHubIssue,
  GitHubIssueCardView,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubMutationResult,
  GitHubCloseReason,
  GitHubRepositoryLabel,
  GitHubThrottle,
  IssueHeartbeatResult,
  IssuePageResult,
  LabelPageResult,
  ListIssueOptions,
  NormalisedProjectKanbanGitHub,
  UpdateIssueInput
} from '../../shared/github-issues'
import type { GitHubAvatarFetcher } from './avatar-fetcher'
import {
  GitHubCacheError,
  type GitHubCompleteSnapshot,
  type GitHubIssueCache
} from './cache'
import { classifyGitHubFailure } from './failure'
import type { GitHubRequestCoordinator } from './request-coordinator'
import type { PullStatusRead } from './graphql-pulls'
import { GitHubPullStatusTracker } from './pull-status-tracker'
import type { GitHubPullBoard, GitHubPullChecksResult, PullLifecycle } from '../../shared/github-pull-status'

const MAX_ISSUES = 10_000
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const FULL_REFRESH_AGE = 24 * 60 * 60_000
const POLL_MS = 60_000
/** Where the heartbeat's validator lives inside the snapshot's (long-existing, previously always
 *  empty) `etags` map, so it is persisted with the issues it vouches for and survives a restart. */
export const HEARTBEAT_ETAG_KEY = 'heartbeat'

/** Floor between two caller-driven refreshes of one project, and the longer floor for a FULL
 *  reconciliation. `refresh` is reachable from the renderer AND — for a shared project — from a
 *  relay guest, and nothing else bounds it: `state.refresh` coalesces CONCURRENT calls but not
 *  sequential ones, so an unthrottled caller can restart a whole-repository scan as fast as the
 *  previous one completes and spend the host's entire hourly quota (which is the ACCOUNT's quota —
 *  it degrades the user's `gh` CLI and github.com session too, not just nodeterm). Both floors sit
 *  under POLL_MS so the background poll is never the thing they throttle. */
export const REFRESH_MIN_INTERVAL_MS = 30_000
export const FULL_REFRESH_MIN_INTERVAL_MS = 120_000

/** Check detail is read when a PR's modal opens — reachable from the renderer AND a relay guest,
 *  and each read is a GraphQL request plus a credential resolve. So: the same PR within this window
 *  shares one read, and a project gets at most `PULL_CHECKS_PER_MINUTE` reads a minute. Both are
 *  checked before anything is resolved or sent. */
export const PULL_CHECKS_REUSE_MS = 15_000
export const PULL_CHECKS_PER_MINUTE = 10

export interface GitHubIssuesClientLike {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
  issuesHeartbeat(repository: string, etag?: string): Promise<IssueHeartbeatResult>
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>
  updateIssue(repository: string, issueNumber: number, input: UpdateIssueInput): Promise<GitHubIssue>
  listRepositoryLabels(
    repository: string,
    options: { page: number; perPage: number; etag?: string }
  ): Promise<LabelPageResult>
  createLabel(
    repository: string,
    input: { name: string; color: string; description?: string }
  ): Promise<GitHubRepositoryLabel>
  /** Agent-filed gap reports (@core/github/report-issue-service). Declared here rather than only
   *  on the concrete client so `contextForProject` hands one caller everything it needs — the
   *  report path must never build a second authenticated client of its own. */
  createIssue(repository: string, input: CreateIssueInput): Promise<GitHubIssue>
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ id: number }>
  /** Pull request CI + mergeability (one GraphQL read). Optional so a client that cannot make
   *  GraphQL reads — and every test fake written before them — simply has no pull status: the board
   *  then shows none, which is the honest answer. */
  pullRequestStatuses?(repository: string): Promise<PullStatusRead>
  pullRequestChecks?(repository: string, pullNumber: number): Promise<GitHubPullChecksResult>
}

export interface GitHubIssueProjectContext {
  localApprovalId: string
  projectId: string
  repository: string
  config: NormalisedProjectKanbanGitHub
  controlRevision: number
  columnColors: Record<string, string>
  /** This machine approved the column mapping now on disk (see `githubMappingDigest`). Without it
   *  the board reads but never writes: the mapping decides what a write DOES, and it arrives
   *  through the git-shared project file. */
  mappingApproved: boolean
  /** The project this context was resolved from (in-process only). The read-only control verbs use
   *  it so a call loads the workspace once, not a second time for the nodes and board. */
  project?: Project
}

/** What `controlSnapshot` answers: the cached board state of one project, no request made. */
export interface GitHubControlSnapshot {
  repository: string
  /** The project the snapshot was resolved for (nodes, board columns, pull-link tombstones). */
  project?: Project
  completionColumnId?: string
  mappingApproved: boolean
  /** Issues AND pull requests of the harvest, each with the column its labels map it to. */
  items: GitHubIssueCardView[]
  /** A complete harvest exists (from this run or the on-disk cache). */
  hasSnapshot: boolean
  /** Only a partial harvest exists (the repository is over the issue/byte bounds). */
  partial: boolean
  incomplete: boolean
  pullsTruncated: boolean
  /** Epoch ms of the last complete refresh — how old the list is. */
  lastSuccessfulRefreshAt?: number
  pullBoard: GitHubPullBoard
  throttle?: GitHubThrottle
}

export interface GitHubIssueServiceContext extends GitHubIssueProjectContext {
  credentialGeneration: number
  userId: string
  client: GitHubIssuesClientLike
}

type TimerId = ReturnType<typeof setInterval> | number
type ServiceOptions = {
  cache: GitHubIssueCache
  coordinator: GitHubRequestCoordinator
  contextForProject(projectId: string): Promise<GitHubIssueServiceContext>
  projectContextForCache?(projectId: string): Promise<GitHubIssueProjectContext>
  projectContextForCacheDeletion?(projectId: string): Promise<GitHubIssueProjectContext>
  avatarFetcher?: GitHubAvatarFetcher
  now?: () => number
  setInterval?: (fn: () => void, milliseconds: number) => TimerId
  clearInterval?: (timer: TimerId) => void
  onDelta?: (uiId: number, projectId: string, changedIssueNumbers: number[]) => void
}

type RepositoryState = {
  snapshot?: GitHubCompleteSnapshot
  partialIssues?: GitHubIssue[]
  incomplete: boolean
  subscribers: Map<string, Set<number>>
  timer?: TimerId
  refresh?: Promise<void>
  cacheGeneration: number
  /** The throttle deadline subscribers were last prompted about, so a held poll re-prompts them
   *  once per deadline instead of once a minute. */
  announcedThrottleUntil?: number
}

type RepositoryControl = {
  generation: number
  clearCutoff: number
  deletion?: Promise<void>
}

function repositoryKey(context: GitHubIssueServiceContext): string {
  return `${context.userId}\0${context.repository}`
}

function epoch(context: GitHubIssueServiceContext): string {
  return JSON.stringify([
    context.localApprovalId,
    context.projectId,
    context.repository,
    context.config.revision,
    context.controlRevision,
    context.credentialGeneration,
    context.userId
  ])
}

function foldLabel(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function mapping(issue: GitHubIssue, config: NormalisedProjectKanbanGitHub): {
  columnId: string | null
  conflict: GitHubIssueCardView['conflict']
} {
  if (issue.state === 'closed') {
    return { columnId: config.completionColumnId ?? null, conflict: null }
  }
  const labelNames = new Set(issue.labels.map((label) => foldLabel(label.name)))
  const matches = config.columnMappings.filter((item) =>
    labelNames.has(foldLabel(item.label)))
  if (matches.length > 1) return { columnId: null, conflict: 'multiple-mapped-labels' }
  if (matches.length === 1 && matches[0].columnId === config.completionColumnId) {
    return { columnId: null, conflict: 'open-with-completion-label' }
  }
  return { columnId: matches[0]?.columnId ?? null, conflict: null }
}

/** Trims a harvest to a bound by dropping PULL REQUESTS first, oldest-updated first.
 *  Issues are never dropped to make room for a pull request: the issue lane shipped first and
 *  a repository big enough to overflow must degrade in the new half, not turn the board it
 *  already had read only. Returns null when the issues ALONE still miss the bound — that is the
 *  caller's existing incomplete path, unchanged. `fits` is a predicate so the same order serves
 *  the item count and the byte ceiling. */
export function evictPullsToFit(
  items: GitHubIssue[],
  fits: (candidate: GitHubIssue[]) => boolean
): { items: GitHubIssue[]; pullsTruncated: boolean } | null {
  if (fits(items)) return { items, pullsTruncated: false }
  const issues = items.filter((item) => !item.pull)
  if (!fits(issues)) return null
  const pulls = items.filter((item) => item.pull)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
  // Binary search the largest surviving prefix: `fits` may stringify the whole harvest, so
  // dropping one at a time would be O(n²) on a repository near the ceiling.
  let low = 0
  let high = pulls.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits([...issues, ...pulls.slice(0, middle)])) low = middle
    else high = middle - 1
  }
  return { items: [...issues, ...pulls.slice(0, low)], pullsTruncated: true }
}

function mutationChain<T>(
  chains: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  let resolveResult: (value: T) => void
  let rejectResult: (error: unknown) => void
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const next = previous.then(async () => {
    try { resolveResult(await operation()) } catch (error) { rejectResult(error) }
  })
  chains.set(key, next)
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key) })
  return result
}

export class GitHubIssueService {
  private readonly repositories = new Map<string, RepositoryState>()
  private readonly projectKeys = new Map<string, string>()
  private readonly issueChains = new Map<string, Promise<void>>()
  private readonly repositoryControls = new Map<string, RepositoryControl>()
  private readonly statePreparations = new Map<string, Set<Promise<RepositoryState>>>()
  private readonly refreshFloors = new Map<string, { any: number; full: number }>()
  /** Pull request CI/mergeability per repository key — see pull-status-tracker.ts. */
  private readonly pulls: GitHubPullStatusTracker
  private readonly checkReads = new Map<string, { at: number; result: Promise<GitHubPullChecksResult> }>()
  private readonly checkStarts = new Map<string, number[]>()
  private operationSequence = 0
  private readonly now: () => number
  private readonly schedule: NonNullable<ServiceOptions['setInterval']>
  private readonly unschedule: NonNullable<ServiceOptions['clearInterval']>

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.setInterval ?? ((fn, milliseconds) => setInterval(fn, milliseconds))
    this.unschedule = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
    this.pulls = new GitHubPullStatusTracker({
      coordinator: options.coordinator,
      now: this.now,
      onChanged: (key, changed) => {
        const state = this.repositories.get(key)
        if (state) this.emitDelta(state, changed, true)
      },
      memory: {
        load: (userId, repository) => options.cache.loadPullMemory(userId, repository),
        save: (userId, repository, memory) => options.cache.savePullMemory(userId, repository, memory)
      },
      harvest: (key) => {
        const lifecycles = new Map<number, PullLifecycle>()
        for (const item of this.repositories.get(key)?.snapshot?.issues ?? []) {
          if (!item.pull) continue
          lifecycles.set(item.number, item.state === 'closed'
            ? item.pull.mergedAt ? 'merged' : 'closed'
            : item.pull.draft ? 'draft' : 'open')
        }
        return lifecycles
      }
    })
  }

  async subscribe(uiId: number, request: { projectId: string }): Promise<GitHubIssuePage> {
    const context = await this.cacheContext(request.projectId)
    const { key, state } = await this.cachedState(context)
    const firstSubscriber = this.subscriberCount(state) === 0
    let subscribers = state.subscribers.get(request.projectId)
    if (!subscribers) {
      subscribers = new Set()
      state.subscribers.set(request.projectId, subscribers)
    }
    subscribers.add(uiId)
    this.projectKeys.set(request.projectId, key)
    if (firstSubscriber) {
      if (!state.snapshot && !state.partialIssues) {
        try { await this.refresh({ projectId: request.projectId }) } catch { /* offline cache remains readable */ }
      } else {
        void this.refresh({ projectId: request.projectId }).catch(() => undefined)
      }
    }
    const activeKey = this.projectKeys.get(request.projectId)
    this.ensureTimer(activeKey ? this.repositories.get(activeKey) ?? state : state)
    return this.query({ projectId: request.projectId, columnId: null, pageSize: 50 })
  }

  unsubscribe(uiId: number, projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.repositories.get(key) : undefined
    if (!state) return
    const subscribers = state.subscribers.get(projectId)
    subscribers?.delete(uiId)
    if (subscribers?.size === 0) state.subscribers.delete(projectId)
    if (this.subscriberCount(state) === 0 && state.timer) {
      this.unschedule(state.timer)
      delete state.timer
    }
  }

  dropClient(uiId: number): void {
    for (const state of this.repositories.values()) {
      for (const [projectId, subscribers] of state.subscribers) {
        subscribers.delete(uiId)
        if (subscribers.size === 0) state.subscribers.delete(projectId)
      }
      if (this.subscriberCount(state) === 0 && state.timer) {
        this.unschedule(state.timer)
        delete state.timer
      }
    }
  }

  async refresh(request: { projectId: string; full?: boolean }): Promise<void> {
    // The floor is checked BEFORE contextForProject on purpose: resolving a context runs the whole
    // credential chain (gh subprocesses + a /user round trip), so a throttle placed after it would
    // still pay the expensive half of every call it rejects.
    const full = request.full === true
    const startedAt = this.now()
    const previousFloor = this.refreshFloors.get(request.projectId)
    if (previousFloor && startedAt < (full ? previousFloor.full : previousFloor.any)) return
    this.refreshFloors.set(request.projectId, {
      any: startedAt + REFRESH_MIN_INTERVAL_MS,
      // An incremental pass does not satisfy a full reconciliation, so it never moves that floor.
      full: full ? startedAt + FULL_REFRESH_MIN_INTERVAL_MS : previousFloor?.full ?? 0
    })
    try {
      // Reuse the clock read above as the refresh's own start stamp: one read per refresh keeps the
      // incremental watermark anchored to when the work actually began.
      // A foreground refresh is never held by the budget, so there is no throttle to hand back.
      await this.refreshWithinFloor(request, startedAt)
    } catch (error) {
      // A refresh that FAILED bought nothing, so it must not hold the floor — otherwise the first
      // network blip disables the board's own Retry button for the next 30 seconds.
      if (this.refreshFloors.get(request.projectId)?.any === startedAt + REFRESH_MIN_INTERVAL_MS) {
        if (previousFloor) this.refreshFloors.set(request.projectId, previousFloor)
        else this.refreshFloors.delete(request.projectId)
      }
      throw error
    }
  }

  /** Resolves to the throttle when a BACKGROUND refresh was held by the rate budget (nothing was
   *  sent), otherwise to nothing. */
  private async refreshWithinFloor(
    request: { projectId: string; full?: boolean },
    startedAt = this.now(),
    background = false
  ): Promise<GitHubThrottle | void> {
    const operationId = ++this.operationSequence
    const captured = await this.options.contextForProject(request.projectId)
    if (background) {
      // Checked after the context resolves because the budget belongs to an IDENTITY, and only the
      // context knows which one. Nothing below this line has spent a request yet.
      const throttle = this.options.coordinator.throttle(captured.userId)
      if (throttle) return throttle
    }
    const control = this.repositoryControl(captured.repository)
    if (control.deletion || operationId <= control.clearCutoff) return
    const repositoryGeneration = control.generation
    let state: RepositoryState
    try {
      state = await this.state(captured, operationId, repositoryGeneration)
    } catch (error) {
      if (error instanceof RepositoryClearedError) return
      throw error
    }
    if (state.refresh) return state.refresh
    const cacheGeneration = state.cacheGeneration
    const work = this.refreshRepository(
      captured, state, request.full === true, cacheGeneration, operationId, repositoryGeneration,
      startedAt, background
    )
    state.refresh = work
    try { await work } finally { if (state.refresh === work) delete state.refresh }
  }

  async query(request: GitHubIssueQuery): Promise<GitHubIssuePage> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50) {
      throw new Error('invalid-query')
    }
    const context = await this.cacheContext(request.projectId)
    const { state, userId } = await this.cachedState(context)
    const throttle = userId ? this.options.coordinator.throttle(userId) : undefined
    // One snapshot holds both kinds (they arrive on the same endpoint), so the kind filter is
    // what keeps the issue lane's items and counts exactly what they were before pull requests
    // were harvested. An absent kind means issues.
    const wantPull = request.kind === 'pull'
    const source = (state.snapshot?.issues ?? state.partialIssues ?? [])
      .filter((item) => !!item.pull === wantPull)
    const mapped = source.map((issue): GitHubIssueCardView => ({ ...issue, ...mapping(issue, context.config) }))
    const search = request.search?.trim().toLocaleLowerCase('en-US') ?? ''
    const filters = new Set((request.labelFilter ?? []).map((item) =>
      foldLabel(item.replace(/^github:/, ''))))
    const filtered = mapped.filter((item) => !search || item.title.toLocaleLowerCase('en-US').includes(search) ||
        String(item.number).includes(search))
      .filter((item) => filters.size === 0 || item.labels.some((label) =>
        filters.has(foldLabel(label.name))))
    const visible = filtered.filter((item) => item.columnId === request.columnId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
    const offset = request.cursor ? Number(request.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid-query')
    const page = visible.slice(offset, offset + request.pageSize)
    if (this.options.avatarFetcher) {
      const avatars = await this.options.avatarFetcher.forPage(page.flatMap((item) => item.assignees))
      for (const item of page) {
        const entries = item.assignees.flatMap((user) => {
          const data = avatars.dataUrls.get(user.id)
          return data ? [[String(user.id), data] as const] : []
        })
        if (entries.length) item.avatarDataUrls = Object.fromEntries(entries)
      }
    }
    const counts: Record<string, number> = {}
    for (const item of filtered) {
      counts[item.columnId ?? 'ungrouped'] = (counts[item.columnId ?? 'ungrouped'] ?? 0) + 1
    }
    return {
      items: page,
      counts,
      ...(offset + page.length < visible.length ? { nextCursor: String(offset + page.length) } : {}),
      partial: (!state.snapshot && !!state.partialIssues) ||
        (wantPull && !!state.snapshot?.pullsTruncated),
      // The board never writes a pull request, so its page says so on the wire rather than
      // relying on every consumer to remember.
      readOnly: wantPull || !context.mappingApproved ||
        state.incomplete || !state.snapshot || !context.config.completionColumnId,
      ...(context.mappingApproved ? {} : { mappingNotApproved: true as const }),
      ...(state.snapshot ? {
        lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt,
        lastFullReconciliationAt: state.snapshot.lastFullReconciliationAt
      } : {}),
      ...(throttle ? { throttle } : {})
    }
  }

  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
    closeReason?: GitHubCloseReason
  }): Promise<GitHubMutationResult> {
    // Reachable from the renderer and from a relay guest: an unknown reason is refused here, before
    // anything is read or written, rather than forwarded for GitHub to reject after a round trip.
    if (request.closeReason !== undefined &&
        request.closeReason !== 'completed' && request.closeReason !== 'not_planned') {
      return Promise.resolve({ status: 'invalid-target' })
    }
    const operationId = ++this.operationSequence
    return mutationChain(this.issueChains, `${request.projectId}:${request.issueNumber}`, async () => {
      const captured = await this.options.contextForProject(request.projectId)
      const capturedEpoch = epoch(captured)
      const repositoryGeneration = this.repositoryControl(captured.repository).generation
      let state: RepositoryState
      try {
        state = await this.state(captured, operationId, repositoryGeneration)
      } catch (error) {
        if (error instanceof RepositoryClearedError) return { status: 'read-only' }
        throw error
      }
      const cacheGeneration = state.cacheGeneration
      if (!captured.mappingApproved || state.incomplete || !state.snapshot ||
          !captured.config.completionColumnId) {
        return { status: 'read-only' }
      }
      const target = state.snapshot.issues.find((item) => item.number === request.issueNumber)
      // A pull request shares the issue number space and now lives in the same snapshot, so the
      // membership check alone would let one through to a write path that cannot serve it.
      if (!target || target.pull) return { status: 'invalid-target' }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const latest = await this.readWithEpoch(captured, () =>
        captured.client.getIssue(captured.repository, request.issueNumber))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!latest) return { status: 'configuration-changed' }
      if (latest.updatedAt !== request.expectedUpdatedAt) {
        if (cacheGeneration !== state.cacheGeneration ||
            !this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) {
          return { status: 'stale', issue: latest }
        }
        state.snapshot = {
          ...state.snapshot,
          issues: state.snapshot.issues.map((item) => item.number === latest.number ? latest : item)
        }
        try {
          await this.options.cache.saveComplete(captured.userId, captured.repository, state.snapshot)
        } catch { /* the validated in-memory issue remains available for this process */ }
        this.emitDelta(state, [latest.number])
        return { status: 'stale', issue: latest }
      }
      const destination = request.toColumnId === null
        ? null
        : captured.config.columnMappings.find((item) => item.columnId === request.toColumnId)
      if (request.toColumnId !== null && !destination) return { status: 'invalid-target' }
      const mappedNames = new Set(captured.config.columnMappings.map((item) =>
        foldLabel(item.label)))
      const labels = latest.labels.map((label) => label.name)
        .filter((name) => !mappedNames.has(foldLabel(name)))
      if (destination) labels.push(destination.label)
      const desiredState = request.toColumnId === captured.config.completionColumnId
        ? 'closed'
        : 'open'
      const input: UpdateIssueInput = {
        // Send `state` ONLY when it actually changes. GitHub rewrites `state_reason` for any write
        // that carries `state`, so re-closing an already-closed issue turns a deliberate
        // 'not_planned' (wontfix) into 'completed'. Closed issues all map into the completion
        // column, so a drag that lands one back where it already sits is a no-op the user never
        // meant as a state change — and it must not be one on GitHub either.
        // When it DOES change, the reason travels with it: the one the user picked for a close
        // (GitHub's own default, `completed`, when none was given), and `reopened` for a reopen.
        ...(latest.state === desiredState ? {} : {
          state: desiredState,
          stateReason: desiredState === 'closed' ? request.closeReason ?? 'completed' : 'reopened'
        }),
        labels
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const updated = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.updateIssue(captured.repository, request.issueNumber, input)
      }).catch((error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        throw error
      })
      if (!updated) return { status: 'configuration-changed' }
      const confirmedLabels = new Set(updated.labels.map((label) =>
        label.name.normalize('NFKC').toLocaleLowerCase('en-US')))
      const expectedLabels = new Set(labels.map((label) =>
        label.normalize('NFKC').toLocaleLowerCase('en-US')))
      if (updated.state !== desiredState ||
          (input.state === 'closed' && updated.stateReason !== input.stateReason) ||
          confirmedLabels.size !== expectedLabels.size ||
          [...expectedLabels].some((label) => !confirmedLabels.has(label))) {
        throw new Error('mutation-not-confirmed')
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'confirmed', issue: updated }
      }
      if (cacheGeneration !== state.cacheGeneration) {
        return { status: 'refresh-pending', issue: updated }
      }
      if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) {
        return { status: 'refresh-pending', issue: updated }
      }
      // The write folds ONE issue into the snapshot and leaves `lastSuccessfulRefreshAt` alone: that
      // is the incremental scan's `since` cursor, and only a completed scan has looked at everything
      // up to it. Advancing it here skipped any third party's change that landed between the last
      // scan and this write until the next daily full reconciliation.
      const snapshot = state.snapshot ?? {
        issues: [], etags: {}, lastSuccessfulRefreshAt: 0, lastFullReconciliationAt: 0
      }
      const issues = snapshot.issues.some((item) => item.number === updated.number)
        ? snapshot.issues.map((item) => item.number === updated.number ? updated : item)
        : [...snapshot.issues, updated]
      state.snapshot = { ...snapshot, issues }
      state.partialIssues = undefined
      try {
        await this.options.cache.saveComplete(captured.userId, captured.repository, state.snapshot)
      } catch {
        return { status: 'refresh-pending', issue: updated }
      }
      this.emitDelta(state, [updated.number])
      return { status: 'confirmed', issue: updated }
    })
  }

  async createMissingLabels(request: { projectId: string }): Promise<CreateMappedLabelsResult> {
    const operationId = ++this.operationSequence
    const captured = await this.options.contextForProject(request.projectId)
    const capturedEpoch = epoch(captured)
    const repositoryGeneration = this.repositoryControl(captured.repository).generation
    let state: RepositoryState
    try {
      state = await this.state(captured, operationId, repositoryGeneration)
    } catch (error) {
      if (error instanceof RepositoryClearedError) {
        return { status: 'read-only', created: [], remaining:
          captured.config.columnMappings.map((item) => item.label) }
      }
      throw error
    }
    // Label names come from the column mapping, so creating them is a write the mapping drives.
    if (!captured.mappingApproved || state.incomplete || !captured.config.completionColumnId) {
      return {
        status: 'read-only',
        created: [],
        remaining: captured.config.columnMappings.map((item) => item.label)
      }
    }
    const known = new Set<string>()
    let page = 1
    while (true) {
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return {
          status: 'configuration-changed',
          created: [],
          remaining: captured.config.columnMappings.map((item) => item.label)
        }
      }
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listRepositoryLabels(captured.repository, { page, perPage: 100 }))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!result) {
        return { status: 'configuration-changed', created: [], remaining:
          captured.config.columnMappings.map((item) => item.label) }
      }
      for (const label of result.items) known.add(label.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      if (!result.nextPage) break
      page = result.nextPage
    }
    const pending = captured.config.columnMappings.filter((item) =>
      !known.has(item.label.normalize('NFKC').toLocaleLowerCase('en-US')))
    const created: string[] = []
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      const current = await this.repositoryLabelNames(captured).catch((error: unknown) =>
        error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!current) {
        return {
          status: 'configuration-changed', created,
          remaining: pending.slice(index).map((candidate) => candidate.label)
        }
      }
      const folded = item.label.normalize('NFKC').toLocaleLowerCase('en-US')
      if (current.has(folded)) continue
      const color = captured.columnColors[item.columnId]?.replace(/^#/, '')
      const result = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.createLabel(captured.repository, {
          name: item.label,
          color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '8b5cf6'
        })
      }).catch(async (error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        const after = await this.repositoryLabelNames(captured).catch(() => null)
        if (after?.has(folded)) return { concurrent: true } as const
        return { failed: true } as const
      })
      if (!result) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      if ('failed' in result) {
        return {
          status: 'partial', created,
          remaining: pending.slice(index).map((candidate) => candidate.label)
        }
      }
      if ('concurrent' in result) {
        known.add(folded)
      } else {
        known.add(result.name.normalize('NFKC').toLocaleLowerCase('en-US'))
        created.push(item.label)
      }
    }
    return { status: 'confirmed', created, remaining: [] }
  }

  async clearCache(request: { projectId: string }): Promise<void> {
    const clearOperationId = ++this.operationSequence
    const context = this.options.projectContextForCacheDeletion
      ? await this.options.projectContextForCacheDeletion(request.projectId)
      : await this.cacheContext(request.projectId)
    const control = this.repositoryControl(context.repository)
    if (control.deletion) await control.deletion
    let finishDeletion!: () => void
    const deletion = new Promise<void>((resolve) => { finishDeletion = resolve })
    control.clearCutoff = Math.max(control.clearCutoff, clearOperationId)
    control.generation += 1
    control.deletion = deletion
    try {
      const affected = this.repositoryStates(context.localApprovalId, context.repository)
      for (const state of affected) state.cacheGeneration += 1
      const mutations = [...this.issueChains.values()]
      await Promise.allSettled([
        ...this.statePreparations.get(context.repository) ?? [],
        ...affected.flatMap((state) => state.refresh ? [state.refresh] : []),
        ...mutations,
        // Forgotten BEFORE the files go, and waited for: a memory save already under way would
        // otherwise write the pull memory back after clearBound deleted it.
        this.pulls.forgetRepository(context.repository)
      ])
      await this.options.cache.clearBound(context.localApprovalId, context.projectId, context.repository)
      for (const state of this.repositoryStates(context.localApprovalId, context.repository)) {
        state.cacheGeneration += 1
        state.snapshot = undefined
        state.partialIssues = undefined
        state.incomplete = false
        this.emitDelta(state, [], true)
      }
    } finally {
      if (control.deletion === deletion) delete control.deletion
      finishDeletion()
    }
  }

  /** What the board knows about this project's pull requests beyond the issues harvest. Read from
   *  memory only — it never sends a request. */
  async pullStatus(request: { projectId: string }): Promise<GitHubPullBoard> {
    const context = await this.cacheContext(request.projectId)
    const { key } = await this.cachedState(context)
    return this.pulls.board(key)
  }

  /**
   * Everything the read-only control verbs (`issues` / `prs`, core/github/control-read.ts) show, from
   * what this process ALREADY holds: the issue cache and the pull tracker's memory. It sends no
   * request, resolves no credential and starts no poll — an agent's read must never spend the
   * account's GitHub budget or wake a repository nobody has subscribed to. Throws the host's coded
   * errors (`not-approved`, `invalid-configuration`, …) exactly like `query`, so a caller can say
   * WHY there is nothing to show rather than "0 issues".
   */
  async controlSnapshot(projectId: string): Promise<GitHubControlSnapshot> {
    const context = await this.cacheContext(projectId)
    const { key, state, userId } = await this.cachedState(context)
    const source = state.snapshot?.issues ?? state.partialIssues ?? []
    const throttle = userId ? this.options.coordinator.throttle(userId) : undefined
    return {
      repository: context.repository,
      ...(context.project ? { project: context.project } : {}),
      completionColumnId: context.config.completionColumnId,
      mappingApproved: context.mappingApproved,
      items: source.map((issue): GitHubIssueCardView => ({ ...issue, ...mapping(issue, context.config) })),
      hasSnapshot: !!state.snapshot,
      partial: !state.snapshot && !!state.partialIssues,
      incomplete: state.incomplete,
      pullsTruncated: !!state.snapshot?.pullsTruncated,
      ...(state.snapshot ? { lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt } : {}),
      pullBoard: this.pulls.board(key),
      ...(throttle ? { throttle } : {})
    }
  }

  /**
   * A VISIBLE board asks this while some PR is undecided. It answers false at the cost of a map
   * lookup unless a chase read is due, so a board may ask as often as it likes: the schedule and the
   * cap of 12 live here, and only a due read resolves a context (which runs the credential chain).
   */
  async chasePulls(request: { projectId: string }): Promise<boolean> {
    const key = this.projectKeys.get(request.projectId)
    if (!key || !this.pulls.claimChase(key)) return false
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(request.projectId)
    } catch {
      return false
    }
    if (repositoryKey(captured) !== key || !captured.client.pullRequestStatuses) return false
    await this.pulls.read(key, captured.userId, 'chase', () =>
      this.readWithEpoch(captured, () => captured.client.pullRequestStatuses!(captured.repository)))
    return true
  }

  /**
   * The one-time permission for the board to move `cardId` because every PR in `pulls` merged. The
   * first ask wins across every window (two Server Edition tabs cannot both move it), and it is
   * remembered per PR, so a card the user dragged back is not moved again for the same merges — even
   * after one of them ages off the pull board. It sends no request and resolves no credential.
   */
  async claimPullAutoMove(request: { projectId: string; cardId: string; pulls: number[] }): Promise<boolean> {
    const key = this.validPullCardRequest(request)
    if (!key) return false
    const { projectId, cardId, pulls } = request
    return this.pulls.claimMove(key, projectId, cardId, pulls)
  }

  /**
   * A visible, armed board reports "this card is waiting on these still-open PRs". The host keeps a
   * note only for PRs it holds as open itself; `claimPullAutoMove` later requires one. Sends no
   * request and resolves no credential.
   */
  async notePullWaits(request: { projectId: string; cardId: string; pulls: number[] }): Promise<number> {
    const key = this.validPullCardRequest(request)
    if (!key) return 0
    return this.pulls.noteWaits(key, request.projectId, request.cardId, request.pulls)
  }

  /** The repository key for a well-formed card request on a bound project that is not being cleared. */
  private validPullCardRequest(
    request: { projectId: string; cardId: string; pulls: number[] } | null | undefined
  ): string | null {
    const { projectId, cardId, pulls } = request ?? {}
    if (typeof projectId !== 'string' || typeof cardId !== 'string' || !cardId || cardId.length > 256 ||
        /[\u0000-\u001f]/.test(cardId) || !Array.isArray(pulls) || pulls.length === 0 || pulls.length > 100 ||
        pulls.some((pull) => !Number.isSafeInteger(pull) || pull < 1)) return null
    const key = this.projectKeys.get(projectId)
    if (!key || key.startsWith('unbound:')) return null
    if (this.repositoryControl(key.slice(key.indexOf('\0') + 1)).deletion) return null
    return key
  }

  /** Per-check detail for one PR, read when its modal opens. Never throws: every failure is one of
   *  the result's own statuses, so a modal can always say what it knows. */
  async pullChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult> {
    if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber < 1) {
      return { status: 'unavailable' }
    }
    const now = this.now()
    const key = `${request.projectId}\0${request.pullNumber}`
    const recent = this.checkReads.get(key)
    if (recent && now - recent.at < PULL_CHECKS_REUSE_MS) return recent.result
    const starts = (this.checkStarts.get(request.projectId) ?? []).filter((at) => now - at < 60_000)
    if (starts.length >= PULL_CHECKS_PER_MINUTE) {
      this.checkStarts.set(request.projectId, starts)
      return { status: 'unavailable' }
    }
    this.checkStarts.set(request.projectId, [...starts, now])
    for (const [candidate, entry] of this.checkReads) {
      if (now - entry.at >= PULL_CHECKS_REUSE_MS) this.checkReads.delete(candidate)
    }
    const result = this.readPullChecks(request)
    this.checkReads.set(key, { at: now, result })
    return result
  }

  private async readPullChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult> {
    let captured: GitHubIssueServiceContext
    try {
      captured = await this.options.contextForProject(request.projectId)
    } catch {
      return { status: 'unavailable' }
    }
    if (!captured.client.pullRequestChecks) return { status: 'unavailable' }
    // A token already known to be unable to read checks is not asked again.
    if (!this.pulls.board(repositoryKey(captured)).access.ci) return { status: 'hidden' }
    const throttle = this.options.coordinator.throttle(captured.userId, this.now(), 'graphql')
    if (throttle?.kind === 'rate-limited') return { status: 'unavailable' }
    try {
      return await this.readWithEpoch(captured, () =>
        captured.client.pullRequestChecks!(captured.repository, request.pullNumber))
    } catch (error) {
      // A 403 that is not a rate limit: this token may not read the checks. Say nothing about them.
      return (error as { code?: unknown } | null)?.code === 'insufficient-permission'
        ? { status: 'hidden' }
        : { status: 'unavailable' }
    }
  }

  private readPullStatusAfterHeartbeat(
    captured: GitHubIssueServiceContext,
    changed: boolean,
    foreground: boolean
  ): void {
    const key = repositoryKey(captured)
    if (!captured.client.pullRequestStatuses) return
    if (!this.pulls.wantsReadAfterHeartbeat(key, { changed, foreground })) return
    void this.pulls.read(key, captured.userId, foreground ? 'foreground' : 'heartbeat', () =>
      this.readWithEpoch(captured, () => captured.client.pullRequestStatuses!(captured.repository)))
      .catch(() => undefined)
  }

  private state(
    context: GitHubIssueServiceContext,
    operationId: number,
    repositoryGeneration: number
  ): Promise<RepositoryState> {
    const work = this.prepareState(context, operationId, repositoryGeneration)
    let preparations = this.statePreparations.get(context.repository)
    if (!preparations) {
      preparations = new Set()
      this.statePreparations.set(context.repository, preparations)
    }
    preparations.add(work)
    void work.finally(() => {
      preparations!.delete(work)
      if (preparations!.size === 0) this.statePreparations.delete(context.repository)
    }).catch(() => undefined)
    return work
  }

  private async prepareState(
    context: GitHubIssueServiceContext,
    operationId: number,
    repositoryGeneration: number
  ): Promise<RepositoryState> {
    this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
    await this.options.cache.bind(
      context.localApprovalId, context.projectId, context.repository, context.userId
    )
    this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
    const key = repositoryKey(context)
    const unboundKey = `unbound:${context.localApprovalId}\0${context.repository}`
    const unbound = this.repositories.get(unboundKey)
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(context.userId, context.repository)
      this.assertRepositoryWriteAllowed(context.repository, operationId, repositoryGeneration)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.repositories.set(key, state)
    }
    if (unbound && unbound !== state) {
      for (const [projectId, subscribers] of unbound.subscribers) {
        let target = state.subscribers.get(projectId)
        if (!target) {
          target = new Set()
          state.subscribers.set(projectId, target)
        }
        for (const uiId of subscribers) target.add(uiId)
      }
      if (unbound.timer) {
        this.unschedule(unbound.timer)
        delete unbound.timer
      }
      this.repositories.delete(unboundKey)
      this.ensureTimer(state)
    }
    this.migrateProjectState(context.projectId, key, state)
    this.projectKeys.set(context.projectId, key)
    return state
  }

  private async cacheContext(projectId: string): Promise<GitHubIssueProjectContext> {
    if (this.options.projectContextForCache) return this.options.projectContextForCache(projectId)
    return this.options.contextForProject(projectId)
  }

  private async cachedState(context: GitHubIssueProjectContext): Promise<{
    key: string
    state: RepositoryState
    /** The identity the project's cache is bound to; null before its first authenticated refresh. */
    userId: string | null
  }> {
    await this.waitForRepositoryDeletion(context.repository)
    const repositoryGeneration = this.repositoryControl(context.repository).generation
    const userId = await this.options.cache.boundUserId(
      context.localApprovalId, context.projectId, context.repository
    )
    if (!userId) {
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      const key = `unbound:${context.localApprovalId}\0${context.repository}`
      let state = this.repositories.get(key)
      if (!state) {
        state = { incomplete: false, subscribers: new Map(), cacheGeneration: 0 }
        this.repositories.set(key, state)
      }
      this.projectKeys.set(context.projectId, key)
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      return { key, state, userId: null }
    }
    const key = `${userId}\0${context.repository}`
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(userId, context.repository)
      if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
        return this.cachedState(context)
      }
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map(),
        cacheGeneration: 0
      }
      this.repositories.set(key, state)
    }
    this.projectKeys.set(context.projectId, key)
    if (repositoryGeneration !== this.repositoryControl(context.repository).generation) {
      return this.cachedState(context)
    }
    return { key, state, userId }
  }

  private async refreshRepository(
    captured: GitHubIssueServiceContext,
    state: RepositoryState,
    forceFull: boolean,
    cacheGeneration: number,
    operationId: number,
    repositoryGeneration: number,
    refreshStartedAt: number,
    background = false
  ): Promise<void> {
    const full = forceFull || !state.snapshot ||
      this.now() - state.snapshot.lastFullReconciliationAt >= FULL_REFRESH_AGE
    const previous = state.snapshot
    const byNumber = new Map((full ? [] : previous?.issues ?? []).map((issue) => [issue.number, issue]))
    // An incremental pass starts from a set a previous eviction may already have thinned, and it
    // never re-fetches what was dropped — so the claim survives until a full reconciliation
    // re-reads the repository and can honestly clear it.
    let pullsTruncated = !full && !!previous?.pullsTruncated
    // The heartbeat runs BEFORE the scan, and it is its validator — not one read afterwards — that
    // gets stored: a change landing while the scan pages is then still "new" to the next heartbeat.
    // A 304 skips the scan outright. It never skips a full reconciliation (deletions and transfers
    // do not move the top item, so that pass is the only thing that can see them), and never an
    // incomplete repository, which a 304 would otherwise freeze read only.
    const storedEtag = previous?.etags[HEARTBEAT_ETAG_KEY]
    const beat = await this.readWithEpoch(captured, () =>
      captured.client.issuesHeartbeat(captured.repository, storedEtag))
      .catch((error: unknown) =>
        error instanceof ConfigurationChangedError ? null : Promise.reject(error))
    if (!beat) return
    // The heartbeat is also what decides whether pull request CI/mergeability is worth a GraphQL
    // read. It runs beside the issue scan, not after it: the board's issues never wait on it.
    this.readPullStatusAfterHeartbeat(captured, !beat.notModified, !background)
    if (beat.notModified && !full && previous && !state.incomplete) {
      // Nothing to fetch — but subscribers still re-read their pages, from the local cache, as every
      // successful refresh has always made them do. A page is not only issues: read only, the
      // mapping approval and the completion column are derived by the host at query time, and a
      // board never prompted keeps showing the old answer (e.g. read only after its approval).
      this.emitDelta(state, [], true)
      return
    }
    const heartbeatEtag = beat.etag
    const etags: Record<string, string> = heartbeatEtag ? { [HEARTBEAT_ETAG_KEY]: heartbeatEtag } : {}
    let page = 1
    while (true) {
      if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
          cacheGeneration !== state.cacheGeneration ||
          epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
      const since = !full && previous?.lastSuccessfulRefreshAt
        ? new Date(Math.max(0, previous.lastSuccessfulRefreshAt - 2_000)).toISOString()
        : undefined
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listIssues(captured.repository, {
          state: 'all', page, perPage: 100, ...(since ? { since } : {})
        })).catch((error: unknown) =>
          error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!result) return
      if (!result.notModified) {
        for (const item of result.items) {
          const old = byNumber.get(item.number)
          if (!old || item.updatedAt >= old.updatedAt) byNumber.set(item.number, item)
        }
      }
      if (byNumber.size > MAX_ISSUES) {
        const trimmed = evictPullsToFit(
          [...byNumber.values()], (candidate) => candidate.length <= MAX_ISSUES
        )
        if (!trimmed) {
          await this.incomplete(
            captured, state, 'issue-limit', [...byNumber.values()].slice(0, MAX_ISSUES),
            cacheGeneration, operationId, repositoryGeneration
          )
          return
        }
        // Paging continues on the trimmed set: each firing drops at least one item, so the scan
        // stays bounded, and a later page's issue still displaces a pull request rather than the
        // scan giving up.
        byNumber.clear()
        for (const item of trimmed.items) byNumber.set(item.number, item)
        pullsTruncated = pullsTruncated || trimmed.pullsTruncated
      }
      if (!result.nextPage) break
      page = result.nextPage
    }
    const harvest = [...byNumber.values()]
    const withinBytes = evictPullsToFit(harvest, (candidate) =>
      Buffer.byteLength(JSON.stringify(candidate), 'utf-8') <= MAX_CACHE_BYTES)
    if (!withinBytes) {
      await this.incomplete(
        captured, state, 'byte-limit', harvest, cacheGeneration, operationId, repositoryGeneration
      )
      return
    }
    const issues = withinBytes.items
    pullsTruncated = pullsTruncated || withinBytes.pullsTruncated
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration ||
        epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
    const snapshot: GitHubCompleteSnapshot = {
      issues,
      etags,
      lastSuccessfulRefreshAt: refreshStartedAt,
      lastFullReconciliationAt: full
        ? refreshStartedAt
        : previous?.lastFullReconciliationAt ?? refreshStartedAt,
      ...(pullsTruncated ? { pullsTruncated: true } : {})
    }
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration)) return
    await this.options.cache.saveComplete(captured.userId, captured.repository, snapshot)
    if (!this.repositoryWriteAllowed(captured.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    const oldNumbers = new Map((previous?.issues ?? []).map((item) => [item.number, item.updatedAt]))
    const nextNumbers = new Set(issues.map((item) => item.number))
    const changed = [
      ...issues.filter((item) => oldNumbers.get(item.number) !== item.updatedAt)
        .map((item) => item.number),
      ...(previous?.issues ?? []).filter((item) => !nextNumbers.has(item.number))
        .map((item) => item.number)
    ]
    state.snapshot = snapshot
    state.partialIssues = undefined
    state.incomplete = false
    this.emitDelta(state, changed, true)
  }

  private subscriberCount(state: RepositoryState): number {
    let count = 0
    for (const subscribers of state.subscribers.values()) count += subscribers.size
    return count
  }

  private ensureTimer(state: RepositoryState): void {
    if (state.timer || this.subscriberCount(state) === 0) return
    state.timer = this.schedule(() => this.poll(state), POLL_MS)
  }

  private async poll(state: RepositoryState): Promise<void> {
    for (const projectId of [...state.subscribers.keys()]) {
      try {
        // Deliberately BELOW the caller floor: the floor bounds callers we don't control (the
        // renderer, and a relay guest on a shared project), while the poll is already paced by
        // POLL_MS. Routing it through the floor would also break this loop's fallback — a
        // throttled call returns without throwing, which reads here as "this project worked" and
        // would stop us ever trying the next subscriber's context.
        // It IS a background refresh, though, so the rate budget may hold it.
        const throttle = await this.refreshWithinFloor({ projectId }, undefined, true)
        // A refresh that ran prompted its subscribers itself (a 304 included), which is also what
        // clears a lifted "held until" line from the board.
        if (throttle) this.announceThrottle(state, throttle.until)
        return
      } catch (error) {
        const failure = classifyGitHubFailure(error)
        if (failure.kind === 'rate-limited' && failure.retryAt !== undefined) {
          this.announceThrottle(state, failure.retryAt)
        }
        // Another approved project may still provide a valid context for the shared repository.
      }
    }
  }

  /** A held poll changes nothing the board can see except WHY it is quiet. Prompt its subscribers
   *  to re-read (the page carries the throttle) — once per deadline, not once per skipped minute. */
  private announceThrottle(state: RepositoryState, until: number): void {
    if (state.announcedThrottleUntil === until) return
    state.announcedThrottleUntil = until
    this.emitDelta(state, [], true)
  }

  /** Prompts one project's subscribers to re-read their pages. For a change the host makes that
   *  no refresh would report — an approval given or withdrawn — so the board does not wait for the
   *  next poll (or, before polls re-prompted, for something to change on GitHub). */
  notifyProject(projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.repositories.get(key) : undefined
    for (const uiId of state?.subscribers.get(projectId) ?? []) {
      this.options.onDelta?.(uiId, projectId, [])
    }
  }

  private migrateProjectState(projectId: string, key: string, target: RepositoryState): void {
    const previousKey = this.projectKeys.get(projectId)
    if (!previousKey || previousKey === key) return
    const previous = this.repositories.get(previousKey)
    const subscribers = previous?.subscribers.get(projectId)
    if (!previous || !subscribers) return
    let destination = target.subscribers.get(projectId)
    if (!destination) {
      destination = new Set()
      target.subscribers.set(projectId, destination)
    }
    for (const uiId of subscribers) destination.add(uiId)
    previous.subscribers.delete(projectId)
    if (this.subscriberCount(previous) === 0 && previous.timer) {
      this.unschedule(previous.timer)
      delete previous.timer
    }
    this.ensureTimer(target)
  }

  private repositoryControl(repository: string): RepositoryControl {
    let control = this.repositoryControls.get(repository)
    if (!control) {
      control = { generation: 0, clearCutoff: 0 }
      this.repositoryControls.set(repository, control)
    }
    return control
  }

  private repositoryWriteAllowed(
    repository: string,
    operationId: number,
    repositoryGeneration: number
  ): boolean {
    const control = this.repositoryControl(repository)
    return !control.deletion && operationId > control.clearCutoff &&
      repositoryGeneration === control.generation
  }

  private assertRepositoryWriteAllowed(
    repository: string,
    operationId: number,
    repositoryGeneration: number
  ): void {
    if (!this.repositoryWriteAllowed(repository, operationId, repositoryGeneration)) {
      throw new RepositoryClearedError()
    }
  }

  private async waitForRepositoryDeletion(repository: string): Promise<void> {
    while (this.repositoryControl(repository).deletion) {
      await this.repositoryControl(repository).deletion
    }
  }

  private repositoryStates(localApprovalId: string, repository: string): RepositoryState[] {
    const states: RepositoryState[] = []
    for (const [key, state] of this.repositories) {
      if (key.endsWith(`\0${repository}`) || key === `unbound:${localApprovalId}\0${repository}`) {
        states.push(state)
      }
    }
    return states
  }

  private readWithEpoch<T>(captured: GitHubIssueServiceContext, operation: () => Promise<T>): Promise<T> {
    return this.options.coordinator.runRead(captured.userId, async () => {
      if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) {
        throw new ConfigurationChangedError()
      }
      return operation()
    })
  }

  private async repositoryLabelNames(captured: GitHubIssueServiceContext): Promise<Set<string>> {
    const names = new Set<string>()
    let page = 1
    while (true) {
      const result = await this.readWithEpoch(captured, () =>
        captured.client.listRepositoryLabels(captured.repository, { page, perPage: 100 }))
      for (const label of result.items) {
        names.add(label.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      }
      if (!result.nextPage) return names
      page = result.nextPage
    }
  }

  private emitDelta(
    state: RepositoryState,
    changedIssueNumbers: number[],
    includeEmpty = false
  ): void {
    if (!includeEmpty && changedIssueNumbers.length === 0) return
    for (const [projectId, subscribers] of state.subscribers) {
      for (const uiId of subscribers) this.options.onDelta?.(uiId, projectId, changedIssueNumbers)
    }
  }

  private async incomplete(
    context: GitHubIssueServiceContext,
    state: RepositoryState,
    reason: 'issue-limit' | 'byte-limit',
    issues: GitHubIssue[],
    cacheGeneration: number,
    operationId: number,
    repositoryGeneration: number
  ): Promise<void> {
    if (!this.repositoryWriteAllowed(context.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    await this.options.cache.saveIncompleteAttempt(context.userId, context.repository, {
      reason,
      observedAt: this.now(),
      ...(!state.snapshot ? { partialIssues: issues } : {})
    })
    if (!this.repositoryWriteAllowed(context.repository, operationId, repositoryGeneration) ||
        cacheGeneration !== state.cacheGeneration) return
    if (!state.snapshot) state.partialIssues = issues
    state.incomplete = true
    this.emitDelta(state, [], true)
  }
}

/** Carries a `code` like every other error the pull status tracker reads: a context that changed
 *  mid-read is not a failed read, and must not mark the board stale. */
class ConfigurationChangedError extends Error {
  readonly code = 'configuration-changed'
}
class RepositoryClearedError extends Error {}
