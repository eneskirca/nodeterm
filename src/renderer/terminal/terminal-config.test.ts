import { describe, it, expect, beforeEach } from 'vitest'
import {
  attachReplay,
  closedByLabel,
  copyKeyAction,
  createDataGate,
  cursorPlacementSeq,
  disposalAction,
  forgetNodeTermState,
  isCopyShortcut,
  isPasteShortcut,
  isLetterboxed,
  letterboxFor,
  markRecycled,
  recycleAction,
  repaintResync,
  reportedSize,
  seedPaint,
  setFittedSize,
  shouldApplyResync,
  stripTrailingNewline,
  takeRecycled,
  terminalKey,
  terminalKeyAction,
  toXtermText,
  xtermScrollback,
  applyLiveOptions,
  mergeProjectVisuals,
  terminalLetterSpacing,
  terminalLineHeight,
  xtermOptionsFromSettings,
  RESYNC_NOTICE,
  SHIFT_ENTER_SEQ,
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  XTERM_SCROLLBACK_MAX,
  XTERM_SCROLLBACK_MIN,
  type CopyShortcutEvent,
  type LiveOptionTarget,
  type XtermVisualSettings
} from './terminal-config'
import { resolveTerminalTheme } from './themes'
import type { ClientId } from '@shared/presence'

const ev = (p: Partial<CopyShortcutEvent>): CopyShortcutEvent => ({
  type: 'keydown',
  key: 'c',
  code: 'KeyC',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...p
})

describe('IME shortcut ownership', () => {
  it('passes composition Enter through instead of submitting a newline shortcut', () => {
    const enter = ev({ key: 'Enter', code: 'Enter', shiftKey: true })
    expect(terminalKeyAction({ ...enter, isComposing: true }, false, false)).toBe('pass')
    expect(terminalKeyAction({ ...enter, keyCode: 229 }, false, false)).toBe('pass')
    expect(terminalKeyAction(enter, false, false)).not.toBe('pass')
  })
})

describe('terminalKey (session-scope the node-keyed renderer-global maps)', () => {
  it('same session + node → the same key (stable across a park→remount)', () => {
    expect(terminalKey('local', 'abc')).toBe(terminalKey('local', 'abc'))
    expect(terminalKey('relay-1', 'abc')).toBe(terminalKey('relay-1', 'abc'))
  })

  it('distinct sessions with the SAME node id → distinct keys (no local↔relay collision)', () => {
    // The core bug: a relay tab adopts the host's project KEEPING node ids, so a local node and a
    // relay node can share a bare id. Scoping by session id must keep them apart.
    expect(terminalKey('local', 'abc')).not.toBe(terminalKey('relay-1', 'abc'))
  })

  it('distinct node ids in the same session → distinct keys', () => {
    expect(terminalKey('local', 'abc')).not.toBe(terminalKey('local', 'def'))
  })
})

describe('reportedSize', () => {
  it('reports the fit proposal, floored at 1 (a collapsed node can propose 0)', () => {
    expect(reportedSize({ cols: 132, rows: 43 })).toEqual({ cols: 132, rows: 43 })
    expect(reportedSize({ cols: 0, rows: 0 })).toEqual({ cols: 1, rows: 1 })
  })

  it('returns null when the fit cannot be measured (hidden / zero-size node)', () => {
    expect(reportedSize(undefined)).toBeNull()
    expect(reportedSize(null)).toBeNull()
    expect(reportedSize({ cols: NaN, rows: 24 })).toBeNull()
    expect(reportedSize({ cols: 80, rows: Infinity })).toBeNull()
    expect(reportedSize({ cols: 80 })).toBeNull()
  })
})

describe('isLetterboxed', () => {
  it('is false for a solo user: the effective size IS their own fit', () => {
    expect(isLetterboxed({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false)
  })

  it('is true when the pty runs at a smaller subscriber s grid', () => {
    expect(isLetterboxed({ cols: 80, rows: 30 }, { cols: 100, rows: 30 })).toBe(true)
    expect(isLetterboxed({ cols: 100, rows: 24 }, { cols: 100, rows: 30 })).toBe(true)
  })

  it('is false while our own fit is unknown (nothing to letterbox against)', () => {
    expect(isLetterboxed({ cols: 80, rows: 24 }, null)).toBe(false)
  })
})

describe('shouldApplyResync', () => {
  it('paints a non-empty capture', () => {
    expect(shouldApplyResync('$ ls\nfoo\n')).toBe(true)
  })

  it('IGNORES an empty/absent payload — a wrongly reset screen is unrecoverable', () => {
    expect(shouldApplyResync('')).toBe(false)
    expect(shouldApplyResync(null)).toBe(false)
    expect(shouldApplyResync(undefined)).toBe(false)
  })
})

describe('attachReplay', () => {
  it('replays the persisted snapshot on a cold start (tmux session gone)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: false })).toBe('cold-snapshot')
  })

  it('seeds nothing on a warm reattach — tmux redraws the pane and owns its history', () => {
    expect(attachReplay({ parked: false, fresh: false, hasInitialCommand: false })).toBe('warm-attach')
  })

  it('seeds nothing on a brand-new node (fresh session + launch command)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: true })).toBe('none')
  })

  it('seeds nothing for a parked terminal — its buffer is already correct', () => {
    // Both fresh values: an adopted xterm must never be seeded, or the content would double.
    expect(attachReplay({ parked: true, fresh: false, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: true })).toBe('none')
  })
})

describe('toXtermText', () => {
  it('turns tmux capture LFs into CRLFs, leaving existing CRLFs alone', () => {
    expect(toXtermText('a\nb')).toBe('a\r\nb')
    expect(toXtermText('a\r\nb')).toBe('a\r\nb')
  })

  it('turns tmux capture-pane LFs into CRLFs (xterm runs with convertEol off)', () => {
    expect(toXtermText('one\ntwo\n')).toBe('one\r\ntwo\r\n')
  })

  it('leaves existing CRLFs alone', () => {
    expect(toXtermText('one\r\ntwo')).toBe('one\r\ntwo')
  })

  it('keeps escape sequences untouched', () => {
    expect(toXtermText('\x1b[31mred\x1b[0m\n')).toBe('\x1b[31mred\x1b[0m\r\n')
  })
})

