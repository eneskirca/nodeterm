// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ClaudeUsage } from '@shared/types'
import { useSettings } from '../state/settings'
import { UsageIndicator } from './UsageIndicator'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
let system: ClaudeUsage
let managed: ClaudeUsage
const snapshot = (name?: string): ClaudeUsage => ({
  limits: [], session: null, weekly: null, email: 'same@example.test', updatedAt: Date.now(), status: 'ok',
  ...(name ? { organization: { name, rateLimitTier: 'default_raven' } } : {})
})
beforeEach(() => {
  system = snapshot('Personal')
  managed = snapshot('Team')
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: [] } })
  window.nodeTerminal = { usage: {
    fetch: vi.fn(async (id?: string) => id ? managed : system),
    refresh: vi.fn(async () => system),
    providers: vi.fn(async () => []), onUpdate: vi.fn(() => () => {})
  } } as unknown as typeof window.nodeTerminal
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})
async function open() {
  await act(async () => root.render(<UsageIndicator />))
  await act(async () => host.querySelector<HTMLButtonElement>('.usage-pill')!.click())
}
it('shows the active organization beside the system email and keeps the raw tier in the tooltip', async () => {
  await open()
  const row = host.querySelector('.usage-account')!
  expect(row.textContent).toContain('same@example.test')
  expect(row.textContent).toContain('Organization: Personal')
  expect(row.textContent).not.toContain('default_raven')
  expect(row.querySelector('.usage-account__organization')?.getAttribute('title')).toContain('Rate limit tier: default_raven')
})
it('keeps same-email organizations in separate account rows and prefers the fetched identity email', async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: [{ id: 'team', label: 'Work', email: 'stale@example.test', createdAt: 0 }] } })
  await open()
  const rows = [...host.querySelectorAll('.usage-account')]
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('Organization: Personal')
  expect(rows[0].textContent).not.toContain('Organization: Team')
  expect(rows[1].textContent).toContain('Organization: Team')
  expect(rows[1].textContent).toContain('same@example.test')
  expect(rows[1].textContent).not.toContain('stale@example.test')
})
it('keeps the email-only block when organization metadata is unavailable', async () => {
  system = snapshot()
  await open()
  expect(host.querySelector('.usage-account')?.textContent).toBe('Claude Accountsame@example.test')
  expect(host.querySelector('.usage-account__organization')).toBeNull()
})
it('shows an available organization even when no email was found', async () => {
  system.email = null
  await open()
  expect(host.querySelector('.usage-account')?.textContent).toContain('Organization: Personal')
})
