import { describe, it, expect } from 'vitest'
import { candidateName, localChildName, safeDownloadBasename, uniqueChildName } from './download-name'

describe('safeDownloadBasename', () => {
  it('takes the basename of a remote path', () => {
    expect(safeDownloadBasename('/srv/app/docs/notes.md')).toBe('notes.md')
    expect(safeDownloadBasename('~/work/report.pdf')).toBe('report.pdf')
    expect(safeDownloadBasename('/srv/app/docs/')).toBe('docs')
  })

  it('refuses paths that name nothing writable', () => {
    for (const p of ['', '/', '.', '..', '~', '/srv/..']) expect(safeDownloadBasename(p)).toBeNull()
  })

  it('neutralizes separators and control characters rather than refusing the download', () => {
    expect(safeDownloadBasename('/srv/a\\b.txt')).toBe('a_b.txt')
    expect(safeDownloadBasename('/srv/we:ird?.txt')).toBe('we_ird_.txt')
    expect(safeDownloadBasename('/srv/nl\nname')).toBe('nl_name')
  })

  it('cannot produce a traversal component', () => {
    // A remote file literally named `..` (or `../x` as one component) must never come back as one.
    expect(safeDownloadBasename('/srv/app/..')).toBeNull()
    expect(safeDownloadBasename('/srv/app/...')).toBe('...')
  })
})

describe('candidateName', () => {
  it('leaves the first attempt alone', () => {
    expect(candidateName('notes.md', 1)).toBe('notes.md')
    expect(candidateName('notes.md', 0)).toBe('notes.md')
  })

  it('numbers before the extension', () => {
    expect(candidateName('notes.md', 2)).toBe('notes (2).md')
    expect(candidateName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
  })

  it('appends at the end when there is no extension to protect', () => {
    expect(candidateName('README', 2)).toBe('README (2)')
    expect(candidateName('.bashrc', 2)).toBe('.bashrc (2)')
  })
})

describe('localChildName', () => {
  it.each([
    ['a:b', 'a_b'],
    ['x?.txt', 'x_.txt'],
    ['q"<>|*', 'q_____'],
    ['a\\b', 'a_b'],
    ['CON', '_CON'],
    ['com1.txt', '_com1.txt'],
    ['Lpt9', '_Lpt9'],
    ['console.log', 'console.log'],
    ['name. ', 'name'],
    ['nul. ', '_nul'],
    ['...', 'download'],
    ['tab\there', 'tab_here']
  ])('win32: %j → %j', (name, want) => {
    expect(localChildName(name, 'win32')).toBe(want)
  })

  it('POSIX hosts keep every name a POSIX filesystem can hold', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const n of ['a:b', 'x?.txt', 'CON', 'com1.txt', 'name. ', 'a\\b']) expect(localChildName(n, platform)).toBe(n)
      // A separator is never a path, anywhere.
      expect(localChildName('a/b', platform)).toBe('a_b')
    }
  })

  it('names nothing for the directory entries', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(localChildName('.', platform)).toBeNull()
      expect(localChildName('..', platform)).toBeNull()
      expect(localChildName('', platform)).toBeNull()
    }
  })
})

describe('uniqueChildName', () => {
  it('win32: case-insensitive, so Foo and foo do not overwrite each other', () => {
    const taken = new Set<string>()
    expect(uniqueChildName('Foo.txt', taken, 'win32')).toBe('Foo.txt')
    expect(uniqueChildName('foo.txt', taken, 'win32')).toBe('foo (2).txt')
    expect(uniqueChildName('FOO.TXT', taken, 'win32')).toBe('FOO (3).TXT')
  })
  it('POSIX: case-sensitive, as the filesystem is', () => {
    const taken = new Set<string>()
    expect(uniqueChildName('Foo', taken, 'linux')).toBe('Foo')
    expect(uniqueChildName('foo', taken, 'linux')).toBe('foo')
    expect(uniqueChildName('foo', taken, 'linux')).toBe('foo (2)')
  })
})
