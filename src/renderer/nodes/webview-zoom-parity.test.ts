import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('webview zoom surface parity', () => {
  it('keeps the shared controls on web nodes and browser surfaces', () => {
    const webNode = source('./WebNode.tsx')
    const browserSurface = source('./BrowserSurface.tsx')
    expect(webNode).toContain('<WebviewZoomControls target={wvRef}')
    expect(browserSurface).toContain('<WebviewZoomControls target={ref}')
  })

  it('keeps browser nodes and the kanban modal on the shared BrowserSurface', () => {
    expect(source('./BrowserNode.tsx')).toContain('<BrowserSurface')
    expect(source('../components/kanban/CardModal.tsx')).toContain('<BrowserSurface')
  })
})
