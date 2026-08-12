import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

/**
 * THE SILENT PLAIN-SHELL WINDOW.
 *
 * `findTmux` is subprocess-free by design (a sync login shell on the main thread froze every
 * window for 100-800ms per lookup), so it knows two things: a FIXED list of install locations, and
 * the login-shell PATH — which is resolved ASYNCHRONOUSLY and is simply not available for the
 * first moments of a run. A tmux that lives in neither is invisible, and a session spawned in that
 * window becomes a plain shell with NO PERSISTENCE and no banner: the app never says so, and the
 * park/offscreen disposes that are merely "detach a tmux client" everywhere else become "kill the
 * shell and the agent CLI in it" (issue #126).
 *
 * The fixed list closing as much of that window as it cheaply can is one half (tmux-hint.test.ts);
 * this is the other half — the guarantee that the window CLOSES: `init()` re-runs `ensureTmux()`
 * when the PATH probe lands, so a nonstandard tmux is picked up for NEW sessions with no restart.
 * Sessions already spawned plain are not migrated (a running process cannot be moved into a tmux
 * pane); their recovery is the node's own refresh/respawn.
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

describe('tmux discovery after the login-shell PATH probe settles', () => {
  beforeEach(() => {
    probe.shellPath = undefined
    initPlatform(fakePlatform())
    // No tmux in ANY fixed location — the whole point is a tmux only the shell PATH knows about.
    vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    // ensureTmux writes the generated tmux.conf into userDataDir; the fake's dir does not exist.
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  it('upgrades new sessions once the probe lands, without a restart', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    mgr.init(() => ({ tmuxEnabled: true, tmuxScrollback: 10_000 }) as never)
    // The probe has not settled: the nonstandard install is invisible and this run would spawn
    // plain shells. This is the window the fixed candidate list narrows but cannot delete.
    expect(mgr.getTmuxBin()).toBeNull()

    probe.shellPath = '/opt/weird/bin'
    await Promise.resolve() // let init()'s `resolveShellPath().then(() => ensureTmux())` run
    await Promise.resolve()
    expect(mgr.getTmuxBin()).toBe('/opt/weird/bin/tmux')
  })

  it('tmuxStatus() re-probes too, so the banner clears itself', async () => {
    const { PtyManager } = await import('./pty-manager')
    const mgr = new PtyManager()
    mgr.init(() => ({ tmuxEnabled: true, tmuxScrollback: 10_000 }) as never)
    expect(mgr.tmuxStatus().available).toBe(false)
    probe.shellPath = '/opt/weird/bin'
    expect(mgr.tmuxStatus().available).toBe(true)
  })
})
