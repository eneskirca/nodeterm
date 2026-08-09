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

export interface GitHubIssueServiceContext {
  localApprovalId: string
  projectId: string
  repository: string
  config: NormalisedProjectKanbanGitHub
  controlRevision: number
  credentialGeneration: number
  userId: string
  client: GitHubIssuesClientLike
  columnColors: Record<string, string>
}

type TimerId = ReturnType<typeof setInterval> | number
type ServiceOptions = {
  cache: GitHubIssueCache
  coordinator: GitHubRequestCoordinator
  contextForProject(projectId: string): Promise<GitHubIssueServiceContext>
  avatarFetcher?: GitHubAvatarFetcher
  now?: () => number
  setInterval?: (fn: () => void, milliseconds: number) => TimerId
  clearInterval?: (timer: TimerId) => void
  onDelta?: (projectId: string, changedIssueNumbers: number[]) => void
}

type RepositoryState = {
  snapshot?: GitHubCompleteSnapshot
  partialIssues?: GitHubIssue[]
  incomplete: boolean
  subscribers: Set<string>
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

function mapping(issue: GitHubIssue, config: NormalisedProjectKanbanGitHub): {
  columnId: string | null
  conflict: GitHubIssueCardView['conflict']
} {
  if (issue.state === 'closed') {
    return { columnId: config.completionColumnId ?? null, conflict: null }
  }
  const labelNames = new Set(issue.labels.map((label) => label.name.toLocaleLowerCase('en-US')))
  const matches = config.columnMappings.filter((item) =>
    labelNames.has(item.label.toLocaleLowerCase('en-US')))
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
    const context = await this.options.contextForProject(request.projectId)
    const key = repositoryKey(context)
    const state = await this.state(context)
    const subscriber = `${uiId}:${request.projectId}`
    state.subscribers.add(subscriber)
    this.projectKeys.set(request.projectId, key)
    if (!state.timer) {
      state.timer = this.schedule(() => {
        void this.refresh({ projectId: request.projectId }).catch(() => undefined)
      }, POLL_MS)
    }
    if (!state.snapshot && !state.partialIssues) {
      await this.refresh({ projectId: request.projectId })
    }
    return this.query({ projectId: request.projectId, columnId: null, pageSize: 50 })
  }

  unsubscribe(uiId: number, projectId: string): void {
    const key = this.projectKeys.get(projectId)
    const state = key ? this.repositories.get(key) : undefined
    if (!state) return
    state.subscribers.delete(`${uiId}:${projectId}`)
    if (state.subscribers.size === 0 && state.timer) {
      this.unschedule(state.timer)
      delete state.timer
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
    const context = await this.options.contextForProject(request.projectId)
    const state = await this.state(context)
    const source = state.snapshot?.issues ?? state.partialIssues ?? []
    const mapped = source.map((issue): GitHubIssueCardView => ({ ...issue, ...mapping(issue, context.config) }))
    const search = request.search?.trim().toLocaleLowerCase('en-US') ?? ''
    const filters = new Set((request.labelFilter ?? []).map((item) =>
      item.replace(/^github:/, '').toLocaleLowerCase('en-US')))
    const visible = mapped.filter((item) => item.columnId === request.columnId)
      .filter((item) => !search || item.title.toLocaleLowerCase('en-US').includes(search) ||
        String(item.number).includes(search))
      .filter((item) => filters.size === 0 || item.labels.some((label) =>
        filters.has(label.name.toLocaleLowerCase('en-US'))))
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
    for (const item of mapped) counts[item.columnId ?? 'ungrouped'] = (counts[item.columnId ?? 'ungrouped'] ?? 0) + 1
    return {
      items: page,
      counts,
      ...(offset + page.length < visible.length ? { nextCursor: String(offset + page.length) } : {}),
      partial: !state.snapshot && !!state.partialIssues,
      readOnly: state.incomplete,
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
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'configuration-changed' }
      }
      const latest = await this.options.coordinator.runRead(captured.userId, () =>
        captured.client.getIssue(captured.repository, request.issueNumber))
      if (latest.updatedAt !== request.expectedUpdatedAt) return { status: 'stale', issue: latest }
      const destination = request.toColumnId === null
        ? null
        : captured.config.columnMappings.find((item) => item.columnId === request.toColumnId)
      if (request.toColumnId !== null && !destination) return { status: 'invalid-target' }
      const mappedNames = new Set(captured.config.columnMappings.map((item) =>
        item.label.toLocaleLowerCase('en-US')))
      const labels = latest.labels.map((label) => label.name)
        .filter((name) => !mappedNames.has(name.toLocaleLowerCase('en-US')))
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
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return { status: 'confirmed', issue: updated }
      }
      const state = await this.state(captured)
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
      this.options.onDelta?.(request.projectId, [updated.number])
      return { status: 'confirmed', issue: updated }
    })
  }

  async createMissingLabels(request: { projectId: string }): Promise<CreateMappedLabelsResult> {
    const captured = await this.options.contextForProject(request.projectId)
    const capturedEpoch = epoch(captured)
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
      const result = await this.options.coordinator.runRead(captured.userId, () =>
        captured.client.listRepositoryLabels(captured.repository, { page, perPage: 100 }))
      for (const label of result.items) known.add(label.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      if (!result.nextPage) break
      page = result.nextPage
    }
    const pending = captured.config.columnMappings.filter((item) =>
      !known.has(item.label.normalize('NFKC').toLocaleLowerCase('en-US')))
    const created: string[] = []
    for (const item of pending) {
      if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      const color = captured.columnColors[item.columnId]?.replace(/^#/, '')
      const result = await this.options.coordinator.runMutation(captured.userId, async () => {
        if (capturedEpoch !== epoch(await this.options.contextForProject(request.projectId))) {
          throw new ConfigurationChangedError()
        }
        return captured.client.createLabel(captured.repository, {
          name: item.label,
          color: color && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '8b5cf6'
        })
      }).catch((error: unknown) => {
        if (error instanceof ConfigurationChangedError) return null
        throw error
      })
      if (!result) {
        return {
          status: 'configuration-changed',
          created,
          remaining: pending.filter((candidate) => !created.includes(candidate.label))
            .map((candidate) => candidate.label)
        }
      }
      known.add(result.name.normalize('NFKC').toLocaleLowerCase('en-US'))
      created.push(item.label)
    }
    return { status: 'confirmed', created, remaining: [] }
  }

  async clearCache(request: { projectId: string }): Promise<void> {
    const context = await this.options.contextForProject(request.projectId)
    await this.options.cache.clear(context.userId, context.repository)
    const state = this.repositories.get(repositoryKey(context))
    if (state) {
      state.snapshot = undefined
      state.partialIssues = undefined
      state.incomplete = false
    }
  }

  private async state(context: GitHubIssueServiceContext): Promise<RepositoryState> {
    const key = repositoryKey(context)
    let state = this.repositories.get(key)
    if (!state) {
      const cached = await this.options.cache.load(context.userId, context.repository)
      state = {
        snapshot: cached.lastComplete,
        partialIssues: cached.lastAttempt?.partialIssues,
        incomplete: !!cached.lastAttempt,
        subscribers: new Set()
      }
      this.repositories.set(key, state)
    }
    this.projectKeys.set(context.projectId, key)
    return state
  }

  private async refreshRepository(
    captured: GitHubIssueServiceContext,
    state: RepositoryState,
    forceFull: boolean
  ): Promise<void> {
    const full = forceFull || !state.snapshot ||
      this.now() - state.snapshot.lastFullReconciliationAt >= FULL_REFRESH_AGE
    const previous = state.snapshot
    const byNumber = new Map((full ? [] : previous?.issues ?? []).map((issue) => [issue.number, issue]))
    let page = 1
    const etags: Record<string, string> = { ...(previous?.etags ?? {}) }
    while (true) {
      if (epoch(captured) !== epoch(await this.options.contextForProject(captured.projectId))) return
      const since = !full && previous?.lastSuccessfulRefreshAt
        ? new Date(Math.max(0, previous.lastSuccessfulRefreshAt - 2_000)).toISOString()
        : undefined
      const etagKey = JSON.stringify([captured.userId, captured.repository, full ? 'all' : since, page])
      const result = await this.options.coordinator.runRead(captured.userId, () =>
        captured.client.listIssues(captured.repository, {
          state: 'all', page, perPage: 100, ...(since ? { since } : {}),
          ...(etags[etagKey] ? { etag: etags[etagKey] } : {})
        }))
      if (!result.notModified) {
        for (const item of result.items) {
          const old = byNumber.get(item.number)
          if (!old || item.updatedAt >= old.updatedAt) byNumber.set(item.number, item)
        }
      }
      if (result.etag) etags[etagKey] = result.etag
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
    const now = this.now()
    const snapshot: GitHubCompleteSnapshot = {
      issues,
      etags,
      lastSuccessfulRefreshAt: now,
      lastFullReconciliationAt: full ? now : previous?.lastFullReconciliationAt ?? now
    }
    await this.options.cache.saveComplete(captured.userId, captured.repository, snapshot)
    const oldNumbers = new Map((previous?.issues ?? []).map((item) => [item.number, item.updatedAt]))
    const changed = issues.filter((item) => oldNumbers.get(item.number) !== item.updatedAt)
      .map((item) => item.number)
    state.snapshot = snapshot
    state.partialIssues = undefined
    state.incomplete = false
    this.options.onDelta?.(captured.projectId, changed)
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
