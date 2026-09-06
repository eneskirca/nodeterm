// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import type { CodexAccount } from '@shared/codex-account'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'

const account: ClaudeAccount = { id: 'a1', label: 'work', createdAt: 0 }

function renderSection(
  accounts: ClaudeAccount[],
  codexAccounts: CodexAccount[] = []
): { host: HTMLElement; root: Root } {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts, codexAccounts }
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

function swatch(host: HTMLElement, label: string, name: string): HTMLButtonElement {
  const group = host.querySelector(`[aria-label="Default node color for ${label}"]`)
  expect(group).toBeTruthy()
  const btn = Array.from(group!.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === name
  )
  expect(btn, `no swatch "${name}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

const colorOf = (id: string): string | undefined =>
  useSettings.getState().settings.claudeAccounts.find((a) => a.id === id)?.color

const codexColorOf = (id: string): string | undefined =>
  useSettings.getState().settings.codexAccounts.find((a) => a.id === id)?.color

beforeEach(() => {
  document.body.innerHTML = ''
  // The section also mounts the Codex-accounts panel, which hydrates the SSH server list and the
  // system Codex identity on mount — stubbed so those effects resolve instead of throwing on an
  // absent bridge member (the throw takes the whole section down with it, colors included).
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    // Every swatch click is a `useSettings.update()`, which schedules a real 300 ms coalesced
    // save. Whether that timer fires before the worker exits is pure timing — and when it does,
    // an absent `settings.save` throws INSIDE the timer, which vitest reports as an unhandled
    // error and exits 1 on even though every test passed. Stubbed so the file cannot poison a
    // longer run it happens to share a worker with.
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountsSection — default node color', () => {
  it('stores the picked color on the account', () => {
    const { host, root } = renderSection([account])
    act(() => {
      swatch(host, 'work', 'Node color #0a84ff').click()
    })
    expect(colorOf('a1')).toBe('#0a84ff')
    root.unmount()
  })

  it('clears the color back to the agent default', () => {
    const { host, root } = renderSection([{ ...account, color: '#0a84ff' }])
    act(() => {
      swatch(host, 'work', 'Default').click()
    })
    expect(colorOf('a1')).toBeUndefined()
    root.unmount()
  })

  it('marks the picked swatch as selected', () => {
    const { host, root } = renderSection([{ ...account, color: '#0a84ff' }])
    expect(swatch(host, 'work', 'Node color #0a84ff').getAttribute('aria-pressed')).toBe('true')
    expect(swatch(host, 'work', 'Node color #32d74b').getAttribute('aria-pressed')).toBe('false')
    expect(swatch(host, 'work', 'Default').getAttribute('aria-pressed')).toBe('false')
    root.unmount()
  })

  it('marks Default as selected while no color is set', () => {
    const { host, root } = renderSection([account])
    expect(swatch(host, 'work', 'Default').getAttribute('aria-pressed')).toBe('true')
    root.unmount()
  })

  it('colors one account without touching the other', () => {
    const other: ClaudeAccount = { id: 'a2', label: 'personal', createdAt: 0, color: '#ff453a' }
    const { host, root } = renderSection([account, other])
    act(() => {
      swatch(host, 'work', 'Node color #0a84ff').click()
    })
    expect(colorOf('a1')).toBe('#0a84ff')
    expect(colorOf('a2')).toBe('#ff453a')
    root.unmount()
  })

  // Codex accounts are managed the same way and bind to nodes through the same `data.accountId`,
  // so they carry the same swatch group — a machine with two Codex logins is exactly the case the
  // feature exists for. The rows render in their own machine panel, hence the separate lookup.
  it('stores the picked color on a Codex account', () => {
    const { host, root } = renderSection([], [{ id: 'c1', label: 'codex work' }])
    act(() => {
      swatch(host, 'codex work', 'Node color #32d74b').click()
    })
    expect(codexColorOf('c1')).toBe('#32d74b')
    root.unmount()
  })

  it('clears a Codex account’s color back to the agent default', () => {
    const { host, root } = renderSection([], [{ id: 'c1', label: 'codex work', color: '#32d74b' }])
    act(() => {
      swatch(host, 'codex work', 'Default').click()
    })
    expect(codexColorOf('c1')).toBeUndefined()
    root.unmount()
  })

  // One list must never write through the other: the two are keyed independently and an id can
  // legitimately appear in both.
  it('colors a Codex account without touching a Claude account of the same id', () => {
    const { host, root } = renderSection([{ ...account, id: 'x1' }], [{ id: 'x1', label: 'codex' }])
    act(() => {
      swatch(host, 'codex', 'Node color #32d74b').click()
    })
    expect(codexColorOf('x1')).toBe('#32d74b')
    expect(colorOf('x1')).toBeUndefined()
    root.unmount()
  })
})
