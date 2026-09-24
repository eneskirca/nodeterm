// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZoomableWebview } from '@shared/webview-zoom'

const runtime = vi.hoisted(() => ({ browser: false }))
vi.mock('../bridge/runtime', () => ({ isBrowserRuntime: () => runtime.browser }))

import { WebviewZoomControls } from './WebviewZoomControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  runtime.browser = false
})

describe('WebviewZoomControls', () => {
  it('applies zoom out, reset, and zoom in to the mounted guest', () => {
    let level = 1
    const target: { current: ZoomableWebview | null } = {
      current: {
        getZoomLevel: () => level,
        setZoomLevel: (next: number) => {
          level = next
        }
      }
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<WebviewZoomControls target={target} />))

    const click = (label: string): void => {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
      expect(button).not.toBeNull()
      act(() => button?.click())
    }

    click('Zoom out')
    expect(level).toBe(0)
    click('Zoom in')
    expect(level).toBe(1)
    click('Reset page zoom to 100%')
    expect(level).toBe(0)

    act(() => root.unmount())
  })

  it('renders no Electron-only controls in the Server Edition browser', () => {
    runtime.browser = true
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<WebviewZoomControls target={createRef()} />))
    expect(host.querySelector('.webview-zoom')).toBeNull()
    act(() => root.unmount())
  })
})
