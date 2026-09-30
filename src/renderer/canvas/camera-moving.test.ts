import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

// The viewport must never be promoted with `will-change: transform` — not permanently and not
// during a camera move. MEASURED (see the comment in styles.css where the rule used to be): it
// overran Chromium's tile budget on a real canvas (blank tiles = flicker) with no CPU gain.
describe('viewport is never promoted', () => {
  it('styles.css has no will-change on .react-flow__viewport', () => {
    const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = css.match(/[^{}]*\.react-flow__viewport[^{]*\{[^}]*\}/g) ?? []
    for (const r of rules) expect(r).not.toMatch(/will-change/)
    expect(css).not.toContain('.canvas-camera-moving')
  })

  it('Canvas no longer toggles a camera-moving class', () => {
    expect(read('canvas/Canvas.tsx')).not.toContain('canvas-camera-moving')
  })
})
