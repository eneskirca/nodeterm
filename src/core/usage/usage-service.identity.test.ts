import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { fetchUsage } from './usage-service'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { registerClaudeAccountsSource, resetClaudeAccountsSourceForTests } from '../claude-config-dir'

const { keychain } = vi.hoisted(() => ({ keychain: vi.fn() }))
vi.mock('child_process', () => ({ execFile: keychain }))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return { ...actual, promises: { ...actual.promises, readFile: vi.fn() } }
})
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>()
  return { ...actual, default: { ...actual, homedir: () => '/fixture-home' } }
})

const token = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', email: 'same@example.test' } })
const identity = (name: string) => JSON.stringify({ oauthAccount: {
  emailAddress: 'same@example.test', organizationName: name,
  organizationUuid: `id-${name}`, organizationType: 'claude_team',
  organizationRateLimitTier: 'default_raven'
} })
let files: Record<string, string>

beforeEach(() => {
  initPlatform(fakePlatform({ userDataDir: '/fixture-data' }))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  files = { '/fixture-home/.claude/.credentials.json': token, '/fixture-home/.claude.json': identity('Personal') }
  vi.mocked(fs.readFile).mockImplementation(async (file) => {
    const raw = files[String(file)]
    if (raw === undefined) throw new Error('fixture missing')
    return raw
  })
  keychain.mockReset()
  keychain.mockImplementation((_cmd, _args, cb) => cb(new Error('fixture missing')))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ five_hour: { utilization: 12 } }))))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetClaudeAccountsSourceForTests()
  resetPlatformForTests()
})

describe('active Claude organization', () => {
  it('reads the identity even when credentials already supply email; refresh follows a same-email org switch', async () => {
    expect(await fetchUsage()).toMatchObject({ email: 'same@example.test', organization: { name: 'Personal', rateLimitTier: 'default_raven' } })
    files['/fixture-home/.claude.json'] = identity('Team')
    expect(await fetchUsage()).toMatchObject({ organization: { name: 'Team' }, status: 'ok' })
  })
  it.each(['missing', '{broken', 'null', '{}', '{"oauthAccount":{"organizationName":42}}'])('fails softly for identity %s', async (raw) => {
    if (raw === 'missing') delete files['/fixture-home/.claude.json']
    else files['/fixture-home/.claude.json'] = raw
    const u = await fetchUsage()
    expect(u).toMatchObject({ email: 'same@example.test', status: 'ok', session: { leftPercent: 88 } })
    expect(u.organization).toBeUndefined()
  })
  it('does not attribute a different email’s metadata to the token', async () => {
    files['/fixture-home/.claude.json'] = identity('Wrong').replace('same@example.test', 'other@example.test')
    expect((await fetchUsage()).organization).toBeUndefined()
  })
  it('uses each managed or linked account’s identity without falling back to the system file', async () => {
    registerClaudeAccountsSource(() => [{ id: 'linked', label: 'Linked', createdAt: 0, configDir: '/fixture-linked' }])
    for (const [id, dir] of [['managed', '/fixture-data/claude-accounts/managed'], ['linked', '/fixture-linked']]) {
      files[`${dir}/.credentials.json`] = token
      files[`${dir}/.claude.json`] = identity(id)
      expect((await fetchUsage(id)).organization?.name).toBe(id)
      delete files[`${dir}/.claude.json`]
      expect((await fetchUsage(id)).organization).toBeUndefined()
    }
  })
  it('reads org metadata with a Keychain email on macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    keychain.mockImplementation((_cmd, _args, cb) => cb(null, { stdout: token, stderr: '' }))
    expect((await fetchUsage()).organization?.name).toBe('Personal')
  })
  it('never combines managed identity with an unscoped system Keychain token', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    keychain.mockImplementation((_cmd, args, cb) => args.includes('Claude Code-credentials') ? cb(null, { stdout: token, stderr: '' }) : cb(new Error('no scoped entry')))
    files['/fixture-data/claude-accounts/team/.claude.json'] = identity('Team')
    expect(await fetchUsage('team')).toMatchObject({ status: 'unavailable' })
    expect(fetch).not.toHaveBeenCalled()
    expect(keychain).toHaveBeenCalledTimes(1)
  })
})

it('falls back to the managed credentials FILE after a scoped Keychain miss', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  files['/fixture-data/claude-accounts/team/.credentials.json'] = token
  files['/fixture-data/claude-accounts/team/.claude.json'] = identity('Team')
  expect(await fetchUsage('team')).toMatchObject({ status: 'ok', organization: { name: 'Team' } })
  expect(keychain).toHaveBeenCalledTimes(1)
})
it('preserves email backfill and drops malformed optional fields', async () => {
  files['/fixture-home/.claude/.credentials.json'] = '{"accessToken":"fixture-token"}'
  files['/fixture-home/.claude.json'] = JSON.stringify({ oauthAccount: {
    emailAddress: 'backfill@example.test', organizationName: '  Team  ',
    organizationUuid: 1, organizationType: [], organizationRateLimitTier: '  '
  } })
  const u = await fetchUsage()
  expect(u.email).toBe('backfill@example.test')
  expect(u.organization).toEqual({ name: 'Team', uuid: undefined, type: undefined, rateLimitTier: undefined })
})
it('does not advertise stale organization metadata without credentials', async () => {
  delete files['/fixture-home/.claude/.credentials.json']
  expect(await fetchUsage()).toMatchObject({ status: 'unavailable' })
  expect((await fetchUsage()).organization).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
it('preserves resolved identity when usage fetch fails', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('fixture offline'))
  expect(await fetchUsage()).toMatchObject({ status: 'error', email: 'same@example.test', organization: { name: 'Personal' } })
})
