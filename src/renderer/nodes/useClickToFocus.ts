import { useEffect, useRef } from 'react'
import {
  bodyPressAcknowledges,
  focusLossOutcome,
  outsidePressReleases,
  reclaimOnRelease,
  reclaimTarget
} from '../lib/terminalFocusMode'

/** What the click-to-focus machinery needs from its terminal node. Read LIVE on every event. */
export interface ClickToFocusHost {
  id: string
  /** The node's own root (`.term-node`). Focus mode MOVES this element; it is never replaced. */
  root: () => HTMLElement | null
  /** The xterm's input element, if a terminal is mounted. */
  xtermTextarea: () => HTMLTextAreaElement | undefined
  /** The ⌘M (Markdown / chat) view covers the xterm. */
  mdMode: () => boolean
  /** True while focus mode is moving the root; the blur that move causes is not the user leaving. */
  reparenting: () => boolean
  /** The node's `enterNow` — the acknowledgement a dwell or a guard click runs. */
  acknowledge: () => void
  /** `focusXtermUnlessCovered` for this node. */
  focusXterm: () => void
  setArmed: (armed: boolean) => void
  remember: () => void
  isActive: () => boolean
  setActive: (active: boolean) => void
  reportFocus: () => void
  releaseFocus: () => void
}

/**
 * The node's "I hold the keyboard" state follows DOM focus and deliberate presses, never the
 * pointer's position. Born for click to focus (#757); since sloppy focus it runs in BOTH modes — a
 * hover dwell only TAKES the keyboard, and losing it is this hook's job either way. In
 * focus-follows-pointer mode the host's `setArmed` is a no-op (`focusDrivesGuard`): the guard
 * belongs to the pointer there.
 *
 * ONE document capture `pointerdown` listener plus `focusin`/`focusout` on the node root. Earlier
 * versions also listened on the React Flow wrapper, captured once when the effect ran — and focus
 * mode moves the root out of that wrapper into the fullscreen surface, after which body presses
 * never reached the wrapper listener and the document listener called them "outside" (Codex round
 * 3). Now every containment question is asked at EVENT time: the root is the one stable element,
 * and "this node's own chrome" is `root.closest('.react-flow__node') ?? root`, resolved when the
 * press happens (in focus mode that is just the root, which is all of the node there is).
 *
 * The press listener does three things, in this order:
 * - remembers that a press landed on this node, for the `focusout` that the press's own default
 *   action causes in the same task (MEASURED in Electron 42: pointerdown → mousedown → focusout);
 * - releases an active node that holds no focus when the press is elsewhere (`outsidePressReleases`);
 * - acknowledges a deliberate primary press in the body (`bodyPressAcknowledges`), guard excluded.
 *
 * Capture phase on the document, so React Flow's d3-drag (which stops mousedown at the wrapper) can
 * never hide a press. The focus decisions are the pure functions in `lib/terminalFocusMode.ts`.
 */
