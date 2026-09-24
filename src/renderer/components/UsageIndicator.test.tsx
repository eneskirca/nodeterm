// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage, type ProviderUsage, type UsageLimit } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

const limit: UsageLimit = {
  kind: 'session', group: 'session', usedPercent: 37, severity: null,
  resetsAt: null, windowMinutes: 300, scopeLabel: null, isActive: false
}
const snapshot = (status: ClaudeUsage['status'], limits: UsageLimit[] = []): ClaudeUsage => ({
  status, limits, session: null, weekly: null, email: null, updatedAt: 0
})

let host: HTMLDivElement
let root: Root
let update: (u: ClaudeUsage) => void

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, usagePercentMode: 'remaining' } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  vi.unstubAllGlobals()
})

async function open(system: ClaudeUsage, account?: ClaudeUsage | 'pending', providers: ProviderUsage[] = []) {
  if (account) useSettings.setState({ settings: {
    ...DEFAULT_SETTINGS, usagePercentMode: 'remaining',
    claudeAccounts: [{ id: 'work', label: 'Work', createdAt: 0 }]
  } })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // No credentials, network, or running sessions: exercise the real component using bridge snapshots.
  vi.stubGlobal('nodeTerminal', { usage: {
    fetch: async (id?: string) => id
      ? account === 'pending' ? new Promise<ClaudeUsage>(() => {}) : account
      : system,
    providers: async () => providers,
    onUpdate: (listener: typeof update) => { update = listener; return () => {} }
  } })
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
}

describe('Claude usage failure readout', () => {
  it('distinguishes failed system and managed account reads from empty data', async () => {
    await open(snapshot('error'), snapshot('error'))
    expect(host.querySelectorAll('.usage-popover__empty')).toHaveLength(2)
    for (const row of host.querySelectorAll('.usage-popover__empty')) {
      expect(row.textContent).toBe('Could not read usage.')
    }
  })

  it.each(['ok', 'fetching', 'unavailable'] as const)('keeps the empty account wording for %s', async (status) => {
    await open(snapshot('ok', [limit]), snapshot(status))
    expect(host.querySelector('.usage-popover__empty')?.textContent).toBe('No usage data.')
  })

  it('keeps the loading pulse while the managed account has no snapshot', async () => {
    await open(snapshot('ok', [limit]), 'pending')
    expect(host.querySelector('.usage-popover__empty.usage-pill__pulse')?.textContent).toBe('···')
  })

  it('preserves stale limit bars for both system and managed accounts', async () => {
    await open(snapshot('ok', [limit]), snapshot('error', [limit]))
    await act(async () => update(snapshot('error', [limit])))
    expect(host.querySelectorAll('.usage-row')).toHaveLength(2)
    expect(host.querySelector('.usage-popover__empty')).toBeNull()
    for (const row of host.querySelectorAll('.usage-row')) expect(row.textContent).toContain('63%')
  })

  it('shows the failure without any managed accounts', async () => {
    await open(snapshot('error'))
    expect(host.querySelector('.usage-popover__empty')?.textContent).toBe('Could not read usage.')
  })

  it('still attributes the Claude failure when another provider has data', async () => {
    await open(snapshot('error'), undefined, [{ provider: 'codex', account: null, status: 'ok', limits: [limit], updatedAt: 0 }])
    expect(host.querySelector('.usage-popover__empty')?.textContent).toBe('Could not read usage.')
    expect(host.querySelector('.usage-popover__body > .usage-account__label')?.textContent).toBe('Claude')
    expect(host.querySelectorAll('.usage-row')).toHaveLength(1)
  })

  it('preserves stale bars in the single-account view', async () => {
    await open(snapshot('error', [limit]))
    expect(host.querySelectorAll('.usage-row')).toHaveLength(1)
    expect(host.querySelector('.usage-popover__empty')).toBeNull()
  })
})
