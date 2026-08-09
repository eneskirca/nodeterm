import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitHubIssueCache } from './cache'
import {
  GitHubIssueService,
  type GitHubIssueServiceContext,
  type GitHubIssuesClientLike
} from './service'
import { GitHubRequestCoordinator } from './request-coordinator'
import type { GitHubIssue, NormalisedProjectKanbanGitHub } from '../../shared/github-issues'

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

  async listIssues() {
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

describe('GitHubIssueService', () => {
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

  it('uses one poll timer for every visible subscriber to the same repository', async () => {
    const client = new FixtureClient([])
    const timers: Array<() => void> = []
    const cleared: unknown[] = []
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => context(client),
      setInterval: (fn) => { timers.push(fn); return timers.length },
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
    const result = await service.moveIssue({
      projectId: 'project-1', issueNumber: 42, toColumnId: 'doing',
      expectedUpdatedAt: '2026-08-09T10:00:00Z'
    })
    expect(result).toMatchObject({ status: 'stale', issue: { updatedAt: '2026-08-09T11:00:00Z' } })
    expect(client.updates).toEqual([])
  })

  it('cancels before the write when the approval epoch changes in the queue', async () => {
    const client = new FixtureClient([issue(42)])
    let reads = 0
    const service = new GitHubIssueService({
      cache: new GitHubIssueCache(userDataDir),
      coordinator: new GitHubRequestCoordinator(),
      contextForProject: async () => {
        reads += 1
        return context(client, { controlRevision: reads >= 4 ? 2 : 1 })
      }
    })
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

  it('returns refresh-pending after one confirmed write when cache persistence fails', async () => {
    class FailingCache extends GitHubIssueCache {
      override async saveComplete(): Promise<void> { throw new Error('disk full') }
    }
    const shown = issue(42)
    const client = new FixtureClient([shown])
    const service = new GitHubIssueService({
      cache: new FailingCache(userDataDir),
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
})
