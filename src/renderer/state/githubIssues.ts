import { create } from 'zustand'
import type {
  GitHubCloseReason,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubIssuesApi,
  GitHubMutationResult
} from '@shared/github-issues'
import type { GitHubPullBoard, PullLifecycle } from '@shared/github-pull-status'
import { GITHUB_MAPPING_NOT_APPROVED } from '../lib/githubSyncStatus'
import type { PrLookup } from '../lib/prWait'

export interface GitHubProjectPages {
  pages: Record<string, GitHubIssuePage>
  /** The same columns paged for the other kind. Pull requests ride the issue snapshot, so this
   *  costs no extra network refresh — one query per column against what is already cached. */
  pullPages: Record<string, GitHubIssuePage>
  columns: string[]
  /** Pull request CI/mergeability and the PR ↔ issue/branch facts, from the host's memory (no
   *  request). Absent until the first load, and on a host too old to answer. */
  pullBoard?: GitHubPullBoard
  moving: Record<number, true>
  loading: boolean
  error?: string
  labelFilter: string[]
  issueStatus: Record<number, string>
  generation: number
  loadGeneration: number
}

interface GitHubIssuesState {
  projects: Record<string, GitHubProjectPages>
  /** Pull request status kept for armed `--after-pr` nodes, whether or not a board is open. The
   *  SAME host memory the board reads (`pullStatus`, no request), refreshed on the same change
   *  events, and it rides the board's refcounted host subscription — the existing 60 s conditional
   *  heartbeat, not a poller of its own. */
  pullWatch: Record<string, GitHubPullBoard>
  watchPulls(api: GitHubIssuesApi, projectId: string): Promise<() => void>
  connect(api: GitHubIssuesApi, projectId: string, columns: string[], labelFilter?: string[]): Promise<() => void>
  reload(api: GitHubIssuesApi, projectId: string): Promise<void>
  loadMore(
    api: GitHubIssuesApi,
    projectId: string,
    columnId: string | null,
    kind?: GitHubIssueQuery['kind']
  ): Promise<void>
  move(
    api: GitHubIssuesApi,
    projectId: string,
    issueNumber: number,
    toColumnId: string | null,
    expectedUpdatedAt: string,
    closeReason?: GitHubCloseReason
  ): Promise<GitHubMutationResult>
}

const keyFor = (columnId: string | null): string => columnId ?? 'ungrouped'

/** A host that cannot answer (older build over a relay, a transient failure) leaves the board
 *  without pull status; the issue and PR cards still render exactly as before. */
async function loadPullBoard(api: GitHubIssuesApi, projectId: string): Promise<GitHubPullBoard | undefined> {
  try {
    return await api.pullStatus(projectId)
  } catch {
    return undefined
  }
}

/** The pages say the board is read only because the column mapping is not approved here. */
function mappingNotApproved(project: GitHubProjectPages | undefined): boolean {
  return Object.values(project?.pages ?? {}).some((page) => page.mappingNotApproved)
}

/** Pages every column for one kind. Both kinds are served from the one cached snapshot in core,
 *  so the second pass is a read of data already fetched, not a second refresh. */
async function pageColumns(
  api: GitHubIssuesApi,
  projectId: string,
  columns: (string | null)[],
  labelFilter: string[],
  kind: GitHubIssueQuery['kind']
): Promise<Record<string, GitHubIssuePage>> {
  const pages = await Promise.all(columns.map(async (columnId) => [
    keyFor(columnId),
    await api.query({ projectId, columnId, pageSize: 50, labelFilter, ...(kind ? { kind } : {}) })
  ] as const))
  return Object.fromEntries(pages)
}
let nextConnectionGeneration = 0

type HostSubscription = {
  api: GitHubIssuesApi
  refs: number
  subscribed: boolean
  pending?: Promise<void>
}

const hostSubscriptions = new WeakMap<GitHubIssuesApi, Map<string, HostSubscription>>()

function subscriptionsFor(api: GitHubIssuesApi): Map<string, HostSubscription> {
  let subscriptions = hostSubscriptions.get(api)
  if (!subscriptions) {
    subscriptions = new Map()
    hostSubscriptions.set(api, subscriptions)
  }
  return subscriptions
}

async function acquireHostSubscription(api: GitHubIssuesApi, projectId: string): Promise<() => void> {
  const subscriptions = subscriptionsFor(api)
  let record = subscriptions.get(projectId)
  if (!record) {
    record = { api, refs: 0, subscribed: false }
    subscriptions.set(projectId, record)
  }
  record.refs += 1
  try {
    if (!record.subscribed) {
      if (!record.pending) {
        const current = record
        current.pending = current.api.subscribe(projectId).then(() => {
          current.subscribed = true
        }).finally(() => {
          delete current.pending
        })
      }
      await record.pending
    }
  } catch (error) {
    record.refs -= 1
    if (record.refs === 0 && subscriptions.get(projectId) === record) {
      subscriptions.delete(projectId)
    }
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    record!.refs -= 1
    if (record!.refs !== 0 || subscriptions.get(projectId) !== record) return
    subscriptions.delete(projectId)
    if (record!.subscribed) void record!.api.unsubscribe(projectId)
  }
}

