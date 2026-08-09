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
}

interface GitHubIssuesState {
  projects: Record<string, GitHubProjectPages>
  connect(api: GitHubIssuesApi, projectId: string, columns: string[]): Promise<() => void>
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

export const useGitHubIssues = create<GitHubIssuesState>((set, get) => ({
  projects: {},

  async connect(api, projectId, columns) {
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: {
          pages: {}, columns, moving: {}, loading: true
        }
      }
    }))
    try {
      const ungrouped = await api.subscribe(projectId)
      const columnPages = await Promise.all(columns.map(async (columnId) => [
        columnId,
        await api.query({ projectId, columnId, pageSize: 50 })
      ] as const))
      set((state) => ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: { ungrouped, ...Object.fromEntries(columnPages) },
            columns,
            moving: state.projects[projectId]?.moving ?? {},
            loading: false
          }
        }
      }))
    } catch (error) {
      set((state) => ({
        projects: {
          ...state.projects,
          [projectId]: {
            pages: {}, columns, moving: {}, loading: false,
            error: error instanceof Error ? error.message : 'GitHub issues are unavailable'
          }
        }
      }))
    }
    let live = true
    const changed = api.onChanged(projectId, () => {
      if (live) void get().reload(api, projectId)
    })
    return () => {
      live = false
      changed()
      void api.unsubscribe(projectId)
      set((state) => {
        const projects = { ...state.projects }
        delete projects[projectId]
        return { projects }
      })
    }
  },

  async reload(api, projectId) {
    const current = get().projects[projectId]
    if (!current) return
    try {
      const pages = await Promise.all([null, ...current.columns].map(async (columnId) => [
        keyFor(columnId),
        await api.query({ projectId, columnId, pageSize: 50 })
      ] as const))
      set((state) => {
        const existing = state.projects[projectId]
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
    const next = await api.query({
      projectId,
      columnId,
      pageSize: 50,
      cursor: current.nextCursor
    })
    set((state) => {
      const existing = state.projects[projectId]
      if (!existing) return state
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
    set((state) => {
      const project = state.projects[projectId]
      if (!project) return state
      return {
        projects: {
          ...state.projects,
          [projectId]: { ...project, moving: { ...project.moving, [issueNumber]: true } }
        }
      }
    })
    try {
      const result = await api.moveIssue({ projectId, issueNumber, toColumnId, expectedUpdatedAt })
      await get().reload(api, projectId)
      return result
    } finally {
      set((state) => {
        const project = state.projects[projectId]
        if (!project) return state
        const moving = { ...project.moving }
        delete moving[issueNumber]
        return { projects: { ...state.projects, [projectId]: { ...project, moving } } }
      })
    }
  }
}))
