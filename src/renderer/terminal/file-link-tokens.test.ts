// The token matcher (file-link-tokens.ts). Each "measured gap" row names what the matcher before
// this change returned for it, so a revert shows up as a named regression rather than a diff.
// Several cases are taken from Orca's terminal-links tests (MIT, Copyright (c) 2026 Lovecast Inc.).
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { looksLikeBareFilename, matchFileTokens, type FileToken } from './file-link-tokens'
import { resolveFileToken } from './file-links'

const paths = (line: string): string[] => matchFileTokens(line).map((t) => t.path)
/** The span each token claims in `line` — must equal its own `text`. */
const spans = (line: string): string[] =>
  matchFileTokens(line).map((t) => line.slice(t.startIndex, t.startIndex + t.text.length))

describe('the measured gaps', () => {
  it('keeps Turkish letters in a path (was `var/otta-aktar`)', () => {
    expect(paths('› [file] var/otta-aktarım/çıktı.sql (2.8KB)')).toEqual([
      'var/otta-aktarım/çıktı.sql'
    ])
  })

  it('keeps route-group parentheses and brackets in a segment (was `/page.tsx`)', () => {
    expect(paths('app/(shop)/[id]/page.tsx')).toEqual(['app/(shop)/[id]/page.tsx'])
  })

  it('claims a path with a space as ONE token (was `/Users/me/My` and `Docs/a.md`)', () => {
    const [first] = matchFileTokens('/Users/me/My Docs/a.md')
    expect(first).toEqual({
      text: '/Users/me/My Docs/a.md',
      startIndex: 0,
      path: '/Users/me/My Docs/a.md',
      line: undefined
    })
  })

  it('offers bare filenames (was nothing — no slash, no link)', () => {
    expect(matchFileTokens('see README or Makefile')).toEqual([
      { text: 'README', startIndex: 4, path: 'README', line: undefined, bare: true },
      { text: 'Makefile', startIndex: 14, path: 'Makefile', line: undefined, bare: true }
    ])
    expect(paths('foo.ts')).toEqual(['foo.ts'])
  })

  it('reads a file:// URI as its percent-decoded absolute path (was nothing)', () => {
    expect(matchFileTokens('file:///tmp/a%20b.txt')).toEqual([
      { text: 'file:///tmp/a%20b.txt', startIndex: 0, path: '/tmp/a b.txt', line: undefined }
    ])
  })
})

describe('Unicode path segments', () => {
  it('accepts letters, numbers and marks from any script', () => {
    expect(paths('/tmp/报告.html and docs/café/report.pdf')).toEqual([
      '/tmp/报告.html',
      'docs/café/report.pdf'
    ])
    // A decomposed é (e + U+0301) is a mark, not a delimiter.
    expect(paths('docs/cafe\u0301/r.md')).toEqual(['docs/cafe\u0301/r.md'])
    expect(paths('~/Документы/отчёт.txt')).toEqual(['~/Документы/отчёт.txt'])
  })

  it('keeps Japanese middle dots and wave dashes, and stops at CJK punctuation', () => {
    expect(paths('/tmp/前・後/a.txt')).toEqual(['/tmp/前・後/a.txt'])
    expect(paths('/tmp/前〜後/a.txt')).toEqual(['/tmp/前〜後/a.txt'])
    expect(paths('/tmp/前後/a.txt，次')).toEqual(['/tmp/前後/a.txt'])
    expect(paths('/tmp/前後/a.txt。')).toEqual(['/tmp/前後/a.txt'])
  })

  it('does not take prose symbols into a path', () => {
    expect(paths('edit · ~/.claude/plans/p.md → done')).toEqual(['~/.claude/plans/p.md'])
    expect(paths('│ src/a.ts │')).toEqual(['src/a.ts'])
  })
})

