import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import { isRecord } from '../../shared/is-record'
import type { GitHubRepoLabelsResult } from '../../shared/github-pull-sidebar'
import type {
  CreateMappedLabelsResult,
  GitHubCloseReason,
  GitHubIssuePage,
  GitHubIssueQuery,
  GitHubMutationResult
} from '../../shared/github-issues'
import type { GitHubPullBoard, GitHubPullChecksResult } from '../../shared/github-pull-status'
import type { GitHubPullCheckLogResult } from '../../shared/github-pull-check-log'
import type { GitHubPullTimelineResult } from '../../shared/github-pull-timeline'
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
import type { GitHubPullCommitFilesResult, GitHubPullCommitsResult } from '../../shared/github-pull-commits'
import type { GitHubPullSinceReviewResult } from '../../shared/github-pull-since-review'
import { isPullNoteId, parsePullNoteInput, type PullNotesStore } from './pull-notes-store'

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
  pullTimeline(
    request: { projectId: string; repository: string; pullNumber: number; after?: string }
  ): Promise<GitHubPullTimelineResult>
  pullFiles(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullFilesResult>
  pullFileContents(
    request: { projectId: string; repository: string; pullNumber: number; path: string }
  ): Promise<GitHubPullFileContentsResult>
  pullCommits(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullCommitsResult>
  pullCommitFiles(
    request: { projectId: string; repository: string; pullNumber: number; sha: string }
  ): Promise<GitHubPullCommitFilesResult>
  pullCommitFileContents(
    request: { projectId: string; repository: string; pullNumber: number; sha: string; path: string }
  ): Promise<GitHubPullFileContentsResult>
  pullSinceReview(request: { projectId: string; repository: string; pullNumber: number }): Promise<GitHubPullSinceReviewResult>
  pullSinceReviewFileContents(
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
  issueTimeline(
    request: { projectId: string; repository: string; issueNumber: number; after?: string }
  ): Promise<GitHubPullTimelineResult>
  commentOnIssue(request: { projectId: string; repository: string; issueNumber: number; body: string }): Promise<PullWriteResult>
  disablePullAutoMerge(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult>
  enablePullAutoMerge(request: { projectId: string; repository: string; pullNumber: number; method: PullMergeMethod; headSha: string }): Promise<PullWriteResult>
  updatePullBranch(request: { projectId: string; repository: string; pullNumber: number; headSha: string }): Promise<PullWriteResult>
  setFileViewed(request: { projectId: string; repository: string; pullNumber: number; path: string; viewed: boolean }): Promise<PullWriteResult>
  setReviewThreadResolved(request: { projectId: string; repository: string; pullNumber: number; threadId: number; resolved: boolean }): Promise<PullWriteResult>
  applySuggestion(request: { projectId: string; repository: string; pullNumber: number; headSha: string; commentId: number }): Promise<PullWriteResult>
  setPullLabels(request: { projectId: string; repository: string; pullNumber: number; label: string; add: boolean }): Promise<PullWriteResult>
  setPullAssignees(request: { projectId: string; repository: string; pullNumber: number; login: string; add: boolean }): Promise<PullWriteResult>
  setPullState(request: { projectId: string; repository: string; pullNumber: number; open: boolean }): Promise<PullWriteResult>
  markPullReady(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult>
  deleteHeadBranch(request: { projectId: string; repository: string; pullNumber: number }): Promise<PullWriteResult>
  pullCheckLog(request: { projectId: string; repository: string; pullNumber: number; jobId: number }): Promise<GitHubPullCheckLogResult>
  rerunFailedJobs(request: { projectId: string; repository: string; pullNumber: number; runId: number }): Promise<PullWriteResult>
  repoLabels(request: { projectId: string; repository: string }): Promise<GitHubRepoLabelsResult>
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
  platform.handle(IPC.githubIssuesPullTimeline,
    (projectId: string, repository: string, pullNumber: number, after?: string) =>
      service.pullTimeline({ projectId, repository, pullNumber, after }))
  platform.handle(IPC.githubIssuesPullFiles, (projectId: string, repository: string, pullNumber: number) =>
    service.pullFiles({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesPullFileContents,
    (projectId: string, repository: string, pullNumber: number, path: string) =>
      service.pullFileContents({ projectId, repository, pullNumber, path }))
  platform.handle(IPC.githubIssuesPullCommits, (projectId: string, repository: string, pullNumber: number) =>
    service.pullCommits({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesPullCommitFiles, (projectId: string, repository: string, pullNumber: number, sha: string) =>
    service.pullCommitFiles({ projectId, repository, pullNumber, sha }))
  platform.handle(IPC.githubIssuesPullCommitFileContents,
    (projectId: string, repository: string, pullNumber: number, sha: string, path: string) =>
      service.pullCommitFileContents({ projectId, repository, pullNumber, sha, path }))
  platform.handle(IPC.githubIssuesPullSinceReview, (projectId: string, repository: string, pullNumber: number) =>
    service.pullSinceReview({ projectId, repository, pullNumber }))
  platform.handle(IPC.githubIssuesPullSinceReviewFileContents,
    (projectId: string, repository: string, pullNumber: number, path: string) =>
      service.pullSinceReviewFileContents({ projectId, repository, pullNumber, path }))
  platform.handle(IPC.githubIssuesPullComment, (request) => service.commentOnPull(request))
  platform.handle(IPC.githubIssuesPullReview, (request) => service.reviewPull(request))
  platform.handle(IPC.githubIssuesPullMerge, (request) => service.mergePull(request))
  platform.handle(IPC.githubIssuesRepoMergeMethods, (projectId: string, repository: string) =>
    service.repoMergeMethods({ projectId, repository }))
  platform.handle(IPC.githubIssuesPullRequestReviewer, (request) => service.requestPullReviewer(request))
  platform.handle(IPC.githubIssuesPullLineComment, (request) => service.commentOnPullLine(request))
  platform.handle(IPC.githubIssuesIssueConversation, (projectId: string, repository: string, issueNumber: number) =>
    service.issueConversation({ projectId, repository, issueNumber }))
  platform.handle(IPC.githubIssuesIssueTimeline,
    (projectId: string, repository: string, issueNumber: number, after?: string) =>
      service.issueTimeline({ projectId, repository, issueNumber, after }))
  platform.handle(IPC.githubIssuesIssueComment, (request) => service.commentOnIssue(request))
  platform.handle(IPC.githubIssuesPullAutoMergeOff, (request) => service.disablePullAutoMerge(request))
  platform.handle(IPC.githubIssuesPullAutoMerge, (request) => service.enablePullAutoMerge(request))
  platform.handle(IPC.githubIssuesPullUpdateBranch, (request) => service.updatePullBranch(request))
  platform.handle(IPC.githubIssuesPullFileViewed, (request) => service.setFileViewed(request))
  platform.handle(IPC.githubIssuesPullThreadResolved, (request) => service.setReviewThreadResolved(request))
  platform.handle(IPC.githubIssuesPullApplySuggestion, (request) => service.applySuggestion(request))
  platform.handle(IPC.githubIssuesPullLabels, (request) => service.setPullLabels(request))
  platform.handle(IPC.githubIssuesPullAssignees, (request) => service.setPullAssignees(request))
  platform.handle(IPC.githubIssuesPullState, (request) => service.setPullState(request))
  platform.handle(IPC.githubIssuesPullReady, (request) => service.markPullReady(request))
  platform.handle(IPC.githubIssuesPullDeleteBranch, (request) => service.deleteHeadBranch(request))
  platform.handle(IPC.githubIssuesPullCheckLog, (projectId: string, repository: string, pullNumber: number, jobId: number) =>
    service.pullCheckLog({ projectId, repository, pullNumber, jobId }))
  platform.handle(IPC.githubIssuesPullRerunFailed, (request) => service.rerunFailedJobs(request))
  platform.handle(IPC.githubIssuesRepoLabels, (projectId: string, repository: string) =>
    service.repoLabels({ projectId, repository }))
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

/** Notes for agents (F-07). Every input is checked here; a bad one throws and writes nothing. */
export function registerPullNoteHandlers(platform: CorePlatform, store: Pick<PullNotesStore, 'list' | 'add' | 'remove'>): void {
  const bad = (): never => { throw new Error('invalid-note-input') }
  const pullOf = (request: unknown): { repository: string; pullNumber: number } => {
    const r = (isRecord(request) ? request : {}) as { repository?: unknown; pullNumber?: unknown }
    return typeof r.repository === 'string' && typeof r.pullNumber === 'number'
      ? { repository: r.repository, pullNumber: r.pullNumber } : bad()
  }
  platform.handle(IPC.pullNotesList, (repository: unknown, pullNumber: unknown) => {
    const pull = pullOf({ repository, pullNumber })
    return store.list(pull.repository, pull.pullNumber)
  })
  platform.handle(IPC.pullNotesAdd, (input: unknown) => store.add(parsePullNoteInput(input) ?? bad()))
  platform.handle(IPC.pullNotesDelete, (request: { id?: unknown }) => {
    const pull = pullOf(request)
    return isPullNoteId(request.id) ? store.remove(pull.repository, pull.pullNumber, [request.id]) : bad()
  })
  platform.handle(IPC.pullNotesClear, (request: { ids?: unknown }) => {
    const pull = pullOf(request)
    const ids = request.ids
    if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 500 && ids.every(isPullNoteId))) bad()
    return store.remove(pull.repository, pull.pullNumber, ids as string[] | undefined)
  })
}
