import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_CACHE_MS,
  GitHubCredentialResolver,
  type CommandRunner,
  type GitHubSecretStore
} from './credentials'
import type { GitHubAuthProvider } from '../../shared/github-issues'

function fixture(options: {
  gh?: 'valid' | 'invalid' | 'missing'
  storedToken?: string | null
  validTokens?: Record<string, string>
  storage?: GitHubSecretStore['availability']
}) {
  const calls: string[] = []
  const run: CommandRunner = async (_command, args) => {
    calls.push(args.join(' '))
    if (options.gh === 'missing') return { ok: false, stdout: '', stderr: 'not found' }
    if (args[1] === 'status') {
      return options.gh === 'valid'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'not logged in' }
    }
    return { ok: true, stdout: 'gh-token\n', stderr: '' }
  }
  const secret: GitHubSecretStore = {
    availability: options.storage ?? 'encrypted',
    readForHost: async () => options.storedToken ?? null,
    save: async () => undefined,
    clear: async () => undefined
  }
  const resolver = new GitHubCredentialResolver({
    run,
    secret,
    validate: async (token) => {
      const userId = options.validTokens?.[token]
      return userId ? { userId, login: `login-${userId}` } : null
    }
  })
  return { resolver, calls }
}

describe('GitHubCredentialResolver caching', () => {
  function counted(now: () => number) {
    let ghCalls = 0
    let validations = 0
    const run: CommandRunner = async (_command, args) => {
      ghCalls += 1
      if (args[1] === 'status') return { ok: true, stdout: '', stderr: '' }
      return { ok: true, stdout: 'gh-token\n', stderr: '' }
    }
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => null,
      save: async () => undefined,
      clear: async () => undefined
    }
    const resolver = new GitHubCredentialResolver({
      run,
      secret,
      validate: async () => {
        validations += 1
        return { userId: 'gh-user', login: 'octocat' }
      },
      now
    })
    return { resolver, counts: () => ({ ghCalls, validations }) }
  }

  it('resolves once for repeated calls inside the cache window', async () => {
    // Every epoch re-check in the service calls resolve(). Uncached, each one spawns two `gh`
    // processes AND spends a /user request that no rate-limit accounting can see.
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)

    await resolver.resolve('gh')
    const first = counts()
    expect(first.ghCalls).toBe(2)
    expect(first.validations).toBe(1)

    clock += 1_000
    await resolver.resolve('gh')
    await resolver.resolve('gh')
    expect(counts()).toEqual(first)

    clock += CREDENTIAL_CACHE_MS
    await resolver.resolve('gh')
    expect(counts().validations).toBe(2)
  })

  it('re-resolves immediately after the credential boundary moves', async () => {
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)
    await resolver.resolve('gh')
    expect(counts().validations).toBe(1)

    resolver.invalidate()

    await resolver.resolve('gh')
    expect(counts().validations).toBe(2)
  })

  it('caches each provider separately', async () => {
    let clock = 1_000
    const { resolver, counts } = counted(() => clock)
    await resolver.resolve('gh')
    await resolver.resolve('auto')
    expect(counts().validations).toBe(2)
  })
})

describe('GitHubCredentialResolver', () => {
  const providerCases = [
    ['auto', { gh: 'valid', storedToken: 'pat', validTokens: { 'gh-token': 'gh-user', pat: 'pat-user' } }, 'gh'],
    ['auto', { gh: 'invalid', storedToken: 'pat', validTokens: { pat: 'pat-user' } }, 'token'],
    ['gh', { gh: 'invalid', storedToken: 'pat', validTokens: { pat: 'pat-user' } }, null],
    ['token', { gh: 'valid', storedToken: 'bad', validTokens: { 'gh-token': 'gh-user' } }, null]
  ] satisfies Array<[GitHubAuthProvider, Parameters<typeof fixture>[0], 'gh' | 'token' | null]>

  it.each(providerCases)('uses the exact %s provider fallback rule', async (provider, options, expected) => {
    const { resolver } = fixture(options)
    expect((await resolver.resolve(provider))?.provider ?? null).toBe(expected)
  })

  it('does not read the stored token when GitHub CLI succeeds in auto mode', async () => {
    let secretReads = 0
    const secret: GitHubSecretStore = {
      availability: 'encrypted',
      readForHost: async () => { secretReads += 1; return 'pat' },
      save: async () => undefined,
      clear: async () => undefined
    }
    const resolver = new GitHubCredentialResolver({
      run: async (_command, args) => args[1] === 'status'
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: true, stdout: 'gh-token', stderr: '' },
      secret,
      validate: async () => ({ userId: '1', login: 'octocat' })
    })
    expect((await resolver.resolve('auto'))?.provider).toBe('gh')
    expect(secretReads).toBe(0)
  })

  it('returns presence and provider status without credential material', async () => {
    const { resolver } = fixture({
      gh: 'invalid',
      storedToken: 'super-secret-token',
      validTokens: { 'super-secret-token': 'pat-user' },
      storage: 'restricted-file'
    })
    const status = await resolver.status('auto')
    expect(status).toEqual({
      selectedProvider: 'auto',
      activeProvider: 'token',
      ghAuthenticated: false,
      tokenPresent: true,
      storage: 'restricted-file',
      login: 'login-pat-user'
    })
    expect(JSON.stringify(status)).not.toContain('super-secret-token')
  })

  it('validates GitHub CLI auth before asking it for a token', async () => {
    const { resolver, calls } = fixture({ gh: 'invalid', storedToken: null })
    await resolver.resolve('gh')
    expect(calls).toEqual(['auth status --hostname github.com'])
  })
})
