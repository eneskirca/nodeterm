// Ctrl+click file links for a LOCAL Windows session.
//
// Its own file: the POSIX cases in file-links.test.ts are the ones every existing user runs, and
// they must stay byte-identical. The two matchers are separate functions for the same reason —
// widening the POSIX regex's separator class would start matching Windows-shaped text inside a
// POSIX session, where it can only ever be wrong.
//
// The gating fact is per-SESSION, not per-platform: an SSH project's paths are POSIX however the
// desktop is spelled, so a remote session on a Windows machine keeps the POSIX matcher. Getting
// that backwards would break the SSH links that already work in order to fix the local ones that
// never did. `TerminalNode` computes it as `isWindowsPlatform() && !remoteSession`.

import { describe, expect, it } from 'vitest'
import { makeDirListingLookup, matchFileTokens, resolveFileToken } from './file-links'

const WIN = { windows: true } as const
const CWD = String.raw`C:\Users\me\proj`

/** The paths of every token matched in a line. */
const paths = (line: string, opts = WIN): string[] =>
  matchFileTokens(line, opts).map((t) => t.path)

describe('matching Windows paths', () => {
  it('matches a drive-absolute path', () => {
    expect(paths(String.raw`see C:\Users\me\src\a.ts for detail`)).toEqual([
      String.raw`C:\Users\me\src\a.ts`
    ])
  })

  it('matches a multi-segment relative path', () => {
    expect(paths(String.raw`edited src\renderer\a.ts`)).toEqual([String.raw`src\renderer\a.ts`])
  })

  it('matches a forward-slash relative path emitted by Windows tools', () => {
    expect(paths('edited src/renderer/a.ts')).toEqual(['src/renderer/a.ts'])
  })

  it('matches a dot-relative path', () => {
    expect(paths(String.raw`at .\src\a.ts`)).toEqual([String.raw`.\src\a.ts`])
    expect(paths(String.raw`at ..\sibling\a.ts`)).toEqual([String.raw`..\sibling\a.ts`])
  })

  it('carries the :line suffix, with the drive colon left alone', () => {
    // The trap: a drive letter's colon looks exactly like the start of a `:line` suffix. It is
    // not, because SUFFIX_RE anchors the digits at the END of the token.
    const [t] = matchFileTokens(String.raw`C:\src\a.ts:12: error`, WIN)
    expect(t.path).toBe(String.raw`C:\src\a.ts`)
    expect(t.line).toBe(12)
  })

  it('handles :line:col', () => {
    const [t] = matchFileTokens(String.raw`C:\src\a.ts:12:5`, WIN)
    expect(t.path).toBe(String.raw`C:\src\a.ts`)
    expect(t.line).toBe(12)
  })

  it('does not turn a bare word with a colon-number into a path', () => {
    // `C:12` would otherwise split into path `C`, line 12.
    expect(paths('C:12')).toEqual([])
    expect(paths('warning:42 somewhere')).toEqual([])
  })

  it('leaves URLs to the web-links addon', () => {
    expect(paths('open https://example.com/a/b')).toEqual([])
  })

  it('refuses a whole UNC token instead of relabelling its host as a cwd-relative directory', () => {
    expect(paths(String.raw`opened \\server\share\a.ts`)).toEqual([])
    expect(paths('opened //server/share/a.ts')).toEqual([])
  })

  it('strips trailing punctuation', () => {
    expect(paths(String.raw`in C:\src\a.ts.`)).toEqual([String.raw`C:\src\a.ts`])
    expect(paths(String.raw`(see src\a.ts)`)).toEqual([String.raw`src\a.ts`])
  })
})

describe('the POSIX matcher is untouched by any of this', () => {
  it('still matches POSIX paths when the flag is off', () => {
    expect(paths('edited src/renderer/a.ts:12', {} as never)).toEqual(['src/renderer/a.ts'])
  })

  it('does not match Windows paths when the flag is off', () => {
    // An SSH session on a Windows desktop must behave exactly as it does today.
    expect(paths(String.raw`C:\Users\me\a.ts`, {} as never)).toEqual([])
  })

  it('defaults to POSIX with no options at all', () => {
    expect(matchFileTokens(String.raw`C:\Users\me\a.ts`)).toEqual([])
    expect(matchFileTokens('src/a.ts').map((t) => t.path)).toEqual(['src/a.ts'])
  })
})

