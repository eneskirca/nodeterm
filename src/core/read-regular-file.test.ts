import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRegularFileBytesNoFollow, readRegularFileNoFollow } from './read-regular-file'

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

describe('readRegularFileBytesNoFollow', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nt-regular-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Same inode, same size, same mtime, other bytes: what a rename publish onto a just-freed inode
  // in one coarse mtime tick looks like. The stamp is a compare-and-set revision, so it must differ.
  it('the stamp tells apart two files with the same inode, size and mtime', async () => {
    const f = path.join(dir, 'board.excalidraw')
    const stampOf = async (text: string) => {
      writeFileSync(f, text)
      utimesSync(f, 1000, 1000)
      return (await readRegularFileBytesNoFollow(f, 1024, { read: false }))?.stamp
    }
    const a = await stampOf('aa')
    expect(a).toBeTruthy()
    expect(await stampOf('bb')).not.toBe(a)
    expect(await stampOf('aa')).toBe(a)
  })

  it('reading the bytes or not gives the same stamp', async () => {
    const f = path.join(dir, 'board.excalidraw')
    writeFileSync(f, 'x'.repeat(3 * 1024 * 1024 + 7))
    const kept = await readRegularFileBytesNoFollow(f, 4 * 1024 * 1024)
    const statOnly = await readRegularFileBytesNoFollow(f, 4 * 1024 * 1024, { read: false })
    expect(kept?.bytes?.length).toBe(3 * 1024 * 1024 + 7)
    expect(statOnly?.bytes).toBeUndefined()
    expect(statOnly?.stamp).toBe(kept?.stamp)
  })
})
