// linkSharedEntry: the POSIX leg is a plain symlink exactly as before; the Windows leg (deps
// injected, so it runs here on Linux) never lets one unprivileged link block an account add.
import { describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { constants } from 'fs'
import os from 'os'
import path from 'path'
import { linkSharedEntry, type SharedEntryLinkDeps } from './shared-entry-link'

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
const stats = (dir: boolean) => ({ isDirectory: () => dir, isSymbolicLink: () => false })

function fakeDeps(over: Partial<SharedEntryLinkDeps> & { dir?: boolean } = {}): SharedEntryLinkDeps {
  return {
    platform: 'win32',
    lstat: vi.fn(async () => stats(!!over.dir)),
    stat: vi.fn(async () => stats(!!over.dir)),
    symlink: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
    copyFile: vi.fn(async () => {}),
    warn: vi.fn(),
    ...over
  }
}

describe('linkSharedEntry — win32', () => {
  it('a directory is a junction (no privilege needed)', async () => {
    const deps = fakeDeps({ dir: true })
    expect(await linkSharedEntry('C:\\s\\skills', 'C:\\t\\skills', deps)).toBe('junction')
    expect(deps.symlink).toHaveBeenCalledWith('C:\\s\\skills', 'C:\\t\\skills', 'junction')
  })

  it('a file whose symlink is refused (EPERM) becomes a hardlink', async () => {
    const deps = fakeDeps({ symlink: vi.fn(async () => Promise.reject(err('EPERM'))) })
    expect(await linkSharedEntry('s', 't', deps)).toBe('hardlink')
    expect(deps.symlink).toHaveBeenCalledWith('s', 't', 'file')
    expect(deps.link).toHaveBeenCalledWith('s', 't')
    expect(deps.copyFile).not.toHaveBeenCalled()
    expect(deps.warn).not.toHaveBeenCalled()
  })

  it('EPERM symlink + EXDEV hardlink ⇒ an exclusive copy, with a drift warning', async () => {
    const deps = fakeDeps({
      symlink: vi.fn(async () => Promise.reject(err('EPERM'))),
      link: vi.fn(async () => Promise.reject(err('EXDEV')))
    })
    expect(await linkSharedEntry('s', 't', deps)).toBe('copy')
    expect(deps.copyFile).toHaveBeenCalledWith('s', 't', constants.COPYFILE_EXCL)
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('COPY'))
  })

  it('an unexpected error is logged and skipped, never thrown', async () => {
    const deps = fakeDeps({ symlink: vi.fn(async () => Promise.reject(err('EIO'))) })
    await expect(linkSharedEntry('s', 't', deps)).resolves.toBe('skipped')
    expect(deps.warn).toHaveBeenCalledTimes(1)
    const copyFails = fakeDeps({
      symlink: vi.fn(async () => Promise.reject(err('EPERM'))),
      link: vi.fn(async () => Promise.reject(err('EXDEV'))),
      copyFile: vi.fn(async () => Promise.reject(err('EBUSY')))
    })
    await expect(linkSharedEntry('s', 't', copyFails)).resolves.toBe('skipped')
  })

  it('a missing source makes no link call at all', async () => {
    const deps = fakeDeps({ lstat: vi.fn(async () => Promise.reject(err('ENOENT'))) })
    expect(await linkSharedEntry('s', 't', deps)).toBe('skipped')
    expect(deps.symlink).not.toHaveBeenCalled()
    expect(deps.warn).not.toHaveBeenCalled()
  })

  it('an existing target is a silent skip (no hardlink/copy over it)', async () => {
    const deps = fakeDeps({ symlink: vi.fn(async () => Promise.reject(err('EEXIST'))) })
    expect(await linkSharedEntry('s', 't', deps)).toBe('skipped')
    expect(deps.link).not.toHaveBeenCalled()
    expect(deps.warn).not.toHaveBeenCalled()
    const viaLink = fakeDeps({
      symlink: vi.fn(async () => Promise.reject(err('EPERM'))),
      link: vi.fn(async () => Promise.reject(err('EEXIST')))
    })
    expect(await linkSharedEntry('s', 't', viaLink)).toBe('skipped')
    expect(viaLink.copyFile).not.toHaveBeenCalled()
  })
})

describe('linkSharedEntry — POSIX (unchanged behavior)', () => {
  it('is an untyped symlink and still throws an unexpected error', async () => {
    for (const p of ['linux', 'darwin'] as const) {
      const deps = fakeDeps({ platform: p })
      expect(await linkSharedEntry('/s/config.toml', '/t/config.toml', deps)).toBe('symlink')
      expect(deps.symlink).toHaveBeenCalledWith('/s/config.toml', '/t/config.toml')
      expect(deps.stat).not.toHaveBeenCalled()
      const failing = fakeDeps({ platform: p, symlink: vi.fn(async () => Promise.reject(err('EPERM'))) })
      await expect(linkSharedEntry('/s', '/t', failing)).rejects.toThrow('EPERM')
      expect(failing.link).not.toHaveBeenCalled()
    }
  })

  it.skipIf(process.platform === 'win32')('real fs: files and directories resolve through the link', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-shared-entry-'))
    try {
      mkdirSync(path.join(root, 'src', 'skills'), { recursive: true })
      writeFileSync(path.join(root, 'src', 'config.toml'), 'model = "x"\n')
      mkdirSync(path.join(root, 'dst'))
      await linkSharedEntry(path.join(root, 'src', 'config.toml'), path.join(root, 'dst', 'config.toml'))
      await linkSharedEntry(path.join(root, 'src', 'skills'), path.join(root, 'dst', 'skills'))
      expect(await linkSharedEntry(path.join(root, 'src', 'absent'), path.join(root, 'dst', 'absent'))).toBe(
        'skipped'
      )
      expect(lstatSync(path.join(root, 'dst', 'skills')).isSymbolicLink()).toBe(true)
      expect(readFileSync(path.join(root, 'dst', 'config.toml'), 'utf8')).toBe('model = "x"\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('linkSharedEntry — real Windows', () => {
  it.skipIf(process.platform !== 'win32')('links a dir and a file without the symlink privilege', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nt-shared-entry-'))
    try {
      mkdirSync(path.join(root, 'src', 'skills'), { recursive: true })
      writeFileSync(path.join(root, 'src', 'config.toml'), 'a')
      mkdirSync(path.join(root, 'dst'))
      expect(await linkSharedEntry(path.join(root, 'src', 'skills'), path.join(root, 'dst', 'skills'))).toBe(
        'junction'
      )
      expect(
        await linkSharedEntry(path.join(root, 'src', 'config.toml'), path.join(root, 'dst', 'config.toml'))
      ).not.toBe('skipped')
      expect(readFileSync(path.join(root, 'dst', 'config.toml'), 'utf8')).toBe('a')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
