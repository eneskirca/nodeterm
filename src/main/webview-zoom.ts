import type { WebContents } from 'electron'
import { applyWebviewZoom, webviewZoomShortcut } from '../shared/webview-zoom'

/** Installs browser-like page zoom only on Electron webview guests. */
export function installWebviewZoom(contents: WebContents, isMac: boolean): boolean {
  if (contents.getType() !== 'webview') return false

  contents.on('zoom-changed', (event, direction) => {
    event.preventDefault()
    applyWebviewZoom(contents, direction)
  })

  contents.on('before-input-event', (event, input) => {
    const action = webviewZoomShortcut(input, isMac)
    if (!action) return
    event.preventDefault()
    applyWebviewZoom(contents, action)
  })

  return true
}
