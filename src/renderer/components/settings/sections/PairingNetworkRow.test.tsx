// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '@renderer/state/settings'
import { PhoneSection } from './PhoneSection'
import { SettingsSearchContext } from '../context'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('qrcode', () => ({ toDataURL: async (payload: string) => `data:image/png;base64,${payload}` }))

let root: Root
let container: HTMLElement
let networks = [{ interfaceName: 'wlan0', address: '192.168.1.42' }, { interfaceName: 'wg0', address: '10.7.0.2' }]
let persisted = ''
let save: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let list: ReturnType<typeof vi.fn>
let done: (result: { ok: boolean }) => void

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function mount(active = true, query = ''): Promise<void> {
  await act(async () => root.render(<SettingsSearchContext.Provider value={query}><PhoneSection isActive={active} /></SettingsSearchContext.Provider>))
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  expect(found, label).toBeTruthy()
  return found!
}
function select(): HTMLSelectElement { return container.querySelector('#phone-pairing-network')! }
async function choose(value: string): Promise<void> {
  await act(async () => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const qr = (): HTMLImageElement | null => container.querySelector('img[alt="Pairing QR code"]')

beforeEach(() => {
  networks = [{ interfaceName: 'wlan0', address: '192.168.1.42' }, { interfaceName: 'wg0', address: '10.7.0.2' }]
  persisted = ''
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true })
  save = vi.fn(async (settings: typeof DEFAULT_SETTINGS) => { persisted = settings.phonePairingInterface })
  start = vi.fn(async () => ({ payload: JSON.stringify({ v: 1, host: persisted || '192.168.1.42' }), sshOpen: true, relayPlan: 'off' }))
  stop = vi.fn(async () => undefined)
  list = vi.fn(async () => networks)
  window.nodeTerminal = {
    pairing: { listNetworks: list, start, stop, onDone: (callback: typeof done) => { done = callback; return () => {} },
      probeSsh: async () => true, listDevices: async () => [], revokeDevice: vi.fn(), openRemoteLoginSettings: vi.fn() },
    settings: { save }, remoteHost: { setPhoneAccess: vi.fn() }, shell: { openExternal: vi.fn() }
  } as unknown as typeof window.nodeTerminal
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Settings Phone pairing network', () => {
  it('shows Automatic and real adapter names/current addresses without claiming phone reachability', async () => {
    await mount()
    expect(select().value).toBe('')
    expect([...select().options].map((option) => option.text)).toEqual(['Automatic', 'wlan0 — 192.168.1.42', 'wg0 — 10.7.0.2'])
    expect(container.textContent).toContain('not a test of whether your phone can reach them')
  })

  it('loads and saves the visible network row reached through Settings search without selecting Phone navigation', async () => {
    await mount(false, 'network')
    expect(select()).not.toBeNull()
    expect(select().disabled).toBe(false)
    expect(list).toHaveBeenCalledTimes(1)
    await choose('wg0')
    expect(persisted).toBe('wg0')
    expect(start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Pairing network')
  })

  it('retires the owned pairing listener when Settings search hides Pair phone while its parent hook stays mounted', async () => {
    await mount(false, 'network')
    await act(async () => button('Start pairing').click())
    expect(qr()).not.toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
    await mount(false, 'appearance')
    expect(select()).toBeNull()
    expect(stop).toHaveBeenCalledTimes(1)
    await act(async () => done({ ok: true }))
    await mount(false, 'network')
    expect(qr()).toBeNull()
    expect(button('Start pairing')).toBeTruthy()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('saves the interface name while idle, without starting pairing', async () => {
    await mount()
    await choose('wg0')
    expect(persisted).toBe('wg0')
    expect(useSettings.getState().settings.phonePairingInterface).toBe('wg0')
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('preserves an unavailable saved choice instead of displaying or saving Automatic', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, phonePairingInterface: 'en9' } })
    await mount()
    expect(select().value).toBe('en9')
    expect(select().selectedOptions[0].text).toBe('en9 — unavailable')
    expect(container.textContent).toContain('No pairing address will be substituted')
    expect(save).not.toHaveBeenCalled()
  })

  it('retires and hides a waiting QR before saving, then regenerates only after the core save acknowledgement', async () => {
    await mount()
    await act(async () => button('Start pairing').click())
    expect(qr()).not.toBeNull()
    const held = deferred<void>()
    save.mockImplementationOnce(async (settings: typeof DEFAULT_SETTINGS) => { await held.promise; persisted = settings.phonePairingInterface })
    await choose('wg0')
    expect(qr()).toBeNull()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(persisted).toBe('')
    await act(async () => held.resolve())
    expect(start).toHaveBeenCalledTimes(2)
    expect(persisted).toBe('wg0')
    expect(qr()?.src).toContain('wg0')
  })

  it('keeps the old QR hidden and surfaces a failed save without restarting', async () => {
    await mount()
    await act(async () => button('Start pairing').click())
    save.mockRejectedValueOnce(new Error('disk full'))
    await choose('wg0')
    expect(qr()).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save the pairing network')
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('retries the same failed choice explicitly, keeping the old QR retired until the save is acknowledged', async () => {
    await mount()
    await act(async () => button('Start pairing').click())
    save.mockRejectedValueOnce(new Error('disk full'))
    await choose('wg0')
    expect(select().value).toBe('wg0')
    expect(persisted).toBe('')
    expect(qr()).toBeNull()
    const held = deferred<void>()
    save.mockImplementationOnce(async (settings: typeof DEFAULT_SETTINGS) => { await held.promise; persisted = settings.phonePairingInterface })
    await act(async () => button('Retry save').click())
    expect(start).toHaveBeenCalledTimes(1)
    expect(persisted).toBe('')
    expect(qr()).toBeNull()
    expect(select().disabled).toBe(true)
    await act(async () => held.resolve())
    expect(persisted).toBe('wg0')
    expect(start).toHaveBeenCalledTimes(2)
    expect(qr()?.src).toContain('wg0')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect([...container.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Retry save')).toBe(false)
  })

  it('does not restart a failed idle save on retry, or expose Retry in an unsupported Server shell', async () => {
    await mount()
    save.mockRejectedValueOnce(new Error('disk full'))
    await choose('wg0')
    await act(async () => button('Retry save').click())
    expect(persisted).toBe('wg0')
    expect(start).not.toHaveBeenCalled()
    save.mockRejectedValueOnce(new Error('disk full'))
    await choose('wlan0')
    list.mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }))
    await act(async () => button('Refresh networks').click())
    expect(select()).toBeNull()
    expect(container.textContent).not.toContain('Retry save')
  })

  it('admits only one save before React disables the dropdown, so duplicate events cannot restart another code', async () => {
    await mount()
    const held = deferred<void>()
    save.mockImplementationOnce(async (settings: typeof DEFAULT_SETTINGS) => { await held.promise; persisted = settings.phonePairingInterface })
    await act(async () => {
      select().value = 'wg0'
      select().dispatchEvent(new Event('change', { bubbles: true }))
      select().value = 'wlan0'
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(useSettings.getState().settings.phonePairingInterface).toBe('wg0')
    await act(async () => held.resolve())
    expect(persisted).toBe('wg0')
  })

  it('does not regenerate after Settings leaves during the save, and the row is usable when it returns', async () => {
    await mount()
    await act(async () => button('Start pairing').click())
    const held = deferred<void>()
    save.mockImplementationOnce(async () => held.promise)
    await choose('wg0')
    await mount(false)
    await act(async () => held.resolve())
    expect(start).toHaveBeenCalledTimes(1)
    await mount(true)
    expect(select().disabled).toBe(false)
  })

  it('rechecks DHCP without changing the persisted adapter name or starting an idle code', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, phonePairingInterface: 'wlan0' } })
    await mount()
    networks = [{ interfaceName: 'wlan0', address: '192.168.1.77' }]
    await act(async () => button('Refresh networks').click())
    expect(select().selectedOptions[0].text).toBe('wlan0 — 192.168.1.77')
    expect(save).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('shows network read failure and permits Refresh to recover without resetting the selection', async () => {
    list.mockRejectedValueOnce(new Error('OS read failed'))
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, phonePairingInterface: 'wg0' } })
    await mount()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not read')
    await act(async () => button('Refresh networks').click())
    expect(select().value).toBe('wg0')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('hides the deliberate unsupported selector in the browser Server shell', async () => {
    list.mockRejectedValueOnce(Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' }))
    await mount()
    expect(select()).toBeNull()
    expect(container.textContent).not.toContain('Pairing network')
  })

  it('changing network after a completed scan saves it but does not restart pairing', async () => {
    await mount()
    await act(async () => button('Start pairing').click())
    await act(async () => done({ ok: true }))
    await choose('wg0')
    expect(start).toHaveBeenCalledTimes(1)
    expect(container.textContent).toMatch(/Paired/)
  })
})