describe('closedByLabel', () => {
  const peers = { 7: { name: 'Ada' } } as Record<ClientId, { name: string }>

  it('names the peer who destroyed the node', () => {
    expect(closedByLabel(7 as ClientId, peers)).toBe('Ada')
  })

  it('degrades to a neutral label for an unattributed destroy or an unknown/departed peer', () => {
    expect(closedByLabel(null, peers)).toBe('another user')
    expect(closedByLabel(99 as ClientId, peers)).toBe('another user')
  })
})

// The fitted size is read by the pty:size listener, which is wired ONCE and SURVIVES a park
// (the terminal is adopted by a later mount with its listeners intact). It therefore may not
// live in the mounting effect's closure: after a park/adopt, the listener would keep measuring
// the letterbox against the PRE-PARK grid — so a co-viewer who parks, changes the font size and
// comes back gets a letterbox he shouldn't have (or loses one he should).
describe('fitted-size registry (survives a park, like the listeners that read it)', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('measures the letterbox against the fit of the CURRENTLY mounted terminal', () => {
    // Mount A fits 120×40 and wires the pty:size listener.
    setFittedSize('n1', { cols: 120, rows: 40 })
    const onSize = (size: { cols: number; rows: number }): boolean => letterboxFor('n1', size)
    expect(onSize({ cols: 80, rows: 24 })).toBe(true) // a smaller co-viewer clamps us → letterbox

    // Park + adopt: the SAME listener lives on, but the user bumped the font size, so mount B
    // fits a smaller grid — which is now exactly the pty's size. No letterbox.
    setFittedSize('n1', { cols: 80, rows: 24 })
    expect(onSize({ cols: 80, rows: 24 })).toBe(false)
  })

  it('reports no letterbox for a node that has never reported a fit', () => {
    expect(letterboxFor('never-fitted', { cols: 80, rows: 24 })).toBe(false)
  })

  it('forgets a node on permanent deletion (a recycled node id must not inherit a stale fit)', () => {
    setFittedSize('n1', { cols: 200, rows: 60 })
    forgetNodeTermState('n1')
    expect(letterboxFor('n1', { cols: 80, rows: 24 })).toBe(false)
  })
})

// The "session restarted by another user" banner is armed when the recycle notice lands and must
// be CONSUMED by the spawn it belongs to — even when that spawn is abandoned (the node unmounted
// while create() was in flight). A flag left behind would print the banner on some unrelated
// mount hours later.
describe('recycle banner flag', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('is consumed exactly once', () => {
    markRecycled('n1')
    expect(takeRecycled('n1')).toBe(true)
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is false for a node that was never recycled', () => {
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is dropped with the node (no stale banner on a much later mount)', () => {
    markRecycled('n1')
    forgetNodeTermState('n1')
    expect(takeRecycled('n1')).toBe(false)
  })
})

// The recycle notice carries whether a REPLACEMENT session is already live. Without one (the
// recycler crashed between the kill and the create), restarting would spawn `nt-<id>` from this
// client's own — stale — cwd, silently undoing the worktree move for everybody. So: only restart
// when there is something to restart onto.
describe('recycleAction', () => {
  it('restarts onto the replacement session when it is live', () => {
    expect(recycleAction({ ready: true })).toBe('restart')
  })

  it('ends the terminal (reopen to restart) when no replacement was ever registered', () => {
    expect(recycleAction({ ready: false })).toBe('ended')
  })

  it('treats a payload-less/legacy notice as "no replacement" (never spawn in a stale cwd)', () => {
    expect(recycleAction(undefined)).toBe('ended')
  })
})

describe('stripTrailingNewline', () => {
  it('drops exactly one trailing LF (tmux capture-pane ends with one)', () => {
    expect(stripTrailingNewline('one\ntwo\n')).toBe('one\ntwo')
  })

  it('drops a trailing CRLF as a unit', () => {
    expect(stripTrailingNewline('one\r\n')).toBe('one')
  })

  it('keeps blank lines that precede the final one (only ONE newline goes)', () => {
    expect(stripTrailingNewline('one\n\n\n')).toBe('one\n\n')
  })

  it('leaves text without a trailing newline alone', () => {
    expect(stripTrailingNewline('one\ntwo')).toBe('one\ntwo')
    expect(stripTrailingNewline('')).toBe('')
  })

  it('composes with toXtermText so the seed leaves the cursor on the LAST captured row', () => {
    // Writing the trailing newline would push the cursor one row down: xterm scrolls, the top row
    // of the captured visible screen lands in scrollback, and tmux's redraw repaints it again —
    // one duplicated line at the seam on every warm reattach.
    expect(toXtermText(stripTrailingNewline('one\ntwo\n'))).toBe('one\r\ntwo')
  })
})

/**
 * …and the row the seed leaves the cursor on is the LAST CAPTURED one, not the one the pane has it
 * on. That was the 2026-08-05 report: refresh a terminal running an agent CLI and the block cursor
 * sits at the end of the status line instead of in the input prompt, until the first keystroke
 * makes the app repaint. `capture-pane` carries text and nothing else, so the position has to be
 * asked of tmux separately and written after the paint.
 */
