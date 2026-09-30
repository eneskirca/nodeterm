import { describe, expect, it } from 'vitest'
import fixture from './__fixtures__/claude-image-paste.json'
import {
  confirmImagePaste,
  expectedImagePlaceholders,
  imagePasteNotice,
  imagePlaceholderNumbers,
  pasteWithImageReceipt,
  xtermScreenText
} from './image-paste-confirm'
import { escapeDroppedPath } from './file-drop'

// Screens captured from Claude Code 2.1.285 (see the fixture's provenance). `before` is the pane
// after one earlier paste (#12 on screen); `pngAndBmp` after pasting a png and a bmp together;
// `missingPng` after pasting a .png path that does not exist.
const F = fixture

describe('expectation: only claude, only the extensions claude turned into [Image #N]', () => {
  it('counts png/jpg/jpeg/gif/webp in any case, not bmp/svg/heic/tiff', () => {
    const paths = ['/a/x.png', '/a/x.JPG', '/a/x.jpeg', '/a/x.gif', '/a/x.webp', '/a/x.bmp', '/a/x.svg', '/a/x.heic', '/a/x.tiff']
    expect(expectedImagePlaceholders('claude', paths)).toBe(5)
  })
  it('an escaped space still ends in the extension', () => {
    expect(expectedImagePlaceholders('claude', [escapeDroppedPath('/a/pasted 2.png')])).toBe(1)
  })
  it('other agents and no agent get no expectation (nothing is claimed for them)', () => {
    for (const a of ['codex', 'gemini', 'grok', 'copilot', 'opencode', undefined])
      expect(expectedImagePlaceholders(a, ['/a/x.png'])).toBe(0)
  })
})

describe('confirmation over the captured screens', () => {
  const read = (seq: string[]) => {
    let i = 0
    return () => seq[Math.min(i++, seq.length - 1)]
  }
  const fast = { sleep: async () => {}, timeoutMs: 100, pollMs: 1 }

  it('a new placeholder number confirms, even though it is not #1', async () => {
    const before = imagePlaceholderNumbers(F.before.screen)
    expect([...before]).toEqual([12])
    const n = expectedImagePlaceholders('claude', F.pngAndBmp.pasted.trim().split(' '))
    expect(n).toBe(1)
    let t = 0
    expect(
      await confirmImagePaste({ before, expected: n, read: read([F.before.screen, F.pngAndBmp.screen]), now: () => t++, ...fast })
    ).toBe('confirmed')
  })

  it('a placeholder already on screen before the paste never confirms it', async () => {
    const before = imagePlaceholderNumbers(F.pngAndBmp.screen)
    let t = 0
    expect(
      await confirmImagePaste({ before, expected: 1, read: read([F.missingPng.screen]), now: () => t++, ...fast })
    ).toBe('unconfirmed')
  })

  it('a path claude kept as text is reported as not confirmed', () => {
    expect(imagePasteNotice('unconfirmed', 1)).toEqual({ text: 'Pasted the path — not confirmed as an image', ok: false })
    expect(imagePasteNotice('confirmed', 2)).toEqual({ text: '2 images attached', ok: true })
  })
})

// A minimal xterm stand-in: rows of text, with soft-wrap flags.
function fakeTerm(rows: { text: string; wrapped?: boolean }[]) {
  const pasted: string[] = []
  const term = {
    rows: rows.length,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y: number) =>
          rows[y] ? { isWrapped: !!rows[y].wrapped, translateToString: () => rows[y].text } : undefined
      }
    },
    paste: (t: string) => pasted.push(t)
  }
  return { term: term as unknown as Parameters<typeof xtermScreenText>[0] & { paste: (t: string) => void }, rows, pasted }
}

describe('reading the emulator', () => {
  it('joins a soft-wrapped placeholder back into one token', () => {
    const { term } = fakeTerm([{ text: '❯ [Imag' }, { text: 'e #7]', wrapped: true }])
    expect([...imagePlaceholderNumbers(xtermScreenText(term))]).toEqual([7])
  })

  it('pasteWithImageReceipt: pastes exactly the text, then reports what the pane showed', async () => {
    const f = fakeTerm(F.before.screen.split('\n').map((text) => ({ text })))
    const reports: { text: string; ok: boolean }[] = []
    pasteWithImageReceipt(f.term, '/work/project/pasted-1.png ', ['/work/project/pasted-1.png'], 'claude', (r) =>
      reports.push(r)
    )
    expect(f.pasted).toEqual(['/work/project/pasted-1.png '])
    // The pane repaints with the new placeholder.
    f.rows.splice(0, f.rows.length, ...F.pngAndBmp.screen.split('\n').map((text) => ({ text })))
    for (let i = 0; i < 50 && !reports.length; i++) await new Promise((r) => setTimeout(r, 10))
    expect(reports).toEqual([{ text: 'Image attached', ok: true }])
  })

  it('an agent we did not measure gets the paste and no receipt at all', async () => {
    const f = fakeTerm([{ text: '❯' }])
    const reports: unknown[] = []
    pasteWithImageReceipt(f.term, '/a/x.png ', ['/a/x.png'], 'codex', (r) => reports.push(r))
    await new Promise((r) => setTimeout(r, 30))
    expect(f.pasted).toEqual(['/a/x.png '])
    expect(reports).toEqual([])
  })
})

describe('both terminal surfaces paste files through the receipt', () => {
  it('TerminalNode and ModalTerminal never paste a file path with a bare term.paste', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const rel of ['src/renderer/nodes/TerminalNode.tsx', 'src/renderer/components/kanban/ModalTerminal.tsx']) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n')
      expect(src, rel).toMatch(/pasteWithImageReceipt\(\s*term,\s*paths\.join\(' '\) \+ ' ',/)
      expect(src, rel).not.toMatch(/term\.paste\(paths\.join/)
      expect(src, rel).toMatch(/term-paste-pill/)
    }
  })
})

describe('review: only numbers ABOVE the highest one on screen confirm', () => {
  it('an older placeholder scrolling into view does not confirm this paste', async () => {
    let t = 0
    const out = await confirmImagePaste({
      before: new Set([12]),
      expected: 1,
      read: () => '❯ [Image #3] [Image #12]', // #3 was scrolled off before the paste
      now: () => t++,
      sleep: async () => {},
      timeoutMs: 50,
      pollMs: 1
    })
    expect(out).toBe('unconfirmed')
  })
})
