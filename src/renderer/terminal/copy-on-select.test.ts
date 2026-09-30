// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachCopyOnSelect,
  xtermOwnsMouseDown,
  type CopyOnSelectTerminal
} from './copy-on-select'

/**
 * Issue #759: a `copyOnSelect` setting. The rule is "a COMPLETED MOUSE selection that xterm owns
 * lands on the clipboard" — not "every selection change": the search addon calls
 * `Terminal.select()` while the user steps through hits, and that must never touch the clipboard.
 */
describe('xtermOwnsMouseDown', () => {
  const down = (init: MouseEventInit): MouseEvent => new MouseEvent('mousedown', init)

  it('owns a plain left press when no app is tracking the mouse', () => {
    expect(xtermOwnsMouseDown(down({ button: 0 }), 'none', { isMac: true, optionForces: true })).toBe(true)
    expect(xtermOwnsMouseDown(down({ button: 0 }), 'none', { isMac: false, optionForces: true })).toBe(true)
  })

  it('never owns another button (right-click-selects-word is a context-menu gesture)', () => {
    for (const button of [1, 2]) {
      expect(xtermOwnsMouseDown(down({ button }), 'none', { isMac: true, optionForces: true })).toBe(false)
    }
  })

  it('does not own a plain press while an app tracks the mouse — the report goes to the pty', () => {
    expect(xtermOwnsMouseDown(down({ button: 0 }), 'vt200', { isMac: true, optionForces: true })).toBe(false)
    expect(xtermOwnsMouseDown(down({ button: 0 }), 'any', { isMac: false, optionForces: true })).toBe(false)
  })

  it('owns a FORCED selection inside a mouse-tracking app: Option on macOS, Shift elsewhere', () => {
    expect(
      xtermOwnsMouseDown(down({ button: 0, altKey: true }), 'vt200', { isMac: true, optionForces: true })
    ).toBe(true)
    expect(
      xtermOwnsMouseDown(down({ button: 0, shiftKey: true }), 'vt200', { isMac: false, optionForces: true })
    ).toBe(true)
    // xterm 5.5 `shouldForceSelection`: Shift does not force on macOS, Option only when the option is set.
    expect(
      xtermOwnsMouseDown(down({ button: 0, shiftKey: true }), 'vt200', { isMac: true, optionForces: true })
    ).toBe(false)
    expect(
      xtermOwnsMouseDown(down({ button: 0, altKey: true }), 'vt200', { isMac: true, optionForces: false })
    ).toBe(false)
  })
})

