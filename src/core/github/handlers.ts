import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import type {
  CreateMappedLabelsResult,
  GitHubCloseReason,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubMutationResult
} from '../../shared/github-issues'
import type { GitHubPullBoard, GitHubPullChecksResult } from '../../shared/github-pull-status'
import type { GitHubPullConversationResult, GitHubPullDetailResult } from '../../shared/github-pull-detail'

export interface GitHubIssueHandlerService {
  subscribe(uiId: number, request: { projectId: string }): Promise<GitHubIssuePage>
  unsubscribe(uiId: number, projectId: string): void
  query(request: GitHubIssueQuery): Promise<GitHubIssuePage>
  refresh(request: { projectId: string; full?: boolean }): Promise<void>
  moveIssue(request: {
    projectId: string
    issueNumber: number
    toColumnId: string | null
    expectedUpdatedAt: string
    closeReason?: GitHubCloseReason
  }): Promise<GitHubMutationResult>
  createMissingLabels(request: { projectId: string }): Promise<CreateMappedLabelsResult>
  clearCache(request: { projectId: string }): Promise<void>
  pullStatus(request: { projectId: string }): Promise<GitHubPullBoard>
  chasePulls(request: { projectId: string }): Promise<boolean>
  pullChecks(request: { projectId: string; pullNumber: number }): Promise<GitHubPullChecksResult>
  pullDetail(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullDetailResult>
  pullConversation(
    request: { projectId: string; repository: string; pullNumber: number }
  ): Promise<GitHubPullConversationResult>
  claimPullAutoMove(request: { projectId: string; cardId: string; pulls: number[] }): Promise<boolean>
  notePullWaits(request: { projectId: string; cardId: string; pulls: number[] }): Promise<number>
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
  platform.handle(IPC.githubIssuesRefresh, (projectId: string, full?: boolean) =>
    service.refresh({ projectId, full }))
  platform.handle(IPC.githubIssuesMove, (request) => service.moveIssue(request))
  platform.handle(IPC.githubIssuesCreateLabels, (projectId: string) =>
    service.createMissingLabels({ projectId }))
  platform.handle(IPC.githubIssuesClearCache, (projectId: string) =>
    service.clearCache({ projectId }))
  platform.handle(IPC.githubIssuesPullStatus, (projectId: string) =>
    service.pullStatus({ projectId }))
  platform.handle(IPC.githubIssuesChasePulls, (projectId: string) =>
    service.chasePulls({ projectId }))
  platform.handle(IPC.githubIssuesPullChecks, (projectId: string, pullNumber: number) =>
    service.pullChecks({ projectId, pullNumber }))
  platform.handle(IPC.githubIssuesPullDetail, (projectId: string, repository: string, pullNumber: number) =>
    service.pullDetail({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesPullConversation, (projectId: string, repository: string, pullNumber: number) =>
    service.pullConversation({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesClaimPullAutoMove,
    (request: { projectId: string; cardId: string; pulls: number[] }) => service.claimPullAutoMove(request))
  platform.handle(IPC.githubIssuesNotePullWaits,
    (request: { projectId: string; cardId: string; pulls: number[] }) => service.notePullWaits(request))
}
