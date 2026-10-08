import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import { sessionName } from './tmux-naming'
import { hookServer, PERM_WAIT_SECS_DEFAULT } from './agents/hook-server'
import { paneOwnerProject, resetPaneOwnershipForTests } from './agents/pane-ownership'
import { codexLauncherDir } from './codex-identity-proxy'

/**
 * AUDIT A72 — a session the PHONE starts gets the agent's env and a proven owner.
 *
 * The relay `pty.attach` of a fresh node id creates its tmux session through `attachDetached`, and
 * tmux reads `-e` only at creation: whatever env that spawn lacks, the session lacks for life. A33
 * made the relay host resolve the phone's project/account/agent and pass them here when the attach
 * creates the session; this file pins what that spawn then carries, and the one thing it lacked:
 *
 *  - the agent-gated hook env (`NODETERM_AGENT_ID`, the Claude hook-reply wait, the canvas-control
 *    grant `canControlCanvas` decides) and, for Codex, the managed launcher's directory on PATH —
 *    the same `-e` pairs a canvas-started spawn gets, asserted on the tmux ARGV because that is
 *    what the session is created from;
 *  - PANE OWNERSHIP: recorded for the host-resolved owner (`agents/pane-ownership.ts`), and never
 *    for an attach this process can see is a join — so a phone cannot claim a live pane.
 *
 * Driven through a REAL hook server (as hook-server.env.test.ts does): a stubbed `buildPtyEnv`
 * would assert the arguments, not the env the session ends up with.
 */

const spawnArgs: string[][] = []

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (_file: string, args: string[]) => {
    spawnArgs.push(args)
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 1
    }
  }
}))

/** Every tmux side-call goes through child_process; `has-session` answers from the set. */
const liveTmuxSessions = new Set<string>()

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: string | { stdout: string; stderr: string }, stderr?: string) => void
  const execFile = (_file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    const ok = (stdout: string): void => cb?.(null, { stdout, stderr: '' })
    if (args.includes('has-session')) {
      const target = args[args.indexOf('-t') + 1]
      if (liveTmuxSessions.has(target)) ok('')
      else cb?.(Object.assign(new Error('no such session'), { code: 1 }))
    } else if (args[0] === '-ilc') {
      cb?.(null, '__NT_PATH_START__/usr/bin:/bin__NT_PATH_END__', '')
    } else {
      ok('')
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

// Hermetic tmux resolution (issue #160): the tmux-backed spawn is what is under test.
vi.mock('./tmux-hint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tmux-hint')>()),
  findFixedTmux: () => '/usr/bin/tmux'
}))

// A machine with pty devices to spare (see pty-single-user.test.ts).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1
const NODE = 'term-new-1'

/** The session env tmux is told to create the session with: every `-e KEY=VALUE` on the argv. */
function sessionEnv(args: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  args.forEach((a, i) => {
    if (a !== '-e') return
    const pair = args[i + 1]
    const eq = pair.indexOf('=')
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  })
  return env
}

describe('a session the phone starts over the relay — audit A72', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeAll(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-relaycreate-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    // buildPtyEnv answers {} until the server has a port and a token.
    await hookServer.start()
  })
  afterAll(() => {
    hookServer.stop()
    resetPlatformForTests()
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    } catch {
      /* a temp dir we could not remove is not a test result */
    }
  })
  beforeEach(() => {
    spawnArgs.length = 0
    liveTmuxSessions.clear()
    resetPaneOwnershipForTests()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetPaneOwnershipForTests()
  })

  async function tmuxManager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.init(() => ({ ...DEFAULT_SETTINGS, hookReplyApprovals: true }))
    m.registerIpc()
    return m
  }
  const sinks = () => ({ onData: vi.fn(), onExit: vi.fn() })
  const create = (extra: Record<string, unknown> = {}) =>
    fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24, persistKey: NODE, ...extra }) as Promise<{
      sessionId: string
      fresh: boolean
    }>

  it("creates a Claude session with the agent's hook env: identity, approval wait, canvas control", async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, cwd: userDataDir, agentId: 'claude', ownerProjectId: 'proj-A' })

    expect(spawnArgs).toHaveLength(1)
    const env = sessionEnv(spawnArgs[0])
    expect(env.NODETERM_NODE_ID).toBe(NODE)
    expect(env.NODETERM_AGENT_ID).toBe('claude')
    // Deterministic hook-reply approvals: without this the phone's `approvals.answer` has nothing
    // held to answer, and the permission prompt only ever reaches the pane.
    expect(env.NODETERM_PERM_WAIT_SECS).toBe(String(PERM_WAIT_SECS_DEFAULT))
    expect(env.NODETERM_CANVAS_CONTROL).toBe('1')
    expect(spawnArgs[0][spawnArgs[0].indexOf('-s') + 1]).toBe(sessionName(NODE))
  })

  it("puts a Codex session's managed launcher directory first on its PATH", async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, agentId: 'codex', ownerProjectId: 'proj-A' })
    const env = sessionEnv(spawnArgs[0])
    expect(env.NODETERM_AGENT_ID).toBe('codex')
    expect(env.PATH.split(path.delimiter)[0]).toBe(codexLauncherDir())
  })

  it('an attach with no agent (a join, an older phone) keeps the bare hook env it always had', async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24 })
    const env = sessionEnv(spawnArgs[0])
    // Status badges and inbox events never depended on the agent: node id + endpoint are there.
    expect(env.NODETERM_NODE_ID).toBe(NODE)
    expect(env.NODETERM_HOOK_ENDPOINT).toBeTruthy()
    expect(env).not.toHaveProperty('NODETERM_AGENT_ID')
    expect(env).not.toHaveProperty('NODETERM_PERM_WAIT_SECS')
    expect(env).not.toHaveProperty('NODETERM_CANVAS_CONTROL')
  })

  it("records the pane's host-resolved owner when the relay host creates the session", async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, agentId: 'claude', ownerProjectId: 'proj-A' })
    expect(paneOwnerProject(NODE)).toBe('proj-A')
  })

  it('records nothing for an attach that names no owner (every join, every older phone)', async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, agentId: 'claude' })
    expect(paneOwnerProject(NODE)).toBeUndefined()
  })

  it('a live generation in this process makes it a JOIN: the phone cannot claim the pane', async () => {
    const m = await tmuxManager()
    // The canvas spawned the node first, for its own project…
    await create({ ownerProjectId: 'proj-A' })
    expect(paneOwnerProject(NODE)).toBe('proj-A')
    // …then an attach naming another project arrives (a caller whose probe was stale).
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, ownerProjectId: 'proj-B' })
    expect(paneOwnerProject(NODE)).toBe('proj-A')
  })

  it('a join of a session another relay stream holds records nothing either', async () => {
    const m = await tmuxManager()
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24 })
    m.attachDetached(NODE, sinks(), { cols: 80, rows: 24, ownerProjectId: 'proj-B' })
    expect(paneOwnerProject(NODE)).toBeUndefined()
  })
})
