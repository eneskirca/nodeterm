import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubIssuesApi } from '@shared/github-issues'
import { lookupPullRequests, pullBoardFor, useGitHubIssues } from './githubIssues'

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

const pullPage = (number: number, columnId: string | null, nextCursor?: string) => {
  const base = page(number, columnId, nextCursor)
  return { ...base, items: [{ ...base.items[0], pull: { draft: false, mergedAt: null } }] }
}

function api(): GitHubIssuesApi {
  return {
    subscribe: vi.fn(async () => page(1, null)),
    unsubscribe: vi.fn(async () => {}),
    query: vi.fn(async (request) => request.kind === 'pull'
      ? pullPage(request.columnId === 'todo' ? 200 : 300, request.columnId)
      : page(request.columnId === 'todo' ? 2 : 3, request.columnId)),
    refresh: vi.fn(async () => {}),
    moveIssue: vi.fn(async () => ({ status: 'configuration-changed' as const })),
    createMissingLabels: vi.fn(async () => ({ status: 'confirmed' as const, created: [], remaining: [] })),
    clearCache: vi.fn(async () => {}),
    pullStatus: vi.fn(async () => ({
      pulls: [], stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    })),
    chasePulls: vi.fn(async () => false),
    pullChecks: vi.fn(async () => ({ status: 'no-checks' as const })),
    claimPullAutoMove: vi.fn(async () => false),
    notePullWaits: vi.fn(async () => 0),
    projectAvatar: vi.fn(async () => null),
    onChanged: vi.fn(() => () => {})
  }
}

beforeEach(() => useGitHubIssues.setState({ projects: {}, pullWatch: {} }))

