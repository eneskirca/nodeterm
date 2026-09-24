const ELECTRON_ZOOM_FACTOR_PER_LEVEL = 1.2
export const WEBVIEW_ZOOM_MIN_LEVEL = Math.log(0.5) / Math.log(ELECTRON_ZOOM_FACTOR_PER_LEVEL)
export const WEBVIEW_ZOOM_MAX_LEVEL = Math.log(3) / Math.log(ELECTRON_ZOOM_FACTOR_PER_LEVEL)

export type WebviewZoomAction = 'in' | 'out' | 'reset'

export interface ZoomableWebview {
  getZoomLevel(): number
  setZoomLevel(level: number): void
}

export interface WebviewZoomShortcutInput {
  type: string
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

export function nextWebviewZoomLevel(current: number, action: WebviewZoomAction): number {
  const level = Number.isFinite(current) ? current : 0
  if (action === 'reset') return 0
  const next = level + (action === 'in' ? 1 : -1)
  return Math.min(WEBVIEW_ZOOM_MAX_LEVEL, Math.max(WEBVIEW_ZOOM_MIN_LEVEL, next))
}

export function applyWebviewZoom(target: ZoomableWebview, action: WebviewZoomAction): number {
  const current = target.getZoomLevel()
  const next = nextWebviewZoomLevel(current, action)
  if (next !== current) target.setZoomLevel(next)
  return next
}

export function webviewZoomShortcut(
  input: WebviewZoomShortcutInput,
  isMac: boolean
): WebviewZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null
  const primary = isMac ? input.meta && !input.control : input.control && !input.meta
  if (!primary) return null
  // Equal is the physical +/- key on common layouts, so Shift is valid only for zooming in.
  if (input.code === 'Equal' || (!input.shift && input.code === 'NumpadAdd')) return 'in'
  if (input.shift) return null
  if (input.code === 'Minus' || input.code === 'NumpadSubtract') return 'out'
  if (input.code === 'Digit0' || input.code === 'Numpad0') return 'reset'
  return null
}
