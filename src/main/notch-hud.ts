// macOS Notch HUD (docs/notch-hud.md) — a transparent, always-on-top, click-through strip along
// the top edge that shows walking agent mascots beside the MacBook notch while agents work, and
// expands into a mini session panel. macOS + desktop only; default on (settings.notchHud).
//
// This module owns the BrowserWindow + the getHudWindow/sendToHud singleton (mirroring
// main-window.ts) and the mirror/IPC subscriptions. The DATA folding lives in the pure,
// Electron-free notch-hud-model.ts so it is unit-testable without a window. index.ts feeds two
// extra streams in (the normalized agent-event stream for prompt+subagents, and context-update for
// the model) via the module-level notchHudOn* functions, which no-op when the HUD is off.

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { getMainWindow, sendToMain } from './main-window'
import {
  onNodeStateChange,
  onNodeNowChange,
  onMirrorFlush,
  type NodeStateChange,
  type NodeNowChange,
  type MirrorFile
} from '../core/agent-status-mirror'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { createHudModel, type HudModel, type HudContextUpdate } from './notch-hud-model'
import { hudGeometry, hudPlacement, type HudGeometry } from './notch-hud-geometry'
import {
  sanitizeNotchAlign,
  sanitizeNotchOffsetY,
  sanitizeNotchWidth,
  type NotchAlign
} from '../shared/notch-hud'

// The notch-width constants + `sanitizeNotchWidth` moved to src/shared/notch-hud.ts (2026-09) so
// Settings → Notch reads the same bounds it clamps against; re-exported for existing importers.
export { NOTCH_WIDTH_MIN, NOTCH_WIDTH_MAX } from '../shared/notch-hud'
/** Debounce for coalescing feed changes into one push to the HUD renderer. */
const PUSH_DEBOUNCE_MS = 150
/** Low-frequency sweep so stale (gone + idle > 6h) nodes drop even with no live events. */
// Also the tick that lets the model's working watchdog and the relative times age without events.
const SWEEP_MS = 60 * 1000

/**
 * Keep the app a REGULAR Dock app even though the HUD is a `focusable:false` (non-activating
 * panel) overlay. On macOS `focusable:false` maps to AppKit's `setDisableKeyOrMainWindow:YES`, so
 * the HUD window can never become the app's key/main window. If such a panel is the only window
 * that is orderFront-ed on screen (e.g. it shows before the main window has finished loading, or
 * while the main window is hidden by hide-on-close), macOS re-evaluates the app as having no
 * regular window and drops its Dock tile — the "Dock icon disappears once the HUD opens" bug.
 * Asserting `regular` + `dock.show()` is idempotent and cheap, and guarantees the HUD never
 * demotes the app's Dock presence. No-op off macOS.
 */
export function assertRegularDockPresence(): void {
  if (process.platform !== 'darwin') return
  try {
    // Idempotent: re-asserting 'regular' when already regular is a no-op.
    app.setActivationPolicy('regular')
  } catch {
    /* older Electron / transient — ignore */
  }
  // `dock.show()` returns a Promise in recent Electron; swallow it either way.
  try {
    void Promise.resolve(app.dock?.show()).catch(() => {})
  } catch {
    /* ignore */
  }
}

// ---- Singleton (mirror main-window.ts) -----------------------------------------------------

let hudWin: BrowserWindow | null = null

export function getHudWindow(): BrowserWindow | null {
  return hudWin && !hudWin.isDestroyed() ? hudWin : null
}

export function sendToHud(channel: string, ...args: unknown[]): void {
  getHudWindow()?.webContents.send(channel, ...args)
}

// ---- Controller ----------------------------------------------------------------------------

export interface NotchHudDeps {
  /** Sync in-memory node title (workspaceStore.getNodeTitle). */
  getNodeTitle: (nodeId: string) => string | undefined
}

