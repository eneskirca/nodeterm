import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { IPC } from '../shared/ipc'
import { MAIN_INTERCEPTED_COMMAND_IDS } from '../shared/keybindings'
import {
  MENU_ITEM_ID_CLOSE,
  MENU_ITEM_ID_KANBAN,
  MENU_ITEM_ID_MINIMIZE,
  MENU_ITEM_ID_SETTINGS,
  installKeydownIntercepts,
  keydownIntercept,
  menuItemIdsToSuspend,
  menuStandsDown,
  navigationClearsRecording,
  policyStandsDown,
  resolveInterceptBindings,
  type KeydownInterceptBindings,
  type KeydownInterceptInput,
  type KeydownInterceptTarget,
  closeStandsDownInTerminal
} from './keydown-intercept'

/**
 * BEHAVIOURAL. This replaces `menu-accelerator-intercepts.test.ts`, which asserted on the SOURCE
 * TEXT of `src/main/index.ts` (`expect(MAIN_SRC).toContain(...)`) and was therefore green on a tree
 * where a bare `0` keystroke was swallowed app-wide: the strings it matched were all still present,
 * because the guard that made them safe had moved out from under them. A test that reads the code
 * cannot see the code being *wrong*, only being *absent*.
 *
 * So: press keys, assert what happened. Two outcomes are observable and they are the two that
 * matter — did the window swallow the key (`preventDefault`, which takes it from the page AND the
 * default menu), and what did it forward to the renderer.
 *
 * The load-bearing half of this file is the refusals. Every chord here is built on a character
 * people type (`m`, `w`, `0`), so the difference between "intercepts ⌘0" and "intercepts 0" is one
 * modifier check and a completely unusable app.
 */

/** A `before-input-event` input with every flag off, overridable per case. */
function input(over: Partial<KeydownInterceptInput> = {}): KeydownInterceptInput {
  return {
    type: 'keyDown',
    key: '0',
    code: 'Digit0',
    meta: false,
    control: false,
    shift: false,
    alt: false,
    isAutoRepeat: false,
    ...over
  }
}

/** The shipped bindings, per platform. `node.close` / `node.toggleMarkdown` default to `Cmd+W` /
 *  `Cmd+M` on both, but `Cmd` RESOLVES differently — ⌘ on mac, Control elsewhere — which is what
 *  makes `press(…, { isMac: false })` below the Windows/Linux run of the same chord. */
const DEFAULTS = resolveInterceptBindings(undefined, true)
const DEFAULTS_PC = resolveInterceptBindings(undefined, false)

/**
 * Press a key at the real installation seam: register the handler on a fake window exactly as
 * `createWindow` does, then dispatch. Covers the wiring (`preventDefault` is called, the channel is
 * sent on `webContents`), not just the pure decision.
 */
function press(
  over: Partial<KeydownInterceptInput> = {},
  opts: { bindings?: KeydownInterceptBindings; isMac?: boolean } = {}
): { prevented: boolean; sent: string[] } {
  const isMac = opts.isMac ?? true
  const bindings = opts.bindings ?? (isMac ? DEFAULTS : DEFAULTS_PC)
  // Neither recording nor stood down: the ordinary state of the app, and the baseline every case
  // below asserts against. Each suspended state has its own describe block at the bottom of this
  // file. Both thunks are spelled out rather than defaulted, so a THIRD suspension added to
  // `installKeydownIntercepts` cannot silently inherit "off" here.
  const seam = install(() => bindings, isMac, () => false, () => false)
  seam.fire(over)
  return { prevented: seam.prevented.length > 0, sent: seam.sent }
}

/**
 * ONE installation whose listener can be fired repeatedly — the shape a live window has, and the
 * only way to press the same key on both sides of a state change (the recording bit flipping under
 * a running window is exactly what `press`, which installs per call, cannot show).
 */
