// @vitest-environment jsdom
// Issue #912: one block per provider that carries its own account, meters and action, with a
// failure as one line. These pin the grouping, not the styling.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage, type ProviderUsage, type UsageLimit } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

const limit = (kind: UsageLimit['kind'], usedPercent: number): UsageLimit => ({
  kind, group: kind === 'session' ? 'session' : 'weekly', usedPercent, severity: null,
  resetsAt: null, windowMinutes: 300, scopeLabel: null, isActive: false
})
const EMAIL = 'example@example.com'
const claude = (org?: string): ClaudeUsage => ({
  status: 'ok', limits: [limit('session', 5), limit('weekly', 71)], session: null, weekly: null,
  email: EMAIL, updatedAt: 0, ...(org ? { organization: { name: org } } : {})
})
const codex: ProviderUsage = { provider: 'codex', account: null, status: 'ok', limits: [limit('session', 74)], updatedAt: 0 }
const grokOk: ProviderUsage = { provider: 'grok', account: null, status: 'ok', limits: [limit('weekly', 1)], updatedAt: 0 }

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

async function open(system: ClaudeUsage, providers: ProviderUsage[], managed?: ClaudeUsage) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('nodeTerminal', { usage: {
    fetch: async (id?: string) => (id && managed ? managed : system),
    providers: async () => providers,
    onUpdate: () => () => {}
  } })
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector('.usage-indicator')!.dispatchEvent(
    new MouseEvent('mouseover', { bubbles: true })
  ))
}

const headings = (): string[] =>
  [...host.querySelectorAll('.usage-account__label')].map((el) => el.textContent ?? '')
const switchButton = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('.usage-popover__switch')
/** The block a provider's heading opens — its nearest enclosing grouping element. */
const blockOf = (heading: string): Element => {
  const el = [...host.querySelectorAll('.usage-account__label')].find((h) => h.textContent === heading)
  if (!el?.parentElement) throw new Error(`no block headed ${heading}`)
  return el.parentElement
}

describe('usage popover groups each provider into one block (issue #912)', () => {
  it('puts the Claude account inside the Claude block, not under a fourth peer heading', async () => {
    await open(claude('Acme'), [codex, grokOk])
    expect(headings()).toEqual(['Claude', 'Codex', 'Grok'])
    const block = blockOf('Claude')
    expect(block.textContent).toContain(EMAIL)
    expect(block.textContent).toContain('Organization: Acme')
    expect(block.querySelectorAll('.usage-row').length).toBeGreaterThanOrEqual(2)
    expect(host.textContent).not.toContain('Claude Account')
  })

  it('puts "Switch Claude account…" inside the Claude block, before any other provider', async () => {
    await open(claude(), [codex, grokOk])
    const btn = switchButton()
    expect(btn).not.toBeNull()
    expect(blockOf('Claude').contains(btn)).toBe(true)
    expect(blockOf('Grok').contains(btn)).toBe(false)
    // Document order: the action is read before the Codex heading, never after Grok's rows.
    const codexHeading = [...host.querySelectorAll('.usage-account__label')].find((h) => h.textContent === 'Codex')!
    expect(btn!.compareDocumentPosition(codexHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the switch with the system account when managed accounts are listed', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, usagePercentMode: 'remaining',
      claudeAccounts: [{ id: 'work', label: 'Work', email: EMAIL, createdAt: 0 }] } })
    await open(claude(), [grokOk], claude())
    const blocks = [...host.querySelectorAll('.usage-popover__body > .usage-account')]
    const btn = switchButton()
    expect(btn).not.toBeNull()
    expect(blocks[0].contains(btn)).toBe(true)
    expect(blocks.slice(1).some((b) => b.contains(btn))).toBe(false)
  })

  it('prints an identical per-view failure once for the provider', async () => {
    await open(claude(), [{ provider: 'grok', account: null, status: 'error', limits: [], updatedAt: 0,
      diagnostics: [
        { view: 'credits', reason: 'http', httpStatus: 401 },
        { view: 'default', reason: 'http', httpStatus: 401 }
      ] }])
    const text = blockOf('Grok').textContent ?? ''
    expect(text.split('Grok authentication failed (HTTP 401)')).toHaveLength(2)
    expect(text).toContain('Credits view and Default view: Grok authentication failed (HTTP 401)')
  })

  it('still prints differing per-view failures separately', async () => {
    await open(claude(), [{ provider: 'grok', account: null, status: 'error', limits: [], updatedAt: 0,
      diagnostics: [
        { view: 'credits', reason: 'http', httpStatus: 401 },
        { view: 'default', reason: 'timeout' }
      ] }])
    const text = blockOf('Grok').textContent ?? ''
    expect(text).toContain('Credits view: Grok authentication failed (HTTP 401)')
    expect(text).toContain('Default view: Usage request timed out')
  })

  it('keeps the organization line, de-emphasising only a name derived from the email above it', async () => {
    await open(claude(`${EMAIL}'s Organization`), [codex])
    const org = host.querySelector('.usage-account__organization')
    expect(org?.textContent).toBe(`Organization: ${EMAIL}'s Organization`)
    expect(org?.classList.contains('usage-account__organization--derived')).toBe(true)
  })

  it('does not de-emphasise a real organization name', async () => {
    await open(claude('Acme Corp'), [codex])
    const org = host.querySelector('.usage-account__organization')
    expect(org?.textContent).toBe('Organization: Acme Corp')
    expect(org?.classList.contains('usage-account__organization--derived')).toBe(false)
  })
})
