import type { Terminal } from '@xterm/xterm'

/**
 * Make the DOM and WebGL renderers agree on the cell width, so a renderer swap (budget grant or
 * release) is horizontally pixel-stable instead of visibly reflowing the text.
 *
 * The disagreement is a rounding split inside xterm: the WebGL renderer FLOORS the measured char
 * width to whole device pixels (`Math.floor(charWidth × dpr)` — its glyph atlas needs an integer
 * grid), while the DOM renderer uses the RAW fractional measurement and pins each row's advance
 * to it via `letter-spacing`. A char measured at 8.43px therefore lays out on an 8.0px cell under
 * WebGL and an 8.43px cell under DOM — ~30px of drift across 80 columns, which is what a swap
 * flashes as "the text got wider".
 *
 * The fix quantizes at the SOURCE both renderers read: `CharSizeService`'s measure strategy is
 * wrapped so every measurement lands on the device-pixel grid (`floor(width × dpr) / dpr`).
 * The WebGL floor then loses nothing (it floors an already-integer product) and the DOM renderer
 * lays out on the identical cell — and `fit`/`proposeDimensions` read the same service, so the
 * column math stays consistent with what either renderer draws. Height is left alone: both
 * renderers already ceil it through the same formula.
 *
 * Costs and edges, called out because they are deliberate:
 *  - A cell can narrow by at most 1/dpr px (≤0.5px on retina) versus the unquantized DOM cell.
 *  - The dpr is read at MEASURE time (live, via the core's browser service with a window
 *    fallback). Moving the window to a display with a different dpr re-quantizes on the next
 *    measure (font/size changes, refresh); until one runs, the widths sit on the old grid —
 *    exactly the pre-existing xterm behaviour for its own dpr-derived dimensions.
 *  - This pokes xterm internals (`_core._charSizeService._measureStrategy`), in the same
 *    guarded, fail-open style as TerminalNode's `restoreDomRenderer`: if any field is missing
 *    on a future xterm, the wrap silently does not install and both renderers keep xterm's
 *    stock behaviour — nothing regresses but the swap parity.
 *
 * Idempotent per terminal (a marker on the strategy), safe to call on every mount/adopt. Returns
 * whether the quantizing wrap is installed.
 */
interface MeasureResult {
  width: number
  height: number
}
interface MeasureStrategyLike {
  measure(): Readonly<MeasureResult>
  __ntQuantized?: boolean
}
interface CharSizeServiceLike {
  measure(): void
  _measureStrategy?: MeasureStrategyLike
}
interface CoreLike {
  _charSizeService?: CharSizeServiceLike
  _coreBrowserService?: { dpr?: number }
}

export function quantizeCharSize(
  term: Terminal,
  win: { devicePixelRatio?: number } | undefined = typeof window === 'undefined' ? undefined : window
): boolean {
  try {
    const core = (term as unknown as { _core?: CoreLike })._core
    const svc = core?._charSizeService
    const strategy = svc?._measureStrategy
    if (!svc || typeof svc.measure !== 'function' || !strategy || typeof strategy.measure !== 'function') {
      return false
    }
    if (strategy.__ntQuantized) return true
    const original = strategy.measure.bind(strategy)
    strategy.measure = () => {
      const result = original()
      const dpr = core?._coreBrowserService?.dpr || win?.devicePixelRatio || 1
      if (!result || !Number.isFinite(result.width) || !Number.isFinite(dpr) || dpr <= 0) return result
      const quantized = Math.floor(result.width * dpr) / dpr
      // A sub-device-pixel font would quantize to 0 and invalidate the whole char size — keep
      // the raw measurement there (the renderers disagree again, but they draw).
      if (quantized <= 0) return result
      return { width: quantized, height: result.height }
    }
    strategy.__ntQuantized = true
    // Re-measure NOW: `term.open()` already measured unquantized, and the renderer built from
    // that measurement is live. The service change-gates internally, so this fires its
    // char-size-change event (renderers recompute dimensions) only when the width actually moves.
    svc.measure()
    return true
  } catch {
    return false
  }
}