function install(
  getBindings: () => KeydownInterceptBindings,
  isMac: boolean,
  isRecording: () => boolean,
  isStoodDown: () => boolean,
  isCloseSuspended?: () => boolean
): { fire: (over?: Partial<KeydownInterceptInput>) => void; prevented: string[]; sent: string[] } {
  let handler:
    | ((event: { preventDefault(): void }, input: KeydownInterceptInput) => void)
    | null = null
  const sent: string[] = []
  const prevented: string[] = []
  const win: KeydownInterceptTarget = {
    webContents: {
      on: (_event, listener) => {
        handler = listener
      },
      send: (channel) => {
        sent.push(channel)
      }
    }
  }
  installKeydownIntercepts(win, getBindings, isMac, isRecording, isStoodDown, isCloseSuspended)
  if (!handler) throw new Error('installKeydownIntercepts registered no before-input-event listener')
  const fire = (over: Partial<KeydownInterceptInput> = {}): void => {
    const i = input(over)
    ;(handler as (e: { preventDefault(): void }, i: KeydownInterceptInput) => void)(
      { preventDefault: () => prevented.push(i.code) },
      i
    )
  }
  return { fire, prevented, sent }
}

/** Nothing happened at all: the page gets the key, and so does the menu if the page ignores it. */
const UNTOUCHED = { prevented: false, sent: [] }

describe('the main window refuses keys it does not claim', () => {
  // THE regression. #193 added the ⌘0 branch under a shared `meta || control` guard; a later
  // rewrite of that shared guard leaves `Digit0` with no modifier test of its own, and every
  // press of the zero key anywhere in the app is eaten and snaps the canvas to 100%.
  it('a bare 0 reaches the page', () => {
    expect(press()).toEqual(UNTOUCHED)
  })

  it('a bare m reaches the page', () => {
    expect(press({ key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
  })

  it('a bare w reaches the page', () => {
    expect(press({ key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })

  // Shift and Alt are not primary modifiers: `)`, `M`, `W`, and every AltGr character on a non-US
  // layout are ordinary typing.
  it.each([
    ['Shift+0 — types ")"', { shift: true, key: ')' }],
    ['Alt+0 — AltGr territory', { alt: true }],
    ['Shift+M', { shift: true, key: 'M', code: 'KeyM' }],
    ['Alt+W', { alt: true, key: 'w', code: 'KeyW' }]
  ])('%s reaches the page', (_name, over) => {
    expect(press(over)).toEqual(UNTOUCHED)
  })

  it('an unclaimed chord (⌘K) reaches the page', () => {
    expect(press({ meta: true, key: 'k', code: 'KeyK' })).toEqual(UNTOUCHED)
  })

  it('keyUp is never intercepted, even for a claimed chord', () => {
    expect(press({ type: 'keyUp', meta: true })).toEqual(UNTOUCHED)
    expect(press({ type: 'keyUp', meta: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ type: 'keyUp', meta: true, key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })
})

describe('⌘0 → canvas back to 100%', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true })).toEqual({ prevented: true, sent: [IPC.appZoomActualSize] })
  })

  it('is intercepted under Ctrl too (Windows / Linux)', () => {
    expect(press({ control: true })).toEqual({ prevented: true, sent: [IPC.appZoomActualSize] })
    expect(press({ control: true }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appZoomActualSize]
    })
  })

  // Matched on the physical key, so the chord survives a layout where the zero key prints
  // something else — the same rule the renderer's `zoomShortcutChord` follows.
  it('is matched on `code`, not the printed character', () => {
    expect(press({ meta: true, key: 'à' })).toEqual({
      prevented: true,
      sent: [IPC.appZoomActualSize]
    })
    // ...and only the digit row: the numpad zero is left to whatever else wants it.
    expect(press({ meta: true, code: 'Numpad0' })).toEqual(UNTOUCHED)
  })

  it('drops OS auto-repeat while still swallowing the key', () => {
    // Both halves matter. Forwarding a held ⌘0 would restart the 200ms zoom tween on every repeat;
    // letting it through would hand the repeat to the default menu's View ▸ Actual Size instead.
    expect(press({ meta: true, isAutoRepeat: true })).toEqual({ prevented: true, sent: [] })
  })

  it('is not claimed with Shift or Alt added', () => {
    expect(press({ meta: true, shift: true })).toEqual(UNTOUCHED)
    expect(press({ meta: true, alt: true })).toEqual(UNTOUCHED)
  })
})

describe('⌘M → markdown view, stolen back from Window ▸ Minimize', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true, key: 'm', code: 'KeyM' })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
    // Windows / Linux: the same `Cmd+M` binding resolves to Control there.
    expect(press({ control: true, key: 'm', code: 'KeyM' }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })

  // D-STRICT DELTA (named in the PR body). The old branch was `key === 'm'` under a
  // `meta || control` guard, so ⌘⇧M, ⌘⌥M and — on mac — ⌃M all toggled too. Matching a real
  // binding is exact on all four modifier flags, so each of those is now a different chord and
  // goes back to the page/menu. This is the behaviour change; assert it rather than leave it to
  // a reader of the diff.
  it('no longer claims ⌘⇧M, ⌘⌥M, or ⌃M on mac', () => {
    expect(press({ meta: true, shift: true, key: 'M', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ meta: true, alt: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
    expect(press({ control: true, key: 'm', code: 'KeyM' })).toEqual(UNTOUCHED)
  })

  it('repeats keep toggling (no auto-repeat rule here, unlike ⌘0)', () => {
    expect(press({ meta: true, key: 'm', code: 'KeyM', isAutoRepeat: true })).toEqual({
      prevented: true,
      sent: [IPC.appToggleMarkdown]
    })
  })
})

describe('⌘W → close the selected node, stolen back from Window ▸ Close', () => {
  it('is intercepted and forwarded', () => {
    expect(press({ meta: true, key: 'w', code: 'KeyW' })).toEqual({
      prevented: true,
      sent: [IPC.appCloseNode]
    })
    expect(press({ control: true, key: 'w', code: 'KeyW' }, { isMac: false })).toEqual({
      prevented: true,
      sent: [IPC.appCloseNode]
    })
  })

  it('leaves ⌘⇧W to the menu (Close All Windows)', () => {
    expect(press({ meta: true, shift: true, key: 'W', code: 'KeyW' })).toEqual(UNTOUCHED)
  })

  // Same D-strict delta as ⌘M's: ⌃W was swallowed app-wide on mac (where it is readline's
  // delete-word, not a menu accelerator) and now reaches the page.
  it('no longer claims ⌃W on mac', () => {
    expect(press({ control: true, key: 'w', code: 'KeyW' })).toEqual(UNTOUCHED)
  })
})

describe('the decision is pure', () => {
  // Same function, called directly: a caller that is not a BrowserWindow (a future menu, a test,
  // the next intercept) gets the same answer, and `null` unambiguously means "not ours".
  it('returns null for anything unclaimed and an action for a claimed chord', () => {
    expect(keydownIntercept(input(), DEFAULTS, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true }), DEFAULTS, true)).toEqual({
      action: 'zoom-actual-size'
    })
    expect(keydownIntercept(input({ meta: true, isAutoRepeat: true }), DEFAULTS, true)).toEqual({
      action: null
    })
  })
})

