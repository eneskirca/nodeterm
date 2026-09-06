import { describe, it, expect } from 'vitest'
import path from 'path'
import { hostLauncherPath, resolveSessionHostScript, WINDOWS_HOST_EXE } from './session-host-launcher'
import type { HostLinkFs } from './session-host-launcher'

const asar = path.join('/app', 'resources', 'app.asar')
const resources = path.join('/app', 'resources')
const repo = path.join('/home', 'me', 'nodeterm')

const inAsar = path.join(asar, 'out', 'session-host', 'host.cjs')
const inResources = path.join(resources, 'session-host', 'host.cjs')
const inRepo = path.join(repo, 'out', 'session-host', 'host.cjs')

/** `exists` is injected so the resolution order is testable without a filesystem. */
const only = (...present: string[]) => (p: string) => present.includes(p)

describe('resolveSessionHostScript', () => {
  it('finds the bundle inside the asar — the packaged path', () => {
    // This is the one that matters: `build.files` carries `out/**` into the asar, so the bundle is
    // already there, and a host resolved from inside the asar can reach `node-pty` (a host copied
    // to <resourcesPath>/session-host cannot — see the module comment).
    expect(
      resolveSessionHostScript({ resourcesPath: resources, appPath: asar, repoRoot: repo, exists: only(inAsar) })
    ).toBe(inAsar)
  })

  it('finds the bundle in a dev checkout, where appPath IS the repo root', () => {
    expect(
      resolveSessionHostScript({ appPath: repo, repoRoot: repo, exists: only(inRepo) })
    ).toBe(inRepo)
  })

  it('still honours an extraResources copy when one exists, and prefers it', () => {
    // Kept ahead of the others so an installation that DOES ship the copy is unaffected.
    expect(
      resolveSessionHostScript({ resourcesPath: resources, appPath: asar, exists: only(inResources, inAsar) })
    ).toBe(inResources)
  })

  it('falls back to repoRoot for a shell that supplies no app path', () => {
    expect(resolveSessionHostScript({ repoRoot: repo, exists: only(inRepo) })).toBe(inRepo)
  })

  it('answers null when the bundle was never built', () => {
    // An incomplete build is the only way this backend can be unavailable, so the miss must be
    // clean rather than a path that does not exist.
    expect(
      resolveSessionHostScript({ resourcesPath: resources, appPath: asar, repoRoot: repo, exists: () => false })
    ).toBeNull()
  })

  it('ignores absent opts rather than building paths from undefined', () => {
    expect(resolveSessionHostScript({ exists: () => true })).toBeNull()
  })

  it('keeps looking when a candidate throws', () => {
    const exists = (p: string) => {
      if (p === inResources) throw new Error('EPERM')
      return p === inAsar
    }
    expect(resolveSessionHostScript({ resourcesPath: resources, appPath: asar, exists })).toBe(inAsar)
  })
})

// The installer conflict this exists to solve: a detached host that is ALSO `nodeterm.exe` is
// indistinguishable from the app to the one-click NSIS installer's image-name wait, so an install
// stalls until it is killed by hand. These pin the naming, not the linking — creating a real hard
// link needs a real Electron binary beside its DLLs, so the end-to-end proof lives in the PR.
describe('WINDOWS_HOST_EXE', () => {
  it('is a name the installer cannot mistake for the app', () => {
    expect(WINDOWS_HOST_EXE).toBe('nodeterm-session-host.exe')
    expect(WINDOWS_HOST_EXE).not.toBe('nodeterm.exe')
  })

  it('keeps the .exe suffix, because Windows resolves and reports on the file name', () => {
    expect(WINDOWS_HOST_EXE.endsWith('.exe')).toBe(true)
  })
})

describe('hostLauncherPath', () => {
  const exe = 'C:\\Program Files\\node-terminal\\nodeterm.exe'
  const link = 'C:\\Program Files\\node-terminal\\' + WINDOWS_HOST_EXE

  /** `stats` maps a path to an identity; a missing entry throws, as the real statSync does. */
  const fsWith = (
    stats: Record<string, { ino: bigint; dev: bigint }>,
    hooks: Partial<HostLinkFs> = {}
  ): { fs: HostLinkFs; calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      fs: {
        statSync: (p) => {
          const s = stats[p]
          if (!s) throw new Error('ENOENT')
          return s
        },
        unlinkSync: (p) => {
          calls.push('unlink:' + p)
          hooks.unlinkSync?.(p)
        },
        linkSync: (a, b) => {
          calls.push('link:' + b)
          hooks.linkSync?.(a, b)
        },
        ...(hooks.statSync ? { statSync: hooks.statSync } : {})
      } as HostLinkFs
    }
  }

  it('does nothing off win32 — no filesystem access at all', () => {
    const { fs, calls } = fsWith({})
    for (const p of ['darwin', 'linux']) expect(hostLauncherPath(exe, p, fs)).toBe(exe)
    expect(calls).toEqual([])
  })

  it('reuses a link that is the same file', () => {
    const id = { ino: 42n, dev: 7n }
    const { fs, calls } = fsWith({ [exe]: id, [link]: id })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(link)
    expect(calls).toEqual([])
  })

  it('replaces a STALE link — the after-an-update case', () => {
    // An installer replaces nodeterm.exe; a link to the old inode would keep launching the previous
    // version's binary forever.
    const { fs, calls } = fsWith({ [exe]: { ino: 99n, dev: 7n }, [link]: { ino: 42n, dev: 7n } })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(link)
    expect(calls).toEqual(['unlink:' + link, 'link:' + link])
  })

  it('does not trust a zero file id, which proves nothing', () => {
    const { fs, calls } = fsWith({ [exe]: { ino: 0n, dev: 7n }, [link]: { ino: 0n, dev: 7n } })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(link)
    expect(calls).toEqual(['unlink:' + link, 'link:' + link])
  })

  it('creates the link when it is absent', () => {
    const { fs, calls } = fsWith({ [exe]: { ino: 42n, dev: 7n } })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(link)
    expect(calls).toEqual(['link:' + link])
  })

  it('falls back to execPath when the link cannot be created', () => {
    // A read-only install dir, a filesystem without hard links, a directory squatting the name.
    const { fs } = fsWith({ [exe]: { ino: 42n, dev: 7n } }, {
      linkSync: () => {
        throw new Error('EPERM')
      }
    })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(exe)
  })

  it('falls back when the binary itself cannot be stat-ed', () => {
    const { fs, calls } = fsWith({})
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(exe)
    expect(calls).toEqual([])
  })

  it('still tries to link when an unremovable file holds the name', () => {
    // unlink fails, link then fails too, and the caller gets today's behaviour rather than a throw.
    const { fs } = fsWith({ [exe]: { ino: 99n, dev: 7n }, [link]: { ino: 42n, dev: 7n } }, {
      unlinkSync: () => {
        throw new Error('EBUSY')
      },
      linkSync: () => {
        throw new Error('EEXIST')
      }
    })
    expect(hostLauncherPath(exe, 'win32', fs)).toBe(exe)
  })
})
