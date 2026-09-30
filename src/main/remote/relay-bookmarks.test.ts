// src/main/remote/relay-bookmarks.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BookmarkStore, publicBookmark, type RelayBookmark } from './relay-bookmarks'
import { testTmpDir } from '../../core/test-tmp'

const tmpFile = () => path.join(testTmpDir('bm-'), 'relay-bookmarks.json')
const b: RelayBookmark = { hostId: 'H', code: 'nodeterm://join?code=x', label: 'box', deviceToken: null, approvedAt: null, source: 'code' }

describe('relay bookmarks', () => {
  it('upserts by hostId and removes', async () => {
    const s = new BookmarkStore(tmpFile())
    await s.upsert(b)
    await s.upsert({ ...b, approvedAt: '2026-09-28T00:00:00Z' })
    expect(await s.list()).toEqual([{ ...b, approvedAt: '2026-09-28T00:00:00Z' }])
    await s.remove('H')
    expect(await s.list()).toEqual([])
  })

  // POSIX permission bits: Windows has no 0600 (ACLs decide there), so the mode is not observable.
  it.skipIf(process.platform === 'win32')('persists 0600, because a bookmark holds a device token', async () => {
    const file = tmpFile()
    const s = new BookmarkStore(file)
    await s.upsert({ ...b, deviceToken: 'DT' })
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    // Rewrites keep it (each write is a fresh temp file renamed over the old one).
    await s.upsert({ ...b, hostId: 'H2' })
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
  })

  it('a corrupt file reads as empty for display, and no write ever replaces it', async () => {
    // A corrupt file may still hold other teams' tokens and approvals: unknown trust state is never
    // overwritten, so every write refuses until the file is readable again.
    const file = tmpFile()
    fs.writeFileSync(file, 'nope')
    const s = new BookmarkStore(file)
    expect(await s.list()).toEqual([])
    await expect(s.upsert(b)).rejects.toThrow()
    await expect(s.update('H', { approvedAt: 'now' })).rejects.toThrow()
    await expect(s.remove('H')).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('nope')
  })

  it('a file with a malformed entry is refused for writes too (that entry would be dropped)', async () => {
    const file = tmpFile()
    const raw = JSON.stringify([b, { hostId: 'X' }])
    fs.writeFileSync(file, raw)
    const s = new BookmarkStore(file)
    await expect(s.upsert({ ...b, hostId: 'H2' })).rejects.toThrow()
    fs.writeFileSync(file, JSON.stringify({ not: 'a list' }))
    await expect(s.upsert(b)).rejects.toThrow()
    fs.writeFileSync(file, raw)
    await expect(s.remove('H')).rejects.toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })

  it('readForWrite: none on a missing file; a refusal never quotes the file (it holds tokens)', async () => {
    const file = tmpFile()
    const s = new BookmarkStore(file)
    expect(await s.readForWrite()).toEqual([])
    // An unquoted token: V8's JSON.parse error QUOTES the text around it ('..."ceToken": SECRET-TOK"...').
    fs.writeFileSync(file, '[{"deviceToken": SECRET-TOKEN}]')
    const err = await s.readForWrite().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('SECRET')
  })

  it('R39: a directory no write could land in is refused for writes, and the refusal names why', async () => {
    // A readable file on a read-only mount: the read succeeds, every write would fail. The probe a
    // join runs before minting must see that, or each launch spends a device mint it cannot keep.
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify([b]))
    const seen: Array<[string, number]> = []
    const s = new BookmarkStore(file, {
      access: async (p, mode) => {
        seen.push([p, mode])
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
      }
    })
    const err = await s.readForWrite().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/EROFS/)
    expect(seen).toEqual([[path.dirname(file), fs.constants.W_OK]])
    await expect(s.upsert({ ...b, hostId: 'H2' })).rejects.toThrow(/EROFS/)
    // Display is unaffected: reading is still fine.
    expect(await s.list()).toEqual([b])
  })

  it('R39: the directory check passes on an ordinary writable directory (the default seam)', async () => {
    const s = new BookmarkStore(tmpFile())
    expect(await s.readForWrite()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('an unreadable file (not a missing one) is refused for writes', async () => {
    // A directory where the file should be: reading it fails with EISDIR, which is not absence.
    const file = tmpFile()
    fs.mkdirSync(file)
    await expect(new BookmarkStore(file).upsert(b)).rejects.toThrow()
  })

  it('drops malformed entries on read', async () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify([b, { hostId: 'X' }, null, { ...b, hostId: 'Y', source: 'phone' }, { ...b, hostId: 'Z', deviceToken: 5 }]))
    expect(await new BookmarkStore(file).list()).toEqual([b])
  })

  it('concurrent writes are serialized, none is lost', async () => {
    const s = new BookmarkStore(tmpFile())
    await Promise.all(['A', 'B', 'C', 'D'].map((hostId) => s.upsert({ ...b, hostId })))
    expect((await s.list()).map((x) => x.hostId).sort()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('update applies only when the stored bookmark still satisfies the caller\'s condition', async () => {
    const s = new BookmarkStore(tmpFile())
    await s.upsert({ ...b, deviceToken: 'NEWER' })
    await s.update('H', { approvedAt: 'now' }, (x) => x.deviceToken === 'OLDER')
    expect((await s.list())[0].approvedAt).toBeNull()
    await s.update('H', { approvedAt: 'now' }, (x) => x.deviceToken === 'NEWER')
    expect((await s.list())[0].approvedAt).toBe('now')
  })

  it('update patches an existing bookmark and never creates one', async () => {
    const s = new BookmarkStore(tmpFile())
    await s.update('H', { approvedAt: 'now' })
    expect(await s.list()).toEqual([])
    await s.upsert(b)
    await s.update('H', { approvedAt: 'now', deviceToken: 'DT' })
    expect(await s.list()).toEqual([{ ...b, approvedAt: 'now', deviceToken: 'DT' }])
  })

  it('the renderer\'s view of a bookmark never carries its device token', () => {
    const shown = publicBookmark({ ...b, deviceToken: 'SECRET', approvedAt: '2026-09-28T00:00:00Z' })
    expect(shown).toEqual({ hostId: 'H', label: 'box', approved: true, code: 'nodeterm://join?code=x' })
    expect(JSON.stringify(shown)).not.toContain('SECRET')
    expect(publicBookmark(b).approved).toBe(false)
  })
})
