import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssuesApi } from '@shared/github-issues'
import { useGitHubIssues } from './githubIssues'

const page = (number: number, columnId: string | null, nextCursor?: string) => ({
  items: [{
    id: number, number, title: `Issue ${number}`, body: '', state: 'open' as const,
    stateReason: null, htmlUrl: `https://github.com/o/r/issues/${number}`,
    apiUrl: `https://api.github.com/repos/o/r/issues/${number}`, labels: [], assignees: [],
    createdAt: '2026-08-09T00:00:00Z', updatedAt: '2026-08-09T00:00:00Z', locked: false,
    columnId, conflict: null
  }],
  counts: { [columnId ?? 'ungrouped']: 1 },
  partial: false,
  readOnly: false,
  ...(nextCursor ? { nextCursor } : {})
})

function api(): GitHubIssuesApi {
  return {
    subscribe: vi.fn(async () => page(1, null)),
    unsubscribe: vi.fn(async () => {}),
    query: vi.fn(async (request) => page(request.columnId === 'todo' ? 2 : 3, request.columnId)),
    refresh: vi.fn(async () => {}),
    moveIssue: vi.fn(async () => ({ status: 'configuration-changed' as const })),
    createMissingLabels: vi.fn(async () => ({ status: 'confirmed' as const, created: [], remaining: [] })),
    clearCache: vi.fn(async () => {}),
    onChanged: vi.fn(() => () => {})
  }
}

beforeEach(() => useGitHubIssues.setState({ projects: {} }))

describe('GitHub issue renderer state', () => {
  it('subscribes once and loads every visible column', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(
      client, 'p1', ['todo', 'done'], ['github:bug']
    )
    expect(client.subscribe).toHaveBeenCalledWith('p1')
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ labelFilter: ['github:bug'] }))
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items[0].number).toBe(2)
    disconnect()
    expect(client.unsubscribe).toHaveBeenCalledWith('p1')
  })

  it('marks only the issue being moved and exposes an actionable non-confirmed status', async () => {
    const client = api()
    await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    let resolveMove!: (value: { status: 'configuration-changed' }) => void
    vi.mocked(client.moveIssue).mockReturnValue(new Promise((resolve) => { resolveMove = resolve }))
    const moving = useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z')
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBe(true)
    resolveMove({ status: 'configuration-changed' })
    await moving
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBeUndefined()
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('settings changed')
  })

  it('catches a failed move so fire-and-forget UI calls do not reject', async () => {
    const client = api()
    await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    vi.mocked(client.moveIssue).mockRejectedValue(new Error('network down'))
    await expect(useGitHubIssues.getState().move(
      client, 'p1', 2, 'done', '2026-08-09T00:00:00Z'
    )).resolves.toEqual({ status: 'failed', message: 'network down' })
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('network down')
  })
})
