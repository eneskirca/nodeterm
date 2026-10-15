/**
 * Task 5.1 — local managed Codex account lifecycle: add (private 0700 home + shared-asset symlinks),
 * the device-login gate (a REAL non-symlink auth.json), and race/use-safe removal (Property 10).
 * Real filesystem under mkdtemp; only the electron shell, the app-server readers, the CLI lookup,
 * and the relay-root effect are faked.
 *
 * MUTATIONS (recorded in the PR body):
 *  - switch the login gate's `fs.lstat` to `fs.stat` (follows the symlink) ⇒ a symlinked credential
 *    pointed at the system jar counts as logged in ⇒ the symlink test reddens. (lstat is the
 *    load-bearing guard: under lstat a symlink's `isFile()` is already false; the explicit
 *    `!isSymbolicLink()` is belt-and-braces on top.)
 *  - drop the `removingCodexAccounts` in-progress guard ⇒ a concurrent removal is admitted ⇒ red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))
const readAccount = vi.fn(async () => ({ email: 'me@example.com' }))
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadAt: vi.fn(async () => null),
  readCodexAccountAt: (..._a: any[]) => readAccount()
}))
const findInLoginPath = vi.fn(async () => null)
vi.mock('../core/pty-manager', () => ({ findInLoginPath: (..._a: any[]) => findInLoginPath() }))
const ensureRelayRoot = vi.fn()
vi.mock('./codex-relay-daemon', () => ({ ensureCodexRelayRoot: ensureRelayRoot }))

import { IPC } from '../shared/ipc'
import { fakePlatform } from '../core/platform-fake'
import { codexAccountHome } from '../core/codex-accounts-core'

let userDataDir = ''
let systemHome = ''
const sender = { id: 1, isDestroyed: () => false, once: () => {}, removeListener: () => {} }
const call = (channel: string, ...args: any[]) => h.handlers[channel]({ sender }, ...args)

beforeEach(async () => {
  h.handlers = {}
  ensureRelayRoot.mockClear()
  findInLoginPath.mockClear()
  readAccount.mockReset().mockResolvedValue({ email: 'me@example.com' })
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-acct-'))
  systemHome = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-sys-'))
  // A system home with a shared, non-secret asset + directory to be symlinked into managed homes.
  writeFileSync(path.join(systemHome, 'config.toml'), 'model = "gpt"\n')
  mkdirSync(path.join(systemHome, 'skills'))
  process.env.CODEX_HOME = systemHome
  vi.resetModules()
  const { initPlatform } = await import('../core/platform')
  initPlatform(fakePlatform({ userDataDir }))
  const { initCodexAccounts } = await import('./codex-accounts')
  initCodexAccounts()
})
afterEach(async () => {
  const { resetPlatformForTests } = await import('../core/platform')
  resetPlatformForTests()
  delete process.env.CODEX_HOME
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(systemHome, { recursive: true, force: true })
})

describe('Codex local account lifecycle (Task 5.1)', () => {
  it('ensures the ~/.nodeterm relay root at boot (carried PR-4 obligation)', () => {
    // initCodexAccounts ran in beforeEach; the boot-time call to ensureCodexRelayRoot is asserted
    // here (not just the function itself) so removing the call site would red this.
    expect(ensureRelayRoot).toHaveBeenCalled()
  })

  it('add mints a 0700 home and symlinks the shared, non-secret runtime assets', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(home).toBe(codexAccountHome(userDataDir, id))
    if (process.platform !== 'win32') expect(lstatSync(home).mode & 0o777).toBe(0o700)
    // config.toml + skills are symlinks INTO the system home (installation shared, creds are not).
    expect(lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(lstatSync(path.join(home, 'skills')).isSymbolicLink()).toBe(true)
    // auth.json is NEVER symlinked in — a managed account acts only as its own login.
    expect(() => lstatSync(path.join(home, 'auth.json'))).toThrow()
  })

  it('the login gate returns the identity for a REAL non-symlink auth.json', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}')
    expect(await call(IPC.codexAccountsWaitLogin, id)).toEqual({ email: 'me@example.com' })
  })

  it('the login gate REFUSES a symlinked auth.json (Property 10 / §2.1)', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    // A credential that is a SYMLINK (e.g. pointed at the system jar) is not "logged in".
    const realCred = path.join(systemHome, 'auth.json')
    writeFileSync(realCred, '{"tokens":{}}')
    symlinkSync(realCred, path.join(home, 'auth.json'))
    const pending = call(IPC.codexAccountsWaitLogin, id) as Promise<unknown>
    // The first gate check SKIPS the symlink; cancelling makes the loop return null after its single
    // 2s poll sleep (real timers — deterministic, well under the test timeout) instead of the 5min
    // deadline. A gate that (wrongly) accepted the symlink would return the identity here.
    call(IPC.codexAccountsCancelWait, id)
    expect(await pending).toBeNull()
  }, 15_000)

  it('refuses a concurrent removal of the same account (Property 10)', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    expect(home).toBeTruthy()
    // Two removals launched back-to-back: the first synchronously claims the in-progress lock before
    // its first await, so the second is refused.
    const first = call(IPC.codexAccountsRemove, id) as Promise<void>
    await expect(call(IPC.codexAccountsRemove, id)).rejects.toThrow(/already in progress/)
    await expect(first).resolves.toBeUndefined()
  })

  it('rejects an unsafe account id before it becomes a path (supply-chain guard)', async () => {
    await expect(call(IPC.codexAccountsWaitLogin, '../escape')).rejects.toThrow(/Invalid Codex account id/)
    await expect(call(IPC.codexAccountsRemove, '../escape')).rejects.toThrow(/Invalid Codex account id/)
  })

  it('systemIdentity reads THIS Mac by default but fails closed for a remote projectId', async () => {
    // No ctx ⇒ this Mac's system login (the mocked app-server reader).
    await expect(call(IPC.codexAccountsSystemIdentity)).resolves.toEqual({ email: 'me@example.com' })
    // A remote `{ projectId }` request with no SSH manager to ask cannot be resolved, so it MUST
    // resolve null — never THIS Mac's identity (with a manager it asks the host: see
    // codex-accounts.remote.test.ts) (§5 "system-account discovery must not fabricate an account"; a
    // remote machine panel never borrows the local login).
    // MUTATION PIN: change the handler to return `accountIdentity()` for a remote projectId
    // (fail-OPEN) and this assertion reds.
    await expect(call(IPC.codexAccountsSystemIdentity, { projectId: 'proj-1' })).resolves.toBeNull()
  })
})

describe('Codex identity on a host with no reachable app-server (Windows)', () => {
  const jwt = (email: string): string =>
    ['h', Buffer.from(JSON.stringify({ email })).toString('base64url'), 's'].join('.')
  const authJson = (email: string): string => JSON.stringify({ tokens: { id_token: jwt(email) } })

  beforeEach(async () => {
    const { setCodexAccountsHostPlatformForTests } = await import('./codex-accounts')
    setCodexAccountsHostPlatformForTests('win32')
  })
  afterEach(async () => {
    const { setCodexAccountsHostPlatformForTests } = await import('./codex-accounts')
    setCodexAccountsHostPlatformForTests(null)
  })

  it('waitLogin resolves the auth.json JWT email with NO daemon start and NO socket read', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    writeFileSync(path.join(home, 'auth.json'), authJson('win@example.com'))
    expect(await call(IPC.codexAccountsWaitLogin, id)).toEqual({ email: 'win@example.com' })
    expect(await call(IPC.codexAccountsIdentity, id)).toEqual({ email: 'win@example.com' })
    expect(findInLoginPath).not.toHaveBeenCalled()
    expect(readAccount).not.toHaveBeenCalled()
  })

  it('a credential with no readable email still completes the login (email: null)', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}')
    expect(await call(IPC.codexAccountsWaitLogin, id)).toEqual({ email: null })
  })

  it.skipIf(process.platform === 'win32')('still REFUSES a symlinked auth.json', async () => {
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    const realCred = path.join(systemHome, 'auth.json')
    writeFileSync(realCred, authJson('system@example.com'))
    symlinkSync(realCred, path.join(home, 'auth.json'))
    expect(await call(IPC.codexAccountsIdentity, id)).toBeNull()
    const pending = call(IPC.codexAccountsWaitLogin, id) as Promise<unknown>
    call(IPC.codexAccountsCancelWait, id)
    expect(await pending).toBeNull()
  }, 15_000)

  it('the system identity reads the SYSTEM home\'s auth.json, and is null without one', async () => {
    expect(await call(IPC.codexAccountsSystemIdentity)).toBeNull()
    writeFileSync(path.join(systemHome, 'auth.json'), authJson('system@example.com'))
    expect(await call(IPC.codexAccountsSystemIdentity)).toEqual({ email: 'system@example.com' })
    expect(readAccount).not.toHaveBeenCalled()
  })

  it('a leg that NEEDS the app-server (transfer) fails at once with a named error — no daemon spawn', async () => {
    await expect(
      call(IPC.codexAccountsTransferThreadToSsh, 'thread-1', '/work', 'proj-1', undefined, undefined)
    ).rejects.toThrow(/not reachable on Windows/)
    expect(findInLoginPath).not.toHaveBeenCalled()
    expect(readAccount).not.toHaveBeenCalled()
  })

  it('POSIX keeps the app-server path (regression pin)', async () => {
    const { setCodexAccountsHostPlatformForTests } = await import('./codex-accounts')
    setCodexAccountsHostPlatformForTests('linux')
    const { id, home } = (await call(IPC.codexAccountsAdd)) as { id: string; home: string }
    writeFileSync(path.join(home, 'auth.json'), authJson('jwt@example.com'))
    expect(await call(IPC.codexAccountsWaitLogin, id)).toEqual({ email: 'me@example.com' })
    expect(readAccount).toHaveBeenCalled()
  })
})
