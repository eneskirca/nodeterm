import type {
  GitHubAuthProvider,
  GitHubAuthStatus,
  GitHubSecretAvailability
} from '../../shared/github-issues'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export type CommandResult = { ok: boolean; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

const execute = promisify(execFile)

export const runGitHubCliCommand: CommandRunner = async (command, args) => {
  if (command !== 'gh') return { ok: false, stdout: '', stderr: 'unsupported command' }
  try {
    const result = await execute(command, args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin${process.env.PATH ? `:${process.env.PATH}` : ''}`
      }
    })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr || failure.message || 'GitHub CLI failed'
    }
  }
}

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
  now?: () => number
}

/** How long one resolved credential is reused. The service re-checks its epoch before every read
 *  and around every write, and each check calls resolve() — which, uncached, spawns `gh auth
 *  status` + `gh auth token` AND spends a GET /user request. Those /user calls never pass through
 *  the request coordinator, so they are neither rate-limited nor backed off: a single full sync of
 *  a large repository could fire hundreds of them, trip GitHub's secondary limiter, and surface as
 *  "not authenticated" to a user who is signed in perfectly well. Short enough that an external
 *  `gh auth logout` is noticed promptly; every in-app credential change calls invalidate() instead
 *  of waiting for it. */
export const CREDENTIAL_CACHE_MS = 30_000

type CacheEntry = { at: number; value: ResolvedGitHubCredential | null }

export class GitHubCredentialResolver {
  private readonly cache = new Map<GitHubAuthProvider, CacheEntry>()
  private readonly now: () => number

  constructor(private readonly dependencies: ResolverDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  async resolve(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null> {
    const cached = this.cache.get(provider)
    const at = this.now()
    if (cached && at - cached.at < CREDENTIAL_CACHE_MS) return cached.value
    const value = await this.resolveUncached(provider)
    // A null answer is cached too: "gh is logged out" is exactly the state that would otherwise
    // re-spawn two processes on every epoch check of every failing refresh.
    this.cache.set(provider, { at, value })
    return value
  }

  /** Drop the memo the moment the credential boundary moves (token saved/cleared, provider
   *  switched, project revoked) so the next resolve reflects the new reality immediately. */
  invalidate(): void {
    this.cache.clear()
  }

  private async resolveUncached(provider: GitHubAuthProvider): Promise<ResolvedGitHubCredential | null> {
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
