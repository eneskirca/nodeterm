import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubSecretAvailability
} from '../../shared/github-issues'

export type CommandResult = { ok: boolean; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export interface GitHubSecretStore {
  readonly availability: GitHubSecretAvailability
  readForHost(): Promise<string | null>
  save(token: string): Promise<void>
  clear(): Promise<void>
}

export interface ValidatedGitHubIdentity {
  userId: string
  login: string
}

export interface ResolvedGitHubCredential extends ValidatedGitHubIdentity {
  provider: 'gh' | 'token'
  token: string
}

type ResolverDependencies = {
  run: CommandRunner
  secret: GitHubSecretStore
  validate(token: string): Promise<ValidatedGitHubIdentity | null>
}

export class GitHubCredentialResolver {
  constructor(private readonly dependencies: ResolverDependencies) {}

  async resolve(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null> {
    if (provider === 'gh') return this.fromGitHubCli()
    if (provider === 'token') return this.fromStoredToken()
    return (await this.fromGitHubCli()) ?? this.fromStoredToken()
  }

  async status(provider: GitHubAuthProvider): Promise<GitHubAuthStatus> {
    const gh = await this.fromGitHubCli()
    const stored = await this.dependencies.secret.readForHost()
    const tokenIdentity = stored ? await this.dependencies.validate(stored) : null
    const active = provider === 'gh'
      ? gh
      : provider === 'token'
        ? tokenIdentity && stored ? { ...tokenIdentity, provider: 'token' as const, token: stored } : null
        : gh ?? (tokenIdentity && stored
          ? { ...tokenIdentity, provider: 'token' as const, token: stored }
          : null)
    return {
      selectedProvider: provider,
      activeProvider: active?.provider ?? null,
      ghAuthenticated: gh !== null,
      tokenPresent: stored !== null,
      storage: this.dependencies.secret.availability,
      ...(active ? { login: active.login } : {})
    }
  }

  private async fromGitHubCli(): Promise<ResolvedGitHubCredential | null> {
    const status = await this.dependencies.run('gh', ['auth', 'status', '--hostname', 'github.com'])
    if (!status.ok) return null
    const result = await this.dependencies.run('gh', ['auth', 'token', '--hostname', 'github.com'])
    const token = result.ok ? result.stdout.trim() : ''
    if (!token) return null
    const identity = await this.dependencies.validate(token)
    return identity ? { ...identity, provider: 'gh', token } : null
  }

  private async fromStoredToken(): Promise<ResolvedGitHubCredential | null> {
    const token = await this.dependencies.secret.readForHost()
    if (!token) return null
    const identity = await this.dependencies.validate(token)
    return identity ? { ...identity, provider: 'token', token } : null
  }
}
