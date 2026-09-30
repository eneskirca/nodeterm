// Issue #783: a host that loses `listen` to a still-busy endpoint keeps its startup lock and
// retries for up to two minutes. The client must WAIT while that is happening — its old 4.5 s
// budget left every node that mounted in the window on a permanent "could not be started" until
// the user clicked Try again — and must stop waiting the moment nothing is starting any more.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const launcherMocks = vi.hoisted(() => ({
  resolveSessionHostScript: vi.fn(() => 'fake-session-host.cjs'),
  spawnSessionHost: vi.fn()
}))
const identityMocks = vi.hoisted(() => ({
  readExistingSessionHostIdentity: vi.fn(),
  startupLockState: vi.fn(() => 'other' as string),
  LISTEN_RETRY_BUDGET_MS: 120_000,
  EMPTY_LOCK_STALE_MS: 15_000
}))

vi.mock('./session-host-launcher', () => launcherMocks)
vi.mock('../session-host/existing-host-state', () => identityMocks)

import { SessionHostClient } from './session-host-client'
import { testTmpDir } from './test-tmp'

const emptyLock = (): never => {
  throw new Error('invalid session-host state: file is empty')
}

const tempDir = (): string => testTmpDir('nt-host-wait-')

beforeEach(() => {
  vi.clearAllMocks()
  launcherMocks.resolveSessionHostScript.mockReturnValue('fake-session-host.cjs')
})

describe('SessionHostClient waits for a host that is still starting', () => {
  it('keeps polling well past the ordinary budget while the lock is being heartbeated', async () => {
    identityMocks.readExistingSessionHostIdentity.mockImplementation(emptyLock)
    // 'starting' for the first 45 reads — i.e. past the 30-attempt budget — then nothing is
    // starting any more and the wait must end.
    identityMocks.startupLockState.mockImplementation(() =>
      identityMocks.readExistingSessionHostIdentity.mock.calls.length < 45 ? 'starting' : 'other'
    )

    await expect(new SessionHostClient({ userDataDir: tempDir() }).listSessions()).rejects.toThrow(
      'file is empty'
    )
    // Proof it did not stop at 30: the ordinary budget would have given up long before this.
    expect(identityMocks.readExistingSessionHostIdentity.mock.calls.length).toBeGreaterThan(40)
  }, 30_000)

  it('does not spawn a second host while one is starting', async () => {
    identityMocks.readExistingSessionHostIdentity.mockImplementation(emptyLock)
    identityMocks.startupLockState.mockImplementation(() =>
      identityMocks.readExistingSessionHostIdentity.mock.calls.length < 35 ? 'starting' : 'other'
    )

    await expect(
      new SessionHostClient({ userDataDir: tempDir() }).listSessions()
    ).rejects.toThrow()
    expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled()
  }, 30_000)

  it('fails fast, exactly as before, when nothing is starting', async () => {
    identityMocks.readExistingSessionHostIdentity.mockImplementation(emptyLock)
    identityMocks.startupLockState.mockReturnValue('other')

    await expect(new SessionHostClient({ userDataDir: tempDir() }).listSessions()).rejects.toThrow(
      'file is empty'
    )
    // Unchanged behaviour: an empty lock nobody is heartbeating is an integrity failure, reported
    // after the small pre-launch batch — no host is launched and nothing waits on it.
    expect(identityMocks.readExistingSessionHostIdentity.mock.calls.length).toBeLessThanOrEqual(6)
    expect(launcherMocks.spawnSessionHost).not.toHaveBeenCalled()
  }, 30_000)
})
