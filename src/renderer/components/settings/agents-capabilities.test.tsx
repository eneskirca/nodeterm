// @vitest-environment jsdom
//
// Settings → Agents: the per-project capability rows are GENERATED from PROJECT_CAPABILITIES.
// Every assertion below iterates the array rather than naming rows: a capability added to the
// union without a rendered row (the hand-written-list failure this repo has already documented)
// fails here, and agent messaging's row (its PR 6) must appear by adding a copy entry only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Project } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_COPY,
  projectCapabilityFlagInFile
} from '@shared/project-capabilities'
import { projectCapabilityGrantedFor } from '@shared/project-capability-consent'
import { useProjects } from '../../state/projects'
import { useSettings } from '../../state/settings'
import { AgentsSection } from './sections/AgentsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'my-canvas',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  ...over
})

let root: Root
let host: HTMLElement

function mount(): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AgentsSection isActive />))
}

function capSwitch(label: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)
  expect(el, `a rendered switch for "${label}"`).toBeTruthy()
  return el!
}

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn(async () => undefined) },
    claude: { cliCaps: vi.fn(async () => null) }
  }
  useProjects.setState({ projects: [project()], activeProjectId: 'p1', reloadNonce: 0 })
  useSettings.setState({ settings: DEFAULT_SETTINGS, hydrated: true })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useProjects.setState({ projects: [], activeProjectId: '' })
})

describe('per-project capability rows, generated from PROJECT_CAPABILITIES', () => {
  it('offers a machine-local messaging default for projects created later', () => {
    mount()
    const toggle = host.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Messaging in new projects"]'
    )
    expect(toggle).toBeTruthy()
    expect(useSettings.getState().settings.agentMessagingDefault).toBe(false)
    act(() => toggle!.click())
    expect(useSettings.getState().settings.agentMessagingDefault).toBe(true)
  })

  it('renders one row per capability, naming the active project, the grant and what travels', () => {
    mount()
    const text = host.textContent ?? ''
    for (const cap of PROJECT_CAPABILITIES) {
      const copy = PROJECT_CAPABILITY_COPY[cap]
      capSwitch(copy.label)
      expect(text).toContain(copy.description)
      // The same "this is in the project file" sentence the clone notice shows: the two
      // git-shared grants read alike wherever the switch is set.
      expect(text).toContain(copy.cloneWarning)
    }
    expect(text).toContain('my-canvas')
  })

  it.each([...PROJECT_CAPABILITIES])(
    'toggling %s on writes the literal true the strict validators accept, plus this machine’s ack',
    (cap) => {
      mount()
      act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
      const p = useProjects.getState().getProject('p1')!
      expect(p[cap]).toBe(true) // === true, not "true"/1 — projectCapabilityFlagInFile is strict
      // Setting it yourself records its own KEPT: no clone notice for the user's own switch.
      expect(p.capabilityAck?.[cap]).toBe('kept')
      expect(projectCapabilityFlagInFile(p, cap)).toBe(true)
    }
  )

  it.each([...PROJECT_CAPABILITIES])(
    'toggling %s off deletes the field outright — no bytes, and never a stored false',
    (cap) => {
      useProjects.getState().setProjectCapability('p1', cap, true)
      mount()
      act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
      const p = useProjects.getState().getProject('p1')!
      expect(p[cap]).toBeUndefined()
      // …and records DECLINED (PR #213 C1/M-2): if a teammate re-commits `true`, the project is
      // re-noticed and refused instead of silently re-granted through the old consent.
      expect(p.capabilityAck?.[cap]).toBe('declined')
    }
  )

  it('turning a capability off takes effect LIVE: every read consults the store, nothing caches', () => {
    // PR 6 Task 6.4 depends on this shape: the browser ledger / messagingEnabled read the switch
    // per call. Simulate two consecutive calls around an off-toggle and require the second to see
    // the refusal immediately — no lease-start snapshot may answer for it.
    const cap = PROJECT_CAPABILITIES[0]
    useProjects.getState().setProjectCapability('p1', cap, true)
    const grantedNow = (): boolean =>
      projectCapabilityGrantedFor(useProjects.getState().getProject('p1'), cap)
    expect(grantedNow()).toBe(true)
    mount()
    act(() => capSwitch(PROJECT_CAPABILITY_COPY[cap].label).click())
    expect(grantedNow()).toBe(false)
  })

  it('with no project open the switch is disabled — a capability needs a project to belong to', () => {
    useProjects.setState({ projects: [], activeProjectId: '' })
    mount()
    for (const cap of PROJECT_CAPABILITIES) {
      const el = capSwitch(PROJECT_CAPABILITY_COPY[cap].label)
      expect(el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')).toBe(true)
    }
  })
})
