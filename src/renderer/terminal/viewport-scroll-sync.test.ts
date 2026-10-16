import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { patchViewportScrollSync } from './viewport-scroll-sync'

interface FakeDims {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } }
  device: { cell: { width: number; height: number } }
}

function makeDims(cellH: number, canvasH: number): FakeDims {
  return {
    css: { canvas: { width: 640, height: canvasH }, cell: { width: 8, height: cellH } },
    device: { cell: { width: 8, height: cellH } }
  }
}

function createFakeTerm(opts?: { rows?: number; cols?: number; rowHeight?: number }) {
  const rows = opts?.rows ?? 50
  const cols = opts?.cols ?? 80
  const rowHeight = opts?.rowHeight ?? 16
  let csiJHandler: ((params: { params: number[] }) => boolean) | null = null

  const buffer = {
    lines: { length: 200 },
    ybase: 150,
    ydisp: 150
  }
  const bufferService = {
    buffer,
    isUserScrolling: false
  }

  let currentDims = makeDims(rowHeight, rows * rowHeight)
  let resizeCalls = 0
  const renderService = {
    get dimensions() {
      return currentDims
    },
    setRenderer(newRenderer: { dimensions: FakeDims }) {
      currentDims = newRenderer.dimensions
    },
    handleResize(_c: number, _r: number) {
      resizeCalls++
      if (currentDims.device.cell.height === 0) {
        currentDims = makeDims(rowHeight, rows * rowHeight)
      }
    }
  }

  let rawScrollTop = 150 * rowHeight
  let scrollAreaHeightPx = 200 * rowHeight
  const viewportHeight = rows * rowHeight

  // Simulate Blink's synchronous layout clamping when scrollArea.style.height shrinks and
  // viewportElement.scrollTop is subsequently read.
  const scrollArea = {
    style: {
      set height(v: string) {
        scrollAreaHeightPx = Number.parseFloat(v) || 0
      },
      get height() {
        return `${scrollAreaHeightPx}px`
      }
    }
  } as unknown as HTMLElement

  const viewportElement = {
    offsetHeight: viewportHeight,
    get scrollTop() {
      const maxScroll = Math.max(0, scrollAreaHeightPx - viewportHeight)
      if (rawScrollTop > maxScroll) {
        rawScrollTop = maxScroll
      }
      return rawScrollTop
    },
    set scrollTop(v: number) {
      const maxScroll = Math.max(0, scrollAreaHeightPx - viewportHeight)
      rawScrollTop = Math.max(0, Math.min(v, maxScroll))
    }
  } as unknown as HTMLElement

  let syncImmediateCalls = 0
  let wheelCalls = 0
  const viewport = {
    _viewportElement: viewportElement,
    _scrollArea: scrollArea,
    _renderDimensions: currentDims,
    _activeBuffer: buffer,
    _currentRowHeight: rowHeight,
    _currentDeviceCellHeight: rowHeight,
    _lastRecordedBufferLength: 200,
    _lastRecordedViewportHeight: viewportHeight,
    _lastRecordedBufferHeight: 200 * rowHeight,
    _lastScrollTop: 150 * rowHeight,
    _ignoreNextScrollEvent: false,
    _innerRefresh() {
      this._currentRowHeight = this._renderDimensions.device.cell.height
      this._currentDeviceCellHeight = this._renderDimensions.device.cell.height
      this._lastRecordedViewportHeight = viewportHeight
      const newBufferHeight =
        Math.round(this._currentRowHeight * this._lastRecordedBufferLength) +
        (this._lastRecordedViewportHeight - this._renderDimensions.css.canvas.height)
      if (this._lastRecordedBufferHeight !== newBufferHeight) {
        this._lastRecordedBufferHeight = newBufferHeight
        scrollArea.style.height = `${this._lastRecordedBufferHeight}px`
      }
      const scrollTop = bufferService.buffer.ydisp * this._currentRowHeight
      // Mirrors xterm's exact line 134: reading viewportElement.scrollTop triggers layout clamping!
      if (viewportElement.scrollTop !== scrollTop) {
        this._ignoreNextScrollEvent = true
        viewportElement.scrollTop = scrollTop
      }
    },
    syncScrollArea(immediate?: boolean) {
      if (immediate) {
        syncImmediateCalls++
        this._lastRecordedBufferLength = bufferService.buffer.lines.length
        this._innerRefresh()
      }
    },
    handleWheel(ev: WheelEvent) {
      wheelCalls++
      viewportElement.scrollTop += ev.deltaY
      return true
    }
  }

  const term = {
    cols,
    rows,
    parser: {
      registerCsiHandler(id: { final: string }, cb: (params: { params: number[] }) => boolean) {
        if (id.final === 'J') csiJHandler = cb
        return { dispose() {} }
      }
    },
    _core: {
      _renderService: renderService,
      _bufferService: bufferService,
      viewport
    }
  } as unknown as Terminal

  return {
    term,
    buffer,
    bufferService,
    renderService,
    viewport,
    viewportElement,
    getCsiJHandler: () => csiJHandler,
    getResizeCalls: () => resizeCalls,
    getSyncImmediateCalls: () => syncImmediateCalls,
    getWheelCalls: () => wheelCalls
  }
}

