// @vitest-environment jsdom
//
// Settings → License, rendered. The pure copy is pinned in `renderer/lib/licenseCopy.test.ts`; what
// this file exists for is the wiring around it, where every defect in the final review round lived:
// which sentence lands beside which data, what a destructive button does before it does it, and
// whether a failed ACTION is reported as a failed READ.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { pinNeutralMachineNoun } from '@renderer/lib/testMachineNoun'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { LicenseDetail, LicenseStatus } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PRO: LicenseStatus = {
  tier: 'pro',
  active: true,
  expiresAt: null,
  termEndsAt: null,
  seats: 3,
  error: null
}
const FREE: LicenseStatus = {
  tier: null,
  active: false,
  expiresAt: null,
  termEndsAt: null,
  seats: 0,
  error: null
}
/** A healthy keygen read with room to spare. */
const KEYGEN: LicenseDetail = { key: 'NT-KEY-1', used: 2, seats: 3, source: 'keygen', error: null }

let root: Root
let host: HTMLElement
let detail: Mock<() => Promise<LicenseDetail>>
let releaseOthers: Mock<() => Promise<LicenseDetail>>
let deactivate: Mock<() => Promise<LicenseStatus>>
let activate: Mock<(key: string) => Promise<LicenseStatus>>
let writeText: Mock<(text: string) => void>
const onNavigate = vi.fn()

/**
 * The store subscribes to `license.onChange` at IMPORT time, so the bridge has to exist before the
 * module graph does — hence the reset + dynamic import, the same shape as `entitlement.test.ts`.
 * Returns the section already mounted with `status` applied, so the mount-time `loadDetail` effect
 * runs exactly as it does in the app.
 */
async function mount(
  status: LicenseStatus,
  read: LicenseDetail = KEYGEN,
  browser = false
): Promise<void> {
  vi.resetModules()
  if (browser) (await import('@renderer/bridge/runtime')).markBrowserRuntime()
  onNavigate.mockClear()
  detail = vi.fn(async () => read)
  releaseOthers = vi.fn(async () => ({ key: null, used: 1, seats: 3, source: null, error: null }))
  deactivate = vi.fn(async () => FREE)
  activate = vi.fn(async () => FREE)
  writeText = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    license: {
      getStatus: vi.fn(async () => status),
      onChange: vi.fn(() => () => undefined),
      // Indirected so a test can swap the resolved value AFTER mounting (the store captured the
      // bridge object at import time, not these mocks).
      detail: () => detail(),
      releaseOthers: () => releaseOthers(),
      deactivate,
      activate,
      upgrade: vi.fn(async () => status)
    },
    clipboard: { writeText }
  }
  const { useEntitlement } = await import('../../../state/entitlement')
  const { LicenseSection } = await import('./LicenseSection')
  await act(async () => {
    await useEntitlement.getState().hydrate()
  })
  await act(async () => {
    root.render(<LicenseSection isActive onNavigate={onNavigate} />)
  })
  await act(async () => undefined) // the mount-time detail read
}

/** Everything on screen, the portalled dialogs included. */
function screenText(): string {
  return document.body.textContent ?? ''
}

function click(label: string, from: ParentNode = document.body): void {
  const el = [...from.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(el, `a rendered "${label}" button`).toBeTruthy()
  ;(el as HTMLButtonElement).click()
}

/** The confirm dialog's own button, which portals onto body after everything else. */
function confirmDialog(label: string): void {
  const all = [...document.body.querySelectorAll('.confirm button')].filter(
    (b) => b.textContent?.trim() === label
  )
  expect(all.length, `a "${label}" button inside the confirm dialog`).toBeGreaterThan(0)
  ;(all[all.length - 1] as HTMLButtonElement).click()
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
  vi.unstubAllGlobals()
})


// See testMachineNoun.ts: the rendered copy names the machine, so the host OS is pinned.
pinNeutralMachineNoun()

