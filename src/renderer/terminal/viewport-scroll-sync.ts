import type { Terminal } from '@xterm/xterm'

/**
 * Keeps xterm's DOM `Viewport` synchronized with `BufferService` and `RenderService` across:
 *
 * 1. **Full-scrollback clear + rewrite bursts (`CSI 3 J`, `\x1b[3J`)** — TUIs that render in the
 *    normal buffer using an inline strategy (such as Antigravity CLI `agy`, which emits
 *    `\x1b[2J\x1b[3J\x1b[H` before rewriting a multi-page conversation) trigger two xterm bugs:
 *    - `InputHandler.eraseInDisplay(3)` trims the scrollback and zeros `ybase`/`ydisp`, but never
 *      resets `BufferService.isUserScrolling`. If `isUserScrolling` was set, the multi-page write
 *      that immediately follows advances `ybase` while leaving `ydisp` stuck at `0`.
 *    - In `Viewport._innerRefresh()`, xterm shrinks `_scrollArea.style.height` BEFORE reading
 *      `this._viewportElement.scrollTop !== scrollTop`. Shrinking the scroll area causes Blink to
 *      clamp `scrollTop` to `0` during the synchronous layout forced by reading `scrollTop` and
 *      enqueue a native DOM `'scroll'` event. Because the clamped `scrollTop` (`0`) already equals
 *      the target `scrollTop` (`0`), xterm skips setting `_ignoreNextScrollEvent = true`. When the
 *      queued DOM `'scroll'` event fires on the next frame (after the multi-page rewrite has moved
 *      `ybase`/`ydisp` to the bottom), `Viewport._handleScroll` mistakes it for a user scroll to
 *      row `0`, locking `isUserScrolling = true` and yanking `ydisp` back to the top.
 *    - Conversely, if `_innerRefresh()` sets `_ignoreNextScrollEvent = true` and assigns a
 *      `scrollTop` that the browser clamps back to its previous value, no DOM `'scroll'` event
 *      fires and `_ignoreNextScrollEvent` stays stuck `true`, swallowing the user's wheel scroll.
 *
 * 2. **Renderer swaps (`WebglAddon` acquire/release, `restoreDomRenderer`)** — `Viewport` caches
 *    `_renderService.dimensions` by reference at construction and updates it only on
 *    `onDimensionsChange`. `RenderService.setRenderer()` swaps the renderer without firing
 *    `onDimensionsChange`, leaving `Viewport._renderDimensions` pointing at a disposed or
 *    unmeasured renderer's dimensions and breaking row-height / scroll-area calculations.
 *
 * Guarded and fail-open in the same style as `quantizeCharSize` and `resyncDomRendererSpacing`:
 * if any private field is absent on a future xterm version, the patch leaves stock behavior intact.
 */
interface RenderDimensionsLike {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } }
  device: { cell: { width: number; height: number } }
}

interface RenderServiceLike {
  dimensions?: RenderDimensionsLike
  setRenderer?(renderer: unknown): void
  handleResize?(cols: number, rows: number): void
  __ntViewportSetRendererPatched?: boolean
}

interface BufferLike {
  lines: { length: number }
  ybase: number
  ydisp: number
}

interface BufferServiceLike {
  buffer: BufferLike
  isUserScrolling: boolean
}

interface ViewportLike {
  _viewportElement?: HTMLElement
  _scrollArea?: HTMLElement
  _renderDimensions?: RenderDimensionsLike
  _activeBuffer?: BufferLike
  _currentRowHeight?: number
  _currentDeviceCellHeight?: number
  _lastRecordedBufferLength?: number
  _lastRecordedViewportHeight?: number
  _lastRecordedBufferHeight?: number
  _lastScrollTop?: number
  _ignoreNextScrollEvent?: boolean
  _innerRefresh?(): void
  handleWheel?(ev: WheelEvent): boolean
  syncScrollArea?(immediate?: boolean): void
  __ntScrollSyncPatched?: boolean
}

interface CoreLike {
  _renderService?: RenderServiceLike
  _bufferService?: BufferServiceLike
  viewport?: ViewportLike
}

