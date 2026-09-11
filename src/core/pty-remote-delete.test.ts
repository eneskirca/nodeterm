/**
 * Deleting an SSH project's node must end the session on the HOST — including when this process
 * holds no live client for it.
 *
 * The bug: `runEndSession` decided "is this node remote?" from the in-memory live `Session` alone
 * (`dying?.sshRemote`). With no live client — after an app restart, after the offscreen release,
 * after the park timer, or for a node whose project is simply not open — `dying` is undefined, the
 * remote branch was skipped in silence, and the ONE kill that did go out went to the LOCAL tmux
 * socket, where a `requireRemote` node has nothing. Everything else about the teardown ran, so
 * nothing looked wrong: the node left the canvas and its `nt-<id>` kept running on the host.
 *
 * These pin the fix from the outside: the ownership answer comes from PERSISTED project data (the
 * resolver the shell wires to `workspaceStore.sshProjectIdForNode` + the project's ControlMaster),
 * never from a live session, and a kill that could not be delivered is RECORDED, not swallowed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'fs'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 4321
  })
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const HAS_SSH = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].some((p) =>
  existsSync(p)
)

const CONN = { host: 'example.test', user: 'deploy' }
const NODE = 'node-remote-1'

describe('deleting a remote node with no live client', () => {
  let fake: FakePlatform
  let runs: Array<{ file: string; args: string[] }>

  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
    runs = []
  })
  afterEach(() => {
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  async function manager(fail?: (args: readonly string[]) => unknown) {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({
      confirmedProcessRun: async (file: string, args: readonly string[]) => {
        runs.push({ file, args: [...args] })
        const error = fail?.(args)
        if (error) throw error
        return { stdout: '', stderr: '' }
      }
    })
    m.init(() => DEFAULT_SETTINGS)
    return m
  }

  const owner = (nodeId: string) =>
    nodeId === NODE
      ? {
          projectId: 'p1',
          hostKey: 'deploy@example.test',
          remote: { conn: CONN, controlPath: '/tmp/cm-p1' }
        }
      : null

  it.skipIf(!HAS_SSH)(
    'kills the session on the host, resolved from persisted project data',
    async () => {
      const m = await manager()
      m.setRemoteNodeOwner((nodeId) =>
        nodeId === NODE
          ? {
              projectId: 'p1',
              hostKey: 'deploy@example.test',
              remote: { conn: CONN, controlPath: '/tmp/cm-p1' }
            }
          : null
      )

      await m.destroySession(null, NODE)

      const remote = runs.filter((r) => r.file.endsWith('ssh'))
      expect(remote.length).toBeGreaterThan(0)
      const flat = remote.map((r) => r.args.join(' ')).join('\n')
      expect(flat).toContain('kill-session')
      expect(flat).toContain(sessionName(NODE))
      expect(flat).toContain('/tmp/cm-p1')
    }
  )

  it('records the undelivered kill when the project is not connected', async () => {
    const m = await manager()
    m.setRemoteNodeOwner((nodeId) =>
      nodeId === NODE ? { projectId: 'p1', hostKey: 'deploy@example.test' } : null
    )

    await m.destroySession(null, NODE)

    const { readPendingRemoteKills } = await import('./pending-remote-kills')
    const pending = await readPendingRemoteKills()
    expect(pending.map((e) => e.session)).toContain(sessionName(NODE))
    expect(pending[0].projectId).toBe('p1')
  })

  it.skipIf(!HAS_SSH)(
    "tmux's own \"can't find session\" (exit 1) settles it — nothing is owed",
    async () => {
      // The commonest outcome for a host that rebooted since the session was last seen. It is an
      // ANSWER, and recording a debt for it would queue an ssh round trip per reconnect forever.
      const m = await manager((args) =>
        args.join(' ').includes('kill-session') ? Object.assign(new Error('can\'t find session'), { code: 1 }) : null
      )
      m.setRemoteNodeOwner(owner)

      await m.destroySession(null, NODE)

      const { readPendingRemoteKills } = await import('./pending-remote-kills')
      expect(await readPendingRemoteKills()).toEqual([])
    }
  )

  it.skipIf(!HAS_SSH)('a transport failure (ssh 255) is owed, not swallowed', async () => {
    // A dead ControlMaster says nothing about whether the session is still running — and it
    // usually is. This is the case the old `catch {}` threw away.
    const m = await manager((args) =>
      args.join(' ').includes('kill-session')
        ? Object.assign(new Error('ssh: Control socket connect: No such file'), { code: 255 })
        : null
    )
    m.setRemoteNodeOwner(owner)

    await m.destroySession(null, NODE)

    const { readPendingRemoteKills } = await import('./pending-remote-kills')
    const pending = await readPendingRemoteKills()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      session: sessionName(NODE),
      hostKey: 'deploy@example.test',
      reason: 'delivery-failed'
    })
  })

  it('a RECYCLE still kills remotely but never owes a debt', async () => {
    // A recycle keeps the node (worktree move, model switch, "pause & end session"), so a kill
    // deferred to some later reconnect would land on the session the node has since RESPAWNED
    // under the same name — ending live work hours after the action that queued it. Only a delete
    // makes "kill this name whenever you next can" unconditionally correct.
    const m = await manager()
    m.setRemoteNodeOwner((nodeId) =>
      nodeId === NODE ? { projectId: 'p1', hostKey: 'deploy@example.test' } : null
    )

    await m.recycleSession(null, NODE)

    const { readPendingRemoteKills } = await import('./pending-remote-kills')
    expect(await readPendingRemoteKills()).toEqual([])
  })

  it('leaves a LOCAL node untouched — no resolver answer, no remote call, no debt', async () => {
    const m = await manager()
    m.setRemoteNodeOwner(() => null)

    await m.destroySession(null, 'node-local-1')

    expect(runs.filter((r) => r.file.endsWith('ssh'))).toEqual([])
    const { readPendingRemoteKills } = await import('./pending-remote-kills')
    expect(await readPendingRemoteKills()).toEqual([])
  })
})