/** The user-tunable part of the HUD (Settings → Interface → Notch). Applied live, no restart. */
export interface NotchHudTunables {
  enabled: boolean
  /** Assumed physical notch width in px — the knob that makes the capsule sit flush. */
  notchWidth: number
  /** Which side of the primary display the capsule sits on (settings.notchAlign). */
  align: NotchAlign
  /** Vertical offset from the capsule's resting place, px, positive = down (settings.notchOffsetY). */
  offsetY: number
  /** Expand the panel on hover (else click-only). */
  hoverExpand: boolean
  /** settings.usagePercentMode — how the rows' context percentages render ("42% used" / "58% left"). */
  percentMode: 'used' | 'remaining' | 'tokens'
}

/** Everything but `enabled` — the values a RUNNING controller can take live. */
type LiveTunables = Omit<NotchHudTunables, 'enabled'>

class NotchHudController {
  private model: HudModel = createHudModel()
  private unsubs: (() => void)[] = []
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private ipcBound = false
  private readonly onSetIgnoreMouse: (_e: unknown, ignore: boolean) => void
  private readonly onFocusNode: (_e: unknown, nodeId: string) => void
  private readonly onExpanded: () => void
  private readonly onDismiss: (_e: unknown, nodeId: string) => void
  private readonly onDisplayChange: () => void

