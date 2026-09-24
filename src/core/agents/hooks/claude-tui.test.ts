import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { ensureFullscreenTui, ensureFullscreenTuiInFile, TUI_FULLSCREEN } from './claude-tui'

describe('ensureFullscreenTui (pure)', () => {
  it('writes tui=fullscreen when the key is absent', () => {
    const { config, changed } = ensureFullscreenTui({})
    expect(changed).toBe(true)
    expect(config.tui).toBe(TUI_FULLSCREEN)
  })

  it('preserves every other key when it writes', () => {
    const { config } = ensureFullscreenTui({ hooks: { Stop: [] }, model: 'x' })
    expect(config).toEqual({ hooks: { Stop: [] }, model: 'x', tui: TUI_FULLSCREEN })
  })

  it('never overwrites an existing tui value (write-if-absent) — any value', () => {
    for (const value of ['default', 'fullscreen', 'garbage', 42, null]) {
      const input = { tui: value, other: 1 }
      const { config, changed } = ensureFullscreenTui(input as never)
      expect(changed).toBe(false)
      expect(config).toBe(input) // returned untouched (same reference)
    }
  })

  it("treats an explicit tui:undefined as present (the key exists → don't touch)", () => {
    const { changed } = ensureFullscreenTui({ tui: undefined })
    expect(changed).toBe(false)
  })
})

describe('ensureFullscreenTuiInFile (fail-open file wrapper)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nt-tui-'))

  it('creates the key in a missing file (parents made, valid JSON written)', () => {
    const p = path.join(dir, 'nested', 'settings.json')
    expect(ensureFullscreenTuiInFile(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ tui: TUI_FULLSCREEN })
  })

  it('leaves a file that already has a tui value untouched, byte-for-byte', () => {
    const p = path.join(dir, 'has-tui.json')
    const original = JSON.stringify({ tui: 'default', hooks: { Stop: [] } }, null, 2)
    writeFileSync(p, original, 'utf8')
    expect(ensureFullscreenTuiInFile(p)).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe(original)
  })

  it('merges into an existing file without a tui key, preserving its contents', () => {
    const p = path.join(dir, 'no-tui.json')
    writeFileSync(p, JSON.stringify({ hooks: { Stop: [{ x: 1 }] } }), 'utf8')
    expect(ensureFullscreenTuiInFile(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({
      hooks: { Stop: [{ x: 1 }] },
      tui: TUI_FULLSCREEN
    })
  })

  it('NEVER touches a file that exists but does not parse (data loss beats a rendering default)', () => {
    // Unlike install-helper, which normalizes a corrupt file: if the hook merge bailed early,
    // this pass would be the FIRST writer here, and replacing the user's settings with {tui:...}
    // would silently destroy every real key they had.
    const p = path.join(dir, 'corrupt.json')
    writeFileSync(p, '{ not json', 'utf8')
    expect(ensureFullscreenTuiInFile(p)).toBe(false)
    expect(readFileSync(p, 'utf8')).toBe('{ not json')
  })

  it('initializes a successfully read empty file' , () => {
    const p = path.join(dir, 'empty.json')
    writeFileSync(p, '', 'utf8')
    expect(ensureFullscreenTuiInFile(p)).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ tui: TUI_FULLSCREEN })
  })
})
