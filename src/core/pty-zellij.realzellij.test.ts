// PtyManager's Zellij wiring, against a REAL Zellij binary (skipped when none is found — see
// zellij-test-env.ts). node-pty is mocked (suite convention: it is built for Electron's ABI), and
// the mock RUNS the painter argv the manager built — headless, `--create` → `--create-background`
// — with the env and cwd the manager chose. So what reaches the session is exactly what the
// painter would have given it, and every later op (exists, paste, capture, pane command, kill) is
// the manager's own code talking to a real Zellij.
import fs from 'fs'
import { execFileSync } from 'child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { sessionName } from './tmux-naming'
import { zellijSessionState } from './zellij-backend'
import { TEST_ZELLIJ, disposeZellijSandbox, eventually, makeZellijSandbox, type ZellijSandbox } from './zellij-test-env'
import { testTmpDir } from './test-tmp'

const h = vi.hoisted(() => ({
  spawns: [] as Array<{ file: string; args: string[]; env: Record<string, string>; cwd: string }>,
  zellij: null as string | null
}))

vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => {
    h.spawns.push({ file, args, env: opts.env, cwd: opts.cwd })
    if (file === h.zellij) {
      // `--create-background` REFUSES a session that exists, where the painter's `--create` would
      // simply attach — so a failure here on a warm reattach is the harness, not the code. Every
      // test asserts the session state it expects afterwards, so a real create failure still fails.
      try {
        execFileSync(
          file,
          args.map((a) => (a === '--create' ? '--create-background' : a)),
          { env: opts.env, cwd: opts.cwd, timeout: 10_000, stdio: 'ignore' }
        )
      } catch {
        /* see above */
      }
    }
    return {
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))

describe.skipIf(!TEST_ZELLIJ)('PtyManager on the Zellij backend (real binary)', () => {
  let sb: ZellijSandbox
  let settings: Settings
  const saved: Record<string, string | undefined> = {}
  const node = `zw-${Date.now().toString(36)}`

  beforeAll(() => {
    h.zellij = TEST_ZELLIJ
    sb = makeZellijSandbox()
    // The manager builds its env from process.env; point it at the sandbox for this file.
    for (const k of ['ZELLIJ_SOCKET_DIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'COLORTERM']) {
      saved[k] = process.env[k]
      if (k === 'COLORTERM') delete process.env[k]
      else process.env[k] = sb.env[k]
    }
    initPlatform(fakePlatform({ userDataDir: testTmpDir('zw-ud-') }))
    settings = { ...DEFAULT_SETTINGS, sessionBackend: 'zellij', defaultShell: '/bin/sh' }
  })
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetPlatformForTests()
    if (sb) await disposeZellijSandbox(sb)
  })

  async function manager(): Promise<import('./pty-manager').PtyManager> {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager({ zellijBin: TEST_ZELLIJ })
    m.init(() => settings)
    return m
  }

  it('a new local terminal is created in Zellij, cold, with its env and nothing on argv', async () => {
    const m = await manager()
    const r = await m.createHeadless({ cols: 100, rows: 30, persistKey: node, cwd: sb.root })
    expect(r.fresh).toBe(true)
    expect(r.persistent).toBe(true)
    const spawn = h.spawns.at(-1)!
    expect(spawn.file).toBe(TEST_ZELLIJ)
    expect(spawn.args).toEqual(expect.arrayContaining(['attach', '--create', '--close-on-exit', sessionName(node)]))
    expect(spawn.args).not.toContain('-e')
    expect(spawn.env.ZELLIJ).toBeUndefined()
    expect(fs.existsSync(spawn.args[spawn.args.indexOf('--config') + 1])).toBe(true)
    expect(await eventually(async () => (await zellijSessionState(sb.run, sessionName(node))) === 'live')).toBe(true)

    // The manager's own env (COLORTERM is set by spawnSession, not inherited — deleted above).
    expect(await m.sendText(node, 'echo "CT=$COLORTERM PWD=$PWD"')).toBe(true)
    expect(
      await eventually(async () => (await m.captureSession(node)).includes(`CT=truecolor PWD=${sb.root}`))
    ).toBe(true)
    expect(await eventually(async () => (await m.paneCommand(node)) === 'sh')).toBe(true)
    // The co-attach seed is the visible screen, colour kept.
    expect(await m.captureSnapshot(node)).toContain('CT=truecolor')
    // Degrades named in ZELLIJ_BACKEND_GAPS answer "unknown/refused", never a tmux guess.
    expect(await m.paneOwner(node)).toBeNull()
    expect(await m.paneCwd(node)).toBeNull()
    expect(await m.terminateForeground(node)).toBe(false)
  }, 30_000)

  it('after a restart the node reattaches its Zellij session warm — even with the setting back on tmux', async () => {
    settings = { ...settings, sessionBackend: 'tmux' }
    // The review repro: a personal session whose name has a SPACE used to make every listing
    // unparseable → "unknown" → with tmux selected, fresh:true and a tmux spawn — the agent resumed
    // a second time beside the live Zellij one.
    execFileSync(TEST_ZELLIJ as string, ['attach', '--create-background', 'my work'], {
      env: sb.env,
      timeout: 10_000,
      stdio: 'ignore'
    })
    const m = await manager() // a fresh manager = a fresh app run: no memory of the node
    expect(await m.sessionExists(node)).toBe(true)
    const r = await m.createHeadless({ cols: 100, rows: 30, persistKey: node, cwd: sb.root })
    expect(r.fresh).toBe(false)
    expect(h.spawns.at(-1)!.file).toBe(TEST_ZELLIJ)
    // …and a node that never existed is not claimed to exist.
    expect(await m.sessionExists('never-existed')).toBe(false)
  }, 30_000)

  it('with tmux selected and no Zellij session, the default path is untouched', async () => {
    const m = await manager()
    const other = `${node}-t`
    await m.createHeadless({ cols: 80, rows: 24, persistKey: other, cwd: sb.root })
    expect(h.spawns.at(-1)!.file).not.toBe(TEST_ZELLIJ)
    expect(await zellijSessionState(sb.run, sessionName(other))).toBe('absent')
  }, 30_000)

  it('deleting the node ends its Zellij session, even from a manager that never held it', async () => {
    const m = await manager()
    await m.destroySession(null, node)
    expect(await eventually(async () => (await zellijSessionState(sb.run, sessionName(node))) === 'absent')).toBe(true)
  }, 30_000)
})
