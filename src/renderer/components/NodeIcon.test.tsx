import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NODE_GLYPHS } from '@shared/node-icon'
import { NodeIconView } from './NodeIcon'

// Issue #291: a glyph icon draws through the one NodeIconView every listing surface uses.
describe('NodeIconView glyphs', () => {
  it('draws every curated glyph as an svg in the icon box', () => {
    for (const glyph of NODE_GLYPHS) {
      const html = renderToStaticMarkup(
        <NodeIconView icon={{ type: 'lucide', name: glyph.id }} size={15} />
      )
      expect(html, glyph.id).toMatch(/^<span class="node-icon"[^>]*><svg/)
      expect(html).toContain('width:15px')
    }
  })

  it('draws nothing for a name outside the allowlist, same as an unreadable image', () => {
    expect(renderToStaticMarkup(<NodeIconView icon={{ type: 'lucide', name: 'skull' }} />)).toBe('')
  })

  // The canvas header is the other surface the issue names. TerminalNode is too large to mount
  // here, so pin that its header icon is this same component and not a per-surface copy.
  it('is what the terminal node header renders', () => {
    const src = readFileSync(join(__dirname, '..', 'nodes', 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const header = src.slice(src.indexOf('<div className="term-node__header">'))
    expect(header).toMatch(/<NodeIconView icon=\{data\.icon as NodeIcon\}/)
  })
})
