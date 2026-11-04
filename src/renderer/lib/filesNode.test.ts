import { describe, expect, it } from 'vitest'
import {
  breadcrumbs,
  childOnPath,
  childPath,
  classifyEmptyListing,
  displacedFilesPatch,
  downloadMenuEntries,
  fileOpenTarget,
  filterEntries,
  folderTitle,
  listKeyAction,
  parentDir,
  scrollTopToReveal,
  TYPEAHEAD_RESET_MS,
  typeAhead,
  typeAheadIndex
} from './filesNode'

describe('breadcrumbs', () => {
  it('walks a shallow path in full', () => {
    expect(breadcrumbs('/a/b')).toEqual([
      { name: '/', path: '/' },
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' }
    ])
  })

  it('is just root at the root', () => {
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })

  it('collapses a deep path but keeps every crumb navigable', () => {
    const crumbs = breadcrumbs('/one/two/three/four/five/six', 3)
    expect(crumbs.map((c) => c.name)).toEqual(['/', '…', 'four', 'five', 'six'])
    // The ellipsis is not decoration: it goes to the deepest directory it hid, so a user can
    // climb back out one level at a time instead of being teleported to root.
    expect(crumbs[1].path).toBe('/one/two/three')
    expect(crumbs[crumbs.length - 1].path).toBe('/one/two/three/four/five/six')
  })

  it('does not collapse a path that exactly fits', () => {
    expect(breadcrumbs('/a/b/c', 3).map((c) => c.name)).toEqual(['/', 'a', 'b', 'c'])
  })

  // An SSH project's remoteCwd DEFAULTS to `~`, so a remote files node routinely stands on a
  // `~`-relative path. Prefixing `/` to such crumbs produced `/~/remotion-app` — a literal path
  // that does not exist on the host — so clicking any crumb but the last answered "Could not
  // reach this folder." The crumbs must keep the path's own root instead of inventing one.
  it('keeps a ~-relative path relative (no invented / root)', () => {
    expect(breadcrumbs('~/remotion-app/OUT-1.0.14')).toEqual([
      { name: '~', path: '~' },
      { name: 'remotion-app', path: '~/remotion-app' },
      { name: 'OUT-1.0.14', path: '~/remotion-app/OUT-1.0.14' }
    ])
  })

  it('is just home at a bare ~', () => {
    expect(breadcrumbs('~')).toEqual([{ name: '~', path: '~' }])
  })

  it('collapses a deep relative path without an absolute ellipsis target', () => {
    const crumbs = breadcrumbs('~/one/two/three/four/five', 3)
    expect(crumbs.map((c) => c.name)).toEqual(['~', '…', 'three', 'four', 'five'])
    expect(crumbs[1].path).toBe('~/one/two')
    expect(crumbs[crumbs.length - 1].path).toBe('~/one/two/three/four/five')
  })
})

describe('folderTitle', () => {
  it('names the directory', () => expect(folderTitle('/home/me/repo')).toBe('repo'))
  it('names the root', () => expect(folderTitle('/')).toBe('/'))
  it('ignores a trailing slash', () => expect(folderTitle('/home/me/repo/')).toBe('repo'))
})

describe('childPath', () => {
  it('joins normally', () => expect(childPath('/a/b', 'c.ts')).toBe('/a/b/c.ts'))
  it('does not double the separator at the root', () => expect(childPath('/', 'etc')).toBe('/etc'))
  it('absorbs a trailing slash', () => expect(childPath('/a/', 'b')).toBe('/a/b'))
})

describe('parentDir', () => {
  it('climbs one level', () => expect(parentDir('/a/b/c')).toBe('/a/b'))
  it('stops at the root', () => expect(parentDir('/a')).toBe('/'))
  it('stays at the root', () => expect(parentDir('/')).toBe('/'))
})

describe('filterEntries', () => {
  const entries = [{ name: 'README.md' }, { name: 'src' }, { name: 'package.json' }]

  it('matches case-insensitively anywhere in the name', () => {
    expect(filterEntries(entries, 'age').map((e) => e.name)).toEqual(['package.json'])
    expect(filterEntries(entries, 'readme').map((e) => e.name)).toEqual(['README.md'])
  })

  // The bug this pins: select-all + delete leaves '' (or a stray space), and a filter that treats
  // that as "match nothing" blanks the whole listing with no way to tell why.
  it('matches everything for an empty or whitespace query', () => {
    expect(filterEntries(entries, '')).toEqual(entries)
    expect(filterEntries(entries, '   ')).toEqual(entries)
  })

  it('can legitimately match nothing', () => {
    expect(filterEntries(entries, 'zzz')).toEqual([])
  })
})

