// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage, type ProviderUsage, type UsageLimit } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

const limit = (over: Partial<UsageLimit>): UsageLimit => ({
  kind: 'session', group: 'session', usedPercent: 0, severity: null,
  resetsAt: null, windowMinutes: null, scopeLabel: null, isActive: false, ...over
})
const claude = (limits: UsageLimit[]): ClaudeUsage => ({
  status: limits.length ? 'ok' : 'unavailable', limits, session: null, weekly: null, email: null, updatedAt: 0
})
const row = (provider: string, limits: UsageLimit[]): ProviderUsage => ({
  provider, limits, account: null, updatedAt: 0, status: 'ok'
})
const cursor = row('cursor', [
  limit({ kind: 'monthly', usedPercent: 35 }),
  limit({ kind: 'monthly_scoped', scopeLabel: 'Auto', usedPercent: 33 }),
  limit({ kind: 'monthly_scoped', scopeLabel: 'API', usedPercent: 100 })
])

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, usagePercentMode: 'used' } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  vi.unstubAllGlobals()
})

async function pill(system: ClaudeUsage, providers: ProviderUsage[]): Promise<string> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('nodeTerminal', { usage: {
    fetch: async () => system,
    providers: async () => providers,
    onUpdate: () => () => {}
  } })
  await act(async () => root.render(<UsageIndicator />))
  // Providers load when the popover opens.
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
  return host.querySelector('.usage-pill__summary')?.textContent ?? ''
}

describe('usage pill: Cursor buckets', () => {
  it('shows all three Cursor numbers after the other segments', async () => {
    const text = await pill(claude([limit({ usedPercent: 92 })]),
      [row('grok', [limit({ usedPercent: 10 }), limit({ kind: 'weekly_all', usedPercent: 44 })]), cursor])
    expect(text).toBe('92% 5h·44% Grok·35% Cursor·33% auto·100% api')
  })

  it('leaves every other provider on its single worst limit, text unchanged', async () => {
    const text = await pill(claude([limit({ usedPercent: 92 }), limit({ kind: 'weekly_all', usedPercent: 44 })]), [
      row('grok', [limit({ usedPercent: 10 }), limit({ kind: 'weekly_all', usedPercent: 61 })]),
      row('kimi', [limit({ usedPercent: 7 })])
    ])
    expect(text).toBe('92% 5h·44% wk·61% Grok·7% Kimi')
  })

  it('leads with Cursor when it is the only provider, with no stray separator', async () => {
    expect(await pill(claude([]), [cursor])).toBe('35% Cursor·33% auto·100% api')
  })
})
