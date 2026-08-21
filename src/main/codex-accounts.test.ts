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
  readCodexThreadRollout: vi.fn(async () => null),
  readCodexAccountAt: (..._a: any[]) => readAccount()
}))
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))
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
    // A remote `{ projectId }` request cannot be resolved by this build, so it MUST resolve null —
    // never THIS Mac's identity (§5 "system-account discovery must not fabricate an account"; a
    // remote machine panel never borrows the local login).
    // MUTATION PIN: change the handler to return `accountIdentity()` for a remote projectId
    // (fail-OPEN) and this assertion reds.
    await expect(call(IPC.codexAccountsSystemIdentity, { projectId: 'proj-1' })).resolves.toBeNull()
  })
})
