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
  | 'label-too-long'
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

/** The PR-only facts the issues endpoint carries for a pull request item, normalised. Its
 *  presence on a `GitHubIssue` is the discriminator: GitHub returns pull requests from
 *  `/repos/{repo}/issues`, and only those items have a `pull_request` object (an issue item
 *  carries no `draft` key at all). */
export interface GitHubPullMeta {
  draft: boolean
  /** ISO stamp when the PR merged, else null — the only thing separating merged from
   *  closed-unmerged, both of which report `state: 'closed'`. */
  mergedAt: string | null
  /** Head branch. NOT in the issues list payload; filled by a targeted per-branch read. */
  head?: string
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
  /** Present iff this item is a pull request. */
  pull?: GitHubPullMeta
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
  /** Which kind of item to page. Absent = `'issue'`, so a caller that predates pull requests
   *  gets exactly the page it always got. */
  kind?: 'issue' | 'pull'
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
  | { status: 'read-only' }
  | { status: 'invalid-target' }
  | { status: 'failed'; message: string }

export interface CreateMappedLabelsResult {
  status: 'confirmed' | 'configuration-changed' | 'read-only' | 'partial'
  created: string[]
  remaining: string[]
}

export interface GitHubControlView {
  control: {
    revision: number
    authProvider: GitHubAuthProvider
  }
  auth: GitHubAuthStatus
  project?: {
    projectId: string
    repository?: string
    detectedRepository?: string
    approved: boolean
  }
}

export interface GitHubIssuesApi {
  subscribe(projectId: string): Promise<GitHubIssuePage>
  unsubscribe(projectId: string): Promise<void>
  query(request: GitHubIssueQuery): Promise<GitHubIssuePage>
  refresh(projectId: string, full?: boolean): Promise<void>
  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<GitHubMutationResult>
  createMissingLabels(projectId: string): Promise<CreateMappedLabelsResult>
  clearCache(projectId: string): Promise<void>
  onChanged(projectId: string, listener: (changedIssueNumbers: number[]) => void): () => void
  /** Resolve the project's GitHub org/user avatar (owner derived host-side from the project's own
   *  origin — never a caller-supplied slug). Null when the project has no GitHub origin or the
   *  avatar cannot be fetched. */
  projectAvatar(projectId: string): Promise<{ dataUrl: string } | null>
}

export interface GitHubControlApi {
  status(projectId?: string): Promise<GitHubControlView>
  approve(input: { projectId: string; repository: string; expectedRevision: number }): Promise<GitHubControlView>
  revoke(input: { projectId: string; expectedRevision: number }): Promise<GitHubControlView>
  selectProvider(input: { provider: GitHubAuthProvider; expectedRevision: number }): Promise<GitHubControlView>
  saveToken(token: string): Promise<GitHubControlView>
  clearToken(): Promise<GitHubControlView>
}
