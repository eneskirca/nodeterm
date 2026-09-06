import type { Terminal } from '@xterm/xterm'

/**
 * Re-derive the DOM renderer's row spacing once the terminal element is measurable again.
 *
 * xterm's DOM renderer does not lay glyphs out on a grid — it pins the advance with CSS
 * `letter-spacing`, computed ONCE per renderer instance as `cell.width - widthCache('W')`
 * (`DomRenderer._setDefaultSpacing`). The width cache measures with `offsetWidth`, which is **0**
 * for an element that is not in the rendered tree — so a DOM renderer built while the node is
 * detached or `display:none` bakes in `letter-spacing: <a whole cell>` and every character sits a
 * space too far apart.
 *
 * That is not hypothetical: `releaseWebgl` runs from the lifecycle effect's cleanup, i.e. AFTER
 * React has removed the node's DOM, and `WebglAddon.dispose()` is also the put-xterm-back-on-a-DOM-
 * renderer path. A project switch therefore parks every terminal with a mismeasured renderer, and
 * the adopting mount paints it wide until the WebGL grant lands (`WEBGL_ACQUIRE_DEBOUNCE_MS`) —
 * the visible "letters drift apart for a split second". Focus mode's `display:none` wrapper
 * reclaims hidden grants the same way.
 *
 * xterm recomputes the spacing on a char-size / dpr / options change and NOT on a resize, so
 * nothing in the normal reattach path heals it. `handleCharSizeChanged()` is the narrowest lever
 * that does (re-measure, clear the width cache, re-derive the spacing).
 *
 * Change-gated, because this runs on every fit: the comparison costs one cached cache read, and a
 * terminal whose spacing already agrees is left completely alone. A measurement of 0 means the
 * element is still not rendered — nothing can be derived, so it bails rather than re-baking the
 * same wrong number. Guarded internals in the same fail-open style as `quantizeCharSize` and
 * TerminalNode's `restoreDomRenderer`: a future xterm that renames a field silently keeps its
 * stock behaviour. Only xterm's DOM renderer carries a width cache, so the WebGL renderer and the
 * shared glyph addon bail on the first gate.
 *
 * Returns whether the spacing was actually re-derived (the caller owes a repaint).
 */
const SPACING_EPS = 0.01

interface WidthCacheLike {
  get(char: string, bold: boolean, italic: boolean): number
}
interface DomRendererLike {
  _widthCache?: WidthCacheLike
  _rowFactory?: { defaultSpacing: number }
  dimensions?: { css?: { cell?: { width?: number } } }
  handleCharSizeChanged?(): void
}

export function resyncDomRendererSpacing(term: Terminal): boolean {
  try {
    const renderer = (
      term as unknown as {
        _core?: { _renderService?: { _renderer?: { value?: DomRendererLike } } }
      }
    )._core?._renderService?._renderer?.value
    const cache = renderer?._widthCache
    const factory = renderer?._rowFactory
    if (!renderer || !cache || !factory || typeof renderer.handleCharSizeChanged !== 'function') {
      return false
    }
    const cellWidth = renderer.dimensions?.css?.cell?.width
    if (!Number.isFinite(cellWidth) || !cellWidth) return false
    const measured = cache.get('W', false, false)
    if (!(measured > 0)) return false
    if (Math.abs((cellWidth as number) - measured - factory.defaultSpacing) <= SPACING_EPS) {
      return false
    }
    renderer.handleCharSizeChanged()
    return true
  } catch {
    return false
  }
}