describe('cursorPlacementSeq', () => {
  it('moves the cursor to the pane position, converting 0-based to CUP 1-based', () => {
    // tmux says column 6, row 1 (0-based). CUP is `ESC [ row ; col H`, 1-based, ROW FIRST — getting
    // that order backwards is the classic way to land the cursor on a transposed cell.
    expect(cursorPlacementSeq({ x: 6, y: 1, visible: true })).toBe('\x1b[2;7H\x1b[?25h')
    expect(cursorPlacementSeq({ x: 0, y: 0, visible: true })).toBe('\x1b[1;1H\x1b[?25h')
  })

  it('carries the visibility the capture also drops', () => {
    // A full-screen TUI that hid its cursor would otherwise have one painted back over it — the
    // same class of gap as the mouse modes (`CO_ATTACH_MOUSE_SEQ`).
    expect(cursorPlacementSeq({ x: 3, y: 4, visible: false })).toBe('\x1b[5;4H\x1b[?25l')
  })

  it('writes NOTHING when tmux could not be asked', () => {
    // The pre-fix behaviour: leave the cursor where the paint left it. A poor place, but a known
    // one — better than a guessed coordinate the pane never had.
    expect(cursorPlacementSeq(undefined)).toBe('')
  })
})

describe('disposalAction', () => {
  it('proceeds while the node is still mounted', () => {
    expect(disposalAction({ disposed: false, handedOff: null })).toBe('proceed')
  })

  it('continues the setup when the cleanup PARKED this session', () => {
    // Project switch during the hydration await: the park entry holds the same xterm, PTY client
    // and cleanups array, so the session is alive and must be finished wiring — killing it here
    // would leave a permanently dead node when the user switches back.
    expect(disposalAction({ disposed: true, handedOff: { dead: false } })).toBe('continue-parked')
  })

  it('continues the setup when the parked session was already ADOPTED by a remount', () => {
    // Park-then-adopt inside one hydration await: the remount takes the entry out of the parked
    // map and deliberately re-wires nothing — it relies on THIS continuation to open the gate and
    // attach onExit/onData. The handed-off entry is still alive (not dead), so: continue.
    const handedOff = { dead: false } // adoption does not kill; it only removes the map entry
    expect(disposalAction({ disposed: true, handedOff })).toBe('continue-parked')
  })

  it('tears down on a real unmount/delete (the cleanup handed nothing off)', () => {
    expect(disposalAction({ disposed: true, handedOff: null })).toBe('teardown')
    expect(disposalAction({ disposed: true, handedOff: undefined })).toBe('teardown')
  })

  it('tears down when the handed-off session was disposed for good (park expiry / delete)', () => {
    expect(disposalAction({ disposed: true, handedOff: { dead: true } })).toBe('teardown')
  })
})

describe('createDataGate', () => {
  it('queues chunks that arrive before the gate opens, then drains them in order', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('a')
    gate.push('b')
    expect(written).toEqual([]) // nothing reaches the emulator while the hydration is in flight
    gate.open()
    expect(written).toEqual(['a', 'b'])
  })

  it('writes straight through once open', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.open()
    gate.push('a')
    gate.push('b')
    expect(written).toEqual(['a', 'b'])
  })

  it('is idempotent on open (a second open cannot replay the queue)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('a')
    gate.open()
    gate.open()
    expect(written).toEqual(['a'])
  })

  it('keeps ordering when a chunk arrives during the drain', () => {
    const written: string[] = []
    const gate: ReturnType<typeof createDataGate> = createDataGate((c) => {
      written.push(c)
      if (c === 'a') gate.push('b') // re-entrant push while draining
    })
    gate.push('a')
    gate.open()
    expect(written).toEqual(['a', 'b'])
  })

  // A `pty:resync` repaints the CURRENT screen from tmux. Anything the gate is still holding
  // predates that capture, so draining it would splice the stale flood back over the fresh screen —
  // the terminal would end up showing output the redraw exists to skip.
  it('DISCARDS the queue on reset (a resync supersedes everything that predates it)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('stale-1')
    gate.push('stale-2')
    expect(gate.reset()).toBe('stale-1'.length + 'stale-2'.length) // bytes owed back to flow control
    gate.open() // the seed's `finally` still runs — it must not resurrect the dropped chunks
    expect(written).toEqual([])
  })

  it('passes through after a reset (post-capture output must keep streaming)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('stale')
    gate.reset()
    gate.push('fresh')
    expect(written).toEqual(['fresh'])
  })

  it('reports nothing dropped when the gate is already open', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.open()
    gate.push('a')
    expect(gate.reset()).toBe(0)
    expect(written).toEqual(['a'])
  })
})

describe('xtermScrollback', () => {
  it('follows the tmux scrollback setting below the cap', () => {
    expect(xtermScrollback(2000)).toBe(2000)
  })

  it('caps the default 50000-line tmux scrollback', () => {
    expect(xtermScrollback(50000)).toBe(XTERM_SCROLLBACK_MAX)
    expect(XTERM_SCROLLBACK_MAX).toBe(10000)
  })

  it('floors a tiny setting the same way the tmux conf does (history-limit max(1000, n))', () => {
    // tmux would still keep 1000 lines of history — an xterm buffer smaller than that would make
    // them unreachable, since xterm is the buffer the user scrolls.
    expect(XTERM_SCROLLBACK_MIN).toBe(1000)
    expect(xtermScrollback(100)).toBe(XTERM_SCROLLBACK_MIN)
    expect(xtermScrollback(0)).toBe(XTERM_SCROLLBACK_MIN)
  })
})

