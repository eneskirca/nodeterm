// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UsageIndicator } from './UsageIndicator'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { DEFAULT_SETTINGS, type RemoteAccountUsage, type ProviderUsage } from '@shared/types'
let root: Root, host: HTMLDivElement
const usage = (value: number): ProviderUsage => ({ provider: 'codex', status: 'ok', account: 'Work', updatedAt: 1,
  limits: [{ kind: 'session', group: 'session', usedPercent: value, severity: null, resetsAt: null, windowMinutes: 300, scopeLabel: null, isActive: false }] })
const row = (hostKey: string, value: number): Extract<RemoteAccountUsage, { provider: 'codex' }> => ({ provider: 'codex', hostKey, accountId: 'work', label: 'Work', usage: usage(value) })
const project = (id: string, server: string) => ({ id, name: id, nodes: [], ssh: { server: { host: server, user: 'u', port: 22 }, remoteCwd: '/srv' } })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSettings.setState({ hydrated: true, settings: { ...DEFAULT_SETTINGS, usagePercentMode: 'used', hiddenUsageProviders: ['claude', 'claude-remote'],
    claudeAccounts: [{ id: 'work', label: 'Claude work', host: 'u@a', createdAt: 0 }] } })
  useProjects.setState({ projects: [project('a', 'a'), project('b', 'b')] as never, activeProjectId: 'a' })
  useSshConn.setState({ byProject: { a: { controlPath: '/a' }, b: { controlPath: '/b' } } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); useSettings.setState({ settings: DEFAULT_SETTINGS }); useProjects.setState({ projects: [], activeProjectId: '' }); useSshConn.setState({ byProject: {} }); vi.unstubAllGlobals() })
async function render(remote: (q?: {hostKey?: string}) => Promise<RemoteAccountUsage[]>) {
  Object.assign(window, { nodeTerminal: { usage: { remote, providers: async () => [usage(99)],
    fetch: async () => null, onUpdate: () => () => {} }, settings: { save: async () => {} } } })
  await act(async () => root.render(<UsageIndicator countAccountSessions={() => 3} onMoveSessions={vi.fn()} />))
}
it('shows host Codex when Claude is hidden without Claude default/move controls or local quotas', async () => {
  await render(async () => [row('u@a', 42)])
  expect(host.querySelector('.usage-pill')?.textContent).toContain('42% Codex')
  expect(host.textContent).not.toContain('99%')
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
  expect(host.textContent).toContain('u@a · SSH')
  expect(host.textContent).not.toContain('Move 3 sessions')
  expect(host.textContent).not.toContain('Use for new sessions')
  await act(async () => useSettings.setState({ settings: { ...useSettings.getState().settings, hiddenUsageProviders: ['codex', 'claude', 'claude-remote'] } }))
  expect(host.querySelector('.usage-pill')).toBeNull()
})
it('does not let a slow previous host response replace the current host quota', async () => {
  let finish: ((r: RemoteAccountUsage[]) => void) | undefined
  await render(q => q?.hostKey === 'u@a' ? new Promise(r => { finish = r }) : Promise.resolve([row('u@b', 17)]))
  await act(async () => useProjects.setState({ activeProjectId: 'b' }))
  expect(host.textContent).toContain('17% Codex')
  await act(async () => finish?.([row('u@a', 88)]))
  expect(host.textContent).toContain('17% Codex'); expect(host.textContent).not.toContain('88%')
})
it('renders an error without a zero percent bar when the host cannot read usage', async () => {
  await render(async () => [{ ...row('u@a', 42), usage: { ...usage(42), limits: [], status: 'error' } }])
  expect(host.querySelector('.usage-pill')?.textContent).toContain('⚠')
  expect(host.textContent).not.toContain('0%')
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
  expect(host.textContent).toContain('Could not read usage.')
})

it('discards an old forced refresh after switching projects and retains both Claude and Codex pill limits', async () => {
  useSettings.setState({ settings: { ...useSettings.getState().settings, hiddenUsageProviders: [] } })
  let finish: ((r: RemoteAccountUsage[]) => void) | undefined
  await render((q: { hostKey?: string; force?: boolean } | undefined) => {
    if (q?.force) return new Promise(r => { finish = r })
    if (q?.hostKey === 'u@b') return Promise.resolve([row('u@b', 17)])
    return Promise.resolve([row('u@a', 98), { hostKey: 'u@a', accountId: null, label: 'u@a',
      usage: { limits: usage(5).limits, email: null, session: null, weekly: null, status: 'ok', updatedAt: 1 } }])
  })
  expect(host.querySelector('.usage-pill')?.textContent).toContain('98% Codex')
  expect(host.querySelector('.usage-pill')?.textContent).toContain('5%')
  expect((host.querySelector('.usage-pill__minibar-fill') as HTMLElement).style.width).toBe('98%')
  await act(async () => (host.querySelector('.usage-pill') as HTMLButtonElement).click())
  const refresh = host.querySelector('button[title="Refresh usage"]') as HTMLButtonElement
  expect(refresh).toBeTruthy()
  await act(async () => refresh.click())
  await act(async () => useProjects.setState({ activeProjectId: 'b' }))
  expect(host.querySelector('.usage-pill')?.textContent).toContain('17% Codex')
  await act(async () => finish?.([row('u@a', 88)]))
  expect(host.querySelector('.usage-pill')?.textContent).toContain('17% Codex')
})
