import type { Project } from '../../shared/types'
import type { CorePlatform } from '../platform'
import type { GitHubSecretStore, CommandRunner } from './credentials'
import { GitHubCredentialResolver } from './credentials'
import { GitHubControlStore } from './control-store'
import { GitHubIssuesClient } from './client'
import { GitHubIssueCache } from './cache'
import { GitHubRequestCoordinator } from './request-coordinator'
import { GitHubAvatarFetcher } from './avatar-fetcher'
import { GitHubHostController } from './host'
import { GitHubIssueService } from './service'
import { registerGitHubIssueHandlers } from './handlers'
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
  const validateToken = async (token: string) => {
    try {
      return await new GitHubIssuesClient({ token }).getAuthenticatedUser()
    } catch {
      return null
    }
  }
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
    client: (token) => new GitHubIssuesClient({ token }),
    onCredentialBoundaryChange: () => coordinator.cancelAll()
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
  return { controller, service }
}
