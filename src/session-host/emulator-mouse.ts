import type { Terminal } from '@xterm/headless'

type MouseEncoding = 'DEFAULT' | 'SGR' | 'SGR_PIXELS'
type MouseProtocol = 'NONE' | 'X10' | 'VT200' | 'DRAG' | 'ANY'
interface MouseEvent {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}
interface MouseState {
  protocol: MouseProtocol
  encoding: MouseEncoding
  restrict: (event: MouseEvent) => boolean
  encode: (event: MouseEvent) => string
}

const tracking: Record<MouseProtocol, string> = {
  NONE: 'none', X10: 'x10', VT200: 'vt200', DRAG: 'drag', ANY: 'any'
}
const encodings = new Set<string>(['DEFAULT', 'SGR', 'SGR_PIXELS'])

/**
 * The installed headless 6.0 CoreMouseService (and renderer 5.5) stores tracking
 * and coordinate encoding separately. Pin this narrow private seam: the public
 * modes API exposes only tracking. Unknown shape/state must not become SGR input.
 * See the package's CoreMouseService/InputHandler source map, not a byte guess.
 */
export function mouseState(term: Terminal): MouseState | undefined {
  try {
    const service = (term as unknown as { _core?: { coreMouseService?: {
      activeProtocol?: unknown
      activeEncoding?: unknown
      _protocols?: Record<string, { restrict?: unknown }>
      _encodings?: Record<string, unknown>
    } } })._core?.coreMouseService
    const protocol = service?.activeProtocol
    const encoding = service?.activeEncoding
    if (typeof protocol !== 'string' || !Object.hasOwn(tracking, protocol) ||
        typeof encoding !== 'string' || !encodings.has(encoding) ||
        tracking[protocol as MouseProtocol] !== term.modes.mouseTrackingMode) return undefined
    const restrict = service?._protocols?.[protocol]?.restrict
    const encode = service?._encodings?.[encoding]
    if (typeof restrict !== 'function' || typeof encode !== 'function') return undefined
    return { protocol: protocol as MouseProtocol, encoding: encoding as MouseEncoding,
      restrict: restrict as MouseState['restrict'], encode: encode as MouseState['encode'] }
  } catch {
    return undefined
  }
}

/** Pure encoding, no triggerMouseEvent, onData/onBinary, or native write side effects. */
export function wheelReport(state: MouseState, up: boolean): string | undefined {
  try {
    // triggerMouseEvent increments zero-based cells before calling its encoder.
    // Pixel coordinates remain zero-based (MouseService.getMouseReportCoords).
    const event: MouseEvent = { col: 1, row: 1, x: 0, y: 0, button: 4,
      action: up ? 0 : 1, ctrl: false, alt: false, shift: false }
    if (state.restrict(event) !== true) return undefined
    const report = state.encode(event)
    return typeof report === 'string' && report.length > 0 && report.length <= 64 ? report : undefined
  } catch {
    return undefined
  }
}

/** Restore encoding even if tracking is off; the addon only restores tracking. */
export function mouseEncodingRestore(state: MouseState): string {
  if (state.encoding === 'SGR') return '\x1b[?1006h'
  if (state.encoding === 'SGR_PIXELS') return '\x1b[?1016h'
  return '\x1b[?1006l\x1b[?1016l'
}
