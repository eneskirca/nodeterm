// @vitest-environment jsdom
//
// Settings → Privacy is where the user learns what the telemetry toggle sends. The open-project
// count rides /v1/check only while this toggle is on (core/check.ts), so the row must say so —
// and say it is a number only — before the first count is ever sent (spec §9).
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
  'Lets nodeterm contact api.nodeterm.dev for Pro and your free-project allowance only. Telemetry and the announcement feed stay off.'

function consentSwitch(): HTMLButtonElement | null {
  return host.querySelector(`button[role="switch"][aria-label="${CONSENT_LABEL}"]`)
}

describe('Privacy → telemetry row', () => {
  it('names the open-project count in its label', async () => {
    expect(await renderSection()).toContain('Send anonymous usage data (version/OS, open-project count)')
  })

  it('says the count is a number only, and how to fully disable', async () => {
    expect(await renderSection()).toContain(
      'No personal data; client IP is never stored. Used to see which versions are in use and how many projects people keep open (a number only — never names, paths or hosts). A lighter anonymous install count runs regardless; fully disable with the DO_NOT_TRACK environment variable.'
    )
  })

  it('says a one-way hash of the hardware id is used if the free-project limit is reached', async () => {
    // Spec §6: the machine hash is a new stable identifier, so the privacy copy names it — appended
    // to the same description, after the DO_NOT_TRACK sentence.
    expect(await renderSection()).toContain(
      'fully disable with the DO_NOT_TRACK environment variable. If you reach the free-project limit, nodeterm checks your allowance with a one-way hash of this computer\'s hardware id, so the allowance stays with this machine.'
    )
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
    // Off by default: no consent until the user gives it.
    expect(consentSwitch()?.getAttribute('aria-checked')).toBe('false')
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