describe('GitHub issue renderer state', () => {
  it('lets only the newest overlapping connection publish or tear down project state', async () => {
    const client = api()
    let resolveFirst!: (value: ReturnType<typeof page>) => void
    const first = new Promise<ReturnType<typeof page>>((resolve) => { resolveFirst = resolve })
    vi.mocked(client.subscribe).mockReturnValueOnce(first)

    const oldConnection = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    const newConnection = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    expect(client.subscribe).toHaveBeenCalledTimes(1)
    resolveFirst(page(1, null))
    const [oldDisconnect, newDisconnect] = await Promise.all([oldConnection, newConnection])

    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)
    oldDisconnect()
    expect(client.unsubscribe).not.toHaveBeenCalled()
    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)

    newDisconnect()
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
    expect(useGitHubIssues.getState().projects.p1).toBeUndefined()
  })

  it('releases the shared host subscription when a replacement connection fails', async () => {
    const client = api()
    const oldDisconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    vi.mocked(client.query).mockRejectedValueOnce(new Error('replacement failed'))

    const newDisconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    oldDisconnect()
    expect(client.unsubscribe).not.toHaveBeenCalled()

    newDisconnect()
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps pending subscriptions separate when the project changes host API', async () => {
    const oldApi = api()
    const newApi = api()
    let resolveOld!: (value: ReturnType<typeof page>) => void
    vi.mocked(oldApi.subscribe).mockReturnValue(new Promise((resolve) => { resolveOld = resolve }))

    const oldConnection = useGitHubIssues.getState().connect(oldApi, 'p1', ['todo'])
    const newDisconnect = await useGitHubIssues.getState().connect(newApi, 'p1', ['todo'])
    expect(oldApi.subscribe).toHaveBeenCalledTimes(1)
    expect(newApi.subscribe).toHaveBeenCalledTimes(1)
    resolveOld(page(1, null))
    const oldDisconnect = await oldConnection

    expect(oldApi.unsubscribe).toHaveBeenCalledTimes(1)
    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(3)
    oldDisconnect()
    newDisconnect()
    expect(newApi.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('keeps a refresh delta that arrives while initial column queries are pending', async () => {
    const client = api()
    let changed!: (changedIssueNumbers: number[]) => void
    vi.mocked(client.onChanged).mockImplementation((_projectId, callback) => {
      changed = callback
      return () => undefined
    })
    let resolveInitial!: (value: ReturnType<typeof page>) => void
    let initialStarted!: () => void
    const started = new Promise<void>((resolve) => { initialStarted = resolve })
    vi.mocked(client.query).mockImplementationOnce(async () => {
      initialStarted()
      return new Promise((resolve) => { resolveInitial = resolve })
    }).mockImplementation(async (request) =>
      page(request.columnId === 'todo' ? 20 : 30, request.columnId))

    const connecting = useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await started
    changed([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    resolveInitial(page(2, 'todo'))
    const disconnect = await connecting

    expect(useGitHubIssues.getState().projects.p1.pages.ungrouped.items[0].number).toBe(30)
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items[0].number).toBe(20)
    disconnect()
  })

  it('subscribes once and loads every visible column, in both kinds', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(
      client, 'p1', ['todo', 'done'], ['github:bug']
    )
    expect(client.subscribe).toHaveBeenCalledWith('p1')
    // Three columns × two kinds. Both are served from the one cached snapshot in core, so the
    // pull pass is a read of data the refresh already fetched.
    expect(client.query).toHaveBeenCalledTimes(6)
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({ labelFilter: ['github:bug'] }))
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items[0].number).toBe(2)
    expect(useGitHubIssues.getState().projects.p1.pullPages.todo.items[0].number).toBe(200)
    disconnect()
    expect(client.unsubscribe).toHaveBeenCalledWith('p1')
  })

  it('pages more of the kind it was asked for, leaving the other lane alone', async () => {
    const client = api()
    vi.mocked(client.query).mockImplementation(async (request) => request.kind === 'pull'
      ? pullPage(request.cursor ? 201 : 200, request.columnId, request.cursor ? undefined : '1')
      : page(2, request.columnId))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])

    await useGitHubIssues.getState().loadMore(client, 'p1', 'todo', 'pull')
    expect(useGitHubIssues.getState().projects.p1.pullPages.todo.items.map((item) => item.number))
      .toEqual([200, 201])
    expect(useGitHubIssues.getState().projects.p1.pages.todo.items.map((item) => item.number))
      .toEqual([2])
    disconnect()
  })

  it('marks only the issue being moved and exposes an actionable non-confirmed status', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    let resolveMove!: (value: { status: 'configuration-changed' }) => void
    vi.mocked(client.moveIssue).mockReturnValue(new Promise((resolve) => { resolveMove = resolve }))
    const moving = useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z')
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBe(true)
    resolveMove({ status: 'configuration-changed' })
    await moving
    expect(useGitHubIssues.getState().projects.p1.moving[2]).toBeUndefined()
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('settings changed')
    disconnect()
  })

  it('passes the chosen close reason through to the host', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z', 'not_planned')
    expect(client.moveIssue).toHaveBeenCalledWith({
      projectId: 'p1', issueNumber: 2, toColumnId: 'done',
      expectedUpdatedAt: '2026-08-09T00:00:00Z', closeReason: 'not_planned'
    })
    disconnect()
  })

  it('points a move refused for an unapproved mapping at the approval, not at a refresh', async () => {
    const client = api()
    vi.mocked(client.query).mockImplementation(async (request) => ({
      ...page(request.columnId === 'todo' ? 2 : 3, request.columnId),
      readOnly: true,
      mappingNotApproved: true as const
    }))
    vi.mocked(client.moveIssue).mockResolvedValue({ status: 'read-only' })
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().move(client, 'p1', 2, 'done', '2026-08-09T00:00:00Z')
    const said = useGitHubIssues.getState().projects.p1.issueStatus[2]
    expect(said).toContain('Approve them in Settings')
    expect(said).not.toContain('refresh')
    disconnect()
  })

  it('catches a failed move so fire-and-forget UI calls do not reject', async () => {
    const client = api()
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    vi.mocked(client.moveIssue).mockRejectedValue(new Error('network down'))
    await expect(useGitHubIssues.getState().move(
      client, 'p1', 2, 'done', '2026-08-09T00:00:00Z'
    )).resolves.toEqual({ status: 'failed', message: 'network down' })
    expect(useGitHubIssues.getState().projects.p1.issueStatus[2]).toContain('network down')
    disconnect()
  })

  it('loads the pull board with the pages and refreshes it on reload', async () => {
    const client = api()
    const board = (number: number) => ({
      pulls: [{ number, lifecycle: 'open' as const, headRefName: 'x', closes: [], ci: 'passed' as const }],
      observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    })
    vi.mocked(client.pullStatus).mockResolvedValueOnce(board(1)).mockResolvedValueOnce(board(2))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    expect(useGitHubIssues.getState().projects.p1.pullBoard?.pulls[0].number).toBe(1)
    await useGitHubIssues.getState().reload(client, 'p1')
    expect(useGitHubIssues.getState().projects.p1.pullBoard?.pulls[0].number).toBe(2)
    disconnect()
  })

  it('a host that cannot answer pull status leaves the board working and the last pull board in place', async () => {
    const client = api()
    const board = {
      pulls: [], observedAt: 1, stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
    }
    vi.mocked(client.pullStatus).mockResolvedValueOnce(board).mockRejectedValueOnce(new Error('E_UNKNOWN_METHOD'))
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    await useGitHubIssues.getState().reload(client, 'p1')
    const project = useGitHubIssues.getState().projects.p1
    expect(project.error).toBeUndefined()
    expect(project.pages.todo.items).toHaveLength(1)
    expect(project.pullBoard).toEqual(board)
    disconnect()
  })
})

