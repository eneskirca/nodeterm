// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage, type ProviderUsage, type UsageLimit } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

const limit: UsageLimit = {
  kind: 'session', group: 'session', usedPercent: 37, severity: null,
  resetsAt: null, windowMinutes: 300, scopeLabel: null, isActive: false
}
const claude: ClaudeUsage = {
  status: 'ok', limits: [limit], session: null, weekly: null, email: null, updatedAt: 0
}
const grokFailed: ProviderUsage = {
  provider: 'grok', account: null, status: 'error', limits: [], updatedAt: 0,
  diagnostics: [{ view: 'credits', reason: 'http', httpStatus: 401 }]
}
const grokRecovered: ProviderUsage = {
  provider: 'grok', account: null, status: 'ok', limits: [limit], updatedAt: 1
}

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

async function openWith(usage: Record<string, unknown>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('nodeTerminal', { usage: { fetch: async () => claude, onUpdate: () => () => {}, ...usage } })
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
}

async function clickRefresh() {
  const refresh = host.querySelector('button[title="Refresh usage"]') as HTMLButtonElement
  await act(async () => refresh.click())
}

it('⟳ on a local project also re-reads the other providers, past their debounce', async () => {
  // The service answers from its cache unless forced — the one path a stale 401 can clear on.
  const providers = vi.fn(async (force?: boolean) => [force ? grokRecovered : grokFailed])
  await openWith({ refresh: async () => claude, providers })
  expect(host.textContent).toContain('Grok authentication failed (HTTP 401)')

  await clickRefresh()

  expect(providers).toHaveBeenCalledWith(true)
  expect(host.textContent).not.toContain('Grok authentication failed (HTTP 401)')
})

it('a failed Claude read on ⟳ does not throw away the providers\' fresh answer', async () => {
  const providers = vi.fn(async (force?: boolean) => [force ? grokRecovered : grokFailed])
  await openWith({ refresh: async () => { throw new Error('boom') }, providers })
  expect(host.textContent).toContain('Grok authentication failed (HTTP 401)')

  await clickRefresh()

  expect(host.textContent).not.toContain('Grok authentication failed (HTTP 401)')
  expect(host.querySelector('button[title="Refresh usage"]')?.hasAttribute('disabled')).toBe(false)
})