describe('isCopyShortcut', () => {
  it('copies on Cmd+C', () => {
    expect(isCopyShortcut(ev({ metaKey: true }))).toBe(true)
  })

  it('copies on Ctrl+Shift+C', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves plain Ctrl+C alone so it still sends SIGINT', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true }))).toBe(false)
  })

  it('ignores other keys, keyups and extra modifiers', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'v', code: 'KeyV' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, type: 'keyup' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, altKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('accepts an uppercase key (Shift makes Ctrl+Shift+C report "C")', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'C' }))).toBe(true)
  })

  it('copies on a non-Latin layout, where e.key is not "c" (physical KeyC)', () => {
    // Cyrillic layout: the C key reports 'с' (U+0441), Greek reports 'ψ'.
    expect(isCopyShortcut(ev({ metaKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'ψ', code: 'KeyC' }))).toBe(true)
    // Plain Ctrl on the same layout still reaches the pty as SIGINT.
    expect(isCopyShortcut(ev({ ctrlKey: true, key: 'с', code: 'KeyC' }))).toBe(false)
  })

  it('does not copy when neither the printed nor the physical key is C', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'ц', code: 'KeyW' }))).toBe(false)
  })

  it('copies on Cmd+Shift+C too (no competing binding; asserted, not accidental)', () => {
    expect(isCopyShortcut(ev({ metaKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves AltGr combos alone (ctrl+alt+shift+C must not copy)', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('copies on Ctrl+Insert (the traditional binding no browser reserves)', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, key: 'Insert', code: 'Insert' }))).toBe(true)
    // Shift+Insert is PASTE, not ours; bare Insert is a plain key.
    expect(isCopyShortcut(ev({ shiftKey: true, key: 'Insert', code: 'Insert' }))).toBe(false)
    expect(isCopyShortcut(ev({ key: 'Insert', code: 'Insert' }))).toBe(false)
    expect(
      isCopyShortcut(ev({ ctrlKey: true, altKey: true, key: 'Insert', code: 'Insert' }))
    ).toBe(false)
  })
})

describe('copyKeyAction', () => {
  it('copies a copy chord when there is a selection', () => {
    expect(copyKeyAction(ev({ metaKey: true }), true)).toBe('copy')
    expect(copyKeyAction(ev({ ctrlKey: true, shiftKey: true }), true)).toBe('copy')
  })

  it('SWALLOWS Ctrl+Shift+C with no selection — it must never reach the pty as SIGINT', () => {
    // Regression: falling through to xterm here maps ctrl+c to \x03 and kills the foreground
    // process, right after the user's selection was cleared by a click. We advertise the chord as
    // copy, so it can only ever copy or do nothing.
    expect(copyKeyAction(ev({ ctrlKey: true, shiftKey: true }), false)).toBe('swallow')
    expect(copyKeyAction(ev({ metaKey: true }), false)).toBe('swallow')
    expect(copyKeyAction(ev({ ctrlKey: true, key: 'Insert', code: 'Insert' }), false)).toBe(
      'swallow'
    )
  })

  it('passes plain Ctrl+C through to the pty (SIGINT), selection or not', () => {
    expect(copyKeyAction(ev({ ctrlKey: true }), true)).toBe('pass')
    expect(copyKeyAction(ev({ ctrlKey: true }), false)).toBe('pass')
  })
})

describe('isPasteShortcut (issue #562 — Ctrl+V did nothing on Windows)', () => {
  const v = (p: Partial<CopyShortcutEvent> = {}): CopyShortcutEvent =>
    ev({ key: 'v', code: 'KeyV', ...p })

  it('claims Ctrl+V on Windows', () => {
    expect(isPasteShortcut(v({ ctrlKey: true }), true)).toBe(true)
    // Non-Latin layout: the physical KeyV position still counts, like isCopyShortcut's KeyC.
    expect(isPasteShortcut(ev({ key: 'м', code: 'KeyV', ctrlKey: true }), true)).toBe(true)
  })

  it('claims NOTHING off Windows — there Ctrl+V is a pty control byte and paste is Cmd+V / Ctrl+Shift+V', () => {
    // vim's blockwise-visual and readline's literal-next live on this chord.
    expect(isPasteShortcut(v({ ctrlKey: true }), false)).toBe(false)
  })

  it('leaves the chords xterm already passes through alone', () => {
    // Measured in @xterm/xterm's evaluateKeyboardEvent: Ctrl+Shift+V and Shift+Insert produce
    // neither a key nor a cancel, so the platform paste already runs for them.
    expect(isPasteShortcut(v({ ctrlKey: true, shiftKey: true }), true)).toBe(false)
    expect(isPasteShortcut(ev({ key: 'Insert', code: 'Insert', shiftKey: true }), true)).toBe(false)
  })

  it('ignores keyup, plain V, AltGr (ctrl+alt) and Cmd+V', () => {
    expect(isPasteShortcut(v({ ctrlKey: true, type: 'keyup' }), true)).toBe(false)
    expect(isPasteShortcut(v(), true)).toBe(false)
    expect(isPasteShortcut(v({ ctrlKey: true, altKey: true }), true)).toBe(false)
    expect(isPasteShortcut(v({ metaKey: true }), true)).toBe(false)
  })
})

describe('terminalKeyAction', () => {
  it('maps Shift+Enter keydown to shift-enter', () => {
    expect(terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true }), false)).toBe(
      'shift-enter'
    )
    // selection state is irrelevant for shift-enter
    expect(terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true }), true)).toBe(
      'shift-enter'
    )
  })

  it('only fires on keydown, with shift alone', () => {
    // `code: 'Enter'` overrides the ev factory's default `code: 'KeyC'` — otherwise the extra
    // modifiers below would match the copy chord via the physical KeyC position, not shift-enter.
    expect(
      terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true, type: 'keyup' }), false)
    ).toBe('pass')
    expect(
      terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true, metaKey: true }), false)
    ).toBe('pass')
    expect(
      terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true, ctrlKey: true }), false)
    ).toBe('pass')
    expect(
      terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true, altKey: true }), false)
    ).toBe('pass')
    expect(terminalKeyAction(ev({ key: 'Enter', code: 'Enter' }), false)).toBe('pass') // plain Enter untouched
  })

  it('still resolves copy chords like copyKeyAction', () => {
    expect(terminalKeyAction(ev({ metaKey: true }), true)).toBe('copy') // Cmd+C w/ selection (ev defaults key:'c')
    expect(terminalKeyAction(ev({ ctrlKey: true, shiftKey: true }), false)).toBe('swallow')
  })

  // `registryOwns` (decided by the caller via `terminalChordBubbles`): the window dispatcher will
  // claim this chord, so xterm must neither process nor cancel it — 'bubble' = return false with
  // NO preventDefault. Deliberately the LAST branch: chords with a local owner keep it.
  it('bubbles a registry-owned keydown that nothing local owns', () => {
    const arrow = { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, shiftKey: true }
    expect(terminalKeyAction(ev(arrow), false, false, true)).toBe('bubble')
    // default false = byte-identical pre-feature behavior
    expect(terminalKeyAction(ev(arrow), false)).toBe('pass')
    expect(terminalKeyAction(ev(arrow), false, false, false)).toBe('pass')
  })

  it('never bubbles a chord a local owner already claims, and never on keyup', () => {
    // copy chord (selection) beats bubble
    expect(terminalKeyAction(ev({ ctrlKey: true, shiftKey: true }), true, false, true)).toBe('copy')
    // copy chord (no selection) still swallows — SIGINT must never reach the pty
    expect(terminalKeyAction(ev({ ctrlKey: true, shiftKey: true }), false, false, true)).toBe(
      'swallow'
    )
    // shift-enter keeps its remap
    expect(
      terminalKeyAction(ev({ key: 'Enter', code: 'Enter', shiftKey: true }), false, false, true)
    ).toBe('shift-enter')
    // project-jump bubbles to the dispatcher (which performs the switch) — it must
    // still beat a registry bubble's reason but reach the window as a bubble, not a swallow
    expect(terminalKeyAction(ev({ key: '1', code: 'Digit1', metaKey: true }), false, true, true)).toBe(
      'bubble'
    )
    // keyup never bubbles — the dispatcher only acts on keydown
    expect(
      terminalKeyAction(
        ev({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true, shiftKey: true, type: 'keyup' }),
        false,
        false,
        true
      )
    ).toBe('pass')
  })

  it('exports the ESC+CR sequence', () => {
    expect(SHIFT_ENTER_SEQ).toBe('\x1b\r')
  })

  // Issue #562: xterm maps Ctrl+V to \x16 AND cancels the keydown, which suppresses both
  // Chromium's paste command and the Edit menu's Ctrl+V accelerator — so nothing pasted at all.
  // 'native' = return false from the xterm handler WITHOUT preventDefault, so the platform pastes.
  it('hands Windows Ctrl+V to the platform paste', () => {
    const ctrlV = ev({ key: 'v', code: 'KeyV', ctrlKey: true })
    expect(terminalKeyAction(ctrlV, false, false, false, true)).toBe('native')
    expect(terminalKeyAction(ctrlV, true, false, false, true)).toBe('native')
  })

  it('leaves Ctrl+V as a pty control byte off Windows', () => {
    const ctrlV = ev({ key: 'v', code: 'KeyV', ctrlKey: true })
    expect(terminalKeyAction(ctrlV, false, false, false, false)).toBe('pass')
    // The default reads the live platform; under vitest's node env that is not Windows, so every
    // existing call site keeps its byte-identical behavior.
    expect(terminalKeyAction(ctrlV, false)).toBe('pass')
  })

  it('never lets the paste claim shadow a copy chord or Shift+Enter', () => {
    expect(terminalKeyAction(ev({ ctrlKey: true, shiftKey: true }), true, false, false, true)).toBe(
      'copy'
    )
    expect(
      terminalKeyAction(
        ev({ key: 'Enter', code: 'Enter', shiftKey: true }),
        false,
        false,
        false,
        true
      )
    ).toBe('shift-enter')
  })

  // The jump-to-project chord: WHICH events are the chord is decided once, in lib/projectJump.ts
  // (and tested there — layout, AltGr, keyup, digit range). This module only obeys the answer.
  // It bubbles (not swallow) so the window dispatcher can perform the switch while still
  // preventing the PTY control byte — see terminal-config.ts.
  it('bubbles the jump-to-project chord so the PTY never sees the control byte', () => {
    expect(terminalKeyAction(ev({ key: '1', code: 'Digit1', ctrlKey: true }), false, true)).toBe(
      'bubble'
    )
  })

  // REGRESSION GUARD (review #2): the swallow follows the caller's resolution, so a digit that
  // addresses no open project keeps reaching the pty — Ctrl+2..Ctrl+8 are ^@ ^[ ^\ ^] ^^ ^_, and
  // vim's ^] (jump to tag) and ^^ (alternate file) are daily-use keys.
  it('passes the same chord through when the app does not own it', () => {
    expect(terminalKeyAction(ev({ key: '1', code: 'Digit1', ctrlKey: true }), false, false)).toBe(
      'pass'
    )
    expect(terminalKeyAction(ev({ key: '5', code: 'Digit5', ctrlKey: true }), false, false)).toBe(
      'pass'
    )
  })

  it('defaults to not swallowing — the pre-feature behavior, byte for byte', () => {
    expect(terminalKeyAction(ev({ key: '1', code: 'Digit1', ctrlKey: true }), false)).toBe('pass')
  })

  it('never lets the jump swallow shadow a copy chord', () => {
    // Cmd+C with a selection still copies; the digit flag only ever applies to a digit keydown.
    expect(terminalKeyAction(ev({ metaKey: true }), true, false)).toBe('copy')
  })
})

