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

export interface GitHubIssueLabel {
  id: number
  name: string
  color: string
}

export interface GitHubIssueUser {
  id: number
  login: string
  avatarUrl: string
}

export interface GitHubIssue {
  id: number
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  stateReason: 'completed' | 'not_planned' | 'reopened' | null
  htmlUrl: string
  apiUrl: string
  labels: GitHubIssueLabel[]
  assignees: GitHubIssueUser[]
  createdAt: string
  updatedAt: string
  locked: boolean
}

export interface ListIssueOptions {
  state: 'open' | 'closed' | 'all'
  page: number
  perPage: number
  since?: string
  etag?: string
}

export interface IssuePageResult {
  items: GitHubIssue[]
  nextPage?: number
  etag?: string
  notModified?: boolean
}

export interface UpdateIssueInput {
  state?: 'open' | 'closed'
  labels?: string[]
}

export interface GitHubRepositoryLabel extends GitHubIssueLabel {
  description: string | null
}

export interface LabelPageResult {
  items: GitHubRepositoryLabel[]
  nextPage?: number
  etag?: string
  notModified?: boolean
}

export type GitHubIssueConflict =
  | 'multiple-mapped-labels'
  | 'open-with-completion-label'
  | null

export interface GitHubIssueCardView extends GitHubIssue {
  columnId: string | null
  conflict: GitHubIssueConflict
  avatarDataUrls?: Record<string, string>
}

export interface GitHubIssueQuery {
  projectId: string
  columnId: string | null
  pageSize: number
  cursor?: string
  search?: string
  labelFilter?: string[]
}

export interface GitHubIssuePage {
  items: GitHubIssueCardView[]
  counts: Record<string, number>
  nextCursor?: string
  partial: boolean
  readOnly: boolean
  lastSuccessfulRefreshAt?: number
  lastFullReconciliationAt?: number
}

export type GitHubMutationResult =
  | { status: 'confirmed'; issue: GitHubIssue }
  | { status: 'refresh-pending'; issue: GitHubIssue }
  | { status: 'stale'; issue: GitHubIssue }
  | { status: 'configuration-changed' }
  | { status: 'invalid-target' }

export interface CreateMappedLabelsResult {
  status: 'confirmed' | 'configuration-changed'
  created: string[]
  remaining: string[]
}
