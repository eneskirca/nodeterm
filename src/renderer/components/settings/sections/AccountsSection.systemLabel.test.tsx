// @vitest-environment jsdom
//
// Both SYSTEM logins on this machine (`~/.claude`, `~/.codex`) are implicit — no account record —
// so their display name can only come from a setting. Each gets a renamable field on the local
// panel; what the field writes is the setting every picker and the phone mirror read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { useSshServers } from '../../../state/sshServers'
import { DEFAULT_SETTINGS } from '@shared/types'

let root: Root
let host: HTMLElement

function labelInput(ariaLabel: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`)
  expect(el, `the local panel must carry "${ariaLabel}"`).toBeTruthy()
  return el!
}

/** Drive a controlled input the way React sees the user typing. */
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    settings: { save: async () => {} },
    codexAccounts: { identity: vi.fn(async () => null), systemIdentity: vi.fn(async () => null) },
    claudeAccounts: {}
  }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  useSshServers.setState({ servers: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AccountsSection isActive />))
})

afterEach(async () => {
  act(() => root.unmount())
  host.remove()
  await useSettings.getState().flush()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  vi.unstubAllGlobals()
})

describe('AccountsSection — renaming the system logins', () => {
  it('writes the Claude system label to settings.systemAccountLabel', () => {
    const el = labelInput('System Claude account label')
    type(el, 'Work Mac')
    expect(useSettings.getState().settings.systemAccountLabel).toBe('Work Mac')
    expect(el.value).toBe('Work Mac')
  })

  it('writes the Codex system label to settings.systemCodexAccountLabel', () => {
    const el = labelInput('System Codex account label')
    type(el, 'Home codex')
    expect(useSettings.getState().settings.systemCodexAccountLabel).toBe('Home codex')
    expect(el.value).toBe('Home codex')
  })
})
