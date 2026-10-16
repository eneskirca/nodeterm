/**
 * PtyManager's relay-only-host parity seams, driven with node-pty and the session-host backend
 * mocked:
 *   - `prepareRelayAttach(…, {launch})` folds an UNRECORDED node's cwd / account / agent into the
 *     SPAWN options (never typed), keeps a recorded node's own records, and offers a `launch` step
 *     that types the line for the pane's real parser exactly once;
 *   - `scrollRoute` sends a wheel only where something consumes it;
 *   - `sendKeys` writes closed-set keys one at a time into a session-host pane.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { RelayNodeResolver } from './pty-manager'
import type { RelayLaunchContext } from './relay-launch'

const mouse = { mode: null as null | 'none' | 'vt200' }

vi.mock('./session-host-backend', async () => ({
  ...(await import('./__fixtures__/no-session-host')).noSessionHost(),
  sessionHostMouseTracking: async () => mouse.mode
}))
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

const SID = '0f3c2a1e-5b7d-4c9a-8e21-3f4a5b6c7d8e'
const sinks = { onData: () => {}, onExit: () => {} }

function resolver(): RelayNodeResolver {
  return {
    placements: (nodeId) =>
      nodeId === 'recorded'
        ? [{ projectId: 'p1', node: { kind: 'terminal', cwd: '/var/tmp', agentId: 'claude' } }]
        : [],
    refFor: () => undefined,
    projectIsRemote: () => false
  }
}

function launchCtx(over: Partial<RelayLaunchContext> = {}): RelayLaunchContext {
  return {
    customAgents: [],
    claudeAutoSupported: true,
    isKnownAccount: (id, agentId) => id === 'acct-1' && agentId === 'claude',
    env: {},
    ...over
  }
}

async function manager(withLaunch: boolean | Partial<RelayLaunchContext> = true, runtimePlatform?: NodeJS.Platform) {
  const { PtyManager } = await import('./pty-manager')
  const m = new PtyManager(runtimePlatform ? { runtimePlatform } : {})
  m.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: false }))
  m.setRelayNodeResolver(resolver())
  if (withLaunch) m.setRelayLaunchContext(() => launchCtx(withLaunch === true ? {} : withLaunch))
  return m
}

describe('relay launch (pty.attach { launch })', () => {
  beforeEach(() => initPlatform(fakePlatform()))
  afterEach(() => {
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  it('an UNRECORDED node: cwd, account and agent ride the spawn options, nothing is typed for them', async () => {
    const m = await manager()
    const spawn = vi.spyOn(m as unknown as { spawnSession: (...a: unknown[]) => string }, 'spawnSession')
    const prep = await m.prepareRelayAttach(
      'fresh-node',
      { cols: 80, rows: 24 },
      { launch: { agentId: 'claude', cwd: '/var/tmp', accountId: 'acct-1', sessionId: SID } }
    )
    expect(prep.kind).toBe('ready')
    if (prep.kind !== 'ready') return
    expect(prep.launch).toBeTypeOf('function')
    await prep.attach(sinks)
    expect(spawn.mock.calls[0][0]).toMatchObject({ persistKey: 'fresh-node', cwd: '/var/tmp', accountId: 'acct-1', agentId: 'claude' })
  })

  it('an account this machine does not know is dropped (system default), never trusted', async () => {
    const m = await manager()
    const spawn = vi.spyOn(m as unknown as { spawnSession: (...a: unknown[]) => string }, 'spawnSession')
    const prep = await m.prepareRelayAttach('fresh-2', { cols: 80, rows: 24 }, { launch: { agentId: 'claude', accountId: 'stranger' } })
    if (prep.kind !== 'ready') throw new Error('not ready')
    await prep.attach(sinks)
    expect((spawn.mock.calls[0][0] as { accountId?: string }).accountId).toBeUndefined()
  })

  it("an account of the OTHER provider is dropped: a codex agent never runs under a claude account's home", async () => {
    const m = await manager()
    const spawn = vi.spyOn(m as unknown as { spawnSession: (...a: unknown[]) => string }, 'spawnSession')
    const prep = await m.prepareRelayAttach('fresh-x', { cols: 80, rows: 24 }, { launch: { agentId: 'codex', accountId: 'acct-1' } })
    if (prep.kind !== 'ready') throw new Error('not ready')
    await prep.attach(sinks)
    expect((spawn.mock.calls[0][0] as { accountId?: string }).accountId).toBeUndefined()
  })

  it('a launch no line can be built for is never PROMISED (the reply would say launched:true and nothing would come)', async () => {
    // A Windows pane with no trusted planner wired: a custom agent whose args were quoted is not
    // dialect-neutral, so buildRelayLaunch would answer null after the reply. Refused up front.
    const quoted = {
      customAgents: [{ id: 'mine', label: 'Mine', launchCmd: 'mine', args: "--flag 'a b'" } as never]
    }
    const win = await manager(quoted, 'win32')
    const w = await win.prepareRelayAttach('fresh-w', { cols: 80, rows: 24 }, { launch: { agentId: 'mine' } })
    expect(w.kind === 'ready' && w.launch).toBeFalsy()
    // The same agent on a POSIX host types the quoted line exactly as the phone used to.
    const posix = await manager(quoted, 'linux')
    const p = await posix.prepareRelayAttach('fresh-p', { cols: 80, rows: 24 }, { launch: { agentId: 'mine' } })
    expect(p.kind === 'ready' && p.launch).toBeTypeOf('function')
    // A plain builtin on the Windows pane is neutral and still offered.
    const plain = await win.prepareRelayAttach('fresh-b', { cols: 80, rows: 24 }, { launch: { agentId: 'claude', sessionId: SID } })
    expect(plain.kind === 'ready' && plain.launch).toBeTypeOf('function')
    // An ${env:…} that expands to nothing would type a mangled line on ANY host.
    const envd = await manager({ customAgents: [{ id: 'e', label: 'E', launchCmd: '${env:NOPE_UNSET}' } as never] }, 'linux')
    const e = await envd.prepareRelayAttach('fresh-e', { cols: 80, rows: 24 }, { launch: { agentId: 'e' } })
    expect(e.kind === 'ready' && e.launch).toBeFalsy()
  })

  it('a RECORDED node keeps its records; a launch naming another agent is no launch', async () => {
    const m = await manager()
    const spawn = vi.spyOn(m as unknown as { spawnSession: (...a: unknown[]) => string }, 'spawnSession')
    const other = await m.prepareRelayAttach('recorded', { cols: 80, rows: 24 }, { launch: { agentId: 'codex', cwd: '/elsewhere' } })
    expect(other.kind === 'ready' && other.launch).toBeFalsy()
    const same = await m.prepareRelayAttach('recorded', { cols: 80, rows: 24 }, { launch: { agentId: 'claude', cwd: '/elsewhere' } })
    if (same.kind !== 'ready') throw new Error('not ready')
    expect(same.launch).toBeTypeOf('function')
    await same.attach(sinks)
    expect((spawn.mock.calls[0][0] as { cwd?: string }).cwd).toBe('/var/tmp')
  })

  it('no launch context wired (Server Edition): never a launch, and the spawn is unchanged', async () => {
    const m = await manager(false)
    const prep = await m.prepareRelayAttach('fresh-3', { cols: 80, rows: 24 }, { launch: { agentId: 'claude' } })
    expect(prep.kind === 'ready' && prep.launch).toBeFalsy()
  })

  it('types the line for the pane’s parser exactly once — no POSIX syntax into pwsh', async () => {
    const m = await manager()
    vi.spyOn(m, 'paneCommand').mockResolvedValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const send = vi.spyOn(m, 'sendText').mockResolvedValue(true)
    const prep = await m.prepareRelayAttach(
      'fresh-4',
      { cols: 80, rows: 24 },
      { launch: { agentId: 'claude', sessionId: SID, permissionMode: 'auto', cwd: '/var/tmp', accountId: 'acct-1' } }
    )
    if (prep.kind !== 'ready' || !prep.launch) throw new Error('no launch')
    expect(await prep.launch()).toBe(true)
    expect(await prep.launch()).toBe(false) // exactly once
    expect(send).toHaveBeenCalledTimes(1)
    const [node, text] = send.mock.calls[0]
    expect(node).toBe('fresh-4')
    expect(text).toBe(`claude --resume ${SID} --permission-mode auto`)
    for (const posix of ['2>/dev/null', 'env -u', ';', 'cd ']) expect(text).not.toContain(posix)
  })

  it('waits for a shell to own the pane; none in time ⇒ nothing typed', async () => {
    const { PtyManager } = await import('./pty-manager')
    const m = await manager()
    vi.spyOn(PtyManager, 'RELAY_LAUNCH_SHELL_WAIT_MS', 'get').mockReturnValue(0 as never)
    vi.spyOn(m, 'paneCommand').mockResolvedValue('node')
    const send = vi.spyOn(m, 'sendText').mockResolvedValue(true)
    const prep = await m.prepareRelayAttach('fresh-5', { cols: 80, rows: 24 }, { launch: { agentId: 'claude' } })
    if (prep.kind !== 'ready' || !prep.launch) throw new Error('no launch')
    expect(await prep.launch()).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('scrollRoute', () => {
  beforeEach(() => initPlatform(fakePlatform()))
  afterEach(() => resetPlatformForTests())

  async function withSession(fields: Record<string, unknown>) {
    const m = await manager()
    ;(m as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { persistKey: 'n1', ...fields })
    return m
  }

  it('a tmux client (local or remote) consumes the wheel', async () => {
    expect(await (await withSession({ tmuxBacked: true })).scrollRoute('s1')).toBe('tmux')
    expect(await (await withSession({ tmuxBacked: true, sshRemote: {} })).scrollRoute('s1')).toBe('tmux')
  })
  it('a session-host pane: app-mouse only when the app asked for the mouse', async () => {
    mouse.mode = 'vt200'
    expect(await (await withSession({ tmuxBacked: true, sessionHost: true })).scrollRoute('s1')).toBe('app-mouse')
    mouse.mode = 'none'
    expect(await (await withSession({ tmuxBacked: true, sessionHost: true })).scrollRoute('s1')).toBe('local')
    mouse.mode = null // an older host that cannot answer
    expect(await (await withSession({ tmuxBacked: true, sessionHost: true })).scrollRoute('s1')).toBe('local')
  })
  it('a plain shell, a native pane, an unknown session: local', async () => {
    expect(await (await withSession({ tmuxBacked: false })).scrollRoute('s1')).toBe('local')
    expect(await (await withSession({ tmuxBacked: false, nativeWindowsPane: {} })).scrollRoute('s1')).toBe('local')
    expect(await (await manager()).scrollRoute('nope')).toBe('local')
  })
})

describe('sendKeys into a session-host pane', () => {
  beforeEach(() => initPlatform(fakePlatform()))
  afterEach(() => resetPlatformForTests())

  it('writes each key as its own chunk, in order', async () => {
    const m = await manager()
    const writes: string[] = []
    ;(m as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
      persistKey: 'n1',
      sessionHost: true,
      tmuxBacked: true,
      proc: { write: (d: string) => writes.push(d) }
    })
    expect(await m.sendKeys('n1', [{ digit: '2' }, { name: 'Right' }, { name: 'Enter' }])).toBe(true)
    expect(writes).toEqual(['2', '\x1b[C', '\r'])
  })
  // A fake `tmux` that records its argv: proves which socket a key went to (POSIX sh script).
  it.skipIf(process.platform === 'win32')(
    "an SSH-project node with no client held never falls through to the LOCAL socket",
    async () => {
      const fs = await import('node:fs')
      const os = await import('node:os')
      const path = await import('node:path')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-sendkeys-'))
      const log = path.join(dir, 'argv.log')
      const tmux = path.join(dir, 'tmux')
      fs.writeFileSync(tmux, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 })
      try {
        const m = await manager()
        ;(m as unknown as { tmuxPath: string | null }).tmuxPath = tmux
        // Owner known, ControlMaster down: nothing is sent anywhere — a same-named local orphan
        // `nt-<id>` must not take the keystroke.
        m.setRemoteNodeOwner((id) => (id === 'remote-n' ? { projectId: 'p', hostKey: 'u@h' } : null))
        expect(await m.sendKeys('remote-n', [{ digit: '1' }])).toBe(false)
        expect(fs.existsSync(log)).toBe(false)
        // A LOCAL node with no client held still goes to the local socket, as before.
        expect(await m.sendKeys('local-n', [{ digit: '1' }, { name: 'Enter' }])).toBe(true)
        expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual([
          '-L node-terminal send-keys -t nt-local-n -l 1',
          '-L node-terminal send-keys -t nt-local-n Enter'
        ])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  )
  it('no client this process holds ⇒ nothing delivered', async () => {
    const m = await manager()
    ;(m as unknown as { tmuxPath: string | null }).tmuxPath = null
    expect(await m.sendKeys('ghost', [{ name: 'Escape' }])).toBe(false)
    expect(await m.sendKeys('ghost', [])).toBe(false)
  })
})
