// @vitest-environment jsdom
//
// Issue #643 — the "Share ~/.claude/skills with this account" switch. The rules pinned here are the
// two that cannot be seen from the core suites: the filesystem is reconciled BEFORE the flag is
// persisted (the launch sweep replays the flag, so a stored `true` whose links were never made
// would make the switch lie until the next boot), and a REMOTE account renders the switch disabled
// with the reason rather than hiding it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type ClaudeAccount, type ClaudeSkillShareResult } from '@shared/types'

const local: ClaudeAccount = { id: 'a1', label: 'work', createdAt: 0 }
const remote: ClaudeAccount = { id: 'a2', label: 'server', host: 'u@h', createdAt: 0 }

const ok = (over: Partial<ClaudeSkillShareResult> = {}): ClaudeSkillShareResult => ({
  linked: 2,
  unlinked: 0,
  shared: 2,
  occupied: 0,
  failed: 0,
  ...over
})

let setSkillSharing = vi.fn(async (_id: string, _on: boolean) => ok())

function renderSection(accounts: ClaudeAccount[]): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const switchFor = (host: HTMLElement, label: string): HTMLButtonElement => {
  const el = host.querySelector(`[aria-label="Share system skills with ${label}"]`)
  expect(el, `no skills switch for ${label}`).toBeTruthy()
  return el as HTMLButtonElement
}

const flagOf = (id: string): boolean | undefined =>
  useSettings.getState().settings.claudeAccounts.find((a) => a.id === id)?.shareSystemSkills

beforeEach(() => {
  document.body.innerHTML = ''
  setSkillSharing = vi.fn(async (_id: string, _on: boolean) => ok())
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: { setSkillSharing },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — share ~/.claude/skills', () => {
  it('reconciles the filesystem, then persists the flag, and reports the count', async () => {
    const { host, root } = renderSection([local])
    expect(flagOf('a1')).toBeUndefined()
    await act(async () => {
      switchFor(host, 'work').click()
    })
    expect(setSkillSharing).toHaveBeenCalledWith('a1', true)
    expect(flagOf('a1')).toBe(true)
    expect(host.textContent).toContain('Sharing 2 skills.')
    act(() => root.unmount())
  })

  it('does NOT persist the flag when the reconcile refused', async () => {
    setSkillSharing = vi.fn(async () => ok({ linked: 0, shared: 2, refused: 'same-directory' }))
    ;(window as unknown as { nodeTerminal: { claudeAccounts: unknown } }).nodeTerminal.claudeAccounts =
      { setSkillSharing }
    const { host, root } = renderSection([local])
    await act(async () => {
      switchFor(host, 'work').click()
    })
    expect(flagOf('a1')).toBeUndefined()
    expect(host.textContent).toContain('already points at ~/.claude/skills')
    act(() => root.unmount())
  })

  it('shows a remote account the switch DISABLED with the reason, never hidden', () => {
    const { host, root } = renderSection([remote])
    expect(switchFor(host, 'server').disabled).toBe(true)
    expect(host.textContent).toContain('Not available for accounts on an SSH host')
    act(() => root.unmount())
  })
})
