import type { RefObject } from 'react'
import { IconMinus, IconPlus } from './icons'
import { applyWebviewZoom, type ZoomableWebview } from '@shared/webview-zoom'
import { isBrowserRuntime } from '../bridge/runtime'

interface WebviewZoomControlsProps {
  target: RefObject<ZoomableWebview | null>
  disabled?: boolean
}

export function WebviewZoomControls({ target, disabled = false }: WebviewZoomControlsProps) {
  if (isBrowserRuntime()) return null

  const zoom = (action: 'in' | 'out' | 'reset'): void => {
    const webview = target.current
    if (!webview) return
    try {
      applyWebviewZoom(webview, action)
    } catch {
      // A webview exists before its guest is attached. The next click can retry once it is ready.
    }
  }

  return (
    <span className="webview-zoom" aria-label="Page zoom controls">
      <button
        className="webview-zoom__button"
        type="button"
        disabled={disabled}
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => zoom('out')}
      >
        <IconMinus />
      </button>
      <button
        className="webview-zoom__button webview-zoom__reset"
        type="button"
        disabled={disabled}
        title="Reset page zoom to 100%"
        aria-label="Reset page zoom to 100%"
        onClick={() => zoom('reset')}
      >
        100%
      </button>
      <button
        className="webview-zoom__button"
        type="button"
        disabled={disabled}
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => zoom('in')}
      >
        <IconPlus />
      </button>
    </span>
  )
}
