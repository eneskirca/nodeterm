// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitApi, GitStatus, NodeTerminalApi, Project } from '@shared/types'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { ProjectBranch } from './ProjectBranch'
import { SourceControlPanel } from './SourceControlPanel'
import { readBranchStatus, useGitBranch } from '../state/gitBranches'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { useSshConn } from '../state/sshConn'
import { createSession, setActiveSession, bindProjectToSession, SessionProvider, resetSessionsForTest } from '../session/session'
import { ReactFlowProvider } from '@xyflow/react'
import { GroupNode } from '../nodes/GroupNode'
import { useWorktrees } from '../state/worktrees'

vi.mock('./git-history/GitHistoryPanel', () => ({ GitHistoryPanel: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const status = (branch: string, hasRepo = true): GitStatus => ({
  branch, hasRepo, repoName: 'repo', branches: ['main', 'next'], ahead: 0, behind: 0,
  hasRemote: false, hasOrigin: false, hasUpstream: false, ghAvailable: false, ghAuthed: false,
  staged: [], changes: []
})
const noop = () => {}
const sidebarProps: SessionsSidebarProps = {
  open: true, pinned: true, liveActiveNodes: null, onTogglePin: noop, onClose: noop,
  onFocusNode: noop, onCloseSession: noop, onRenameSession: noop, onAiNameSession: noop,
  onRowContextMenu: noop, onProjectContextMenu: noop, onSwitchProject: noop, onAddToProject: noop,
  onMoveToGroup: noop, onAiNameGroup: noop, onReorder: noop, onReorderGroup: noop,
  onReorderProject: noop, onReopenProject: noop, onDeleteProject: noop,
  onReopenClosedSession: noop, onDiscardClosedSession: noop, onOpenClosedTranscript: noop
}
const project = (id: string, cwd = '/repo') => ({
  id, cwd, name: id, color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }
}) as Project
function apiFor(read = vi.fn(async (_cwd: string) => status('main'))) {
  return { git: { status: read, history: vi.fn(async () => ({ items: [], hasMore: false })),
    fetch: vi.fn(async () => ({ ok: true })) }, fs: {} } as unknown as NodeTerminalApi
}
function Branch({ git, cwd, sshId }: { git: GitApi; cwd: string; sshId?: string }) {
  return <output data-cwd={cwd}>{useGitBranch(git, cwd, sshId) ?? 'unknown'}</output>
}
async function settle(fn: () => void | Promise<unknown>) { await act(async () => { await fn() }) }
beforeEach(() => {
  resetSessionsForTest()
  window.nodeTerminal = { sshFs: {} } as NodeTerminalApi
  useProjects.setState({ projects: [], activeProjectId: '' })
  useSettings.setState((s) => ({ settings: { ...s.settings, gitAutoFetch: false } }))
  useSshConn.setState({ byProject: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); resetSessionsForTest() })

it.each([['/repo', false], ['C:\\repo', false], ['/repo', true]] as const)('Source switch at %s (worktree=%s) updates only its checkout headers', async (cwd, worktreeScope) => {
  const wt = `${cwd}/worktree`
  const branches = { [cwd]: 'main', [wt]: 'feature' }
  const api = apiFor(vi.fn(async (path) => status(branches[path])))
  api.git.switchBranch = vi.fn(async (path, branch) => { branches[path] = branch; return { ok: true, message: '' } })
  const sourceCwd = worktreeScope ? wt : cwd
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  const p = project('p', cwd)
  useProjects.setState({ projects: [p], activeProjectId: p.id })
  await readBranchStatus(api.git, wt)
  await settle(() => root.render(<SessionProvider session={session}>
    <SessionsSidebar {...sidebarProps} /><Branch git={api.git} cwd={wt} />
    <ReactFlowProvider><GroupNode {...({ id: 'wt', data: { title: 'worktree', color: '#fff',
      worktree: { path: wt, branch: 'saved', repoPath: cwd, baseRef: 'main', createdByApp: true }
    } } as Parameters<typeof GroupNode>[0])} /></ReactFlowProvider>
    <SourceControlPanel scopes={[{ id: 'main', label: 'main', cwd }, { id: 'wt', label: 'worktree', cwd: wt }]}
      defaultScope={{ id: worktreeScope ? 'wt' : 'main', label: 'selected', cwd: sourceCwd }} onClose={() => {}}
      onRunInTerminal={() => {}} onOpenDiff={() => {}} onOpenCommitDiff={() => {}}
      onExplainCommit={() => {}} onNewWorktree={() => {}} />
  </SessionProvider>))
  expect(host.querySelector('.ss-group__branch')?.textContent).toBe('⎇ main')
  await settle(() => (document.querySelector('.scm-branch') as HTMLElement).click())
  const next = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'next')
  expect(next).toBeDefined()
  await settle(() => next!.click())
  expect(api.git.switchBranch).toHaveBeenCalledWith(sourceCwd, 'next')
  expect(host.querySelector('.ss-group__branch')?.textContent).toBe(worktreeScope ? '⎇ main' : '⎇ next')
  expect(host.querySelector('output')?.textContent).toBe(worktreeScope ? 'next' : 'feature')
  expect(host.querySelector('.group-node__branch')?.textContent).toBe(worktreeScope ? '⎇ next' : '⎇ feature')
  api.git.switchBranch = vi.fn(async () => ({ ok: false, message: 'fixture: dirty checkout' }))
  await settle(() => (document.querySelector('.scm-branch') as HTMLElement).click())
  const main = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'main')
  await settle(() => main!.click())
  expect(document.body.textContent).toContain('fixture: dirty checkout')
  expect(host.querySelector('.ss-group__branch')?.textContent).toBe(worktreeScope ? '⎇ main' : '⎇ next')
  // Existing worktree polling publishes to the same branch observation, with no extra read.
  useWorktrees.getState().reset('p')
  await settle(() => useWorktrees.getState().refreshStatus(wt))
  expect(host.querySelector('output')?.textContent).toBe(worktreeScope ? 'next' : 'feature')
  expect(host.querySelector('.group-node__branch')?.textContent).toBe(worktreeScope ? '⎇ next' : '⎇ feature')
})

it('keeps same-path cores and SSH projects separate, resolves background projects through their own session', async () => {
  const a = apiFor(vi.fn(async () => status('local')))
  const b = apiFor(vi.fn(async () => status('server')))
  const local = createSession('local', a, 'local')
  const server = createSession('server', b, 'server')
  bindProjectToSession('remote', server.id)
  await settle(() => root.render(<SessionProvider session={server}>
    <ProjectBranch project={project('local')} /><ProjectBranch project={project('remote')} />
    <Branch git={a.git} cwd="/repo" sshId="ssh-a" /><Branch git={a.git} cwd="/repo" sshId="ssh-b" />
  </SessionProvider>))
  expect([...host.querySelectorAll('.ss-group__branch')].map((e) => e.textContent)).toEqual(['⎇ local', '⎇ server'])
  await settle(() => readBranchStatus(local.api.git, '/repo', 'ssh-a'))
  expect([...host.querySelectorAll('output')].map((e) => e.textContent)).toEqual(['local', 'unknown'])
})

it('SSH headers observe Source, which waits for remote routing; background headers never probe SSH paths', async () => {
  const api = apiFor()
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  const p = { ...project('ssh'), ssh: { remoteCwd: '/remote', server: { host: 'fixture', user: 'test', port: 22 } } } as Project
  useProjects.setState({ projects: [p], activeProjectId: p.id })
  await settle(() => root.render(<SessionProvider session={session}>
    <ProjectBranch project={p} />
    <SourceControlPanel scopes={[]} onClose={noop} onRunInTerminal={noop} onOpenDiff={noop}
      onOpenCommitDiff={noop} onExplainCommit={noop} onNewWorktree={noop} />
  </SessionProvider>))
  expect(api.git.status).not.toHaveBeenCalled()
  await settle(() => useSshConn.setState({ byProject: { ssh: { controlPath: '/fixture/socket' } } } as never))
  expect(api.git.status).toHaveBeenCalledWith('/remote')
  expect(host.textContent).toBe('⎇ main')
  vi.mocked(api.git.status).mockClear()
  const local = project('local', '/remote')
  // Even a connected SSH header must not probe while its project is in the background. The
  // local same-path header must also not hit the active SSH routing by mistake.
  await settle(() => root.render(<SessionProvider session={session}>
    <ProjectBranch project={p} /><ProjectBranch project={local} />
  </SessionProvider>))
  expect(api.git.status).not.toHaveBeenCalled()
  await settle(() => useProjects.setState({ projects: [p, local], activeProjectId: local.id }))
  expect(api.git.status).toHaveBeenCalledTimes(1)
  expect(api.git.status).toHaveBeenCalledWith('/remote')
})

it('rejects late observations and clears a non-repo result without a render-triggered fetch loop', async () => {
  let resolveOld!: (s: GitStatus) => void
  const api = apiFor(vi.fn().mockImplementationOnce(() => new Promise<GitStatus>((r) => { resolveOld = r }))
    .mockResolvedValueOnce(status('next')).mockResolvedValueOnce(status('', false)))
  await settle(() => root.render(<Branch git={api.git} cwd="/repo" />))
  const old = readBranchStatus(api.git, '/repo')
  await settle(() => readBranchStatus(api.git, '/repo'))
  await settle(async () => { resolveOld(status('old')); await old })
  expect(host.textContent).toBe('next')
  await settle(() => readBranchStatus(api.git, '/repo'))
  expect(host.textContent).toBe('')
  expect(api.git.status).toHaveBeenCalledTimes(3)
})

it('re-resolves a project cwd and re-reads on reopen without retaining its old branch', async () => {
  const api = apiFor(vi.fn(async (cwd) => status(cwd === '/repo' ? 'main' : 'other')))
  const session = createSession('local', api, 'local')
  setActiveSession(session.id)
  const render = (p?: Project) => root.render(<SessionProvider session={session}>{p && <ProjectBranch project={p} />}</SessionProvider>)
  await settle(() => render(project('p')))
  await settle(() => render(project('p', '/other')))
  expect(host.textContent).toBe('⎇ other')
  await settle(() => render())
  await settle(() => render(project('p')))
  expect(host.textContent).toBe('⎇ main')
  expect(api.git.status).toHaveBeenCalledTimes(3)
})
