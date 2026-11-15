// Project secrets AT THE SPAWN (docs/project-secrets.md), through the real `pty:create` handler.
//
// `ProjectSecretsService.spawnEnv` decides WHO receives a value; this file proves WHERE it lands
// and where it does NOT: in the spawned process's environment only — never on an argv (tmux's long-
// lived client argv is readable by other processes, CWE-214), never for a peer's create, never in
// a file under the app's data folder, and a scrollback snapshot of output that printed it is
// redacted before it is written.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { ProjectSecretsService } from './project-secrets'
import { SECRET_REDACTION_MARKER } from '../shared/project-secrets'
import type { ProjectSpawnOverrides } from './project-spawn-overrides'

interface SpawnCall {
  file: string
  args: string[]
  env: Record<string, string>
}
const spawns = vi.hoisted(() => [] as SpawnCall[])
const execs = vi.hoisted(() => [] as string[][])

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { env: Record<string, string> }) => {
    spawns.push({ file, args, env: { ...opts.env } })
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
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: () => null,
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))
// Every tmux side-call answers "fine" without a subprocess, and is recorded so its argv can be
// searched for the value too.
vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    execs.push([file, ...(args ?? [])])
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  return { execFile, execFileSync: (): string => '', spawn: () => ({}) }
})

const DUMMY = 'dummy-secret-value-0123456789'
const PROJECT = 'proj-1'
const OWNER = 1
const PEER = 2
const DECL = { env: 'API_TOKEN', command: ['print-token'] }

async function setup(opts: { tmux?: string | null; policy?: 'deny' | 'allow' | 'ask' } = {}) {
  const secrets = new ProjectSecretsService({
    readDeclarations: async () => ({ kind: 'ok', cwd: '/p', secrets: [{ decl: DECL, source: 'shared' }] }),
    confirm: async () => true,
    crossProjectPolicy: () => opts.policy ?? 'deny',
    run: async () => ({ ok: true, value: Buffer.from(DUMMY) })
  })
  await secrets.authorize(PROJECT)
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  ;(mgr as unknown as { tmuxPath: string | null }).tmuxPath = opts.tmux ?? null
  // The synchronous tmux side-calls (`set-option -ga update-environment …`): recorded, answered ok.
  ;(mgr as unknown as { runTmuxSync: (a: string[]) => unknown }).runTmuxSync = (a: string[]) => {
    execs.push(['tmux', ...a])
    return { ok: true, stdout: '' }
  }
  mgr.setProjectSpawnOverrides(async (): Promise<ProjectSpawnOverrides> => ({ secrets: [DECL] }))
  mgr.setProjectSecrets(secrets)
  mgr.registerIpc()
  return { mgr, secrets }
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? filesUnder(p) : [p]
  })
}

describe('project secrets at the spawn', () => {
  let fake: FakePlatform
  beforeEach(() => {
    spawns.length = 0
    execs.length = 0
    fake = fakePlatform({ isOwnerClient: (id) => id === OWNER })
    initPlatform(fake)
  })
  afterEach(() => {
    resetPlatformForTests()
    vi.restoreAllMocks()
  })

  const create = async (client: number, options: Record<string, unknown>): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](client, { cols: 80, rows: 24, ...options })

  it('an agent node of the project, created by this app, receives the value in its environment only', async () => {
    await setup()
    await create(OWNER, { persistKey: 'n-agent', ownerProjectId: PROJECT, agentId: 'claude' })
    expect(spawns[0].env.API_TOKEN).toBe(DUMMY)
    expect(spawns[0].args.join(' ')).not.toContain(DUMMY)
  })

  it('a plain terminal of the same project does not', async () => {
    await setup()
    await create(OWNER, { persistKey: 'n-plain', ownerProjectId: PROJECT })
    expect(spawns[0].env.API_TOKEN).toBeUndefined()
  })

  it('a create from a peer (relay, hosted teammate) does not, whatever it claims', async () => {
    await setup()
    await create(PEER, { persistKey: 'n-peer', ownerProjectId: PROJECT, agentId: 'claude' })
    expect(spawns[0].env.API_TOKEN).toBeUndefined()
  })

  it('another project\'s node does not', async () => {
    await setup()
    await create(OWNER, { persistKey: 'n-other', ownerProjectId: 'proj-2', agentId: 'claude' })
    expect(spawns[0].env.API_TOKEN).toBeUndefined()
  })

  it('a node opened by another project\'s agent follows the policy', async () => {
    await setup({ policy: 'deny' })
    await create(OWNER, { persistKey: 'n-x', ownerProjectId: PROJECT, agentId: 'claude', secretsCrossProject: true })
    expect(spawns[0].env.API_TOKEN).toBeUndefined()
  })

  it('tmux: the value rides the client env, never a `-e` or any tmux argv; the NAME joins update-environment', async () => {
    await setup({ tmux: '/usr/bin/tmux' })
    await create(OWNER, { persistKey: 'n-tmux', ownerProjectId: PROJECT, agentId: 'claude' })
    const spawn = spawns.find((s) => s.file === '/usr/bin/tmux')
    expect(spawn?.env.API_TOKEN).toBe(DUMMY)
    expect(spawn?.args.join(' ')).not.toContain(DUMMY)
    expect(execs.flat().join(' ')).not.toContain(DUMMY)
    expect(execs.some((a) => a.includes('update-environment') && a.join(' ').includes('API_TOKEN'))).toBe(true)
  })

  it('a scrollback snapshot of output that printed the value is redacted before it is written', async () => {
    const { mgr } = await setup()
    const write = (mgr as unknown as { writeScrollbackIfChanged(k: string, t: string): Promise<boolean> })
      .writeScrollbackIfChanged.bind(mgr)
    expect(await write('n-snap', `$ echo $API_TOKEN\n${DUMMY}\n`)).toBe(true)
    const files = filesUnder(fake.userDataDir)
    const contents = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    expect(contents).toContain(SECRET_REDACTION_MARKER)
    expect(contents).not.toContain(DUMMY)
  })

  it('after authorizing and spawning, no file under the app data folder contains the value', async () => {
    const { mgr } = await setup({ tmux: '/usr/bin/tmux' })
    await create(OWNER, { persistKey: 'n-a', ownerProjectId: PROJECT, agentId: 'claude' })
    await create(OWNER, { persistKey: 'n-b', ownerProjectId: PROJECT, agentId: 'codex' })
    // The tmux config and anything else core wrote while spawning are on disk by now.
    await new Promise((r) => setTimeout(r, 20))
    void mgr
    for (const f of filesUnder(fake.userDataDir)) {
      expect(fs.readFileSync(f).includes(Buffer.from(DUMMY)), f).toBe(false)
    }
  })
})
