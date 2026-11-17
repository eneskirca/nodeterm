import { describe, expect, it } from 'vitest'
import {
  createBoardPauseSlot,
  installBoardRenderPause,
  renderPaused,
  type IntersectionVerdict,
  type PausableTerminal
} from './board-render-pause'

/**
 * A structural fake of xterm 5.5's RenderService pause machinery — the same three fields and the
 * same `_handleIntersectionChange` body as `node_modules/@xterm/xterm/src/browser/services/
 * RenderService.ts`, with the method on the PROTOTYPE (as in the real class) and the observer
 * reaching it through `this.`, which is what makes an instance property shadow it.
 */
class FakeRenderService {
  _isPaused = false
  _needsFullRefresh = false
  /** Rows actually handed to the renderer — the work the board pause exists to stop. */
  painted = 0
  /** Full refreshes the resume path flushed. */
  resumes = 0
  _handleIntersectionChange(entry: IntersectionVerdict): void {
    this._isPaused = entry.isIntersecting === undefined ? entry.intersectionRatio === 0 : !entry.isIntersecting
    if (!this._isPaused && this._needsFullRefresh) {
      this.resumes++
      this.refreshRows()
      this._needsFullRefresh = false
    }
  }
  refreshRows(): void {
    if (this._isPaused) {
      this._needsFullRefresh = true
      return
    }
    this.painted++
  }
  /** The geometric IntersectionObserver delivering an entry. */
  observe(intersecting: boolean): void {
    this._handleIntersectionChange({ isIntersecting: intersecting, intersectionRatio: intersecting ? 1 : 0 })
  }
}

function fake(): { term: PausableTerminal; rs: FakeRenderService } {
  const rs = new FakeRenderService()
  return { term: { _core: { _renderService: rs as never } }, rs }
}

/**
 * The three xterm 5.5 paths that run beside the render service and ignore its pause, as structural
 * fakes with the methods on the PROTOTYPE (as in the real classes) and callers reaching them through
 * the instance, so an instance property shadows them:
 *  - `CoreBrowserTerminal._syncTextArea` — every cursor move (`onCursorMove`);
 *  - `Viewport.syncScrollArea` — every scroll (`_onScroll`), reading and writing layout;
 *  - `RenderService.handleSelectionChanged` — every scroll (`SelectionService.refresh`), which the
 *    DOM renderer answers with a FULL `renderRows`, paused or not.
 */
class FakeSelectingRenderService extends FakeRenderService {
  selections: Array<[unknown, unknown, unknown]> = []
  handleSelectionChanged(start: unknown, end: unknown, columnSelectMode: unknown): void {
    this.selections.push([start, end, columnSelectMode])
  }
}
class FakeViewport {
  syncs: Array<boolean | undefined> = []
  syncScrollArea(immediate?: boolean): void {
    this.syncs.push(immediate)
  }
}
class FakeCore {
  textareaSyncs = 0
  constructor(public _renderService: FakeSelectingRenderService, public viewport: FakeViewport) {}
  _syncTextArea(): void {
    this.textareaSyncs++
  }
  /** What xterm does on a streamed line: cursor move, scroll, selection refresh. */
  streamLine(): void {
    this._syncTextArea()
    this.viewport.syncScrollArea()
    this._renderService.handleSelectionChanged(undefined, undefined, false)
  }
}
function fakeCore(): { term: PausableTerminal; core: FakeCore; rs: FakeSelectingRenderService; vp: FakeViewport } {
  const rs = new FakeSelectingRenderService()
  const vp = new FakeViewport()
  const core = new FakeCore(rs, vp)
  return { term: { _core: core as never }, core, rs, vp }
}

describe('renderPaused', () => {
  it('pauses when covered, when off screen, and when both', () => {
    expect(renderPaused(false, true)).toBe(false)
    expect(renderPaused(true, true)).toBe(true)
    expect(renderPaused(false, false)).toBe(true)
    expect(renderPaused(true, false)).toBe(true)
  })
})