describe('LicenseSection — the Pro line prints the subscription term, never the token TTL (#800)', () => {
  const WEEK_S = 7 * 24 * 60 * 60
  const APPLE: LicenseDetail = { key: null, used: 0, seats: 0, source: 'apple', error: null }
  /** The paragraph that carries the Pro status, read on its own so another line's date cannot pass for it. */
  const proLine = (): string =>
    [...document.body.querySelectorAll('p')].map((p) => p.textContent ?? '').find((t) => t.startsWith('Pro —')) ??
    ''

  it('a 7-day token expiry with no stated term shows NO date', async () => {
    // The reported screen: an App Store yearly subscriber, a token minted with the server's 7-day TTL.
    const tokenExp = Math.floor(Date.now() / 1000) + WEEK_S
    await mount({ ...PRO, expiresAt: tokenExp, termEndsAt: null }, APPLE)
    expect(proLine()).toBe('Pro — active.')
    expect(screenText()).not.toContain(new Date(tokenExp * 1000).toLocaleDateString())
    expect(screenText()).not.toMatch(/active until/)
  })

  it('a null term renders no date — never the epoch', async () => {
    await mount({ ...PRO, expiresAt: null, termEndsAt: null }, APPLE)
    expect(proLine()).toBe('Pro — active.')
    expect(screenText()).not.toContain(new Date(0).toLocaleDateString())
    expect(screenText()).not.toMatch(/1970|1969/)
  })

  it('renders the term when the server states one, and not the token date beside it', async () => {
    const tokenExp = Math.floor(Date.now() / 1000) + WEEK_S
    const term = Math.floor(Date.now() / 1000) + 363 * 24 * 60 * 60
    await mount({ ...PRO, expiresAt: tokenExp, termEndsAt: term }, APPLE)
    expect(proLine()).toBe(`Pro — active. Current term runs through ${new Date(term * 1000).toLocaleDateString()}.`)
    expect(screenText()).not.toContain(new Date(tokenExp * 1000).toLocaleDateString())
  })

  it('tells an App Store subscriber where the renewal is managed', async () => {
    await mount(PRO, APPLE)
    expect(screenText()).toMatch(/managed by Apple, not by nodeterm/)
    expect(screenText()).toMatch(/open the App Store on that phone/)
  })
})

describe('LicenseSection — a release that did not land', () => {
  it('reports the RELEASE, and keeps saying the truth about the license', async () => {
    await mount(PRO)
    expect(screenText()).toContain('2 of 3 devices in use')

    // The laptop lost wifi between opening Settings and pressing the button.
    releaseOthers.mockResolvedValue({ key: null, used: 0, seats: 0, source: null, error: 'offline' })
    await act(async () => click('Release other devices'))
    await act(async () => confirmDialog('Release others'))
    await act(async () => undefined)

    const text = screenText()
    // 1. The user is told about the thing they just pressed…
    expect(text).toMatch(/Could not confirm the release/)
    // …including that it may in fact have happened. "Nothing was changed" here sends them to a
    // retry that hits the 30-day throttle with their one release already spent.
    expect(text).toMatch(/may or may not/)
    // 2. …and is told nothing FALSE about the license. This is the shipped bug: the offline code
    // was merged onto `detail`, so the device-count line was replaced by "Could not read this
    // license right now" while the real key sat in the box directly above it.
    expect(text).not.toMatch(/Could not read this license/)
    expect(text).toContain('2 of 3 devices in use')
    expect((document.querySelector('input[readonly]') as HTMLInputElement).value).toBe('NT-KEY-1')
    // 3. …and the button is usable again, not stuck on "Releasing…".
    expect(text).toContain('Release other devices')
  })

  it('leaves the throttle refusal to the license sentence, with no second voice', async () => {
    await mount(PRO)
    releaseOthers.mockResolvedValue({
      key: null,
      used: 0,
      seats: 0,
      source: null,
      error: 'too_soon',
      retryAfterDays: 12
    })
    await act(async () => click('Release other devices'))
    await act(async () => confirmDialog('Release others'))
    await act(async () => undefined)

    const text = screenText()
    expect(text).toContain('You can release devices again in 12 days.')
    // The refusal rides `detail`; a release note beside it would print the same fact twice in two
    // different wordings.
    expect(text).not.toMatch(/Could not confirm the release/)
    expect(text).not.toMatch(/Could not release the other devices/)
  })

  it('clears the last failure when the release is tried again', async () => {
    await mount(PRO)
    releaseOthers.mockResolvedValue({ key: null, used: 0, seats: 0, source: null, error: 'offline' })
    await act(async () => click('Release other devices'))
    await act(async () => confirmDialog('Release others'))
    await act(async () => undefined)
    expect(screenText()).toMatch(/Could not confirm the release/)

    releaseOthers.mockResolvedValue({ key: null, used: 1, seats: 3, source: null, error: null })
    await act(async () => click('Release other devices'))
    await act(async () => confirmDialog('Release others'))
    await act(async () => undefined)

    // A stale warning over a release that just worked is its own false statement.
    expect(screenText()).not.toMatch(/Could not confirm the release/)
    expect(screenText()).toContain('1 of 3 devices in use')
  })
})

