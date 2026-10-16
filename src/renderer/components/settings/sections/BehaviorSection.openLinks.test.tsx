// @vitest-environment jsdom
//
// Settings → Behavior "Allow nodeterm:// links" is a desktop OS URL scheme. The Server Edition
// registers no scheme and its bridge stub refuses every link, so a browser tab must not offer a
// switch that does nothing — neither as a row nor as a settings-search hit.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ browser: false }))
vi.mock('@renderer/bridge/runtime', () => ({ isBrowserRuntime: () => flags.browser }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  vi.resetModules()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function renderSection(): Promise<string> {
  const { BehaviorSection } = await import('./BehaviorSection')
  act(() => root.render(<BehaviorSection isActive />))
  return host.textContent ?? ''
}

describe('Allow nodeterm:// links row', () => {
  it('is offered on the desktop', async () => {
    flags.browser = false
    expect(await renderSection()).toContain('Allow nodeterm:// links')
  })

  it('is hidden in a Server Edition browser tab', async () => {
    flags.browser = true
    expect(await renderSection()).not.toContain('Allow nodeterm:// links')
  })
})