describe('seedPaint', () => {
  it('paints the snapshot on a cold restore, and nothing when there is none', () => {
    expect(seedPaint({ replay: 'cold-snapshot', superseded: false, snapshot: 'old' })).toBe(
      'snapshot'
    )
    expect(seedPaint({ replay: 'cold-snapshot', superseded: false, snapshot: '' })).toBe('none')
  })

  it('paints NOTHING on a plain warm reattach — tmux redraws the pane itself', () => {
    // Hydrating here is exactly what produced the black bands and duplicated screens: tmux is a
    // screen painter, and its repaints leaked into whatever we had seeded.
    expect(seedPaint({ replay: 'warm-attach', superseded: false })).toBe('none')
  })

  it("paints the create-result screen for a CO-ATTACH JOINER (it gets no tmux redraw)", () => {
    expect(
      seedPaint({ replay: 'warm-attach', superseded: false, screen: 'live screen' })
    ).toBe('create-screen')
    // No screen (a solo warm reattach, or a capture that came back empty): a blank-but-live
    // terminal beats a wrongly painted one — tmux paints it a moment later anyway.
    expect(seedPaint({ replay: 'warm-attach', superseded: false, screen: '' })).toBe('none')
  })

  it('paints nothing for a parked terminal (its buffer is already correct)', () => {
    expect(
      seedPaint({ replay: 'none', superseded: false, snapshot: 'old', screen: 'scr' })
    ).toBe('none')
  })

  it('a resync SUPERSEDES every seed: the decision is "write nothing", never "abort"', () => {
    // The whole point of the helper: a superseded seed still returns a PAINT decision, so the spawn
    // continuation carries on to wire onExit, term.onData (the keyboard input path) and the
    // initialCommand / agent resume. `none` is not a signal to return.
    for (const replay of ['cold-snapshot', 'warm-attach', 'none'] as const) {
      expect(
        seedPaint({
          replay,
          superseded: true,
          snapshot: 'old snapshot',
          screen: 'old screen'
        })
      ).toBe('none')
    }
  })
})

