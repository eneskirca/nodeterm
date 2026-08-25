/**
 * Task 5.3 — the SOURCE side of moving an idle local conversation to an SSH account. The remote
 * landing is PR 6; this leg validates STRICT source containment (a regular file under
 * `<sourceHome>/sessions/`, basename `<threadId>.jsonl`, no symlinked segment — reusing PR 3's
 * `planCodexRolloutExposure` guards) and only THEN hands the upload to the remote importer, with the
 * local rollout left untouched.
 *
 * MUTATION (recorded in the PR body): let the handler skip `planCodexRolloutExposure` and call the
 * importer with the raw source path ⇒ the escaping-source test admits the upload ⇒ red. The pin
 * below asserts the importer is NEVER called when the source escapes `sessions/`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => unknown) => (h.handlers[ch] = fn) }
}))
const readThread = vi.fn()
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadRollout: (..._a: any[]) => readThread(),
  readCodexAccountAt: vi.fn(async () => ({ email: 'me@example.com' }))
}))
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))
vi.mock('./codex-relay-daemon', () => ({ ensureCodexRelayRoot: vi.fn() }))

import { IPC } from '../shared/ipc'
import { fakePlatform } from '../core/platform-fake'
import { codexAccountHome } from '../core/codex-accounts-core'

const SOURCE = 'acctsource1'
const TARGET = 'accttarget1'
const THREAD = 'thread-abc123'
const PROJECT = 'proj-1'

let userDataDir = ''
let sourceHome = ''
const remoteCodexImportThread = vi.fn(async () => ({ imported: true }))
const sender = { id: 1, isDestroyed: () => false, once: () => {}, removeListener: () => {} }
const call = (channel: string, ...args: any[]) => h.handlers[channel]({ sender }, ...args)

beforeEach(async () => {
  h.handlers = {}
  readThread.mockReset()
  remoteCodexImportThread.mockClear()
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-xfer-'))
  sourceHome = codexAccountHome(userDataDir, SOURCE)
  mkdirSync(path.join(sourceHome, 'sessions', '2026'), { recursive: true })
  mkdirSync(codexAccountHome(userDataDir, TARGET), { recursive: true })
  vi.resetModules()
  const { initPlatform } = await import('../core/platform')
  initPlatform(fakePlatform({ userDataDir }))
  const { initCodexAccounts } = await import('./codex-accounts')
  // A live SSH manager carrying PR 6's importer.
  initCodexAccounts(() => ({ remoteCodexImportThread }) as any)
})
afterEach(async () => {
  const { resetPlatformForTests } = await import('../core/platform')
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('Codex local→SSH transfer source leg (Task 5.3)', () => {
  it('hands a contained source rollout to the remote importer with the sessions-relative path', async () => {
    const rollout = path.join(sourceHome, 'sessions', '2026', `rollout-${THREAD}.jsonl`)
    writeFileSync(rollout, '{}\n')
    readThread.mockResolvedValue({ id: THREAD, name: null, path: rollout })

    const res = (await call(
      IPC.codexAccountsTransferThreadToSsh,
      THREAD,
      '/work',
      PROJECT,
      TARGET,
      SOURCE
    )) as { threadId: string; imported: boolean }

    expect(res).toEqual({ threadId: THREAD, imported: true })
    expect(remoteCodexImportThread).toHaveBeenCalledTimes(1)
    const [projectId, targetAccountId, threadId, sessionsRelativePath, localPath] =
      remoteCodexImportThread.mock.calls[0] as unknown[]
    expect(projectId).toBe(PROJECT)
    expect(targetAccountId).toBe(TARGET)
    expect(threadId).toBe(THREAD)
    expect(sessionsRelativePath).toBe(`sessions/2026/rollout-${THREAD}.jsonl`)
    // The LOCAL rollout is handed by path, never moved.
    expect(localPath).toBe(rollout)
  })

  it('refuses a source path escaping sessions/ BEFORE any upload', async () => {
    // A rollout the app-server reports OUTSIDE the source account's sessions/ (e.g. a crafted
    // absolute path). Containment must refuse it before the importer is ever reached.
    const escaping = path.join(userDataDir, `rollout-${THREAD}.jsonl`)
    writeFileSync(escaping, '{}\n')
    readThread.mockResolvedValue({ id: THREAD, name: null, path: escaping })

    await expect(
      call(IPC.codexAccountsTransferThreadToSsh, THREAD, '/work', PROJECT, TARGET, SOURCE)
    ).rejects.toThrow()
    expect(remoteCodexImportThread).not.toHaveBeenCalled()
  })

  it('refuses a basename whose thread id does not match, before any upload', async () => {
    const wrong = path.join(sourceHome, 'sessions', '2026', 'rollout-someone-else.jsonl')
    writeFileSync(wrong, '{}\n')
    readThread.mockResolvedValue({ id: THREAD, name: null, path: wrong })
    await expect(
      call(IPC.codexAccountsTransferThreadToSsh, THREAD, '/work', PROJECT, TARGET, SOURCE)
    ).rejects.toThrow()
    expect(remoteCodexImportThread).not.toHaveBeenCalled()
  })

  it('rejects an unsafe thread id at the door', async () => {
    await expect(
      call(IPC.codexAccountsTransferThreadToSsh, '../escape', '/work', PROJECT, TARGET, SOURCE)
    ).rejects.toThrow(/Invalid Codex transfer request/)
    expect(remoteCodexImportThread).not.toHaveBeenCalled()
  })
})
