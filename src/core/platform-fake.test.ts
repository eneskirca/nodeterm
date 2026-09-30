import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FAKE_PLATFORM_ROOT_ENV,
  enterFakePlatformRoot,
  fakePlatform,
  leaveFakePlatformRoot,
  makeFakeUserDataDir
} from './platform-fake'

// Read before any test below re-points it: what the vitest run itself set up.
const runRootAtLoad = process.env[FAKE_PLATFORM_ROOT_ENV]

// fakePlatform() used to mkdtemp a directory in the system temp dir on EVERY call and never remove
// it — ~395,000 of them filled a development server's /tmp inodes. These pin the three halves of the
// fix: made only when read, made under the run's root, and the root removed at the end of the run.
describe('fakePlatform userDataDir', () => {
  let saved: string | undefined
  let root: string

  beforeEach(() => {
    saved = process.env[FAKE_PLATFORM_ROOT_ENV]
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-fake-root-test-'))
    process.env[FAKE_PLATFORM_ROOT_ENV] = root
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[FAKE_PLATFORM_ROOT_ENV]
    else process.env[FAKE_PLATFORM_ROOT_ENV] = saved
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('makes no directory until userDataDir is read', () => {
    fakePlatform()
    fakePlatform()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('makes one fresh directory under the run root on first read, and keeps it', () => {
    const p = fakePlatform()
    const dir = p.userDataDir
    expect(path.dirname(dir)).toBe(root)
    expect(path.basename(dir)).toMatch(/^u-/)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
    expect(p.userDataDir).toBe(dir)
    expect(fakePlatform().userDataDir).not.toBe(dir)
    expect(fs.readdirSync(root)).toHaveLength(2)
  })

  it('makes nothing when the test passes its own userDataDir', () => {
    const p = fakePlatform({ userDataDir: '/nonexistent/own-dir' })
    expect(p.userDataDir).toBe('/nonexistent/own-dir')
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('carries the directory through a spread copy', () => {
    const p = { ...fakePlatform() }
    expect(path.dirname(p.userDataDir)).toBe(root)
    expect(fs.readdirSync(root)).toHaveLength(1)
  })

  it('makeFakeUserDataDir: a fresh directory under the run root each call (own CorePlatforms)', () => {
    const a = makeFakeUserDataDir()
    const b = makeFakeUserDataDir()
    expect(a).not.toBe(b)
    expect(path.dirname(a)).toBe(root)
    expect(path.dirname(b)).toBe(root)
    expect(fs.statSync(a).isDirectory()).toBe(true)
  })

  it('falls back to the system temp dir when the run root is gone', () => {
    fs.rmSync(root, { recursive: true, force: true })
    const dir = fakePlatform().userDataDir
    try {
      expect(path.dirname(dir)).toBe(os.tmpdir())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the run root (test/setup/fake-platform-root.ts)', () => {
  it('is in effect for this run — vitest.config.ts keeps it in globalSetup', () => {
    // Without it every fakePlatform() directory lands in the system temp dir and is never removed.
    expect(runRootAtLoad, 'fake-platform root not set — see test/setup/fake-platform-root.ts').toBeTruthy()
    expect(fs.statSync(runRootAtLoad!).isDirectory()).toBe(true)
  })

  it('removes every directory the run made, and the variable with it', () => {
    const saved = process.env[FAKE_PLATFORM_ROOT_ENV]
    try {
      const runRoot = enterFakePlatformRoot()
      expect(process.env[FAKE_PLATFORM_ROOT_ENV]).toBe(runRoot)
      const dir = fakePlatform().userDataDir
      fs.writeFileSync(path.join(dir, 'state.json'), '{}')
      expect(dir.startsWith(runRoot + path.sep)).toBe(true)
      leaveFakePlatformRoot(runRoot)
      expect(fs.existsSync(runRoot)).toBe(false)
      expect(process.env[FAKE_PLATFORM_ROOT_ENV]).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[FAKE_PLATFORM_ROOT_ENV]
      else process.env[FAKE_PLATFORM_ROOT_ENV] = saved
    }
  })
})
