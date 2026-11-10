/**
 * The phone's relay `pty.attach` must never spawn an SSH project's node LOCALLY.
 *
 * The bug: the relay host attached with `attachDetached(nodeId)` → `tmux new-session -A` on the
 * LOCAL socket, for whatever id the phone named. A node of an SSH project, opened on the phone
 * before the desktop mounted it, therefore became a local shell in this machine's `$HOME` wearing
 * the remote node's id — work typed there ran on the wrong machine, its hooks reported nothing the
 * node could use, and the desktop's later mount created a SECOND session of the same name on the
 * host. And a local node the phone created first got only the base hook env (no agent id, no
 * canvas-control grant, no account dir, no cwd), which tmux ignores on every later attach.
 *
 * These drive the real `PtyManager.prepareRelayAttach` with node-pty mocked, so a spawn is
 * observable and nothing real is started.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import { existsSync } from 'fs'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'
import type { RelayNodeResolver } from './pty-manager'

const spawned: Array<{ file: string; args: string[]; opts: { cwd?: string; env?: Record<string, string> } }> = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }) => {
    spawned.push({ file, args, opts })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const HAS_SSH = ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh'].some((p) =>
  existsSync(p)
)
const SERVER = { host: 'box.test', user: 'deploy' }
const SSH_NODE = 'node-ssh-1'
const LOCAL_NODE = 'node-local-1'
const sinks = { onData: () => {}, onExit: () => {} }

function resolver(opts: { master?: boolean; setupDone?: boolean } = {}): RelayNodeResolver {
  return {
    placements: (nodeId) =>
      nodeId === SSH_NODE
        ? [
            {
              projectId: 'p-ssh',
              projectServer: SERVER,
              node: { kind: 'terminal', cwd: '/srv/app', agentId: 'claude', ssh: SERVER, sshRemoteTmux: true }
            }
          ]
        : nodeId === LOCAL_NODE
          ? [{ projectId: 'p-local', node: { kind: 'terminal', cwd: '/var/tmp', agentId: 'claude' } }]
          : [],
    refFor: (scope) =>
      opts.master && scope === 'p-ssh'
        ? { conn: SERVER, controlPath: '/var/tmp/nt-test-cm-p1', setupDone: opts.setupDone ?? true }
        : undefined,
    projectIsRemote: (id) => id === 'p-ssh'
  }
}

describe('relay attach routes by this machine’s records, never to a local shell for a remote node', () => {
  beforeEach(() => {
    spawned.length = 0
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  async function manager(r?: RelayNodeResolver) {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => DEFAULT_SETTINGS)
    if (r) m.setRelayNodeResolver(r)
    return m
  }

  it('an SSH-project node with no live master is refused and NOTHING is spawned', async () => {
    const m = await manager(resolver())
    const prep = await m.prepareRelayAttach(SSH_NODE, { cols: 80, rows: 24 })
    expect(prep.kind).toBe('refused')
    if (prep.kind !== 'refused') return
    expect(prep.reason).toBe('not-connected')
    expect(prep.message).toContain('deploy@box.test')
    expect(spawned).toHaveLength(0) // ← the whole point: no local `nt-<id>` wearing a remote id
  })

  it('a master still setting up only JOINS a listed session — it never creates one', async () => {
    // The fake control path answers nothing, so the host's listing is `unknown`: not `present`.
    const m = await manager(resolver({ master: true, setupDone: false }))
    const prep = await m.prepareRelayAttach(SSH_NODE, { cols: 80, rows: 24 })
    expect(prep).toMatchObject({ kind: 'refused', reason: 'still-connecting' })
    expect(spawned).toHaveLength(0)
  })

  it.skipIf(!HAS_SSH)('with a live master the session runs over it on the HOST', async () => {
    const m = await manager(resolver({ master: true }))
    const prep = await m.prepareRelayAttach(SSH_NODE, { cols: 80, rows: 24 })
    expect(prep.kind).toBe('ready')
    if (prep.kind !== 'ready') return
    expect(prep.remote).toBe(true)
    await prep.attach(sinks)
    expect(spawned).toHaveLength(1)
    const { file, args } = spawned[0]
    expect(file).toMatch(/ssh$/) // an ssh client, never the local tmux
    const line = args.join(' ')
    expect(line).toContain('/var/tmp/nt-test-cm-p1')
    expect(line).toContain(sessionName(SSH_NODE))
    expect(line).toContain(`-L ${RMT_TMUX_SOCKET} `) // the HOST's socket, over ssh
  }, 20_000)

  it('a local node is created with the env the desktop gives it, via the one env builder', async () => {
    const { hookServer } = await import('./agents/hook-server')
    const build = vi.spyOn(hookServer, 'buildPtyEnv')
    const m = await manager(resolver())
    const prep = await m.prepareRelayAttach(LOCAL_NODE, { cols: 80, rows: 24 })
    expect(prep).toMatchObject({ kind: 'ready', remote: false })
    if (prep.kind !== 'ready') return
    await prep.attach(sinks)
    expect(spawned).toHaveLength(1)
    // The agent id reaches the SAME builder the desktop's create uses (agent id, canvas-control
    // grant and permission wait all hang off it) — not a second relay-only env.
    expect(build).toHaveBeenCalledWith(LOCAL_NODE, 'claude', expect.any(Number))
    const { args, opts } = spawned[0]
    // The node's cwd: on tmux as the new session's `-c`, on a plain shell as the pty's cwd.
    expect(args.includes('/var/tmp') || opts.cwd === '/var/tmp').toBe(true)
  })

  it('with no resolver wired (Server Edition) the attach is the bare local one it always was', async () => {
    const m = await manager()
    const prep = await m.prepareRelayAttach(SSH_NODE, { cols: 80, rows: 24 })
    expect(prep).toMatchObject({ kind: 'ready', remote: false })
  })
})