export function useClickToFocus(host: ClickToFocusHost): void {
  const hostRef = useRef(host)
  hostRef.current = host
  useEffect(() => {
    const h = () => hostRef.current
    const root = h().root()
    if (!root) return
    let pressedInOwnNode = false
    let pressedInReadableText = false
    // Set by a `reclaim-on-release` focusout; settled by the press's pointerup (see focusLossOutcome).
    let reclaimOnUp: HTMLElement | null = null
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let reclaimTimer: ReturnType<typeof setTimeout> | null = null

    const release = () => {
      h().setArmed(true)
      h().setActive(false)
      h().releaseFocus()
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null
      const ownNode = root.closest<HTMLElement>('.react-flow__node') ?? root
      const inNode = !!target && ownNode.contains(target)
      if (inNode) {
        pressedInOwnNode = true
        pressedInReadableText = !!target?.closest('.term-chat__msgs')
        if (pressTimer) clearTimeout(pressTimer)
        pressTimer = setTimeout(() => {
          pressedInOwnNode = false
          pressedInReadableText = false
          pressTimer = null
        }, 0)
      }
      if (
        outsidePressReleases({
          isActive: h().isActive(),
          pressInsideNode: inNode,
          focusInsideNode: root.contains(document.activeElement)
        })
      ) {
        release()
        return
      }
      if (
        target &&
        root.contains(target) &&
        bodyPressAcknowledges({
          primary: e.button === 0,
          inBody: !!target.closest('.term-node__body'),
          onGuard: !!target.closest('.term-hover-guard')
        })
      ) {
        h().acknowledge()
      }
    }

    const onFocusIn = (e: FocusEvent) => {
      if (e.target === h().xtermTextarea()) {
        h().setArmed(false)
        h().remember()
      }
      h().setActive(true)
      h().reportFocus()
    }

    const onFocusOut = (e: FocusEvent) => {
      // Focus mode's own reparent (reparentKeepingFocus re-focuses the element right after).
      if (h().reparenting()) return
      const outcome = focusLossOutcome({
        nodeRoot: root,
        lost: e.target,
        gained: e.relatedTarget,
        activeElement: document.activeElement,
        windowFocused: document.hasFocus(),
        pressedInOwnNode,
        pressedInReadableText,
        lostIsCoveredXterm: h().mdMode() && e.target === h().xtermTextarea()
      })
      if (outcome === 'keep') return
      if (outcome === 'release') {
        release()
        return
      }
      if (outcome === 'reclaim-on-release') {
        reclaimOnUp = e.target instanceof HTMLElement ? e.target : null
        return
      }
      // 'reclaim': once the press's own focus change has settled, give the keyboard back to what
      // lost it (the ⌘M composer) or to the xterm. If nothing inside the node could take it (the
      // xterm is covered or gone), the keyboard really did leave, so say so.
      const lost = e.target
      if (reclaimTimer) clearTimeout(reclaimTimer)
      reclaimTimer = setTimeout(() => {
        reclaimTimer = null
        const target = reclaimTarget({
          lostIsXterm: lost === h().xtermTextarea(),
          lostStillInNode: lost instanceof HTMLElement && lost.isConnected && root.contains(lost)
        })
        if (target === 'lost') (lost as HTMLElement).focus()
        else h().focusXterm()
        if (!root.contains(document.activeElement)) release()
      }, 0)
    }

    // Activity claimed WITHOUT focus (the ⌘M view blurs the xterm and keeps the node active) never
    // sees a root focusout, and keyboard focus moving elsewhere (⌘K's autofocus) sends no
    // pointerdown. So a focus landing outside this node is the same "the user went elsewhere" as an
    // outside press. The node's own wrapper counts as inside: a header press focuses it on the way
    // to `reclaim`.
    const onDocFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Node ? e.target : null
      const ownNode = root.closest('.react-flow__node') ?? root
      if (
        outsidePressReleases({
          isActive: h().isActive(),
          pressInsideNode: !!target && ownNode.contains(target),
          focusInsideNode: !!target && root.contains(target)
        })
      ) {
        release()
      }
    }

    const onPointerUp = () => {
      const lost = reclaimOnUp
      if (!lost) return
      reclaimOnUp = null
      const sel = window.getSelection()
      if (
        reclaimOnRelease({
          selectionEmpty: !sel || sel.isCollapsed || sel.toString() === '',
          lostStillInNode: lost.isConnected && root.contains(lost)
        })
      )
        lost.focus()
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('focusin', onDocFocusIn, true)
    root.addEventListener('focusin', onFocusIn)
    root.addEventListener('focusout', onFocusOut)
    return () => {
      if (pressTimer) clearTimeout(pressTimer)
      if (reclaimTimer) clearTimeout(reclaimTimer)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('focusin', onDocFocusIn, true)
      root.removeEventListener('focusin', onFocusIn)
      root.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
