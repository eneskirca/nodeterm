// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountsSection } from './AccountsSection'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

let root: Root
let host: HTMLDivElement
let acknowledge: () => void
let rejectSave: (error: Error) => void
let published: Settings
let launched: string[]
let listener: EventListener
const waitLogin = vi.fn()
const save = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  published = { ...DEFAULT_SETTINGS }
  launched = []
  waitLogin.mockReset().mockResolvedValue({ email: 'fixture@example.test' })
  save.mockReset().mockImplementation((settings: Settings) => new Promise<void>((resolve, reject) => {
    acknowledge = () => { published = settings; resolve() }
    rejectSave = reject
  }))
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    settings: { save },
    codexAccounts: {
      add: async () => ({ id: 'fixture-codex', home: '/fixture/managed' }),
      systemIdentity: async () => null,
      identity: async () => null,
      waitLogin
    }
  }
  listener = ((event: CustomEvent<{ accountId: string }>) => {
    // The agent-less PTY resolves its provider from MAIN's list, not the renderer's store.
    const id = event.detail.accountId
    launched.push(published.codexAccounts.some((a) => a.id === id) ? id : 'SYSTEM')
  }) as EventListener
  window.addEventListener('nodeterm:add-codex-account-login', listener)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AccountsSection isActive />))
})

afterEach(async () => {
  act(() => root.unmount())
  window.removeEventListener('nodeterm:add-codex-account-login', listener)
  host.remove()
  // Drain the pending identity update's ordinary coalesced save before leaving jsdom.
  save.mockResolvedValue(undefined)
  await useSettings.getState().flush()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function add(): Promise<void> {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add Codex account')!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}

describe('managed Codex login settings barrier (#683)', () => {
  it('waits for main to know the account before launching, then clears pending after identity capture', async () => {
    await add()
    expect(launched).toEqual([])
    expect(save).toHaveBeenCalledTimes(1)
    expect(waitLogin).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(launched).toEqual([])
    await act(async () => { acknowledge() })
    expect(launched).toEqual(['fixture-codex'])
    expect(waitLogin).toHaveBeenCalledWith('fixture-codex')
    expect(useSettings.getState().settings.codexAccounts[0]).toMatchObject({
      id: 'fixture-codex', email: 'fixture@example.test', pending: false
    })
  })

  it('does not launch or poll when publishing the account fails', async () => {
    await add()
    await act(async () => rejectSave(new Error('fixture write failure')))
    expect(launched).toEqual([])
    expect(waitLogin).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Could not set up the Codex account.')
  })
})
