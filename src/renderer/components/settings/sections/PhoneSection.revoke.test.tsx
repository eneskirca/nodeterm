// @vitest-environment jsdom
//
// Settings → Phone, the Revoke button: which of the three revoke outcomes the user is TOLD about,
// and in which voice.
//   'skipped' → nothing. It is a normal state: a free-tier desktop holds no entitlement to revoke
//               with, or there was no device left to name. Warning there would tell a free user
//               their phone's Pro is stuck when it never had any of ours. (A phone paired before
//               we recorded its relay id is NOT this case — the revoke falls back to our own
//               pairing id and the server leg does run.)
//   'ok'      → a receipt, not silence: the phone keeps the pass it already holds for up to 7
//               days, and users who were told nothing filed that as "removal didn't work".
//   'failed'  → a warning that does not prescribe waiting, because a 403 never clears by waiting.
// Only a leg that actually failed may warn, and a failed one always must.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DeviceRevokeResult, PairedDevice } from '@shared/types'
import { PhoneSection } from './PhoneSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DEVICE: PairedDevice = {
  id: 'dev-a',
  name: 'Enes’ iPhone',
  pairedAt: 1_700_000_000_000,
  lastSeenAt: 0,
  relayDeviceId: 'phone-relay-1'
}

let root: Root
let host: HTMLElement
let revokeDevice: ReturnType<typeof vi.fn>

/**
 * The narrow slice of `window.nodeTerminal` this section touches on mount + revoke. A successful
 * local leg really does empty the list (the ordinary case: one paired phone), because that is what
 * the note has to survive — it renders beside a list that no longer has a row.
 */
function stubBridge(result: DeviceRevokeResult | Error): void {
  let devices: PairedDevice[] = [DEVICE]
  revokeDevice = vi.fn(async () => {
    if (result instanceof Error) throw result
    if (result.local) devices = []
    return result
  })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    pairing: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      onDone: vi.fn(() => () => undefined),
      probeSsh: vi.fn(async () => true),
      openRemoteLoginSettings: vi.fn(),
      listDevices: vi.fn(async () => devices),
      revokeDevice,
      // The push webhook row mounts in this section too; no token is live here.
      webhookStatus: vi.fn(async () => ({ ok: true, value: null })),
      webhookEndpoint: vi.fn(async () => 'https://api.test')
    },
    remoteHost: { setPhoneAccess: vi.fn() },
    shell: { openExternal: vi.fn() }
  }
}

function button(label: string): HTMLButtonElement {
  const el = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  )
  expect(el, `a rendered "${label}" button`).toBeTruthy()
  return el as HTMLButtonElement
}

/** Click Revoke → confirm → let the (async) revoke settle. Returns the section's visible text. */
async function revokeFlow(): Promise<string> {
  await act(async () => {
    button('Revoke').click()
  })
  await act(async () => {
    // The ConfirmDialog's own confirm button carries the same label; it portals onto body last.
    const confirms = [...document.body.querySelectorAll('button')].filter(
      (b) => b.textContent?.trim() === 'Revoke'
    )
    confirms[confirms.length - 1].click()
  })
  await act(async () => undefined)
  return host.textContent ?? ''
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

function mount(): void {
  act(() => root.render(<PhoneSection isActive />))
}

describe('PhoneSection revoke feedback', () => {
  it('says nothing when the server leg was skipped — there was nothing of ours to revoke', async () => {
    stubBridge({ local: true, server: 'skipped' })
    mount()
    await act(async () => undefined) // the mount-time listDevices

    const text = await revokeFlow()
    expect(revokeDevice).toHaveBeenCalledWith('dev-a')
    expect(text).not.toMatch(/Pro access/i)
    expect(text).not.toMatch(/try again/i)
    // Nor the 7-day receipt: there was no Pro of ours on that phone, so there is nothing that
    // ends in 7 days. An implementation that prints the receipt for every non-failure passes the
    // two assertions above.
    expect(text).not.toMatch(/7 days/i)
  })

  it('says WHEN the phone actually loses Pro on a clean revoke — removal is not instant', async () => {
    stubBridge({ local: true, server: 'ok' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/within 7 days/i)
    // A receipt, not a warning: nothing here asks the user to do anything.
    expect(text).not.toMatch(/try again/i)
    expect(text).not.toMatch(/Couldn’t/i)
  })

  it('warns that the phone kept its Pro when the server leg failed', async () => {
    stubBridge({ local: true, server: 'failed' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/Pro access/i)
    // 'failed' also covers a 403 ("not your row") and a 401, which no amount of waiting fixes —
    // so the copy must not promise that being back online is the fix.
    expect(text).not.toMatch(/back online/i)
    // And the retry it does offer must disclose its cost: pairing the phone again RESTORES its Pro.
    expect(text).toMatch(/pairing restores its Pro/i)
    expect(text).toMatch(/get in touch/i)
  })

  it('warns about the local removal when that is the leg that failed', async () => {
    stubBridge({ local: false, server: 'ok' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    // The device is still on this machine — saying "its Pro could not be revoked" would be a
    // different (and here untrue) story.
    expect(text).toMatch(/remove/i)
    expect(text).toMatch(/try again/i)
    expect(text).not.toMatch(/Pro access/i)
  })

  // The ordinary case is ONE paired phone, so the successful local leg empties the list — and the
  // warning has to outlive it. A note rendered inside the list's non-empty branch would vanish at
  // exactly the moment it is needed.
  it('keeps the server warning visible after the last device leaves the list', async () => {
    stubBridge({ local: true, server: 'failed' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toContain('No devices paired yet')
    expect(text).toMatch(/Pro access/i)
  })

  it('reports BOTH legs when both fail', async () => {
    stubBridge({ local: false, server: 'failed' })
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/Couldn’t remove/i)
    expect(text).toMatch(/Pro access/i)
    // The device is still on this machine, so the "Removed … from this machine" clause must not
    // appear beside the failure that says it was not removed.
    expect(text).not.toMatch(/Removed “/)
  })

  it('warns when the call itself never answered', async () => {
    stubBridge(new Error('E_UNSUPPORTED'))
    mount()
    await act(async () => undefined)

    const text = await revokeFlow()
    expect(text).toMatch(/try again/i)
  })
})
