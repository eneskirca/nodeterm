import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { resyncDomRendererSpacing } from './dom-renderer-spacing'

/**
 * A structural fake of exactly the xterm internals the helper reaches for (the guarded-internals
 * style `quantizeCharSize` and `restoreDomRenderer` are tested against). `measuredW` is what the
 * width cache reports: 0 stands for the element not being in the rendered tree — the park /
 * display:none case the whole helper exists for.
 */
function fakeTerm(opts: { cellWidth?: number; defaultSpacing: number; measuredW: number }) {
  const calls = { charSizeChanged: 0, cacheReads: 0 }
  const renderer = {
    dimensions: { css: { cell: { width: opts.cellWidth ?? 8 } } },
    _rowFactory: { defaultSpacing: opts.defaultSpacing },
    _widthCache: {
      get() {
        calls.cacheReads++
        return opts.measuredW
      }
    },
    handleCharSizeChanged() {
      calls.charSizeChanged++
      renderer._rowFactory.defaultSpacing =
        renderer.dimensions.css.cell.width - renderer._widthCache.get()
    }
  }
  const term = {
    _core: { _renderService: { _renderer: { value: renderer } } }
  } as unknown as Terminal
  return { term, renderer, calls }
}

describe('resyncDomRendererSpacing', () => {
  it('re-derives the spacing a detached renderer baked in (a whole cell too wide)', () => {
    // Built while unmeasurable: cell.width - 0 = a full cell of letter-spacing.
    const { term, renderer, calls } = fakeTerm({ cellWidth: 8, defaultSpacing: 8, measuredW: 8.43 })
    expect(resyncDomRendererSpacing(term)).toBe(true)
    expect(calls.charSizeChanged).toBe(1)
    expect(renderer._rowFactory.defaultSpacing).toBeCloseTo(-0.43, 5)
  })

  it('leaves a terminal whose spacing already agrees completely alone', () => {
    const { term, calls } = fakeTerm({ cellWidth: 8, defaultSpacing: -0.43, measuredW: 8.43 })
    expect(resyncDomRendererSpacing(term)).toBe(false)
    expect(calls.charSizeChanged).toBe(0)
  })

  it('bails while the element is still unmeasurable, rather than baking the wrong number again', () => {
    const { term, calls } = fakeTerm({ cellWidth: 8, defaultSpacing: 8, measuredW: 0 })
    expect(resyncDomRendererSpacing(term)).toBe(false)
    expect(calls.charSizeChanged).toBe(0)
  })

  it('bails on a renderer without a width cache (WebGL, the shared glyph addon)', () => {
    const term = {
      _core: {
        _renderService: { _renderer: { value: { handleCharSizeChanged() {}, dimensions: {} } } }
      }
    } as unknown as Terminal
    expect(resyncDomRendererSpacing(term)).toBe(false)
  })

  it('fails open on missing internals', () => {
    expect(resyncDomRendererSpacing({} as unknown as Terminal)).toBe(false)
    expect(
      resyncDomRendererSpacing({ _core: { _renderService: {} } } as unknown as Terminal)
    ).toBe(false)
  })

  it('bails when the cell width is not known yet', () => {
    const { term, calls } = fakeTerm({ cellWidth: 0, defaultSpacing: 8, measuredW: 8.43 })
    expect(resyncDomRendererSpacing(term)).toBe(false)
    expect(calls.charSizeChanged).toBe(0)
  })
})