describe('binding-driven intercept', () => {
  it('defaults reproduce today: Cmd+M and Cmd+W intercept, Shift variants do not', () => {
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), DEFAULTS, true)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ meta: true, key: 'w', code: 'KeyW' }), DEFAULTS, true)).toEqual({
      action: 'close-node'
    })
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'w', code: 'KeyW' }), DEFAULTS, true)).toBeNull()
    // D-strict delta, named in the PR body: ⌘⇧M no longer intercepts (old code ignored shift on m).
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'm', code: 'KeyM' }), DEFAULTS, true)).toBeNull()
  })

  it('an unbound command stops intercepting (Electron default returns)', () => {
    const unbound = resolveInterceptBindings({ 'node.close': [] }, true)
    expect(keydownIntercept(input({ meta: true, key: 'w', code: 'KeyW' }), unbound, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), unbound, true)).toEqual({
      action: 'toggle-markdown'
    })
  })

  it('a remap moves the interception', () => {
    const remapped = resolveInterceptBindings({ 'node.toggleMarkdown': ['Cmd+Shift+M'] }, true)
    expect(keydownIntercept(input({ meta: true, key: 'm', code: 'KeyM' }), remapped, true)).toBeNull()
    expect(keydownIntercept(input({ meta: true, shift: true, key: 'm', code: 'KeyM' }), remapped, true)).toEqual({
      action: 'toggle-markdown'
    })
  })

  // The reason the primary-modifier half of the old shared gate could NOT stay where it was: an
  // Alt-only chord is a valid binding per the registry's rules, this intercept is its only
  // dispatcher (the chord never reaches the renderer — the page does not see a claimed key), so a
  // `meta || control` gate above the matchers would make the remap dead everywhere with no error.
  // Pressed with **isMac: false** on purpose: `Alt+M` is a Windows/Linux chord. macOS composes
  // Option+letter into a character (⌥M reports `key: 'µ'`), so this exact remap could not fire
  // there whatever this module did — mac's stake in the gate is Alt+non-letter (F-keys, arrows).
  it('an Alt-only remap fires off-mac, and the bare key still does not', () => {
    const alt = resolveInterceptBindings({ 'node.toggleMarkdown': ['Alt+M'] }, false)
    expect(keydownIntercept(input({ alt: true, key: 'm', code: 'KeyM' }), alt, false)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ key: 'm', code: 'KeyM' }), alt, false)).toBeNull()
  })

  // The mac half of the same gate, on a key macOS does NOT compose: ⌥F5 stays `key: 'F5'`.
  it('a mac Alt+non-letter remap fires (what Option composition leaves reachable there)', () => {
    const alt = resolveInterceptBindings({ 'node.toggleMarkdown': ['Alt+F5'] }, true)
    expect(keydownIntercept(input({ alt: true, key: 'F5', code: 'F5' }), alt, true)).toEqual({
      action: 'toggle-markdown'
    })
    expect(keydownIntercept(input({ key: 'F5', code: 'F5' }), alt, true)).toBeNull()
  })

  it('garbage overrides fall back to defaults', () => {
    expect(resolveInterceptBindings({ 'node.close': ['garbage+++'] }, true)).toEqual(DEFAULTS)
  })

  it('the Digit0 zoom gesture is untouched by bindings', () => {
    const unbound = resolveInterceptBindings({ 'node.close': [], 'node.toggleMarkdown': [] }, true)
    expect(keydownIntercept(input({ meta: true, code: 'Digit0' }), unbound, true)).toEqual({
      action: 'zoom-actual-size'
    })
    // ...and it keeps the primary-modifier requirement it used to inherit from the shared gate.
    expect(keydownIntercept(input({ code: 'Digit0' }), unbound, true)).toBeNull()
  })

  it('a remapped binding is dispatched at the install seam too', () => {
    const remapped = resolveInterceptBindings({ 'node.close': ['Cmd+Shift+K'] }, true)
    expect(press({ meta: true, shift: true, key: 'K', code: 'KeyK' }, { bindings: remapped })).toEqual(
      { prevented: true, sent: [IPC.appCloseNode] }
    )
    expect(press({ meta: true, key: 'w', code: 'KeyW' }, { bindings: remapped })).toEqual(UNTOUCHED)
  })

  // LIST DRIFT. `MAIN_INTERCEPTED_COMMAND_IDS` is what the Settings UI checks a candidate binding
  // against for the app-wide shadow warning (`findMainInterceptShadowing`), and nothing else ties
  // it to the commands THIS module actually resolves. A third intercept added here without the id
  // added there would be swallowed app-wide with the recorder cheerfully reporting no conflict.
  it('MAIN_INTERCEPTED_COMMAND_IDS is exactly the set this module resolves', () => {
    expect(Object.keys(DEFAULTS)).toHaveLength(MAIN_INTERCEPTED_COMMAND_IDS.length)
    // Unbinding a listed command must visibly change what this module resolves — i.e. it is read
    // here, not merely claimed.
    for (const id of MAIN_INTERCEPTED_COMMAND_IDS) {
      expect(resolveInterceptBindings({ [id]: [] }, true), id).not.toEqual(DEFAULTS)
    }
  })
})

