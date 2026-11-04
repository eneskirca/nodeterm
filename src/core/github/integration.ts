import type { Project } from '../../shared/types'
import type { CorePlatform } from '../platform'
import type { GitHubSecretStore, CommandRunner } from './credentials'
import { createTokenValidator, GitHubCredentialResolver } from './credentials'
import { GitHubControlStore } from './control-store'
import { GitHubIssuesClient } from './client'
import { GitHubIssueCache } from './cache'
import { GitHubRequestCoordinator } from './request-coordinator'
import { GitHubAvatarFetcher } from './avatar-fetcher'
import { resolveProjectAvatarForProject } from './project-avatar'
import { GitHubHostController } from './host'
import { GitHubIssueService } from './service'
import { registerGitHubIssueHandlers, registerPullNoteHandlers } from './handlers'
import { PullNotesStore } from './pull-notes-store'
import { IPC } from '../../shared/ipc'

type Dependencies = {
  platform: CorePlatform
  userDataDir: string
  project(projectId: string): Promise<{ project: Project; localApprovalId: string } | null>
  detectRepository(project: Project): Promise<string | null>
  secret: GitHubSecretStore
  run: CommandRunner
}

export function registerGitHubIntegration(dependencies: Dependencies): {
  controller: GitHubHostController
  service: GitHubIssueService
} {
  // Tri-state and conditional (see createTokenValidator): a failed check is no longer a null that
  // every caller reads as "signed out", and an unchanged identity re-validates with a free 304.
  const validateToken = createTokenValidator((token, etag) =>
    new GitHubIssuesClient({ token }).checkAuthenticatedUser(etag))
  const controls = new GitHubControlStore(dependencies.userDataDir)
  const coordinator = new GitHubRequestCoordinator()
  const resolver = new GitHubCredentialResolver({
    run: dependencies.run,
    secret: dependencies.secret,
    validate: validateToken
  })
  const controller = new GitHubHostController({
    project: dependencies.project,
    detectRepository: dependencies.detectRepository,
    controls,
    resolver,
    secret: dependencies.secret,
    validateToken,
    client: ({ token, userId }) => new GitHubIssuesClient({
      token,
      onRateLimit: (sample) => coordinator.noteRateSample(userId, sample)
    }),
    rate: (userId) => ({
      status: coordinator.rateStatus(userId),
      throttle: coordinator.throttle(userId)
    }),
    // Both halves of a credential boundary move: stop work that captured the old credential, and
    // drop the resolver's memo so the next resolve reflects the change immediately instead of
    // serving a revoked credential until its TTL happens to lapse.
    onCredentialBoundaryChange: () => {
      coordinator.cancelAll()
      resolver.invalidate()
    },
    // `service` is declared below; this only runs on a revoke, long after both exist.
    onRevoked: (projectId) => service.clearCache({ projectId }),
    onApprovalChanged: (projectId) => service.notifyProject(projectId)
  })
  const service = new GitHubIssueService({
    cache: new GitHubIssueCache(dependencies.userDataDir),
    coordinator,
    contextForProject: (projectId) => controller.contextForProject(projectId),
    projectContextForCache: (projectId) => controller.projectContextForCache(projectId),
    projectContextForCacheDeletion: (projectId) => controller.projectContextForCacheDeletion(projectId),
    avatarFetcher: new GitHubAvatarFetcher(),
    onDelta: (uiId, projectId, changedIssueNumbers) =>
      dependencies.platform.sendTo(uiId, IPC.githubIssuesChanged(projectId), changedIssueNumbers)
  })
  registerGitHubIssueHandlers(dependencies.platform, service)
  registerPullNoteHandlers(dependencies.platform, new PullNotesStore(dependencies.userDataDir))

  // Project org/user avatar. The handler receives only a projectId: it derives the owner host-side
  // from the project's own GitHub origin (a renderer never supplies a slug/owner) and resolves a
  // token via the shared credential resolver. Independent of kanban approval — an avatar is public —
  // and never throws: any failure (no origin, no auth, fetch failed, SSH host unreachable) is null.
  dependencies.platform.handle(IPC.githubProjectAvatar, async (projectId: string) => {
    try {
      const record = await dependencies.project(projectId)
      if (!record) return null
      const state = await controls.load()
      const credential = await resolver.resolve(state.authProvider)
      return await resolveProjectAvatarForProject({
        project: record.project,
        detectRepository: dependencies.detectRepository,
        token: credential?.token
      })
    } catch {
      return null
    }
  })

  return { controller, service }
}