describe('parentheses and brackets', () => {
  it('drops parentheses that belong to the sentence, keeps those that belong to the path', () => {
    expect(paths('(see src/a.ts)')).toEqual(['src/a.ts'])
    expect(paths('(src/a.ts)')).toEqual(['src/a.ts'])
    expect(paths('[src/a.ts]')).toEqual(['src/a.ts'])
    expect(paths('(app/(shop)/page.tsx)')).toEqual(['app/(shop)/page.tsx'])
    expect(paths('see app/(shop)/page.tsx).')).toEqual(['app/(shop)/page.tsx'])
    expect(paths('src/foo(1).txt, then')).toEqual(['src/foo(1).txt'])
  })

  it('carries a line suffix through the cleanup', () => {
    const [t] = matchFileTokens('Error in app/(shop)/products/[productId]/page.tsx:42:7')
    expect(t).toMatchObject({ path: 'app/(shop)/products/[productId]/page.tsx', line: 42 })
    expect(t.text).toBe('app/(shop)/products/[productId]/page.tsx:42:7')
    expect(matchFileTokens('(src/a.ts:12)')[0]).toMatchObject({
      text: 'src/a.ts:12',
      startIndex: 1,
      line: 12
    })
  })

  it('takes the target of a markdown link', () => {
    expect(paths('[the plan](docs/plan.md)')).toEqual(['docs/plan.md'])
    expect(paths('[src/a.ts](src/a.ts)')).toEqual(['src/a.ts'])
  })

  it('never turns a URL with parentheses into a file token', () => {
    expect(matchFileTokens('https://en.wikipedia.org/wiki/Foo_(bar)/baz')).toEqual([])
    expect(matchFileTokens('see (https://example.com/a/(b)/c.html)')).toEqual([])
    expect(matchFileTokens('git@github.com:org/repo.git http://x.io/(y)/z')).toEqual([
      { text: 'org/repo.git', startIndex: 15, path: 'org/repo.git', line: undefined }
    ])
  })
})

describe('paths with spaces', () => {
  it('stops before trailing prose', () => {
    const [t] = matchFileTokens('Open /Users/Path/FolderName with Space/content.js for details')
    expect(t.path).toBe('/Users/Path/FolderName with Space/content.js')
  })

  it('ends at a word that completes a file name', () => {
    expect(paths('saved /Users/me/Desktop/Screenshot 2026-09-29 at 10.12.33.png ok')[0]).toBe(
      '/Users/me/Desktop/Screenshot 2026-09-29 at 10.12.33.png'
    )
    expect(paths('/Applications/Visual Studio Code.app is open')[0]).toBe(
      '/Applications/Visual Studio Code.app'
    )
  })

  it('takes an extensionless spaced path at the end of the line, padding and all', () => {
    expect(matchFileTokens('/Users/alice/My Folder   ')[0]).toMatchObject({
      text: '/Users/alice/My Folder',
      path: '/Users/alice/My Folder'
    })
    expect(paths('cd ./My Folder')[0]).toBe('./My Folder')
  })

  it('keeps the space-free pieces as fallbacks, so prose never costs the real path', () => {
    // The trap from Orca's tests: prose after a path that ends in a file name. The spaced reading is
    // offered, but `/usr/bin/python` stays a candidate — the existence check decides.
    expect(paths('/usr/bin/python failed to start app.py')).toEqual([
      '/usr/bin/python failed to start app.py',
      '/usr/bin/python',
      'app.py'
    ])
    expect(paths('run /usr/bin/env node')).toEqual(['/usr/bin/env node', '/usr/bin/env'])
  })

  it('does not join a mid-line command argument, or two complete paths', () => {
    expect(paths('run /usr/bin/env node, then continue')).toEqual(['/usr/bin/env'])
    expect(paths('see src/a.ts and lib/b.ts here')).toEqual(['src/a.ts', 'lib/b.ts'])
    expect(paths('cp /tmp/x /tmp/y')).toEqual(['/tmp/x', '/tmp/y'])
    expect(paths('/a/b   c/d.ts')).toEqual(['/a/b', 'c/d.ts'])
  })

  it('carries a line suffix on a spaced path', () => {
    expect(matchFileTokens('/Users/me/My Docs/a.ts:12:3 error')[0]).toMatchObject({
      text: '/Users/me/My Docs/a.ts:12:3',
      path: '/Users/me/My Docs/a.ts',
      line: 12
    })
  })

  it('resolves a spaced relative path against the cwd like any other', () => {
    const [t] = matchFileTokens('edited src/My Folder/a.ts')
    expect(t.path).toBe('src/My Folder/a.ts')
    expect(resolveFileToken(t.path, '/repo')).toBe('/repo/src/My Folder/a.ts')
  })
})

