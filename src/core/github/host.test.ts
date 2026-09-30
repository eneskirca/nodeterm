import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types'
import type { GitHubControlState } from '../../shared/github-issues'
import { GitHubHostController, GitHubHostError } from './host'
import type { TokenValidation } from './credentials'

const project: Project = {
  id: 'project-1',
  name: 'Test',
  color: '#8b5cf6',
  cwd: '/repo',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  kanban: {
    columns: [
      { id: 'todo', title: 'Todo', color: '#2563eb' },
      { id: 'done', title: 'Done', color: '#16a34a' }
    ],
    assignments: [],
    github: {
      columnMappings: [
        { columnId: 'todo', label: 'status:todo' },
        { columnId: 'done', label: 'status:done' }
      ],
      completionColumnId: 'done'
    }
  }
}

function fixture(options: {
  onRevoked?: (projectId: string) => Promise<void>
  onApprovalChanged?: (projectId: string) => void
} = {}) {
  let current: Project = project
  let state: GitHubControlState = {
    version: 1,
    revision: 0,
    authProvider: 'auto',
    approvals: []
  }
  let token = 'secret'
  const secret = {
    availability: 'encrypted' as const,
    readForHost: vi.fn(async () => token || null),
    save: vi.fn(async (value: string) => { token = value }),
    clear: vi.fn(async () => { token = '' })
  }
  const controls = {
    load: vi.fn(async () => structuredClone(state)),
    isApproved: vi.fn((current: GitHubControlState, input: {
      localApprovalId: string
      projectId: string
      repository: string
    }) => current.approvals.some((item) => item.localApprovalId === input.localApprovalId &&
      item.projectId === input.projectId && item.repository === input.repository)),
    isMappingApproved: vi.fn((current: GitHubControlState, input: {
      localApprovalId: string
      projectId: string
      repository: string
      mappingDigest: string
    }) => current.approvals.some((item) => item.localApprovalId === input.localApprovalId &&
      item.projectId === input.projectId && item.repository === input.repository &&
      item.mappingDigest === input.mappingDigest)),
    approve: vi.fn(async (input: {
      expectedRevision: number
      localApprovalId: string
      projectId: string
      repository: string
      mappingDigest?: string
    }) => {
      state = {
        ...state,
        revision: state.revision + 1,
        approvals: [{ ...input, enabled: true as const, approvedAt: 1 }]
      }
      return structuredClone(state)
    }),
    revoke: vi.fn(async () => {
      state = { ...state, revision: state.revision + 1, approvals: [] }
      return structuredClone(state)
    }),
    selectProvider: vi.fn(async (input: { provider: 'auto' | 'gh' | 'token' }) => {
      state = { ...state, revision: state.revision + 1, authProvider: input.provider }
      return structuredClone(state)
    })
  }
  const resolver = {
    status: vi.fn(async (provider: 'auto' | 'gh' | 'token') => ({
      selectedProvider: provider,
      activeProvider: token ? 'token' as const : null,
      ghAuthenticated: false,
      tokenPresent: !!token,
      storage: secret.availability,
      ...(token ? { login: 'octocat' } : {})
    })),
    resolve: vi.fn(async () => token ? {
      provider: 'token' as const,
      token,
      userId: '1',
      login: 'octocat'
    } : null)
  }
  const client = {
    listIssues: vi.fn(),
    issuesHeartbeat: vi.fn(),
    getIssue: vi.fn(),
    updateIssue: vi.fn(),
    listRepositoryLabels: vi.fn(),
    createLabel: vi.fn(),
    createIssue: vi.fn(),
    createIssueComment: vi.fn()
  }
  const controller = new GitHubHostController({
    project: vi.fn(async (id: string) => id === current.id
      ? { project: current, localApprovalId: 'local-private-id' }
      : null),
    detectRepository: vi.fn(async () => 'owner/repo'),
    controls,
    resolver,
    secret,
    validateToken: vi.fn(async (value: string): Promise<TokenValidation> => value === 'valid-token'
      ? { status: 'ok', identity: { userId: '1', login: 'octocat' } }
      : value === 'unchecked-token'
        ? { status: 'unknown', reason: 'unreachable' }
        : { status: 'unauthorized' }),
    client: vi.fn(() => client),
    ...(options.onRevoked ? { onRevoked: options.onRevoked } : {}),
    ...(options.onApprovalChanged ? { onApprovalChanged: options.onApprovalChanged } : {}),
    rate: (userId: string) => userId === '1'
      ? {
          status: { resource: 'core', limit: 5_000, remaining: 7, resetAt: 9, observedAt: 1 },
          throttle: { until: 9, kind: 'low-budget' as const }
        }
      : {}
  })
  return {
    controller, controls, resolver, secret, client,
    setProject: (next: Project) => { current = next },
    setState: (next: GitHubControlState) => { state = next }
  }
}

