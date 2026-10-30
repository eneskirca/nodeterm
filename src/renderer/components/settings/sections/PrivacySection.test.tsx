// @vitest-environment jsdom
//
// Settings → Privacy is where the user learns what the telemetry toggle sends. The open-project
// count rides /v1/check only while this toggle is on (core/check.ts), so the row must say so —
// and say it is a number only — before the first count is ever sent (spec §9).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  const { PrivacySection } = await import('./PrivacySection')
  act(() => root.render(<PrivacySection isActive />))
  return host.textContent ?? ''
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
})
