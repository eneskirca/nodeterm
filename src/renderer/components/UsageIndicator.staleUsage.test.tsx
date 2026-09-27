// @vitest-environment jsdom
// A rate-limited (429) read keeps the last good Claude numbers (usage-service `keepLastGood`).
// The popover must say they are stale and why, and — with nothing kept — say "rate limited"
// instead of the generic "Could not read usage.".
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage, type UsageLimit } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

const NOW = Date.UTC(2026, 8, 27, 14, 16, 0)
const limit: UsageLimit = {
  kind: 'session', group: 'session', usedPercent: 37, severity: null,
  resetsAt: null, windowMinutes: 300, scopeLabel: null, isActive: false
}
const kept = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
  status: 'error', limits: [limit], session: null, weekly: null, email: null,
  updatedAt: NOW - 14 * 60_000,
  failure: { reason: 'rate-limited', at: NOW - 5_000, retryAt: NOW + 118_000 },
  ...over
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function open(system: ClaudeUsage, account?: ClaudeUsage) {
  useSettings.setState({ settings: {
    ...DEFAULT_SETTINGS, usagePercentMode: 'remaining',
    claudeAccounts: account ? [{ id: 'work', label: 'Work', createdAt: 0 }] : []
  } })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('nodeTerminal', { usage: {
    fetch: async (id?: string) => (id ? account : system),
    providers: async () => [],
    onUpdate: () => () => {}
  } })
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
}

const notices = (): string[] =>
  [...host.querySelectorAll('.usage-popover__stale')].map((n) => n.textContent ?? '')

describe('stale Claude usage', () => {
  it('single-account view: keeps the bars and says why they are old', async () => {
    await open(kept())
    expect(host.querySelectorAll('.usage-row')).toHaveLength(1)
    expect(host.querySelector('.usage-popover__empty')).toBeNull()
    expect(notices()).toEqual(['Rate limited — showing values from 14m ago, next try in 2m'])
    // The popover header keeps the age of the NUMBERS.
    expect(host.querySelector('.usage-popover__ago')?.textContent).toBe('Updated 14m ago')
    // The pill's warning mark names the reason on hover.
    expect(host.querySelector('.usage-pill [title]')?.getAttribute('title'))
      .toBe('Rate limited — showing values from 14m ago, next try in 2m')
  })

  it('multi-account view: each account row carries its own notice', async () => {
    await open(kept(), kept({ failure: { reason: 'error', at: NOW } }))
    expect(notices()).toEqual([
      'Rate limited — showing values from 14m ago, next try in 2m',
      'Could not refresh — showing values from 14m ago'
    ])
  })

  it('nothing kept: the empty line names the rate limit', async () => {
    await open(kept({ limits: [], updatedAt: NOW }))
    expect(host.querySelector('.usage-popover__empty')?.textContent).toBe('Rate limited — try again in 2m.')
    expect(notices()).toEqual([])
  })

  it('a fresh snapshot shows no notice', async () => {
    await open(kept({ status: 'ok', failure: undefined, updatedAt: NOW }))
    expect(notices()).toEqual([])
  })
})
