// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PairedDevice } from '@shared/types'
import { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } from '@renderer/lib/links'
import { PhoneSection } from './PhoneSection'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ANDROID: PairedDevice = { id: 'dev-b', name: 'Android', pairedAt: 1_700_000_000_000, lastSeenAt: 0 }

let root: Root
let host: HTMLElement
let openExternal: ReturnType<typeof vi.fn>

beforeEach(() => {
  openExternal = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      openRemoteLoginSettings: vi.fn(),
      listDevices: vi.fn(async () => [ANDROID]),
      revokeDevice: vi.fn(),
      webhookStatus: vi.fn(async () => ({ ok: true, value: null })),
      webhookEndpoint: vi.fn(async () => 'https://api.test')
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('PhoneSection copy is platform-neutral', () => {
  it('speaks of the nodeterm mobile app, lists the phone by the name it sent, links both stores', async () => {
    act(() => root.render(<PhoneSection isActive />))
    await act(async () => undefined) // mount-time listDevices
    const text = host.textContent ?? ''
    expect(text).toContain('Pair the nodeterm mobile app')
    expect(text).not.toContain('nodeterm iOS app')
    expect(text).toContain('Android') // the device list shows the phone-sent name
    const button = (label: string): HTMLButtonElement | undefined =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
    const store = button('Get it on the App Store')
    expect(store).toBeTruthy()
    act(() => store!.click())
    expect(openExternal).toHaveBeenCalledWith(IOS_APP_STORE_URL)
    const play = button('Get it on Google Play')
    expect(play).toBeTruthy()
    act(() => play!.click())
    expect(openExternal).toHaveBeenCalledWith(ANDROID_PLAY_STORE_URL)
  })
})
