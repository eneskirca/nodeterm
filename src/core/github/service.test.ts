import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubIssueCache } from './cache'
import {
  evictPullsToFit,
  FULL_REFRESH_MIN_INTERVAL_MS,
  GitHubIssueService,
  REFRESH_MIN_INTERVAL_MS,
  type GitHubIssueServiceContext,
  type GitHubIssuesClientLike
} from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type {
  GitHubIssue,
  IssuePageResult,
  ListIssueOptions,
  NormalisedProjectKanbanGitHub
} from '../../shared/github-issues'

let userDataDir: string

const config: NormalisedProjectKanbanGitHub = {
  repository: 'o/r',
  columnMappings: [
    { columnId: 'todo', label: 'status:todo' },
    { columnId: 'doing', label: 'status:doing' },
    { columnId: 'done', label: 'status:done' }
  ],
  completionColumnId: 'done',
  revision: 'mapping-1'
}

const issue = (number: number, over: Partial<GitHubIssue> = {}): GitHubIssue => ({
  id: 1_000 + number,
  number,
  title: `Issue ${number}`,
  body: '',
  state: 'open',
  stateReason: null,
  htmlUrl: `https://github.com/o/r/issues/${number}`,
  apiUrl: `https://api.github.com/repos/o/r/issues/${number}`,
  labels: [],
  assignees: [],
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: `2026-08-09T10:00:${String(number).padStart(2, '0')}Z`,
  locked: false,
  ...over
})

class FixtureClient implements GitHubIssuesClientLike {
  issues = new Map<number, GitHubIssue>()
  updates: Array<{ number: number; input: { state?: 'open' | 'closed'; labels?: string[] } }> = []
  repositoryLabels: Array<{ id: number; name: string; color: string; description: null }> = []
  createdLabels: Array<{ name: string; color: string }> = []

  constructor(issues: GitHubIssue[]) {
    for (const item of issues) this.issues.set(item.number, item)
  }

  async listIssues(_repository: string, _options: ListIssueOptions): Promise<IssuePageResult> {
    return { items: [...this.issues.values()] }
  }

  async getIssue(_repository: string, number: number) {
    return structuredClone(this.issues.get(number)!)
  }

  async updateIssue(
    _repository: string,
    number: number,
    input: { state?: 'open' | 'closed'; labels?: string[] }
  ) {
    this.updates.push({ number, input: structuredClone(input) })
    const current = this.issues.get(number)!
    const updated = {
      ...current,
      ...(input.state ? { state: input.state } : {}),
      ...(input.labels ? {
        labels: input.labels.map((name, index) => ({ id: index + 1, name, color: '8b5cf6' }))
      } : {}),
      updatedAt: '2026-08-09T11:00:00Z'
    }
    this.issues.set(number, updated)
    return structuredClone(updated)
  }

  async listRepositoryLabels() { return { items: structuredClone(this.repositoryLabels) } }
  async createLabel(_repository: string, input: { name: string; color: string }) {
    this.createdLabels.push(structuredClone(input))
    const label = { id: 99 + this.createdLabels.length, name: input.name, color: input.color, description: null }
    this.repositoryLabels.push(label)
    return label
  }
}

function context(client: FixtureClient, over: Partial<GitHubIssueServiceContext> = {}): GitHubIssueServiceContext {
  return {
    localApprovalId: 'local-1',
    projectId: 'project-1',
    repository: 'o/r',
    config,
    controlRevision: 1,
    credentialGeneration: 1,
    userId: 'user-1',
    client,
    columnColors: { todo: '#0a84ff', doing: '#ffd60a', done: '#30d158' },
    ...over
  }
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-github-service-'))
})

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true })
})