describe('installBoardRenderPause', () => {
  it('stops painting while covered and keeps the refresh owed (nothing is lost)', () => {
    const { term, rs } = fake()
    let covered = false
    const pause = installBoardRenderPause(term, { covered: () => covered })!
    rs.refreshRows()
    expect(rs.painted).toBe(1)
    covered = true
    pause.sync()
    expect(rs._isPaused).toBe(true)
    // Streaming output while the board is up: every refresh is deferred, none painted.
    for (let i = 0; i < 50; i++) rs.refreshRows()
    expect(rs.painted).toBe(1)
    expect(rs._needsFullRefresh).toBe(true)
  })

  it('resumes through xterm’s own flush on uncover — one full refresh — and asks for the guaranteed repaint', () => {
    const { term, rs } = fake()
    let covered = true
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    rs.refreshRows()
    rs.refreshRows()
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(false)
    expect(rs.resumes).toBe(1)
    expect(rs.painted).toBe(1)
    expect(repaints).toBe(1)
  })

  it('pauses at install when mounted under a board that is already up', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => true })
    expect(rs._isPaused).toBe(true)
  })

  it('an observer delivery while covered cannot unpause (a node mounting under the board)', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => true })
    rs.observe(true) // xterm's initial "intersecting" entry
    expect(rs._isPaused).toBe(true)
  })

  it('uncovering a terminal that went off screen meanwhile stays paused, with no repaint', () => {
    const { term, rs } = fake()
    let covered = true
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    rs.observe(false)
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(true)
    expect(repaints).toBe(0)
    rs.observe(true) // panned back into view: xterm's own resume, untouched
    expect(rs._isPaused).toBe(false)
  })

  it('a terminal re-adopted off screen (already paused, no new observer delivery) stays paused through a cover/uncover', () => {
    // Park re-adopt: the detached element's observer reported not-intersecting BEFORE install,
    // and reattached still off screen it has nothing new to deliver during the wrapper's life.
    const { term, rs } = fake()
    rs.observe(false)
    let covered = false
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    covered = true
    pause.sync()
    covered = false
    pause.sync()
    expect(rs._isPaused).toBe(true)
    expect(repaints).toBe(0)
    for (let i = 0; i < 10; i++) rs.refreshRows()
    expect(rs.painted).toBe(0) // streaming output off screen: nothing drawn
    pause.dispose()
    expect(rs._isPaused).toBe(true) // dispose hands back the real (off-screen) geometry
    rs.observe(true) // panned into view: xterm's own resume
    expect(rs._isPaused).toBe(false)
    expect(rs.resumes).toBe(1)
  })

  it('leaves xterm’s geometric pause alone when nothing covers it', () => {
    const { term, rs } = fake()
    installBoardRenderPause(term, { covered: () => false })
    rs.observe(false)
    expect(rs._isPaused).toBe(true)
    rs.observe(true)
    expect(rs._isPaused).toBe(false)
  })

  it('sync is change-gated: no repeated replay or repaint for an unmoved board', () => {
    const { term, rs } = fake()
    let covered = false
    let repaints = 0
    const pause = installBoardRenderPause(term, { covered: () => covered, onUncover: () => repaints++ })!
    pause.sync()
    pause.sync()
    expect(repaints).toBe(0)
    covered = true
    pause.sync()
    covered = false
    pause.sync()
    pause.sync()
    expect(repaints).toBe(1)
    expect(rs._isPaused).toBe(false)
  })

  it('dispose restores the prototype method and hands back the real geometry', () => {
    const { term, rs } = fake()
    const pause = installBoardRenderPause(term, { covered: () => true })!
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(true)
    pause.dispose()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
    expect(rs._isPaused).toBe(false)
    pause.dispose() // idempotent
    pause.sync() // inert
    expect(rs._isPaused).toBe(false)
  })

  it('a second install (park re-adopt) replaces the first instead of stacking a wrapper', () => {
    const { term, rs } = fake()
    let firstReads = 0
    installBoardRenderPause(term, { covered: () => (firstReads++, true) })
    const second = installBoardRenderPause(term, { covered: () => false })!
    firstReads = 0
    rs.observe(true)
    expect(firstReads).toBe(0) // the stale controller's predicate is no longer in the chain
    expect(rs._isPaused).toBe(false)
    second.dispose()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
  })

  it('returns null and changes nothing when the private method is missing', () => {
    expect(installBoardRenderPause({}, { covered: () => true })).toBeNull()
    expect(installBoardRenderPause({ _core: { _renderService: {} } }, { covered: () => true })).toBeNull()
  })
})