describe('patchViewportScrollSync', () => {
  it('flags _ignoreNextScrollEvent when shrinking scrollArea clamps scrollTop to 0 during CSI 3 J', () => {
    const { term, buffer, viewport } = createFakeTerm()
    expect(patchViewportScrollSync(term)).toBe(true)

    // Simulate CSI 3 J (clear scrollback): buffer shrinks to 50 rows and ybase/ydisp become 0.
    buffer.lines.length = 50
    buffer.ybase = 0
    buffer.ydisp = 0

    // Without the patch, shrinking scrollArea.style.height clamps viewportElement.scrollTop from
    // 2400 -> 0 on read, so `viewportElement.scrollTop !== 0` is false and _ignoreNextScrollEvent
    // stays false (causing the queued DOM 'scroll' event to yank ydisp to 0 and lock isUserScrolling).
    viewport._innerRefresh()
    expect(viewport._ignoreNextScrollEvent).toBe(true)
    expect(viewport._lastScrollTop).toBe(0)
  })

  it('clears _ignoreNextScrollEvent when a programmatic scrollTop assignment is clamped with no movement', () => {
    const { term, buffer, viewport, viewportElement } = createFakeTerm()
    patchViewportScrollSync(term)

    // Scroll area is only 1 page (50 rows = 800px), so maxScrollTop is 0, and scrollTop is 0.
    buffer.lines.length = 50
    buffer.ybase = 0
    buffer.ydisp = 0
    viewport._innerRefresh()
    // Consume the initial clamp's ignore flag
    viewport._ignoreNextScrollEvent = false
    expect(viewportElement.scrollTop).toBe(0)

    // Suppose ydisp is transiently > 0 while scrollArea cannot scroll past 0: xterm sets
    // _ignoreNextScrollEvent = true and assigns scrollTop, which clamps back to 0 (no DOM scroll event).
    buffer.ydisp = 10
    // Force scrollArea height to remain 800px by keeping lines.length = 50
    viewport._innerRefresh()
    expect(viewportElement.scrollTop).toBe(0)
    expect(viewport._ignoreNextScrollEvent).toBe(false)
  })

  it('resets BufferService.isUserScrolling on CSI 3 J (Erase Saved Lines) but not CSI 2 J', () => {
    const { term, bufferService, getCsiJHandler } = createFakeTerm()
    patchViewportScrollSync(term)
    const handler = getCsiJHandler()
    expect(handler).not.toBeNull()

    // Public `term.parser.registerCsiHandler` passes `(number | number[])[]` via `IParams.toArray()`
    bufferService.isUserScrolling = true
    expect(handler!([2] as unknown as { params: number[] })).toBe(false)
    expect(bufferService.isUserScrolling).toBe(true)

    expect(handler!([3] as unknown as { params: number[] })).toBe(false)
    expect(bufferService.isUserScrolling).toBe(false)

    // Also supports `_core.registerCsiHandler` style `{ params: number[] }`
    bufferService.isUserScrolling = true
    expect(handler!({ params: [3] })).toBe(false)
    expect(bufferService.isUserScrolling).toBe(false)
  })

  it('parses CSI 2 J and CSI 3 J on a real @xterm/xterm Terminal without throwing in WriteBuffer', async () => {
    const { Terminal: RealTerminal } = await import('@xterm/xterm')
    const realTerm = new RealTerminal({ rows: 10, cols: 40, scrollback: 100 })
    const core = (realTerm as unknown as { _core: Record<string, unknown> })._core
    // Attach a minimal viewport & renderService stub to headless Terminal so patchViewportScrollSync installs
    core._renderService = {
      dimensions: makeDims(16, 160),
      setRenderer() {},
      handleResize() {},
      refreshRows() {}
    }
    core.viewport = {
      _innerRefresh() {},
      syncScrollArea() {}
    }
    expect(patchViewportScrollSync(realTerm)).toBe(true)

    const bufSvc = core._bufferService as { isUserScrolling: boolean; buffer: { ybase: number; ydisp: number } }
    await new Promise<void>((resolve) => {
      realTerm.write(
        Array.from({ length: 25 }, (_, i) => `line-${i}`).join('\r\n'),
        () => resolve()
      )
    })
    bufSvc.isUserScrolling = true
    bufSvc.buffer.ydisp = 0

    // Emit the exact Antigravity CLI inline redraw burst: \x1b[2J\x1b[3J\x1b[H followed by 25 lines
    await new Promise<void>((resolve) => {
      realTerm.write(
        '\x1b[2J\x1b[3J\x1b[H' + Array.from({ length: 25 }, (_, i) => `rewritten-${i}`).join('\r\n'),
        () => resolve()
      )
    })

    expect(bufSvc.isUserScrolling).toBe(false)
    expect(bufSvc.buffer.ybase).toBeGreaterThan(0)
    expect(bufSvc.buffer.ydisp).toBe(bufSvc.buffer.ybase)
    realTerm.dispose()
  })

  it('updates Viewport._renderDimensions and syncs scroll area across setRenderer swaps', () => {
    const { term, renderService, viewport, getResizeCalls, getSyncImmediateCalls } = createFakeTerm()
    patchViewportScrollSync(term)

    // Simulate WebglAddon dispose / fresh DomRenderer whose dimensions start at 0 before handleResize
    const zeroDims = makeDims(0, 0)
    renderService.setRenderer({ dimensions: zeroDims })

    expect(getResizeCalls()).toBe(1)
    expect(viewport._renderDimensions).toBe(renderService.dimensions)
    expect(viewport._renderDimensions.device.cell.height).toBe(16)
    expect(getSyncImmediateCalls()).toBeGreaterThanOrEqual(1)
  })

  it('synchronizes stale scrollArea before handling wheel events', () => {
    const { term, buffer, viewport, viewportElement, getSyncImmediateCalls } = createFakeTerm()
    patchViewportScrollSync(term)

    // Simulate 3 pages of output written after a scrollback clear before rAF ran _innerRefresh
    buffer.lines.length = 50
    buffer.ybase = 0
    buffer.ydisp = 0
    viewport._innerRefresh()

    buffer.lines.length = 200
    buffer.ybase = 150
    buffer.ydisp = 150
    // Notice viewport._lastRecordedBufferLength is still 50 and scrollArea is still 800px!
    const beforeSyncs = getSyncImmediateCalls()

    viewport.handleWheel({ deltaY: -48 } as WheelEvent)
    expect(getSyncImmediateCalls()).toBe(beforeSyncs + 1)
    expect(viewportElement.scrollTop).toBe(150 * 16 - 48)
  })

  it('is idempotent and fails open when xterm internals are missing', () => {
    const { term } = createFakeTerm()
    expect(patchViewportScrollSync(term)).toBe(true)
    expect(patchViewportScrollSync(term)).toBe(true)
    expect(patchViewportScrollSync({} as Terminal)).toBe(false)
  })
})