describe('bare filenames', () => {
  it('looks like a filename: an extension that starts with a letter, or a known project file', () => {
    const names = ['foo.ts', 'package.json', '.env', '.gitignore', 'archive.tar.gz', 'main.c']
    names.push('Makefile', 'Dockerfile', 'LICENSE', 'çıktı.sql')
    for (const name of names) expect(looksLikeBareFilename(name), name).toBe(true)
  })

  it('refuses versions, abbreviations, numbers and plain words — no lookup storm on prose', () => {
    const words = ['v1.2', '1.2.3', 'e.g', 'i.e', 'U.S', 'a.b', '42', 'readme', 'hello', 'x']
    words.push('...', 'foo.', 'foo.123', 'me@x.com')
    for (const word of words) expect(looksLikeBareFilename(word), word).toBe(false)
    expect(matchFileTokens('e.g. version v1.2 of the 1.2.3 build, i.e. done')).toEqual([])
  })

  it('carries a line suffix and trims sentence punctuation', () => {
    expect(matchFileTokens('foo.ts:12:3 failed')).toEqual([
      { text: 'foo.ts:12:3', startIndex: 0, path: 'foo.ts', line: 12, bare: true }
    ])
    expect(paths('See README.')).toEqual(['README'])
    expect(paths('("package.json")')).toEqual(['package.json'])
  })

  it('never takes a piece of something larger', () => {
    // The leaf of a URL, of an assignment, of an email address: none is a bare filename.
    expect(matchFileTokens('--out=dist.js me@host.com http://x.io/a.js')).toEqual([])
  })

  it('resolves against the cwd', () => {
    expect(resolveFileToken('README', '/repo')).toBe('/repo/README')
    expect(resolveFileToken('.env', '/repo')).toBe('/repo/.env')
  })
})

describe('file:// URIs', () => {
  it('decodes, keeps a line suffix, and is never offered twice', () => {
    expect(matchFileTokens('Report: file:///Users/dev/My%20Report/r%C3%A7.html:9.')).toEqual([
      {
        text: 'file:///Users/dev/My%20Report/r%C3%A7.html:9',
        startIndex: 8,
        path: '/Users/dev/My Report/rç.html',
        line: 9
      }
    ])
    expect(matchFileTokens('file:///tmp/a.ts#L42')[0]).toMatchObject({ path: '/tmp/a.ts', line: 42 })
    expect(matchFileTokens('file://localhost/etc/hosts')[0]).toMatchObject({ path: '/etc/hosts' })
  })

  it('refuses another host, a bad escape and the bare root', () => {
    expect(matchFileTokens('file://server/share/a.txt')).toEqual([])
    expect(matchFileTokens('file:///tmp/%E0%A4%A.txt')).toEqual([])
    expect(matchFileTokens('file:///')).toEqual([])
  })

  it('is an absolute path to the resolver', () => {
    const [t] = matchFileTokens('file:///tmp/a%20b.txt')
    expect(resolveFileToken(t.path, '/elsewhere')).toBe('/tmp/a b.txt')
  })
})

describe('every token claims exactly its own text', () => {
  it('for all the kinds at once', () => {
    const line =
      'at app/(shop)/page.tsx:3 and /Users/me/My Docs/a.md, file:///tmp/x%20y.txt; see README.md or çıktı/ş.sql'
    const toks = matchFileTokens(line)
    expect(spans(line)).toEqual(toks.map((t: FileToken) => t.text))
    expect(toks.map((t) => t.path)).toEqual([
      'app/(shop)/page.tsx',
      '/Users/me/My Docs/a.md',
      '/Users/me/My',
      'Docs/a.md',
      '/tmp/x y.txt',
      'README.md',
      'çıktı/ş.sql'
    ])
  })
})

describe('ReDoS guard: the scan stays linear on hostile lines', () => {
  // A full-screen TUI paints rows that are mostly alignment padding; a dumped blob can be one
  // unbroken token. Each case is well past anything a terminal row joins to (32 rows × ~300
  // cols ≈ 10k cells) and must finish far inside the budget.
  const BUDGET_MS = 500
  const cases: Array<[string, string]> = [
    ['separator + space padding', `a/${' '.repeat(30_000)}`],
    ['long word, then a path', `${'b'.repeat(30_000)} a/b.ts`],
    ['words separated by single spaces after a path', `/x/y ${'w '.repeat(15_000)}`],
    ['spaced path list', Array.from({ length: 2_000 }, () => '/tmp/Foo Bar/file').join(', ')],
    ['open parentheses', `src/${'('.repeat(30_000)}`],
    ['leading open parentheses', `${'('.repeat(30_000)}src/a.ts`],
    ['nested brackets', `${'('.repeat(15_000)}src/a${')'.repeat(15_000)}`],
    ['many spaced-path starts', 'a/b c '.repeat(5_000)],
    ['alternating separators', 'a/'.repeat(15_000)],
    ['file URI blob', `file:///${'a'.repeat(30_000)}`],
    ['repeated file URIs', 'file:///x '.repeat(3_000)],
    ['dotted prose', 'e.g. '.repeat(6_000)],
    ['Windows-shaped', String.raw`C:\a `.repeat(6_000)]
  ]

  for (const [name, line] of cases) {
    it(`"${name}" (${line.length} chars)`, () => {
      const t0 = performance.now()
      matchFileTokens(line)
      matchFileTokens(line, { windows: true })
      expect(performance.now() - t0).toBeLessThan(BUDGET_MS)
    })
  }
})
