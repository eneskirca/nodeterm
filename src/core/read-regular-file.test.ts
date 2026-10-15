import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRegularFileNoFollow } from './read-regular-file'

describe('readRegularFileNoFollow', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nt-regular-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a plain regular file', async () => {
    const f = path.join(dir, 'auth.json')
    writeFileSync(f, '{"a":1}')
    await expect(readRegularFileNoFollow(f)).resolves.toBe('{"a":1}')
  })

  it('reads an empty file as the empty string', async () => {
    const f = path.join(dir, 'empty')
    writeFileSync(f, '')
    await expect(readRegularFileNoFollow(f)).resolves.toBe('')
  })

  it('is null for an absent file and a directory', async () => {
    await expect(readRegularFileNoFollow(path.join(dir, 'nope'))).resolves.toBeNull()
    mkdirSync(path.join(dir, 'd'))
    await expect(readRegularFileNoFollow(path.join(dir, 'd'))).resolves.toBeNull()
  })

  it('is null over the cap, and reads exactly at it', async () => {
    const f = path.join(dir, 'big')
    writeFileSync(f, 'x'.repeat(10))
    await expect(readRegularFileNoFollow(f, 9)).resolves.toBeNull()
    await expect(readRegularFileNoFollow(f, 10)).resolves.toBe('x'.repeat(10))
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink to a real file (POSIX only: symlink needs privilege on Windows)', async () => {
    const real = path.join(dir, 'real')
    writeFileSync(real, 'secret')
    const link = path.join(dir, 'link')
    symlinkSync(real, link)
    await expect(readRegularFileNoFollow(link)).resolves.toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO without hanging (POSIX only: mkfifo)', async () => {
    const f = path.join(dir, 'fifo')
    execFileSync('mkfifo', [f])
    await expect(readRegularFileNoFollow(f)).resolves.toBeNull()
  })
})
