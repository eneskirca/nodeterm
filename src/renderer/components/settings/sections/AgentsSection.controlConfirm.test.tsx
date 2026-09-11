// @vitest-environment jsdom
//
// The house rule this row exists to satisfy: every loosening of a security gate must be VISIBLE as
// a setting and revocable there. A "Don't ask again" that lives only in a dialog is a permission
// the user granted once and can never find again — so the section has to show what is waived
// right now (including the app-run waiver granted from a dialog that is already gone), and offer
// the way back.
//
// The other half is the git-shared trap, and it is asserted as COPY here because the copy is the
// only place a user learns it: a `bypassPermissions` in `.nodeterm/project.json` travels to
// everyone who clones the repo, so this switch must say — in the row itself — that a project
// override does not count. The behaviour is proven in shared/control-confirm.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CONFIRM_WAIVABLE_VERBS } from '@shared/control-confirm'
import { useSettings } from '../../../state/settings'
import { useControlConfirm } from '../../../state/controlConfirm'
import { AgentsSection } from './AgentsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function selectFor(label: string): HTMLSelectElement {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  expect(el, `a row for "${label}" must be in the Agents section`).toBeTruthy()
  return el!
}

function choose(label: string, value: string): void {
  const el = selectFor(label)
  act(() => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function bypassSwitch(): HTMLElement {
  const el = host.querySelector<HTMLElement>(
    '[aria-label="Skip destructive canvas-control confirmations in Bypass permissions mode"]'
  )
  expect(el, 'the bypass opt-in must be in the Agents section').toBeTruthy()
  return el!
}

const CLOSE_LABEL = 'Ask before an agent closes nodes'
const WRITE_LABEL = 'Ask before an agent types into a node'

async function render(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AgentsSection isActive />)
  })
}

beforeEach(async () => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    claude: { cliCaps: vi.fn(async () => null) }
  }
  useSettings.setState((s) => ({ settings: { ...s.settings, controlConfirmWaivers: undefined } }))
  useControlConfirm.setState({ sessionWaived: [], sessionWaivedSet: new Set() })
  await render()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState((s) => ({ settings: { ...s.settings, controlConfirmWaivers: undefined } }))
  useControlConfirm.setState({ sessionWaived: [], sessionWaivedSet: new Set() })
})

describe('destructive canvas-control confirmations in Settings', () => {
  it('shows one row per waivable verb, derived from the shared table', () => {
    // Derived, not hand-listed: a verb that becomes waivable in code but invisible here would be a
    // loosening the user cannot see or revoke.
    expect(CONFIRM_WAIVABLE_VERBS.size).toBe(2)
    selectFor(WRITE_LABEL)
    selectFor(CLOSE_LABEL)
  })

  it('defaults to Always ask with no setting stored', () => {
    expect(selectFor(CLOSE_LABEL).value).toBe('ask')
    expect(useSettings.getState().settings.controlConfirmWaivers).toBeUndefined()
  })

  it('says "permanently" on the permanent option — the dialog cannot grant this one', () => {
    const option = [...selectFor(CLOSE_LABEL).options].find((o) => o.value === 'never')
    expect(option?.textContent).toMatch(/permanently/i)
  })

  it('persists a permanent waiver per verb, and revokes it', () => {
    choose(CLOSE_LABEL, 'never')
    expect(useSettings.getState().settings.controlConfirmWaivers).toEqual({ always: ['close'] })
    // Waiving `close` must not waive `write`.
    expect(selectFor(WRITE_LABEL).value).toBe('ask')
    choose(CLOSE_LABEL, 'ask')
    expect(useSettings.getState().settings.controlConfirmWaivers).toEqual({})
  })

  it('normalizes a hand-edited settings.json on the first UI write', () => {
    // The gates read through the sanitizer, so a bogus entry is already inert — but leaving it in
    // the file makes the UI and the file disagree about what is waived.
    act(() => {
      useSettings.setState((s) => ({
        settings: {
          ...s.settings,
          controlConfirmWaivers: { always: ['open-project', 'close', 'close'] } as never
        }
      }))
    })
    // It never showed as waived…
    expect(selectFor(CLOSE_LABEL).value).toBe('never')
    choose(WRITE_LABEL, 'never')
    // …and the write drops the entry the table forbids instead of carrying it forward.
    expect(useSettings.getState().settings.controlConfirmWaivers).toEqual({
      always: ['close', 'write']
    })
  })

  it('surfaces an app-run waiver granted from a dialog, and offers Revoke', () => {
    expect(host.textContent).not.toContain('Waived until nodeterm quits')
    act(() => useControlConfirm.getState().waiveForSession('close'))
    const text = host.textContent ?? ''
    // The dialog that granted it is gone, so this row is the only place it can be seen or ended.
    expect(text).toContain('Waived until nodeterm quits')
    const revoke = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Revoke')
    expect(revoke, 'an app-run waiver must be revocable here').toBeTruthy()
    act(() => revoke!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useControlConfirm.getState().sessionWaived).toEqual([])
    expect(host.textContent).not.toContain('Waived until nodeterm quits')
    // Revoking an app-run waiver must not write anything to disk.
    expect(useSettings.getState().settings.controlConfirmWaivers).toBeUndefined()
  })

  it('does not offer Revoke for a PERMANENT waiver — the dropdown is that control', () => {
    choose(CLOSE_LABEL, 'never')
    act(() => useControlConfirm.getState().waiveForSession('close'))
    expect(host.textContent).not.toContain('Waived until nodeterm quits')
    // A Revoke beside a permanent waiver would clear the app-run one and change nothing the user
    // can see, since the permanent waiver still applies — a button that appears to do nothing.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Revoke')).toBe(false)
  })

  it('does not honour a hand-edited waiver the GATES will refuse', () => {
    // `settings.json` is hand-editable and unvalidated on load, so this row must show what
    // `decideControlConfirm` will actually do — not what the file says. A string where a list
    // belongs is the case that separates the two: `'close'.includes('close')` is true, so a raw
    // read reports the verb as waived while the sanitized gate keeps asking.
    act(() => {
      useSettings.setState((s) => ({
        settings: { ...s.settings, controlConfirmWaivers: { always: 'close' } as never }
      }))
    })
    expect(selectFor(CLOSE_LABEL).value).toBe('ask')
  })

  it('has the bypass opt-in OFF by default and persists it', () => {
    expect(bypassSwitch().getAttribute('aria-checked')).toBe('false')
    act(() => bypassSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useSettings.getState().settings.controlConfirmWaivers).toEqual({ bypassMode: true })
  })

  it('tells the user that a project override does NOT count', () => {
    const text = host.textContent ?? ''
    expect(text).toContain('.nodeterm/project.json')
    expect(text).toMatch(/travels to everyone who clones the repo/)
    expect(text).toMatch(/A project that overrides the mode never counts/)
  })
})
