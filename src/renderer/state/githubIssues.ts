import { create } from 'zustand'
import type {
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubIssuesApi,
  GitHubMutationResult
} from '@shared/github-issues'
import { useGitHubLinks } from './githubLinks'

export interface GitHubProjectPages {
  pages: Record<string, GitHubIssuePage>
  /** The same columns paged for the other kind. Pull requests ride the issue snapshot, so this
   *  costs no extra network refresh — one query per column against what is already cached. */
  pullPages: Record<string, GitHubIssuePage>
  columns: string[]
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
    expectedUpdatedAt: string
  ): Promise<GitHubMutationResult>
}

const keyFor = (columnId: string | null): string => columnId ?? 'ungrouped'

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
/** Every card the board just paged is a card a node chip may be about to ask for one at a time. */
function seedLinkCards(
  projectId: string,
  ...pages: Record<string, GitHubIssuePage>[]
): void {
  useGitHubLinks.getState().seedFromPages(projectId, pages.flatMap((record) => Object.values(record)))
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

export const useGitHubIssues = create<GitHubIssuesState>((set, get) => ({
  projects: {},

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
    const changed = api.onChanged(projectId, (changedIssueNumbers) => {
      if (!live || !ownsConnection()) return
      useGitHubLinks.getState().invalidate(
        projectId, changedIssueNumbers.length ? changedIssueNumbers : undefined
      )
      void get().reload(api, projectId)
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
      const [columnPages, columnPullPages] = await Promise.all([
        pageColumns(api, projectId, [null, ...columns], labelFilter, 'issue'),
        pageColumns(api, projectId, [null, ...columns], labelFilter, 'pull')
      ])
      seedLinkCards(projectId, columnPages, columnPullPages)
      set((state) => state.projects[projectId]?.generation === generation &&
        state.projects[projectId]?.loadGeneration === loadGeneration ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: columnPages,
            pullPages: columnPullPages,
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
      const [pages, pullPages] = await Promise.all([
        pageColumns(api, projectId, [null, ...current.columns], current.labelFilter, 'issue'),
        pageColumns(api, projectId, [null, ...current.columns], current.labelFilter, 'pull')
      ])
      seedLinkCards(projectId, pages, pullPages)
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            [projectId]: { ...existing, pages, pullPages, loading: false, error: undefined }
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

  async move(api, projectId, issueNumber, toColumnId, expectedUpdatedAt) {
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
      const result = await api.moveIssue({ projectId, issueNumber, toColumnId, expectedUpdatedAt })
      const status = result.status === 'confirmed'
        ? 'Synced with GitHub.'
        : result.status === 'refresh-pending'
          ? 'Updated on GitHub. Local refresh is pending.'
          : result.status === 'stale'
            ? 'Changed on GitHub. Review the latest issue and retry.'
            : result.status === 'read-only'
              ? 'This repository is read only until a complete refresh succeeds.'
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
