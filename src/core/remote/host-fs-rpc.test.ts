import { describe, it, expect } from 'vitest'
import { browseHostDirectory, isWithinRootsFor, type BrowseFs } from './host-fs-rpc'

describe('isWithinRootsFor — the relay fs jail, in the host’s own path dialect', () => {
  it('POSIX keeps the historical rule', () => {
    expect(isWithinRootsFor('/work/a/b', ['/work'], 'linux')).toBe(true)
    expect(isWithinRootsFor('/work', ['/work'], 'linux')).toBe(true)
    expect(isWithinRootsFor('/work/../etc/passwd', ['/work'], 'linux')).toBe(false)
    expect(isWithinRootsFor('/workshop', ['/work'], 'linux')).toBe(false)
    // Case-SENSITIVE on POSIX.
    expect(isWithinRootsFor('/Work/a', ['/work'], 'darwin')).toBe(false)
    expect(isWithinRootsFor('', ['/work'], 'linux')).toBe(false)
  })
  it('win32: case-insensitive, either separator', () => {
    const roots = ['C:\\Users\\me\\repo']
    expect(isWithinRootsFor('c:\\users\\ME\\repo\\src', roots, 'win32')).toBe(true)
    expect(isWithinRootsFor('C:/Users/me/repo/src/x.ts', roots, 'win32')).toBe(true)
    expect(isWithinRootsFor('C:\\Users\\me\\repo', roots, 'win32')).toBe(true)
  })
  it('win32: `..` traversal, another drive, a sibling prefix are outside', () => {
    const roots = ['C:\\Users\\me\\repo']
    expect(isWithinRootsFor('C:\\Users\\me\\repo\\..\\secrets', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('D:\\Users\\me\\repo\\x', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('C:\\Users\\me\\repository', roots, 'win32')).toBe(false)
  })
  it('win32: UNC, device and drive-relative paths are refused whole', () => {
    const roots = ['C:\\Users\\me\\repo']
    expect(isWithinRootsFor('\\\\server\\share\\repo', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('//server/share', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('\\\\?\\C:\\Users\\me\\repo\\x', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('\\Users\\me\\repo\\x', roots, 'win32')).toBe(false)
    expect(isWithinRootsFor('C:Users\\me\\repo', roots, 'win32')).toBe(false)
    // …and a UNC ROOT never jails anything in.
    expect(isWithinRootsFor('\\\\server\\share\\x', ['\\\\server\\share'], 'win32')).toBe(false)
  })
})

function fakeFs(tree: Record<string, Array<{ name: string; dir: boolean }>>, gits: string[] = []): BrowseFs {
  return {
    readdir: async (d) => {
      const list = tree[d]
      if (!list) throw new Error('ENOENT')
      return list.map((e) => ({ name: e.name, isDirectory: () => e.dir }))
    },
    exists: async (p) => gits.includes(p)
  }
}

describe('browseHostDirectory — directories only, jailed to home', () => {
  const home = 'C:\\Users\\me'
  const fs = fakeFs(
    {
      'C:\\Users\\me': [
        { name: 'repo', dir: true },
        { name: '.ssh', dir: true },
        { name: 'notes.txt', dir: false },
        { name: 'Apps', dir: true }
      ],
      'C:\\Users\\me\\repo': []
    },
    ['C:\\Users\\me\\repo\\.git']
  )

  it('lists the home by default: directories only, hidden skipped, git marked, no parent past home', async () => {
    const res = await browseHostDirectory(undefined, { platform: 'win32', home, fs })
    expect(res).toEqual({
      path: 'C:\\Users\\me',
      parent: null,
      truncated: false,
      entries: [
        { name: 'Apps', dir: true, git: false },
        { name: 'repo', dir: true, git: true }
      ]
    })
  })
  it('a child reports its parent; separators normalize to win32', async () => {
    const res = await browseHostDirectory('C:/Users/me/repo', { platform: 'win32', home, fs })
    expect(res?.path).toBe('C:\\Users\\me\\repo')
    expect(res?.parent).toBe('C:\\Users\\me')
  })
  it('the home jail is case-insensitive on win32 (NTFS)', async () => {
    const res = await browseHostDirectory('c:\\users\\ME', { platform: 'win32', home, fs: fakeFs({ 'c:\\users\\ME': [] }) })
    expect(res?.entries).toEqual([])
  })
  it('refuses outside home, another drive, UNC, traversal and relative paths', async () => {
    for (const p of ['C:\\Windows', 'D:\\Users\\me', '\\\\srv\\share', 'C:\\Users\\me\\..\\other', 'repo']) {
      expect(await browseHostDirectory(p, { platform: 'win32', home, fs })).toBeNull()
    }
  })
  it('caps the listing', async () => {
    const many = fakeFs({ '/home/u': Array.from({ length: 7 }, (_, i) => ({ name: `d${i}`, dir: true })) })
    const res = await browseHostDirectory('/home/u', { platform: 'linux', home: '/home/u', fs: many, maxEntries: 3 })
    expect(res?.entries.map((e) => e.name)).toEqual(['d0', 'd1', 'd2'])
    expect(res?.truncated).toBe(true)
  })
  it('an unreadable directory is null, not an empty listing', async () => {
    expect(await browseHostDirectory('/home/u/gone', { platform: 'linux', home: '/home/u', fs: fakeFs({}) })).toBeNull()
  })
})
