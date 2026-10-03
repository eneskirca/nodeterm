// @vitest-environment jsdom
//
// The consent UI (issue #744). What it must do: ask a NEW install once (and only once), tell a
// grandfathered install once, ask about an SSH host nobody answered for, and give Settings an
// Enable / Decline-and-clean-up per agent and per host. All it ever writes is the choice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/types'
import { INTEGRATION_AGENT_IDS, grandfatheredIntegrations, answerIntegrationPrompt } from '@shared/agent-integrations'
import { useSettings } from '../../state/settings'
import {
  HostIntegrationBanner,
  IntegrationGrandfatherNotice,
  IntegrationPromptBanner,
  IntegrationSettings
} from './IntegrationConsent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    integrations: { status: vi.fn(async () => ({ enabled: [], declined: [], retained: ['/h/.gemini/skills/x/SKILL.md'], vetoed: false })) }
  }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (el: React.JSX.Element) => act(() => root.render(el))
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement
const click = (b: HTMLElement) => act(() => b.click())
const consent = () => useSettings.getState().settings.agentIntegrations

describe('the first-run question', () => {
  it('is shown to a new install and "Enable all" records every agent enabled', () => {
    render(<IntegrationPromptBanner onChoose={() => {}} />)
    expect(host.querySelector('[data-testid="integration-prompt"]')).toBeTruthy()
    click(button('Enable all'))
    for (const a of INTEGRATION_AGENT_IDS) expect(consent()?.agents?.[a]).toBe('enabled')
    expect(host.querySelector('[data-testid="integration-prompt"]')).toBeNull()
  })

  it('"Not now" declines every agent, so it is asked ONCE', () => {
    render(<IntegrationPromptBanner onChoose={() => {}} />)
    click(button('Not now'))
    for (const a of INTEGRATION_AGENT_IDS) expect(consent()?.agents?.[a]).toBe('declined')
    expect(host.querySelector('[data-testid="integration-prompt"]')).toBeNull()
  })

  it('waits for settings to load (never asks over a record it has not read)', () => {
    useSettings.setState({ hydrated: false })
    render(<IntegrationPromptBanner onChoose={() => {}} />)
    expect(host.querySelector('[data-testid="integration-prompt"]')).toBeNull()
  })
})

describe('the grandfathered notice', () => {
  it('shows once and dismisses for good', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentIntegrations: grandfatheredIntegrations() } })
    render(<IntegrationGrandfatherNotice onOpenSettings={() => {}} />)
    expect(host.querySelector('[data-testid="integration-notice"]')).toBeTruthy()
    click(host.querySelector('button[aria-label="Dismiss"]') as HTMLElement)
    expect(consent()?.noticeDismissed).toBe(true)
    expect(consent()?.agents?.claude).toBe('enabled')
    expect(host.querySelector('[data-testid="integration-notice"]')).toBeNull()
  })
})

describe('the per-host question', () => {
  it('asks about an unanswered host once the first-run question is answered, and records the answer', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentIntegrations: answerIntegrationPrompt(['claude']) } })
    render(<HostIntegrationBanner hostKey="me@srv" />)
    click(button('Not on this host'))
    expect(consent()?.hosts?.['me@srv']).toBe('declined')
    expect(host.querySelector('[data-testid="host-integration-prompt"]')).toBeNull()
  })

  it('is not shown for a grandfathered install (its hosts keep working)', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentIntegrations: grandfatheredIntegrations() } })
    render(<HostIntegrationBanner hostKey="me@srv" />)
    expect(host.querySelector('[data-testid="host-integration-prompt"]')).toBeNull()
  })
})

describe('Settings → Agents', () => {
  it('has Enable / Decline & clean up per agent, and lists what the host kept', async () => {
    vi.useFakeTimers()
    try {
      useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agentIntegrations: answerIntegrationPrompt(['claude']) } })
      render(<IntegrationSettings />)
      for (const a of INTEGRATION_AGENT_IDS) expect(host.querySelector(`[data-testid="integration-row-${a}"]`)).toBeTruthy()
      const decline = host.querySelector('button[aria-label^="Turn off the Claude"]') as HTMLButtonElement
      click(decline)
      expect(consent()?.agents?.claude).toBe('declined')
      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })
      expect(host.querySelector('[data-testid="integration-retained"]')?.textContent).toContain('/h/.gemini/skills/x/SKILL.md')
    } finally {
      vi.useRealTimers()
    }
  })
})
