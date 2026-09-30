// What a terminal link points at, said before the click — and the one extra gesture a link takes.
//
// Since relative paths resolve against the node's launch cwd OR the pane's live cwd (file-links.ts
// `findExistingPath`), the text on screen no longer says which file a click will open. Hovering a
// link therefore shows the RESOLVED target plus the gestures it takes:
//
//   /home/me/proj/src/a.ts  (⌘-click to open · ⇧⌘-click to open with default app)
//
// Behaviour adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.) — its terminal-link hover
// hint and Shift+Cmd "open with the system default app" routing; the code here is our own.
//
// Pure pieces (the modifier routing, the hint text, the per-surface refusal) are separate from the
// one DOM piece (the tooltip), so every decision is unit-testable without a terminal.
import { canUseLocalShell, type DownloadContext } from '../lib/download'

/** What a modified click on a link asks for. `system` = hand it to the OS default app. */
export type LinkOpenIntent = 'none' | 'open' | 'system'

/**
 * Modifier routing for every link click path (xterm's provider `activate` and the tmux-mode
 * capture fallback), so the two cannot disagree. Cmd (mac) or Ctrl is the link modifier, exactly
 * as before; adding Shift to it asks for the OS app. Shift ALONE is never a link gesture — it is
 * xterm's force-selection / selection-extend modifier, and stays that.
 */
export function linkOpenIntent(ev: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>): LinkOpenIntent {
  if (!(ev.metaKey || ev.ctrlKey)) return 'none'
  return ev.shiftKey ? 'system' : 'open'
}

/** The link modifier as the user types it on this platform. */
function mod(mac: boolean): string {
  return mac ? '⌘' : 'Ctrl'
}

export interface FileHintOpts {
  abs: string
  dir: boolean
  /** macOS glyphs (⌘ ⇧) vs spelled-out Ctrl/Shift. */
  mac: boolean
  /** Shift+modifier-click can hand the path to the OS here (`systemOpenRefusal` answered null).
   *  When it cannot, the gesture is not advertised — a hint promising a click that only toasts
   *  would be worse than no hint. */
  systemOpen: boolean
}

/** The hover text for a file or directory link. */
export function fileLinkHint({ abs, dir, mac, systemOpen }: FileHintOpts): string {
  const m = mod(mac)
  const shift = mac ? '⇧⌘' : 'Shift+Ctrl'
  // A plain modified click on a directory reveals it in the Explorer drawer (TerminalNode's
  // `openFile`), not an editor — say so.
  const parts = [dir ? `${m}-click to reveal` : `${m}-click to open`]
  if (systemOpen) {
    parts.push(dir ? `${shift}-click to open in ${mac ? 'Finder' : 'file manager'}` : `${shift}-click to open with default app`)
  }
  return `${abs} (${parts.join(' · ')})`
}

/** The hover text for a URL link (typed or OSC 8 — whose target the visible label hides). */
export function urlLinkHint(url: string, mac: boolean): string {
  return `${url} (${mod(mac)}-click to open)`
}

function baseName(abs: string): string {
  const trimmed = abs.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || abs
}

/**
 * Why Shift+modifier-click cannot open `abs` with the OS default app here, or null when it can.
 * Gated on the SAME predicate as every other `shell.*` path action (`canUseLocalShell` — also the
 * link menu's Reveal in Finder), so the surfaces cannot drift:
 *
 *  - desktop, local project → null; the host calls `shell.openPath` (a directory opens in the
 *    OS file manager).
 *  - SSH project → refused. The OS here cannot open a path on another machine, and handing it the
 *    path would open an unrelated LOCAL file if one happened to exist there. We deliberately do
 *    NOT download-then-open: a click that silently copies a (possibly huge) file or whole folder
 *    to this machine is a side effect nobody asked for, and edits made in the local app would land
 *    on a stale copy, not the host's file. The link's right-click menu offers Download, one
 *    gesture away, and the toast says so.
 *  - Server Edition (browser tab) → refused: a browser cannot hand a host file to an OS app, and
 *    the bridge's `shell.openPath` is a documented inert stub. Not a fallback to the plain open —
 *    a modified gesture that silently does a DIFFERENT thing is harder to learn than one that says
 *    it is unavailable.
 *  - relay tab → refused: the path lives on the peer's machine.
 */
