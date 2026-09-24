// @vitest-environment jsdom
//
// The usage popover's bulk "Move N sessions": on an account row with sessions, it offers the OTHER
// accounts of the same machine and hands the pick to Canvas. The rules pinned here: the row's own
// account is never offered as a target, a row with nothing on it shows no control, and the pick
// carries the source, the target and its label.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { UsageIndicator } from './UsageIndicator'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { DEFAULT_SETTINGS, type ClaudeUsage } from '@shared/types'

const usage = (email: string): ClaudeUsage => ({
  limits: [
    {
      kind: 'session',
      group: 'session',
      usedPercent: 100,
      severity: null,
      resetsAt: null,
      windowMinutes: null,
      scopeLabel: null,
      isActive: true
    }
  ],
  session: null,
  weekly: null,
  email,
  updatedAt: 0,
  status: 'ok'
})

let root: Root
let host: HTMLElement
const onMove = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onMove.mockReset()
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      claudeAccounts: [
        { id: 'w', label: 'Work', email: 'w@example.com', createdAt: 0 },
        { id: 'p', label: 'Personal', email: 'p@example.com', createdAt: 0 }
      ]
    },
    hydrated: true
  })
  useProjects.setState({ projects: [{ id: 'p1', name: 'local', nodes: [] } as never], activeProjectId: 'p1' })
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: {
      fetch: async (id?: string) => usage(id ? `${id}@example.com` : 'me@example.com'),
      onUpdate: () => () => {},
      providers: async () => [],
      remote: async () => []
    },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  vi.unstubAllGlobals()
})

async function renderOpen(counts: Record<string, number>): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <UsageIndicator
        countAccountSessions={(id) => counts[id ?? 'system'] ?? 0}
        onMoveSessions={onMove}
      />
    )
  })
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
}

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')]

describe('usage popover — Move N sessions', () => {
  it('moves an account’s sessions to another account of the same machine', async () => {
    await renderOpen({ w: 3 })
    const move = buttons().find((b) => b.textContent === '⇄ Move 3 sessions')!
    expect(move).toBeTruthy()
    await act(async () => move.click())
    const targets = buttons()
      .filter((b) => b.textContent?.startsWith('→ '))
      .map((b) => b.textContent)
    // Its own account is never a target; the system login and the other account are.
    expect(targets).toEqual(['→ me@example.com', '→ Personal'])
    await act(async () => buttons().find((b) => b.textContent === '→ Personal')!.click())
    expect(onMove).toHaveBeenCalledWith('w', 'p', 'Personal')
  })

  it('moves the system account’s sessions (source undefined)', async () => {
    await renderOpen({ system: 1 })
    await act(async () => buttons().find((b) => b.textContent === '⇄ Move 1 session')!.click())
    await act(async () => buttons().find((b) => b.textContent === '→ Work')!.click())
    expect(onMove).toHaveBeenCalledWith(undefined, 'w', 'Work')
  })

  it('shows no control on a row with no sessions', async () => {
    await renderOpen({})
    expect(buttons().some((b) => b.textContent?.startsWith('⇄ Move'))).toBe(false)
  })
})
