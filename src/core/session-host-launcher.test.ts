import { describe, it, expect } from 'vitest'
import path from 'path'
import { resolveSessionHostScript } from './session-host-launcher'

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