describe('installBoardRenderPause — the paths beside the render service', () => {
  it('holds the textarea sync, the scroll-area sync and the selection redraw while covered', () => {
    const { term, core, rs, vp } = fakeCore()
    installBoardRenderPause(term, { covered: () => true })
    for (let i = 0; i < 50; i++) core.streamLine()
    expect(core.textareaSyncs).toBe(0)
    expect(vp.syncs).toEqual([])
    expect(rs.selections).toEqual([])
  })

  it('replays each held path ONCE on uncover — the scroll area immediately, the selection with its latest range', () => {
    const { term, core, rs, vp } = fakeCore()
    let covered = true
    const pause = installBoardRenderPause(term, { covered: () => covered })!
    for (let i = 0; i < 20; i++) core.streamLine()
    rs.handleSelectionChanged([0, 3], [10, 3], true)
    covered = false
    pause.sync()
    expect(core.textareaSyncs).toBe(1)
    expect(vp.syncs).toEqual([true])
    expect(rs.selections).toEqual([[[0, 3], [10, 3], true]])
  })

  it('replays nothing a covered period did not owe', () => {
    const { term, core, rs, vp } = fakeCore()
    let covered = true
    const pause = installBoardRenderPause(term, { covered: () => covered })!
    covered = false
    pause.sync()
    expect(core.textareaSyncs).toBe(0)
    expect(vp.syncs).toEqual([])
    expect(rs.selections).toEqual([])
  })

  it('passes every path straight through while nothing covers it, off screen included (xterm’s own behaviour)', () => {
    const { term, core, rs, vp } = fakeCore()
    installBoardRenderPause(term, { covered: () => false })
    core.streamLine()
    rs.observe(false)
    core.streamLine()
    expect(core.textareaSyncs).toBe(2)
    expect(vp.syncs).toEqual([undefined, undefined])
    expect(rs.selections).toHaveLength(2)
  })

  it('an observer delivery that finds the board gone flushes what was held', () => {
    const { term, core, vp } = fakeCore()
    let covered = true
    installBoardRenderPause(term, { covered: () => covered })
    core.streamLine()
    covered = false
    core._renderService.observe(true)
    expect(core.textareaSyncs).toBe(1)
    expect(vp.syncs).toEqual([true])
  })

  it('dispose restores the prototype methods; a covered dispose replays what it owed, deferred', () => {
    const { term, core, rs, vp } = fakeCore()
    const pause = installBoardRenderPause(term, { covered: () => true })!
    core.streamLine()
    expect(core.textareaSyncs).toBe(0)
    expect(vp.syncs).toEqual([])
    pause.dispose()
    expect(Object.prototype.hasOwnProperty.call(core, '_syncTextArea')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(vp, 'syncScrollArea')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(rs, 'handleSelectionChanged')).toBe(false)
    expect(core.textareaSyncs).toBe(1)
    // A park disposes into a DETACHED element: the scroll area is synced on the next frame rather
    // than forcing a layout of a node that is not in the document.
    expect(vp.syncs).toEqual([undefined])
    expect(rs.selections).toHaveLength(1)
    core.streamLine()
    expect(core.textareaSyncs).toBe(2)
  })

  it('a second install (park re-adopt) does not stack holds', () => {
    const { term, core } = fakeCore()
    installBoardRenderPause(term, { covered: () => true })
    const second = installBoardRenderPause(term, { covered: () => false })!
    core.streamLine()
    // A stacked hold from the first (covered) install would still swallow this.
    expect(core.textareaSyncs).toBe(1)
    second.dispose()
    expect(Object.prototype.hasOwnProperty.call(core, '_syncTextArea')).toBe(false)
  })

  it('a replay that throws never escapes sync or dispose (they run in React effect cleanups)', () => {
    const { term, core, vp } = fakeCore()
    vp.syncScrollArea = () => {
      throw new Error('viewport already disposed')
    }
    let covered = true
    const pause = installBoardRenderPause(term, { covered: () => covered })!
    core.streamLine()
    covered = false
    expect(() => pause.sync()).not.toThrow()
    expect(core.textareaSyncs).toBe(1) // one failed replay does not cost the others
    covered = true
    pause.sync()
    core.streamLine()
    expect(() => pause.dispose()).not.toThrow()
  })

  it('a core without the three methods still gets the render pause', () => {
    const { term, rs } = fake()
    const pause = installBoardRenderPause(term, { covered: () => true })
    expect(pause).not.toBeNull()
    expect(rs._isPaused).toBe(true)
  })
})

/**
 * The node's wiring, run with a fake terminal: TerminalNode's lifecycle run ATTACHES (and its
 * cleanup releases), and the board-flag and focus-mode effects only SYNC the slot. A slot that
 * never held the run's controller is the bug this pins: a node mounted while the board is up
 * pauses at install, and the board closing must still reach it.
 */
describe('createBoardPauseSlot (TerminalNode wiring)', () => {
  it('a node mounted under the board resumes and repaints when the board closes', () => {
    const { term, rs } = fake()
    const slot = createBoardPauseSlot()
    let board = true
    let repaints = 0
    const release = slot.attach(term, { covered: () => board, onUncover: () => repaints++ })
    expect(rs._isPaused).toBe(true)
    rs.refreshRows()
    expect(rs.painted).toBe(0)

    board = false
    slot.sync() // what the [boardOpen] effect does after writing the ref
    expect(rs._isPaused).toBe(false)
    expect(rs.painted).toBe(1) // the refresh owed while covered was flushed
    expect(repaints).toBe(1)
    release()
  })

  it('release hands xterm its own handler back and leaves nothing for a later sync', () => {
    const { term, rs } = fake()
    const slot = createBoardPauseSlot()
    let board = true
    const release = slot.attach(term, { covered: () => board })
    release()
    expect(Object.prototype.hasOwnProperty.call(rs, '_handleIntersectionChange')).toBe(false)
    expect(rs._isPaused).toBe(false) // a covered pause is handed back, not left stuck
    board = true
    slot.sync()
    rs.observe(true)
    expect(rs._isPaused).toBe(false)
  })

  it('a stale run\'s release never detaches the controller a newer run attached', () => {
    const a = fake()
    const b = fake()
    const slot = createBoardPauseSlot()
    let board = false
    const releaseOld = slot.attach(a.term, { covered: () => board })
    slot.attach(b.term, { covered: () => board })
    releaseOld()
    board = true
    slot.sync()
    expect(b.rs._isPaused).toBe(true)
  })

  it('an xterm without the private method attaches nothing and release is still safe', () => {
    const slot = createBoardPauseSlot()
    const release = slot.attach({ _core: {} }, { covered: () => true })
    expect(() => {
      slot.sync()
      release()
    }).not.toThrow()
  })
})