describe('GitHubHostController', () => {
  it('returns a status view without tokens, approvals, or the local approval id', async () => {
    const { controller, resolver } = fixture()
    const view = await controller.status('project-1')
    expect(view).toMatchObject({
      control: { revision: 0, authProvider: 'auto' },
      project: { repository: 'owner/repo', detectedRepository: 'owner/repo', approved: false }
    })
    expect(JSON.stringify(view)).not.toMatch(/secret|local-private-id|approvals/i)
    expect(resolver.status).not.toHaveBeenCalled()
  })

  it('strips the resolver identity from the wire and attaches that identity rate budget', async () => {
    const { controller, resolver } = fixture()
    resolver.status.mockResolvedValueOnce({
      selectedProvider: 'auto', activeProvider: 'token', ghAuthenticated: false,
      tokenPresent: true, storage: 'encrypted', login: 'octocat', userId: '1'
    } as never)
    const view = await controller.status()
    expect(view.auth).not.toHaveProperty('userId')
    expect(view.rate).toEqual({ resource: 'core', limit: 5_000, remaining: 7, resetAt: 9, observedAt: 1 })
    expect(view.throttle).toEqual({ until: 9, kind: 'low-budget' })
  })

  it('requires exact local approval before creating a service context', async () => {
    const { controller } = fixture()
    await expect(controller.contextForProject('project-1')).rejects.toMatchObject({ code: 'not-approved' })
    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: 0 })
    const context = await controller.contextForProject('project-1')
    expect(context).toMatchObject({
      projectId: 'project-1',
      repository: 'owner/repo',
      userId: '1',
      columnColors: { todo: '#2563eb', done: '#16a34a' }
    })
  })

  it('stops writes when a pulled commit changes the column mapping, until this machine approves it again', async () => {
    const { controller, setProject } = fixture()
    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: 0 })
    expect((await controller.contextForProject('project-1')).mappingApproved).toBe(true)

    // The completion column now closes issues from "Todo" — nobody on this machine agreed to that.
    setProject({ ...project, kanban: { ...project.kanban!, github: {
      ...project.kanban!.github!, completionColumnId: 'todo'
    } } })
    const changed = await controller.contextForProject('project-1')
    expect(changed.mappingApproved).toBe(false)
    const view = await controller.status('project-1')
    expect(view.project).toMatchObject({ approved: true, mappingApproved: false })

    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: 1 })
    expect((await controller.contextForProject('project-1')).mappingApproved).toBe(true)
    expect((await controller.status('project-1')).project?.mappingApproved).toBe(true)
  })

  it('keeps reading under an approval from before mappings were bound, but never writes under it', async () => {
    const { controller, setState } = fixture()
    setState({
      version: 1, revision: 4, authProvider: 'auto',
      approvals: [{
        localApprovalId: 'local-private-id', projectId: 'project-1', repository: 'owner/repo',
        enabled: true, approvedAt: 1
      }]
    })
    const context = await controller.projectContextForCache('project-1')
    expect(context.mappingApproved).toBe(false)
    // The resolved project rides the cache context, so the `issues` / `prs` control verbs load the
    // workspace once per call (core/github/control-read.ts).
    expect(context.project?.id).toBe('project-1')
    expect((await controller.status('project-1')).project).toMatchObject({ approved: true, mappingApproved: false })
  })

  it('revokes first and then clears the cache, and says so when the cache could not be cleared', async () => {
    const order: string[] = []
    const { controller, controls } = fixture({
      onRevoked: async (projectId: string) => { order.push(`clear:${projectId}`); throw new Error('EBUSY') }
    })
    controls.revoke.mockImplementationOnce(async () => {
      order.push('revoke')
      return { version: 1, revision: 1, authProvider: 'auto', approvals: [] }
    })
    await expect(controller.revoke({ projectId: 'project-1', expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'revoked-cache-kept' })
    expect(order).toEqual(['revoke', 'clear:project-1'])
  })

  it('tells open boards the approval changed, on approve and on a revoke whose cache clear failed', async () => {
    const changed = vi.fn()
    const { controller } = fixture({
      onApprovalChanged: changed,
      onRevoked: async () => { throw new Error('EBUSY') }
    })
    await controller.approve({ projectId: 'project-1', repository: 'owner/repo', expectedRevision: 0 })
    expect(changed).toHaveBeenCalledWith('project-1')
    changed.mockClear()
    // A successful clear already prompts the board (it empties the cache it shows); a failed one
    // does not, and the board must still learn it is no longer approved.
    await expect(controller.revoke({ projectId: 'project-1', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'revoked-cache-kept' })
    expect(changed).toHaveBeenCalledWith('project-1')
  })

  it('rejects approval for a repository other than the configured or detected repository', async () => {
    const { controller } = fixture()
    await expect(controller.approve({
      projectId: 'project-1', repository: 'other/repo', expectedRevision: 0
    })).rejects.toBeInstanceOf(GitHubHostError)
  })

  it('validates a token before saving and never returns it', async () => {
    const { controller, secret } = fixture()
    await expect(controller.saveToken('bad')).rejects.toMatchObject({ code: 'invalid-token' })
    expect(secret.save).not.toHaveBeenCalled()
    const view = await controller.saveToken('valid-token')
    expect(secret.save).toHaveBeenCalledWith('valid-token')
    expect(JSON.stringify(view)).not.toContain('valid-token')
  })

  it('does not call a token invalid when GitHub could not be asked, and saves nothing', async () => {
    const { controller, secret } = fixture()
    await expect(controller.saveToken('unchecked-token')).rejects.toMatchObject({ code: 'github-unreachable' })
    expect(secret.save).not.toHaveBeenCalled()
  })
})
