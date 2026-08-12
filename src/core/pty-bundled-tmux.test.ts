import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

/**
 * THE BUNDLED tmux, AND WHY IT IS LAST.
 *
 * The macOS app ships its own static tmux (scripts/build-tmux.mjs → resources/bin/tmux →
 * `<app>/Contents/Resources/bin/tmux`) so a machine with no tmux is no longer dropped into the
 * silent plain-shell fallback (issue #126). But it is appended AFTER every system candidate, and
 * that order is the whole design: a tmux client attaches to a tmux SERVER that outlives the app,
 * started by whatever tmux the user installed. Choosing our binary over theirs could hand a new
 * client to an old running server ("server version is too old"). System-first ⇒ existing tmux
 * users see zero change; the bundle only rescues the tmux-less.
 */

const probe = vi.hoisted(() => ({ shellPath: undefined as string | undefined }))
vi.mock('./exec-path', () => ({
  resolveShellPath: () => Promise.resolve(probe.shellPath ?? null),
  shellPathNow: () => probe.shellPath,
  findInPathString: (bin: string, pathStr: string | null | undefined) =>
    pathStr === '/opt/weird/bin' ? `/opt/weird/bin/${bin}` : null,
  findExecutableSync: () => null
}))
vi.mock('node-pty', () => ({ spawn: () => ({ onData: () => {}, onExit: () => {}, kill: () => {} }) }))

const RESOURCES = '/Applications/nodeterm.app/Contents/Resources'
const BUNDLED = `${RESOURCES}/bin/tmux`

/** A manager booted with `existsSync` answering true for exactly `present`. */
async function bootWith(present: string[], resourcesPath?: string) {
  initPlatform(fakePlatform(resourcesPath ? { resourcesPath } : {}))
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => present.includes(String(p)))
  // ensureTmux writes the generated tmux.conf into userDataDir; the fake's dir does not exist.
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  mgr.init(() => ({ tmuxEnabled: true, tmuxScrollback: 10_000 }) as never)
  return mgr
}

describe('bundled tmux in findTmux', () => {
  beforeEach(() => {
    probe.shellPath = undefined
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  it('the system tmux still wins when both exist', async () => {
    const mgr = await bootWith(['/opt/homebrew/bin/tmux', BUNDLED], RESOURCES)
    expect(mgr.getTmuxBin()).toBe('/opt/homebrew/bin/tmux')
  })

  it('a tmux only the login-shell PATH knows about also outranks the bundled one', async () => {
    probe.shellPath = '/opt/weird/bin'
    const mgr = await bootWith([BUNDLED], RESOURCES)
    expect(mgr.getTmuxBin()).toBe('/opt/weird/bin/tmux')
  })

  it('falls back to the bundled binary when the machine has no tmux at all', async () => {
    const mgr = await bootWith([BUNDLED], RESOURCES)
    expect(mgr.getTmuxBin()).toBe(BUNDLED)
  })

  it('makes the tmux-missing banner unreachable on a packaged macOS build', async () => {
    // The banner is driven by tmuxStatus().available, which is just "did findTmux resolve" — so
    // shipping the binary retires the banner for packaged macOS without touching its copy.
    const mgr = await bootWith([BUNDLED], RESOURCES)
    expect(mgr.tmuxStatus().available).toBe(true)
  })

  it('keeps the banner for the cases that still have no tmux (dev without the artifact, Linux)', async () => {
    // No packaged Resources dir, and no `resources/bin/tmux` under the repo root either.
    const mgr = await bootWith([])
    expect(mgr.getTmuxBin()).toBeNull()
    expect(mgr.tmuxStatus().available).toBe(false)
  })

  it('dev run: picks up the artifact scripts/build-tmux.mjs left under the repo root', async () => {
    const mgr = await bootWith([`${process.cwd()}/resources/bin/tmux`])
    expect(mgr.getTmuxBin()).toBe(`${process.cwd()}/resources/bin/tmux`)
  })
})
