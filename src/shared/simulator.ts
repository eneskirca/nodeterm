/**
 * The Simulator node: a live iOS simulator screen on the canvas — touch with the mouse, type with
 * the keyboard, press home / lock — without DeviceHub. Host side in core/simulator; this module is
 * the pure half both sides share: the persisted config, input validation, and the two mappings
 * (pointer → screen ratio, browser key → HID usage).
 */
import { SIMULATOR_UDID } from './run-config'

// ── Devices: iOS simulators and Android virtual devices ───────────────────────────────────────
//
// One node shows either. An iOS simulator is named by its UDID; an Android virtual device (AVD) by
// `avd:<name>` — the AVD's name is its stable identity (a running emulator's adb serial changes from
// run to run). The persisted field keeps its old name, `udid`, so existing nodes load unchanged.

export type SimulatorPlatform = 'ios' | 'android'

/** An AVD's name, as avdmanager allows it. */
export const ANDROID_AVD_NAME = /^[A-Za-z0-9._-]{1,128}$/
export const ANDROID_DEVICE_ID = /^avd:[A-Za-z0-9._-]{1,128}$/

export function androidDeviceId(avd: string): string {
  return `avd:${avd}`
}

/** The AVD name inside an Android device id, or null for anything else. */
export function avdNameOf(id: string): string | null {
  return ANDROID_DEVICE_ID.test(id) ? id.slice(4) : null
}

/** Which kind of device an id names, or null when it is neither. */
export function simulatorPlatformOf(id: unknown): SimulatorPlatform | null {
  if (typeof id !== 'string') return null
  if (ANDROID_DEVICE_ID.test(id)) return 'android'
  if (SIMULATOR_UDID.test(id)) return 'ios'
  return null
}

/** The canonical form of a device id (UDIDs upper-cased), or null when it is not one. */
export function normalizeDeviceId(id: unknown): string | null {
  const p = simulatorPlatformOf(id)
  if (!p) return null
  return p === 'ios' ? (id as string).toUpperCase() : (id as string)
}

export interface SimulatorDevice {
  id: string
  name: string
  platform: SimulatorPlatform
  /** "iOS 27.1", "API 34". */
  os?: string
  state: 'booted' | 'shutdown'
  /** A running Android device's adb serial (`emulator-5554`) — how Flutter and the run node name it. */
  serial?: string
}

export interface SimulatorDevicesResult {
  devices: SimulatorDevice[]
  /** Why there are no Android devices, when that is not simply "none installed". */
  androidError?: string
}

/** Persisted on a `simulator` node as `data.simulator`. */
export interface SimulatorNodeConfig {
  /** The device: an iOS simulator's UDID, or `avd:<name>` for an Android virtual device. Absent
   *  until one is picked. */
  udid?: string
  /** Its name when picked, so the node can label it before devices load. */
  name?: string
  /** How the device is held. Absent = portrait. */
  orientation?: SimulatorOrientation
  /** A Simulator node split off a run node: that run node's id, so it can be docked back in. */
  dockTo?: string
}

/**
 * A simulator shown INSIDE a run node (`data.runSimulator`): present = shown. The device settings
 * of a Simulator node; its size is the run node's own (the panel fills it), so none is stored.
 */
export type InlineSimulatorConfig = Omit<SimulatorNodeConfig, 'dockTo'>

/** How much a run node grows when its simulator opens (it can then be resized like any node). */
export const INLINE_SIM_HEIGHT = 560

export function normalizeInlineSimulatorConfig(raw: unknown): InlineSimulatorConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { dockTo: _d, ...out } = normalizeSimulatorConfig(raw)
  void _d
  return out
}

// ── Orientation ────────────────────────────────────────────────────────────────────────────────
//
// Rotating a device is two things: the helper tells iOS (a GSEvent to PurpleWorkspacePort), and the
// node turns the picture — the framebuffer always stays portrait while iOS draws its content rotated
// inside it, exactly as a real panel does. Touches are then mapped back from the turned picture to
// framebuffer coordinates. MEASURED (Xcode 27, iPad): Purple value 3 lays the UI out upright for a
// device turned LEFT (counter-clockwise: dock on the framebuffer's left edge), 4 for one turned right.

export type SimulatorOrientation = 'portrait' | 'landscape-left' | 'landscape-right' | 'portrait-upside-down'

const ORIENTATIONS: readonly SimulatorOrientation[] = ['portrait', 'landscape-left', 'portrait-upside-down', 'landscape-right']