describe('evictPullsToFit', () => {
  const pull = (number: number): GitHubIssue =>
    issue(number, { pull: { draft: false, mergedAt: null } })

  it('leaves a harvest that already fits untouched', () => {
    const items = [issue(1), pull(2)]
    expect(evictPullsToFit(items, () => true)).toEqual({ items, pullsTruncated: false })
  })

  it('drops the oldest pull requests and keeps every issue', () => {
    const items = [issue(1), issue(2), pull(3), pull(4), pull(5)]
    const trimmed = evictPullsToFit(items, (candidate) => candidate.length <= 3)
    expect(trimmed?.pullsTruncated).toBe(true)
    expect(trimmed?.items.map((item) => item.number).sort()).toEqual([1, 2, 5])
  })

  it('refuses when the issues alone miss the bound, leaving the incomplete path to answer', () => {
    expect(evictPullsToFit([issue(1), issue(2), pull(3)], (candidate) => candidate.length <= 1))
      .toBeNull()
  })
})

describe('GitHubIssueService', () => {
  it('renders a cached snapshot immediately and refreshes it in the background', async () => {
    const client = new FixtureClient([issue(2)])
    let release!: () => void
    let started!: () => void
    const refreshStarted = new Promise<void>((resolve) => { started = resolve })
    client.listIssues = async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
      return { items: [issue(2)] }
    }
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [issue(1)], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    let refreshed!: () => void
    const refreshFinished = new Promise<void>((resolve) => { refreshed = resolve })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      onDelta: () => refreshed()
    })

    const initial = await service.subscribe(1, { projectId: 'project-1' })
    expect(initial.items.map((item) => item.number)).toEqual([1])
    await refreshStarted
    release()
    await refreshFinished
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items
      .map((item) => item.number)).toEqual([2])
  })

  it('does not repopulate private data when cache is cleared during a refresh', async () => {
    const client = new FixtureClient([issue(2)])
    let release!: () => void
    let started!: () => void
    const refreshStarted = new Promise<void>((resolve) => { started = resolve })
    client.listIssues = async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
      return { items: [issue(2)] }
    }
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [issue(1)], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      projectContextForCacheDeletion: async () => context(client)
    })

    const refreshing = service.refresh({ projectId: 'project-1', full: true })
    await refreshStarted
    const clearing = service.clearCache({ projectId: 'project-1' })
    release()
    await Promise.all([refreshing, clearing])

    expect(await cache.boundUserId('local-1', 'project-1', 'o/r')).toBeNull()
    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items)
      .toEqual([])
  })

  it('blocks a mutation whose repository state would be created after cache deletion begins', async () => {
    const shown = issue(42)
    const client = new FixtureClient([shown])
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [shown], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    let releaseContext!: () => void
    let contextStarted!: () => void
    const started = new Promise<void>((resolve) => { contextStarted = resolve })
    let contextCalls = 0
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => {
        contextCalls += 1
        if (contextCalls === 1) {
          contextStarted()
          await new Promise<void>((resolve) => { releaseContext = resolve })
        }
        return context(client)
      },
      projectContextForCacheDeletion: async () => context(client)
    })

    const moving = service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: shown.updatedAt
    })
    await started
    const clearing = service.clearCache({ projectId: 'project-1' })
    releaseContext()
    const [moveResult] = await Promise.all([moving, clearing])

    expect(moveResult.status).toBe('read-only')
    expect(client.updates).toEqual([])
    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items)
      .toEqual([])
  })

  it('purges subscribed in-memory issue bodies and emits an empty cache-change delta', async () => {
    const client = new FixtureClient([issue(1, { body: 'private issue body' })])
    const deltas: number[][] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      projectContextForCacheDeletion: async () => context(client),
      onDelta: (_uiId, _projectId, numbers) => deltas.push(numbers)
    })
    await service.subscribe(1, { projectId: 'project-1' })
    deltas.length = 0

    await service.clearCache({ projectId: 'project-1' })

    expect(deltas).toEqual([[]])
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items)
      .toEqual([])
  })

  it('waits for a cache writer from another project sharing the repository', async () => {
    class PausingCache extends GitHubIssueCache {
      pause = false
      private releaseWrite!: () => void
      private writeStarted!: () => void
      readonly started = new Promise<void>((resolve) => { this.writeStarted = resolve })

      release(): void { this.releaseWrite() }

      override async saveComplete(
        userId: string,
        repository: string,
        snapshot: Parameters<GitHubIssueCache['saveComplete']>[2]
      ): Promise<void> {
        if (this.pause) {
          this.writeStarted()
          await new Promise<void>((resolve) => { this.releaseWrite = resolve })
        }
        await super.saveComplete(userId, repository, snapshot)
      }
    }
    const shown = issue(42)
    const client = new FixtureClient([shown])
    const cache = new PausingCache(userDataDir)
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async (projectId) => context(client, { projectId }),
      projectContextForCacheDeletion: async (projectId) => context(client, { projectId })
    })
    await service.refresh({ projectId: 'project-1', full: true })
    await service.refresh({ projectId: 'project-2', full: true })
    cache.pause = true

    const moving = service.moveIssue({
      projectId: 'project-2', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: shown.updatedAt
    })
    await cache.started
    let clearFinished = false
    const clearing = service.clearCache({ projectId: 'project-1' })
      .then(() => { clearFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clearFinished).toBe(false)

    cache.release()
    await Promise.all([moving, clearing])

    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
  })

  it('rebuilds every page unconditionally during a full reconciliation', async () => {
    const client = new FixtureClient([])
    const calls: Array<{ page: number; etag?: string }> = []
    client.listIssues = async (_repository: string, options: { page: number; etag?: string }) => {
      calls.push({ page: options.page, ...(options.etag ? { etag: options.etag } : {}) })
      return options.page === 1
        ? { items: [issue(1)], nextPage: 2, etag: 'page-one' }
        : { items: [issue(2)], etag: 'page-two' }
    }
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', {
      issues: [issue(99)], etags: { old: 'etag' },
      lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      now: () => 10_000
    })

    await service.refresh({ projectId: 'project-1', full: true })

    expect(calls).toEqual([{ page: 1 }, { page: 2 }])
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items
      .map((item) => item.number)).toEqual([2, 1])
  })

  it('advances the incremental watermark to refresh start, not completion', async () => {
    const client = new FixtureClient([issue(1)])
    const times = [1_000, 9_000, 12_000]
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveComplete('user-1', 'o/r', {
      issues: [], etags: {}, lastSuccessfulRefreshAt: 500, lastFullReconciliationAt: 999
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      now: () => times.shift() ?? 12_000
    })
    await service.refresh({ projectId: 'project-1' })
    const saved = await cache.load('user-1', 'o/r')
    expect(saved.lastComplete?.lastSuccessfulRefreshAt).toBe(1_000)
  })

  it('refreshes and maps open, closed, unmatched, and conflicting issues', async () => {
    const client = new FixtureClient([
      issue(1, { labels: [{ id: 1, name: 'status:todo', color: '0a84ff' }] }),
      issue(2),
      issue(3, { labels: [
        { id: 1, name: 'status:todo', color: '0a84ff' },
        { id: 2, name: 'status:doing', color: 'ffd60a' }
      ] }),
      issue(4, { state: 'closed', labels: [] })
    ])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      now: () => 10_000
    })
    await service.refresh({ projectId: 'project-1', full: true })

    expect((await service.query({ projectId: 'project-1', columnId: 'todo', pageSize: 50 })).items
      .map((item) => item.number)).toEqual([1])
    const ungrouped = await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })
    expect(ungrouped.items.map((item) => [item.number, item.conflict])).toEqual([
      [3, 'multiple-mapped-labels'],
      [2, null]
    ])
    expect((await service.query({ projectId: 'project-1', columnId: 'done', pageSize: 50 })).items
      .map((item) => item.number)).toEqual([4])
  })

  it('reads and clears an approved private cache while signed out', async () => {
    const client = new FixtureClient([issue(1)])
    const cache = new GitHubIssueCache(userDataDir)
    const online = new GitHubIssueService({
      cache, coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await online.refresh({ projectId: 'project-1', full: true })

    const offline = new GitHubIssueService({
      cache, coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => { throw new Error('not-authenticated') },
      projectContextForCache: async () => {
        const { credentialGeneration: _generation, userId: _userId, client: _client, ...base } = context(client)
        return base
      }
    })
    expect((await offline.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items
      .map((item) => item.number)).toEqual([1])
    await offline.clearCache({ projectId: 'project-1' })
    expect(await cache.boundUserId('local-1', 'project-1', 'o/r')).toBeNull()
    expect(await cache.load('user-1', 'o/r')).toEqual({ version: 1 })
  })

  it('uses one poll timer for every visible subscriber to the same repository', async () => {
    const client = new FixtureClient([])
    const timers: Array<() => Promise<void>> = []
    const cleared: unknown[] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      setInterval: (fn) => { timers.push(fn as () => Promise<void>); return timers.length },
      clearInterval: (id) => { cleared.push(id) }
    })
    await service.subscribe(1, { projectId: 'project-1' })
    await service.subscribe(2, { projectId: 'project-1' })
    expect(timers).toHaveLength(1)
    service.unsubscribe(1, 'project-1')
    expect(cleared).toEqual([])
    service.unsubscribe(2, 'project-1')
    expect(cleared).toEqual([1])
  })

  it('polls through an invalid shared project to a valid project for the repository', async () => {
    const client = new FixtureClient([issue(1)])
    const timers: Array<() => Promise<void>> = []
    let firstProjectValid = true
    const deltas: Array<[string, number[]]> = []
    const polledProjects: string[] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async (projectId) => {
        if (!firstProjectValid) polledProjects.push(projectId)
        if (projectId === 'project-1' && !firstProjectValid) throw new Error('approval-revoked')
        return context(client, { projectId })
      },
      setInterval: (fn) => { timers.push(fn as () => Promise<void>); return timers.length },
      onDelta: (_uiId, projectId, numbers) => { deltas.push([projectId, numbers]) }
    })
    await service.subscribe(1, { projectId: 'project-1' })
    await service.subscribe(2, { projectId: 'project-2' })
    firstProjectValid = false
    client.issues.set(2, issue(2))

    await timers[0]()

    expect(polledProjects[0]).toBe('project-1')
    expect(polledProjects).toContain('project-2')
    expect(deltas).toContainEqual(['project-2', [2]])
    expect((await service.query({ projectId: 'project-2', columnId: null, pageSize: 50 })).items
      .map((item) => item.number)).toEqual([2, 1])
  })

  it('migrates subscribers and timer ownership when the authenticated identity changes', async () => {
    const firstClient = new FixtureClient([issue(1)])
    const secondClient = new FixtureClient([issue(2)])
    const timers: Array<() => Promise<void>> = []
    const cleared: unknown[] = []
    let identity = 'user-1'
    let refreshed!: () => void
    const refreshSeen = new Promise<void>((resolve) => { refreshed = resolve })
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(
        identity === 'user-1' ? firstClient : secondClient,
        { userId: identity, credentialGeneration: identity === 'user-1' ? 1 : 2 }
      ),
      setInterval: (fn) => { timers.push(fn as () => Promise<void>); return timers.length },
      clearInterval: (timer) => { cleared.push(timer) },
      onDelta: (_uiId, _projectId, numbers) => {
        if (numbers.includes(2)) refreshed()
      }
    })
    await service.subscribe(7, { projectId: 'project-1' })
    identity = 'user-2'

    await timers[0]()
    await refreshSeen

    expect(cleared).toEqual([1])
    expect(timers).toHaveLength(2)
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).items
      .map((item) => item.number)).toEqual([2])
    service.unsubscribe(7, 'project-1')
    expect(cleared).toEqual([1, 2])
  })

  it('drops all subscriptions for a disconnected client and sends deltas only to subscribers', async () => {
    const client = new FixtureClient([issue(1)])
    const deltas: Array<[number, string, number[]]> = []
    const timers: Array<() => void> = []
    const cleared: unknown[] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async (projectId) => context(client, { projectId }),
      setInterval: (fn) => { timers.push(fn); return timers.length },
      clearInterval: (id) => { cleared.push(id) },
      onDelta: (uiId, projectId, numbers) => deltas.push([uiId, projectId, numbers])
    })
    await service.subscribe(7, { projectId: 'project-1' })
    await service.subscribe(8, { projectId: 'project-2' })
    client.issues.set(2, issue(2))
    await service.refresh({ projectId: 'project-1', full: true })
    expect(deltas.slice(-2)).toEqual([
      [7, 'project-1', [2]],
      [8, 'project-2', [2]]
    ])

    service.dropClient(7)
    service.dropClient(8)
    expect(cleared).toEqual([1])
  })

  it('notifies subscribers when a full refresh only removes issues', async () => {
    const client = new FixtureClient([issue(1), issue(2)])
    const deltas: number[][] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      onDelta: (_uiId, _projectId, numbers) => deltas.push(numbers)
    })
    await service.subscribe(1, { projectId: 'project-1' })
    deltas.length = 0
    client.issues.delete(2)

    await service.refresh({ projectId: 'project-1', full: true })

    expect(deltas).toEqual([[2]])
  })

  it('notifies subscribers when a refresh changes completeness without issue changes', async () => {
    const client = new FixtureClient([])
    client.listIssues = async () => ({
      items: Array.from({ length: 10_001 }, (_, index) => issue(index + 1))
    })
    const deltas: number[][] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      onDelta: (_uiId, _projectId, numbers) => deltas.push(numbers)
    })
    await service.subscribe(1, { projectId: 'project-1' })

    expect(deltas).toEqual([[]])
    expect((await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })).readOnly)
      .toBe(true)
  })

  it('calculates counts from the active search and GitHub label filter', async () => {
    const client = new FixtureClient([
      issue(1, { title: 'Alpha bug', labels: [{ id: 1, name: 'bug', color: 'd73a4a' }] }),
      issue(2, { title: 'Beta task', labels: [{ id: 2, name: 'feature', color: '0a84ff' }] })
    ])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir), coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await service.refresh({ projectId: 'project-1', full: true })
    const page = await service.query({
      projectId: 'project-1', columnId: null, pageSize: 50,
      search: 'alpha', labelFilter: ['github:bug']
    })
    expect(page.items.map((item) => item.number)).toEqual([1])
    expect(page.counts).toEqual({ ungrouped: 1 })
  })

  it('closes in completion, reopens outside it, and preserves unrelated labels', async () => {
    const shown = issue(42, {
      state: 'closed',
      labels: [
        { id: 1, name: 'status:done', color: '30d158' },
        { id: 2, name: 'bug', color: 'd73a4a' }
      ]
    })
    const client = new FixtureClient([shown])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator({ sleep: async () => undefined }),
      contextForProject: async () => context(client)
    })
    await service.refresh({ projectId: 'project-1', full: true })
    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'todo', expectedUpdatedAt: shown.updatedAt
    })
    expect(result.status).toBe('confirmed')
    expect(client.updates).toEqual([{ number: 42, input: {
      state: 'open', labels: ['bug', 'status:todo']
    } }])
  })

  it('returns stale data without writing when the displayed version changed', async () => {
    const client = new FixtureClient([issue(42, { updatedAt: '2026-08-09T11:00:00Z' })])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await service.refresh({ projectId: 'project-1', full: true })
    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(result).toMatchObject({ status: 'stale', issue: { updatedAt: '2026-08-09T11:00:00Z' } })
    expect(client.updates).toEqual([])
  })

  it('rejects mutation when the repository is incomplete or the issue is outside the complete snapshot', async () => {
    const client = new FixtureClient([issue(42)])
    const cache = new GitHubIssueCache(userDataDir)
    await cache.saveIncompleteAttempt('user-1', 'o/r', {
      reason: 'issue-limit', observedAt: 1, partialIssues: [issue(42)]
    })
    const service = new GitHubIssueService({
      cache, coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    expect(await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: issue(42).updatedAt
    })).toEqual({ status: 'read-only' })
    expect(client.updates).toEqual([])
  })

  it('verifies GitHub confirmed the requested state and labels', async () => {
    const client = new FixtureClient([issue(42)])
    client.updateIssue = async (_repository, number) => structuredClone(client.issues.get(number)!)
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir), coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await service.refresh({ projectId: 'project-1', full: true })
    await expect(service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: issue(42).updatedAt
    })).rejects.toThrow('mutation-not-confirmed')
  })

  it('cancels before the write when the approval epoch changes in the queue', async () => {
    const client = new FixtureClient([issue(42)])
    let moving = false
    let moveReads = 0
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => {
        if (moving) moveReads += 1
        return context(client, { controlRevision: moving && moveReads >= 3 ? 2 : 1 })
      }
    })
    await service.refresh({ projectId: 'project-1', full: true })
    moving = true
    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: issue(42).updatedAt
    })
    expect(result.status).toBe('configuration-changed')
    expect(client.updates).toEqual([])
  })

  it('creates only missing mapped labels with column colours', async () => {
    const client = new FixtureClient([])
    client.repositoryLabels = [{ id: 1, name: 'STATUS:TODO', color: 'ffffff', description: null }]
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator({ sleep: async () => undefined }),
      contextForProject: async () => context(client)
    })
    const result = await service.createMissingLabels({ projectId: 'project-1' })
    expect(result).toEqual({
      status: 'confirmed',
      created: ['status:doing', 'status:done'],
      remaining: []
    })
    expect(client.createdLabels).toEqual([
      { name: 'status:doing', color: 'ffd60a' },
      { name: 'status:done', color: '30d158' }
    ])
  })

  it('treats an exact concurrently created label as success and reports exact ownership', async () => {
    const client = new FixtureClient([])
    const original = client.createLabel.bind(client)
    let raced = false
    client.createLabel = async (repository, input) => {
      if (!raced) {
        raced = true
        client.repositoryLabels.push({ id: 500, name: input.name.toUpperCase(),
          color: input.color, description: null })
        throw Object.assign(new Error('already exists'), { status: 422 })
      }
      return original(repository, input)
    }
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator({ sleep: async () => undefined }),
      contextForProject: async () => context(client)
    })
    expect(await service.createMissingLabels({ projectId: 'project-1' })).toEqual({
      status: 'confirmed',
      created: ['status:doing', 'status:done'],
      remaining: []
    })
  })

  it('returns refresh-pending after one confirmed write when cache persistence fails', async () => {
    class FailingCache extends GitHubIssueCache {
      override async saveComplete(): Promise<void> { throw new Error('disk full') }
    }
    const shown = issue(42)
    const client = new FixtureClient([shown])
    const cache = new FailingCache(userDataDir)
    await GitHubIssueCache.prototype.saveComplete.call(cache, 'user-1', 'o/r', {
      issues: [shown], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: shown.updatedAt
    })
    expect(result.status).toBe('refresh-pending')
    expect(client.updates).toHaveLength(1)
  })

  it('omits state from a move that does not change it, so GitHub keeps state_reason', async () => {
    // A closed-as-not_planned issue maps into the completion column, so a drag that lands it back
    // where it already is would PATCH state:'closed' again. GitHub rewrites state_reason to
    // 'completed' for that write, silently destroying the "wontfix" record nobody asked to change.
    const shelved = issue(5, {
      state: 'closed',
      stateReason: 'not_planned',
      labels: [{ id: 1, name: 'status:doing', color: 'ffd60a' }]
    })
    const client = new FixtureClient([shelved])
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [shelved], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })

    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 5, toColumnId: 'done',
      expectedUpdatedAt: shelved.updatedAt
    })

    expect(result.status).toBe('confirmed')
    expect(client.updates).toHaveLength(1)
    expect(client.updates[0].input.state).toBeUndefined()
    expect(client.updates[0].input.labels).toEqual(['status:done'])
  })

  it('still sends state when the move really does change it', async () => {
    const open = issue(6, { labels: [{ id: 1, name: 'status:doing', color: 'ffd60a' }] })
    const client = new FixtureClient([open])
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [open], etags: {}, lastSuccessfulRefreshAt: 1, lastFullReconciliationAt: 1
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })

    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 6, toColumnId: 'done',
      expectedUpdatedAt: open.updatedAt
    })

    expect(result.status).toBe('confirmed')
    expect(client.updates[0].input.state).toBe('closed')
  })

  it('skips a repeat refresh inside the minimum interval', async () => {
    const client = new FixtureClient([issue(1)])
    let listed = 0
    client.listIssues = async () => {
      listed += 1
      return { items: [issue(1)] }
    }
    let clock = 1_000_000
    let resolutions = 0
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => {
        resolutions += 1
        return context(client)
      },
      now: () => clock
    })

    await service.refresh({ projectId: 'project-1' })
    expect(listed).toBe(1)
    const afterFirst = resolutions

    clock += 1_000
    await service.refresh({ projectId: 'project-1' })
    expect(listed).toBe(1)
    // The throttle must run BEFORE the credential resolution, or the expensive half still happens.
    expect(resolutions).toBe(afterFirst)

    clock += REFRESH_MIN_INTERVAL_MS
    await service.refresh({ projectId: 'project-1' })
    expect(listed).toBe(2)
  })

  it('lets a full refresh through its own longer interval, not the incremental one', async () => {
    const client = new FixtureClient([issue(1)])
    const fullPages: Array<string | undefined> = []
    client.listIssues = async (_repository, options: ListIssueOptions) => {
      fullPages.push(options.since)
      return { items: [issue(1)] }
    }
    let clock = 1_000_000
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      now: () => clock
    })

    await service.refresh({ projectId: 'project-1', full: true })
    expect(fullPages).toHaveLength(1)

    clock += REFRESH_MIN_INTERVAL_MS
    await service.refresh({ projectId: 'project-1', full: true })
    expect(fullPages).toHaveLength(1)

    clock += FULL_REFRESH_MIN_INTERVAL_MS
    await service.refresh({ projectId: 'project-1', full: true })
    expect(fullPages).toHaveLength(2)
  })

  it('pages issues and pull requests as separate kinds, counting each on its own', async () => {
    const pull = issue(7, {
      pull: { draft: true, mergedAt: null },
      labels: [{ id: 1, name: 'status:doing', color: 'ffd60a' }]
    })
    const client = new FixtureClient([issue(1), pull])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await service.subscribe(1, { projectId: 'project-1' })

    // No kind means issues: the page a caller that predates pull requests still asks for.
    const issues = await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })
    expect(issues.items.map((item) => item.number)).toEqual([1])
    expect(issues.counts).toEqual({ ungrouped: 1 })

    const pulls = await service.query({
      projectId: 'project-1', columnId: 'doing', pageSize: 50, kind: 'pull'
    })
    expect(pulls.items.map((item) => item.number)).toEqual([7])
    expect(pulls.items[0].pull).toEqual({ draft: true, mergedAt: null })
    expect(pulls.counts).toEqual({ doing: 1 })
    // The board never writes a pull request, and the page says so rather than trusting callers.
    expect(pulls.readOnly).toBe(true)
  })

  it('reports the pull lane as partial when pull requests were evicted to fit', async () => {
    const client = new FixtureClient([])
    const cache = new GitHubIssueCache(userDataDir)
    await cache.bind('local-1', 'project-1', 'o/r', 'user-1')
    await cache.saveComplete('user-1', 'o/r', {
      issues: [issue(1), issue(2, { pull: { draft: false, mergedAt: null } })],
      etags: {},
      lastSuccessfulRefreshAt: 1,
      lastFullReconciliationAt: 1,
      pullsTruncated: true
    })
    const service = new GitHubIssueService({
      cache,
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })

    const pulls = await service.query({
      projectId: 'project-1', columnId: null, pageSize: 50, kind: 'pull'
    })
    const issues = await service.query({ projectId: 'project-1', columnId: null, pageSize: 50 })
    expect(pulls.partial).toBe(true)
    expect(issues.partial).toBe(false)
  })

  it('refuses to move a pull request, which shares the issue number space', async () => {
    const client = new FixtureClient([issue(5, { pull: { draft: false, mergedAt: null } })])
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client)
    })
    await service.subscribe(1, { projectId: 'project-1' })

    expect(await service.moveIssue({
      projectId: 'project-1',
      issueNumber: 5,
      toColumnId: 'done',
      expectedUpdatedAt: '2026-08-09T10:05Z'
    })).toEqual({ status: 'invalid-target' })
    expect(client.updates).toEqual([])
  })
})
