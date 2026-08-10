import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execCandidates, findInPathString, isExecutable } from './exec-path'

describe('isExecutable', () => {
  it('accepts a real executable and rejects a path that is not there', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-exec-'))
    try {
      const p = path.join(d, os.platform() === 'win32' ? 'nt-fake.exe' : 'nt-fake')
      fs.writeFileSync(p, '')
      fs.chmodSync(p, 0o755)
      expect(isExecutable(p)).toBe(true)
      expect(isExecutable(path.join(d, 'nope'))).toBe(false)
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  // THE REASON THIS HELPER EXISTS, and it cannot be expressed on any other platform.
  //
  // Windows ships its most important commands — winget above all — as APP EXECUTION ALIASES:
  // zero-length reparse points under `…\AppData\Local\Microsoft\WindowsApps`. `fs.existsSync`
  // answers FALSE for one (it resolves the link and gets EACCES), while the file is on PATH and
  // runs perfectly. Any lookup written with `existsSync` therefore reports the single package
  // manager Windows actually has as "not installed" — which silently emptied the tmux banner's
  // install button. `fs.accessSync(X_OK)` sees them.
  //
  // Self-skipping (the repo's ssh-docker convention): a machine without the alias still runs green.
  const alias = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'Microsoft',
    'WindowsApps',
    'winget.exe'
  )
  const hasAlias = os.platform() === 'win32' && (() => {
    try {
      return fs.lstatSync(alias).isSymbolicLink()
    } catch {
      return false
    }
  })()

  it.runIf(hasAlias)('sees a Windows App Execution Alias, which fs.existsSync does not', () => {
    expect(fs.existsSync(alias)).toBe(false) // the trap this helper exists to avoid
    expect(isExecutable(alias)).toBe(true)
  })
})

describe('execCandidates', () => {
  it('posix: the bare name and nothing else', () => {
    // The mode bits carry executability there, and PATHEXT is meaningless — appending
    // extensions would only cost a stat per PATH entry per lookup.
    expect(execCandidates('tmux', 'darwin', '.COM;.EXE')).toEqual(['tmux'])
    expect(execCandidates('tmux', 'linux', undefined)).toEqual(['tmux'])
  })

  it('win32: every PATHEXT extension, in PATHEXT order', () => {
    expect(execCandidates('tmux', 'win32', '.COM;.EXE;.CMD')).toEqual([
      'tmux.COM',
      'tmux.EXE',
      'tmux.CMD'
    ])
  })

  it('win32: never the bare name — Windows has no execute bit, so it would match a DIRECTORY', () => {
    // fs.accessSync(dir, X_OK) succeeds for a directory on Windows, so a bare candidate would
    // happily resolve `C:\...\tmux\` as "the tmux executable" and every spawn would then fail.
    expect(execCandidates('tmux', 'win32', '.EXE')).not.toContain('tmux')
  })

  it('win32: an explicit extension is honored verbatim (CreateProcess does not append PATHEXT)', () => {
    expect(execCandidates('tmux.exe', 'win32', '.COM;.EXE')).toEqual(['tmux.exe'])
  })

  it('win32: falls back to a built-in PATHEXT when the env has none', () => {
    const c = execCandidates('tmux', 'win32', undefined)
    expect(c).toContain('tmux.EXE')
    expect(c).toContain('tmux.CMD')
    expect(c).toContain('tmux.BAT')
  })

  it('win32: tolerates a ragged PATHEXT (empty entries, stray spaces, missing dots)', () => {
    expect(execCandidates('tmux', 'win32', '.EXE; ;.CMD;')).toEqual(['tmux.EXE', 'tmux.CMD'])
  })
})

describe('findInPathString', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  /** A real file on disk under a real PATH dir — the whole point is that this walks the fs. */
  function bin(name: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-path-'))
    dirs.push(d)
    const p = path.join(d, name)
    fs.writeFileSync(p, '')
    fs.chmodSync(p, 0o755) // no-op on Windows, load-bearing on POSIX (X_OK)
    return p
  }

  it('finds an executable installed under the host platform s own naming', () => {
    // The file is named the way this platform really names executables: `nt-fake` on POSIX,
    // `nt-fake.exe` on Windows. Both must resolve from the bare name — that is the contract
    // every caller (findTmux, findSsh, findInLoginPath) relies on.
    const real = bin(os.platform() === 'win32' ? 'nt-fake.exe' : 'nt-fake')
    const hit = findInPathString('nt-fake', path.dirname(real))
    expect(hit).not.toBeNull()
    // Compared under the platform's OWN file-name rules: the suffix is taken from PATHEXT, which
    // is conventionally upper-case (`.EXE`), while the file on disk is `.exe`. Windows resolves
    // and spawns either spelling — normalizing the case would cost a readdir per lookup and buy
    // nothing. On POSIX this is a plain string comparison, unchanged.
    const same = (a: string, b: string): boolean =>
      os.platform() === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    expect(same(hit as string, real)).toBe(true)
    // …and it really is the file we planted, not merely a plausible-looking string.
    expect(fs.existsSync(hit as string)).toBe(true)
  })

  it('returns null when nothing on the PATH matches', () => {
    const dir = path.dirname(bin('nt-other'))
    expect(findInPathString('nt-fake', dir)).toBeNull()
  })

  it('tolerates an absent PATH', () => {
    expect(findInPathString('nt-fake', null)).toBeNull()
    expect(findInPathString('nt-fake', undefined)).toBeNull()
  })
})
