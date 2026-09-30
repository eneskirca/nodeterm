import { describe, expect, it } from 'vitest'
import {
  iconFileName,
  localIconCwd,
  NODE_GLYPHS,
  nodeIconMime,
  normalizeNodeIcon,
  portableIconPath,
  resolveIconPath
} from './node-icon'
import { LUCIDE_ICON_IDS } from './project-icon'

// The value under test arrives from `.nodeterm/project.json` — git-shared, hand-editable, and on
// an SSH project a file on someone else's host. Every case below is a thing that file can say.
describe('normalizeNodeIcon', () => {
  it('keeps a single emoji', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: 'rocket'.length ? '\u{1F680}' : '' })).toEqual({
      type: 'emoji',
      value: '\u{1F680}'
    })
  })

  it('keeps a ZWJ sequence whole', () => {
    // 11 UTF-16 units. A naive length cap would reject it; a naive slice would cut it into a
    // fragment that renders as two lone people. Neither is acceptable.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
    expect(normalizeNodeIcon({ type: 'emoji', value: family })).toEqual({
      type: 'emoji',
      value: family
    })
  })

  it('truncates a multi-character value to its first grapheme', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: 'abc' })).toEqual({ type: 'emoji', value: 'a' })
  })

  it('caps a blob from a shared file instead of rendering it into every surface', () => {
    const blob = '\u{1F680}'.repeat(5000)
    const out = normalizeNodeIcon({ type: 'emoji', value: blob })
    expect(out).toEqual({ type: 'emoji', value: '\u{1F680}' })
  })

  it('strips control characters rather than letting a paste carry them into a header', () => {
    const withNewline = `${String.fromCharCode(10)}${String.fromCharCode(7)}\u{1F41B}`
    expect(normalizeNodeIcon({ type: 'emoji', value: withNewline })).toEqual({
      type: 'emoji',
      value: '\u{1F41B}'
    })
  })

  it('refuses an emoji that is only whitespace or control characters', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: '   ' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'emoji', value: String.fromCharCode(9) })).toBeUndefined()
  })

  it('refuses shapes that are not an icon at all', () => {
    expect(normalizeNodeIcon(undefined)).toBeUndefined()
    expect(normalizeNodeIcon(null)).toBeUndefined()
    expect(normalizeNodeIcon('\u{1F680}')).toBeUndefined()
    expect(normalizeNodeIcon(42)).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'svg', markup: '<script/>' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'emoji', value: 7 })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: 7 })).toBeUndefined()
  })

  it('keeps an absolute image path with a known extension', () => {
    expect(normalizeNodeIcon({ type: 'image', path: '/tmp/a/logo.PNG' })).toEqual({
      type: 'image',
      path: '/tmp/a/logo.PNG'
    })
  })

  it('keeps a project-relative image path', () => {
    expect(normalizeNodeIcon({ type: 'image', path: './.nodeterm/images/logo.png' })).toEqual({
      type: 'image',
      path: './.nodeterm/images/logo.png'
    })
  })

  // The gate that stops a cloned project.json from aiming fs.readBinary at a private key.
  it('refuses a path that is not an image', () => {
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/.ssh/id_rsa' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/etc/passwd' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/README' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/notes.png.txt' })).toBeUndefined()
  })

  it('refuses a relative path that traverses out of the project', () => {
    expect(normalizeNodeIcon({ type: 'image', path: './../../.ssh/id_rsa.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: './a/../../b.png' })).toBeUndefined()
  })

  it('refuses a rootless path, which has nothing to resolve against', () => {
    expect(normalizeNodeIcon({ type: 'image', path: 'logo.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '../logo.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '' })).toBeUndefined()
  })

  it('refuses a path carrying control characters', () => {
    const sneaky = `/tmp/a${String.fromCharCode(0)}.png`
    expect(normalizeNodeIcon({ type: 'image', path: sneaky })).toBeUndefined()
  })
})

describe('nodeIconMime', () => {
  it('maps known extensions case-insensitively', () => {
    expect(nodeIconMime('/a/b.PNG')).toBe('image/png')
    expect(nodeIconMime('/a/b.jpeg')).toBe('image/jpeg')
    expect(nodeIconMime('./x.svg')).toBe('image/svg+xml')
  })

  it('answers undefined for a name with no extension', () => {
    expect(nodeIconMime('/a/README')).toBeUndefined()
    expect(nodeIconMime('/a/.gitignore')).toBeUndefined()
    expect(nodeIconMime('/a/b.key')).toBeUndefined()
  })
})

describe('portableIconPath', () => {
  it('rewrites a path inside the project to ./ form so it travels with the repo', () => {
    expect(portableIconPath('/repo/.nodeterm/images/a.png', '/repo')).toBe(
      './.nodeterm/images/a.png'
    )
    // A trailing slash on the cwd must not produce a doubled separator or a missed match.
    expect(portableIconPath('/repo/.nodeterm/images/a.png', '/repo/')).toBe(
      './.nodeterm/images/a.png'
    )
  })

  it('leaves a path outside the project absolute', () => {
    expect(portableIconPath('/elsewhere/a.png', '/repo')).toBe('/elsewhere/a.png')
    // A sibling directory that merely shares a prefix is NOT inside the project.
    expect(portableIconPath('/repo-two/a.png', '/repo')).toBe('/repo-two/a.png')
  })

  it('leaves everything absolute when the project has no local cwd', () => {
    expect(portableIconPath('/appdata/canvas-images/a.png', undefined)).toBe(
      '/appdata/canvas-images/a.png'
    )
  })
})

describe('resolveIconPath', () => {
  it('resolves a ./ path against the project cwd', () => {
    expect(resolveIconPath('./.nodeterm/images/a.png', '/repo')).toBe('/repo/.nodeterm/images/a.png')
    expect(resolveIconPath('./.nodeterm/images/a.png', '/repo/')).toBe(
      '/repo/.nodeterm/images/a.png'
    )
  })

  it('passes an absolute path through', () => {
    expect(resolveIconPath('/appdata/a.png', '/repo')).toBe('/appdata/a.png')
    expect(resolveIconPath('/appdata/a.png', undefined)).toBe('/appdata/a.png')
  })

  // The icon simply does not draw. It must never fall back to reading something else.
  it('answers undefined for a ./ path on a project with no local cwd', () => {
    expect(resolveIconPath('./.nodeterm/images/a.png', undefined)).toBeUndefined()
  })

  it('answers undefined for a traversing or rootless path', () => {
    expect(resolveIconPath('./../secrets/a.png', '/repo')).toBeUndefined()
    expect(resolveIconPath('a.png', '/repo')).toBeUndefined()
  })
})

// Round-tripping is the property the portability story actually rests on: what we store must be
// what we can read back, for both a project-local and an app-local icon.
describe('portable round trip', () => {
  it('survives store -> normalize -> resolve', () => {
    for (const [abs, cwd] of [
      ['/repo/.nodeterm/images/a.png', '/repo'],
      ['/appdata/canvas-images/b.png', undefined]
    ] as const) {
      const stored = portableIconPath(abs, cwd)
      const icon = normalizeNodeIcon({ type: 'image', path: stored })
      expect(icon).toBeDefined()
      expect(resolveIconPath((icon as { path: string }).path, cwd)).toBe(abs)
    }
  })
})

// The path seams, on a machine that is not the one that wrote the value. `.nodeterm/project.json`
// is git-shared, so a Windows teammate's icon reaches a mac's serializer and back; and a hostile
// value written for Windows is CHECKED here, wherever "here" happens to be. Both directions are
// pinned, because getting either wrong is silent: one deletes a colleague's icons, the other
// leaves the project root escapable.
describe('path dialects', () => {
  it('keeps a Windows drive-absolute path, so a mac save does not strip a colleague’s icon', () => {
    for (const path of ['C:\\Users\\me\\proj\\.nodeterm\\images\\a.png', 'D:/work/b.jpg']) {
      expect(normalizeNodeIcon({ type: 'image', path })).toEqual({ type: 'image', path })
    }
  })

  it('refuses a UNC path — reading one reaches another machine over the network', () => {
    for (const path of ['\\\\host\\share\\a.png', '//host/share/a.png']) {
      expect(normalizeNodeIcon({ type: 'image', path })).toBeUndefined()
    }
  })

  it('refuses a drive-RELATIVE path, which has no root of its own to resolve against', () => {
    expect(normalizeNodeIcon({ type: 'image', path: 'C:a.png' })).toBeUndefined()
  })

  // The one that was broken: `\` was not a separator here, so this was a single segment that was
  // neither '', '.' nor '..' — it passed on every platform and escaped the project on Windows.
  it('refuses a relative path that traverses out via BACKSLASH separators', () => {
    for (const path of [
      './a\\..\\..\\secret.png',
      '.\\..\\..\\secret.png',
      './sub\\..\\..\\..\\etc\\passwd.png'
    ]) {
      expect(normalizeNodeIcon({ type: 'image', path })).toBeUndefined()
    }
  })

  it('refuses a relative segment carrying a drive qualifier or an NTFS data stream', () => {
    expect(normalizeNodeIcon({ type: 'image', path: './C:/Windows/a.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: './icon.png:payload.png' })).toBeUndefined()
  })

  it('canonicalizes a relative path to one stored dialect, so its next reader is not guessing', () => {
    expect(normalizeNodeIcon({ type: 'image', path: '.\\images\\a.png' })).toEqual({
      type: 'image',
      path: './images/a.png'
    })
  })

  it('relativizes under a Windows project root, and stores it POSIX-separated', () => {
    expect(portableIconPath('C:\\proj\\.nodeterm\\images\\a.png', 'C:\\proj')).toBe(
      './.nodeterm/images/a.png'
    )
    // A trailing separator on the root is not a reason to give up on portability.
    expect(portableIconPath('C:\\proj\\images\\a.png', 'C:\\proj\\')).toBe('./images/a.png')
  })

  it('leaves a Windows path outside the project absolute', () => {
    expect(portableIconPath('C:\\other\\a.png', 'C:\\proj')).toBe('C:\\other\\a.png')
  })

  it('resolves a ./ path against a Windows root', () => {
    expect(resolveIconPath('./images/a.png', 'C:\\proj')).toBe('C:\\proj/images/a.png')
  })

  it('survives store -> normalize -> resolve on Windows', () => {
    const abs = 'C:\\proj\\.nodeterm\\images\\a.png'
    const cwd = 'C:\\proj'
    const stored = portableIconPath(abs, cwd)
    const icon = normalizeNodeIcon({ type: 'image', path: stored })
    expect(icon).toBeDefined()
    // Same FILE as `abs`; Node accepts forward slashes on Windows, so the spelling differs and
    // the target does not.
    expect(resolveIconPath((icon as { path: string }).path, cwd)).toBe(
      'C:\\proj/.nodeterm/images/a.png'
    )
  })
})

describe('iconFileName', () => {
  it('answers the last segment in either dialect', () => {
    expect(iconFileName('/a/b/c.png')).toBe('c.png')
    expect(iconFileName('C:\\Users\\me\\logo.png')).toBe('logo.png')
    expect(iconFileName('logo.png')).toBe('logo.png')
  })

  it('is what lets nodeIconMime read a Windows path', () => {
    expect(nodeIconMime('C:\\Users\\me\\logo.PNG')).toBe('image/png')
    expect(nodeIconMime('C:\\dir.with.dots\\README')).toBeUndefined()
  })
})

// The read side and the write side must agree about which cwd a `./` icon may resolve against.
// They disagreed: the picker excluded an SSH project, `useNodeIconSrc` did not — so a `./` icon
// authored by someone with the repo checked out locally resolved, on the SSH client, to the same
// relative path under a REMOTE root and was then read through the LOCAL fs.
describe('localIconCwd', () => {
  it('gives a local project its own cwd', () => {
    expect(localIconCwd({ cwd: '/repo' })).toBe('/repo')
  })

  it('refuses an SSH project’s cwd — that path is on the host, the read is not', () => {
    expect(localIconCwd({ cwd: '/srv/repo', ssh: { server: {}, remoteCwd: '/srv/repo' } })).toBeUndefined()
    // ...which makes a `./` icon simply not draw, rather than read an unrelated local file.
    expect(
      resolveIconPath('./images/a.png', localIconCwd({ cwd: '/srv/repo', ssh: {} }))
    ).toBeUndefined()
    // An absolute path is unaffected — and absolute is what the write side stores for SSH.
    expect(resolveIconPath('/appdata/canvas-images/a.png', localIconCwd({ cwd: '/srv/repo', ssh: {} })))
      .toBe('/appdata/canvas-images/a.png')
  })

  it('answers undefined for a cwd-less or unknown project rather than guessing', () => {
    expect(localIconCwd({})).toBeUndefined()
    expect(localIconCwd(undefined)).toBeUndefined()
  })
})

// Issue #291: a curated glyph set — shell, git, database, … — beside emoji and image. Same file,
// same hostility: the name is an allowlist key, never a free lucide export name.
describe('glyph icons', () => {
  it('keeps every curated glyph', () => {
    for (const glyph of NODE_GLYPHS) {
      expect(normalizeNodeIcon({ type: 'lucide', name: glyph.id })).toEqual({
        type: 'lucide',
        name: glyph.id
      })
    }
  })

  it('offers the kinds the issue names', () => {
    const ids = NODE_GLYPHS.map((g) => g.id)
    for (const id of ['terminal', 'folder-git', 'database', 'server', 'file-text']) {
      expect(ids).toContain(id)
    }
  })

  it('is a subset of the lucide ids the renderer can draw, with a label each', () => {
    for (const glyph of NODE_GLYPHS) {
      expect(LUCIDE_ICON_IDS as readonly string[]).toContain(glyph.id)
      expect(glyph.label.trim()).not.toBe('')
    }
    expect(new Set(NODE_GLYPHS.map((g) => g.id)).size).toBe(NODE_GLYPHS.length)
  })

  it('drops a name outside the allowlist, so a shared file cannot name an arbitrary export', () => {
    expect(normalizeNodeIcon({ type: 'lucide', name: 'skull' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'lucide', name: 'Terminal' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'lucide', name: ' terminal' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'lucide', name: 42 })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'lucide' })).toBeUndefined()
  })

  it('keeps only the canonical fields', () => {
    expect(normalizeNodeIcon({ type: 'lucide', name: 'database', color: 'red', path: '/x.png' })).toEqual({
      type: 'lucide',
      name: 'database'
    })
  })
})
