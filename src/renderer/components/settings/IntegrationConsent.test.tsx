// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSettings } from '../../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { integrationHostKey } from '@shared/agent-integrations'
import { IntegrationConsent } from './IntegrationConsent'
import { IntegrationSetupNotice } from './IntegrationSetupNotice'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const save = vi.fn(async () => {})
beforeEach(() => {
  vi.useFakeTimers()
  window.nodeTerminal = { settings: { save, integrationStatus: async () => ({ retained: [] }) } } as never
  useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); save.mockClear() })
it('shows setup for an existing user without consent and persists a decline', async () => {
  act(() => root.render(<><IntegrationSetupNotice onConfigure={() => {}} /><IntegrationConsent /></>))
  expect(host.textContent).toContain('Agent integrations are off until you choose')
  const decline = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Decline and clean up')!
  act(() => decline.click())
  expect(useSettings.getState().settings.agentIntegrations?.local?.claude).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(350) })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ agentIntegrations: { local: { claude: false } } }))
  expect(host.textContent).not.toContain('Agent integrations are off until you choose')
})
it('remote enable saves only the named host choice and leaves local consent absent', async () => {
  const connection = { user: 'u', host: 'remote', port: 2222 }
  act(() => root.render(<IntegrationConsent connection={connection} />))
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Enable integration')!.click())
  const consent = useSettings.getState().settings.agentIntegrations
  expect(consent?.local).toBeUndefined()
  expect(consent?.remote).toEqual({ [integrationHostKey(connection)]: { claude: true } })
  await act(async () => { await vi.advanceTimersByTimeAsync(350) })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ agentIntegrations: consent }))
})
