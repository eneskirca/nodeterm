import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const RENDERER = join(__dirname, '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sources(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/**
 * The palette now has STRUCTURE — two sections and a name per swatch — and the reason it is one
 * component rather than six copies of `NODE_COLORS.map(...)` is that six copies each have to grow
 * the heading, the tooltip and the accessible name separately, and the one that doesn't is the one
 * where the user cannot tell which circle is Claude's.
 *
 * The failure this catches is concrete and cheap to make: a new node kind copy-pastes the popover
 * block out of `TerminalNode`, and its picker silently offers half a palette. Same shape as the
 * `fs.rename` and tmux-socket guards — nobody reading one file can see it.
 */
describe('every color picker renders the shared, sectioned palette', () => {
  const files = sources(RENDERER)

  it('only NodeColorSwatches may own a .color-popover container', () => {
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      // The class is only ever legitimate as the container NodeColorSwatches is asked to draw.
      for (const match of src.matchAll(/className="color-popover"/g)) {
        const before = src.slice(Math.max(0, match.index - 200), match.index)
        if (!/<NodeColorSwatches[^>]*$/.test(before)) {
          offenders.push(relative(RENDERER, file))
        }
      }
    }
    expect(offenders, 'render the palette through <NodeColorSwatches className="color-popover">').toEqual([])
  })

  it('no renderer file maps over the palette to build its own swatch row', () => {
    // NODE_COLORS itself stays importable (fallback colors, rotations); what must not come back is
    // a hand-rolled picker built by mapping it.
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(join('components', 'NodeColorSwatches.tsx'))) continue
      const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
      if (/\bNODE_COLORS\.map\(/.test(src)) offenders.push(relative(RENDERER, file))
    }
    expect(
      offenders,
      'use <NodeColorSwatches>, or SYSTEM_NODE_COLOR_SWATCHES where the value is drawn as text'
    ).toEqual([])
  })
})