/** The GSEvent orientation value the helper sends for each. */
export const ORIENTATION_PURPLE: Readonly<Record<SimulatorOrientation, number>> = {
  portrait: 1,
  'portrait-upside-down': 2,
  'landscape-left': 3,
  'landscape-right': 4
}

/** How far the picture is turned on screen, clockwise, in degrees. */
export const ORIENTATION_DEGREES: Readonly<Record<SimulatorOrientation, 0 | 90 | 180 | 270>> = {
  portrait: 0,
  'landscape-right': 90,
  'portrait-upside-down': 180,
  'landscape-left': 270
}

export function isSimulatorOrientation(v: unknown): v is SimulatorOrientation {
  return typeof v === 'string' && (ORIENTATIONS as readonly string[]).includes(v)
}

/** Turn the device a quarter turn left (counter-clockwise) or right. */
export function rotateOrientation(o: SimulatorOrientation, dir: 'left' | 'right'): SimulatorOrientation {
  const i = ORIENTATIONS.indexOf(o)
  return ORIENTATIONS[(i + (dir === 'left' ? 1 : 3)) % 4]
}

/** A point on the turned picture (0..1 of what is shown) → the same point in the portrait
 *  framebuffer the digitizer expects. */
export function displayToFramebuffer(u: number, v: number, o: SimulatorOrientation): { x: number; y: number } {
  switch (o) {
    case 'landscape-left': // picture turned 90° counter-clockwise
      return { x: 1 - v, y: u }
    case 'landscape-right': // picture turned 90° clockwise
      return { x: v, y: 1 - u }
    case 'portrait-upside-down':
      return { x: 1 - u, y: 1 - v }
    default:
      return { x: u, y: v }
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** Re-validate a persisted config (git-shared, hand-editable). Never undefined: a broken value is
 *  an unconfigured node, which asks for a device. */
export function normalizeSimulatorConfig(raw: unknown): SimulatorNodeConfig {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: SimulatorNodeConfig = {}
  const id = normalizeDeviceId(r.udid)
  if (id) {
    out.udid = id
    if (typeof r.name === 'string' && r.name.trim() && r.name.length <= 200 && !CONTROL.test(r.name)) out.name = r.name.trim()
  }
  if (isSimulatorOrientation(r.orientation) && r.orientation !== 'portrait') out.orientation = r.orientation
  if (typeof r.dockTo === 'string' && SIMULATOR_NODE_ID.test(r.dockTo)) out.dockTo = r.dockTo
  return out
}

export const SIMULATOR_NODE_ID = /^[A-Za-z0-9._-]{1,128}$/

// ── Input ──────────────────────────────────────────────────────────────────────────────────────

export type SimulatorButton = 'home' | 'lock' | 'side' | 'siri' | 'volup' | 'voldown' | 'playpause' | 'back' | 'recents'
const BUTTONS: readonly SimulatorButton[] = ['home', 'lock', 'side', 'siri', 'volup', 'voldown', 'playpause', 'back', 'recents']

/**
 * The panel edge a touch starts on, as the iOS digitizer reports it (Indigo's edge field). iOS
 * recognises its system edge gestures from this flag, not from where the finger lands: MEASURED
 * (Xcode 27, iPhone 17 + iPad Pro): a swipe up from the very bottom without the flag only scrolled
 * the app; with 3 it went home. The values name PHYSICAL edges of the portrait panel — on an iPad
 * turned left, the home swipe (from the bottom of the turned picture, i.e. the panel's left edge)
 * was recognised with 2 and not with 1, 3 or 4; turned right, with 4. Top = 1 is inferred.
 */
export type TouchEdge = 0 | 1 | 2 | 3 | 4
/** How close to an edge (as a fraction of that side) a touch must go down to count as from it. */
export const TOUCH_EDGE_MARGIN = 0.025

/** The edge a touch going down at this PANEL point (0..1 portrait framebuffer) starts on. */
export function touchEdge(x: number, y: number): TouchEdge {
  const m = TOUCH_EDGE_MARGIN
  const candidates: Array<[number, TouchEdge]> = [
    [y, 1],
    [x, 2],
    [1 - y, 3],
    [1 - x, 4]
  ]
  let best: [number, TouchEdge] | null = null
  for (const c of candidates) if (c[0] <= m && (!best || c[0] < best[0])) best = c
  return best ? best[1] : 0
}

/**
 * An Android emulator's hardware buttons, as the W3C key names its gRPC interface maps to Android
 * keys. MEASURED (emulator 36.6.11): GoHome, GoBack and AppSwitch each did what the device's own
 * buttons do. iOS-only buttons have no entry and are refused.
 */
export const ANDROID_BUTTON_KEYS: Readonly<Partial<Record<SimulatorButton, string>>> = {
  home: 'GoHome',
  back: 'GoBack',
  recents: 'AppSwitch',
  lock: 'Power',
  side: 'Power',
  volup: 'AudioVolumeUp',
  voldown: 'AudioVolumeDown',
  playpause: 'MediaPlayPause'
}

/**
 * How far an Android emulator is turned for each orientation (the `orientation` input's value is
 * the iOS GSEvent number, shared by both platforms). MEASURED: z = 90 turns the device left — the
 * frames then arrive already turned, camera on the left — while touches stay in portrait panel
 * coordinates, so the node maps them exactly as it does for iOS.
 */
export const ANDROID_ROTATION_Z: Readonly<Record<number, number>> = { 1: 0, 2: 180, 3: 90, 4: -90 }

/** Whether a platform sends its frames already turned (Android) or always portrait (iOS, where the
 *  node turns the picture itself). */
export function picturePreRotated(p: SimulatorPlatform): boolean {
  return p === 'android'
}

export type SimulatorInput =
  /** `edge`: the panel edge the contact started on (see touchEdge); 0 / absent = none. */
  | { t: 'down' | 'move' | 'up'; x: number; y: number; edge?: TouchEdge }
  | { t: 'key'; usage: number; down: boolean }
  | { t: 'button'; name: SimulatorButton }
  | { t: 'display'; index: number }
  | { t: 'orientation'; value: number }

/** The only commands that reach the helper, re-built field by field (renderer input is untrusted
 *  in the Server Edition and the relay; the helper also clamps). */
export function normalizeSimulatorInput(raw: unknown): SimulatorInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.t) {
    case 'down':
    case 'move':
    case 'up': {
      const x = Number(r.x)
      const y = Number(r.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      const out: SimulatorInput = { t: r.t, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
      const edge = Number(r.edge)
      if (Number.isInteger(edge) && edge >= 1 && edge <= 4) out.edge = edge as TouchEdge
      return out
    }
    case 'key': {
      const usage = Number(r.usage)
      if (!Number.isInteger(usage) || usage < 0 || usage > 255 || typeof r.down !== 'boolean') return null
      return { t: 'key', usage, down: r.down }
    }
    case 'button':
      return BUTTONS.includes(r.name as SimulatorButton) ? { t: 'button', name: r.name as SimulatorButton } : null
    case 'orientation': {
      const value = Number(r.value)
      return Number.isInteger(value) && value >= 1 && value <= 4 ? { t: 'orientation', value } : null
    }
    case 'display': {
      const index = Number(r.index)
      return Number.isInteger(index) && index >= -1 && index < 16 ? { t: 'display', index } : null
    }
    default:
      return null
  }
}

/**
 * Where a pointer landed on the device screen, as a 0..1 ratio — or null when it is in the
 * letterbox around it. The frame is drawn `object-fit: contain` inside a box of `boxW × boxH`, so
 * the picture is centred with bars on two sides; offsets are measured from the box's top-left.
 */
export function pointerToScreenRatio(
  offsetX: number,
  offsetY: number,
  boxW: number,
  boxH: number,
  frameW: number,
  frameH: number
): { x: number; y: number } | null {
  if (boxW <= 0 || boxH <= 0 || frameW <= 0 || frameH <= 0) return null
  const scale = Math.min(boxW / frameW, boxH / frameH)
  const drawnW = frameW * scale
  const drawnH = frameH * scale
  const left = (boxW - drawnW) / 2
  const top = (boxH - drawnH) / 2
  const x = (offsetX - left) / drawnW
  const y = (offsetY - top) / drawnH
  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}

/**
 * Browser `KeyboardEvent.code` → USB HID keyboard usage (page 0x07), the codes the simulator's
 * keyboard service takes. Physical-key codes, not characters: the device applies its own layout
 * and Shift, exactly as a hardware keyboard attached to an iPhone does.
 */
export const HID_USAGE_BY_CODE: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < 26; i++) m[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i
  for (let i = 1; i <= 9; i++) m[`Digit${i}`] = 0x1e + (i - 1)
  m.Digit0 = 0x27
  Object.assign(m, {
    Enter: 0x28, NumpadEnter: 0x58, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
    Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
    Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
    CapsLock: 0x39, Delete: 0x4c, Home: 0x4a, End: 0x4d, PageUp: 0x4b, PageDown: 0x4e,
    ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
    ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
    ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7
  })
  for (let i = 1; i <= 12; i++) m[`F${i}`] = 0x3a + (i - 1)
  return m
})()

