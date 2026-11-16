import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'

/**
 * A `requireRemote` create must never JOIN a live session that is not on the remote it names.
 *
 * `join()` used to match on `persistKey` alone, so an SSH-project node (the card modal, or the
 * canvas after "Open here anyway") attached to a live LOCAL session that happened to carry the same
 * node id — a hosted team tab's node mounted under the local session, or a pre-`requireRemote`
 * orphan. The refusal in `spawnNew` never ran, because nothing was spawned: the join answered
 * first. Now the join is refused (`'held-elsewhere'`) when the held session is local, or is on a
 * different endpoint than the create's `sshRemote`; the held session itself is never touched.
 */
interface FakePty {
  file: string
  args: string[]
  killed: boolean
}
const spawned: FakePty[] = []

// Pin the persistence backend (see src/core/__fixtures__/no-session-host.ts).
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const p: FakePty = { file, args: [...(args ?? [])], killed: false }
    spawned.push(p)
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {
        p.killed = true
      },
      pid: 4321
    }
  }
}))

// A machine with pty devices to spare, always (same reason as pty-require-remote.test.ts).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// A REMOTE held session needs `findSsh` to resolve (the spawn's remote branch is skipped without
// it), and the agent-socket probe would run a real `ssh -G`. Every other lookup is the real one.
vi.mock('./exec-path', async (importOriginal) => {
  const real = await importOriginal<typeof import('./exec-path')>()
  return {
    ...real,
    findExecutableSync: (bin: string, fallbacks?: string[]) =>
      bin === 'ssh' ? '/usr/bin/ssh' : real.findExecutableSync(bin, fallbacks)
  }
})
vi.mock('./remote-ssh/agent-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote-ssh/agent-probe')>()),
  probeAgentSockToPin: async () => undefined
}))

const RENDERER = 1
const MODAL_OR_SECOND_VIEW = 2
const NODE = 'term-musuoygd-979507b8'

type SshRemote = NonNullable<PtyCreateOptions['sshRemote']>

let pathSeq = 0
/** A fresh ControlMaster path per test: the remote spawn gate is module-wide and keyed by it. */
const remoteFor = (conn: SshRemote['conn']): SshRemote => ({
  controlPath: `/tmp/nt-test-cm-join-${++pathSeq}`,
  conn,
  remoteCwd: '~/proj-alpha'
})

