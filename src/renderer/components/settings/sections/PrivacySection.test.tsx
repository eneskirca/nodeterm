// @vitest-environment jsdom
//
// Settings → Privacy is where the user learns what the telemetry toggle sends. The open-project
// count rides /v1/check only while this toggle is on (core/check.ts), so the row must say so —
// and say it is a number only — before the first count is ever sent.
//
// While the free-tier project limit is off the section reads exactly as it did before the limit
// existed: the machine-hash sentence and the allowance wording appear only while it is on.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
/** What core answers `projectLimit.state()` with; the consent row reads `dnt` from it. */
let limitState: ProjectLimitState
let pushLimit: ((s: ProjectLimitState) => void) | null

beforeEach(() => {
  vi.resetModules()
  limitState = INACTIVE_PROJECT_LIMIT
  pushLimit = null
  // The project-limit store subscribes to `projectLimit.onChange` at IMPORT time, so the bridge has
  // to exist before the module graph does (the same shape as LicenseSection.test.tsx).
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectLimit: {
      state: async () => limitState,
      claim: vi.fn(),
      onChange: (listener: (s: ProjectLimitState) => void) => {
        pushLimit = listener
        return () => {}
      }
    }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (window as unknown as { nodeTerminal?: unknown }).nodeTerminal
})

/** Mount the section after the store has read core's state, the way the app's boot effect does. */
async function renderSection(): Promise<string> {
  const { useProjectLimit } = await import('../../../state/projectLimit')
  const { PrivacySection } = await import('./PrivacySection')
  await act(async () => {
    await useProjectLimit.getState().hydrate()
  })
  act(() => root.render(<PrivacySection isActive />))
  return host.textContent ?? ''
}

const CONSENT_LABEL = 'Allow license checks while DO_NOT_TRACK is set'
const CONSENT_DESCRIPTION =
  'Lets nodeterm contact api.nodeterm.dev for license checks only. Telemetry and the announcement feed stay off.'
const CONSENT_DESCRIPTION_ACTIVE =
  'Lets nodeterm contact api.nodeterm.dev for Pro and your free-project allowance only. Telemetry and the announcement feed stay off.'
/** The telemetry description as Release A shipped it — all of it while the limit is off. */
const TELEMETRY_DESCRIPTION =
  'No personal data; client IP is never stored. Used to see which versions are in use and how many projects people keep open (a number only — never names, paths or hosts). A lighter anonymous install count runs regardless; fully disable with the DO_NOT_TRACK environment variable.'
const MACHINE_HASH_SENTENCE =
  " If you reach the free-project limit, nodeterm checks your allowance with a one-way hash of this computer's hardware id (sent whether or not this switch is on), so the allowance stays with this machine."
const ACTIVE: ProjectLimitState = { ...INACTIVE_PROJECT_LIMIT, active: true }

/** The text the settings search sees for `query`: the section renders only rows that match. */
async function searchFor(query: string): Promise<string> {
  const { useProjectLimit } = await import('../../../state/projectLimit')
  const { PrivacySection } = await import('./PrivacySection')
  const { SettingsSearchContext } = await import('../context')
  await act(async () => {
    await useProjectLimit.getState().hydrate()
  })
  act(() =>
    root.render(
      <SettingsSearchContext.Provider value={query}>
        <PrivacySection isActive={false} />
      </SettingsSearchContext.Provider>
    )
  )
  return host.textContent ?? ''
}

function consentSwitch(): HTMLButtonElement | null {
  return host.querySelector(`button[role="switch"][aria-label="${CONSENT_LABEL}"]`)
}

