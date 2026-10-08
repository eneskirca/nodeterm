import { describe, expect, it } from 'vitest'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createOsc8LinkHandler,
  createUrlLinkProvider,
  makeDirListingLookup,
  matchFileTokens,
  matchUrlTokens,
  osc8UrlAt,
  paragraphContaining,
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

  it.each(['hard', 'soft'])('keeps every hovered row inside a capped %s-wrapped paragraph', (wrap) => {
    const text = Array.from({ length: 80 }, (_, row) => String(row).padStart(10, '0'))
    const v = view(10, text.map((line, row) => wrap === 'soft' && row > 0 ? `w:${line}` : line))
    for (let row = 0; row < text.length; row++) {
      const p = paragraphContaining(v, row)!
      expect(p.startRow).toBeLessThanOrEqual(row)
      expect(p.startRow + p.rows, `hovered row ${row}`).toBeGreaterThan(row)
      expect(p.rows).toBeLessThanOrEqual(32)
      const offset = (row - p.startRow) * v.cols
      expect(p.text.slice(offset, offset + v.cols)).toBe(text[row])
    }
  })

  it('offers the complete URL when hovering its tail beyond the paragraph cap', () => {
    const v = view(10, [...Array.from({ length: 38 }, () => 'abcdefghij'), '!https://x', '.io/a'])
    const term = {
      cols: v.cols,
      buffer: { active: { length: v.length, getLine: (row: number) => {
        const line = v.line(row)
        return line && { isWrapped: line.isWrapped, translateToString: line.text }
      } } }
    } as unknown as Terminal
    const opened: string[] = []
    let links: ILink[] | undefined
    createUrlLinkProvider(term, (url) => opened.push(url)).provideLinks(40, (found) => { links = found })
    expect(links).toHaveLength(1)
    expect(links![0].text).toBe('https://x.io/a')
    expect(links![0].range).toEqual({ start: { x: 2, y: 39 }, end: { x: 5, y: 40 } })
    links![0].activate({ ctrlKey: true, metaKey: false } as MouseEvent, links![0].text)
    expect(opened).toEqual(['https://x.io/a'])
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