/** An xterm stand-in: `write` is PARSED ASYNCHRONOUSLY (callbacks fire on `parse()`). */
function fakeTerm(): {
  ops: string[]
  parse: () => void
  write(data: string, done?: () => void): void
  reset(): void
} {
  const queue: Array<() => void> = []
  return {
    ops: [] as string[],
    write(data: string, done?: () => void) {
      this.ops.push(`write:${data}`)
      if (done) queue.push(done)
    },
    reset() {
      this.ops.push('reset')
    },
    parse() {
      while (queue.length) queue.shift()!()
    }
  }
}

describe('repaintResync', () => {
  it('resets only AFTER the writes already queued have been parsed (never mid-flight)', () => {
    const term = fakeTerm()
    term.write('STALE HISTORY') // a seed already handed to xterm but not yet parsed
    repaintResync(term, 'FRESH')
    // Nothing repainted yet: an inline reset() would have cleared an almost-empty buffer and the
    // stale history would then parse on top of the cleared screen.
    expect(term.ops).toEqual(['write:STALE HISTORY', 'write:'])
    term.parse()
    expect(term.ops).toEqual([
      'write:STALE HISTORY',
      'write:',
      'reset',
      'write:FRESH',
      `write:${RESYNC_NOTICE}`
    ])
    const reset = term.ops.indexOf('reset')
    expect(reset).toBeGreaterThan(term.ops.indexOf('write:STALE HISTORY'))
    expect(reset).toBeLessThan(term.ops.indexOf('write:FRESH'))
  })

  it('CRLF-converts the capture (tmux emits bare LFs; xterm runs convertEol:false)', () => {
    const term = fakeTerm()
    repaintResync(term, 'a\nb')
    term.parse()
    expect(term.ops).toContain('write:a\r\nb')
  })

  it('touches NOTHING once the terminal is dead (the deferred reset outlives teardown)', () => {
    const term = fakeTerm()
    let dead = false
    repaintResync(term, 'FRESH', () => !dead)
    // Teardown: the node is destroyed while the zero-length write is still queued. The listener is
    // unsubscribed and the xterm disposed — but xterm's write loop still owns the callback.
    dead = true
    term.parse()
    // Only the zero-length probe write, which happened before teardown. No reset()/write() on a
    // disposed core (which throws inside xterm's async write loop).
    expect(term.ops).toEqual(['write:'])
  })

  it('still repaints while the terminal is alive (the guard is not a blanket no-op)', () => {
    const term = fakeTerm()
    repaintResync(term, 'FRESH', () => true)
    term.parse()
    expect(term.ops).toEqual(['write:', 'reset', 'write:FRESH', `write:${RESYNC_NOTICE}`])
  })

  it('coalesces back-to-back resyncs: only the LATEST capture is painted, once', () => {
    const term = fakeTerm()
    repaintResync(term, 'OLD')
    repaintResync(term, 'NEW') // lands before OLD's callback ran
    term.parse()
    // A stacked repaint would reset, paint OLD, reset, paint NEW — leaving OLD's parse output
    // spliced above NEW. Superseded captures are dropped instead: one reset, the newest screen.
    expect(term.ops).toEqual([
      'write:',
      'write:',
      'reset',
      'write:NEW',
      `write:${RESYNC_NOTICE}`
    ])
  })

  it('coalescing is per terminal and per round (a later, separate resync still paints)', () => {
    const term = fakeTerm()
    repaintResync(term, 'ONE')
    term.parse()
    repaintResync(term, 'TWO')
    term.parse()
    expect(term.ops.filter((o) => o === 'reset')).toHaveLength(2)
    expect(term.ops).toContain('write:ONE')
    expect(term.ops).toContain('write:TWO')
  })
})

const visual = (p: Partial<XtermVisualSettings> = {}): XtermVisualSettings => ({
  fontFamily: 'Menlo',
  fontSize: 13,
  terminalWordSeparator: " ()[]{}',\"",
  fontWeight: 400,
  fontWeightBold: 700,
  drawBoldTextInBrightColors: true,
  terminalMinContrast: 1,
  cursorBlink: true,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  terminalLineHeight: 1,
  terminalLetterSpacing: 0,
  terminalTheme: 'nodeterm-dark',
  tmuxScrollback: 50000,
  ...p
})