export function patchViewportScrollSync(term: Terminal): boolean {
  try {
    const core = (term as unknown as { _core?: CoreLike })._core
    const viewport = core?.viewport
    const renderService = core?._renderService
    const bufferService = core?._bufferService
    if (
      !core ||
      !viewport ||
      !renderService ||
      !bufferService ||
      typeof viewport._innerRefresh !== 'function' ||
      typeof viewport.syncScrollArea !== 'function'
    ) {
      return false
    }
    if (viewport.__ntScrollSyncPatched) return true
    viewport.__ntScrollSyncPatched = true

    const syncDimensionsRef = (): void => {
      try {
        const dims = renderService.dimensions
        if (!dims) return
        if (
          dims.device?.cell?.height === 0 &&
          term.cols > 0 &&
          term.rows > 0 &&
          typeof renderService.handleResize === 'function'
        ) {
          renderService.handleResize(term.cols, term.rows)
        }
        if (renderService.dimensions) {
          viewport._renderDimensions = renderService.dimensions
        }
      } catch {
        // Ignore if renderer is not yet initialized.
      }
    }

    const origInnerRefresh = viewport._innerRefresh.bind(viewport)
    viewport._innerRefresh = (): void => {
      syncDimensionsRef()
      viewport._activeBuffer = bufferService.buffer
      viewport._lastRecordedBufferLength = bufferService.buffer.lines.length
      const viewportEl = viewport._viewportElement
      const prevScrollTop = viewportEl ? viewportEl.scrollTop : 0
      const wasIgnoring = Boolean(viewport._ignoreNextScrollEvent)
      origInnerRefresh()
      if (!viewportEl) return
      const afterScrollTop = viewportEl.scrollTop
      viewport._lastScrollTop = afterScrollTop
      // If `scrollTop` actually moved during `_innerRefresh` — including when shrinking
      // `_scrollArea.style.height` caused layout to clamp `scrollTop` before xterm's own equality
      // check ran — Blink has queued an async DOM `'scroll'` event that must be ignored so
      // `_handleScroll` does not mistake it for a user scroll. Conversely, if `scrollTop` did not
      // move at all (e.g. clamped back to `prevScrollTop`) and no earlier refresh in the same
      // frame is still awaiting its `'scroll'` event (`!wasIgnoring`), clear `_ignoreNextScrollEvent`
      // so the user's next wheel scroll is not swallowed.
      const didScrollTopChange = afterScrollTop !== prevScrollTop
      viewport._ignoreNextScrollEvent = wasIgnoring || didScrollTopChange
    }

    if (typeof viewport.handleWheel === 'function') {
      const origHandleWheel = viewport.handleWheel.bind(viewport)
      viewport.handleWheel = (ev: WheelEvent): boolean => {
        try {
          syncDimensionsRef()
          const buf = bufferService.buffer
          const rowHeight = viewport._currentRowHeight ?? 0
          const viewportEl = viewport._viewportElement
          const expectedScrollTop = buf.ydisp * rowHeight
          if (
            rowHeight <= 0 ||
            viewport._lastRecordedBufferLength !== buf.lines.length ||
            (viewportEl && Math.abs(viewportEl.scrollTop - expectedScrollTop) > Math.max(1, rowHeight))
          ) {
            viewport.syncScrollArea?.(true)
          }
        } catch {
          // Never block wheel handling if sync throws.
        }
        return origHandleWheel(ev)
      }
    }

    if (typeof renderService.setRenderer === 'function' && !renderService.__ntViewportSetRendererPatched) {
      const origSetRenderer = renderService.setRenderer.bind(renderService)
      renderService.__ntViewportSetRendererPatched = true
      renderService.setRenderer = (renderer: unknown): void => {
        origSetRenderer(renderer)
        try {
          syncDimensionsRef()
          viewport.syncScrollArea?.(true)
        } catch {
          // Ignore if viewport is not yet ready.
        }
      }
    }

    // `CSI 3 J` (Erase Saved Lines): xterm trims scrollback and sets `ybase = 0, ydisp = 0`,
    // leaving no scrollback above the viewport, so `isUserScrolling` must be cleared before
    // subsequent lines in the same write batch are parsed. Returning `false` lets xterm's own
    // `InputHandler.eraseInDisplay` execute after this hook.
    // Note: `term.parser.registerCsiHandler` passes `params` as `(number | number[])[]`
    // (via `IParams.toArray()`), whereas `_core.registerCsiHandler` passes `IParams` (`{ params }`).
    term.parser?.registerCsiHandler({ final: 'J' }, (params) => {
      try {
        const first = Array.isArray(params)
          ? params[0]
          : (params as unknown as { params?: number[] })?.params?.[0]
        if (first === 3) {
          bufferService.isUserScrolling = false
        }
      } catch {
        // Never allow a parser hook error to abort xterm's WriteBuffer loop.
      }
      return false
    })

    syncDimensionsRef()
    return true
  } catch {
    return false
  }
}