/**
 * THE bug this suppression exists to close: the Settings shortcut recorder asks the user to PRESS
 * the chord they want to bind, and pressing ⌘W there used to reach `app:close-node` — deleting the
 * selected nodes instead of recording a keystroke. A claimed chord never reaches the page at all,
 * so the recorder's own `preventDefault`/`stopPropagation` cannot help: main has to stand down.
 */
describe('an armed shortcut recorder suspends every interception', () => {
  it('suppresses while armed and resumes on disarm', () => {
    let recording = true
    const seam = install(() => DEFAULTS, true, () => recording, () => false)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    seam.fire({ meta: true, key: 'm', code: 'KeyM' })
    seam.fire({ meta: true, code: 'Digit0' })
    // Not swallowed either: `preventDefault` would take the key from the recorder as well as the
    // menu, so the suppression must return BEFORE it, not merely skip the send.
    expect(seam.prevented).toEqual([])
    expect(seam.sent).toEqual([])
    recording = false
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
    expect(seam.prevented).toEqual(['KeyW'])
  })

  // THE HOLE REVIEW FOUND. The app's own View menu restores `{role:'reload'}` /
  // `{role:'forceReload'}`, and ⌘R/⌘⇧R are ACCELERATORS — they fire above the page, so the
  // recorder's preventDefault cannot stop them. A same-process reload fires no React unmount, no
  // window `closed` and no `render-process-gone`, so every release path this feature had missed
  // it and the bit stayed true forever: ⌘W/⌘M/⌘0 dead app-wide with nothing left to clear them.
  // This mirrors index.ts's wiring exactly — the listener runs the same predicate.
  it('a reload while armed restores interception; an in-page navigation does not', () => {
    let recording = true
    const seam = install(() => DEFAULTS, true, () => recording, () => false)
    const onNavigation = (d: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (navigationClearsRecording(d)) recording = false
    }
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([])
    // pushState / a fragment jump is not a page change: the recorder is still mounted and armed,
    // so disarming here would suppress the recorder instead of the intercept.
    onNavigation({ isMainFrame: true, isSameDocument: true })
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([])
    onNavigation({ isMainFrame: true, isSameDocument: false }) // ⌘R
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })

  it('only a real main-frame document navigation clears the bit', () => {
    expect(navigationClearsRecording({ isMainFrame: true, isSameDocument: false })).toBe(true)
    expect(navigationClearsRecording({ isMainFrame: true, isSameDocument: true })).toBe(false)
    // A subframe navigating is not this page going away — an iframe/ad reloading itself must not
    // silently re-arm the app's shortcuts under a recorder that is still listening.
    expect(navigationClearsRecording({ isMainFrame: false, isSameDocument: false })).toBe(false)
    expect(navigationClearsRecording({ isMainFrame: false, isSameDocument: true })).toBe(false)
  })

  it('is read per event, not captured at install time', () => {
    // The bit lives in a module-level `let` in index.ts that the renderer flips over IPC long
    // after the window was created; a captured boolean would make the whole feature inert.
    let recording = false
    const seam = install(() => DEFAULTS, true, () => recording, () => false)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    recording = true
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })
})

