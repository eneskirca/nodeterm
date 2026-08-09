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

export type GitHubAuthProvider = 'auto' | 'gh' | 'token'
export type GitHubSecretAvailability = 'encrypted' | 'restricted-file' | 'unavailable'

export interface GitHubProjectApproval {
  localApprovalId: string
  projectId: string
  repository: string
  enabled: true
  approvedAt: number
}

export interface GitHubControlState {
  version: 1
  revision: number
  authProvider: GitHubAuthProvider
  approvals: GitHubProjectApproval[]
}

export interface GitHubAuthStatus {
  selectedProvider: GitHubAuthProvider
  activeProvider: Exclude<GitHubAuthProvider, 'auto'> | null
  ghAuthenticated: boolean
  tokenPresent: boolean
  storage: GitHubSecretAvailability
  login?: string
}
