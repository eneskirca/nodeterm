import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NODE_GLYPHS } from '@shared/node-icon'
import { NodeIconView } from './NodeIcon'
import { ProjectGlyph, lucideIcon } from './ProjectGlyph'

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
  // The header's icon BUTTON is conditional; it must be gated on the normalized icon, or an
  // invalid stored value leaves an empty button (and a flex gap) in the header.
  it('gates the terminal header icon button on the normalized icon', () => {
    const src = readFileSync(join(__dirname, '..', 'nodes', 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const header = src.slice(src.indexOf('<div className="term-node__header">'))
    expect(header).toMatch(/\{headerIcon \? \(\s*<button\s+className="term-node__icon nodrag"/)
    expect(src).toMatch(/const headerIcon = normalizeNodeIcon\(data\.icon\)/)
  })

  it('is what the terminal node header renders', () => {
    const src = readFileSync(join(__dirname, '..', 'nodes', 'TerminalNode.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const header = src.slice(src.indexOf('<div className="term-node__header">'))
    expect(header).toMatch(/<NodeIconView icon=\{headerIcon\}/)
  })
})

// Codex review of #291: persisted icons reach NodeIconView WITHOUT passing through
// `nodeStatesToFlow` (an inactive project's rows in `buildSessionList`, kanban, a relay mirror).
// A bracket lookup on a plain object map answers `__proto__` / `constructor` / `toString` with an
// inherited value, and React throws rendering it — taking the whole sidebar down.
describe('NodeIconView at the render boundary', () => {
  const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']

  it('draws nothing, and does not throw, for a prototype key', () => {
    for (const name of hostile) {
      expect(() => renderToStaticMarkup(<NodeIconView icon={{ type: 'lucide', name }} />), name).not.toThrow()
      expect(renderToStaticMarkup(<NodeIconView icon={{ type: 'lucide', name }} />), name).toBe('')
    }
  })

  it('draws nothing for a project-only glyph outside NODE_GLYPHS', () => {
    // `heart` is in LUCIDE_ICON_IDS (projects) but not a node glyph.
    expect(renderToStaticMarkup(<NodeIconView icon={{ type: 'lucide', name: 'heart' }} />)).toBe('')
  })

  it('normalizes the other kinds too: a hostile image path draws nothing', () => {
    expect(
      renderToStaticMarkup(<NodeIconView icon={{ type: 'image', path: '/home/u/.ssh/id_rsa' }} />)
    ).toBe('')
    expect(renderToStaticMarkup(<NodeIconView icon={{ type: 'emoji', value: 'ab' }} />)).toContain('>a<')
  })
})

describe('lucideIcon / ProjectGlyph prototype keys', () => {
  it('answers only own entries of the map', () => {
    expect(lucideIcon('database')).toBeTruthy()
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(lucideIcon(name), name).toBeUndefined()
    }
  })

  it('a project glyph with a prototype-key name falls back instead of throwing', () => {
    for (const name of ['__proto__', 'constructor', 'toString']) {
      const render = (): string =>
        renderToStaticMarkup(<ProjectGlyph icon={{ type: 'lucide', name }} name="Proj" color="#123" />)
      expect(render, name).not.toThrow()
      expect(render()).toContain('>P<')
    }
  })
})
