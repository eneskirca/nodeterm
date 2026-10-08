import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SleepingWakeRequest } from '@shared/agents/sleeping-wake'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Project } from '@shared/types'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useAgentStatus } from '../state/agentStatus'
import { resetProjectLaunchInfoForTests } from '../state/projectLaunchInfo'
import { resetCodexCliCapsForTests } from '../state/codexCli'
import { resetClaudeCliCapsForTests } from '../state/permissionMode'
import { useSshConn } from '../state/sshConn'
import { wakeOffscreenNode } from './offscreen-wake-runtime'

const node: CanvasNodeState = { id: 'term-hidden', kind: 'terminal', title: 'G', color: '#fff', group: null,
  position: { x: 0, y: 0 }, size: { width: 600, height: 400 }, agentId: 'gemini', agentSessionId: 'saved-id' }
const hidden: Project = { id: 'hidden', name: 'Hidden', color: '#fff', cwd: '/hidden', nodes: [node], viewport: { x: 0, y: 0, zoom: 1 }, defaultPermissionMode: 'plan' }
const active: Project = { ...hidden, id: 'active', name: 'Active', nodes: [], defaultPermissionMode: 'bypassPermissions' }
const wake = vi.fn(async (_request: SleepingWakeRequest) => ({ delivered: true, verdict: 'resume' as const }))
const launchInfo = vi.fn(async () => ({ resolved: { setup: {}, worktree: {}, agents: {}, terminal: {} }, trusted: { agents: true, shell: true } }))
const localClaude = vi.fn(async () => ({ version: '2.1.300', autoPermissionMode: true, fullscreenTui: true, sessionIdFlag: true }))
const localCodex = vi.fn(async () => ({ approvalValues: ['untrusted', 'on-request', 'never'] }))
beforeEach(() => {
  vi.stubGlobal('window', { nodeTerminal: { pty: { wakeSleeping: wake }, projectSettings: { launchInfo },
    claude: { cliCaps: localClaude }, codex: { cliCaps: localCodex }, reportHibernated: vi.fn() } })
  wake.mockClear(); launchInfo.mockClear(); localClaude.mockClear(); localCodex.mockClear()
  resetProjectLaunchInfoForTests(); resetCodexCliCapsForTests(); resetClaudeCliCapsForTests()
  useSshConn.setState({ byProject: {}, autoPermByProject: {}, remoteClaudeVersionByProject: {} })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudePermissionMode: 'bypassPermissions' } })
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'active', projects: [active, hidden] })
  useAgentStatus.setState({ byId: { 'term-hidden': { unread: false, hibernated: true, sessionId: 'live-id',
    hibernatedContext: { command: 'bash', panePid: 72, paneId: '%8' } } } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('saved-project offscreen wake integration', () => {
  it('uses the inactive owner permission mode and live provider id without switching the visible tab', async () => {
    await wakeOffscreenNode('term-hidden', true)
    expect(wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ nodeId: 'term-hidden', agentId: 'gemini', command: 'gemini --resume live-id --approval-mode plan' }))
    expect(launchInfo).toHaveBeenCalledWith('hidden')
    expect(useProjects.getState().activeProjectId).toBe('active')
    expect(useAgentStatus.getState().byId['term-hidden'].hibernated).toBeUndefined()
  })
  it('keeps a closed project closed while waking its saved node after canvas eviction', async () => {
    useProjects.getState().closeProject('hidden')
    const closed = useProjects.getState().getProject('hidden')!
    expect(closed.closed).toBe(true)
    await wakeOffscreenNode('term-hidden', false)
    expect(wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: 'gemini --resume live-id --approval-mode plan' }))
    expect(useProjects.getState().getProject('hidden')).toBe(closed)
    expect(useProjects.getState().getProject('hidden')?.closed).toBe(true)
    expect(useProjects.getState().activeProjectId).toBe('active')
  })
  it('keeps the existing legacy Claude tag identity without adopting a hand-launched plain shell', async () => {
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: undefined, tags: ['claude'] }] })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'claude', command: 'claude --resume live-id --permission-mode plan' }))
    wake.mockClear()
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: undefined }] })
    useAgentStatus.setState({ byId: { 'term-hidden': { unread: false, hibernated: true, agentId: 'claude', sessionId: 'live-id' } } })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake).not.toHaveBeenCalled()
  })
  it('refuses custom resume arguments whose required environment values are missing', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, customAgents: [{ id: 'custom:proxy', label: 'Proxy', launchCmd: 'proxy', args: '--token ${env:NODETERM_QA_MISSING_WAKE_TOKEN}' }] } })
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: 'custom:proxy' }] })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake).not.toHaveBeenCalled()
  })
  it('uses actual local Codex caps but never borrows that vocabulary for a remote project', async () => {
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: 'codex' }], defaultPermissionMode: 'manual' })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake.mock.calls[0][0]).toMatchObject({ command: 'codex resume live-id --ask-for-approval untrusted' })
    useAgentStatus.setState({ byId: { 'term-hidden': { unread: false, hibernated: true, sessionId: 'live-id', hibernatedContext: { command: 'bash', panePid: 72, paneId: '%8' } } } })
    wake.mockClear(); localCodex.mockClear()
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: 'codex' }], defaultPermissionMode: 'manual', ssh: { server: { host: 'remote.example', user: 'u' }, remoteCwd: '/remote' } })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake.mock.calls[0][0]).toMatchObject({ command: 'codex resume live-id' })
    expect(localCodex).not.toHaveBeenCalled()
  })
  it('honors the remote project own Claude auto support while ignoring the local capability', async () => {
    useProjects.getState().replaceProject({ ...hidden, nodes: [{ ...node, agentId: 'claude' }], defaultPermissionMode: 'auto', ssh: { server: { host: 'remote.example', user: 'u' }, remoteCwd: '/remote' } })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake.mock.calls[0][0]).toMatchObject({ command: 'claude --resume live-id' })
    expect(localClaude).not.toHaveBeenCalled()
  })
  it('refuses ambiguous node ownership and automatic paused nodes without any delivery', async () => {
    useProjects.getState().replaceProject({ ...active, nodes: [node] })
    await wakeOffscreenNode('term-hidden', false)
    expect(wake).not.toHaveBeenCalled()
    useProjects.getState().replaceProject(active)
    useAgentStatus.getState().setPaused('term-hidden', true)
    await wakeOffscreenNode('term-hidden', true)
    expect(wake).not.toHaveBeenCalled()
  })
  it('cancels when saved project is replaced while trusted launch info is being read', async () => {
    let finish!: () => void
    launchInfo.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ resolved: { setup: {}, worktree: {}, agents: {}, terminal: {} }, trusted: { agents: true, shell: true } }) }))
    const pending = wakeOffscreenNode('term-hidden', false)
    await Promise.resolve(); await Promise.resolve()
    useProjects.getState().replaceProject({ ...hidden, cwd: '/other' })
    finish(); await pending
    expect(wake).not.toHaveBeenCalled()
  })
})
