import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import type {
  CreateMappedLabelsResult,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubLookupRequest,
  GitHubLookupResult,
  GitHubMutationResult,
  GitHubPullsForBranchResult,
  GitHubSearchRequest,
  GitHubSearchResult
} from '../../shared/github-issues'

export interface GitHubIssueHandlerService {
  subscribe(uiId: number, request: { projectId: string }): Promise<GitHubIssuePage>
  unsubscribe(uiId: number, projectId: string): void
  query(request: GitHubIssueQuery): Promise<GitHubIssuePage>
  lookup(request: GitHubLookupRequest): Promise<GitHubLookupResult>
  search(request: GitHubSearchRequest): Promise<GitHubSearchResult>
  pullsForBranch(request: {
    projectId: string
    branch: string
    force?: boolean
  }): Promise<GitHubPullsForBranchResult>
  refresh(request: { projectId: string; full?: boolean }): Promise<void>
  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
  }): Promise<GitHubMutationResult>
  createMissingLabels(request: { projectId: string }): Promise<CreateMappedLabelsResult>
  clearCache(request: { projectId: string }): Promise<void>
}

export function registerGitHubIssueHandlers(
  platform: CorePlatform,
  service: GitHubIssueHandlerService
): void {
  platform.handleWithSender(IPC.githubIssuesSubscribe, (uiId, request: { projectId: string }) =>
    service.subscribe(uiId, request))
  platform.onWithSender(IPC.githubIssuesUnsubscribe, (uiId, projectId: string) =>
    service.unsubscribe(uiId, projectId))
  platform.handle(IPC.githubIssuesQuery, (request: GitHubIssueQuery) => service.query(request))
  platform.handle(IPC.githubIssuesLookup, (request: GitHubLookupRequest) => service.lookup(request))
  platform.handle(IPC.githubIssuesSearch, (request: GitHubSearchRequest) => service.search(request))
  platform.handle(IPC.githubIssuesPullsForBranch,
    (request: { projectId: string; branch: string; force?: boolean }) =>
      service.pullsForBranch(request))
  platform.handle(IPC.githubIssuesRefresh, (projectId: string, full?: boolean) =>
    service.refresh({ projectId, full }))
  platform.handle(IPC.githubIssuesMove, (request) => service.moveIssue(request))
  platform.handle(IPC.githubIssuesCreateLabels, (projectId: string) =>
    service.createMissingLabels({ projectId }))
  platform.handle(IPC.githubIssuesClearCache, (projectId: string) =>
    service.clearCache({ projectId }))
}
