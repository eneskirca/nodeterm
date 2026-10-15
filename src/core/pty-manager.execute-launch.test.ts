// `PtyManager.executeLaunch` — WHICH live sessions may reach the session host's launch ledger.
// The planner and the encoding are proven in launch-intent-execute.test.ts; this file pins the
// dispatch: only a local session-host session on a win32 core, with a dialect the host recorded,
// ever calls `sessionHostExecuteLaunch`. tmux, SSH, a POSIX core and an old generation never do.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sessionName } from './tmux-naming'

vi.mock('child_process', () => ({
  execFile: (_f: string, _a: string[], a?: unknown, b?: unknown) => {
    const cb = (typeof a === 'function' ? a : b) as ((e: Error | null, r?: unknown) => void) | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  },
  execFileSync: (): string => ''
}))
vi.mock('node-pty', () => ({ spawn: () => ({}) }))

const host = vi.hoisted(() => ({
  execute: vi.fn(async (_name: string, _id: string, _plan: unknown) => ({ status: 'executed' as const }))
}))
vi.mock('./session-host-backend', async (original) => ({
  ...(await original<typeof import('./session-host-backend')>()),
  sessionHostExecuteLaunch: host.execute
}))

const NODE = 'node-1'
const LAUNCH_ID = '123e4567-e89b-42d3-a456-426614174000'
const EXE = 'C:\\Users\\me\\.local\\bin\\claude.exe'
const REQUEST = {
  launchId: LAUNCH_ID,
  intent: { kind: 'agent', action: 'start', agentId: 'claude', prompt: `it's "x"` }
}

type Mgr = {
  sessions: Map<string, unknown>
  byPersistKey: Map<string, string>
  launchIntentDepsOverride: Record<string, unknown>
  executeLaunch(k: unknown, r: unknown): Promise<{ ok: boolean; reason?: string }>
}

async function manager(platform: NodeJS.Platform, session: Record<string, unknown>): Promise<Mgr> {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager({ runtimePlatform: platform }) as unknown as Mgr
  mgr.sessions.set('s1', { persistKey: NODE, indexKey: NODE, ...session })
  mgr.byPersistKey.set(NODE, 's1')
  mgr.launchIntentDepsOverride = {
    customAgents: () => [],
    sharedIdentityAvailable: async () => false,
    codexCaps: async () => ({ approvalValues: null, noDaemon: null }),
    exists: (c: string) => c === EXE
  }
  return mgr
}

const HOST_SESSION = {
  sessionHost: true,
  launchDialect: 'pwsh',
  launchAgentId: 'claude',
  launchPath: 'C:\\Users\\me\\.local\\bin'
}

describe('PtyManager.executeLaunch', () => {
  beforeEach(() => host.execute.mockClear())

  it('executes through the host ledger for a win32 local session-host pane', async () => {
    const mgr = await manager('win32', HOST_SESSION)
    expect(await mgr.executeLaunch(NODE, REQUEST)).toEqual({ ok: true })
    expect(host.execute).toHaveBeenCalledTimes(1)
    const [name, id, plan] = host.execute.mock.calls[0]
    expect(name).toBe(sessionName(NODE))
    expect(id).toBe(LAUNCH_ID)
    // A PowerShell plan for the resolved native image — never the POSIX `'\''` quoting.
    expect((plan as { command: string }).command).toContain(`Start-Process -FilePath '${EXE}'`)
    expect((plan as { command: string }).command).not.toContain(`'\\''`)
  })

  it.each([
    ['a local tmux session', 'win32', { sessionHost: false, tmuxBacked: true }],
    ['an SSH session', 'win32', { ...HOST_SESSION, sshRemote: { conn: {}, controlPath: '/x' } }],
    ['a session-host generation with no recorded dialect', 'win32', { ...HOST_SESSION, launchDialect: undefined }],
    ['a macOS core', 'darwin', HOST_SESSION],
    ['a Linux core', 'linux', HOST_SESSION]
  ] as const)('never reaches the host for %s', async (_n, platform, session) => {
    const mgr = await manager(platform, session as Record<string, unknown>)
    expect(await mgr.executeLaunch(NODE, REQUEST)).toMatchObject({ ok: false, reason: 'unsupported-shell' })
    expect(host.execute).not.toHaveBeenCalled()
  })

  it('answers session-unavailable for a node with no live session, or a non-string key', async () => {
    const mgr = await manager('win32', HOST_SESSION)
    expect(await mgr.executeLaunch('other-node', REQUEST)).toMatchObject({ reason: 'session-unavailable' })
    expect(await mgr.executeLaunch(42, REQUEST)).toMatchObject({ reason: 'session-unavailable' })
    expect(host.execute).not.toHaveBeenCalled()
  })
})