  constructor(
    private deps: NotchHudDeps,
    private tunables: LiveTunables
  ) {
    this.onSetIgnoreMouse = (_e, ignore) => {
      // Ignore-mouse ON = click-through (the strip is transparent to the app beneath); OFF while the
      // pointer is over the hotspot/panel so clicks land. `forward` keeps move events flowing so the
      // renderer still sees pointer-leave to re-enable click-through.
      getHudWindow()?.setIgnoreMouseEvents(!!ignore, { forward: true })
    }
    this.onFocusNode = (_e, nodeId) => {
      if (typeof nodeId !== 'string' || !nodeId) return
      // Reuse the notification-click focus path: bring the main window forward + ask the renderer to
      // center the node, then clear its done highlight (a nodeterm-native "you looked at it").
      const w = getMainWindow()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        sendToMain(IPC.appFocusNode, nodeId)
      }
      this.model.noteFocus(nodeId)
      this.schedulePush()
    }
    this.onDismiss = (_e, nodeId) => {
      if (typeof nodeId !== 'string' || !nodeId) return
      this.model.dismiss(nodeId)
      this.schedulePush()
    }
    // NOTE: opening/closing the panel deliberately marks NOTHING as read. It used to clear every
    // done latch on close ("you looked at it"), which lost the plot with three finished sessions
    // waiting: open the panel, click one, and the other two silently vanished unread. Read is now
    // strictly per row — clicking/Go-ing a row clears that row (onFocusNode), and the × dismisses
    // one by hand. The event is still wired because the renderer's expand state may drive more here.
    this.onExpanded = () => {}
    this.onDisplayChange = () => this.reposition()
  }

  start(): void {
    this.createWindow()
    this.bindIpc()
    this.unsubs.push(onNodeStateChange((c: NodeStateChange) => this.onModelChange(() => this.model.applyStateChange(c))))
    this.unsubs.push(onNodeNowChange((c: NodeNowChange) => this.onModelChange(() => this.model.applyNowChange(c))))
    this.unsubs.push(onMirrorFlush((doc: MirrorFile) => this.onModelChange(() => this.model.applyMirrorFlush(doc))))
    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
    this.sweepTimer = setInterval(() => {
      // Always re-push: the working watchdog and the relative timestamps both age with the clock,
      // so a row has to be able to change with no incoming event at all.
      this.model.prune(Date.now())
      this.schedulePush()
    }, SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
    screen.removeListener('display-metrics-changed', this.onDisplayChange)
    screen.removeListener('display-added', this.onDisplayChange)
    screen.removeListener('display-removed', this.onDisplayChange)
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.unbindIpc()
    if (hudWin && !hudWin.isDestroyed()) hudWin.destroy()
    hudWin = null
  }

  /** Feed the normalized agent-event stream (prompt on newTurn + subagent grouping). */
  onAgentEvent(ev: NormalizedAgentEvent): void {
    this.onModelChange(() => this.model.applyAgentEvent(ev))
  }

  /** Feed a context-update {sessionId, model, usedPercent} (the model name). */
  onContextUpdate(p: HudContextUpdate): void {
    this.onModelChange(() => this.model.applyContextUpdate(p))
  }

  private onModelChange(mutate: () => void): void {
    try {
      mutate()
    } catch {
      // A malformed event must never crash the HUD (or the main process).
      return
    }
    this.schedulePush()
  }

  private bindIpc(): void {
    if (this.ipcBound) return
    ipcMain.on(IPC.hudSetIgnoreMouse, this.onSetIgnoreMouse)
    ipcMain.on(IPC.hudFocusNode, this.onFocusNode)
    ipcMain.on(IPC.hudExpanded, this.onExpanded)
    ipcMain.on(IPC.hudDismiss, this.onDismiss)
    this.ipcBound = true
  }

  private unbindIpc(): void {
    if (!this.ipcBound) return
    ipcMain.removeListener(IPC.hudSetIgnoreMouse, this.onSetIgnoreMouse)
    ipcMain.removeListener(IPC.hudFocusNode, this.onFocusNode)
    ipcMain.removeListener(IPC.hudExpanded, this.onExpanded)
    ipcMain.removeListener(IPC.hudDismiss, this.onDismiss)
    this.ipcBound = false
  }

  /** Apply live tunables and re-push, so a slider drag moves the capsule as you drag. Goes through
   *  `reposition` rather than a bare push because the vertical offset changes the window HEIGHT
   *  (a lowered panel needs room below it) — `setBounds` with unchanged bounds is a no-op. */
  setTunables(t: LiveTunables): void {
    this.tunables = {
      notchWidth: t.notchWidth,
      align: t.align,
      offsetY: t.offsetY,
      hoverExpand: t.hoverExpand,
      percentMode: t.percentMode
    }
    this.reposition()
  }

  /** The placement settings, re-validated HERE at the point of use (settings.json is hand-editable;
   *  the type is compile-time only): an unknown side → center, a bad offset → 0 / the nearest bound. */
  private placementSettings(): { align: NotchAlign; offsetY: number } {
    return { align: sanitizeNotchAlign(this.tunables.align), offsetY: sanitizeNotchOffsetY(this.tunables.offsetY) }
  }

  private geometry(): HudGeometry {
    // Always the PRIMARY display's live bounds — never a cached rect — so a display change (or a
    // resolution change under a placement edit) is answered from what the screen reports now.
    const d = screen.getPrimaryDisplay()
    return hudGeometry({
      bounds: d.bounds,
      workArea: d.workArea,
      // `internal` is what keeps an external monitor at a low resolution from reading as notched.
      internal: d.internal === true,
      notchWidth: sanitizeNotchWidth(this.tunables.notchWidth),
      offsetY: this.placementSettings().offsetY
    })
  }

  private reposition(): void {
    const w = getHudWindow()
    if (!w) return
    const g = this.geometry()
    w.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height })
    this.schedulePush() // re-send geometry (bar can change with the notch/menu-bar)
  }

  private createWindow(): void {
    if (getHudWindow()) return
    const g = this.geometry()
    const win = new BrowserWindow({
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
      // LOAD-BEARING (field bug: the capsule rendered as a detached black box BELOW the menu bar
      // instead of fused with the notch). AppKit's -[NSWindow constrainFrameRect:toScreen:] pushes
      // every window down so it can't overlap the menu bar / notch strip; Electron only skips that
      // constraint when enableLargerThanScreen is set. Without it our y = display.bounds.y request
      // is silently clamped to workArea.y and the window can never paint over the notch.
      enableLargerThanScreen: true,
      // NSPanel (non-activating), the same window class agent-notch uses for its indicator: floats
      // over fullscreen spaces and never takes key/main.
      type: 'panel',
      // Do not steal the space or animate; it is a passive overlay.
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/hud.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    hudWin = win
    // Float above full-screen apps and every Space; screen-saver level keeps it over normal windows.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Passive by default: the strip is click-through; the renderer flips this OFF over the hotspot.
    win.setIgnoreMouseEvents(true, { forward: true })
    // The HUD must NEVER affect the Dock: this is a regular Dock app. Creating a focusable:false
    // panel can otherwise demote the app to accessory and drop the Dock icon — re-assert here.
    assertRegularDockPresence()

    win.on('closed', () => {
      if (hudWin === win) hudWin = null
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}/hud.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/hud.html'))
    }
    win.webContents.on('did-finish-load', () => {
      win.showInactive() // show without stealing focus
      // Showing the panel is exactly when macOS re-evaluates the app's window set — re-assert the
      // regular Dock policy so the freshly-shown non-activating panel can't demote us to accessory.
      assertRegularDockPresence()
      this.pushNow()
    })
  }

  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushNow()
    }, PUSH_DEBOUNCE_MS)
    this.pushTimer.unref?.()
  }

  private pushNow(): void {
    const w = getHudWindow()
    if (!w) return
    const now = Date.now()
    this.model.prune(now)
    const rows = this.model.buildRows(now, this.deps.getNodeTitle)
    const g = this.geometry()
    // Did AppKit still push us below the menu bar despite enableLargerThanScreen (older macOS, an
    // unusual display arrangement)? Then the window CANNOT paint over the notch, and reserving the
    // fused top strip would only make the capsule a tall detached box — the exact field bug. Tell
    // the renderer so it drops the reserved strip and draws a compact pill instead.
    const clamped = w.getBounds().y > g.y
    // Where the capsule and its panel sit, from the user's side + offset. Fed the SAME hasNotch the
    // renderer used to key its shape on (detection AND the clamp check), so "fused" can never be
    // claimed for a window that cannot paint over the notch.
    const p = hudPlacement({
      width: g.width,
      bar: g.bar,
      notchWidth: g.notchWidth,
      notchCenterX: g.notchCenterX,
      hasNotch: g.hasNotch && !clamped,
      ...this.placementSettings()
    })
    w.webContents.send(IPC.hudRows, {
      rows,
      bar: g.bar,
      width: g.width,
      notchWidth: g.notchWidth,
      hoverExpand: this.tunables.hoverExpand,
      percentMode: this.tunables.percentMode,
      notchCenterX: g.notchCenterX,
      fused: p.fused,
      anchor: p.anchor,
      capsuleX: p.capsuleX,
      capsuleTop: p.capsuleTop,
      panelLeft: p.panelLeft,
      panelWidth: p.panelWidth
    })
  }
}

