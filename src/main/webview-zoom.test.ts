import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { installWebviewZoom } from './webview-zoom'

type Handler = (event: { preventDefault(): void }, value: never) => void

function fakeContents(type = 'webview') {
  const handlers = new Map<string, Handler>()
  let level = 0
  const contents = {
    getType: () => type,
    getZoomLevel: () => level,
    setZoomLevel: vi.fn((next: number) => {
      level = next
    }),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler)
    })
  }
  return { contents, handlers }
}

describe('installWebviewZoom', () => {
  it('ignores non-webview contents', () => {
    const { contents } = fakeContents('window')
    expect(installWebviewZoom(contents as unknown as WebContents, false)).toBe(false)
    expect(contents.on).not.toHaveBeenCalled()
  })

  it('applies a wheel zoom request from the guest', () => {
    const { contents, handlers } = fakeContents()
    installWebviewZoom(contents as unknown as WebContents, false)
    const preventDefault = vi.fn()
    handlers.get('zoom-changed')?.({ preventDefault }, 'in' as never)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(contents.setZoomLevel).toHaveBeenCalledWith(1)
  })

  it('claims browser zoom shortcuts and leaves ordinary guest input alone', () => {
    const { contents, handlers } = fakeContents()
    installWebviewZoom(contents as unknown as WebContents, false)
    const shortcutEvent = { preventDefault: vi.fn() }
    handlers.get('before-input-event')?.(
      shortcutEvent,
      { type: 'keyDown', code: 'Minus', control: true, meta: false, shift: false, alt: false } as never
    )
    expect(shortcutEvent.preventDefault).toHaveBeenCalledOnce()
    expect(contents.setZoomLevel).toHaveBeenCalledWith(-1)

    const ordinaryEvent = { preventDefault: vi.fn() }
    handlers.get('before-input-event')?.(
      ordinaryEvent,
      { type: 'keyDown', code: 'KeyA', control: false, meta: false, shift: false, alt: false } as never
    )
    expect(ordinaryEvent.preventDefault).not.toHaveBeenCalled()
  })
})
