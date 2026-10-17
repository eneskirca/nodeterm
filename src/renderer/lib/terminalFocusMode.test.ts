import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  focusLossOutcome,
  reclaimOnRelease,
  bodyPressAcknowledges,
  outsidePressReleases,
  reclaimTarget,
  hoverTakesKeyboard,
  pointerLeaveRearmsGuard,
  focusDrivesGuard,
  dwellBlursForeignTerminal,
  resolveFocusFollowsPointer
} from './terminalFocusMode'

/**
 * Issue #757 — "option to disable X Window focus-follows-pointer (Mac-style click to select what
 * UI element has the input focus)". A terminal node's keyboard used to follow the POINTER: a hover
 * dwell took it, leaving the node took it away. `settings.terminalFocusFollowsPointer` keeps the
 * hover dwell (the default) or switches to click-to-focus, where the pointer decides nothing and the
 * clicked terminal keeps the keyboard until the user clicks somewhere else.
 *
 * Since then the default became SLOPPY focus: the dwell still takes the keyboard, but leaving the
 * node no longer takes it away — it stays until another node takes it (a dwell, a click) or the
 * user clicks elsewhere. Typing into a terminal while the mouse rests on the canvas no longer
 * silently stops working.
 */
describe('terminal focus mode (#757)', () => {
  it('defaults to focus-follows-pointer, so nobody’s terminal changes behaviour on upgrade', () => {
    expect(DEFAULT_SETTINGS.terminalFocusFollowsPointer).toBe(true)
  })

  describe('resolveFocusFollowsPointer', () => {
    it('switches to click to focus only on a literal false', () => {
      expect(resolveFocusFollowsPointer(false)).toBe(false)
      expect(resolveFocusFollowsPointer(true)).toBe(true)
      // settings.json is hand-editable: a mangled value keeps the default, never flips the mode.
      expect(resolveFocusFollowsPointer(undefined)).toBe(true)
      expect(resolveFocusFollowsPointer('false')).toBe(true)
      expect(resolveFocusFollowsPointer(null)).toBe(true)
    })
  })

  describe('hoverTakesKeyboard', () => {
    it('lets a hover dwell take the keyboard only while focus follows the pointer', () => {
      expect(hoverTakesKeyboard(true)).toBe(true)
      expect(hoverTakesKeyboard(false)).toBe(false)
    })
  })

  describe('pointerLeaveRearmsGuard', () => {
    it('re-arms the guard on mouseleave only while focus follows the pointer', () => {
      // The guard is a POINTER contract in that mode: a pass-over scroll pans the canvas until the
      // next dwell, so leaving must put it back.
      expect(pointerLeaveRearmsGuard(true)).toBe(true)
      // Click to focus: the guard follows DOM focus, and the pointer wandering off changes nothing.
      expect(pointerLeaveRearmsGuard(false)).toBe(false)
    })
  })

  describe('focusDrivesGuard', () => {
    it('lets focus changes arm and disarm the guard only in click to focus', () => {
      expect(focusDrivesGuard(false)).toBe(true)
      // Focus follows the pointer: the dwell, a click and mouseleave own the guard. A release that
      // re-armed it would strand a pointer resting on the body behind an armed guard with no
      // mouseenter coming to restart the dwell; a reclaim that dropped it would let a pass-over
      // scroll reach tmux.
      expect(focusDrivesGuard(true)).toBe(false)
    })
  })

  describe('dwellBlursForeignTerminal', () => {
    // Sloppy focus: the pointer leaving a terminal no longer takes its keyboard, so the dwell onto
    // the NEXT node is what moves it. A node whose ⌘M view covers its xterm cannot take it, and
    // without this the terminal the user came from would keep receiving keystrokes while another
    // node reads as the active one.
    it('takes the keyboard off another terminal when this node cannot take it itself', () => {
      expect(dwellBlursForeignTerminal({ covered: true, activeIsForeignXterm: true })).toBe(true)
    })

    it('leaves it to focus() when the xterm is not covered (focusing it moves the keyboard anyway)', () => {
      expect(dwellBlursForeignTerminal({ covered: false, activeIsForeignXterm: true })).toBe(false)
    })

    it('never blurs anything but another terminal (a sticky, an editor, a field keep their caret)', () => {
      expect(dwellBlursForeignTerminal({ covered: true, activeIsForeignXterm: false })).toBe(false)
    })
  })

  describe('focusLossOutcome', () => {
    // Plain objects stand in for DOM nodes: all the helper asks of `nodeRoot` is `contains`.
    const lost = { id: 'xterm-textarea' }
    const header = { id: 'rename-input' }
    const elsewhere = { id: 'other-node-textarea' }
    const ownWrapper = { id: 'react-flow-node-wrapper' }
    const body = { id: 'body' }
    const nodeRoot = { contains: (n: unknown) => n === lost || n === header }
    const ev = (over: Partial<Parameters<typeof focusLossOutcome>[0]>) =>
      focusLossOutcome({
        nodeRoot,
        lost,
        gained: null,
        activeElement: body,
        windowFocused: true,
        pressedInOwnNode: false,
        pressedInReadableText: false,
        lostIsCoveredXterm: false,
        ...over
      })

    it('releases when focus moved to something outside the node (another card, a field)', () => {
      expect(ev({ gained: elsewhere, activeElement: elsewhere })).toBe('release')
    })

    it('releases when a click sent focus nowhere (the empty canvas blurs the xterm, #86)', () => {
      expect(ev({ gained: null, activeElement: body })).toBe('release')
    })

    it('keeps it when focus only moved inside the same node (header field, ⌘M composer)', () => {
      expect(ev({ gained: header, activeElement: header })).toBe('keep')
      // …even when the press that moved it was on this node.
      expect(ev({ gained: header, activeElement: header, pressedInOwnNode: true })).toBe('keep')
    })

    it('reclaims the keyboard when the user pressed this node’s own chrome (header drag)', () => {
      // The wrapper is focusable in React Flow, so a header press moves focus to it — outside
      // `.term-node`, where the next Backspace would be the canvas's delete-selection.
      expect(ev({ gained: ownWrapper, activeElement: ownWrapper, pressedInOwnNode: true })).toBe('reclaim')
      // A non-focusable wrapper sends focus to <body> instead; same press, same answer.
      expect(ev({ gained: null, activeElement: body, pressedInOwnNode: true })).toBe('reclaim')
    })

    it('defers the reclaim to the end of the press when it landed on readable text (⌘M chat selection)', () => {
      // Reclaiming now would move the selection into the composer and cancel the drag.
      expect(ev({ gained: null, activeElement: body, pressedInOwnNode: true, pressedInReadableText: true })).toBe(
        'reclaim-on-release'
      )
      // The flag alone (no press on this node in this task) changes nothing.
      expect(ev({ gained: null, activeElement: body, pressedInReadableText: true })).toBe('release')
      // Focus moving to another element inside the node still wins.
      expect(ev({ gained: header, activeElement: header, pressedInOwnNode: true, pressedInReadableText: true })).toBe('keep')
    })

    it('keeps it when the WINDOW lost focus (Cmd+Tab away): the terminal still owns the keyboard', () => {
      // Chromium fires blur/focusout on the focused element when the window deactivates, but the
      // element stays `document.activeElement` and gets focus back on return. Releasing here would
      // drop the node's active flag on every app switch.
      expect(ev({ activeElement: lost, windowFocused: false })).toBe('keep')
      expect(ev({ activeElement: lost, windowFocused: true })).toBe('keep')
      expect(ev({ activeElement: body, windowFocused: false })).toBe('keep')
    })

    it('keeps it when the xterm is blurred by opening the node\'s own ⌘M view', () => {
      // useMdModeFocus blurs the xterm on entry and focuses nothing, so the focusout has no
      // destination and no press — exactly the shape of a click on the empty canvas. It is an
      // internal view change on the node the user is looking at, not leaving it.
      expect(ev({ gained: null, activeElement: body, lostIsCoveredXterm: true })).toBe('keep')
    })

    it('answers keep without a node root (unmounted mid-event) rather than guessing', () => {
      expect(ev({ nodeRoot: null })).toBe('keep')
    })
  })

  describe('outsidePressReleases', () => {
    // Activity can be claimed without this node ever holding DOM focus: "go to node" while the ⌘M
    // view covers the xterm (`focusXtermUnlessCovered` deliberately does not focus it), and Canvas's
    // own `setActive` on a sidebar / notification jump. No `focusout` can come from a node that has
    // no focus, and with click to focus `mouseleave` no longer releases either — so a stale active
    // flag suppressed the unread dot for that node until something else became active.
    it('releases a node that claims activity but holds no focus when the user presses elsewhere', () => {
      expect(outsidePressReleases({ isActive: true, pressInsideNode: false, focusInsideNode: false })).toBe(true)
    })

    it('leaves a node alone whose focus will report its own loss (the focusout path owns that)', () => {
      expect(outsidePressReleases({ isActive: true, pressInsideNode: false, focusInsideNode: true })).toBe(false)
    })

    it('never releases on a press inside the node itself', () => {
      expect(outsidePressReleases({ isActive: true, pressInsideNode: true, focusInsideNode: false })).toBe(false)
    })

    it('has nothing to release when the node is not the active one', () => {
      expect(outsidePressReleases({ isActive: false, pressInsideNode: false, focusInsideNode: false })).toBe(false)
    })
  })

  describe('reclaimTarget', () => {
    // MEASURED in Electron 42 (Blink): a press on the node's own header moves focus from whatever
    // held it to the React Flow wrapper (tabindex 0). When the ⌘M view is open, what held it was the
    // composer, and the covered xterm cannot take focus back — so reclaiming only to the xterm left
    // the keyboard on the wrapper, where Backspace is the canvas's delete-selection.
    it('hands focus back to the element inside the node that lost it (the ⌘M composer)', () => {
      expect(reclaimTarget({ lostIsXterm: false, lostStillInNode: true })).toBe('lost')
    })

    it('uses the xterm when the xterm lost it, or when the lost element is gone (rename field closed)', () => {
      expect(reclaimTarget({ lostIsXterm: true, lostStillInNode: true })).toBe('xterm')
      expect(reclaimTarget({ lostIsXterm: false, lostStillInNode: false })).toBe('xterm')
    })
  })

  describe('bodyPressAcknowledges', () => {
    // Click to focus has no dwell, so a deliberate press is the acknowledgement (active,
    // clearUnread, presence) — on the xterm with the guard already down (a finish that turned unread
    // while the window was inactive), on the ⌘M view, on its composer. Only a press can: a focus
    // restore on window activation is not the user aiming at the node.
    it('acknowledges any primary press inside the node body', () => {
      expect(bodyPressAcknowledges({ primary: true, inBody: true, onGuard: false })).toBe(true)
    })

    it('leaves the guard to HoverGuard, since a press there may be the start of a node drag', () => {
      expect(bodyPressAcknowledges({ primary: true, inBody: true, onGuard: true })).toBe(false)
    })

    it('ignores the header chrome and non-primary buttons', () => {
      expect(bodyPressAcknowledges({ primary: true, inBody: false, onGuard: false })).toBe(false)
      expect(bodyPressAcknowledges({ primary: false, inBody: true, onGuard: false })).toBe(false)
    })
  })

  // The decisions above are only worth something if the node and the settings page use them. A
  // source check, like `focusRestore.test.ts`: TerminalNode cannot be mounted without an xterm.
  describe('wiring', () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

    it('TerminalNode reads the setting live and routes hover, leave and focus loss through it', () => {
      const src = read('src/renderer/nodes/TerminalNode.tsx')
      expect(src).toContain('useSettings((s) => s.settings.terminalFocusFollowsPointer)')
      expect(src).toContain('hoverTakesKeyboard(focusFollowsPointer)')
      expect(src).toContain('pointerLeaveRearmsGuard(focusFollowsPointer)')
      // Sloppy focus: DOM focus owns the keyboard in BOTH modes, so the hook always runs and only
      // the guard is mode-dependent.
      expect(src).toContain('useClickToFocus({')
      expect(src).toContain('if (focusDrivesGuard(focusFollowsPointer)) setArmed(armed)')
      expect(src).toContain('dwellBlursForeignTerminal({')
      // The pointer leaving never takes the keyboard away: no blur, no release, in either mode.
      const leave = src.slice(src.indexOf('const onBodyLeave = () => {'), src.indexOf('useClickToFocus({'))
      expect(leave).not.toContain('blur()')
      expect(leave).not.toContain('setActive(id, false)')
      expect(leave).not.toContain('releaseFocus(')
      // A dwell already running when the setting is switched off must not still take the keyboard:
      // the timer re-reads the LIVE setting, and switching off cancels a pending dwell.
      expect(src).toContain('if (!hoverTakesKeyboard(focusFollowsPointerRef.current)) return')
      expect(src).toMatch(/if \(focusFollowsPointer\) return\s*\n\s*if \(dwellRef\.current\) clearTimeout\(dwellRef\.current\)/)
      // Focus mode keeps the keyboard across its reparent in BOTH modes, and tells the hook.
      expect(src.match(/reparentKeepingFocus\(/g)?.length).toBe(2)
      expect(src).toContain('reparenting: () => reparentingRef.current')
      const hook = read('src/renderer/nodes/useClickToFocus.ts')
      for (const call of ['focusLossOutcome(', 'outsidePressReleases(', 'bodyPressAcknowledges(', 'reclaimTarget(']) {
        expect(hook).toContain(call)
      }
      expect(hook).toContain('lostIsCoveredXterm:')
    })

    it('Settings → Behavior offers the toggle, findable by search', () => {
      const src = read('src/renderer/components/settings/sections/BehaviorSection.tsx')
      expect(src).toContain('update({ terminalFocusFollowsPointer: v })')
      for (const k of ['focus', 'hover', 'pointer', 'click', 'follows', 'x11']) {
        expect(src).toMatch(new RegExp(`focusFollowsPointer: \\{[^}]*'${k}'`))
      }
    })
  })
  describe('reclaimOnRelease', () => {
    it('gives the keyboard back only for a plain click, and only to an element still in the node', () => {
      expect(reclaimOnRelease({ selectionEmpty: true, lostStillInNode: true })).toBe(true)
      expect(reclaimOnRelease({ selectionEmpty: false, lostStillInNode: true })).toBe(false)
      expect(reclaimOnRelease({ selectionEmpty: true, lostStillInNode: false })).toBe(false)
    })
  })
})
