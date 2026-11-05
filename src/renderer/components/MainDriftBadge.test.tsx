// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MainDrift, NodeTerminalApi } from '@shared/types'
import { MainDriftBadge } from './MainDriftBadge'
import { agentStatusForProject, createSession, resetSessionsForTest, SessionProvider, setActiveSession } from '../session/session'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
let root: Root
let host: HTMLDivElement
const behind: MainDrift = { ok: true, base: 'origin/main', branch: 'feat', behind: 2, ahead: 1, fetch: 'ok' }

function apiFor() {
  return {
    git: {
      mainDrift: vi.fn(async () => behind),
      updateFromMain: vi.fn(async () => ({ ok: true, message: 'Merged.' }))
    },
    pty: {
      paneOwner: vi.fn(async () => ({ kind: 'agent', agentId: 'claude' })),
      sendChatPrompt: vi.fn(async () => true)
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
const item = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('.ctx-menu .ctx-item')].find((b) => b.textContent === text)

beforeEach(() => {
  resetSessionsForTest()
  // The poll runs only in a focused window; jsdom's document never has focus.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
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

it('shows a small chip; a click opens merge and rebase, and nothing runs before a pick', async () => {
  const api = apiFor()
  await mount(api)
  expect(badge().textContent).toBe('↓2')
  expect(badge().title).toMatch(/main moved 2 commits/)
  await settle(() => badge().click())
  expect(api.git.updateFromMain).not.toHaveBeenCalled()
  expect(document.querySelector('.ctx-menu')?.textContent).toContain('main moved 2 commits')
  await settle(() => item('Rebase on main')?.click())
  expect(api.git.updateFromMain).toHaveBeenCalledWith('/repo/wt', 'rebase')
})

it('tells the idle agent in the checkout what changed once the update landed', async () => {
  const api = apiFor()
  await mount(api)
  agentStatusForProject('p').store.setState({ byId: { a: { state: 'done', unread: false } } })
  await settle(() => badge().click())
  await settle(() => item('Merge main into feat')?.click())
  expect(api.git.updateFromMain).toHaveBeenCalledWith('/repo/wt', 'merge')
  expect(api.pty.sendChatPrompt).toHaveBeenCalledWith('a', expect.stringMatching(/^nodeterm: the user merged main into feat/), 'claude')
})

it('refuses while an agent in the checkout is working, and says why', async () => {
  const api = apiFor()
  await mount(api)
  agentStatusForProject('p').store.setState({ byId: { a: { state: 'working', unread: false } } })
  const toasts: string[] = []
  const onToast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message)
  window.addEventListener('nodeterm:toast', onToast)
  await settle(() => badge().click())
  await settle(() => item('Merge main into feat')?.click())
  window.removeEventListener('nodeterm:toast', onToast)
  expect(api.git.updateFromMain).not.toHaveBeenCalled()
  expect(toasts[0]).toMatch(/Claude is working/)
})
