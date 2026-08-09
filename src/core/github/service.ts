import type {
  CreateMappedLabelsResult,
  GitHubIssue,
  GitHubIssueCardView,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubMutationResult,
  GitHubRepositoryLabel,
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
import type { GitHubRequestCoordinator } from './request-coordinator'

const MAX_ISSUES = 10_000
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const FULL_REFRESH_AGE = 24 * 60 * 60_000
const POLL_MS = 60_000

export interface GitHubIssuesClientLike {
  listIssues(repository: string, options: ListIssueOptions): Promise<IssuePageResult>
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
}

export interface GitHubIssueProjectContext {
  localApprovalId: string
  projectId: string
  repository: string
  config: NormalisedProjectKanbanGitHub
  controlRevision: number
  columnColors: Record<string, string>
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
  private readonly now: () => number
  private readonly schedule: NonNullable<ServiceOptions['setInterval']>
  private readonly unschedule: NonNullable<ServiceOptions['clearInterval']>

  constructor(private readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.setInterval ?? ((fn, milliseconds) => setInterval(fn, milliseconds))
    this.unschedule = options.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  }

  async subscribe(uiId: number, request: { projectId: string }): Promise<GitHubIssuePage> {
    const context = await this.cacheContext(request.projectId)
    const { key, state } = await this.cachedState(context)
    let subscribers = state.subscribers.get(request.projectId)
    if (!subscribers) {
      subscribers = new Set()
      state.subscribers.set(request.projectId, subscribers)
    }
    subscribers.add(uiId)
    this.projectKeys.set(request.projectId, key)
    if (!state.timer) {
      state.timer = this.schedule(() => {
        const projectId = state.subscribers.keys().next().value as string | undefined
        if (projectId) void this.refresh({ projectId }).catch(() => undefined)
      }, POLL_MS)
    }
    if (!state.snapshot && !state.partialIssues) {
      try { await this.refresh({ projectId: request.projectId }) } catch { /* offline cache remains readable */ }
    }
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
    const captured = await this.options.contextForProject(request.projectId)
    const state = await this.state(captured)
    if (state.refresh) return state.refresh
    const work = this.refreshRepository(captured, state, request.full === true)
    state.refresh = work
    try { await work } finally { if (state.refresh === work) delete state.refresh }
  }

  async query(request: GitHubIssueQuery): Promise<GitHubIssuePage> {
    if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50) {
      throw new Error('invalid-query')
    }
    const context = await this.cacheContext(request.projectId)
    const { state } = await this.cachedState(context)
    const source = state.snapshot?.issues ?? state.partialIssues ?? []
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
      partial: !state.snapshot && !!state.partialIssues,
      readOnly: state.incomplete || !state.snapshot || !context.config.completionColumnId,
      ...(state.snapshot ? {
        lastSuccessfulRefreshAt: state.snapshot.lastSuccessfulRefreshAt,
        lastFullReconciliationAt: state.snapshot.lastFullReconciliationAt
      } : {})
    }
  }

  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<GitHubMutationResult> {
    return mutationChain(this.issueChains, `${request.projectId}:${request.issueNumber}`, async () => {
      const captured = await this.options.contextForProject(request.projectId)
      const capturedEpoch = epoch(captured)
      const state = await this.state(captured)
      if (state.incomplete || !state.snapshot || !captured.config.completionColumnId) {
        return { status: 'read-only' }
      }
      if (!state.snapshot.issues.some((item) => item.number === request.issueNumber)) {
        return { status: 'invalid-target' }
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const latest = await this.readWithEpoch(captured, () =>
        captured.client.getIssue(captured.repository, request.issueNumber))
        .catch((error: unknown) => error instanceof ConfigurationChangedError ? null : Promise.reject(error))
      if (!latest) return { status: 'configuration-changed' }
      if (latest.updatedAt !== request.expectedUpdatedAt) {
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
      const input: UpdateIssueInput = {
        state: request.toColumnId === captured.config.completionColumnId ? 'closed' : 'open',
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
      if (updated.state !== input.state || confirmedLabels.size !== expectedLabels.size ||
          [...expectedLabels].some((label) => !confirmedLabels.has(label))) {
        throw new Error('mutation-not-confirmed')
      }
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'confirmed', issue: updated }
      }
      const snapshot = state.snapshot ?? {
        issues: [], etags: {}, lastSuccessfulRefreshAt: this.now(), lastFullReconciliationAt: 0
      }
      const issues = snapshot.issues.some((item) => item.number === updated.number)
        ? snapshot.issues.map((item) => item.number === updated.number ? updated : item)
        : [...snapshot.issues, updated]
      state.snapshot = { ...snapshot, issues, lastSuccessfulRefreshAt: this.now() }
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
    const captured = await this.options.contextForProject(request.projectId)
    const capturedEpoch = epoch(captured)
    const state = await this.state(captured)
    if (state.incomplete || !captured.config.completionColumnId) {
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
    const context = this.options.projectContextForCacheDeletion
      ? await this.options.projectContextForCacheDeletion(request.projectId)
      : await this.cacheContext(request.projectId)
    await this.options.cache.clearBound(context.localApprovalId, context.projectId, context.repository)
    for (const [key, state] of this.repositories) {
      if (key.endsWith(`\0${context.repository}`) ||
          key === `unbound:${context.localApprovalId}\0${context.repository}`) {
        state.snapshot = undefined
        state.partialIssues = undefined
        state.incomplete = false
      }
    }
  }

  private async state(context: GitHubIssueServiceContext): Promise<RepositoryState> {
    await this.options.cache.bind(
      context.localApprovalId, context.projectId, context.repository, context.userId
    )
    const key = repositoryKey(context)
    const unboundKey = `unbound:${context.localApprovalId}\0${context.repository}`
    const unbound = this.repositories.get(unboundKey)
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(context.userId, context.repository)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map()
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
        if (state.timer) this.unschedule(unbound.timer)
        else state.timer = unbound.timer
      }
      this.repositories.delete(unboundKey)
    }
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
  }> {
    const userId = await this.options.cache.boundUserId(
      context.localApprovalId, context.projectId, context.repository
    )
    if (!userId) {
      const key = `unbound:${context.localApprovalId}\0${context.repository}`
      let state = this.repositories.get(key)
      if (!state) {
        state = { incomplete: false, subscribers: new Map() }
        this.repositories.set(key, state)
      }
      this.projectKeys.set(context.projectId, key)
      return { key, state }
    }
    const key = `${userId}\0${context.repository}`
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(userId, context.repository)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Map()
      }
      this.repositories.set(key, state)
    }
    this.projectKeys.set(context.projectId, key)
    return { key, state }
  }

  private async refreshRepository(
    captured: GitHubIssueServiceContext,
    state: RepositoryState,
    forceFull: boolean
  ): Promise<void> {
    const refreshStartedAt = this.now()
    const full = forceFull || !state.snapshot ||
      this.now() - state.snapshot.lastFullReconciliationAt >= FULL_REFRESH_AGE
    const previous = state.snapshot
    const byNumber = new Map((full ? [] : previous?.issues ?? []).map((issue) => [issue.number, issue]))
    let page = 1
    const etags: Record<string, string> = {}
    while (true) {
      if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
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
        await this.incomplete(captured, state, 'issue-limit', [...byNumber.values()].slice(0, MAX_ISSUES))
        return
      }
      if (!result.nextPage) break
      page = result.nextPage
    }
    const issues = [...byNumber.values()]
    if (Buffer.byteLength(JSON.stringify(issues), 'utf-8') > MAX_CACHE_BYTES) {
      await this.incomplete(captured, state, 'byte-limit', issues)
      return
    }
    if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
    const snapshot: GitHubCompleteSnapshot = {
      issues,
      etags,
      lastSuccessfulRefreshAt: refreshStartedAt,
      lastFullReconciliationAt: full
        ? refreshStartedAt
        : previous?.lastFullReconciliationAt ?? refreshStartedAt
    }
    await this.options.cache.saveComplete(captured.userId, captured.repository, snapshot)
    const oldNumbers = new Map((previous?.issues ?? []).map((item) => [item.number, item.updatedAt]))
    const changed = issues.filter((item) => oldNumbers.get(item.number) !== item.updatedAt)
      .map((item) => item.number)
    state.snapshot = snapshot
    state.partialIssues = undefined
    state.incomplete = false
    this.emitDelta(state, changed)
  }

  private subscriberCount(state: RepositoryState): number {
    let count = 0
    for (const subscribers of state.subscribers.values()) count += subscribers.size
    return count
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

  private emitDelta(state: RepositoryState, changedIssueNumbers: number[]): void {
    if (changedIssueNumbers.length === 0) return
    for (const [projectId, subscribers] of state.subscribers) {
      for (const uiId of subscribers) this.options.onDelta?.(uiId, projectId, changedIssueNumbers)
    }
  }

  private async incomplete(
    context: GitHubIssueServiceContext,
    state: RepositoryState,
    reason: 'issue-limit' | 'byte-limit',
    issues: GitHubIssue[]
  ): Promise<void> {
    await this.options.cache.saveIncompleteAttempt(context.userId, context.repository, {
      reason,
      observedAt: this.now(),
      ...(!state.snapshot ? { partialIssues: issues } : {})
    })
    if (!state.snapshot) state.partialIssues = issues
    state.incomplete = true
  }
}

class ConfigurationChangedError extends Error {}