describe('fileOpenTarget', () => {
  it('opens text and images on the canvas', () => {
    expect(fileOpenTarget('/a/notes.md')).toBe('canvas')
    expect(fileOpenTarget('/a/logo.png')).toBe('canvas')
    expect(fileOpenTarget('/a/Makefile')).toBe('canvas')
  })

  it('opens video on the canvas (the video node, not Monaco)', () => {
    expect(fileOpenTarget('/a/clip.mp4')).toBe('canvas')
    expect(fileOpenTarget('/a/clip.mov')).toBe('canvas')
  })

  it('hands binaries and archives to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg')).toBe('os')
    expect(fileOpenTarget('/a/bundle.zip')).toBe('os')
    expect(fileOpenTarget('/a/data.sqlite')).toBe('os')
  })

  // shell.openPath opens a path on THIS machine. For a remote listing that is either a silent
  // no-op or, if the path happens to exist locally too, an unrelated local file.
  it('never hands a remote path to the OS', () => {
    expect(fileOpenTarget('/a/installer.dmg', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/bundle.zip', { remote: true })).toBe('canvas')
    expect(fileOpenTarget('/a/notes.md', { remote: true })).toBe('canvas')
  })
})

describe('classifyEmptyListing', () => {
  const parent = [{ name: 'docs' }, { name: 'src' }, { name: 'README.md' }]

  // The case the fourth empty state exists for, and could not reach before: a removed worktree.
  // `listDir` answers [] for a directory that is gone, exactly as it does for an empty one.
  it('says missing when the parent lists real entries and ours is not among them', () => {
    expect(classifyEmptyListing('/repo/gone', parent)).toBe('missing')
  })

  it('says empty when the parent lists us — the folder is there and simply has nothing in it', () => {
    expect(classifyEmptyListing('/repo/docs', parent)).toBe('empty')
    expect(classifyEmptyListing('/repo/docs/', parent)).toBe('empty')
  })

  // The parent contains us, so it cannot legitimately be childless: an empty listing means we
  // could not see it. That is real information, and reporting it as `unknown` let the node say
  // "This folder is empty." over a dead ControlMaster, which is the commonest cause of an empty
  // remote listing.
  it('says unreachable when the parent itself came back empty', () => {
    expect(classifyEmptyListing('/repo/docs', [])).toBe('unreachable')
  })

  it('says unreachable when the parent could not be asked at all', () => {
    expect(classifyEmptyListing('/repo/docs', null)).toBe('unreachable')
  })

  // The distinction that keeps `unreachable` honest: a path whose parent could never answer is
  // still `unknown`, so a `~` root or a `.git` cwd does not start claiming the host is down.
  it('keeps unknown for the paths no parent listing could ever answer', () => {
    expect(classifyEmptyListing('~', null)).toBe('unknown')
    expect(classifyEmptyListing('~', [])).toBe('unknown')
    expect(classifyEmptyListing('/repo/.git', [])).toBe('unknown')
    expect(classifyEmptyListing('relative/dir', [])).toBe('unknown')
  })

  // Root has no parent to interrogate and always exists.
  it('says empty at the root rather than interrogating a parent that does not exist', () => {
    expect(classifyEmptyListing('/', null)).toBe('empty')
    expect(classifyEmptyListing('/', [])).toBe('empty')
  })

  // Every case below would name-match FAIL and be reported as a deletion. Each is a readable
  // directory, so `unknown` (which renders as "empty") is the only honest answer.

  // The one that shipped: an SSH project's remoteCwd DEFAULTS to `~`. `ls ~` works, but
  // parentDir('~') is '/' and '/' has no entry named '~' — so an empty remote HOME reported
  // "Could not read this folder."
  it('never calls a non-absolute path missing — `~` is an SSH project default, not a deletion', () => {
    expect(classifyEmptyListing('~', [{ name: 'bin' }, { name: 'etc' }])).toBe('unknown')
    expect(classifyEmptyListing('~/src', [{ name: 'bin' }])).toBe('unknown')
    expect(classifyEmptyListing('relative/dir', [{ name: 'bin' }])).toBe('unknown')
  })

  // Both listing legs strip `.git` on purpose, so a node pointed at one can never find itself.
  it('never calls a .git directory missing — both listing legs filter it out', () => {
    expect(classifyEmptyListing('/repo/.git', [{ name: 'src' }, { name: 'README.md' }])).toBe('unknown')
  })

  it('never calls a dot segment missing — readdir and `ls -A` do not emit them', () => {
    expect(classifyEmptyListing('/repo/.', [{ name: 'src' }])).toBe('unknown')
    expect(classifyEmptyListing('/repo/..', [{ name: 'src' }])).toBe('unknown')
  })

  // APFS/NTFS list a directory fine under the wrong case, but readdir answers with the on-disk
  // spelling. "Missing" has to be the conclusion we are SURE of.
  it('accepts a case-folded match on a case-insensitive filesystem', () => {
    expect(classifyEmptyListing('/repo/Docs', [{ name: 'docs' }])).toBe('empty')
    expect(classifyEmptyListing('/repo/docs', [{ name: 'DOCS' }])).toBe('empty')
  })

  // A symlinked directory can list as a non-dir entry depending on the leg; matching on `dir`
  // would call it missing. Name matching is what keeps that false alarm out.
  it('matches by name, not by entry kind', () => {
    // Real callers pass `DirEntry[]`; a symlinked directory can arrive with `dir: false`.
    const listed: { name: string; dir: boolean }[] = [{ name: 'link', dir: false }]
    expect(classifyEmptyListing('/repo/link', listed)).toBe('empty')
  })
})