export function hidUsageForCode(code: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(HID_USAGE_BY_CODE, code) ? HID_USAGE_BY_CODE[code] : undefined
}

// ── Host API ───────────────────────────────────────────────────────────────────────────────────

export interface SimulatorDisplayInfo {
  index: number
  width: number
  height: number
  /** The device's own name for it: "LCD" (cover / only screen), "LCD-1" (a foldable's inner). */
  name: string
  /** simctl's screen id for it (`simctl io --display=<id>`), 0 when unknown. */
  screenID: number
  /** Device pixels per point, when known (an Android AVD's density / 160). */
  scale?: number
}

export type SimulatorStatusEvent =
  | { kind: 'ready' }
  | { kind: 'displays'; displays: SimulatorDisplayInfo[]; active: number; pinned: boolean }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'exited'; code: number | null; signal: string | null }

export interface SimulatorFrame {
  width: number
  height: number
  display: number
  /** The encoded picture (JPEG from the iOS helper, PNG from an Android emulator — see `mime`). */
  jpeg: Uint8Array
  /** Absent = JPEG. */
  mime?: 'image/png'
}

export type SimulatorStartResult = { ok: true } | { ok: false; error: string }

export interface SimulatorApi {
  /** Every iOS simulator and Android virtual device installed on this machine. */
  devices(refresh?: boolean): Promise<SimulatorDevicesResult>
  /** Boot a device (an Android one headless: the node is its screen). */
  boot(id: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Start streaming `udid` into this node (compiles the helper on first use). */
  start(nodeId: string, udid: string): Promise<SimulatorStartResult>
  stop(nodeId: string): Promise<void>
  /** Touch / key / button / display — validated again on the host. */
  input(nodeId: string, cmd: SimulatorInput): Promise<boolean>
  shutdown(udid: string): Promise<boolean>
  /** The ⋯ menu's device actions (simctl / simulator notifications). */
  action(udid: string, action: SimulatorAction): Promise<SimulatorActionResult>
  /** Settings the menu marks with ✓, and the location scenarios. */
  state(udid: string): Promise<SimulatorDeviceState>
  /** A full-resolution screenshot of a screen, to the Desktop, the clipboard, or for the canvas. */
  screenshot(udid: string, screenID: number, target: SimulatorCaptureTarget, name: string): Promise<SimulatorActionResult & { path?: string }>
  startRecording(udid: string, screenID: number, name: string): Promise<SimulatorActionResult>
  stopRecording(udid: string): Promise<SimulatorActionResult & { path?: string }>
  isRecording(udid: string): Promise<boolean>
  onFrame(nodeId: string, listener: (frame: SimulatorFrame) => void): () => void
  onStatus(nodeId: string, listener: (event: SimulatorStatusEvent) => void): () => void
}

/** A friendlier label for a display than the device's own ("LCD-1"). */
export function displayLabel(d: SimulatorDisplayInfo, all: readonly SimulatorDisplayInfo[]): string {
  if (all.length < 2) return 'Screen'
  // A foldable: the larger screen is the inner one.
  const largest = all.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
  return d.index === largest.index ? 'Inner' : 'Cover'
}

// ── Fitting the node to the screen ─────────────────────────────────────────────────────────────

export interface FitInput {
  /** The screen area's current size (layout px) and the node's chrome around it. */
  screenW: number
  screenH: number
  chromeW: number
  chromeH: number
  /** The picture's width / height, as shown (after rotation). */
  aspect: number
  /** Which side keeps its length: the longer one (a shape change — rotation, first frame), or the
   *  side the user just dragged (a hand resize). */
  by: 'long' | 'width' | 'height'
  minW: number
  minH: number
}

/** The node size whose screen area has exactly the picture's shape — no letterbox bars. */
export function fitNodeToScreen(f: FitInput): { width: number; height: number } {
  const long = Math.max(f.screenW, f.screenH)
  const screenW =
    f.by === 'width'
      ? f.screenW
      : f.by === 'height'
        ? f.screenH * f.aspect
        : f.aspect >= 1
          ? long
          : long * f.aspect
  const width = Math.max(f.minW, Math.round(screenW + f.chromeW))
  // A width clamped up to the minimum still gets a screen of the right shape.
  const height = Math.max(f.minH, Math.round((width - f.chromeW) / f.aspect + f.chromeH))
  return { width, height }
}

/** Which side a hand resize was about: the one that changed more, relative to where it started. */
export function draggedSide(before: { w: number; h: number }, after: { w: number; h: number }): 'width' | 'height' {
  const dw = Math.abs(after.w - before.w) / Math.max(1, before.w)
  const dh = Math.abs(after.h - before.h) / Math.max(1, before.h)
  return dw >= dh ? 'width' : 'height'
}

// ── The ⋯ menu: device actions ─────────────────────────────────────────────────────────────────

export type ContentSizeStep = 'increment' | 'decrement'
export type BatteryState = 'charging' | 'charged' | 'discharging'
export type PrivacyService =
  | 'all' | 'calendar' | 'contacts-limited' | 'contacts' | 'location' | 'location-always' | 'photos-add'
  | 'photos' | 'media-library' | 'microphone' | 'motion' | 'reminders' | 'siri'
const PRIVACY_SERVICES: readonly PrivacyService[] = [
  'all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add',
  'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri'
]

export type SimulatorAction =
  | { a: 'appearance'; value: 'light' | 'dark' }
  | { a: 'content-size'; value: ContentSizeStep }
  | { a: 'increase-contrast'; value: boolean }
  | { a: 'location-set'; lat: number; lon: number }
  | { a: 'location-run'; scenario: string }
  | { a: 'location-clear' }
  | { a: 'status-bar'; preset: 'clean' | 'clear' }
  | { a: 'status-bar'; preset: 'battery'; batteryLevel: number; batteryState: BatteryState }
  | { a: 'shake' }
  | { a: 'biometric'; kind: 'face' | 'touch'; op: 'enroll' | 'unenroll' | 'match' | 'nomatch' }
  | { a: 'open-url'; url: string }
  | { a: 'push'; bundleId: string; payload: string }
  | { a: 'privacy'; op: 'grant' | 'revoke' | 'reset'; service: PrivacyService; bundleId?: string }
  | { a: 'pasteboard'; dir: 'to-device' | 'to-mac' }
  /** Android: set the device clipboard to this text (⌘V then presses Ctrl+V there). */
  | { a: 'clipboard-set'; text: string }
  | { a: 'install'; path: string }
  | { a: 'add-media'; paths: string[] }
  | { a: 'restart' }
  | { a: 'erase' }
  | { a: 'open-devicehub' }

/** `text` is the device clipboard, for the Android "copy the device clipboard" action (core has no
 *  clipboard of its own, so the renderer writes it). */
export type SimulatorActionResult = { ok: true; message?: string; text?: string } | { ok: false; error: string }

/** Longest text the clipboard action carries (the same bound the relay uses for a paste). */
export const MAX_CLIPBOARD_TEXT = 64_000
export type SimulatorCaptureTarget = 'desktop' | 'clipboard' | 'canvas'

/** What the menu shows a ✓ for, and the location scenarios to offer. Parts that could not be read
 *  are absent — never guessed. */
export interface SimulatorDeviceState {
  appearance?: 'light' | 'dark'
  increaseContrast?: boolean
  contentSize?: string
  locationScenarios?: string[]
}

/** A bundle identifier: reverse-DNS, letters/digits/hyphen/dot. */
export const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const MAX_PUSH_BYTES = 4096 // APNs' own payload limit

function absPath(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length < 4096 && !CONTROL.test(v)
}

/** The only actions that reach `simctl`, rebuilt field by field. */
export function normalizeSimulatorAction(raw: unknown): SimulatorAction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.a) {
    case 'appearance':
      return r.value === 'light' || r.value === 'dark' ? { a: 'appearance', value: r.value } : null
    case 'content-size':
      return r.value === 'increment' || r.value === 'decrement' ? { a: 'content-size', value: r.value } : null
    case 'increase-contrast':
      return typeof r.value === 'boolean' ? { a: 'increase-contrast', value: r.value } : null
    case 'location-set': {
      const lat = Number(r.lat)
      const lon = Number(r.lon)
      return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { a: 'location-set', lat, lon }
        : null
    }
    case 'location-run':
      return typeof r.scenario === 'string' && r.scenario.trim() && r.scenario.length <= 100 && !CONTROL.test(r.scenario)
        ? { a: 'location-run', scenario: r.scenario.trim() }
        : null
    case 'location-clear':
      return { a: 'location-clear' }
    case 'status-bar':
      if (r.preset === 'clean' || r.preset === 'clear') return { a: 'status-bar', preset: r.preset }
      if (r.preset === 'battery') {
        const level = Number(r.batteryLevel)
        const state = r.batteryState
        if (!Number.isInteger(level) || level < 0 || level > 100) return null
        if (state !== 'charging' && state !== 'charged' && state !== 'discharging') return null
        return { a: 'status-bar', preset: 'battery', batteryLevel: level, batteryState: state }
      }
      return null
    case 'shake':
      return { a: 'shake' }
    case 'biometric':
      return (r.kind === 'face' || r.kind === 'touch') && (r.op === 'enroll' || r.op === 'unenroll' || r.op === 'match' || r.op === 'nomatch')
        ? { a: 'biometric', kind: r.kind, op: r.op }
        : null
    case 'open-url': {
      if (typeof r.url !== 'string' || r.url.length > 4096 || CONTROL.test(r.url)) return null
      // Any scheme an app might register (deep links), but it must BE a URL with a scheme.
      return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(r.url.trim()) ? { a: 'open-url', url: r.url.trim() } : null
    }
    case 'push': {
      if (typeof r.bundleId !== 'string' || !BUNDLE_ID.test(r.bundleId) || typeof r.payload !== 'string') return null
      if (new TextEncoder().encode(r.payload).length > MAX_PUSH_BYTES) return null
      try {
        const doc = JSON.parse(r.payload) as unknown
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
      } catch {
        return null
      }
      return { a: 'push', bundleId: r.bundleId, payload: r.payload }
    }
    case 'privacy': {
      if (r.op !== 'grant' && r.op !== 'revoke' && r.op !== 'reset') return null
      if (!PRIVACY_SERVICES.includes(r.service as PrivacyService)) return null
      if (r.bundleId !== undefined && (typeof r.bundleId !== 'string' || !BUNDLE_ID.test(r.bundleId))) return null
      // grant/revoke need an app; reset may be device-wide.
      if (r.op !== 'reset' && r.bundleId === undefined) return null
      return { a: 'privacy', op: r.op, service: r.service as PrivacyService, ...(r.bundleId ? { bundleId: r.bundleId as string } : {}) }
    }
    case 'pasteboard':
      return r.dir === 'to-device' || r.dir === 'to-mac' ? { a: 'pasteboard', dir: r.dir } : null
    case 'clipboard-set':
      // NUL is the one character a clipboard string cannot carry to the device.
      return typeof r.text === 'string' && r.text.length <= MAX_CLIPBOARD_TEXT && !r.text.includes('\u0000')
        ? { a: 'clipboard-set', text: r.text }
        : null
    case 'install':
      return absPath(r.path) ? { a: 'install', path: r.path } : null
    case 'add-media':
      return Array.isArray(r.paths) && r.paths.length > 0 && r.paths.length <= 50 && r.paths.every(absPath)
        ? { a: 'add-media', paths: r.paths as string[] }
        : null
    case 'restart':
      return { a: 'restart' }
    case 'erase':
      return { a: 'erase' }
    case 'open-devicehub':
      return { a: 'open-devicehub' }
    default:
      return null
  }
}