type PullWatchRecord = { refs: number; ready: Promise<void>; teardown?: () => void }
const pullWatches = new WeakMap<GitHubIssuesApi, Map<string, PullWatchRecord>>()

/** The freshest pull request status known for a project: the open board's or the watch's, by the
 *  host clock each was answered at. */
export function pullBoardFor(
  state: Pick<GitHubIssuesState, 'projects' | 'pullWatch'>,
  projectId: string
): GitHubPullBoard | undefined {
  const fromBoard = state.projects[projectId]?.pullBoard
  const fromWatch = state.pullWatch[projectId]
  if (!fromBoard) return fromWatch
  if (!fromWatch) return fromBoard
  return (fromWatch.now ?? 0) > (fromBoard.now ?? 0) ? fromWatch : fromBoard
}

function lifecycleOf(item: GitHubIssuePage['items'][number]): PullLifecycle {
  if (item.state === 'open') return item.pull?.draft ? 'draft' : 'open'
  return item.pull?.mergedAt ? 'merged' : 'closed'
}

/**
 * Does the board's repository have these pull requests, and where are they in their life? Read
 * from the host's harvested issue list (#1008: pull requests ride the same REST snapshot). Holding
 * the host subscription for the duration makes the host read the repository first when nothing has
 * yet in this app run.
 *
 * Which columns: the first page's `counts` name every column that holds a match, so a PR the
 * mapping files under a column the board has since deleted is still found.
 *
 * "Not found" is an ANSWER only from a snapshot a refresh STARTED after this call produced (B1). A
 * snapshot from before it proves nothing — the headline flow is `gh pr create` then `open-* --after-pr`,
 * and the board's last refresh can be a minute old — so a miss asks for one refresh and looks again.
 * A refresh the floor swallowed, one already in flight from before the call, or one that failed
 * leaves `complete: false`, which a caller must not read as absence. A truncated harvest is named:
 * a PR it dropped is never listed however long one waits.
 */
export async function lookupPullRequests(
  api: GitHubIssuesApi,
  projectId: string,
  columns: string[],
  numbers: number[]
): Promise<Map<number, PrLookup>> {
  const release = await acquireHostSubscription(api, projectId)
  try {
    type Search = { item?: GitHubIssuePage['items'][number]; synced: boolean; partial: boolean; refreshedAt?: number }
    const search = async (number: number): Promise<Search> => {
      const pageOf = (columnId: string | null, cursor?: string) => api.query({
        projectId, columnId, kind: 'pull', pageSize: 50, search: String(number), ...(cursor ? { cursor } : {})
      })
      const first = await pageOf(null)
      const found: Search = {
        synced: first.lastSuccessfulRefreshAt !== undefined,
        partial: first.partial,
        refreshedAt: first.lastSuccessfulRefreshAt
      }
      const fromCounts = Object.keys(first.counts).map((key) => (key === 'ungrouped' ? null : key))
      const columnIds = [...new Set<string | null>([null, ...columns, ...fromCounts])]
      for (const columnId of columnIds) {
        let page: GitHubIssuePage | undefined = columnId === null ? first : undefined
        let cursor: string | undefined
        do {
          page = page ?? await pageOf(columnId, cursor)
          if (page.partial) found.partial = true
          if (page.lastSuccessfulRefreshAt === undefined) found.synced = false
          const item = page.items.find((candidate) => candidate.number === number)
          if (item) return { ...found, item }
          cursor = page.nextCursor
          page = undefined
        } while (cursor)
      }
      return found
    }
    const out = new Map<number, PrLookup>()
    const first = await Promise.all(numbers.map(async (number) => [number, await search(number)] as const))
    const missed: number[] = []
    for (const [number, result] of first) {
      if (result.item) out.set(number, { found: true, lifecycle: lifecycleOf(result.item) })
      else missed.push(number)
    }
    if (!missed.length) return out
    // One refresh for every miss, then look again. The host's clock is read BEFORE it, so a snapshot
    // proves absence only if its refresh started at or after that moment.
    const since = await api.pullStatus(projectId).then((board) => board.now, () => undefined)
    const refreshed = await api.refresh(projectId).then(() => true, () => false)
    await Promise.all(missed.map(async (number) => {
      const result = await search(number)
      if (result.item) {
        out.set(number, { found: true, lifecycle: lifecycleOf(result.item) })
        return
      }
      const fresh = refreshed && since !== undefined && result.refreshedAt !== undefined &&
        result.refreshedAt >= since
      const truncated = result.synced && result.partial
      out.set(number, fresh && result.synced && !result.partial
        ? { found: false, complete: true }
        : { found: false, complete: false, ...(truncated ? { truncated: true as const } : {}) })
    }))
    return out
  } finally {
    release()
  }
}

