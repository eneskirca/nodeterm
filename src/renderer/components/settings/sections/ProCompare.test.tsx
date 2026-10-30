// @vitest-environment jsdom
//
// The Core vs Pro comparison follows the free-tier open-project limit (spec §8, and the §2
// anti-goal: the app must not say "unlimited / free forever" while the limit is on). Inactive — the
// Server Edition's permanent answer, and every install until the flip — it is byte-identical to the
// copy that shipped before the limit existed. Rendered through a real root, not
// `renderToStaticMarkup`: a zustand hook reads the store's INITIAL state on the server render, so a
// static render would never see the active state at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS } from '@shared/agents/config'
import { INACTIVE_PROJECT_LIMIT, type ProjectLimitState } from '@shared/project-limit'

// The project-limit store subscribes to `window.nodeTerminal.projectLimit.onChange` when it is
// created, so the bridge must exist before any import runs.
vi.hoisted(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectLimit: { state: vi.fn(), claim: vi.fn(), onChange: () => () => {} }
  }
})

import { ProCompare } from './ProCompare'
import { useProjectLimit } from '../../../state/projectLimit'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACTIVE: ProjectLimitState = { active: true, pro: false, free: 5, allowance: null, dnt: false }

const column = (html: string, heading: string): string[] => {
  const at = html.indexOf(heading)
  const rest = html.slice(at)
  const end = rest.indexOf('</div>')
  return [...rest.slice(0, end).matchAll(/<p class="text-text">✓ ([^<]*)<\/p>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
}

const AGENT_NODES = `Agent nodes (${BUILTIN_AGENT_IDS.map((id) => AGENT_CONFIG[id].label).join(' / ')})`
const LIVE_LINKS = 'Live links to a terminal: watch, chat, or let people type — viewers need nothing installed'
const DICTATION = 'Larger on-device dictation models (base, small, large-v3-turbo)'

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useProjectLimit.setState({ state: INACTIVE_PROJECT_LIMIT })
})

function render(state: ProjectLimitState): string {
  useProjectLimit.setState({ state })
  act(() => root.render(<ProCompare />))
  return host.innerHTML
}

describe('ProCompare — limit inactive', () => {
  it('lists live links under Pro', () => {
    expect(column(render(INACTIVE_PROJECT_LIMIT), 'Pro<')).toContain(LIVE_LINKS)
  })

  it('leaves the free Core list exactly as it was', () => {
    // Today's array, captured from the source before the limit touched it.
    expect(column(render(INACTIVE_PROJECT_LIMIT), 'Core — free forever')).toEqual([
      'Unlimited local terminals & canvas',
      'Unlimited SSH projects',
      'Groups, worktrees, git & diff',
      AGENT_NODES,
      'QR phone pairing on your LAN',
      'Remote access from your phone (relay, E2E encrypted)'
    ])
  })

  it('lists the larger dictation models right after live links, and nothing about projects', () => {
    expect(column(render(INACTIVE_PROJECT_LIMIT), 'Pro<')).toEqual([
      'Everything in Core',
      'nodeterm mobile Pro included',
      '3 team seats included (extra seats $5/seat/mo)',
      LIVE_LINKS,
      DICTATION
    ])
  })
})

describe('ProCompare — limit active', () => {
  it('shows the free allowance and drops "free forever" and the unqualified "unlimited"', () => {
    const html = render(ACTIVE)
    expect(html).not.toContain('free forever')
    expect(html).not.toContain('Unlimited local terminals')
    expect(html).not.toContain('Unlimited SSH projects')
    expect(column(html, 'Core — free<')).toEqual([
      'Up to 5 open projects',
      'Unlimited terminals & canvas in each project',
      'SSH projects',
      'Groups, worktrees, git & diff',
      AGENT_NODES,
      'QR phone pairing on your LAN',
      'Remote access from your phone (relay, E2E encrypted)'
    ])
  })

  it("shows the user's own allowance when it is above FREE", () => {
    const html = render({ ...ACTIVE, allowance: 30 })
    expect(column(html, 'Core — free<')[0]).toBe('Up to 30 open projects')
  })

  it('leads the Pro list with unlimited open projects and still lists dictation', () => {
    expect(column(render(ACTIVE), 'Pro<')).toEqual([
      'Everything in Core',
      'Unlimited open projects',
      'nodeterm mobile Pro included',
      '3 team seats included (extra seats $5/seat/mo)',
      LIVE_LINKS,
      DICTATION
    ])
  })
})