describe('terminalLineHeight / terminalLetterSpacing (clamps)', () => {
  it('passes through in-range values', () => {
    expect(terminalLineHeight(1.4)).toBe(1.4)
    expect(terminalLetterSpacing(1.5)).toBe(1.5)
  })

  it('clamps out-of-range values to the bounds', () => {
    expect(terminalLineHeight(0.2)).toBe(TERMINAL_LINE_HEIGHT_MIN)
    expect(terminalLineHeight(9)).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(terminalLetterSpacing(-40)).toBe(TERMINAL_LETTER_SPACING_MIN)
    expect(terminalLetterSpacing(40)).toBe(TERMINAL_LETTER_SPACING_MAX)
  })

  // A hand-edited settings.json can carry anything. NaN would sail through a bare Math.min/max
  // and reach xterm, which renders a zero-height grid from it.
  it('falls back to the default for a non-number / NaN', () => {
    expect(terminalLineHeight(NaN)).toBe(1)
    expect(terminalLetterSpacing(NaN)).toBe(0)
    expect(terminalLineHeight(undefined as unknown as number)).toBe(1)
    expect(terminalLetterSpacing('3' as unknown as number)).toBe(0)
  })
})

describe('xtermOptionsFromSettings', () => {
  it('maps settings onto xterm option names', () => {
    const o = xtermOptionsFromSettings(
      visual({
        fontFamily: 'JetBrains Mono',
        fontSize: 15,
        terminalWordSeparator: ' ',
        cursorBlink: false,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'none',
        terminalLineHeight: 1.3,
        terminalLetterSpacing: 0.5
      })
    )
    expect(o.fontFamily).toBe('JetBrains Mono')
    expect(o.fontSize).toBe(15)
    expect(o.wordSeparator).toBe(' ')
    expect(o.cursorBlink).toBe(false)
    expect(o.cursorStyle).toBe('bar')
    expect(o.cursorInactiveStyle).toBe('none')
    expect(o.lineHeight).toBe(1.3)
    expect(o.letterSpacing).toBe(0.5)
  })

  it('clamps the metrics and the scrollback', () => {
    const o = xtermOptionsFromSettings(
      visual({ terminalLineHeight: 99, terminalLetterSpacing: 99, tmuxScrollback: 10 ** 9 })
    )
    expect(o.lineHeight).toBe(TERMINAL_LINE_HEIGHT_MAX)
    expect(o.letterSpacing).toBe(TERMINAL_LETTER_SPACING_MAX)
    expect(o.scrollback).toBe(XTERM_SCROLLBACK_MAX)
  })

  it('resolves the theme, tolerating an unknown id', () => {
    expect(xtermOptionsFromSettings(visual({ terminalTheme: 'nord' })).theme).toBe(
      resolveTerminalTheme('nord').theme
    )
    expect(xtermOptionsFromSettings(visual({ terminalTheme: 'bogus' })).theme).toBe(
      resolveTerminalTheme('nodeterm-dark').theme
    )
  })

  it('carries the non-appearance options both call sites need', () => {
    const o = xtermOptionsFromSettings(visual())
    expect(o.allowProposedApi).toBe(true)
    expect(o.macOptionClickForcesSelection).toBe(true)
  })
})

describe('applyLiveOptions', () => {
  /** An xterm stand-in that records every WRITE to `options` — the guard is the point. */
  function fakeTerm(s: XtermVisualSettings): LiveOptionTarget & { writes: string[] } {
    const writes: string[] = []
    const backing = xtermOptionsFromSettings(s) as unknown as Record<string, unknown>
    const options = new Proxy(backing, {
      set(t, k, v) {
        writes.push(String(k))
        t[String(k)] = v
        return true
      }
    }) as LiveOptionTarget['options']
    return { options, writes }
  }

  it('reports no change and writes nothing when settings are unchanged', () => {
    const s = visual()
    const term = fakeTerm(s)
    expect(applyLiveOptions(term, s)).toEqual({ metricsChanged: false, themeChanged: false })
    // xterm's `options` is a setter proxy: an unchanged write still fires its change handling,
    // and terminals are re-optioned on every settings keystroke.
    expect(term.writes).toEqual([])
  })

  it('applies a font size change and reports metricsChanged', () => {
    const term = fakeTerm(visual())
    const r = applyLiveOptions(term, visual({ fontSize: 16 }))
    expect(r.metricsChanged).toBe(true)
    expect(r.themeChanged).toBe(false)
    expect(term.options.fontSize).toBe(16)
    expect(term.writes).toEqual(['fontSize'])
  })

  it('applies a word-separator change without refitting the terminal', () => {
    const term = fakeTerm(visual())
    const r = applyLiveOptions(term, visual({ terminalWordSeparator: ' ' }))
    expect(r).toEqual({ metricsChanged: false, themeChanged: false })
    expect(term.options.wordSeparator).toBe(' ')
    expect(term.writes).toEqual(['wordSeparator'])
  })

  it.each([
    ['fontFamily', { fontFamily: 'Iosevka' }],
    ['lineHeight', { terminalLineHeight: 1.5 }],
    ['letterSpacing', { terminalLetterSpacing: 2 }]
  ] as const)('treats %s as a cell-geometry change', (_name, patch) => {
    const term = fakeTerm(visual())
    expect(applyLiveOptions(term, visual(patch)).metricsChanged).toBe(true)
  })

  // The distinction is what decides whether the caller re-fits (and, under co-attach, re-reports
  // its grid to a SHARED pty). A palette swap must not drag every terminal through a resize.
  it.each([
    ['cursorStyle', { cursorStyle: 'bar' }],
    ['cursorInactiveStyle', { cursorInactiveStyle: 'none' }],
    ['cursorBlink', { cursorBlink: false }],
    ['scrollback', { tmuxScrollback: 20000 }],
    ['theme', { terminalTheme: 'dracula' }]
  ] as const)('does NOT treat %s as a cell-geometry change', (_name, patch) => {
    const term = fakeTerm(visual())
    expect(applyLiveOptions(term, visual(patch as Partial<XtermVisualSettings>)).metricsChanged).toBe(
      false
    )
  })

  // The font WEIGHTS are the interesting case: xterm's CharSizeService re-measures the cell only
  // on fontFamily/fontSize, so a weight change repaints but never moves the grid. Reporting it as
  // a metrics change would push a pointless resize at the shared pty on every weight tweak.
  it.each([
    ['fontWeight', { fontWeight: 300 }],
    ['fontWeightBold', { fontWeightBold: 600 }],
    ['drawBoldTextInBrightColors', { drawBoldTextInBrightColors: false }],
    ['terminalMinContrast', { terminalMinContrast: 4.5 }]
  ] as const)('applies %s without reporting a cell-geometry change', (_name, patch) => {
    const term = fakeTerm(visual())
    const r = applyLiveOptions(term, visual(patch as Partial<XtermVisualSettings>))
    expect(r).toEqual({ metricsChanged: false, themeChanged: false })
    expect(term.writes).toHaveLength(1)
  })

  it('clamps a hand-edited weight and contrast rather than passing them to xterm', () => {
    const o = xtermOptionsFromSettings(
      visual({ fontWeight: 5000, fontWeightBold: 0, terminalMinContrast: 99 })
    )
    expect(o.fontWeight).toBe(900)
    expect(o.fontWeightBold).toBe(100)
    expect(o.minimumContrastRatio).toBe(21)
  })

  it('falls back for a NaN weight or contrast', () => {
    const o = xtermOptionsFromSettings(
      visual({ fontWeight: NaN, fontWeightBold: NaN, terminalMinContrast: NaN })
    )
    expect(o.fontWeight).toBe(400)
    expect(o.fontWeightBold).toBe(700)
    expect(o.minimumContrastRatio).toBe(1)
  })

  it('applies a theme change and reports themeChanged', () => {
    const term = fakeTerm(visual())
    const r = applyLiveOptions(term, visual({ terminalTheme: 'tokyo-night' }))
    expect(r.themeChanged).toBe(true)
    expect(term.options.theme).toBe(resolveTerminalTheme('tokyo-night').theme)
    expect(term.writes).toEqual(['theme'])
  })

  it('an unknown theme id resolves to the default, so it is not a change', () => {
    const term = fakeTerm(visual())
    expect(applyLiveOptions(term, visual({ terminalTheme: 'bogus' })).themeChanged).toBe(false)
  })

  it('applies several changes in one pass', () => {
    const term = fakeTerm(visual())
    const r = applyLiveOptions(
      term,
      visual({ fontSize: 18, terminalTheme: 'nord', cursorStyle: 'underline' })
    )
    expect(r).toEqual({ metricsChanged: true, themeChanged: true })
    expect(term.options.fontSize).toBe(18)
    expect(term.options.cursorStyle).toBe('underline')
    expect(term.options.theme).toBe(resolveTerminalTheme('nord').theme)
  })
})

