// @vitest-environment jsdom
//
// The owner's answer to a device asking to join a hosted team. A REMOTE device raises this dialog
// under the owner's hands, so what is asserted is safety-shaped: the least role is the default, the
// SAS and key fingerprint are on screen, Enter never approves, a held key never answers a queue of
// requests, and only a click on Allow grants anything. (No @testing-library in this repo: plain
// react-dom + act, like the other component tests.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HostedApprovalDialog } from './HostedApprovalDialog'
import { CONFIRM_ARM_MS } from './confirm-key'
import { openDialogCount, pushDialog, popDialog, resetDialogStack } from './dialog-stack'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  resetDialogStack()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const pending = (over: Partial<{ pendingId: string; sas: string; peerKeyB64: string; since: number }> = {}) => ({
  pendingId: 'p',
  sas: '123 456',
  peerKeyB64: 'AAAABBBBCCCC',
  since: 0,
  ...over
})

function mount(props: Partial<Parameters<typeof HostedApprovalDialog>[0]> = {}) {
  const onApprove = vi.fn()
  const onDeny = vi.fn()
  act(() => {
    root.render(<HostedApprovalDialog pending={pending()} teamLabel="box" onApprove={onApprove} onDeny={onDeny} {...props} />)
  })
  return { onApprove, onDeny }
}

const text = () => document.body.textContent ?? ''
const byText = (t: string) => [...document.querySelectorAll('button, strong, p, span, div')].find((e) => e.textContent === t) as HTMLElement | undefined
const roleSelect = () => document.querySelector('select[aria-label="Role"]') as HTMLSelectElement
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
const key = (target: EventTarget, init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(e) })
  return e
}

describe('HostedApprovalDialog', () => {
  it('defaults to Viewer, shows SAS + fingerprint, and approves with the chosen role', () => {
    const { onApprove } = mount()
    expect(byText('123 456')).toBeTruthy()
    expect(text()).toMatch(/AAAA·BBBB/)
    expect(roleSelect().value).toBe('viewer')
    act(() => {
      roleSelect().value = 'editor'
      roleSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(text()).toMatch(/run commands on box/i)
    act(() => button('Allow').click())
    expect(onApprove).toHaveBeenCalledWith('p', 'editor')
  })

  it('says what each role grants; the least role never mentions running commands', () => {
    mount()
    expect(text()).toMatch(/watch its terminals/)
    expect(text()).not.toMatch(/run commands/i)
    for (const [role, re] of [['commenter', /comment on cards/], ['owner', /approving, removing and changing roles.*run commands on box/]] as const) {
      act(() => {
        roleSelect().value = role
        roleSelect().dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(text()).toMatch(re)
    }
  })

  it('M2: the Viewer copy does not understate it: every file (.env included), the terminals, and git only for its own repository', () => {
    mount()
    expect(text()).toMatch(/Can read every file in the shared project's folder, \.env files included, and watch its terminals and anything printed in them\./)
    expect(text()).toMatch(/Its git history too, when the folder is a repository of its own\./)
    act(() => {
      roleSelect().value = 'commenter'
      roleSelect().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(text()).toMatch(/Viewer access, and can comment on cards and in cursor chat\./)
  })

  it('Enter does not approve (a remote device raised this dialog)', () => {
    vi.useFakeTimers()
    const { onApprove, onDeny } = mount()
    vi.advanceTimersByTime(CONFIRM_ARM_MS + 10)
    key(document.body, { key: 'Enter' })
    // …not even aimed inside the dialog, on the Allow button itself, or on the role picker.
    const allow = button('Allow')
    allow.focus()
    const onAllow = key(allow, { key: 'Enter' })
    expect(onAllow.defaultPrevented).toBe(true) // the browser's own button activation is blocked too
    key(roleSelect(), { key: 'Enter' })
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDeny).not.toHaveBeenCalled()
  })

  it('Deny is the focused button and answers with this request\'s id; Allow never takes focus', () => {
    const { onDeny, onApprove } = mount({ pending: pending({ pendingId: 'req-7' }) })
    expect(document.activeElement).toBe(button('Deny'))
    act(() => button('Deny').click())
    expect(onDeny).toHaveBeenCalledWith('req-7')
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('Escape declines — but never a held key or one already in flight when the dialog appeared', () => {
    vi.useFakeTimers()
    const { onDeny } = mount()
    key(document.body, { key: 'Escape' }) // arrived before the dialog was armed
    vi.advanceTimersByTime(CONFIRM_ARM_MS + 10)
    key(document.body, { key: 'Escape', repeat: true }) // a held key must not deny a whole queue
    expect(onDeny).not.toHaveBeenCalled()
    key(document.body, { key: 'Escape' })
    expect(onDeny).toHaveBeenCalledWith('p')
  })

  it('registers on the dialog stack, and a dialog above it owns the keys', () => {
    vi.useFakeTimers()
    const { onDeny } = mount()
    expect(openDialogCount()).toBe(1)
    vi.advanceTimersByTime(CONFIRM_ARM_MS + 10)
    pushDialog('above')
    key(document.body, { key: 'Escape' })
    expect(onDeny).not.toHaveBeenCalled()
    popDialog('above')
    act(() => root.render(<></>))
    expect(openDialogCount()).toBe(0)
  })

  it('says how many more requests are waiting behind this one', () => {
    mount({ more: 2 })
    expect(text()).toMatch(/2 more requests are waiting/)
  })

  it('renders what the host sent as text, never markup', () => {
    mount({ teamLabel: '<img src=x onerror=alert(1)>', pending: pending({ sas: '<b>1</b>' }) })
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(text()).toContain('<img src=x onerror=alert(1)>')
  })
})
