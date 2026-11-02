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
import type {
  GitHubPullConversationResult,
  GitHubIssueConversationResult,
  GitHubPullDetailResult,
  GitHubPullFileContentsResult,
  GitHubPullFilesResult,
  GitHubRepoCollaboratorsResult,
  GitHubPullForBranchResult,
  PullCreateDraft,
  PullCreateResult,
  GitHubRepoMergeMethodsResult,
  PullLineCommentRequest,
  PullLineDraft,
  PullMergeMethod,
  PullReviewEvent,
  PullWriteResult
} from '../../shared/github-pull-detail'

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
  pullFiles(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullFilesResult>
  pullFileContents(
    request: { projectId: string; repository: string; pullNumber: number; path: string }
  ): Promise<GitHubPullFileContentsResult>
  commentOnPull(
    request: { projectId: string; repository: string; pullNumber: number; body: string }
  ): Promise<PullWriteResult>
  reviewPull(request: {
    projectId: string; repository: string; pullNumber: number; event: PullReviewEvent; body: string; headSha: string
    comments?: PullLineDraft[]
  }): Promise<PullWriteResult>
  commentOnPullLine(request: PullLineCommentRequest): Promise<PullWriteResult>
  issueConversation(request: { projectId: string; repository: string; issueNumber: number }): Promise<GitHubIssueConversationResult>
  commentOnIssue(request: { projectId: string; repository: string; issueNumber: number; body: string }): Promise<PullWriteResult>
  disablePullAutoMerge(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult>
  enablePullAutoMerge(request: { projectId: string; repository: string; pullNumber: number; method: PullMergeMethod; headSha: string }): Promise<PullWriteResult>
  updatePullBranch(request: { projectId: string; repository: string; pullNumber: number; headSha: string }): Promise<PullWriteResult>
  mergePull(request: {
    projectId: string; repository: string; pullNumber: number; method: PullMergeMethod; headSha: string
  }): Promise<PullWriteResult>
  repoMergeMethods(request: { projectId: string; repository: string }): Promise<GitHubRepoMergeMethodsResult>
  repoCollaborators(request: { projectId: string; repository: string }): Promise<GitHubRepoCollaboratorsResult>
  requestPullReviewer(
    request: { projectId: string; repository: string; pullNumber: number; reviewer: string }
  ): Promise<PullWriteResult>
  pullForBranch(request: { projectId: string; repository: string; head: string }): Promise<GitHubPullForBranchResult>
  createPull(request: { projectId: string; repository: string } & PullCreateDraft): Promise<PullCreateResult>
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
  platform.handle(IPC.githubIssuesPullFiles, (projectId: string, repository: string, pullNumber: number) =>
    service.pullFiles({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesPullFileContents,
    (projectId: string, repository: string, pullNumber: number, path: string) =>
      service.pullFileContents({ projectId, repository, pullNumber, path }))
  platform.handle(IPC.githubIssuesPullComment, (request) => service.commentOnPull(request))
  platform.handle(IPC.githubIssuesPullReview, (request) => service.reviewPull(request))
  platform.handle(IPC.githubIssuesPullMerge, (request) => service.mergePull(request))
  platform.handle(IPC.githubIssuesRepoMergeMethods, (projectId: string, repository: string) =>
    service.repoMergeMethods({ projectId, repository }))
  platform.handle(IPC.githubIssuesPullRequestReviewer, (request) => service.requestPullReviewer(request))
  platform.handle(IPC.githubIssuesPullLineComment, (request) => service.commentOnPullLine(request))
  platform.handle(IPC.githubIssuesIssueConversation, (projectId: string, repository: string, issueNumber: number) =>
    service.issueConversation({ projectId, repository, issueNumber }))
  platform.handle(IPC.githubIssuesIssueComment, (request) => service.commentOnIssue(request))
  platform.handle(IPC.githubIssuesPullAutoMergeOff, (request) => service.disablePullAutoMerge(request))
  platform.handle(IPC.githubIssuesPullAutoMerge, (request) => service.enablePullAutoMerge(request))
  platform.handle(IPC.githubIssuesPullUpdateBranch, (request) => service.updatePullBranch(request))
  platform.handle(IPC.githubIssuesRepoCollaborators, (projectId: string, repository: string) =>
    service.repoCollaborators({ projectId, repository }))
  platform.handle(IPC.githubIssuesPullForBranch, (projectId: string, repository: string, head: string) =>
    service.pullForBranch({ projectId, repository, head }))
  platform.handle(IPC.githubIssuesPullCreate, (request) => service.createPull(request))
  platform.handle(IPC.githubIssuesClaimPullAutoMove,
    (request: { projectId: string; cardId: string; pulls: number[] }) => service.claimPullAutoMove(request))
  platform.handle(IPC.githubIssuesNotePullWaits,
    (request: { projectId: string; cardId: string; pulls: number[] }) => service.notePullWaits(request))
}