describe('requireRemote create vs a live session of the same node id', () => {
  let fake: FakePlatform
  let manager: import('./pty-manager').PtyManager
  let warn: MockInstance<typeof console.warn>

  beforeEach(async () => {
    spawned.length = 0
    fake = fakePlatform()
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    manager = new PtyManager()
    manager.registerIpc()
    // The remote freshness read would run `ssh … tmux list-sessions` over the master: answered
    // "absent" here, so a remote create spawns its (mocked) ssh client without touching a host.
    vi.spyOn(
      manager as unknown as { remoteSessionVerdict: () => Promise<string> },
      'remoteSessionVerdict'
    ).mockResolvedValue('absent')
    // A join that does not resize paints the joiner from a capture — over ssh for a remote session.
    // Nothing here is about the screen, so no real ssh is ever run for it.
    const paint = manager as unknown as {
      captureForResync: (s: string) => Promise<string>
      paneCursor: (s: string) => Promise<unknown>
    }
    vi.spyOn(paint, 'captureForResync').mockResolvedValue('')
    vi.spyOn(paint, 'paneCursor').mockResolvedValue(undefined)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  const create = (clientId: number, options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](clientId, {
      cols: 80,
      rows: 24,
      persistKey: NODE,
      ...options
    }) as Promise<PtyCreateResult>

  const subscribersOf = (sessionId: string): number =>
    (manager as unknown as { sessions: Map<string, { subscribers: Set<unknown> }> }).sessions.get(sessionId)!
      .subscribers.size

  const warnedAbout = (): unknown[][] => warn.mock.calls.filter((c) => String(c[0]).includes(NODE))

  /** The hosted team tab's node mounted under the LOCAL session: no sshRemote, no requireRemote. */
  async function localHeld(): Promise<PtyCreateResult> {
    const local = await create(RENDERER, { agentId: 'claude', cwd: '/home/e2e/proj-alpha' })
    expect(local.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].file.endsWith('ssh')).toBe(false) // the LOCAL branch, never ssh
    return local
  }

  it('refuses to join a LOCAL session for a requireRemote create', async () => {
    const local = await localHeld()
    const res = await create(MODAL_OR_SECOND_VIEW, {
      agentId: 'claude',
      cwd: '~/proj-alpha',
      requireRemote: true,
      sshRemote: remoteFor({ host: 'h.example', user: 'e2e', port: 22 })
    })

    expect(res.unavailable).toBe('held-elsewhere')
    expect(res.sessionId).toBe('')
    expect(spawned).toHaveLength(1) // nothing spawned remotely either
    // Refused BEFORE subscribing: the held session gained no second view, and was never killed.
    expect(subscribersOf(local.sessionId)).toBe(1)
    expect(spawned[0].killed).toBe(false)
    expect(warnedAbout()).toHaveLength(1)
  })

  it('refuses the same join when the master is momentarily down (no sshRemote)', async () => {
    const local = await localHeld()
    const res = await create(MODAL_OR_SECOND_VIEW, { agentId: 'claude', requireRemote: true })

    expect(res.unavailable).toBe('held-elsewhere')
    expect(res.sessionId).toBe('')
    expect(spawned).toHaveLength(1)
    expect(subscribersOf(local.sessionId)).toBe(1)
    expect(spawned[0].killed).toBe(false)
  })

  it('warns once for the held session, however often the refused join is retried', async () => {
    // A caller may retry a refused join on a backoff, and each retry is refused the same way: one
    // warning for the held session, not one per retry.
    const local = await localHeld()
    const retry = () => create(MODAL_OR_SECOND_VIEW, { agentId: 'claude', requireRemote: true })
    const results = [await retry(), await retry(), await retry()]

    expect(results.map((r) => r.unavailable)).toEqual(['held-elsewhere', 'held-elsewhere', 'held-elsewhere'])
    expect(warnedAbout()).toHaveLength(1)
    expect(subscribersOf(local.sessionId)).toBe(1)
  })

  it('a create WITHOUT requireRemote still joins the local session (local nodes unchanged)', async () => {
    const local = await localHeld()
    const res = await create(MODAL_OR_SECOND_VIEW, { agentId: 'claude', cwd: '/home/e2e/proj-alpha' })

    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).toBe(local.sessionId)
    expect(spawned).toHaveLength(1)
    expect(subscribersOf(local.sessionId)).toBe(2)
    expect(warnedAbout()).toHaveLength(0)
  })

  describe('a held REMOTE session', () => {
    const HOST = { host: 'h.example', user: 'e2e' } // port left to the `?? 22` default

    async function remoteHeld(): Promise<PtyCreateResult> {
      const first = await create(RENDERER, {
        agentId: 'claude',
        requireRemote: true,
        sshRemote: remoteFor(HOST)
      })
      expect(first.unavailable).toBeUndefined()
      expect(first.sessionId).not.toBe('')
      expect(spawned).toHaveLength(1)
      expect(spawned[0].file).toBe('/usr/bin/ssh') // the REMOTE branch
      return first
    }

    it('is refused to a requireRemote create whose master names a DIFFERENT host', async () => {
      const first = await remoteHeld()
      const res = await create(MODAL_OR_SECOND_VIEW, {
        agentId: 'claude',
        requireRemote: true,
        sshRemote: remoteFor({ ...HOST, host: 'other.example' })
      })

      expect(res.unavailable).toBe('held-elsewhere')
      expect(res.sessionId).toBe('')
      expect(spawned).toHaveLength(1)
      expect(subscribersOf(first.sessionId)).toBe(1)
      expect(spawned[0].killed).toBe(false)
      expect(warnedAbout()).toHaveLength(1)
    })

    it('is refused when only the user or only the port differs', async () => {
      const first = await remoteHeld()
      const otherUser = await create(MODAL_OR_SECOND_VIEW, {
        requireRemote: true,
        sshRemote: remoteFor({ ...HOST, user: 'someone-else' })
      })
      const otherPort = await create(MODAL_OR_SECOND_VIEW, {
        requireRemote: true,
        sshRemote: remoteFor({ ...HOST, port: 2222 })
      })

      expect(otherUser.unavailable).toBe('held-elsewhere')
      expect(otherPort.unavailable).toBe('held-elsewhere')
      expect(spawned).toHaveLength(1)
      expect(subscribersOf(first.sessionId)).toBe(1)
    })

    it('joins when one side names no user and the other an empty one', async () => {
      // `user` is typed as a string but arrives from hand-editable JSON, so a create can carry none
      // at all while the held session spells it ''. Both mean "ssh's default user": same endpoint.
      // (The other way round cannot be held: a spawn refuses a user that is not a string.)
      const first = await create(RENDERER, {
        agentId: 'claude',
        requireRemote: true,
        sshRemote: remoteFor({ host: HOST.host, user: '' })
      })
      expect(first.unavailable).toBeUndefined()
      expect(spawned).toHaveLength(1)
      expect(spawned[0].file).toBe('/usr/bin/ssh')

      const res = await create(MODAL_OR_SECOND_VIEW, {
        agentId: 'claude',
        requireRemote: true,
        sshRemote: remoteFor({ host: HOST.host, user: undefined as unknown as string, port: 22 })
      })

      expect(res.unavailable).toBeUndefined()
      expect(res.sessionId).toBe(first.sessionId)
      expect(spawned).toHaveLength(1)
      expect(subscribersOf(first.sessionId)).toBe(2)
      expect(warnedAbout()).toHaveLength(0)
    })

    it('joins on the same host, user and port (an unset port is 22)', async () => {
      const first = await remoteHeld()
      // A second view reaches the same endpoint over its own ControlMaster path, with the port
      // spelled out: still the same machine, so it attaches to the one live session.
      const res = await create(MODAL_OR_SECOND_VIEW, {
        agentId: 'claude',
        requireRemote: true,
        sshRemote: remoteFor({ ...HOST, port: 22 })
      })

      expect(res.unavailable).toBeUndefined()
      expect(res.sessionId).toBe(first.sessionId)
      expect(spawned).toHaveLength(1)
      expect(subscribersOf(first.sessionId)).toBe(2)
      expect(warnedAbout()).toHaveLength(0)
    })
  })
})