describe('mergeProjectVisuals (a project\'s own theme / font over the global settings)', () => {
  it('returns the base BY IDENTITY when the project overrides nothing', () => {
    const base = visual()
    expect(mergeProjectVisuals(base, undefined)).toBe(base)
    expect(mergeProjectVisuals(base, {})).toBe(base)
  })

  it('lets a project theme win over the global one', () => {
    const merged = mergeProjectVisuals(visual({ terminalTheme: 'nord' }), { theme: 'dracula' })
    expect(merged.terminalTheme).toBe('dracula')
    expect(xtermOptionsFromSettings(merged).theme).toBe(resolveTerminalTheme('dracula').theme)
  })

  it('lets a project font family win over the global one', () => {
    const merged = mergeProjectVisuals(visual({ fontFamily: 'Menlo' }), { fontFamily: 'Iosevka' })
    expect(merged.fontFamily).toBe('Iosevka')
    expect(xtermOptionsFromSettings(merged).fontFamily).toBe('Iosevka')
  })

  // The whole reason `isKnownTerminalThemeId` exists: `resolveTerminalTheme` is total, so passing an
  // unknown override straight through would repaint the project's terminals with the APP DEFAULT
  // rather than leaving the user's own global choice alone.
  it('falls back to the GLOBAL theme for an unknown id, not to the app default', () => {
    const merged = mergeProjectVisuals(visual({ terminalTheme: 'nord' }), { theme: 'bogus' })
    expect(merged.terminalTheme).toBe('nord')
    expect(xtermOptionsFromSettings(merged).theme).toBe(resolveTerminalTheme('nord').theme)
    expect(xtermOptionsFromSettings(merged).theme).not.toBe(
      resolveTerminalTheme('nodeterm-dark').theme
    )
  })

  it('ignores a blank font family rather than handing xterm an empty string', () => {
    const base = visual({ fontFamily: 'Menlo' })
    expect(mergeProjectVisuals(base, { fontFamily: '' })).toBe(base)
    expect(mergeProjectVisuals(base, { fontFamily: '   ' })).toBe(base)
  })

  it('overrides one value without disturbing the other twelve', () => {
    const base = visual({ fontSize: 15, cursorStyle: 'bar' })
    const merged = mergeProjectVisuals(base, { theme: 'nord' })
    expect(merged).toEqual({ ...base, terminalTheme: 'nord' })
  })

  // Live application rides the EXISTING machinery: nothing new re-fits, and a project font is a
  // cell-geometry change exactly like a global one (see the co-attach caveat on mergeProjectVisuals).
  it('feeds applyLiveOptions the same way a global change does', () => {
    const base = visual()
    const backing = xtermOptionsFromSettings(base) as unknown as Record<string, unknown>
    const term = { options: backing } as LiveOptionTarget
    expect(applyLiveOptions(term, mergeProjectVisuals(base, { theme: 'nord' }))).toEqual({
      metricsChanged: false,
      themeChanged: true
    })
    expect(applyLiveOptions(term, mergeProjectVisuals(base, { fontFamily: 'Iosevka' }))).toEqual({
      metricsChanged: true,
      themeChanged: true // back off `nord` — the project no longer sets a theme in this call
    })
  })
})
