import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  createOsc8LinkHandler,
  makeDirListingLookup,
  matchFileTokens,
  matchUrlTokens,
  osc8UrlAt,
  paragraphContaining,
  planFileLinkClick,
  resolveExtendedFileLinkAt,
  resolveFileLinks,
  resolveFileToken,
  type BufferView
} from './file-links'

describe('matchFileTokens', () => {
  it('finds absolute, dot-relative and bare relative paths', () => {
    const t = matchFileTokens('see /etc/hosts and ./src/a.ts plus src/lib/b.tsx here')
    expect(t.map((x) => x.path)).toEqual(['/etc/hosts', './src/a.ts', 'src/lib/b.tsx'])
    expect(t[0].startIndex).toBe(4)
  })

  it('parses :line and :line:col suffixes into path + line', () => {
    const [t] = matchFileTokens('src/renderer/App.tsx:42:7 - error TS2551')
    expect(t.path).toBe('src/renderer/App.tsx')
    expect(t.line).toBe(42)
    expect(t.text).toBe('src/renderer/App.tsx:42:7')
  })

  it('strips trailing punctuation', () => {
    expect(matchFileTokens('(see src/a.ts, then src/b.ts.)').map((x) => x.path)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
  })

  it('skips URLs and lone words', () => {
    expect(matchFileTokens('https://example.com/a/b plain word')).toEqual([])
  })

  it('matches home-relative ~/ paths with their tilde attached', () => {
    expect(matchFileTokens('~/notes.md')).toEqual([
      { text: '~/notes.md', startIndex: 0, path: '~/notes.md', line: undefined }
    ])
    // Claude Code's plan-approval footer — the path the user Cmd+clicks.
    const line = 'ctrl-g to edit in Vim · ~/.claude/plans/wondrous-rossum.md'
    const [t] = matchFileTokens(line)
    expect(t.text).toBe('~/.claude/plans/wondrous-rossum.md')
    expect(t.path).toBe('~/.claude/plans/wondrous-rossum.md')
    expect(line.slice(t.startIndex, t.startIndex + t.text.length)).toBe(t.text)
    expect(matchFileTokens('(~/src/a.ts:12)')).toEqual([
      { text: '~/src/a.ts:12', startIndex: 1, path: '~/src/a.ts', line: 12 }
    ])
  })

  it('does not treat a mid-word tilde or ~user as a home path', () => {
    expect(matchFileTokens('backup~/notes.md')).toEqual([])
    expect(matchFileTokens('~alice/notes.md')).toEqual([])
  })
})

describe('resolveFileToken', () => {
  it('passes absolutes through and resolves relatives against cwd', () => {
    expect(resolveFileToken('/etc/hosts', '/repo')).toBe('/etc/hosts')
    expect(resolveFileToken('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(resolveFileToken('./src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
    expect(resolveFileToken('../other/x.ts', '/repo/sub')).toBe('/repo/other/x.ts')
  })

  it('returns null without a cwd for relatives, and for root-escaping paths', () => {
    expect(resolveFileToken('src/a.ts', undefined)).toBeNull()
    expect(resolveFileToken('../../../../etc/passwd', '/a')).toBeNull()
  })

  it('preserves a tilde-rooted cwd (SSH default) instead of mangling it to /~', () => {
    expect(resolveFileToken('src/a.ts', '~/proj')).toBe('~/proj/src/a.ts')
    expect(resolveFileToken('./src/a.ts', '~')).toBe('~/src/a.ts')
    expect(resolveFileToken('../x.ts', '~/proj/sub')).toBe('~/proj/x.ts')
    expect(resolveFileToken('../../../x.ts', '~/proj')).toBeNull() // .. may not pop the ~
    expect(resolveFileToken('/abs/x.ts', '~/proj')).toBe('/abs/x.ts') // absolutes unaffected
  })

  it('keeps a ~/ token home-rooted whatever the cwd, for the core to expand', () => {
    expect(resolveFileToken('~/.claude/plans/p.md', '/root/nodeterm')).toBe('~/.claude/plans/p.md')
    expect(resolveFileToken('~/a/../b.md', undefined)).toBe('~/b.md')
    expect(resolveFileToken('~/../etc/passwd', '/x')).toBeNull() // .. may not pop the ~
  })
})

describe('POSIX existence lookup', () => {
  it('keeps a backslash inside the filename and matches case-sensitively', async () => {
    const listed: string[] = []
    const lookup = makeDirListingLookup(async (dir) => {
      listed.push(dir)
      return [
        { name: String.raw`name\part.ts`, dir: false },
        { name: 'CASE.ts', dir: false }
      ]
    })

    await expect(lookup(String.raw`/repo/name\part.ts`)).resolves.toEqual({
      exists: true,
      dir: false
    })
    await expect(lookup('/repo/case.ts')).resolves.toEqual({ exists: false, dir: false })
    expect(listed).toEqual(['/repo'])
  })
})

/** Fake buffer: each entry is a row's content; `w:` prefix marks it soft-wrapped. Rows are
 *  stored untrimmed exactly as given (pad to `cols` yourself to simulate a full row). */
function view(cols: number, rows: string[]): BufferView {
  const parsed = rows.map((r) =>
    r.startsWith('w:') ? { wrapped: true, text: r.slice(2) } : { wrapped: false, text: r }
  )
  return {
    cols,
    length: parsed.length,
    line: (row) => {
      const p = parsed[row]
      return p
        ? { isWrapped: p.wrapped, text: (trim) => (trim ? p.text.replace(/\s+$/, '') : p.text) }
        : undefined
    }
  }
}

describe('paragraphContaining', () => {
  it('joins soft-wrapped rows from any row of the paragraph', () => {
    const v = view(10, ['prompt>   ', 'https://x.', 'w:io/abc'])
    for (const row of [1, 2]) {
      const p = paragraphContaining(v, row)!
      expect(p.startRow).toBe(1)
      expect(p.text).toBe('https://x.io/abc')
      expect(p.rows).toBe(2)
    }
    // row 0 does not run into row 1 (it has trailing spaces) — separate paragraph
    expect(paragraphContaining(v, 0)!.text).toBe('prompt>')
  })

  it('joins HARD-wrapped rows (tmux repaint / TUI): full last column + non-space next start', () => {
    // 10-col screen painting "https://claude.com/oauth?x=1" as three hard rows
    const v = view(10, ['https://cl', 'aude.com/o', 'auth?x=1'])
    for (const row of [0, 1, 2]) {
      const p = paragraphContaining(v, row)!
      expect(p.startRow).toBe(0)
      expect(p.text).toBe('https://claude.com/oauth?x=1')
    }
    expect(matchUrlTokens(paragraphContaining(v, 1)!.text)[0].url).toBe(
      'https://claude.com/oauth?x=1'
    )
  })

  it('does NOT join when the row is not full to the last column', () => {
    const v = view(10, ['https://x ', 'unrelated'])
    expect(paragraphContaining(v, 0)!.text).toBe('https://x')
  })

  it('does NOT join when the next row starts with a space', () => {
    const v = view(10, ['aaaaaaaaaa', ' indented'])
    expect(paragraphContaining(v, 0)!.text).toBe('aaaaaaaaaa')
  })

  it('index math holds across hard rows (every joined row contributes exactly cols chars)', () => {
    const v = view(10, ['see https:', '//x.io/abc', 'd now'])
    const p = paragraphContaining(v, 0)!
    const [u] = matchUrlTokens(p.text)
    expect(u.url).toBe('https://x.io/abcd')
    // token starts at index 4 → row 0 col 4; ends at index 20 → row 2 col 0
    expect(Math.floor(u.startIndex / 10)).toBe(0)
    expect(Math.floor((u.startIndex + u.text.length - 1) / 10)).toBe(2)
  })

  it('caps runaway joins at MAX_JOIN_ROWS', () => {
    const wall = Array.from({ length: 80 }, () => 'x'.repeat(10))
    const p = paragraphContaining(view(10, wall), 0)!
    expect(p.rows).toBeLessThanOrEqual(32)
  })
})

describe('matchUrlTokens', () => {
  it('finds http(s) URLs with their start index', () => {
    const t = matchUrlTokens('open https://example.com/a/b and http://x.io/p here')
    expect(t.map((x) => x.url)).toEqual(['https://example.com/a/b', 'http://x.io/p'])
    expect(t[0].startIndex).toBe(5)
  })

  it('strips trailing sentence punctuation', () => {
    expect(matchUrlTokens('see https://example.com/a.').map((x) => x.url)).toEqual([
      'https://example.com/a'
    ])
    expect(matchUrlTokens('(https://example.com/a)').map((x) => x.url)).toEqual([
      'https://example.com/a'
    ])
  })

  it('ignores non-http schemes and bare paths', () => {
    expect(matchUrlTokens('ftp://x.io file:///etc/hosts /usr/local plain')).toEqual([])
  })
})

describe('createOsc8LinkHandler', () => {
  const range = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }
  const click = (mod: boolean): MouseEvent => ({ metaKey: mod, ctrlKey: false }) as MouseEvent

  it('opens http(s) only, and only on a modifier click', () => {
    const opened: string[] = []
    const h = createOsc8LinkHandler((u) => opened.push(u))
    h.activate(click(false), 'https://example.com/a', range)
    h.activate(click(true), 'javascript:alert(1)', range)
    h.activate(click(true), 'file:///etc/passwd', range)
    h.activate(click(true), 'not a url', range)
    h.activate(click(true), 'https://example.com/a', range)
    expect(opened).toEqual(['https://example.com/a'])
  })
})

describe('osc8UrlAt', () => {
  /** Just the private shape osc8UrlAt reads: a cell's extended.urlId + the osc link service. */
  const fakeTerm = (urlId: number | undefined, uri: string | undefined): Terminal =>
    ({
      buffer: { active: { getLine: () => ({ getCell: () => ({ extended: { urlId } }) }) } },
      _core: { _oscLinkService: { getLinkData: () => (uri ? { uri } : undefined) } }
    }) as unknown as Terminal

  it('resolves the URI at a linked cell and refuses a non-http scheme', () => {
    expect(osc8UrlAt(fakeTerm(3, 'https://example.com/pr/1'), 0, 0)).toBe(
      'https://example.com/pr/1'
    )
    expect(osc8UrlAt(fakeTerm(3, 'javascript:alert(1)'), 0, 0)).toBeNull()
  })

  it('returns null for an unlinked cell and when internals are absent', () => {
    expect(osc8UrlAt(fakeTerm(undefined, 'https://x.io/a'), 0, 0)).toBeNull()
    expect(osc8UrlAt(fakeTerm(3, undefined), 0, 0)).toBeNull()
    const bare = { buffer: { active: { getLine: () => undefined } } } as unknown as Terminal
    expect(osc8UrlAt(bare, 0, 0)).toBeNull()
  })
})

/** A fake filesystem: every listed path exists, with each ancestor as a directory. A path ending
 *  in `/` is a directory itself. `listed` records every fs.list the lookups made. */
function fakeFs(paths: string[]): {
  list: (dir: string) => Promise<Array<{ name: string; dir: boolean }>>
  listed: string[]
} {
  const dirs = new Map<string, Map<string, boolean>>()
  for (const p of paths) {
    const tilde = p.startsWith('~/')
    const segs = (tilde ? p.slice(2) : p).split('/').filter(Boolean)
    segs.forEach((name, i) => {
      const parentSegs = segs.slice(0, i).join('/')
      const parent = tilde ? (parentSegs ? `~/${parentSegs}` : '~') : `/${parentSegs}`
      const isDir = i < segs.length - 1 || p.endsWith('/')
      const entries = dirs.get(parent) ?? new Map<string, boolean>()
      entries.set(name, (entries.get(name) ?? false) || isDir)
      dirs.set(parent, entries)
    })
  }
  const listed: string[] = []
  return {
    listed,
    list: async (dir) => {
      listed.push(dir)
      return [...(dirs.get(dir) ?? new Map()).entries()].map(([name, dir]) => ({ name, dir }))
    }
  }
}

function fsDeps(paths: string[], cwd = '/repo') {
  const fs = fakeFs(paths)
  const lookup = makeDirListingLookup(fs.list)
  return { fs, deps: { getCwd: () => cwd, lookup, listDir: lookup.listDir } }
}

describe('existence-guided extension (spaces + agent-wrapped paths)', () => {
  const CODEX_PATH =
    '/Users/someuser/Claude/Claude Code/example-project-name-demo.worktrees/feature-x/docs/gui-proposal/TEAM-ACCESS.md'
  // Measured in a Codex session (codex-cli 0.155.1, 110 cols): Codex wrapped the reply itself at a
  // word boundary with a 2-space hanging indent, so row 0 does NOT reach the last column.
  const CODEX_ROWS = [
    '• The file is located at /Users/someuser/Claude/Claude Code/example-project-name-demo.worktrees/feature-x/',
    '  docs/gui-proposal/TEAM-ACCESS.md'
  ]

  it('links the Codex two-row example to the full path, spanning both rows, from either row', async () => {
    const { deps } = fsDeps([CODEX_PATH])
    for (const row of [0, 1]) {
      const links = (await resolveFileLinks(view(110, CODEX_ROWS), row, deps)).filter(
        (l) => l.abs === CODEX_PATH
      )
      expect(links).toHaveLength(1)
      expect(links[0].dir).toBe(false)
      expect(links[0].range).toEqual({ start: { x: 26, y: 1 }, end: { x: 34, y: 2 } })
    }
  })

  it('activates the extended link from a click on either row (the tmux click fallback)', async () => {
    const { deps } = fsDeps([CODEX_PATH])
    const v = view(110, CODEX_ROWS)
    await expect(resolveExtendedFileLinkAt(v, 1, 10, deps)).resolves.toEqual({
      abs: CODEX_PATH,
      dir: false
    })
    await expect(resolveExtendedFileLinkAt(v, 0, 60, deps)).resolves.toEqual({
      abs: CODEX_PATH,
      dir: false
    })
    // Before the path: nothing.
    await expect(resolveExtendedFileLinkAt(v, 0, 5, deps)).resolves.toBeNull()
  })

  it('links a path with a space on one row when the listing has the spaced name', async () => {
    const { deps } = fsDeps(['/data/My Docs/report.txt'])
    const links = await resolveFileLinks(view(80, ['open /data/My Docs/report.txt now']), 0, deps)
    expect(links.map((l) => [l.text, l.abs])).toEqual([
      ['/data/My Docs/report.txt', '/data/My Docs/report.txt']
    ])
    expect(links[0].range).toEqual({ start: { x: 6, y: 1 }, end: { x: 29, y: 1 } })
  })

  it('keeps a :line suffix after a spaced name and drops trailing punctuation', async () => {
    const { deps } = fsDeps(['/data/My Docs/a.ts'])
    const [l] = await resolveFileLinks(view(80, ['at /data/My Docs/a.ts:12, then']), 0, deps)
    expect(l.text).toBe('/data/My Docs/a.ts:12')
    expect(l.abs).toBe('/data/My Docs/a.ts')
  })

  it('follows a name the TUI broke AT its space onto the indented row', async () => {
    const { deps } = fsDeps(['/data/My Docs/r.txt'])
    const links = await resolveFileLinks(view(40, ['see /data/My', '  Docs/r.txt']), 1, deps)
    expect(links.map((l) => [l.abs, l.range])).toEqual([
      ['/data/My Docs/r.txt', { start: { x: 5, y: 1 }, end: { x: 12, y: 2 } }]
    ])
  })

  it('ends a spaced path at a closing backtick, but not inside a longer word', async () => {
    const { deps } = fsDeps(['/data/My Docs/a.md'])
    const [l] = await resolveFileLinks(view(80, ['see `/data/My Docs/a.md` here']), 0, deps)
    expect(l.text).toBe('/data/My Docs/a.md')
    await expect(resolveFileLinks(view(80, ['/data/My Docs/a.mdx']), 0, deps)).resolves.toEqual([])
  })

  it('does not swallow the sentence after an existing path', async () => {
    const { deps } = fsDeps(['/tmp/a'])
    const one = await resolveFileLinks(view(80, ['see /tmp/a for details']), 0, deps)
    expect(one.map((l) => l.text)).toEqual(['/tmp/a'])
    const two = await resolveFileLinks(view(80, ['/tmp/a b']), 0, deps)
    expect(two.map((l) => l.text)).toEqual(['/tmp/a'])
  })

  it('lets an existing prefix yield to a longer entry the text spells', async () => {
    const { deps } = fsDeps(['/tmp/a', '/tmp/a b.txt'])
    const links = await resolveFileLinks(view(80, ['/tmp/a b.txt']), 0, deps)
    expect(links.map((l) => [l.text, l.abs])).toEqual([['/tmp/a b.txt', '/tmp/a b.txt']])
  })

  it('keeps an existing token byte-identical when no longer entry is spelled', async () => {
    const { deps, fs } = fsDeps(['/tmp/a', '/tmp/a c.txt'])
    const withExt = await resolveFileLinks(view(80, ['see /tmp/a b.txt']), 0, deps)
    const without = await resolveFileLinks(view(80, ['see /tmp/a b.txt']), 0, {
      getCwd: deps.getCwd,
      lookup: deps.lookup
    })
    expect(withExt).toEqual(without)
    expect(withExt.map((l) => l.text)).toEqual(['/tmp/a'])
    // Not followed by a space or seam: no extension, only the existence check's listing.
    fs.listed.length = 0
    const other = fsDeps(['/tmp/a'])
    await resolveFileLinks(view(80, ['see /tmp/a, ok']), 0, other.deps)
    expect(other.fs.listed).toEqual(['/tmp'])
  })

  it('offers no link when nothing exists', async () => {
    const { deps, fs } = fsDeps([])
    await expect(
      resolveFileLinks(view(80, ['open /nope/My Docs/x.txt now']), 0, deps)
    ).resolves.toEqual([])
    // Only the existence checks' own parent listings — the extension found nothing to follow.
    expect(fs.listed).toEqual(['/nope', '/repo/Docs'])
  })

  it('offers no link when a later segment cannot be resolved', async () => {
    const { deps } = fsDeps(['/data/My Docs/real.txt'])
    await expect(resolveFileLinks(view(80, ['/data/My Docs/ghost.txt']), 0, deps)).resolves.toEqual(
      []
    )
  })

  it('respects the space bound', async () => {
    const four = '/d/a b c d e/x.txt'
    const five = '/d/a b c d e f/x.txt'
    const ok = fsDeps([four])
    expect((await resolveFileLinks(view(80, [four]), 0, ok.deps)).map((l) => l.abs)).toEqual([four])
    const over = fsDeps([five])
    expect(await resolveFileLinks(view(80, [five]), 0, over.deps)).toEqual([])
  })

  it('respects the row bound on indented continuation rows', async () => {
    const name = (n: number): string => 'p' + 'q'.repeat(n)
    const rows = (n: number): string[] => ['see /d/p', ...Array.from({ length: n }, () => '  q')]
    const short = fsDeps([`/d/${name(4)}`])
    expect((await resolveFileLinks(view(20, rows(4)), 0, short.deps)).map((l) => l.abs)).toEqual([
      `/d/${name(4)}`
    ])
    const long = fsDeps([`/d/${name(40)}`])
    expect(await resolveFileLinks(view(20, rows(40)), 0, long.deps)).toEqual([])
  })

  it('only continues onto a row that starts with indentation', async () => {
    const { deps } = fsDeps(['/d/pq'])
    expect(await resolveFileLinks(view(20, ['see /d/p', 'q']), 0, deps)).toEqual([])
  })

  it('supports ~ paths through the same listing', async () => {
    const { deps } = fsDeps(['~/My Docs/a.md'])
    const [l] = await resolveFileLinks(view(80, ['plan: ~/My Docs/a.md']), 0, deps)
    expect(l.abs).toBe('~/My Docs/a.md')
  })

  it('leaves the Windows dialect alone', async () => {
    const { deps } = fsDeps(['/data/My Docs/report.txt'])
    await expect(
      resolveFileLinks(view(80, ['/data/My Docs/report.txt']), 0, {
        ...deps,
        convention: { windows: true }
      })
    ).resolves.toEqual([])
  })

  it('is a no-op without a listDir (existing links unchanged)', async () => {
    const { deps } = fsDeps(['/data/My', '/data/My Docs/report.txt'])
    const links = await resolveFileLinks(view(80, ['/data/My Docs/report.txt']), 0, {
      getCwd: deps.getCwd,
      lookup: deps.lookup
    })
    expect(links.map((l) => l.text)).toEqual(['/data/My'])
  })

  it('listDir shares the lookup cache', async () => {
    const fs = fakeFs(['/repo/x'])
    const lookup = makeDirListingLookup(fs.list)
    await lookup('/repo/x')
    await lookup.listDir('/repo')
    expect(fs.listed).toEqual(['/repo'])
  })
})

describe('review fixes: click fallback, seams before a slash, listing cache', () => {
  const clickAt = async (
    rows: string[],
    row: number,
    col: number,
    paths: string[]
  ): Promise<{ abs: string; dir: boolean } | null | 'not-swallowed'> => {
    const { deps } = fsDeps(paths)
    const click = planFileLinkClick(view(80, rows), row, col, deps)
    return click ? click() : 'not-swallowed'
  }

  it('click fallback prefers the extended path over an existing relative fragment', async () => {
    const rows = ['open /data/My Docs/a.ts']
    const paths = ['/data/My Docs/a.ts', '/repo/Docs/a.ts']
    // col 17 is inside the relative token `Docs/a.ts`, which exists under cwd /repo.
    await expect(clickAt(rows, 0, 17, paths)).resolves.toEqual({
      abs: '/data/My Docs/a.ts',
      dir: false
    })
    const { deps } = fsDeps(paths)
    const links = await resolveFileLinks(view(80, rows), 0, deps)
    expect(links.map((l) => l.abs)).toEqual(['/data/My Docs/a.ts'])
  })

  it('click fallback still opens a plain token when no extension covers it', async () => {
    await expect(clickAt(['see /tmp/a now'], 0, 6, ['/tmp/a'])).resolves.toEqual({
      abs: '/tmp/a',
      dir: false
    })
  })

  it('a seam before a slash continues the path instead of ending it', async () => {
    const { deps } = fsDeps(['/data/My Docs/a.ts'])
    const links = await resolveFileLinks(view(40, ['see /data/My Docs', '  /a.ts']), 0, deps)
    expect(links.map((l) => [l.abs, l.range])).toEqual([
      ['/data/My Docs/a.ts', { start: { x: 5, y: 1 }, end: { x: 7, y: 2 } }]
    ])
  })

  it('click on the space or a slash-less last segment opens the extended path', async () => {
    const rows = ['open /x/My Report.txt now']
    const paths = ['/x/My Report.txt']
    await expect(clickAt(rows, 0, 10, paths)).resolves.toEqual({
      abs: '/x/My Report.txt',
      dir: false
    }) // the space
    await expect(clickAt(rows, 0, 15, paths)).resolves.toEqual({
      abs: '/x/My Report.txt',
      dir: false
    }) // inside `Report.txt`
  })

  it('Cmd-click on an ordinary word outside any link reach does nothing', async () => {
    await expect(clickAt(['hello world'], 0, 2, [])).resolves.toBe('not-swallowed')
    // Six words after the path: past the space bound, never swallowed.
    await expect(clickAt(['see /x/My a b c d e word'], 0, 22, ['/x/My Report.txt'])).resolves.toBe(
      'not-swallowed'
    )
  })

  it('does not cache a failed listing', async () => {
    let calls = 0
    const lookup = makeDirListingLookup(async () => {
      calls++
      if (calls === 1) throw new Error('EAGAIN')
      return [{ name: 'a', dir: false }]
    })
    await expect(lookup('/d/a')).resolves.toEqual({ exists: false, dir: false })
    await expect(lookup('/d/a')).resolves.toEqual({ exists: true, dir: false })
  })

  it('an older in-flight listing does not overwrite a newer one', async () => {
    const resolvers: Array<(v: Array<{ name: string; dir: boolean }>) => void> = []
    let calls = 0
    const lookup = makeDirListingLookup(
      (): Promise<Array<{ name: string; dir: boolean }>> =>
        new Promise((r) => {
          calls++
          resolvers.push(r)
        })
    )
    const older = lookup.listDir('/d')
    const newer = lookup.listDir('/d')
    resolvers[1]([{ name: 'new', dir: false }])
    await newer
    resolvers[0]([{ name: 'old', dir: false }])
    await older
    await expect(lookup('/d/new')).resolves.toEqual({ exists: true, dir: false })
    expect(calls).toBe(2)
  })

  it('listDir returns a copy of the cached listing', async () => {
    const lookup = makeDirListingLookup(async () => [{ name: 'a', dir: false }])
    const first = await lookup.listDir('/d')
    first.length = 0
    await expect(lookup.listDir('/d')).resolves.toEqual([{ name: 'a', dir: false }])
  })
})

describe('review fixes: symlinked directories and dot segments', () => {
  /** Listings given verbatim, so an entry can be a directory symlink (reported `dir: false`). */
  function rawDeps(listings: Record<string, Array<{ name: string; dir: boolean }>>) {
    const lookup = makeDirListingLookup(async (dir) => listings[dir] ?? [])
    return { getCwd: () => '/repo', lookup, listDir: lookup.listDir }
  }

  it('follows a directory symlink that the listing reports as a file', async () => {
    const deps = rawDeps({
      '/lnk': [{ name: 'My Docs', dir: false }],
      '/lnk/My Docs': [{ name: 'a.txt', dir: false }]
    })
    const links = await resolveFileLinks(view(80, ['cat /lnk/My Docs/a.txt']), 0, deps)
    expect(links.map((l) => l.abs)).toEqual(['/lnk/My Docs/a.txt'])
  })

  it('follows a symlinked directory across an indented wrap (/etc then /hosts)', async () => {
    const deps = rawDeps({
      '/': [{ name: 'etc', dir: false }],
      '/etc': [{ name: 'hosts', dir: false }]
    })
    const links = await resolveFileLinks(view(40, ['see /etc', '  /hosts']), 1, deps)
    expect(links.map((l) => l.abs)).toEqual(['/etc/hosts'])
  })

  it('rejects a non-directory followed by / when its listing is empty', async () => {
    const deps = rawDeps({ '/lnk': [{ name: 'My Docs', dir: false }] })
    await expect(resolveFileLinks(view(80, ['cat /lnk/My Docs/a.txt']), 0, deps)).resolves.toEqual(
      []
    )
    // `…/My Docs/` then a space would otherwise link the FILE as a directory.
    await expect(resolveFileLinks(view(80, ['cat /lnk/My Docs/ now']), 0, deps)).resolves.toEqual(
      []
    )
  })

  it('handles . and .. segments after the extension starts, normalized', async () => {
    const { deps } = fsDeps(['/data/My Docs/report.txt', '/data/x/a.ts'])
    const dot = await resolveFileLinks(view(80, ['/data/My Docs/./report.txt']), 0, deps)
    expect(dot.map((l) => [l.text, l.abs])).toEqual([
      ['/data/My Docs/./report.txt', '/data/My Docs/report.txt']
    ])
    const up = await resolveFileLinks(view(80, ['/data/My Docs/../x/a.ts']), 0, deps)
    expect(up.filter((l) => l.text.startsWith('/data')).map((l) => [l.text, l.abs])).toEqual([
      ['/data/My Docs/../x/a.ts', '/data/x/a.ts']
    ])
  })

  it('never walks .. above / or above ~', async () => {
    const { deps } = fsDeps(['/My Docs/', '/etc/', '~/My Docs/'])
    const root = await resolveFileLinks(view(80, ['/My Docs/../../etc']), 0, deps)
    expect(root.filter((l) => l.text.startsWith('/My'))).toEqual([])
    const home = await resolveFileLinks(view(80, ['~/My Docs/../../etc']), 0, deps)
    expect(home.filter((l) => l.text.startsWith('~'))).toEqual([])
  })
})

describe('review fixes: unicode names, seam ties, join budget', () => {
  it('treats a Unicode letter after a name as part of the word (no false link)', async () => {
    const { deps } = fsDeps(['/data/My Docs'])
    await expect(resolveFileLinks(view(80, ['open /data/My Docsé now']), 0, deps)).resolves.toEqual(
      []
    )
    const combining = await resolveFileLinks(view(80, ['open /data/My Docsé now']), 0, deps)
    expect(combining).toEqual([])
    // Punctuation after the name still ends it.
    const [l] = await resolveFileLinks(view(80, ['open "/data/My Docs".']), 0, deps)
    expect(l.abs).toBe('/data/My Docs')
  })

  it('breaks an equal-span seam tie in favour of the longer name (the spaced one)', async () => {
    // `MyDocs` is listed first, so a first-entry-wins rule would pick it.
    const { deps } = fsDeps(['/data/MyDocs/report.txt', '/data/My Docs/report.txt'])
    for (const row of [0, 1]) {
      const links = await resolveFileLinks(
        view(40, ['see /data/My', '  Docs/report.txt']),
        row,
        deps
      )
      expect(links.map((l) => l.abs)).toEqual(['/data/My Docs/report.txt'])
    }
  })

  it('gives the same link from either row after a long run of indented prose', async () => {
    const rows = [
      ...Array.from({ length: 31 }, (_, i) => `  prose line ${i} ends here`),
      '  see /data/My Docs/',
      '  report.txt'
    ]
    const { deps } = fsDeps(['/data/My Docs/report.txt'])
    for (const row of [31, 32]) {
      const links = await resolveFileLinks(view(40, rows), row, deps)
      expect(links.map((l) => l.abs)).toEqual(['/data/My Docs/report.txt'])
    }
  })
})

describe('review fixes: dot segments after a wrap, window from the token row', () => {
  it('handles ./ and ../ on the indented continuation row, from both rows', async () => {
    const { deps } = fsDeps(['/data/My Docs/report.txt', '/data/x/a.ts'])
    const cases: Array<[string[], string]> = [
      [['see /data/My Docs/', '  ./report.txt'], '/data/My Docs/report.txt'],
      [['see /data/My Docs/', '  ../x/a.ts'], '/data/x/a.ts']
    ]
    for (const [rows, abs] of cases) {
      for (const row of [0, 1]) {
        const links = await resolveFileLinks(view(40, rows), row, deps)
        expect(links.filter((l) => l.text.startsWith('/data')).map((l) => l.abs)).toEqual([abs])
      }
    }
  })

  it('counts the row budget from the token row, not a long soft-wrapped paragraph start', async () => {
    const rows = [
      'prose text here',
      ...Array.from({ length: 30 }, () => 'w:more prose text'),
      'w:see /data/My Docs/',
      '  report.txt'
    ]
    const { deps } = fsDeps(['/data/My Docs/report.txt'])
    for (const row of [31, 32]) {
      const links = await resolveFileLinks(view(40, rows), row, deps)
      expect(links.map((l) => l.abs)).toEqual(['/data/My Docs/report.txt'])
    }
  })
})
