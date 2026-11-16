import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { testTmpDir } from './test-tmp'
import { isRetiredLiveLinkFile, removeRetiredLiveLinkData } from './retired-data-cleanup'

const RETIRED = [
  'watch-links.json',
  'watch-links.json.corrupt-1767225600000',
  'watch-links.json.tmp',
  'watch-links.json.4242.7.tmp',
  'watch-links.json.4242.7.0b9c8f2e-1d3a-4c5b-9e7f-0123456789ab.tmp'
]
const LOOK_ALIKES = [
  'watch-links.json.bak',
  'my-watch-links.json',
  'watch-links.jsonx',
  'watch-links.json.corrupt-',
  'watch-links.json.corrupt-1.bak',
  'watch-links.json.x.tmp'
]

describe('isRetiredLiveLinkFile', () => {
  it('matches the store, its sidelines and its atomic-write temps, and nothing else', () => {
    for (const name of RETIRED) expect(isRetiredLiveLinkFile(name), name).toBe(true)
    for (const name of LOOK_ALIKES) expect(isRetiredLiveLinkFile(name), name).toBe(false)
  })
})

describe('removeRetiredLiveLinkData', () => {
  it('removes the store, its sidelines and its temps', async () => {
    const dir = testTmpDir('retired-data-')
    for (const name of [...RETIRED, ...LOOK_ALIKES]) fs.writeFileSync(path.join(dir, name), 'x')
    const warn = vi.fn()
    expect(await removeRetiredLiveLinkData(dir, warn)).toBe(5)
    for (const name of RETIRED) expect(fs.existsSync(path.join(dir, name)), name).toBe(false)
    for (const name of LOOK_ALIKES) expect(fs.existsSync(path.join(dir, name)), name).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves a directory with a matching name alone', async () => {
    const dir = testTmpDir('retired-data-')
    fs.mkdirSync(path.join(dir, 'watch-links.json.corrupt-1'))
    expect(await removeRetiredLiveLinkData(dir, vi.fn())).toBe(0)
    expect(fs.statSync(path.join(dir, 'watch-links.json.corrupt-1')).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('removes a symlink as a link and never touches its target', async () => {
    // Skipped on Windows: creating a symlink there needs Developer Mode or elevation.
    const dir = testTmpDir('retired-data-')
    const outside = testTmpDir('retired-target-')
    const target = path.join(outside, 'target.json')
    fs.writeFileSync(target, 'keep me')
    fs.symlinkSync(target, path.join(dir, 'watch-links.json'))
    expect(await removeRetiredLiveLinkData(dir, vi.fn())).toBe(1)
    expect(fs.existsSync(path.join(dir, 'watch-links.json'))).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
  })

  it('does not recurse', async () => {
    const dir = testTmpDir('retired-data-')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'watch-links.json'), 'x')
    expect(await removeRetiredLiveLinkData(dir, vi.fn())).toBe(0)
    expect(fs.existsSync(path.join(dir, 'sub', 'watch-links.json'))).toBe(true)
  })

  it('an absent dir answers 0 and warns nothing', async () => {
    const warn = vi.fn()
    expect(await removeRetiredLiveLinkData(path.join(testTmpDir('retired-data-'), 'missing'), warn)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  // Skipped on Windows (chmod does not make a directory unreadable there) and as root (root reads
  // a mode-000 directory anyway, so the error path cannot be reached).
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable dir answers 0, warns once, never throws',
    async () => {
      const dir = testTmpDir('retired-data-')
      fs.writeFileSync(path.join(dir, 'watch-links.json'), 'x')
      fs.chmodSync(dir, 0o000)
      const warn = vi.fn()
      try {
        expect(await removeRetiredLiveLinkData(dir, warn)).toBe(0)
      } finally {
        fs.chmodSync(dir, 0o700)
      }
      expect(warn).toHaveBeenCalledTimes(1)
    }
  )

  it('a failed unlink is reported once with a count and a code, never a file body', async () => {
    const dir = testTmpDir('retired-data-')
    fs.writeFileSync(path.join(dir, 'watch-links.json'), 'SECRET-BODY')
    fs.writeFileSync(path.join(dir, 'watch-links.json.tmp'), 'SECRET-BODY')
    const warn = vi.fn()
    const unlink = vi.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EPERM' }))
    try {
      expect(await removeRetiredLiveLinkData(dir, warn)).toBe(0)
    } finally {
      unlink.mockRestore()
    }
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('2')
    expect(message).toContain('EPERM')
    expect(message).not.toContain('SECRET-BODY')
  })
})