describe('the PR watch an armed --after-pr node keeps (no board open)', () => {
  const pullBoard = (n: number) => ({
    repository: 'o/r', now: n, pulls: [], stale: false, access: { ci: true, merge: true }, undecided: false, truncated: false
  })

  it('reads the host board, re-reads on every change, and shares the board’s host subscription', async () => {
    const client = api()
    let fire: (() => void) | undefined
    vi.mocked(client.onChanged).mockImplementation((_p, listener) => {
      fire = () => listener([])
      return () => { fire = undefined }
    })
    vi.mocked(client.pullStatus).mockResolvedValueOnce(pullBoard(1)).mockResolvedValueOnce(pullBoard(2))
    useGitHubIssues.setState({ projects: {}, pullWatch: {} })
    const release = await useGitHubIssues.getState().watchPulls(client, 'p1')
    expect(pullBoardFor(useGitHubIssues.getState(), 'p1')?.now).toBe(1)
    fire?.()
    await vi.waitFor(() => expect(pullBoardFor(useGitHubIssues.getState(), 'p1')?.now).toBe(2))
    // A second watcher and a board connection ride the SAME host subscription.
    const again = await useGitHubIssues.getState().watchPulls(client, 'p1')
    const disconnect = await useGitHubIssues.getState().connect(client, 'p1', ['todo'])
    expect(client.subscribe).toHaveBeenCalledTimes(1)
    release()
    again()
    expect(client.unsubscribe).not.toHaveBeenCalled()
    expect(useGitHubIssues.getState().pullWatch.p1).toBeUndefined()
    disconnect()
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('pullBoardFor prefers the newer of the watch and the open board', () => {
    const state = {
      projects: { p1: { pullBoard: pullBoard(5) } },
      pullWatch: { p1: pullBoard(3) }
    } as never
    expect(pullBoardFor(state, 'p1')?.now).toBe(5)
    expect(pullBoardFor({ projects: {}, pullWatch: { p1: pullBoard(3) } } as never, 'p1')?.now).toBe(3)
    expect(pullBoardFor({ projects: {}, pullWatch: {} } as never, 'p1')).toBeUndefined()
  })
})

describe('lookupPullRequests — does the board repository have these pull requests?', () => {
  const item = (number: number, patch: Record<string, unknown> = {}) => ({
    ...pullPage(number, null).items[0],
    ...patch
  })
  /** A fake host: one harvested list, its last refresh stamp and whether it is truncated. `refresh`
   *  can land new items (a PR opened a minute ago) and move the stamp, or do nothing (the floor). */
  function host(init: { items: ReturnType<typeof item>[]; refreshedAt?: number; partial?: boolean }) {
    const state = { ...init, now: 1_000 }
    const client = api()
    vi.mocked(client.pullStatus).mockImplementation(async () => ({
      repository: 'o/r', now: state.now, pulls: [], stale: false, access: { ci: true, merge: true },
      undecided: false, truncated: false
    }))
    vi.mocked(client.query).mockImplementation(async (request) => {
      const hits = state.items.filter((i) => String(i.number).includes(request.search ?? ''))
      const counts: Record<string, number> = {}
      for (const i of hits) counts[(i.columnId as string | null) ?? 'ungrouped'] = (counts[(i.columnId as string | null) ?? 'ungrouped'] ?? 0) + 1
      return {
        items: hits.filter((i) => i.columnId === request.columnId), counts, partial: !!state.partial, readOnly: true,
        ...(state.refreshedAt !== undefined ? { lastSuccessfulRefreshAt: state.refreshedAt } : {})
      } as never
    })
    return { client, state }
  }

  it('finds a PR in a column the board no longer has — the counts name every column that holds a match', async () => {
    const { client } = host({ items: [item(7, { columnId: 'deleted-col' })], refreshedAt: 5 })
    const found = await lookupPullRequests(client, 'p1', ['todo'], [7])
    expect(found.get(7)).toEqual({ found: true, lifecycle: 'open' })
    expect(client.refresh).not.toHaveBeenCalled()
  })

  it('follows pages and reads every lifecycle', async () => {
    const { client } = host({
      items: [
        item(1),
        item(2, { pull: { draft: true, mergedAt: null } }),
        item(3, { state: 'closed', pull: { draft: false, mergedAt: null } }),
        item(4, { state: 'closed', pull: { draft: false, mergedAt: '2026-09-01T00:00:00Z' } })
      ],
      refreshedAt: 5
    })
    const found = await lookupPullRequests(client, 'p1', [], [1, 2, 3, 4])
    expect([1, 2, 3, 4].map((n) => found.get(n))).toEqual([
      { found: true, lifecycle: 'open' },
      { found: true, lifecycle: 'draft' },
      { found: true, lifecycle: 'closed' },
      { found: true, lifecycle: 'merged' }
    ])
    expect(client.subscribe).toHaveBeenCalledTimes(1)
    expect(client.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('B1: a PR opened after the last refresh is found by one refresh on the miss, not refused', async () => {
    // `gh pr create` → `open-claude --after-pr N:checks`: the board's snapshot predates the PR.
    const { client, state } = host({ items: [], refreshedAt: 5 })
    vi.mocked(client.refresh).mockImplementation(async () => {
      state.items = [item(1019)]
      state.refreshedAt = state.now
    })
    const found = await lookupPullRequests(client, 'p1', [], [1019])
    expect(found.get(1019)).toEqual({ found: true, lifecycle: 'open' })
    expect(client.refresh).toHaveBeenCalledTimes(1)
  })

  it('"not found" is an answer only from a refresh that started after this call', async () => {
    const { client, state } = host({ items: [], refreshedAt: 5 })
    vi.mocked(client.refresh).mockImplementation(async () => { state.refreshedAt = state.now })
    expect((await lookupPullRequests(client, 'p1', [], [9])).get(9)).toEqual({ found: false, complete: true })
  })

  it('an OLD snapshot proves nothing: no refresh landed (the floor), an older one landed, or it failed', async () => {
    const floored = host({ items: [], refreshedAt: 5 })
    expect((await lookupPullRequests(floored.client, 'p1', [], [9])).get(9)).toEqual({ found: false, complete: false })
    const inFlight = host({ items: [], refreshedAt: 5 })
    vi.mocked(inFlight.client.refresh).mockImplementation(async () => { inFlight.state.refreshedAt = 900 })
    expect((await lookupPullRequests(inFlight.client, 'p1', [], [9])).get(9)).toEqual({ found: false, complete: false })
    const failed = host({ items: [], refreshedAt: 5 })
    vi.mocked(failed.client.refresh).mockRejectedValue(new Error('offline'))
    expect((await lookupPullRequests(failed.client, 'p1', [], [9])).get(9)).toEqual({ found: false, complete: false })
  })

  it('a truncated harvest says so: an old PR it dropped will never be confirmed by waiting', async () => {
    const { client, state } = host({ items: [], refreshedAt: 5, partial: true })
    vi.mocked(client.refresh).mockImplementation(async () => { state.refreshedAt = state.now })
    expect((await lookupPullRequests(client, 'p1', [], [9])).get(9)).toEqual({
      found: false, complete: false, truncated: true
    })
  })
})