export function systemOpenRefusal(ctx: DownloadContext, abs: string): string | null {
  if (canUseLocalShell(ctx)) return null
  const name = baseName(abs)
  if (ctx.source === 'relay') {
    return `“${name}” is on another machine — it cannot be opened with an app on this one.`
  }
  if (ctx.ssh) {
    return `“${name}” is on the SSH host — the apps on this machine cannot open it. Right-click the link to download it first.`
  }
  return `“${name}” can only be opened with its default app by the desktop app — a browser tab cannot hand a file to your operating system.`
}

export interface LinkHintTooltip {
  /** Show `text` near viewport point (x, y), after the hover delay. */
  show(text: string, clientX: number, clientY: number): void
  hide(): void
  dispose(): void
}

/** Gap between the pointer and the tooltip, in CSS px of the terminal's own (unscaled) space. */
const OFFSET_X = 12
const OFFSET_Y = 18
const EDGE = 4

/**
 * The hover tooltip — one per xterm instance, living INSIDE `host` (the terminal's own element).
 * Inside, not portalled to the body, so it travels with the terminal across a park (detached with
 * it, invisible) and dies with it; the copy pill lives in the node for the same reason. The canvas
 * zoom is a CSS transform on an ancestor, so the pointer's viewport offset is divided by the
 * rendered/layout width ratio to land in the element's own coordinate space (the same cancellation
 * `bufferPosFromEvent` does for cells), and the tooltip then scales with the terminal text.
 *
 * `pointer-events: none` + xterm's own `xterm-hover` class: it can never take a click, a wheel or a
 * hover away from the terminal underneath (xterm's linkifier also ignores events from inside an
 * `.xterm-hover` element, belt and braces). A press or a wheel anywhere on the terminal hides it —
 * a click has just opened the link, and a scroll moved the text out from under it.
 */
export function createLinkHintTooltip(host: HTMLElement, delayMs = 250): LinkHintTooltip {
  const doc = host.ownerDocument
  const tip = doc.createElement('div')
  tip.className = 'term-link-hint xterm-hover'
  tip.setAttribute('role', 'tooltip')
  tip.hidden = true
  host.appendChild(tip)
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const hide = (): void => {
    cancel()
    tip.hidden = true
  }
  const place = (text: string, clientX: number, clientY: number): void => {
    if (!host.isConnected) return
    tip.textContent = text
    tip.hidden = false
    const rect = host.getBoundingClientRect()
    const layoutW = host.offsetWidth || rect.width
    const layoutH = host.offsetHeight || rect.height
    const scale = layoutW > 0 && rect.width > 0 ? rect.width / layoutW : 1
    const x = (clientX - rect.left) / scale
    const y = (clientY - rect.top) / scale
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    const left = Math.max(EDGE, Math.min(x + OFFSET_X, layoutW - w - EDGE))
    // Below the pointer; above it when that would leave the terminal.
    const below = y + OFFSET_Y
    const top = below + h + EDGE > layoutH ? Math.max(EDGE, y - h - OFFSET_Y / 2) : below
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }
  const onPress = (): void => hide()
  host.addEventListener('mousedown', onPress, { capture: true })
  host.addEventListener('wheel', onPress, { capture: true, passive: true })

  return {
    show(text, clientX, clientY) {
      cancel()
      if (delayMs <= 0) place(text, clientX, clientY)
      else timer = setTimeout(() => place(text, clientX, clientY), delayMs)
    },
    hide,
    dispose() {
      hide()
      host.removeEventListener('mousedown', onPress, { capture: true })
      host.removeEventListener('wheel', onPress, { capture: true })
      tip.remove()
    }
  }
}

/** Hide every link tooltip under `root` — for a terminal re-adopted from the park, whose
 *  tooltip may have been showing when its element was detached (no `mouseleave` fires then). */
export function hideLinkHints(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.term-link-hint').forEach((el) => {
    el.hidden = true
  })
}