// ── "Is anyone getting my touches?" ─────────────────────────────────────────────────────────────
//
// A device takes input from its FIRST HID client only (measured on Xcode 27): while DeviceHub shows
// a device, our touches are dropped without an error, and the node keeps streaming frames, so it
// looks alive and ignores the user. Nothing reports the drop, so the node watches for its symptom:
// the helper sends a frame only when the screen changed, so a touch followed by no frame at all
// changed nothing. One such touch proves little (a tap on an inert spot changes nothing either), so
// the hint waits for several in a row, and any touch that IS answered starts the count again.

/** How long after a touch lifts the screen gets to change before the touch counts as unanswered. */
export const TOUCH_ANSWER_MS = 1500
/** Unanswered touches in a row before the node says something may be holding the input. */
export const UNANSWERED_TOUCHES_FOR_HINT = 3

export const INPUT_HELD_HINT =
  'Touches are not changing the screen. If DeviceHub is showing this simulator, it keeps the touch input: pick another device in DeviceHub or quit it.'

/** The count after one more touch, and whether the hint should now show. */
export function afterTouch(count: number, answered: boolean): { count: number; hint: boolean } {
  if (answered) return { count: 0, hint: false }
  const next = count + 1
  return { count: next, hint: next >= UNANSWERED_TOUCHES_FOR_HINT }
}
