import type { Project } from '../../shared/types'
import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubControlState,
  GitHubControlView,
  GitHubRateStatus,
  GitHubThrottle
} from '../../shared/github-issues'
import { githubMappingDigest, normaliseProjectKanbanGitHub, parseGitHubRepository } from './config'
import type { GitHubSecretStore, ResolvedGitHubCredential, TokenValidation } from './credentials'
import { GitHubReachabilityError } from './failure'
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
    | 'configuration-changed'
    | 'revoked-cache-kept') {
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
    mappingDigest?: string
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
  isMappingApproved(state: GitHubControlState, input: {
    localApprovalId: string
    projectId: string
    repository: string
    mappingDigest: string
  }): boolean
}

type CredentialResolverLike = {
  resolve(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null>
  /** `userId` is the active credential's GitHub id — used here to find its rate budget, and
   *  stripped before the status leaves the host. */
  status(provider: GitHubAuthProvider): Promise<GitHubAuthStatus & { userId?: string }>
}

type HostDependencies = {
  project(projectId: string): Promise<ProjectRecord | null>
  detectRepository(project: Project): Promise<string | null>
  controls: ControlStoreLike
  resolver: CredentialResolverLike
  secret: GitHubSecretStore
  validateToken(token: string): Promise<TokenValidation>
  /** Builds the API client for a resolved credential. The identity comes with the token so the
   *  client can report every response's rate budget against the right account. */
  client(credential: { token: string; userId: string }): GitHubIssuesClientLike
  /** The request budget last seen for an identity, and why sync is held (if it is). */
  rate?(userId: string): { status?: GitHubRateStatus; throttle?: GitHubThrottle }
  onCredentialBoundaryChange?(): void
  /** Runs after a revoke is recorded: deletes this project's private issue cache from disk. */
  onRevoked?(projectId: string): Promise<void>
  /** An approval was given or withdrawn: the project's open boards must re-read (read only, the
   *  mapping approval) now, not at the next poll. */
  onApprovalChanged?(projectId: string): void
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
        ...this.authView(await this.dependencies.resolver.status(state.authProvider))
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
    // Only a VALID configuration has a mapping to approve; an invalid one keeps writes off anyway.
    const board = record.project.kanban
    const config = board?.github ? normaliseProjectKanbanGitHub(board.github, board.columns) : null
    const mappingApproved = approved && !!repository && !!config?.ok &&
      this.dependencies.controls.isMappingApproved(state, {
        localApprovalId: record.localApprovalId,
        projectId,
        repository,
        mappingDigest: githubMappingDigest(repository, config.value)
      })
    const authed = approved
      ? this.authView(await this.dependencies.resolver.status(state.authProvider))
      : {
          auth: {
            selectedProvider: state.authProvider,
            activeProvider: null,
            ghAuthenticated: false,
            tokenPresent: false,
            storage: this.dependencies.secret.availability
          }
        }
    return {
      control: { revision: state.revision, authProvider: state.authProvider },
      ...authed,
      project: {
        projectId,
        ...(repository ? { repository } : {}),
        ...(detected ? { detectedRepository: detected } : {}),
        approved,
        ...(approved ? { mappingApproved } : {})
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
    // The approval covers the column mapping as it is on disk NOW — what the user is looking at
    // when they click Approve. A later change to it (a pull, a teammate's commit) re-asks.
    await this.dependencies.controls.approve({
      ...input,
      localApprovalId: project.localApprovalId,
      repository: project.repository,
      mappingDigest: githubMappingDigest(project.repository, project.config)
    })
    this.dependencies.onApprovalChanged?.(input.projectId)
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
    // "Stop this computer from reading issues" must not leave what it already read behind: the
    // cache is plaintext JSON (issue bodies included) under userData. The revoke is recorded FIRST,
    // so a failed delete never leaves the machine approved — it is reported instead, and "Clear
    // cached data" (which needs no approval) remains the way to finish the job.
    try {
      await this.dependencies.onRevoked?.(input.projectId)
    } catch {
      throw new GitHubHostError('revoked-cache-kept')
    } finally {
      this.dependencies.onApprovalChanged?.(input.projectId)
    }
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
    const validation = await this.dependencies.validateToken(token)
    // Only GitHub refusing the token makes it invalid. When GitHub could not be asked, nothing is
    // saved either — an unchecked token is not stored — but the user is told why, not that the
    // token they pasted is wrong.
    if (validation.status === 'unauthorized') throw new GitHubHostError('invalid-token')
    if (validation.status === 'unknown') {
      throw new GitHubReachabilityError(
        validation.reason === 'rate-limited' ? 'rate-limited' : 'github-unreachable',
        validation.retryAt
      )
    }
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
      client: this.dependencies.client({ token: credential.token, userId: credential.userId })
    }
  }

  /** Splits the resolver's answer into the wire auth block (identity stripped) and the active
   *  identity's rate budget. */
  private authView(resolved: GitHubAuthStatus & { userId?: string }): Pick<
    GitHubControlView, 'auth' | 'rate' | 'throttle'
  > {
    const { userId, ...auth } = resolved
    const rate = userId ? this.dependencies.rate?.(userId) : undefined
    return {
      auth,
      ...(rate?.status ? { rate: rate.status } : {}),
      ...(rate?.throttle ? { throttle: rate.throttle } : {})
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
    return this.cacheProjectContext(project, state.revision, this.dependencies.controls.isMappingApproved(state, {
      localApprovalId: project.localApprovalId,
      projectId,
      repository: project.repository,
      mappingDigest: githubMappingDigest(project.repository, project.config)
    }))
  }

  async projectContextForCacheDeletion(projectId: string): Promise<GitHubIssueProjectContext> {
    const project = await this.resolveProject(projectId)
    const state = await this.dependencies.controls.load()
    // Deletion needs no approval at all, and certainly never writes to GitHub.
    return this.cacheProjectContext(project, state.revision, false)
  }

  private cacheProjectContext(
    project: ResolvedProject,
    controlRevision: number,
    mappingApproved: boolean
  ): GitHubIssueProjectContext {
    return {
      localApprovalId: project.localApprovalId,
      projectId: project.project.id,
      repository: project.repository,
      config: project.config,
      controlRevision,
      mappingApproved,
      project: project.project,
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
