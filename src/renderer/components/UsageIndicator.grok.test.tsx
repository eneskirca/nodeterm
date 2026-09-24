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

async function open(system: ClaudeUsage, providers: ProviderUsage[] = []) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // No credentials, network, or running sessions: exercise the real component using bridge snapshots.
  vi.stubGlobal('nodeTerminal', { usage: {
    fetch: async () => system,
    providers: async () => providers,
    onUpdate: () => () => {}
  } })
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
}

describe('Grok billing diagnostics in the usage popover', () => {
  it.each([
    [{ reason: 'http', httpStatus: 401 }, 'Grok authentication failed (HTTP 401)'],
    [{ reason: 'http', httpStatus: 403 }, 'Grok authentication failed (HTTP 403)'],
    [{ reason: 'http', httpStatus: 429 }, 'Usage request rate limited (HTTP 429)'],
    [{ reason: 'http', httpStatus: 503 }, 'Grok returned HTTP 503'],
    [{ reason: 'http', httpStatus: 418 }, 'Usage request failed (HTTP 418)'],
    [{ reason: 'network' }, 'Could not reach Grok'],
    [{ reason: 'timeout' }, 'Usage request timed out'],
    [{ reason: 'invalid-response' }, 'Usage response could not be read']
  ] as const)('shows a safe, specific reason for %j', async (diagnostic, message) => {
    await open(snapshot('unavailable'), [{ provider: 'grok', account: null,
      status: 'error', limits: [], updatedAt: 0, diagnostics: [{ view: 'credits', ...diagnostic }] }])
    expect(host.querySelector('.usage-indicator')?.textContent).toContain('⚠')
    const text = host.querySelector('.usage-account')?.textContent
    expect(text).toContain('Credits view: ' + message)
    expect(text).not.toContain('expired')
    expect(text).not.toContain('No usage data.')
  })
  it.each(['unavailable', 'error'] as const)('keeps Claude %s distinct from a Grok failure', async (status) => {
    await open(snapshot(status), [{ provider: 'grok', account: null,
      status: 'error', limits: [], updatedAt: 0, diagnostics: [{ view: 'credits', reason: 'network' }] }])
    const body = host.querySelector('.usage-popover__body')!
    expect(body.textContent).toContain('Credits view: Could not reach Grok')
    expect(body.textContent).not.toContain('No usage data.')
    expect(body.textContent?.includes('Could not read usage.')).toBe(status === 'error')
  })
  it('shows recovered limits alongside the failed view', async () => {
    await open(snapshot('unavailable'), [{ provider: 'grok', account: null,
      status: 'ok', limits: [limit], updatedAt: 0, diagnostics: [
        { view: 'credits', reason: 'network' }
      ] }])
    expect(host.querySelectorAll('.usage-row')).toHaveLength(1)
    expect(host.querySelector('.usage-account')?.textContent).toContain('Credits view: Could not reach Grok')
  })
  it('keeps distinct reasons from both views visible', async () => {
    await open(snapshot('unavailable'), [{ provider: 'grok', account: null,
      status: 'error', limits: [], updatedAt: 0, diagnostics: [
        { view: 'credits', reason: 'http', httpStatus: 401 },
        { view: 'default', reason: 'timeout' }
      ] }])
    const text = host.querySelector('.usage-account')?.textContent
    expect(text).toContain('Credits view: Grok authentication failed (HTTP 401)')
    expect(text).toContain('Default view: Usage request timed out')
  })
  it('respects the hidden-provider setting even on failure', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hiddenUsageProviders: ['grok'] } })
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('nodeTerminal', { usage: {
      fetch: async () => snapshot('unavailable'),
      providers: async () => [{ provider: 'grok', status: 'error', limits: [],
        diagnostics: [{ view: 'credits', reason: 'network' }] }],
      onUpdate: () => () => {}
    } })
    await act(async () => root.render(<UsageIndicator />))
    expect(host.querySelector('.usage-indicator')).toBeNull()
  })
  it('supports older snapshots without diagnostics', async () => {
    await open(snapshot('unavailable'), [{ provider: 'grok', account: null,
      status: 'error', limits: [], updatedAt: 0 }])
    expect(host.querySelector('.usage-account')?.textContent).toContain('Could not read usage.')
  })
})