describe('resolving Windows tokens', () => {
  it('returns a /-separated path that keeps its drive', () => {
    // Forward slashes on purpose: makeDirListingLookup finds the parent with lastIndexOf('/'),
    // and Windows accepts either separator for filesystem calls. A native path would make that
    // split fail and the link would silently never resolve.
    expect(resolveFileToken(String.raw`C:\Users\me\src\a.ts`, CWD, WIN)).toBe(
      'C:/Users/me/src/a.ts'
    )
  })

  it('resolves a relative token against cwd', () => {
    expect(resolveFileToken(String.raw`src\a.ts`, CWD, WIN)).toBe('C:/Users/me/proj/src/a.ts')
  })

  it('normalizes . and ..', () => {
    expect(resolveFileToken(String.raw`.\src\.\a.ts`, CWD, WIN)).toBe('C:/Users/me/proj/src/a.ts')
    expect(resolveFileToken(String.raw`..\other\a.ts`, CWD, WIN)).toBe('C:/Users/me/other/a.ts')
  })

  it('refuses .. that would climb past the drive root', () => {
    expect(resolveFileToken(String.raw`..\..\..\..\..\evil`, CWD, WIN)).toBeNull()
  })

  it('accepts a forward-slash absolute path, which Windows tools also emit', () => {
    expect(resolveFileToken('C:/Users/me/a.ts', CWD, WIN)).toBe('C:/Users/me/a.ts')
  })

  it('refuses a UNC path rather than half-handling it', () => {
    // No drive to anchor on, and its first two segments are a host and a share rather than
    // directories — resolving it would aim a directory listing at a network host.
    expect(resolveFileToken(String.raw`\\server\share\a.ts`, CWD, WIN)).toBeNull()
  })

  it('refuses a relative token when cwd is not drive-qualified', () => {
    expect(resolveFileToken(String.raw`src\a.ts`, undefined, WIN)).toBeNull()
    expect(resolveFileToken(String.raw`src\a.ts`, '/home/me/proj', WIN)).toBeNull()
  })

  it('the POSIX resolver keeps its exact contract', () => {
    expect(resolveFileToken('src/a.ts', '/home/me/proj')).toBe('/home/me/proj/src/a.ts')
    expect(resolveFileToken('/etc/hosts', '/home/me/proj')).toBe('/etc/hosts')
    expect(resolveFileToken('../../../../etc/passwd', '/home/me')).toBeNull()
  })
})

describe('a path containing a space', () => {
  it('is offered whole, with its space-free pieces as fallbacks, and stops before the sentence', () => {
    // `C:\Program Files\...` is everywhere on Windows. The spaced reading ends at the word that
    // completes a file name (`a.exe`), so `crashed` is never swallowed; the pieces stay candidates
    // because only the existence check can say which reading is real.
    const got = matchFileTokens(String.raw`C:\Program Files\app\a.exe crashed`, WIN)
    expect(got.map((t) => t.path)).toEqual([
      String.raw`C:\Program Files\app\a.exe`,
      String.raw`C:\Program`,
      String.raw`Files\app\a.exe`
    ])
  })

  it('keeps a parenthesised segment inside a spaced path', () => {
    const got = matchFileTokens(String.raw`at C:\Program Files (x86)\tool\run.exe:4`, WIN)
    expect(got[0]).toMatchObject({
      path: String.raw`C:\Program Files (x86)\tool\run.exe`,
      line: 4
    })
  })
})

describe('Unicode, brackets, bare names and file URIs in the Windows dialect', () => {
  it('keeps Unicode letters and route brackets in a segment', () => {
    expect(paths(String.raw`wrote C:\veri\çıktı\aktarım.sql`)).toEqual([
      String.raw`C:\veri\çıktı\aktarım.sql`
    ])
    expect(paths(String.raw`app\(shop)\[id]\page.tsx`)).toEqual([String.raw`app\(shop)\[id]\page.tsx`])
  })

  it('offers a bare filename, and not the leaf of a Windows path read as POSIX', () => {
    expect(matchFileTokens('see README.md', WIN)).toEqual([
      { text: 'README.md', startIndex: 4, path: 'README.md', line: undefined, bare: true }
    ])
    expect(matchFileTokens(String.raw`C:\Users\me\a.ts`)).toEqual([])
  })

  it('decodes a drive-qualified file URI and refuses a POSIX-rooted one', () => {
    expect(paths('open file:///C:/Users/me/My%20Docs/a.md now')).toEqual(['C:/Users/me/My Docs/a.md'])
    expect(paths('open file:///home/me/a.md')).toEqual([])
    expect(resolveFileToken('C:/Users/me/My Docs/a.md', CWD, WIN)).toBe('C:/Users/me/My Docs/a.md')
  })
})

describe('Windows existence lookup', () => {
  it('uses Windows separators and case-insensitive entry names', async () => {
    const listed: string[] = []
    const lookup = makeDirListingLookup(
      async (dir) => {
        listed.push(dir)
        return [{ name: 'App.TSX', dir: false }]
      },
      3000,
      () => WIN
    )

    await expect(lookup(String.raw`C:\Users\ME\src\app.tsx`)).resolves.toEqual({
      exists: true,
      dir: false
    })
    expect(listed).toEqual([String.raw`C:\Users\ME\src`])
  })

  it('shares a cached directory listing across Windows path casing', async () => {
    let calls = 0
    const lookup = makeDirListingLookup(
      async () => {
        calls++
        return [{ name: 'a.ts', dir: false }]
      },
      3000,
      () => WIN
    )

    await lookup('C:/Users/ME/src/a.ts')
    await lookup('c:/users/me/SRC/A.TS')
    expect(calls).toBe(1)
  })
})
