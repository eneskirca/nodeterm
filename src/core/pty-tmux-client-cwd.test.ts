/**
 * Issue #1131 — the LOCAL tmux client must not be spawned in the node's project directory.
 *
 * The first client to reach the shared `-L node-terminal` socket STARTS the server, and the server
 * keeps that client's working directory for the rest of its life. From tmux 3.7, `spawn.c` only
 * honours a new pane's `-c <dir>` when the SERVER's own `getcwd()` succeeds; once the directory the
 * server started in is deleted (a removed worktree, a cleaned-up station), `getcwd()` fails, the
 * `chdir(-c)` is skipped and every new pane inherits the server's deleted cwd — whatever project it
 * belongs to. MEASURED on a locally built tmux 3.7c (private socket): server started from a dir
 * that was then removed → `new-session -c <proj>` pane at `<gone> (deleted)`; same server started
 * from $HOME → pane at `<proj>`. tmux 3.4–3.6 do not have the guard and honour `-c` either way.
 *
 * So the tmux client runs from a stable directory and the pane's directory rides `-c` only. The
 * plain-shell fallback is the pane itself and keeps the project cwd.
 *
 * MUTATION: pass `cwd` instead of `localTmuxClientCwd()` to `pty.spawn` for the tmux branch → the
 * first case reddens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { PtyCreateOptions, PtyCreateResult, Settings } from '../shared/types'

const spawned: Array<{ file: string; args: string[]; cwd: string | undefined }> = []

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { cwd?: string }) => {
    spawned.push({ file, args, cwd: options?.cwd })
    return {
      onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {},
      pause: () => {}, resume: () => {}, kill: () => {}, pid: 4321
    }
  }
}))
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1

describe('the local tmux client never pins the project dir as the server cwd (#1131)', () => {
  let fake: FakePlatform
  let userDataDir: string
  let projectDir: string
  let settings: Settings

  beforeEach(async () => {
    spawned.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-client-cwd-'))
    projectDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-client-cwd-proj-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    settings = { ...DEFAULT_SETTINGS }
    const mgr = new PtyManager()
    mgr.init(() => settings)
    mgr.registerIpc()
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80, rows: 24, persistKey: 'node-1', cwd: projectDir, ...options
    }) as Promise<PtyCreateResult>

  it.skipIf(process.platform === 'win32')('spawns the tmux client from a stable dir and passes the project dir via -c', async () => {
    const { localTmuxClientCwd } = await import('./pty-manager')
    const res = await create({})
    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    const [{ args, cwd }] = spawned
    // This suite needs a real tmux on PATH (as the other pty suites do); without one the create
    // takes the plain-shell branch and the next assertions would be about the wrong thing.
    expect(args).toContain('new-session')
    expect(args[args.indexOf('-c') + 1]).toBe(projectDir)
    expect(cwd).toBe(localTmuxClientCwd())
    expect(cwd).not.toBe(projectDir)
  })

  it('the plain-shell fallback is the pane itself and keeps the project cwd', async () => {
    settings = { ...settings, tmuxEnabled: false }
    await create({ persistKey: undefined })
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cwd).toBe(projectDir)
  })
})

describe('localTmuxClientCwd', () => {
  it('answers the home directory when it exists, else /', async () => {
    const { localTmuxClientCwd } = await import('./pty-manager')
    expect(localTmuxClientCwd('/home/x', () => true)).toBe('/home/x')
    expect(localTmuxClientCwd('/home/x', () => false)).toBe('/')
    expect(localTmuxClientCwd('', () => true)).toBe('/')
  })
})
