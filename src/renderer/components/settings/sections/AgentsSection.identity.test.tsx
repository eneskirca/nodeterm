// @vitest-environment jsdom
//
// The escape hatch has to exist IN THE UI, because the situations it rescues are exactly the ones
// where the user cannot tell what went wrong: canvas control stops working and the reply says the
// node has no identity. A hatch that can only be reached by hand-editing settings.json is a hatch
// only the author knows about.
//
// Two properties, and the tri-state is the whole point of both:
//  - `undefined` (follow the dated rollout) is a THIRD value, not a synonym for `false`. Rendering
//    this as a Switch would collapse the default into one of the two explicit answers the first
//    time anybody touched the row.
//  - the date the row prints is the date the hook server enforces. One string, imported.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NODE_IDENTITY_STRICT_DATE } from '@shared/node-identity'
import { useSettings } from '../../../state/settings'
import { AgentsSection } from './AgentsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function select(): HTMLSelectElement {
  const el = host.querySelector<HTMLSelectElement>(
    'select[aria-label="Require verified node identity"]'
  )
  expect(el, 'the identity row must be in the Agents section').toBeTruthy()
  return el!
}

/** Drive the native <select> the way React sees a user changing it. */
function choose(value: string): void {
  const el = select()
  act(() => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

beforeEach(async () => {
  // The section probes the local Claude CLI on mount; the probe swallows its own failures, but a
  // real `window.nodeTerminal` keeps the settings store's coalesced save from throwing later.
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    claude: { cliCaps: vi.fn(async () => null) }
  }
  useSettings.setState((s) => ({ settings: { ...s.settings, hookIdentityStrict: undefined } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AgentsSection isActive />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState((s) => ({ settings: { ...s.settings, hookIdentityStrict: undefined } }))
})

describe('the node-identity escape hatch in Settings', () => {
  it('offers three choices, because the setting is a tri-state', () => {
    expect([...select().options].map((o) => o.value)).toEqual(['auto', 'on', 'off'])
  })

  it('shows the default as Automatic while the setting is absent', () => {
    expect(select().value).toBe('auto')
  })

  it('writes `false` for "Not required" — the state a stranded user needs', () => {
    choose('off')
    expect(useSettings.getState().settings.hookIdentityStrict).toBe(false)
  })

  it('writes `true` for "Always required" (opt in before the date)', () => {
    choose('on')
    expect(useSettings.getState().settings.hookIdentityStrict).toBe(true)
  })

  it('writes `undefined`, NOT `false`, when the user goes back to Automatic', () => {
    // The distinction this test exists for: `false` is a permanent opt-out that survives the
    // cutoff, `undefined` is "follow the rollout". Mapping Automatic onto `false` would quietly
    // opt every user who ever opened this row out of the feature.
    choose('off')
    choose('auto')
    expect(useSettings.getState().settings.hookIdentityStrict).toBeUndefined()
  })

  it('tells the user what it does, in their terms, and names the cutoff date', () => {
    const text = host.textContent ?? ''
    expect(text).toContain('Require verified node identity for canvas control')
    // The date is imported from @shared, never typed into the copy: a Settings page promising a
    // different cutoff from the one the hook server enforces is worse than no copy at all.
    expect(text).toContain(NODE_IDENTITY_STRICT_DATE)
    // …and it says what turning it off buys, since that is the sentence a stranded user is hunting.
    expect(text).toMatch(/restores the behaviour from before this feature/)
  })
})