describe('LicenseSection — confirming the destructive actions', () => {
  it('does not release anything until the user confirms, and says what will be released', async () => {
    await mount(PRO)
    await act(async () => click('Release other devices'))

    // One click used to deactivate every other machine AND every paired phone, irreversibly for
    // 30 days, with nothing on screen saying so beforehand.
    expect(releaseOthers).not.toHaveBeenCalled()
    const dialog = screenText()
    expect(dialog).toMatch(/paired phone/)
    expect(dialog).toMatch(/once every 30 days/)
    expect(dialog).toMatch(/this computer keeps it/)

    await act(async () => confirmDialog('Cancel'))
    expect(releaseOthers).not.toHaveBeenCalled()
    expect(screenText()).not.toMatch(/once every 30 days/)

    await act(async () => click('Release other devices'))
    await act(async () => confirmDialog('Release others'))
    await act(async () => undefined)
    expect(releaseOthers).toHaveBeenCalledTimes(1)
  })

  it('warns to copy the key before deactivating, and deactivates only on confirm', async () => {
    await mount(PRO)
    await act(async () => click('Deactivate on this device'))

    // After deactivating, the detail read has no entitlement to authorize it — the key is
    // unrecoverable in-app, which is exactly the support queue this screen exists to end.
    expect(deactivate).not.toHaveBeenCalled()
    expect(screenText()).toMatch(/Copy your license key first/)

    await act(async () => confirmDialog('Deactivate'))
    expect(deactivate).toHaveBeenCalledTimes(1)
  })

  it('does not tell a license with no key to copy one', async () => {
    // An App Store entitlement: nothing to copy, so that sentence would be nonsense.
    await mount(PRO, { key: null, used: 0, seats: 0, source: 'apple', error: null })
    await act(async () => click('Deactivate on this device'))

    expect(screenText()).not.toMatch(/Copy your license key first/)
    expect(screenText()).toMatch(/Pro features stop here/)
  })
})

describe('LicenseSection — the key field and the paste-elsewhere line', () => {
  it('copies through the app clipboard channel and says it copied', async () => {
    await mount(PRO)
    await act(async () => click('Copy'))

    expect(writeText).toHaveBeenCalledWith('NT-KEY-1')
    expect(screenText()).toContain('Copied')
  })

  it('offers no key field at all when the stated source has none', async () => {
    await mount(PRO, { key: null, used: 0, seats: 0, source: 'apple', error: null })

    const text = screenText()
    // "not available" means "exists, could not be fetched" — beside a sentence that says there is
    // no key at all, the two halves of the first screen an App Store subscriber sees disagree.
    expect(text).not.toContain('not available')
    expect(text).not.toContain('License key')
    expect(document.querySelector('input[readonly]')).toBeNull()
    expect(text).toContain('comes from the App Store subscription on your paired phone')
  })

  it('stops inviting the user to paste the key elsewhere once the cap is full', async () => {
    await mount(PRO, { ...KEYGEN, used: 3, seats: 3 })

    const text = screenText()
    expect(text).toContain('All 3 devices are in use.')
    // The line used to render on `detail.key` alone — directly under that sentence. Following it
    // lands the user on `seat_limit` on the other Mac, which is where this whole task started.
    expect(text).not.toMatch(/paste this key/)
    // The key itself is still shown and copyable; it is the ADVICE that is wrong here.
    expect((document.querySelector('input[readonly]') as HTMLInputElement).value).toBe('NT-KEY-1')
  })

  it('still invites it while there is room', async () => {
    await mount(PRO)
    expect(screenText()).toMatch(/paste this key/)
  })
})

describe('LicenseSection — activation failures', () => {
  it('renders seat_limit as a way out, never as a code', async () => {
    await mount({ ...FREE, error: 'seat_limit' })

    const text = screenText()
    expect(text).not.toContain('seat_limit')
    expect(text).toContain('This license already has all its devices in use.')
    expect(text).toMatch(/Release other devices/)
  })

  it('renders an unknown reason as an apology with an action, not as a code', async () => {
    await mount({ ...FREE, error: 'gremlins' })

    const text = screenText()
    expect(text).not.toContain('gremlins')
    expect(text).toContain('Could not activate this key.')
  })
})


describe('LicenseSection — existing App Store purchase (#787)', () => {
  it('offers pairing before checkout and beside the key input without promising recovery', async () => {
    await mount(FREE)
    const messages = [...host.querySelectorAll('p')].filter((p) =>
      p.textContent?.includes('Already have Pro from the App Store?')
    )
    expect(messages).toHaveLength(2)
    expect(messages[0].closest('details')).toBeNull()
    expect(messages[1].closest('details')?.querySelector('input')).toBeTruthy()
    for (const message of messages) {
      expect(message.textContent).toContain('can unlock Pro')
      expect(message.textContent).toContain('Some purchases cannot be linked by pairing')
      expect(message.textContent).toContain('contact support before buying again')
    }
    await act(async () => click('Open Settings → Phone'))
    expect(onNavigate).toHaveBeenCalledWith('phone')
    expect(activate).not.toHaveBeenCalled()
    expect(window.nodeTerminal.license.upgrade).not.toHaveBeenCalled()
  })

  it('directs browser users to the desktop app instead of unsupported browser pairing', async () => {
    await mount(FREE, KEYGEN, true)
    expect(screenText()).toContain('In the desktop app, open Settings → Phone')
    expect(screenText()).toContain('Server Edition does not support this activation route')
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === 'Open Settings → Phone')
    ).toBe(false)
  })
})
