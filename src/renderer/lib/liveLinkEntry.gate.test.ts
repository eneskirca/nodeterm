// @vitest-environment jsdom
//
// The opener against the REAL Pro gate (state/upgradeGate + state/entitlement): a Server Edition
// tab and a relay tab never open the Upgrade dialog — not for a license layer the server does not
// have (R43), not for a peer's terminal (H4). The pure test (liveLinkEntry.test.tsx) pins the order
// with a fake gate; this one pins what the user actually sees.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveLinkAvailabilityFacts } from './liveLinkEntry'

type Gate = typeof import('../state/upgradeGate')
type Ent = typeof import('../state/entitlement')
let gate: Gate
let ent: Ent
let entry: typeof import('./liveLinkEntry')

beforeAll(async () => {
  // The entitlement store subscribes to `license.onChange` when it is created.
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { license: { onChange: () => () => {} } }
  gate = await import('../state/upgradeGate')
  ent = await import('../state/entitlement')
  entry = await import('./liveLinkEntry')
})

beforeEach(() => {
  gate.useUpgradeGate.setState({ open: false, feature: '' })
  ent.useEntitlement.setState({ isPremium: false })
})

const facts = (over: Partial<LiveLinkAvailabilityFacts>): LiveLinkAvailabilityFacts => ({
  serverEdition: false,
  source: 'local',
  activeLinks: 0,
  ...over
})

function open(f: LiveLinkAvailabilityFacts): { show: ReturnType<typeof vi.fn>; notice: ReturnType<typeof vi.fn> } {
  const show = vi.fn()
  const notice = vi.fn()
  entry.openLiveLink({ facts: () => f, requirePro: gate.requireProOr, show, notice }, { nodeId: 'n', title: 't', projectId: 'p' })
  return { show, notice }
}

describe('live-link entry points vs the real Pro gate', () => {
  it('Server Edition, not Pro: no Upgrade dialog, the R43 sentence instead', () => {
    const r = open(facts({ serverEdition: true }))
    expect(gate.useUpgradeGate.getState().open).toBe(false)
    expect(r.show).not.toHaveBeenCalled()
    expect(r.notice).toHaveBeenCalledWith(
      'Live links need a Pro license on this server — not available in the Server Edition yet'
    )
  })

  it('relay tab, not Pro: no Upgrade dialog, the relay sentence instead', () => {
    const r = open(facts({ source: 'relay' }))
    expect(gate.useUpgradeGate.getState().open).toBe(false)
    expect(r.notice).toHaveBeenCalledWith('Live links are created on the machine that runs this terminal.')
  })

  it('desktop, not Pro: the Upgrade dialog, naming the feature as ruled (R56)', () => {
    const r = open(facts({}))
    expect(gate.useUpgradeGate.getState()).toMatchObject({ open: true, feature: 'Sharing a live link' })
    expect(r.show).not.toHaveBeenCalled()
  })

  it('desktop, Pro: straight to the dialog', () => {
    ent.useEntitlement.setState({ isPremium: true })
    const r = open(facts({}))
    expect(gate.useUpgradeGate.getState().open).toBe(false)
    expect(r.show).toHaveBeenCalledTimes(1)
  })
})
