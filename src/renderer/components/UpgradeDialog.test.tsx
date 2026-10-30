// @vitest-environment jsdom
//
// The Pro upgrade prompt. Only live links open it today, yet its body never mentioned them, and it
// still promised "unlimited remote access from your phone" months after the relay quota was removed.
// The body is pinned verbatim, and it names unlimited open projects only while the free-tier limit
// is on (docs/project-limit.md: no "unlimited" claim the limit would contradict — and, inactive, no
// claim about a limit that does not exist).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { pinNeutralMachineNoun } from '@renderer/lib/testMachineNoun'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

// The project-limit store subscribes to `window.nodeTerminal.projectLimit.onChange` when it is
// created, so the bridge must exist before any import runs.
vi.hoisted(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectLimit: { state: vi.fn(), claim: vi.fn(), onChange: () => () => {} }
  }
})
// The real entitlement store pulls in the license bridge; the dialog only reads `isPremium` and
// calls `upgrade`.
vi.mock('../state/entitlement', async () => {
  const { create } = await import('zustand')
  return { useEntitlement: create(() => ({ isPremium: false, upgrade: async () => {} })) }
})

import { UpgradeDialog } from './UpgradeDialog'
import { useUpgradeGate } from '../state/upgradeGate'
import { useProjectLimit } from '../state/projectLimit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

pinNeutralMachineNoun()

const ACTIVE: ProjectLimitState = { active: true, pro: false, free: 5, allowance: null, dnt: false }

const INACTIVE_BODY =
  'Pro adds live links to a terminal (watch, chat, or let people type), 3 team seats to share this computer, the larger on-device dictation models, and nodeterm mobile Pro. Complete your purchase in the browser — Pro unlocks here automatically.'
const ACTIVE_BODY =
  'Pro adds unlimited open projects, live links to a terminal (watch, chat, or let people type), 3 team seats to share this computer, the larger on-device dictation models, and nodeterm mobile Pro. Complete your purchase in the browser — Pro unlocks here automatically.'

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useUpgradeGate.setState({ open: false, feature: '' })
  useProjectLimit.setState({ state: INACTIVE_PROJECT_LIMIT })
})

/** Open the dialog for a live link (the one feature that opens it) and return its two lines. */
function render(state: ProjectLimitState): string[] {
  useProjectLimit.setState({ state })
  useUpgradeGate.setState({ open: true, feature: 'Live links' })
  act(() => root.render(<UpgradeDialog />))
  // The dialog portals into document.body, not into `host`.
  return [...document.body.querySelectorAll('.confirm__msg')].map((p) => p.textContent ?? '')
}

describe('UpgradeDialog', () => {
  it('names the gated feature', () => {
    expect(render(INACTIVE_PROJECT_LIMIT)[0]).toBe('Live links is a Pro feature')
  })

  it('limit inactive: lists live links and dictation, and says nothing about projects', () => {
    const [, body] = render(INACTIVE_PROJECT_LIMIT)
    expect(body).toBe(INACTIVE_BODY)
    expect(body).toContain('live links')
    expect(body).not.toContain('unlimited open projects')
    expect(body).not.toContain('remote access')
  })

  it('limit active: leads with unlimited open projects, then the same list', () => {
    const [, body] = render(ACTIVE)
    expect(body).toBe(ACTIVE_BODY)
    expect(body).toContain('live links')
  })
})
