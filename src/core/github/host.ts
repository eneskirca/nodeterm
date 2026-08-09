import type { Project } from '../../shared/types'
import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubControlState,
  GitHubControlView
} from '../../shared/github-issues'
import { normaliseProjectKanbanGitHub, parseGitHubRepository } from './config'
import type { GitHubSecretStore, ResolvedGitHubCredential } from './credentials'
import type {
  GitHubIssueProjectContext,
  GitHubIssueServiceContext,
  GitHubIssuesClientLike
} from './service'

export class GitHubHostError extends Error {
  constructor(readonly code:
    | 'project-not-found'
    | 'invalid-configuration'
    | 'repository-not-found'
    | 'repository-mismatch'
    | 'not-approved'
    | 'not-authenticated'
    | 'invalid-token'
    | 'configuration-changed') {
    super(code)
  }
}

type ProjectRecord = { project: Project; localApprovalId: string }

type ControlStoreLike = {
  load(): Promise<GitHubControlState>
  approve(input: {
    expectedRevision: number
    localApprovalId: string
    projectId: string
    repository: string
  }): Promise<GitHubControlState>
  revoke(input: { expectedRevision: number; localApprovalId: string }): Promise<GitHubControlState>
  selectProvider(input: {
    expectedRevision: number
    provider: GitHubAuthProvider
  }): Promise<GitHubControlState>
  isApproved(state: GitHubControlState, input: {
    localApprovalId: string
    projectId: string
    repository: string
  }): boolean
}

type CredentialResolverLike = {
  resolve(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null>
  status(provider: GitHubAuthProvider): Promise<GitHubAuthStatus>
}

type HostDependencies = {
  project(projectId: string): Promise<ProjectRecord | null>
  detectRepository(project: Project): Promise<string | null>
  controls: ControlStoreLike
  resolver: CredentialResolverLike
  secret: GitHubSecretStore
  validateToken(token: string): Promise<{ userId: string; login: string } | null>
  client(token: string): GitHubIssuesClientLike
  onCredentialBoundaryChange?(): void
}

type ResolvedProject = ProjectRecord & {
  repository: string
  detectedRepository?: string
  config: GitHubIssueServiceContext['config']
}

export class GitHubHostController {
  private credentialGeneration = 0

  constructor(private readonly dependencies: HostDependencies) {}

  async status(projectId?: string): Promise<GitHubControlView> {
    const state = await this.dependencies.controls.load()
    if (!projectId) {
      return {
        control: { revision: state.revision, authProvider: state.authProvider },
        auth: await this.dependencies.resolver.status(state.authProvider)
      }
    }

    const record = await this.dependencies.project(projectId)
    if (!record) throw new GitHubHostError('project-not-found')
    const detected = parseGitHubRepository(await this.dependencies.detectRepository(record.project)) ?? undefined
    const configured = record.project.kanban?.github?.repository
      ? parseGitHubRepository(record.project.kanban.github.repository) ?? undefined
      : undefined
    const repository = configured ?? detected
    const approved = !!repository && this.dependencies.controls.isApproved(state, {
      localApprovalId: record.localApprovalId,
      projectId,
      repository
    })
    const auth = approved
      ? await this.dependencies.resolver.status(state.authProvider)
      : {
          selectedProvider: state.authProvider,
          activeProvider: null,
          ghAuthenticated: false,
          tokenPresent: false,
          storage: this.dependencies.secret.availability
        }
    return {
      control: { revision: state.revision, authProvider: state.authProvider },
      auth,
      project: {
        projectId,
        ...(repository ? { repository } : {}),
        ...(detected ? { detectedRepository: detected } : {}),
        approved
      }
    }
  }

  async approve(input: {
    projectId: string
    repository: string
    expectedRevision: number
  }): Promise<GitHubControlView> {
    const project = await this.resolveProject(input.projectId)
    if (parseGitHubRepository(input.repository) !== project.repository) {
      throw new GitHubHostError('repository-mismatch')
    }
    await this.dependencies.controls.approve({
      ...input,
      localApprovalId: project.localApprovalId,
      repository: project.repository
    })
    return this.status(input.projectId)
  }

  async revoke(input: { projectId: string; expectedRevision: number }): Promise<GitHubControlView> {
    const record = await this.dependencies.project(input.projectId)
    if (!record) throw new GitHubHostError('project-not-found')
    await this.dependencies.controls.revoke({
      expectedRevision: input.expectedRevision,
      localApprovalId: record.localApprovalId
    })
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status(input.projectId)
  }

  async selectProvider(input: {
    provider: GitHubAuthProvider
    expectedRevision: number
  }): Promise<GitHubControlView> {
    await this.dependencies.controls.selectProvider(input)
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status()
  }

  async saveToken(token: string): Promise<GitHubControlView> {
    const identity = await this.dependencies.validateToken(token)
    if (!identity) throw new GitHubHostError('invalid-token')
    await this.dependencies.secret.save(token)
    this.credentialGeneration += 1
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status()
  }

  async clearToken(): Promise<GitHubControlView> {
    await this.dependencies.secret.clear()
    this.credentialGeneration += 1
    this.dependencies.onCredentialBoundaryChange?.()
    return this.status()
  }

  async contextForProject(projectId: string): Promise<GitHubIssueServiceContext> {
    const project = await this.projectContextForCache(projectId)
    const state = await this.dependencies.controls.load()
    if (state.revision !== project.controlRevision) {
      throw new GitHubHostError('configuration-changed')
    }
    const credential = await this.dependencies.resolver.resolve(state.authProvider)
    if (!credential) throw new GitHubHostError('not-authenticated')
    return {
      ...project,
      credentialGeneration: this.credentialGeneration,
      userId: credential.userId,
      client: this.dependencies.client(credential.token)
    }
  }

  async projectContextForCache(projectId: string): Promise<GitHubIssueProjectContext> {
    const project = await this.resolveProject(projectId)
    const state = await this.dependencies.controls.load()
    if (!this.dependencies.controls.isApproved(state, {
      localApprovalId: project.localApprovalId,
      projectId,
      repository: project.repository
    })) throw new GitHubHostError('not-approved')
    return this.cacheProjectContext(project, state.revision)
  }

  async projectContextForCacheDeletion(projectId: string): Promise<GitHubIssueProjectContext> {
    const project = await this.resolveProject(projectId)
    const state = await this.dependencies.controls.load()
    return this.cacheProjectContext(project, state.revision)
  }

  private cacheProjectContext(
    project: ResolvedProject,
    controlRevision: number
  ): GitHubIssueProjectContext {
    return {
      localApprovalId: project.localApprovalId,
      projectId: project.project.id,
      repository: project.repository,
      config: project.config,
      controlRevision,
      columnColors: Object.fromEntries(
        (project.project.kanban?.columns ?? []).map((column) => [column.id, column.color])
      )
    }
  }

  private async resolveProject(projectId: string): Promise<ResolvedProject> {
    const record = await this.dependencies.project(projectId)
    if (!record) throw new GitHubHostError('project-not-found')
    const board = record.project.kanban
    if (!board?.github) throw new GitHubHostError('invalid-configuration')
    const config = normaliseProjectKanbanGitHub(board.github, board.columns)
    if (!config.ok) throw new GitHubHostError('invalid-configuration')
    const detected = parseGitHubRepository(await this.dependencies.detectRepository(record.project)) ?? undefined
    const repository = config.value.repository ?? detected
    if (!repository) throw new GitHubHostError('repository-not-found')
    return {
      ...record,
      repository,
      ...(detected ? { detectedRepository: detected } : {}),
      config: config.value
    }
  }
}
