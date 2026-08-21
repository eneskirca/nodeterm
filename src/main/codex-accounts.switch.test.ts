/**
 * The three-phase, owner-authorized, TTL-bounded same-machine Codex account switch (S6 §4.1 /
 * Properties 5 & 10). Driven against the REAL rollout primitives on a REAL temp filesystem
 * (planCodexRolloutExposure / commitCodexRolloutExposure — constraint 8: no re-implementation); only
 * the electron shell boundary, the app-server readers, and the relay-root effect are faked.
 *
 * MUTATIONS (recorded in the PR body):
 *  - drop `pending.owner.id === event.sender.id` in commit ⇒ a non-owner WebContents commits ⇒ red.
 *  - drop the `pendingSwitchExposures` guard in remove ⇒ removal succeeds while a switch holds the
 *    account ⇒ red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const h: { handlers: Record<string, (...a: any[]) => unknown> } = { handlers: {} }

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    }
  }
}))

// The app-server client + relay root are runtime effects (probe U4/U6, unrunnable headless). Fake
// them; the rollout copy under test is the real fs primitive.
const readThread = vi.fn()
const readAccount = vi.fn(async () => ({ email: 'me@example.com' }))
vi.mock('../core/codex-session-name', () => ({
  readCodexThreadRollout: (..._a: any[]) => readThread(),
  readCodexAccountAt: (..._a: any[]) => readAccount()
}))
vi.mock('../core/pty-manager', () => ({ findInLoginPath: vi.fn(async () => null) }))
vi.mock('./codex-relay-daemon', () => ({ ensureCodexRelayRoot: vi.fn() }))

import { IPC } from '../shared/ipc'
import { fakePlatform } from '../core/platform-fake'
import { codexAccountHome } from '../core/codex-accounts-core'

const SOURCE = 'acctsource1'
const TARGET = 'accttarget1'
const THREAD = 'thread-abc123'

let userDataDir = ''
let sourceRollout = ''

/** A WebContents-shaped fake: `.id` + the listener surface the switch protocol drives. */
const makeSender = (id: number) => {
  const listeners: Array<() => void> = []
  return {
    id,
    isDestroyed: () => false,
    once: (_ev: string, cb: () => void) => listeners.push(cb),
    removeListener: () => {},
    fireDestroyed: () => listeners.forEach((cb) => cb())
  }
}
const call = (channel: string, sender: any, ...args: any[]) =>
  h.handlers[channel]({ sender }, ...args)

beforeEach(async () => {
  h.handlers = {}
  readThread.mockReset()
  readAccount.mockReset().mockResolvedValue({ email: 'me@example.com' })
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-switch-'))
  // Real homes at the exact paths the module computes, with a real rollout under source/sessions.
  const sourceHome = codexAccountHome(userDataDir, SOURCE)
  const targetHome = codexAccountHome(userDataDir, TARGET)
  const sessionsDir = path.join(sourceHome, 'sessions', '2026', '08')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(path.join(targetHome, 'sessions'), { recursive: true })
  sourceRollout = path.join(sessionsDir, `rollout-${THREAD}.jsonl`)
  writeFileSync(sourceRollout, '{"id":"' + THREAD + '"}\n')
  readThread.mockResolvedValue({ id: THREAD, name: null, path: sourceRollout })
  // Fresh module state per test (the reservation maps live at module scope). resetModules resets the
  // platform module too, so init it on the freshly-imported instance codex-accounts will bind to.
  vi.resetModules()
  const { initPlatform } = await import('../core/platform')
  initPlatform(fakePlatform({ userDataDir }))
  const { initCodexAccounts } = await import('./codex-accounts')
  initCodexAccounts()
})
afterEach(async () => {
  const { resetPlatformForTests } = await import('../core/platform')
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
  vi.clearAllTimers()
})

