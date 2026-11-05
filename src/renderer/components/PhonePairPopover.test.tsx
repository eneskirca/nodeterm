// @vitest-environment jsdom
//
// The quick-pair popover says what Settings → Phone says beside the QR: pairing is a direct request
// from the phone, so a phone on another network can only time out (a field report on 5G: "The
// computer didn't respond.").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PhonePairPopover } from './PhonePairPopover'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,QR' }))

let root: Root
let host: HTMLElement

function stubBridge(start: Record<string, unknown>): void {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(async () => ({ payload: '{"v":1}', sshOpen: true, ...start })),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      openRemoteLoginSettings: vi.fn()
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal: vi.fn() }
  }
}

async function open(): Promise<string> {
  act(() =>
    root.render(<PhonePairPopover anchor={{ right: 100, bottom: 40 }} onClose={() => undefined} onOpenSettings={() => undefined} />)
  )
  await act(async () => undefined)
  await act(async () => undefined)
  return document.body.textContent ?? ''
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('PhonePairPopover', () => {
  it('says beside the QR that this first pairing needs the same network', async () => {
    stubBridge({ sshKey: false, relayPlan: 'ok' })
    expect(await open()).toMatch(/same Wi-Fi network.*connects from anywhere/)
  })

  it('promises nothing about "anywhere" on a LAN-only code', async () => {
    stubBridge({ sshKey: true, relayPlan: 'off' })
    const text = await open()
    expect(text).toMatch(/same Wi-Fi network/)
    expect(text).not.toMatch(/connects from anywhere/)
  })

  it('has no network note while the QR is withheld', async () => {
    stubBridge({ sshKey: false, relayPlan: 'off' })
    expect(await open()).not.toMatch(/same Wi-Fi network/)
  })
})
