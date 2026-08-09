export interface ProjectKanbanGitHub {
  repository?: string
  columnMappings: Array<{
    columnId: string
    label: string
  }>
  completionColumnId?: string
}

export interface NormalisedProjectKanbanGitHub {
  repository?: string
  columnMappings: Array<{
    columnId: string
    label: string
  }>
  completionColumnId?: string
  revision: string
}

export type GitHubConfigError =
  | 'invalid-shape'
  | 'invalid-repository'
  | 'unknown-column'
  | 'duplicate-column'
  | 'empty-label'
  | 'duplicate-label'
  | 'invalid-completion-column'

export type GitHubConfigResult =
  | { ok: true; value: NormalisedProjectKanbanGitHub }
  | { ok: false; reason: GitHubConfigError }
