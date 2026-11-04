// THE STALE-CWD SIGNAL, PROVEN AGAINST A REAL TMUX (issue #464).
//
// Unit tests pin what `classifyPaneCwd` does with an answer; whether tmux actually gives that
// answer for a session whose start directory was deleted — and keeps giving it after a same-named
// directory is re-created (a DIFFERENT inode, the whole point of the issue) — is a property of
// tmux and the kernel, so it is measured here on a private socket, exactly like the other
// realtmux suites.
//
// Also proven, because the issue asks it explicitly: a NEW session created after the re-creation
// starts in the re-created directory — the spawn path was never the broken half.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { classifyPaneCwd } from './pane-cwd'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-cwd-${process.pid}`

let tmp: string
let tmuxOk = false

function tmux(args: string[], opts?: { cwd?: string }): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    cwd: opts?.cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

/** The exact probe `PtyManager.paneCwdStale` runs: exact-match target, one format. The trailing
 *  colon is load-bearing and MEASURED here (tmux 3.4): a bare `=name` target-pane resolves
 *  NOTHING silently — exit 0, every format empty — while `=name:` is "exactly this session, its
 *  active pane". The first assertion below (`'ok'`, not `'unknown'`) is what pins it. */
function panePath(session: string): string {
  return tmux(['display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}']).replace(
    /\r?\n$/,
    ''
  )
}

/** `tmux new-session -d -c <dir>` returns as soon as the server forks the pane process, before the
 *  child is scheduled to run `chdir(dir)` — so an immediate `#{pane_current_path}` under CI load
 *  can still read `/proc/<pid>/cwd` as the server's initial working directory. Poll until the pane
 *  lands in `dir` before deleting `dir` or asserting its path. */
function waitForPaneCwd(session: string, expectedDir: string): string {
  const target = fs.realpathSync(expectedDir)
  const deadline = Date.now() + 10_000
  let reported = panePath(session)
  while (Date.now() < deadline) {
    try {
      if (reported && fs.realpathSync(reported) === target) return reported
    } catch {
      /* path not settled yet */
    }
    reported = panePath(session)
  }
  return reported
}

const dirExists = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

beforeAll(() => {
  if (process.platform === 'win32') return // no tmux on Windows — the session host owns that world
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntcwd-', SOCKET)
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('pane_current_path across delete → recreate (real tmux)', () => {
  it('a deleted-then-recreated start dir stays STALE for the live session, and a healthy one is ok', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj')
    fs.mkdirSync(dir)
    // `sleep` rather than an interactive shell: the pane's process-group leader holds the cwd and
    // sits still, so the measurement has no prompt/rc-file noise in it.
    // `-f /dev/null` on the server-starting call: a contributor's ~/.tmux.conf must not join the
    // measurement (the private socket makes this call the one that boots the server).
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'victim', '-c', dir, 'sleep 60'])

    // Healthy: tmux names the directory and it exists.
    const initial = waitForPaneCwd('victim', dir)
    expect(classifyPaneCwd(initial, dirExists)).toBe('ok')
    expect(fs.realpathSync(initial)).toBe(fs.realpathSync(dir))

    // Deleted: the shell keeps the inode; the classifier must call it stale.
    fs.rmSync(dir, { recursive: true, force: true })
    const afterDelete = panePath('victim')
    expect(classifyPaneCwd(afterDelete, dirExists)).toBe('stale')

    // Recreated at the same path — a different inode, so nothing self-heals. This is the exact
    // reported state: the folder EXISTS again, and the verdict must still be stale.
    fs.mkdirSync(dir)
    const afterRecreate = panePath('victim')
    expect(dirExists(dir)).toBe(true)
    expect(classifyPaneCwd(afterRecreate, dirExists)).toBe('stale')
    if (process.platform === 'linux') {
      // The measured Linux signal, pinned so a kernel/tmux change that stops emitting it turns
      // this suite red instead of silently disabling the banner: /proc's readlink names the dead
      // inode with the " (deleted)" suffix, before AND after the same-named mkdir.
      expect(afterDelete.endsWith(' (deleted)')).toBe(true)
      expect(afterRecreate.endsWith(' (deleted)')).toBe(true)
    }
  })

  it('a NEW session created after the recreation starts in the recreated directory', () => {
    if (!tmuxOk) return
    const dir = path.join(tmp, 'proj2')
    fs.mkdirSync(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir)
    tmux(['new-session', '-d', '-s', 'fresh', '-c', dir, 'sleep 60'])
    const reported = waitForPaneCwd('fresh', dir)
    expect(classifyPaneCwd(reported, dirExists)).toBe('ok')
    expect(fs.realpathSync(reported)).toBe(fs.realpathSync(dir))
  })
})