/**
 * The SECOND suspension, and a different fact from the first. `terminal-first` is the user saying
 * "while I am typing in a terminal, the terminal gets the chord" — so main must stop claiming keys
 * it would otherwise steal from the page, for exactly as long as an xterm holds keyboard focus.
 *
 * It is a separate thunk rather than an `||` folded into `isRecording` because the two suspend for
 * unrelated reasons and on unrelated schedules: recording is a Settings dialog being armed and
 * suspends ALWAYS, the policy one is a live focus mirror and suspends only while the mirror says a
 * terminal is focused. One boolean would make "recording still works when the policy is off" — the
 * first case below — untestable, and would hide a future bug where one reason silently ate the
 * other.
 */
describe('terminal-first stands every interception down while a terminal is focused', () => {
  it('suppresses all three chords while stood down, and resumes when it flips back', () => {
    let stoodDown = true
    const seam = install(() => DEFAULTS, true, () => false, () => stoodDown)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    seam.fire({ meta: true, key: 'm', code: 'KeyM' })
    seam.fire({ meta: true, code: 'Digit0' })
    // ⌘0 is in the list on purpose: it is the one chord with no registry command behind it, so a
    // stand-down written against `getBindings` alone would leave it claimed — and the canvas would
    // still snap to 100% under a user who asked their terminal to own the key.
    // Not swallowed either: `preventDefault` takes the key from the PAGE as well as the menu, and
    // the page is who the terminal-first policy is standing down FOR, so the suppression must
    // return before it rather than merely skip the send.
    expect(seam.prevented).toEqual([])
    expect(seam.sent).toEqual([])
    // Focus leaves the terminal (or the user switches back to app-first): every chord is ours again.
    stoodDown = false
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    seam.fire({ meta: true, key: 'm', code: 'KeyM' })
    seam.fire({ meta: true, code: 'Digit0' })
    expect(seam.sent).toEqual([IPC.appCloseNode, IPC.appToggleMarkdown, IPC.appZoomActualSize])
    expect(seam.prevented).toEqual(['KeyW', 'KeyM', 'Digit0'])
  })

  it('the two suspensions are independent — either one alone suppresses', () => {
    let recording = false
    let stoodDown = false
    const seam = install(() => DEFAULTS, true, () => recording, () => stoodDown)
    // Recording alone, with the policy off: the Settings recorder must keep working for a user who
    // never chose terminal-first (i.e. everybody, by default).
    recording = true
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([])
    // Stood down alone, with no recorder armed: the policy suspension does not depend on the other.
    recording = false
    stoodDown = true
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([])
    // Neither: back to the ordinary app.
    stoodDown = false
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })

  it('is read per event, not captured at install time', () => {
    // Same reason as the recording bit's twin test: the focus mirror flips a module-level `let` in
    // index.ts over IPC while the window lives. A captured boolean would make the policy inert for
    // whichever value happened to be true at `createWindow` time — i.e. always inert, since the
    // window is built before any renderer has reported focus.
    let stoodDown = false
    const seam = install(() => DEFAULTS, true, () => false, () => stoodDown)
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    stoodDown = true
    seam.fire({ meta: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })
})

/**
 * Standing the INTERCEPTS down is only half of "the terminal gets the chord". The other half is the
 * application MENU, which is handled above the page either way — so a stand-down that only stopped
 * `preventDefault` would hand ⌘M to `{role:'minimize'}` and, on Windows/Linux, Ctrl+W to
 * `{role:'close'}`. For a terminal-first user that is strictly WORSE than not having the policy:
 * a Linux user's readline kill-word would close their window. `index.ts` therefore disables those
 * menu items for exactly as long as the intercepts are stood down, and this list is which ones.
 */
describe('menuItemIdsToSuspend', () => {
  it('suspends minimize, kanban and settings everywhere, and close only off-mac', () => {
    // The mac template has no `{role:'close'}` at all (Window ▸ Minimize / Zoom / Front), which is
    // exactly why `keydownIntercept` is ⌘W's only handler there. Listing a close id on mac would
    // be a no-op today and a silent lie the day someone adds the role.
    //
    // Kanban and Settings, by contrast, ARE on both templates — `buildAppMenu` builds one
    // `viewSubmenu` array and one `settingsItem` object and puts each into the mac and the
    // Windows/Linux template — so an asymmetry for them would be the lie instead.
    expect(menuItemIdsToSuspend(true)).toEqual([
      MENU_ITEM_ID_MINIMIZE,
      MENU_ITEM_ID_KANBAN,
      MENU_ITEM_ID_SETTINGS
    ])
    expect(menuItemIdsToSuspend(false)).toEqual([
      MENU_ITEM_ID_MINIMIZE,
      MENU_ITEM_ID_KANBAN,
      MENU_ITEM_ID_SETTINGS,
      MENU_ITEM_ID_CLOSE
    ])
  })

  // ⌘⇧B and ⌘, are ordinary registry commands, not intercepted chords — the menu simply takes them
  // above the page, so under terminal-first they were the two chords that did NOT reach the shell.
  // Membership is the whole fix, which is why it is pinned per-id rather than only by the arrays.
  it('carries the two menu-owned registry chords on both platforms', () => {
    for (const isMac of [true, false]) {
      expect(menuItemIdsToSuspend(isMac)).toContain(MENU_ITEM_ID_KANBAN)
      expect(menuItemIdsToSuspend(isMac)).toContain(MENU_ITEM_ID_SETTINGS)
    }
  })

  // The named exception. `{role:'reload'}` / `{role:'forceReload'}` keep their accelerators while
  // stood down ON PURPOSE: a wedged renderer is exactly when ⌘R is needed, and a main-frame
  // navigation is one of the three sites that reset `terminalFocused` / `shortcutRecording`. There
  // is no id to assert the absence of, so this pins the LENGTH — a fourth/fifth entry appearing
  // here (a reload id being the likely one) reds this test and sends the author to the comment.
  it('does not grow silently — reload is deliberately not suspended', () => {
    expect(menuItemIdsToSuspend(true)).toHaveLength(3)
    expect(menuItemIdsToSuspend(false)).toHaveLength(4)
  })

  // The ids are the ONLY link between `buildAppMenu`'s template and the sync that disables the
  // items — `getMenuItemById` answers `null` for a typo, and the fail-safe there is to do nothing,
  // which looks exactly like the feature working. Both sides import these constants, so the typo
  // class cannot happen; this pins that they are distinct and non-empty.
  it('the ids are distinct and non-empty', () => {
    const ids = [
      MENU_ITEM_ID_MINIMIZE,
      MENU_ITEM_ID_CLOSE,
      MENU_ITEM_ID_KANBAN,
      MENU_ITEM_ID_SETTINGS
    ]
    for (const id of ids) expect(id).toBeTruthy()
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/**
 * The composition index.ts hands to the 5th parameter, as a pure function so it can be pressed.
 * The BYTE-IDENTICAL claim of this whole change lives here: on the shipped default (`app-first`)
 * it is false whatever the mirror says, so nothing about the intercepts changes for a user who
 * never touched the setting — including one whose renderer is reporting terminal focus all day.
 */
describe('policyStandsDown', () => {
  it('stands down only under terminal-first, and only while a terminal is focused', () => {
    expect(policyStandsDown('terminal-first', true)).toBe(true)
    expect(policyStandsDown('terminal-first', false)).toBe(false)
  })

  it('app-first never stands down, focused or not', () => {
    expect(policyStandsDown('app-first', true)).toBe(false)
    expect(policyStandsDown('app-first', false)).toBe(false)
  })

  // The fail-safe direction, stated as a test: main starts at `terminalFocused = false` and every
  // reset returns it there, so a mirror that never reported — or a page that died mid-report —
  // leaves the intercepts ON (the pre-feature behaviour), never off.
  it('the reset value (not focused) means intercepts stay on under either policy', () => {
    for (const policy of ['app-first', 'terminal-first'] as const) {
      expect(policyStandsDown(policy, false)).toBe(false)
    }
  })
})

/**
 * The MENU leg's composed state — what `index.ts`'s `syncMenuForStandDown` asks. The INTERCEPT
 * thunks stay two independent parameters (the describe above pins that); only the menu ORs them,
 * because a menu item is enabled or it is not and both reasons want the same items suspended.
 *
 * Why recording joined at all: a menu accelerator is handled above the page, so while a recorder
 * was armed ⌘M minimized the window, ⌘⇧B opened the kanban board and ⌘, opened Settings instead of
 * being recorded. Suspending the items is what lets the chord reach the recorder.
 */
describe('menuStandsDown', () => {
  it('recording alone suspends the menu leg, under either policy', () => {
    expect(menuStandsDown(true, 'app-first', false)).toBe(true)
    expect(menuStandsDown(true, 'terminal-first', false)).toBe(true)
  })
  it('without recording it is exactly the policy stand-down', () => {
    expect(menuStandsDown(false, 'terminal-first', true)).toBe(true)
    expect(menuStandsDown(false, 'terminal-first', false)).toBe(false)
    expect(menuStandsDown(false, 'app-first', true)).toBe(false)
  })

  // The behaviour contract of this change, stated as a test: with no recorder armed the menu leg
  // is BYTE-IDENTICAL to what it was before recording was composed in, so a user who never opens
  // the Settings recorder sees exactly the previous app.
  it('is exactly policyStandsDown over the whole non-recording matrix', () => {
    for (const policy of ['app-first', 'terminal-first'] as const) {
      for (const focused of [true, false]) {
        expect(menuStandsDown(false, policy, focused)).toBe(policyStandsDown(policy, focused))
      }
    }
  })

  // Recording is the ALWAYS suspension (see `installKeydownIntercepts`): it does not consult the
  // mirror, so a recorder armed with no terminal focused still gets its chords.
  it('recording ignores the focus mirror entirely', () => {
    for (const policy of ['app-first', 'terminal-first'] as const) {
      for (const focused of [true, false]) {
        expect(menuStandsDown(true, policy, focused)).toBe(true)
      }
    }
  })
})

/**
 * Issue #383: off-mac, `node.close`'s default chord is Ctrl+W — readline's kill-word in every
 * shell — so while a terminal has FOCUS the close leg stands down REGARDLESS of the policy, and
 * the keystroke falls through untouched to the page → xterm → the pty. mac's ⌘W is not a shell
 * key and is deliberately unaffected.
 */
describe('the close leg stands down inside a terminal, off-mac only (#383)', () => {
  it('closeStandsDownInTerminal truth table', () => {
    expect(closeStandsDownInTerminal(false, true)).toBe(true) // off-mac + terminal focused
    expect(closeStandsDownInTerminal(false, false)).toBe(false) // off-mac, no terminal
    expect(closeStandsDownInTerminal(true, true)).toBe(false) // mac untouched
    expect(closeStandsDownInTerminal(true, false)).toBe(false)
  })

  it('a suspended close chord falls through UNTOUCHED; the other intercepts keep firing', () => {
    let terminalFocused = true
    const offMacDefaults = resolveInterceptBindings({}, false)
    const seam = install(
      () => offMacDefaults,
      false,
      () => false,
      () => false, // app-first: the policy leg does NOT stand down — this is the narrow close rule
      () => closeStandsDownInTerminal(false, terminalFocused)
    )
    seam.fire({ control: true, key: 'w', code: 'KeyW' })
    // No preventDefault and no send: the chord must reach the pty as readline's kill-word.
    expect(seam.prevented).toEqual([])
    expect(seam.sent).toEqual([])
    // The OTHER claimed chords are untouched by the close-only rule.
    seam.fire({ control: true, key: 'm', code: 'KeyM' })
    expect(seam.sent).toEqual([IPC.appToggleMarkdown])
    // Focus leaves the terminal → close works again.
    terminalFocused = false
    seam.fire({ control: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appToggleMarkdown, IPC.appCloseNode])
  })

  it('the default 6th parameter is "never suspended" — pre-#383 callers are byte-identical', () => {
    const offMacDefaults = resolveInterceptBindings({}, false)
    const seam = install(() => offMacDefaults, false, () => false, () => false)
    seam.fire({ control: true, key: 'w', code: 'KeyW' })
    expect(seam.sent).toEqual([IPC.appCloseNode])
  })

  it('index.ts wires the predicate into BOTH consumers (intercept thunk + close menu item)', () => {
    // The menu leg cannot be pressed from here (it lives against a real Menu in index.ts), so the
    // wiring is pinned at source level — the same discipline as hook-verified-parity.
    const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('() => closeStandsDownInTerminal(interceptIsMac, keyStateOf(presenceId).terminalFocused)')
    expect(src).toContain('() => closeStandsDownInTerminal(interceptIsMac, keyStateOf(clientId).terminalFocused)')
    const menuSync = src.slice(
      src.indexOf('function syncMenuForStandDown'),
      src.indexOf('function createWindow')
    )
    expect(menuSync).toContain('closeStandsDownInTerminal(interceptIsMac, terminalFocused)')
    expect(menuSync).toContain('MENU_ITEM_ID_CLOSE')
  })
})
