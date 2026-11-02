import type { GitHubPullBoard, GitHubPullChecksResult } from './github-pull-status'
import type { GitHubPullConversationResult, GitHubPullDetailResult } from './github-pull-detail'

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
  /** Digest of the column mapping this approval covers (repository + completion column + column
   *  labels — see `githubMappingDigest`). Board WRITES require it to match the mapping on disk;
   *  absent on an approval given before mappings were bound, which therefore allows reads only. */
  mappingDigest?: string
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
  /** Present when the sign-in could not be CHECKED — a network failure, a GitHub outage or a rate
   *  limit. It is not "signed out": the fields above keep the last answer GitHub gave for this
   *  token (or none, if it never gave one). `retryAt` is epoch ms, for a rate limit. */
  unreachable?: { reason: 'rate-limited' | 'unreachable'; retryAt?: number }
}

/** The GitHub request budget last reported for the active identity (`x-ratelimit-*`), `core`
 *  resource. `resetAt` / `observedAt` are epoch milliseconds. */
export interface GitHubRateStatus {
  resource: string
  limit: number
  remaining: number
  resetAt: number
  observedAt: number
}

/** Sync is held until `until` (epoch ms). `rate-limited`: GitHub refused, or the budget is spent —
 *  every request waits. `low-budget`: nodeterm is leaving the rest of the window to the user —
 *  only background polls wait; a refresh the user asks for still runs. */
export interface GitHubThrottle {
  until: number
  kind: 'rate-limited' | 'low-budget'
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
  /** `null` also stands for a reason GitHub added after this build (see `stateReasonFrom`). */
  stateReason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | null
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
  /**
   * Comma-separated label filter, passed straight to the REST list endpoint.
   *
   * The dedupe lookup for agent-filed reports uses THIS rather than the search API on purpose:
   * `/search/issues` is served from an index that lags its writes, so two agents hitting one gap a
   * minute apart would both search, both miss, and both file — the exact duplicate the fingerprint
   * exists to prevent. The list endpoint reads the database and is immediately consistent.
   */
  labels?: string
}

/** What `createIssue` needs. `labels` are names, and the caller ensures they exist first —
 *  GitHub creates an unknown label implicitly, with a random colour and no description. */
export interface CreateIssueInput {
  title: string
  body: string
  labels?: string[]
}

export interface IssuePageResult {
  items: GitHubIssue[]
  nextPage?: number
  etag?: string
  notModified?: boolean
}

/** `notModified` = GitHub answered 304 to the stored validator: nothing in the repository changed.
 *  `etag` is the validator to store for the next heartbeat (the one sent, on a 304). */
export interface IssueHeartbeatResult {
  notModified: boolean
  etag?: string
}

/** Why an issue is closed, as GitHub records it. A board close used to send none, so GitHub filed
 *  every one of them as `completed` — including the ones the user was dismissing. */
export type GitHubCloseReason = 'completed' | 'not_planned'

export interface UpdateIssueInput {
  state?: 'open' | 'closed'
  /** Sent only WITH a state change: a close reason on a close, `reopened` on a reopen. */
  stateReason?: GitHubCloseReason | 'reopened'
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
  /** The board is read only because this machine has not approved the column mapping now in the
   *  project file (it changed, or the approval predates mapping approval). */
  mappingNotApproved?: true
  /** Present while sync for this project's GitHub identity is held by the rate budget. */
  throttle?: GitHubThrottle
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
  /** The active identity's request budget, when a response has reported one this window. */
  rate?: GitHubRateStatus
  /** Present while sync for the active identity is held by the rate budget. */
  throttle?: GitHubThrottle
  project?: {
    projectId: string
    repository?: string
    detectedRepository?: string
    approved: boolean
    /** The approval also covers the column mapping now in the project file, so the board may
     *  write. False while approved means the mapping changed (or predates mapping approval). */
    mappingApproved?: boolean
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
    /** Used only when the move closes the issue; absent = `completed`, GitHub's own default. */
    closeReason?: GitHubCloseReason
  }): Promise<GitHubMutationResult>
  createMissingLabels(projectId: string): Promise<CreateMappedLabelsResult>
  clearCache(projectId: string): Promise<void>
  /** Pull request CI + mergeability, from memory (no request). */
  pullStatus(projectId: string): Promise<GitHubPullBoard>
  /** A VISIBLE board asks while some PR is undecided; the host decides whether a read is due (30 s,
   *  1 min, 2 min, then 5 min, at most 12 per episode) and answers whether it read. */
  chasePulls(projectId: string): Promise<boolean>
  /** Per-check detail for one PR — read only when its modal opens. */
  pullChecks(projectId: string, pullNumber: number): Promise<GitHubPullChecksResult>
  /** One PR's overview for the pull request node. Refused (no request) unless `repository` is the
   *  project's approved repository; answers from memory inside the 30 s refresh floor. */
  pullDetail(projectId: string, repository: string, pullNumber: number): Promise<GitHubPullDetailResult>
  /** One PR's comments and reviews, oldest first, for the node's Conversation tab. Same refusals
   *  and refresh floor as `pullDetail`. */
  pullConversation(projectId: string, repository: string, pullNumber: number): Promise<GitHubPullConversationResult>
  /** The one-time permission to move a session card because its linked PRs merged. The first ask
   *  across every window wins; the host remembers it. */
  claimPullAutoMove(request: { projectId: string; cardId: string; pulls: number[] }): Promise<boolean>
  /** "This card is waiting on these still-open PRs." The host keeps a note only for PRs it holds as
   *  open; a later claim for this card requires one. Answers how many notes were new. */
  notePullWaits(request: { projectId: string; cardId: string; pulls: number[] }): Promise<number>
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
