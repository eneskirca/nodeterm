import { create } from 'zustand'
import type {
  GitHubIssuePage,
  GitHubIssuesApi,
  GitHubMutationResult
} from '@shared/github-issues'

export interface GitHubProjectPages {
  pages: Record<string, GitHubIssuePage>
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
  loadMore(api: GitHubIssuesApi, projectId: string, columnId: string | null): Promise<void>
  move(
    api: GitHubIssuesApi,
    projectId: string,
    issueNumber: number,
    toColumnId: string | null,
    expectedUpdatedAt: string
  ): Promise<GitHubMutationResult>
}

const keyFor = (columnId: string | null): string => columnId ?? 'ungrouped'
let nextConnectionGeneration = 0

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
          pages: {}, columns, moving: {}, loading: true, labelFilter, issueStatus: {},
          generation, loadGeneration: 0
        }
      }
    }))
    let live = true
    let subscribed = false
    const changed = api.onChanged(projectId, () => {
      if (live && ownsConnection()) void get().reload(api, projectId)
    })
    const teardown = (): void => {
      if (!live) return
      live = false
      changed()
      if (!ownsConnection()) return
      if (subscribed) void api.unsubscribe(projectId)
      set((state) => {
        if (state.projects[projectId]?.generation !== generation) return state
        const projects = { ...state.projects }
        delete projects[projectId]
        return { projects }
      })
    }
    try {
      const ungrouped = await api.subscribe(projectId)
      subscribed = true
      if (!ownsConnection()) {
        live = false
        changed()
        if (!get().projects[projectId]) void api.unsubscribe(projectId)
        return () => undefined
      }
      const loadGeneration = get().projects[projectId]?.loadGeneration ?? 0
      const columnPages = await Promise.all(columns.map(async (columnId) => [
        columnId,
        await api.query({ projectId, columnId, pageSize: 50, labelFilter })
      ] as const))
      set((state) => state.projects[projectId]?.generation === generation &&
        state.projects[projectId]?.loadGeneration === loadGeneration ? ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: { ungrouped, ...Object.fromEntries(columnPages) },
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
            pages: {}, columns, moving: {}, loading: false, labelFilter, issueStatus: {},
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
      const pages = await Promise.all([null, ...current.columns].map(async (columnId) => [
        keyFor(columnId),
        await api.query({ projectId, columnId, pageSize: 50, labelFilter: current.labelFilter })
      ] as const))
      set((state) => {
        const existing = state.projects[projectId]
        if (existing?.generation !== generation || existing.loadGeneration !== loadGeneration) return state
        return existing ? {
          projects: {
            ...state.projects,
            [projectId]: { ...existing, pages: Object.fromEntries(pages), loading: false, error: undefined }
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

  async loadMore(api, projectId, columnId) {
    const project = get().projects[projectId]
    const current = project?.pages[keyFor(columnId)]
    if (!project || !current?.nextCursor) return
    const generation = project.generation
    const loadGeneration = project.loadGeneration
    const next = await api.query({
      projectId,
      columnId,
      pageSize: 50,
      cursor: current.nextCursor,
      labelFilter: project.labelFilter
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
            pages: {
              ...existing.pages,
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