describe('displacedFilesPatch', () => {
  it('re-points to the fallback and renames while the title still tracks the folder', () => {
    expect(displacedFilesPatch({}, '/repo/src')).toEqual({ cwd: '/repo/src', title: 'src' })
  })

  // The `titleAuto` contract: a name the user typed is never overwritten by a cwd change,
  // whether that change came from navigating or from a worktree being removed underneath.
  it('leaves a hand-typed title alone', () => {
    expect(displacedFilesPatch({ titleAuto: false }, '/repo/src')).toEqual({ cwd: '/repo/src' })
  })

  // The one that matters: FilesNode reads `data.cwd || '/'`, so writing undefined would make a
  // displaced node silently list the filesystem ROOT. Doing nothing leaves it on the dead path,
  // where the parent-listing probe tells the truth instead.
  it('refuses to write anything when there is no fallback directory', () => {
    expect(displacedFilesPatch({}, undefined)).toBeNull()
    expect(displacedFilesPatch({ titleAuto: false }, '')).toBeNull()
  })
})

describe('downloadMenuEntries', () => {
  const labels = (...a: Parameters<typeof downloadMenuEntries>) => downloadMenuEntries(...a).map((e) => e.label)

  it('offers nothing where the listing cannot be downloaded from (desktop local, relay)', () => {
    expect(downloadMenuEntries('none', '/srv/app/a.txt', { dir: false, here: false })).toEqual([])
  })

  it('offers nothing for the filesystem root — the HTTP route would tar the whole server', () => {
    expect(downloadMenuEntries('http', '/', { dir: true, here: true })).toEqual([])
    expect(downloadMenuEntries('scp', '/', { dir: true, here: true })).toEqual([])
  })

  it('offers Download and Download to… for a file on an SSH host', () => {
    expect(labels('scp', '/srv/app/a.txt', { dir: false, here: false })).toEqual(['Download', 'Download to…'])
    expect(downloadMenuEntries('scp', '/srv/app/a.txt', { dir: false, here: false })[1].pickFolder).toBe(true)
  })

  it('says a folder arrives as a .tar.gz in the browser, and offers no folder picker there', () => {
    expect(labels('http', '/srv/app/src', { dir: true, here: false })).toEqual(['Download folder (.tar.gz)'])
  })

  it('names the folder being shown when the menu was opened on empty space', () => {
    expect(labels('scp', '/srv/app/src', { dir: true, here: true })).toEqual([
      'Download this folder',
      'Download to…'
    ])
    expect(labels('http', '/srv/app/src', { dir: true, here: true })).toEqual(['Download this folder (.tar.gz)'])
  })
})

describe('typeAheadIndex', () => {
  const names = ['alpha', 'Apple', 'beta', 'banana', 'build', 'çiçek']

  it('jumps to the first entry starting with a letter, case-insensitively', () => {
    expect(typeAheadIndex(names, -1, 'b')).toBe(2)
    expect(typeAheadIndex(names, -1, 'A')).toBe(0)
  })

  it('cycles through the entries sharing a letter when the letter is pressed again (Windows)', () => {
    expect(typeAheadIndex(names, 2, 'b')).toBe(3)
    expect(typeAheadIndex(names, 3, 'b')).toBe(4)
    expect(typeAheadIndex(names, 4, 'b')).toBe(2) // wraps
    // A fast "bb" is still cycling, not a search for a name starting with "bb".
    expect(typeAheadIndex(names, 2, 'bb')).toBe(3)
  })

  it('treats a typed word as a prefix and keeps the current entry while it still matches', () => {
    expect(typeAheadIndex(names, -1, 'ba')).toBe(3)
    expect(typeAheadIndex(names, 3, 'ban')).toBe(3)
    expect(typeAheadIndex(names, 2, 'bu')).toBe(4)
  })

  it('matches non-ASCII names', () => {
    expect(typeAheadIndex(names, -1, 'ç')).toBe(5)
  })

  it('reports no match rather than moving somewhere arbitrary', () => {
    expect(typeAheadIndex(names, 1, 'z')).toBe(-1)
    expect(typeAheadIndex([], -1, 'a')).toBe(-1)
    expect(typeAheadIndex(names, 0, '')).toBe(-1)
  })
})