// ---- Module-level lifecycle + feed shims ---------------------------------------------------

let controller: NotchHudController | null = null
let controllerDeps: NotchHudDeps | null = null

/** Whether the HUD is supported on this platform (macOS desktop only). */
function supported(): boolean {
  return process.platform === 'darwin'
}

/**
 * Create the HUD (if darwin + enabled). Idempotent. `deps.getNodeTitle` is retained so a later
 * `setNotchHudEnabled(true)` (settings toggle) can recreate it without re-plumbing.
 */
export function initNotchHud(deps: NotchHudDeps, t: NotchHudTunables): void {
  controllerDeps = deps
  if (!supported() || !t.enabled) return
  if (controller) return
  controller = new NotchHudController(deps, t)
  controller.start()
}

/**
 * Live settings apply: create/destroy the window on the enable toggle, and push the geometry
 * tunables (notch width, side, vertical offset, hover-expand) straight through to a running HUD —
 * no restart, so the width / offset sliders can be dragged while watching the capsule move.
 */
export function applyNotchHudSettings(t: NotchHudTunables): void {
  if (!supported()) return
  if (!t.enabled) {
    controller?.stop()
    controller = null
    return
  }
  if (controller) {
    controller.setTunables(t)
    return
  }
  if (!controllerDeps) return
  controller = new NotchHudController(controllerDeps, t)
  controller.start()
}

/** Tear the HUD down (app quit). */
export function destroyNotchHud(): void {
  controller?.stop()
  controller = null
}

/** Feed shims — cheap no-ops when the HUD is off. Called unconditionally from index.ts. */
export function notchHudOnAgentEvent(ev: NormalizedAgentEvent): void {
  controller?.onAgentEvent(ev)
}
export function notchHudOnContextUpdate(p: HudContextUpdate): void {
  controller?.onContextUpdate(p)
}
