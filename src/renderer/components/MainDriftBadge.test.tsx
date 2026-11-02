// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MainDrift, NodeTerminalApi } from '@shared/types'
import { MainDriftBadge } from './MainDriftBadge'
import { agentStatusForProject, createSession, resetSessionsForTest, SessionProvider, setActiveSession } from '../session/session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const behind: MainDrift = { ok: true, base: 'origin/main', branch: 'feat', behind: 2, ahead: 1, fetch: 'ok' }

function apiFor(updateMode?: string) {
  const local = updateMode ? { worktree: { updateMode } } : undefined
  return {
    git: {
      mainDrift: vi.fn(async () => behind),
      updateFromMain: vi.fn(async () => ({ ok: true, message: 'Merged.' }))
    },
    projectSettings: {
      read: vi.fn(async () => ({ shared: null, local })),
      updateLocal: vi.fn(async () => true)
    }
  } as unknown as NodeTerminalApi
}
const nodes = () => [{ id: 'a', title: 'Claude', agentId: 'claude', cwd: '/repo/wt' }]
async function settle(fn: () => void | Promise<unknown>) {
  await act(async () => {
    await fn()
  })
}
async function mount(api: NodeTerminalApi) {
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  await settle(() =>
    root.render(
      <SessionProvider session={session}>
        <MainDriftBadge projectId="p" cwd="/repo/wt" nodes={nodes} />
      </SessionProvider>
    )
  )
}
const badge = () => host.querySelector('.main-drift__badge') as HTMLButtonElement
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement

beforeEach(() => {
  resetSessionsForTest()
  window.nodeTerminal = {} as NodeTerminalApi
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  resetSessionsForTest()
})

it('shows how far main moved and runs the remembered update on one click', async () => {
  const api = apiFor('rebase')
  await mount(api)
  expect(badge().textContent).toBe('main moved 2 commits')
  await settle(() => badge().click())
  expect(api.git.updateFromMain).toHaveBeenCalledWith('/repo/wt', 'rebase')
})

it('asks merge or rebase the first time and remembers the answer in the local overlay', async () => {
  const api = apiFor()
  await mount(api)
  await settle(() => badge().click())
  expect(api.git.updateFromMain).not.toHaveBeenCalled()
  await settle(() => button('Merge').click())
  expect(api.git.updateFromMain).toHaveBeenCalledWith('/repo/wt', 'merge')
  expect(api.projectSettings.updateLocal).toHaveBeenCalledWith('p', { worktree: { updateMode: 'merge' } })
})

it('refuses while an agent in the checkout is working, and says why', async () => {
  const api = apiFor('merge')
  await mount(api)
  agentStatusForProject('p').store.setState({ byId: { a: { state: 'working', unread: false } } })
  const toasts: string[] = []
  const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message)
  window.addEventListener('nodeterm:toast', onToast)
  await settle(() => badge().click())
  window.removeEventListener('nodeterm:toast', onToast)
  expect(api.git.updateFromMain).not.toHaveBeenCalled()
  expect(toasts[0]).toMatch(/Claude is working/)
})