export const useGitHubIssues = create<GitHubIssuesState>((set, get) => ({
  projects: {},
  pullWatch: {},

  async watchPulls(api, projectId) {
    let watches = pullWatches.get(api)
    if (!watches) {
      watches = new Map()
      pullWatches.set(api, watches)
    }
    let record = watches.get(projectId)
    if (!record) {
      const fresh: PullWatchRecord = { refs: 0, ready: Promise.resolve() }
      const load = async (): Promise<void> => {
        const board = await loadPullBoard(api, projectId)
        // A failed read keeps what was there (the host marks its own board stale).
        if (board && watches!.get(projectId) === fresh) {
          set((state) => ({ pullWatch: { ...state.pullWatch, [projectId]: board } }))
        }
      }
      fresh.ready = (async () => {
        const changed = api.onChanged(projectId, () => { void load() })
        let releaseHost: (() => void) | undefined
        fresh.teardown = () => {
          changed()
          releaseHost?.()
        }
        try {
          releaseHost = await acquireHostSubscription(api, projectId)
        } catch {
          // No host subscription (sync not approved, offline): the memory may still answer, and a
          // wait that never learns anything expires on its deadline rather than firing.
        }
        if (watches!.get(projectId) !== fresh) {
          releaseHost?.()
          return
        }
        await load()
      })()
      record = fresh
      watches.set(projectId, record)
    }
    record.refs += 1
    const current = record
    await current.ready
    let released = false
    return () => {
      if (released) return
      released = true
      current.refs -= 1
      if (current.refs !== 0 || watches!.get(projectId) !== current) return
      watches!.delete(projectId)
      current.teardown?.()
      set((state) => {
        if (!(projectId in state.pullWatch)) return state
        const pullWatch = { ...state.pullWatch }
        delete pullWatch[projectId]
        return { pullWatch }
      })
    }
  },

  async connect(api, projectId, columns, labelFilter = []) {
    const generation = ++nextConnectionGeneration
    const ownsConnection = (): boolean =>
      get().projects[projectId]?.generation === generation
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          pages: {}, pullPages: {}, columns, moving: {}, loading: true, labelFilter,
          issueStatus: {}, generation, loadGeneration: 0
        }
      }
    }))
    let live = true
    let releaseHost: (() => void) | undefined
    const changed = api.onChanged(projectId, () => {
      if (live && ownsConnection()) void get().reload(api, projectId)
    })
    const teardown = (): void => {
      if (!live) return
      live = false
      changed()
      releaseHost?.()
      if (!ownsConnection()) return
      set((state) => {
        if (state.projects[projectId]?.generation !== generation) return state
        const projects = { ...state.projects }
        delete projects[projectId]
        return { projects }
      })
    }
    try {
      releaseHost = await acquireHostSubscription(api, projectId)
      if (!ownsConnection()) {
        live = false
        changed()
        releaseHost()
        return () => undefined
      }
      const loadGeneration = get().projects[projectId]?.loadGeneration ?? 0
      const [columnPages, columnPullPages, pullBoard] = await Promise.all([
        pageColumns(api, projectId, [null, ...columns], labelFilter, 'issue'),
        pageColumns(api, projectId, [null, ...columns], labelFilter, 'pull'),
        loadPullBoard(api, projectId)
      ])
      set((state) => state.projects[projectId]?.generation === generation &&
        state.projects[projectId]?.loadGeneration === loadGeneration ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: columnPages,
            pullPages: columnPullPages,
            ...(pullBoard ? { pullBoard } : {}),
            columns,
            moving: state.projects[projectId]?.moving ?? {},
            issueStatus: state.projects[projectId]?.issueStatus ?? {},
            loading: false,
            labelFilter,
            generation,
            loadGeneration
          }
        }
      }) : state)
    } catch (error) {
      set((state) => state.projects[projectId]?.generation === generation ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: {}, pullPages: {}, columns, moving: {}, loading: false, labelFilter,
            issueStatus: {},
            error: error instanceof Error ? error.message : 'GitHub issues are unavailable',
            generation,
            loadGeneration: state.projects[projectId]?.loadGeneration ?? 0
          }
        }
      }) : state)
    }
    if (!ownsConnection()) {
      live = false
      changed()
      releaseHost?.()
      return () => undefined
    }
    return teardown
  },

  async reload(api, projectId) {
    const current = get().projects[projectId]
    if (!current) return
    const generation = current.generation
    const loadGeneration = current.loadGeneration + 1
    set((state) => {
      const existing = state.projects[projectId]
      return existing?.generation === generation ? {
        projects: {
          ...state.projects,
          [projectId]: { ...existing, loadGeneration }
        }
      } : state
    })
    try {
      const [pages, pullPages, pullBoard] = await Promise.all([
        pageColumns(api, projectId, [null, ...current.columns], current.labelFilter, 'issue'),
        pageColumns(api, projectId, [null, ...current.columns], current.labelFilter, 'pull'),
        loadPullBoard(api, projectId)
      ])
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            // A failed pull status read keeps the last board (the host marks it stale itself).
            [projectId]: {
              ...existing, pages, pullPages, pullBoard: pullBoard ?? existing.pullBoard,
              loading: false, error: undefined
            }
          }
        } : state
      })
    } catch (error) {
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            [projectId]: {
              ...existing,
              loading: false,
              error: error instanceof Error ? error.message : 'GitHub issues are unavailable'
            }
          }
        } : state
      })
    }
  },

  async loadMore(api, projectId, columnId, kind = 'issue') {
    const project = get().projects[projectId]
    const field = kind === 'pull' ? 'pullPages' : 'pages'
    const current = project?.[field][keyFor(columnId)]
    if (!project || !current?.nextCursor) return
    const generation = project.generation
    const loadGeneration = project.loadGeneration
    const next = await api.query({
      projectId,
      columnId,
      pageSize: 50,
      cursor: current.nextCursor,
      labelFilter: project.labelFilter,
      kind
    })
    set((state) => {
      const existing = state.projects[projectId]
      if (!existing || existing.generation !== generation ||
          existing.loadGeneration !== loadGeneration) return state
      return {
        projects: {
          ...state.projects,
          [projectId]: {
            ...existing,
            [field]: {
              ...existing[field],
              [keyFor(columnId)]: { ...next, items: [...current.items, ...next.items] }
            }
          }
        }
      }
    })
  },

  async move(api, projectId, issueNumber, toColumnId, expectedUpdatedAt, closeReason) {
    const generation = get().projects[projectId]?.generation
    set((state) => {
      const project = state.projects[projectId]
      if (!project || project.generation !== generation) return state
      return {
        projects: {
          ...state.projects,
          [projectId]: { ...project, moving: { ...project.moving, [issueNumber]: true } }
        }
      }
    })
    try {
      const result = await api.moveIssue({
        projectId, issueNumber, toColumnId, expectedUpdatedAt, ...(closeReason ? { closeReason } : {})
      })
      const status = result.status === 'confirmed'
        ? 'Synced with GitHub.'
        : result.status === 'refresh-pending'
          ? 'Updated on GitHub. Local refresh is pending.'
          : result.status === 'stale'
            ? 'Changed on GitHub. Review the latest issue and retry.'
            : result.status === 'read-only'
              ? mappingNotApproved(get().projects[projectId])
                ? GITHUB_MAPPING_NOT_APPROVED
                : 'This repository is read only until a complete refresh succeeds.'
              : result.status === 'invalid-target'
                ? 'This issue or destination is no longer available.'
                : result.status === 'configuration-changed'
                  ? 'GitHub settings changed. Refresh and retry.'
                  : result.message
      set((state) => {
        const project = state.projects[projectId]
        if (!project || project.generation !== generation) return state
        const pages = result.status === 'stale'
          ? Object.fromEntries(Object.entries(project.pages).map(([key, page]) => [key, {
            ...page,
            items: page.items.map((item) => item.number === issueNumber
              ? { ...item, ...result.issue }
              : item)
          }]))
          : project.pages
        return { projects: { ...state.projects, [projectId]: {
          ...project, pages, issueStatus: { ...project.issueStatus, [issueNumber]: status }
        } } }
      })
      if (result.status === 'confirmed' || result.status === 'refresh-pending' || result.status === 'stale') {
        await get().reload(api, projectId)
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GitHub sync failed'
      set((state) => {
        const project = state.projects[projectId]
        return project?.generation === generation ? { projects: { ...state.projects, [projectId]: {
          ...project, issueStatus: { ...project.issueStatus, [issueNumber]: `Sync failed. ${message}` }
        } } } : state
      })
      return { status: 'failed', message }
    } finally {
      set((state) => {
        const project = state.projects[projectId]
        if (!project || project.generation !== generation) return state
        const moving = { ...project.moving }
        delete moving[issueNumber]
        return { projects: { ...state.projects, [projectId]: { ...project, moving } } }
      })
    }
  }
}))
