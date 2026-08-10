import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findTmux, wellKnownTmux } from './pty-manager'

/**
 * WHICH BINARY PROVIDES THE MULTIPLEXER.
 *
 * Everything about persistence — a terminal surviving an app restart, a reboot, a power cut —
 * hangs off resolving one executable. `tmux` is that executable on macOS and Linux. On Windows
 * there is no tmux, and the app used to degrade SILENTLY to a plain shell: no continuity, no
 * scrollback restore, no resumable agent, and no way for the user to find out why.
 *
 * psmux is a tmux-compatible multiplexer for Windows that ships `tmux`, `psmux` and `pmux` command
 * aliases. It answers every subcommand this app issues (verified against psmux 3.3.7: source-file,
 * has-session, new-session -A -D -e -c -s, capture-pane -p -e -S, send-keys -l/Enter,
 * display-message with #{cursor_x}/#{cursor_y}/#{cursor_flag}/#{pane_current_command},
 * list-sessions -F, kill-session). So the fix is not a Windows code path — it is one more NAME to
 * look for, on every platform.
 */
describe('findTmux', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  /** A PATH directory holding real files named the way THIS platform names executables. */
  function pathDir(...bins: string[]): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mux-'))
    dirs.push(d)
    for (const b of bins) {
      const p = path.join(d, os.platform() === 'win32' ? `${b}.exe` : b)
      fs.writeFileSync(p, '')
      fs.chmodSync(p, 0o755) // no-op on Windows, load-bearing on POSIX (X_OK)
    }
    return d
  }

  /** The resolved file's name, lower-cased: the suffix comes from PATHEXT (`.EXE`) while the file
   *  on disk is `.exe`, and Windows treats those as the same name. */
  const binName = (p: string | null): string | null =>
    p === null ? null : path.basename(p).toLowerCase()

  it('resolves tmux from the PATH', () => {
    expect(binName(findTmux(pathDir('tmux'), []))).toBe(os.platform() === 'win32' ? 'tmux.exe' : 'tmux')
  })

  it('resolves psmux when it is the only multiplexer installed', () => {
    // THE WINDOWS CASE. Before this, a psmux-only host resolved nothing and every terminal fell
    // through to the plain-shell branch — the silent degrade this whole port exists to remove.
    expect(binName(findTmux(pathDir('psmux'), []))).toBe(
      os.platform() === 'win32' ? 'psmux.exe' : 'psmux'
    )
  })

  it('prefers tmux over psmux when both are installed', () => {
    // tmux is the reference implementation; psmux is the compatible stand-in. Wherever the real
    // thing exists it wins, so no macOS/Linux host can ever be pulled onto the fallback.
    expect(binName(findTmux(pathDir('tmux', 'psmux'), []))).toBe(
      os.platform() === 'win32' ? 'tmux.exe' : 'tmux'
    )
  })

  it('returns null when no multiplexer is installed', () => {
    expect(findTmux(pathDir('git'), [])).toBeNull()
  })

  it('prefers a well-known absolute location over the PATH (GUI apps inherit a minimal PATH)', () => {
    const wellKnown = path.join(pathDir('tmux'), os.platform() === 'win32' ? 'tmux.exe' : 'tmux')
    expect(findTmux(pathDir('tmux'), [wellKnown])).toBe(wellKnown)
  })

  it('skips a well-known location that does not exist', () => {
    const dir = pathDir('psmux')
    expect(binName(findTmux(dir, [path.join(dir, 'nope', 'tmux')]))).toBe(
      os.platform() === 'win32' ? 'psmux.exe' : 'psmux'
    )
  })
})

describe('wellKnownTmux', () => {
  it('offers the POSIX install locations on macOS and Linux', () => {
    expect(wellKnownTmux('darwin')).toContain('/opt/homebrew/bin/tmux')
    expect(wellKnownTmux('linux')).toContain('/usr/bin/tmux')
  })

  it('offers none on Windows, where a rooted path means the CURRENT DRIVE', () => {
    // `/usr/bin/tmux` resolves to `C:\usr\bin\tmux` there — a path an MSYS2 install rooted at the
    // drive root really creates. That tmux is real but does not speak ConPTY, and this list is
    // consulted before the PATH, so keeping it would let a stray MSYS binary outrank the working
    // psmux the user installed.
    expect(wellKnownTmux('win32')).toEqual([])
  })
})
