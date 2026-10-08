// @vitest-environment jsdom
//
// The Android link on both phone surfaces (Settings → Phone and the quick-pair popover).
//
// There is no store listing and no published APK: the link opens the repo's `android/` source
// folder. It sits beside an App Store link and after "Don't have the app yet?", so a bare
// "nodeterm for Android" reads as a download (audit A66). Until a signed release APK exists, the
// label must say it is source, and the URL must come from the one repository constant.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PhoneSection } from './settings/sections/PhoneSection'
import { PhonePairPopover } from './PhonePairPopover'
import { REPO_URL } from '@renderer/lib/bugReport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,QR' }))

let root: Root
let host: HTMLElement
let openExternal: ReturnType<typeof vi.fn>

function stubBridge(): void {
  openExternal = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(async () => ({ payload: '{"v":1}', sshOpen: true, sshKey: true, relayPlan: 'ok' })),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      openRemoteLoginSettings: vi.fn(),
      listDevices: vi.fn(async () => []),
      revokeDevice: vi.fn()
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal }
  }
}

/** The one button naming Android; clicking it must open the repo's `android/` folder. */
function androidLink(): HTMLButtonElement {
  const buttons = [...document.body.querySelectorAll('button')].filter((b) =>
    /Android/.test(b.textContent ?? '')
  )
  expect(buttons).toHaveLength(1)
  act(() => buttons[0].click())
  expect(openExternal).toHaveBeenCalledWith(`${REPO_URL}/tree/main/android`)
  return buttons[0]
}

beforeEach(() => {
  stubBridge()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('the Android app link says it is source, not an installable', () => {
  it('Settings → Phone', async () => {
    act(() => root.render(<PhoneSection isActive />))
    await act(async () => undefined)
    expect(androidLink().textContent).toMatch(/build from source/)
  })

  it('the quick-pair popover', async () => {
    act(() =>
      root.render(
        <PhonePairPopover
          anchor={{ right: 800, bottom: 40 }}
          onClose={() => undefined}
          onOpenSettings={() => undefined}
        />
      )
    )
    await act(async () => undefined)
    expect(androidLink().textContent).toMatch(/build from source/)
  })
})

describe('lib/links', () => {
  it('derives the Android link from REPO_URL instead of spelling the repository out again', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'links.ts'), 'utf8').replace(/\r\n/g, '\n')
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join('\n')
    expect(code).not.toMatch(/github\.com/)
  })
})