describe('attachCopyOnSelect', () => {
  interface Fake {
    term: CopyOnSelectTerminal & { selection: string; tracking: CopyOnSelectTerminal['modes']['mouseTrackingMode'] }
    element: HTMLElement
    screen: HTMLElement
    write: ReturnType<typeof vi.fn>
    setEnabled: (v: boolean) => void
    dispose: () => void
  }
  const disposers: Array<() => void> = []

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.()
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  function mount(opts: { enabled?: boolean; isMac?: boolean } = {}): Fake {
    const element = document.createElement('div')
    // Stands in for xterm's screen, the usual event target inside `term.element`.
    const screen = document.createElement('div')
    element.appendChild(screen)
    document.body.appendChild(element)
    let enabled = opts.enabled ?? true
    const term = {
      selection: '',
      tracking: 'none' as CopyOnSelectTerminal['modes']['mouseTrackingMode'],
      element,
      get modes() {
        return { mouseTrackingMode: term.tracking }
      },
      options: { macOptionClickForcesSelection: true },
      hasSelection: () => term.selection.length > 0,
      getSelection: () => term.selection
    }
    const write = vi.fn()
    const dispose = attachCopyOnSelect(term, {
      enabled: () => enabled,
      write,
      isMac: opts.isMac ?? true
    })
    disposers.push(dispose)
    return { term, element, screen, write, setEnabled: (v) => (enabled = v), dispose }
  }

  function mouse(target: EventTarget, type: 'mousedown' | 'mouseup', init: MouseEventInit = {}): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
  }

  /** A drag: press inside, xterm builds the selection, release at `upTarget`, timers flush. */
  function drag(f: Fake, text: string, upTarget: EventTarget = f.screen, init: MouseEventInit = {}): void {
    mouse(f.screen, 'mousedown', init)
    f.term.selection = text
    mouse(upTarget, 'mouseup', init)
    vi.runAllTimers()
  }

  it('copies a completed mouse selection', () => {
    const f = mount()
    drag(f, 'hello world')
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('hello world')
  })

  it('reads the selection AFTER xterm finalised it on the same mouseup', () => {
    // xterm's SelectionService finalises on a DOCUMENT bubble-phase mouseup listener it adds on
    // mousedown. The helper listens on the window in the CAPTURE phase — i.e. before xterm — so it
    // must defer its read, or it would see the selection as it was before the release.
    const f = mount()
    const xtermMouseUp = (): void => {
      f.term.selection = 'finalised on mouseup'
    }
    document.addEventListener('mouseup', xtermMouseUp)
    try {
      mouse(f.screen, 'mousedown')
      mouse(f.screen, 'mouseup')
      expect(f.write).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(f.write).toHaveBeenCalledWith('finalised on mouseup')
    } finally {
      document.removeEventListener('mouseup', xtermMouseUp)
    }
  })

  it('does nothing while the setting is off', () => {
    const f = mount({ enabled: false })
    drag(f, 'hello')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('never writes an empty selection (a plain click clears it)', () => {
    const f = mount()
    drag(f, '')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('ignores a programmatic selection — no mousedown in the terminal, no copy', () => {
    // The search addon's `Terminal.select()` sets a selection with no gesture at all; a later
    // release anywhere in the window must not sweep it onto the clipboard.
    const f = mount()
    f.term.selection = 'search hit'
    mouse(document.body, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('copies when the drag is released OUTSIDE the terminal', () => {
    const f = mount()
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    drag(f, 'overshot the node', elsewhere)
    expect(f.write).toHaveBeenCalledWith('overshot the node')
  })

  it('ignores a gesture that STARTED outside the terminal', () => {
    const f = mount()
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    mouse(elsewhere, 'mousedown')
    f.term.selection = 'left over'
    mouse(f.screen, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('copies each completed gesture once, and a stray later mouseup copies nothing', () => {
    const f = mount()
    drag(f, 'one')
    // The pending release listener was one-shot: a release with no new press is not a gesture.
    mouse(document.body, 'mouseup')
    vi.runAllTimers()
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('cancels a gesture abandoned by leaving the window — a later unrelated release copies nothing', () => {
    // Press in the terminal, switch windows with the button held, release in the other app: this
    // window never sees that mouseup. Without a cancel on blur the armed listener survives, and the
    // next click anywhere back here would copy whatever is selected THEN — a search hit included.
    const f = mount()
    mouse(f.screen, 'mousedown')
    window.dispatchEvent(new Event('blur'))
    f.term.selection = 'search hit'
    mouse(document.body, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('cancels a gesture whose release was lost when the NEXT press comes — anywhere', () => {
    // The release of the first gesture never arrived (outside the window, focus kept). A later press
    // that is not a new owned press here — a toolbar click, a plain click in a mouse-tracking
    // terminal — must disarm it, or its own release would copy the stale selection.
    const f = mount()
    mouse(f.screen, 'mousedown')
    f.term.selection = 'stale highlight'
    const toolbar = document.createElement('button')
    document.body.appendChild(toolbar)
    mouse(toolbar, 'mousedown')
    mouse(toolbar, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('a new owned press re-arms cleanly after a lost release, and copies once', () => {
    const f = mount()
    mouse(f.screen, 'mousedown')
    drag(f, 'second drag')
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('second drag')
  })

  it('a right or middle button release during a left drag does not complete it', () => {
    const f = mount()
    mouse(f.screen, 'mousedown')
    f.term.selection = 'partial'
    mouse(f.screen, 'mouseup', { button: 2 })
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
    f.term.selection = 'whole drag'
    mouse(f.screen, 'mouseup')
    vi.runAllTimers()
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith('whole drag')
  })

  it('does not re-copy a stale selection when an app owns the mouse (tmux copy-mode drag)', () => {
    // Under tmux with mouse ON a plain drag is tmux's, which copies via OSC 52 on release. An older
    // xterm selection still on screen must not overwrite that copy a tick later.
    const f = mount()
    f.term.selection = 'stale forced selection'
    f.term.tracking = 'vt200'
    mouse(f.screen, 'mousedown')
    mouse(f.screen, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('copies a forced (Option) selection inside a mouse-tracking app — deliberate', () => {
    const f = mount({ isMac: true })
    f.term.tracking = 'vt200'
    drag(f, 'forced', f.screen, { altKey: true })
    expect(f.write).toHaveBeenCalledWith('forced')
  })

  it('reads the setting LIVE, so a toggle applies to the next gesture', () => {
    const f = mount({ enabled: false })
    drag(f, 'before')
    expect(f.write).not.toHaveBeenCalled()
    f.setEnabled(true)
    drag(f, 'after')
    expect(f.write).toHaveBeenCalledWith('after')
    f.setEnabled(false)
    drag(f, 'off again')
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('honours a toggle-off that lands mid-gesture', () => {
    const f = mount()
    mouse(f.screen, 'mousedown')
    f.term.selection = 'text'
    f.setEnabled(false)
    mouse(f.screen, 'mouseup')
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('dispose removes every listener, including a gesture in flight', () => {
    const f = mount()
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    mouse(f.screen, 'mousedown')
    f.term.selection = 'text'
    f.dispose()
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function), true)
    removeSpy.mockRestore()
    mouse(f.screen, 'mouseup')
    vi.runAllTimers()
    drag(f, 'after dispose')
    expect(f.write).not.toHaveBeenCalled()
  })

  it('dispose cancels a read already scheduled for the release', () => {
    const f = mount()
    mouse(f.screen, 'mousedown')
    f.term.selection = 'text'
    mouse(f.screen, 'mouseup')
    f.dispose()
    vi.runAllTimers()
    expect(f.write).not.toHaveBeenCalled()
  })

  it('a terminal with no element (never opened) attaches nothing and disposes cleanly', () => {
    const write = vi.fn()
    const dispose = attachCopyOnSelect(
      {
        element: undefined,
        modes: { mouseTrackingMode: 'none' },
        options: {},
        hasSelection: () => true,
        getSelection: () => 'x'
      },
      { enabled: () => true, write, isMac: true }
    )
    expect(() => dispose()).not.toThrow()
    expect(write).not.toHaveBeenCalled()
  })
})