describe('Privacy → telemetry row', () => {
  it('names the open-project count in its label', async () => {
    expect(await renderSection()).toContain('Send anonymous usage data (version/OS, open-project count)')
  })

  it('says the count is a number only, and how to fully disable', async () => {
    expect(await renderSection()).toContain(TELEMETRY_DESCRIPTION)
  })

  it('while the limit is off, the description is exactly the one before the limit existed', async () => {
    await renderSection()
    expect(host.querySelector('p')?.textContent).toBe(TELEMETRY_DESCRIPTION)
  })

  it('while the limit is on, names the one-way hash of the hardware id, sent whatever this switch says', async () => {
    // The machine hash is a stable identifier a claim sends, so the privacy copy names it — appended
    // to the same description, after the DO_NOT_TRACK sentence. It rides the claim, not the
    // telemetry toggle, and the sentence says so because it sits under that switch.
    limitState = ACTIVE
    expect(await renderSection()).toContain(TELEMETRY_DESCRIPTION + MACHINE_HASH_SENTENCE)
  })

  it('follows the limit switching on without a remount', async () => {
    await renderSection()
    expect(host.textContent).not.toContain(MACHINE_HASH_SENTENCE.trim())
    act(() => pushLimit!(ACTIVE))
    expect(host.textContent).toContain(TELEMETRY_DESCRIPTION + MACHINE_HASH_SENTENCE)
  })
})

describe('Privacy → license checks under DO_NOT_TRACK', () => {
  it('is absent when DO_NOT_TRACK is not set — there is nothing to consent to', async () => {
    const text = await renderSection()
    expect(text).not.toContain(CONSENT_LABEL)
    expect(consentSwitch()).toBeNull()
  })

  it('is shown, with its scope spelled out, when core reports DO_NOT_TRACK', async () => {
    limitState = { ...INACTIVE_PROJECT_LIMIT, dnt: true }
    const text = await renderSection()
    expect(text).toContain(CONSENT_LABEL)
    expect(text).toContain(CONSENT_DESCRIPTION)
    // While the limit is off nothing on the row speaks of it.
    expect(text).not.toMatch(/allowance|free-project/)
    // Off by default: no consent until the user gives it.
    expect(consentSwitch()?.getAttribute('aria-checked')).toBe('false')
  })

  it('names the free-project allowance only while the limit is on', async () => {
    limitState = { ...ACTIVE, dnt: true }
    const text = await renderSection()
    expect(text).toContain(CONSENT_DESCRIPTION_ACTIVE)
    expect(text).not.toContain(CONSENT_DESCRIPTION)
  })

  it('a search for the limit finds nothing while it is off, and the row once it is on', async () => {
    limitState = { ...INACTIVE_PROJECT_LIMIT, dnt: true }
    for (const q of ['allowance', 'projects']) expect(await searchFor(q)).not.toContain(CONSENT_LABEL)
    // The neutral words still find it.
    expect(await searchFor('license')).toContain(CONSENT_LABEL)

    limitState = { ...ACTIVE, dnt: true }
    for (const q of ['allowance', 'projects']) expect(await searchFor(q)).toContain(CONSENT_LABEL)
  })

  it('follows a pushed state change without a remount', async () => {
    await renderSection()
    expect(consentSwitch()).toBeNull()
    act(() => pushLimit!({ ...INACTIVE_PROJECT_LIMIT, dnt: true }))
    expect(consentSwitch()).not.toBeNull()
  })

  it('toggling it on writes licenseNetworkConsent: true', async () => {
    limitState = { ...INACTIVE_PROJECT_LIMIT, dnt: true }
    const { useSettings } = await import('../../../state/settings')
    const update = vi.fn()
    useSettings.setState({ update })
    await renderSection()
    act(() => consentSwitch()!.click())
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ licenseNetworkConsent: true })
  })

  it('reflects a consent already given, and toggling it off revokes it', async () => {
    limitState = { ...INACTIVE_PROJECT_LIMIT, dnt: true }
    const { useSettings } = await import('../../../state/settings')
    const update = vi.fn()
    useSettings.setState({ settings: { ...useSettings.getState().settings, licenseNetworkConsent: true }, update })
    await renderSection()
    expect(consentSwitch()?.getAttribute('aria-checked')).toBe('true')
    act(() => consentSwitch()!.click())
    expect(update).toHaveBeenCalledWith({ licenseNetworkConsent: false })
  })
})