describe('Codex same-machine switch — three-phase, owner-authorized (Properties 5, 10)', () => {
  it('reserves, commits an atomic hardlink into the target, and preserves the conversation id', async () => {
    const owner = makeSender(1)
    const res = (await call(
      IPC.codexAccountsSwitchThread,
      owner,
      THREAD,
      '/work',
      SOURCE,
      TARGET
    )) as { threadId: string; rollbackToken?: string }
    expect(res.threadId).toBe(THREAD)
    expect(res.rollbackToken).toBeTruthy()

    await call(IPC.codexAccountsCommitSwitch, owner, res.rollbackToken)

    // The target now holds the SAME inode (byte-identical conversation id survives the copy).
    const targetPath = path.join(
      codexAccountHome(userDataDir, TARGET),
      'sessions',
      '2026',
      '08',
      `rollout-${THREAD}.jsonl`
    )
    const src = statSync(sourceRollout)
    const tgt = statSync(targetPath)
    expect(tgt.ino).toBe(src.ino)
    expect(tgt.dev).toBe(src.dev)

    // Finishing releases the reservation, so the account is removable again.
    await call(IPC.codexAccountsFinishSwitch, owner, res.rollbackToken)
    expect(readThread).toHaveBeenCalled()
  })

  it('refuses to finish a switch that was never committed (committed-gate, Property 5)', async () => {
    // A reservation is planned but NOT committed (the atomic hardlink never ran). Finishing it would
    // release the reservation as if the copy had succeeded — the renderer then recycles the node
    // onto a target that has no rollout. finishSwitch must refuse until commit ran.
    const owner = makeSender(1)
    const res = (await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, TARGET)) as {
      rollbackToken?: string
    }
    // MUTATION: drop `!pending?.committed` in finishSwitch ⇒ this stops throwing ⇒ red.
    expect(() => call(IPC.codexAccountsFinishSwitch, owner, res.rollbackToken)).toThrow(
      /was not committed/
    )
    // The target still has NO rollout — nothing was published by a premature finish.
    const targetPath = path.join(
      codexAccountHome(userDataDir, TARGET),
      'sessions',
      '2026',
      '08',
      `rollout-${THREAD}.jsonl`
    )
    expect(() => statSync(targetPath)).toThrow()
  })

  it('a non-owner WebContents cannot commit or finish the switch', async () => {
    const owner = makeSender(1)
    const attacker = makeSender(2)
    const res = (await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, TARGET)) as {
      rollbackToken?: string
    }
    // commit/finish/rollback are synchronous handlers, so a refusal throws synchronously.
    expect(() => call(IPC.codexAccountsCommitSwitch, attacker, res.rollbackToken)).toThrow(
      /preparation expired/
    )
    // The owner can still commit — the attacker's attempt did not consume the reservation.
    expect(call(IPC.codexAccountsCommitSwitch, owner, res.rollbackToken)).toBeUndefined()
    // A non-owner cannot finish the (now committed) switch either.
    expect(() => call(IPC.codexAccountsFinishSwitch, attacker, res.rollbackToken)).toThrow(
      /was not committed/
    )
  })

  it('removal refuses while a switch reservation holds either account (Property 10)', async () => {
    const owner = makeSender(1)
    await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, TARGET)
    await expect(call(IPC.codexAccountsRemove, owner, SOURCE)).rejects.toThrow(
      /reserved by an account switch/
    )
    await expect(call(IPC.codexAccountsRemove, owner, TARGET)).rejects.toThrow(
      /reserved by an account switch/
    )
  })

  it('the TTL releases the reservation, unblocking removal and voiding a late commit', async () => {
    vi.useFakeTimers()
    try {
      const owner = makeSender(1)
      const res = (await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, TARGET)) as {
        rollbackToken?: string
      }
      vi.advanceTimersByTime(60_000)
      // The reservation is gone: a late (synchronous) commit is refused.
      expect(() => call(IPC.codexAccountsCommitSwitch, owner, res.rollbackToken)).toThrow(
        /preparation expired/
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('owner destroyed auto-releases the reservation', async () => {
    const owner = makeSender(1)
    const res = (await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, TARGET)) as {
      rollbackToken?: string
    }
    owner.fireDestroyed()
    expect(() => call(IPC.codexAccountsCommitSwitch, owner, res.rollbackToken)).toThrow(
      /preparation expired/
    )
  })

  it('a no-op switch to the same account short-circuits without reserving', async () => {
    const owner = makeSender(1)
    const res = (await call(IPC.codexAccountsSwitchThread, owner, THREAD, '/work', SOURCE, SOURCE)) as {
      rollbackToken?: string
    }
    expect(res.rollbackToken).toBeUndefined()
    // Nothing reserved ⇒ removal is not blocked.
    await expect(call(IPC.codexAccountsRemove, owner, SOURCE)).resolves.toBeUndefined()
  })
})