describe('typeAhead', () => {
  const names = ['alpha', 'beta', 'bravo']

  it('builds a word from keys typed in quick succession', () => {
    const a = typeAhead({ buffer: '', at: 0 }, 'b', 1000, names, -1)
    expect(a.index).toBe(1)
    const b = typeAhead(a.state, 'r', 1200, names, a.index)
    expect(b.state.buffer).toBe('br')
    expect(b.index).toBe(2)
  })

  it('starts a fresh word after a pause', () => {
    const a = typeAhead({ buffer: 'br', at: 1000 }, 'a', 1000 + TYPEAHEAD_RESET_MS + 1, names, 2)
    expect(a.state.buffer).toBe('a')
    expect(a.index).toBe(0)
  })
})

describe('listKeyAction', () => {
  const k = (key: string, mods: { alt?: boolean; meta?: boolean; ctrl?: boolean } = {}) => ({ key, ...mods })

  it('moves the selection with the arrows, clamped at both ends', () => {
    expect(listKeyAction(k('ArrowDown'), 1, 5)).toEqual({ kind: 'select', index: 2 })
    expect(listKeyAction(k('ArrowDown'), 4, 5)).toEqual({ kind: 'select', index: 4 })
    expect(listKeyAction(k('ArrowUp'), 1, 5)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction(k('ArrowUp'), 0, 5)).toEqual({ kind: 'select', index: 0 })
  })

  it('enters the list from nothing selected at the natural end', () => {
    expect(listKeyAction(k('ArrowDown'), -1, 5)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction(k('ArrowUp'), -1, 5)).toEqual({ kind: 'select', index: 4 })
    expect(listKeyAction(k('Home'), 3, 5)).toEqual({ kind: 'select', index: 0 })
    expect(listKeyAction(k('End'), 0, 5)).toEqual({ kind: 'select', index: 4 })
  })

  it('opens the selection with Enter (and ⌘↓, the Finder chord) — never with nothing selected', () => {
    expect(listKeyAction(k('Enter'), 2, 5)).toEqual({ kind: 'open', index: 2 })
    expect(listKeyAction(k('ArrowDown', { meta: true }), 2, 5)).toEqual({ kind: 'open', index: 2 })
    expect(listKeyAction(k('Enter'), -1, 5)).toBeNull()
  })

  it('goes up a folder with Backspace, Alt+↑ (Windows) and ⌘↑ (Finder), even in an empty folder', () => {
    expect(listKeyAction(k('Backspace'), -1, 0)).toEqual({ kind: 'up' })
    expect(listKeyAction(k('ArrowUp', { alt: true }), 2, 5)).toEqual({ kind: 'up' })
    expect(listKeyAction(k('ArrowUp', { meta: true }), 2, 5)).toEqual({ kind: 'up' })
  })

  it('has nothing to select in an empty listing, and leaves other chords alone', () => {
    expect(listKeyAction(k('ArrowDown'), -1, 0)).toBeNull()
    expect(listKeyAction(k('a', { ctrl: true }), 0, 5)).toBeNull()
    expect(listKeyAction(k('Escape'), 0, 5)).toBeNull()
  })
})

describe('childOnPath', () => {
  it('names the entry of an ancestor that leads back to where we were', () => {
    expect(childOnPath('/a', '/a/b/c')).toBe('b')
    expect(childOnPath('/', '/a/b')).toBe('a')
    expect(childOnPath('/a/', '/a/b/')).toBe('b')
    expect(childOnPath('~', '~/proj')).toBe('proj')
  })

  it('is null when the destination is not a strict ancestor', () => {
    expect(childOnPath('/a/b', '/a')).toBeNull()
    expect(childOnPath('/a', '/a')).toBeNull()
    expect(childOnPath('/ab', '/a/b')).toBeNull()
    expect(childOnPath('/x', '/a/b')).toBeNull()
    expect(childOnPath('a', '/a/b')).toBeNull()
  })
})

describe('scrollTopToReveal', () => {
  it('leaves a fully visible row where it is', () => {
    expect(scrollTopToReveal(100, 20, 50, 200)).toBe(50)
  })
  it('scrolls up just enough for a row above the view', () => {
    expect(scrollTopToReveal(30, 20, 50, 200)).toBe(30)
  })
  it('scrolls down just enough for a row below the view', () => {
    expect(scrollTopToReveal(260, 20, 50, 200)).toBe(80)
  })
})
