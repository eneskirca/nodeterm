// @vitest-environment jsdom
//
// Settings → Phone on a relay-only host (Windows, `sshKey: false`): the QR waits for the RELAY, not
// sshd; no "your phone connects with its own key" claim; a failed relay mint says nothing was
// paired; a timeout nothing reached points at the firewall. Platform comes from main's start
// result, so this runs on any runner.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PhoneSection } from './PhoneSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,QR' }))

type Done = (r: { ok: boolean; relay?: string; reason?: string; reached?: boolean }) => void
let root: Root
let host: HTMLElement
let fireDone: Done

function stubBridge(start: Record<string, unknown>): void {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(async () => ({ payload: '{"v":1}', sshOpen: false, ...start })),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn((cb: Done) => {
        fireDone = cb
        return () => undefined
      }),
      probeSsh: vi.fn(async () => false),
      openRemoteLoginSettings: vi.fn(),
      listDevices: vi.fn(async () => []),
      revokeDevice: vi.fn(),
      // The push webhook row mounts in this section too; no token is live here.
      webhookStatus: vi.fn(async () => ({ ok: true, value: null })),
      webhookEndpoint: vi.fn(async () => 'https://api.test')
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal: vi.fn() }
  }
}

async function startPairing(): Promise<string> {
  act(() => root.render(<PhoneSection isActive />))
  await act(async () => undefined)
  const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Start pairing')
  expect(btn).toBeTruthy()
  await act(async () => btn!.click())
  await act(async () => undefined)
  return host.textContent ?? ''
}

const qrShown = (): boolean => !!host.querySelector('img[alt="Pairing QR code"]')

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

describe('PhoneSection on a relay-only (Windows) host', () => {
  it('withholds the QR until remote access is on — and never asks for an SSH server', async () => {
    stubBridge({ sshKey: false, relayPlan: 'off' })
    const text = await startPairing()
    expect(qrShown()).toBe(false)
    expect(text).toMatch(/only through remote access/)
    expect(text).not.toMatch(/OpenSSH|Remote Login|SSH server/)
  })

  it('shows the QR with sshd down once the relay will be minted, and explains the missing key', async () => {
    stubBridge({ sshKey: false, relayPlan: 'ok', windowsKeyFile: 'administrators' })
    const text = await startPairing()
    expect(qrShown()).toBe(true)
    expect(text).toMatch(/installs no SSH key/)
    expect(text).toMatch(/administrators_authorized_keys/)
  })

  it('does not claim a key-based connection once paired', async () => {
    stubBridge({ sshKey: false, relayPlan: 'ok' })
    await startPairing()
    await act(async () => fireDone({ ok: true, relay: 'ok' }))
    expect(host.textContent).toMatch(/through remote access/)
    expect(host.textContent).not.toMatch(/connect with its own key/)
  })

  it('says nothing was paired when the relay mint failed', async () => {
    stubBridge({ sshKey: false, relayPlan: 'ok' })
    await startPairing()
    await act(async () => fireDone({ ok: false, reason: 'relay-failed', reached: true }))
    expect(host.textContent).toMatch(/nothing was paired/)
  })

  it('points at the firewall when the phone never reached this computer', async () => {
    stubBridge({ sshKey: false, relayPlan: 'ok' })
    await startPairing()
    await act(async () => fireDone({ ok: false, reason: 'timeout', reached: false }))
    expect(host.textContent).toMatch(/Windows Defender Firewall/)
  })
})

describe('PhoneSection on an SSH host is unchanged', () => {
  it('still withholds the QR while sshd is down, relay or not', async () => {
    stubBridge({ sshKey: true, relayPlan: 'ok' })
    const text = await startPairing()
    expect(qrShown()).toBe(false)
    expect(text).toMatch(/is off, so your phone wouldn/)
  })

  it('treats a start result with no sshKey field (older main) as an SSH host', async () => {
    stubBridge({ relayPlan: 'ok' })
    await startPairing()
    expect(qrShown()).toBe(false)
  })
})
