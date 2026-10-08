import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, UNKNOWN_CLAUDE_CLI_CAPS, UNKNOWN_CODEX_CLI_CAPS, UNKNOWN_GROK_CLI_CAPS,
  type Project, type Settings, type Workspace } from '../shared/types'
import type { ManagedTerminalRequest } from './managed-terminals'
import { createManagedTerminalPlanner, type ManagedTerminalPlannerDeps } from './managed-terminal-plan'
import { findInLoginPath } from './exec-path'

vi.mock('./codex-accounts-core', async (original) => ({
  ...(await original<typeof import('./codex-accounts-core')>()),
  codexAccountHome: (root: string, id: string) => path.join(root, 'codex-test', id)
}))
vi.mock('node-pty', () => ({ spawn: vi.fn(() => { throw new Error('planner must not spawn a PTY') }) }))

describe('host-owned managed terminal planner', () => {
  let root: string
  let project: Project
  let settings: Settings
  let workspace: Workspace
  let snapshot: Awaited<ReturnType<ManagedTerminalPlannerDeps['store']['readProjectSettings']>>
  let deps: ManagedTerminalPlannerDeps
  let request: ManagedTerminalRequest
  const nodeId = 'term-managed-owned'
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-managed-plan-'))
    const cwd = path.join(root, 'repo')
    await fs.mkdir(cwd)
    project = { id: 'owned-project', name: 'Repo', color: '#123456', cwd,
      nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }
    workspace = { projects: [project], activeProjectId: project.id } as Workspace
    settings = structuredClone(DEFAULT_SETTINGS)
    snapshot = { shared: null, local: undefined }
    deps = {
      userData: root, settings: () => settings,
      store: { load: vi.fn(async () => workspace),
        projectTargetInfo: vi.fn(() => ({ cwd: project.cwd, ssh: project.ssh, name: project.name })),
        readProjectSettings: vi.fn(async () => snapshot) },
      trust: { isTrusted: vi.fn(async () => false) },
      executable: vi.fn(async (bin) => bin.startsWith('/') ? bin : '/bin/' + bin),
      sessionShell: (program, fallback) => program || fallback || '/bin/bash',
      claudeCaps: vi.fn(async () => ({ ...UNKNOWN_CLAUDE_CLI_CAPS, autoPermissionMode: true, sessionIdFlag: true })),
      codexCaps: vi.fn(async () => ({ ...UNKNOWN_CODEX_CLI_CAPS, approvalValues: ['on-request', 'never'] })),
      grokCaps: vi.fn(async () => ({ ...UNKNOWN_GROK_CLI_CAPS, sessionIdFlag: true })),
      codexIdentity: vi.fn(async () => ({ shared: false, launcherPath: null })),
      env: { WRAPPER: 'fixture' }
    }
    request = { creationId: '11111111-1111-4111-8111-111111111111', projectId: project.id,
      kind: 'shell', cols: 80, rows: 24 }
  })
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })
  const planner = () => createManagedTerminalPlanner(deps)
  const agent = (agentId: 'claude' | 'codex' | 'grok' | 'gemini' | 'opencode' | 'copilot' = 'claude') =>
    ({ ...request, kind: 'agent' as const, agentId })

  it('creates shell facts from the genuine local owner and never supplies an agent command', async () => {
    const plan = await planner().plan(request, nodeId)
    expect(plan.node).toMatchObject({ id: nodeId, kind: 'terminal', title: 'Terminal', cwd: project.cwd, shell: '/bin/bash' })
    expect(plan.options).toEqual({ persistKey: nodeId, ownerProjectId: project.id, cwd: project.cwd,
      shell: '/bin/bash', cols: 80, rows: 24 })
    expect(plan.command).toBeUndefined()
    expect(plan.node.agentId).toBeUndefined()
    expect(await planner().revalidate(request, plan)).toBe(true)
    const largest = await planner().plan({ ...request, cols: 500, rows: 500, title: 'a'.repeat(120) }, nodeId)
    expect(largest.options).toMatchObject({ cols: 500, rows: 500 })
    expect(largest.node.title).toHaveLength(120)
  })

  it.skipIf(process.platform === 'win32')('plans the inherited absolute POSIX shell using the real executable resolver', async () => {
    // The physical Android New Terminal path uses these same production dependencies. With a
    // blank defaultShell, the inherited absolute SHELL used to be looked up beneath each PATH dir.
    const { resolveLocalSessionShell } = await import('./pty-manager')
    const shell = path.join(root, 'qa-shell')
    await fs.writeFile(shell, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    vi.stubEnv('SHELL', shell)
    vi.stubEnv('PATH', path.join(root, 'unrelated-path'))
    settings.defaultShell = ''
    deps.executable = findInLoginPath
    deps.sessionShell = resolveLocalSessionShell
    const plan = await planner().plan(request, nodeId)
    expect(plan.node.shell).toBe(shell)
    expect(plan.options.shell).toBe(shell)
    expect(plan.command).toBeUndefined()
    expect(await planner().revalidate(request, plan)).toBe(true)
    await fs.unlink(shell)
    expect(await planner().revalidate(request, plan)).toBe(false)
    await expect(planner().plan(request, nodeId)).rejects.toThrow('The configured shell is unavailable.')
  })

  it('rejects extra executable hints, unsupported custom agents, account-on-shell and invalid sizes before resolution', async () => {
    for (const patch of [{ cwd: '/wrong' }, { command: 'echo bad' }, { shell: 'sh' }, { kind: 'agent', agentId: 'custom:evil' },
      { accountId: 'account' }, { cols: 0 }, { rows: 501 }, { creationId: '../bad' },
      { projectId: 'a'.repeat(201) }, { title: 'a'.repeat(121) }, { title: 'bad\nline' }]) {
      await expect(planner().plan({ ...request, ...patch } as ManagedTerminalRequest, nodeId)).rejects.toThrow()
    }
    expect(deps.store.load).not.toHaveBeenCalled()
  })

  it('rejects missing, closed, SSH, driven, inline and ambiguous project ownership', async () => {
    const original = structuredClone(project)
    for (const patch of [{ closed: true }, { ssh: { server: { host: 'other', user: 'user' }, remoteCwd: '/remote' } },
      { drivenRemotely: true }, { cwd: undefined }]) {
      Object.assign(project, original, patch)
      await expect(planner().plan(request, nodeId)).rejects.toThrow('open local folder')
      delete (project as unknown as { drivenRemotely?: boolean }).drivenRemotely
      delete project.ssh
      delete project.closed
    }
    Object.assign(project, original)
    workspace.projects = []
    await expect(planner().plan(request, nodeId)).rejects.toThrow('unavailable or ambiguous')
    workspace.projects = [project, structuredClone(project)]
    await expect(planner().plan(request, nodeId)).rejects.toThrow('unavailable or ambiguous')
  })

  it('requires the current actual folder and rejects settings conflicts', async () => {
    await fs.rm(project.cwd!, { recursive: true })
    await expect(planner().plan(request, nodeId)).rejects.toThrow()
    await fs.mkdir(project.cwd!)
    snapshot = { shared: null, local: undefined, conflict: true }
    await expect(planner().plan(request, nodeId)).rejects.toThrow('settings conflict')
  })

  it('uses each agent’s own approval dialect and stable supported provider session identity', async () => {
    settings.claudePermissionMode = 'auto'
    const claude = await planner().plan(agent(), nodeId)
    expect(claude.command).toContain('--permission-mode auto')
    expect(claude.node.agentSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(claude.node.agentSessionId).not.toBe(request.creationId)
    expect(claude.command).toContain('--session-id ' + claude.node.agentSessionId)
    expect((await planner().plan(agent(), nodeId)).node.agentSessionId).toBe(claude.node.agentSessionId)
    deps.claudeCaps = async () => UNKNOWN_CLAUDE_CLI_CAPS
    const oldClaude = await planner().plan(agent(), nodeId)
    expect(oldClaude.command).not.toContain('--permission-mode auto')
    expect(oldClaude.command).not.toContain('--session-id')
    settings.claudePermissionMode = 'auto'
    const codex = await planner().plan(agent('codex'), nodeId)
    expect(codex.command).toContain('--ask-for-approval on-request')
    expect(codex.command).not.toContain('untrusted')
    const grok = await planner().plan(agent('grok'), nodeId)
    expect(grok.command).toContain('--session-id ' + grok.node.agentSessionId)
    expect(grok.node.agentSessionId).not.toBe(claude.node.agentSessionId)
    for (const id of ['gemini', 'opencode', 'copilot'] as const) {
      expect((await planner().plan(agent(id), nodeId)).node.agentId).toBe(id)
    }
  })

  it('takes project permission policy before global policy and ignores phone-supplied model or mode', async () => {
    project.defaultPermissionMode = 'plan'
    settings.claudePermissionMode = 'bypassPermissions'
    expect((await planner().plan(agent(), nodeId)).command).toContain('--permission-mode plan')
    for (const patch of [{ model: 'injected' }, { permissionMode: 'bypassPermissions' }]) {
      await expect(planner().plan({ ...agent(), ...patch } as ManagedTerminalRequest, nodeId)).rejects.toThrow('Invalid')
    }
  })

  it('honors paired local/project-trusted launch overrides and rejects shared environment expansion', async () => {
    settings.agentLaunchCommands = { claude: 'global-wrapper claude' }
    snapshot = { shared: { version: 1, rev: 1, savedAt: '', agents: { defaultAgentId: 'claude', launchCmd: 'shared-wrapper claude' } }, local: undefined }
    expect((await planner().plan(agent(), nodeId)).command).toMatch(/^global-wrapper claude/)
    deps.trust.isTrusted = async () => true
    expect((await planner().plan(agent(), nodeId)).command).toMatch(/^shared-wrapper claude/)
    snapshot.local = { agents: { defaultAgentId: 'claude', launchCmd: 'local-wrapper claude' } }
    deps.trust.isTrusted = async () => false
    expect((await planner().plan(agent(), nodeId)).command).toMatch(/^local-wrapper claude/)
    snapshot.local.agents!.launchCmd = '${env:WRAPPER} claude'
    expect((await planner().plan(agent(), nodeId)).command).toMatch(/^global-wrapper claude/)
    snapshot.local.agents!.defaultAgentId = 'codex'
    snapshot.local.agents!.launchCmd = 'wrong-agent-wrapper'
    expect((await planner().plan(agent(), nodeId)).command).toMatch(/^global-wrapper claude/)
  })

  it('refuses missing real CLI, missing wrapper, unsupported shell and missing global expansion instead of defaulting', async () => {
    settings.agentLaunchCommands = { claude: 'available-wrapper claude' }
    deps.executable = async (bin) => bin === 'claude' ? null : bin
    await expect(planner().plan(agent(), nodeId)).rejects.toThrow('agent CLI')
    settings.agentLaunchCommands = { claude: 'missing-wrapper claude' }
    deps.executable = async (bin) => bin === 'missing-wrapper' ? null : bin
    await expect(planner().plan(agent(), nodeId)).rejects.toThrow('launcher')
    settings.agentLaunchCommands = { claude: '${env:ABSENT} claude' }
    deps.executable = async (bin) => bin
    await expect(planner().plan(agent(), nodeId)).rejects.toThrow('launch is unavailable')
    settings.defaultShell = 'python3'
    await expect(planner().plan(agent(), nodeId)).rejects.toThrow('cannot launch')
  })

  it('admits shared shell and environment only after trust, and invalidates an earlier trust verdict', async () => {
    snapshot = { shared: { version: 1, rev: 1, savedAt: '',
      agents: { env: { QA: 'shared-value' } }, terminal: { shell: '/bin/zsh' } }, local: undefined }
    const untrusted = await planner().plan(agent(), nodeId)
    expect(untrusted.options.shell).toBe('/bin/bash')
    deps.trust.isTrusted = async () => true
    expect(await planner().revalidate(agent(), untrusted)).toBe(false)
    const trusted = await planner().plan(agent(), nodeId)
    expect(trusted.options.shell).toBe('/bin/zsh')
    deps.trust.isTrusted = async () => false
    expect(await planner().revalidate(agent(), trusted)).toBe(false)
    snapshot.local = { terminal: { shell: '/bin/fish' } }
    expect((await planner().plan(agent(), nodeId)).options.shell).toBe('/bin/fish')
  })

  it('binds an explicitly frozen default or selected local account, color and directory without reading credentials', async () => {
    settings.claudeAccounts = [{ id: 'local', label: 'Local', createdAt: 1, color: '#112233' }]
    await fs.mkdir(path.join(root, 'claude-accounts', 'local'), { recursive: true })
    project.defaultAccountId = 'local'
    const req = { ...agent(), accountId: project.defaultAccountId }
    const plan = await planner().plan(req, nodeId)
    expect(plan.node).toMatchObject({ accountId: 'local', color: '#112233' })
    expect(plan.options.accountId).toBe('local')
    settings.claudeAccounts = []
    expect(await planner().revalidate(req, plan)).toBe(false)
    await expect(planner().plan({ ...agent(), accountId: 'local' }, nodeId)).rejects.toThrow('unavailable')
  })

  it('keeps an absent account as explicit System even when a project default is configured', async () => {
    project.defaultAccountId = 'local-default'
    settings.claudeAccounts = [{ id: 'local-default', label: 'Default', createdAt: 1 }]
    await fs.mkdir(path.join(root, 'claude-accounts', 'local-default'), { recursive: true })
    const plan = await planner().plan(agent(), nodeId)
    expect(plan.node.accountId).toBeUndefined()
    expect(plan.options.accountId).toBeUndefined()
    settings.claudeAccounts = []
    await expect(planner().plan({ ...agent(), accountId: project.defaultAccountId }, nodeId)).rejects.toThrow('unavailable')
  })

  it('refuses pending, remote, duplicate, missing-directory and other-agent accounts', async () => {
    const req = { ...agent(), accountId: 'local' }
    await fs.mkdir(path.join(root, 'claude-accounts', 'local'), { recursive: true })
    for (const rows of [[], [{ id: 'local', pending: true }], [{ id: 'local', host: 'remote' }], [{ id: 'local' }, { id: 'local' }]]) {
      settings.claudeAccounts = rows as Settings['claudeAccounts']
      await expect(planner().plan(req, nodeId)).rejects.toThrow()
    }
    settings.claudeAccounts = [{ id: 'local', label: 'Local', createdAt: 1 }]
    await fs.rm(path.join(root, 'claude-accounts', 'local'), { recursive: true })
    await expect(planner().plan(req, nodeId)).rejects.toThrow()
    await expect(planner().plan({ ...agent('gemini'), accountId: 'local' }, nodeId)).rejects.toThrow('cannot use')
    settings.codexAccounts = [{ id: 'codex-local', label: 'C', color: '#abcdef' }]
    await fs.mkdir(path.join(root, 'codex-test', 'codex-local'), { recursive: true })
    expect((await planner().plan({ ...agent('codex'), accountId: 'codex-local' }, nodeId)).node.color).toBe('#abcdef')
  })

  it('keeps a valid linked account and refuses malformed linked paths rather than selecting a managed fallback', async () => {
    const linked = path.join(root, 'linked')
    await fs.mkdir(linked)
    await fs.mkdir(path.join(root, 'claude-accounts', 'linked'), { recursive: true })
    settings.claudeAccounts = [{ id: 'linked', label: 'Linked', createdAt: 1, configDir: linked }]
    expect((await planner().plan({ ...agent(), accountId: 'linked' }, nodeId)).options.accountId).toBe('linked')
    settings.claudeAccounts[0].configDir = '../wrong'
    await expect(planner().plan({ ...agent(), accountId: 'linked' }, nodeId)).rejects.toThrow('linked account')
  })

  it('uses the actual shared Codex launcher path and host default gateway model', async () => {
    deps.codexIdentity = async () => ({ shared: true, launcherPath: '/generated/nodeterm-codex' })
    deps.executable = async (bin) => bin === 'nodeterm-codex' ? null : bin
    settings.agentLaunchMode = 'gateway-model'
    settings.modelGatewayDefaultModel = 'host-model'
    const plan = await planner().plan(agent('codex'), nodeId)
    expect(plan.command).toMatch(/^nodeterm-codex /)
    expect(plan.command).toContain("--model 'host-model'")
    expect(plan.node.agentModel).toBe('host-model')
    deps.executable = async (bin) => bin.startsWith('/generated/') ? null : bin
    await expect(planner().plan(agent('codex'), nodeId)).rejects.toThrow('shared Codex launcher')
    settings.agentLaunchMode = 'subscription'
    deps.codexIdentity = async () => ({ shared: false, launcherPath: null })
    expect((await planner().plan(agent('codex'), nodeId)).node.agentModel).toBeUndefined()
  })

  it('revalidates environment and shell trust changes, account/folder replacement and host policy changes', async () => {
    snapshot = { shared: null, local: { agents: { env: { QA: 'before' } }, terminal: { shell: '/bin/bash' } } }
    const plan = await planner().plan(agent(), nodeId)
    snapshot.local!.agents!.env!.QA = 'after'
    expect(await planner().revalidate(agent(), plan)).toBe(false)
    snapshot.local!.agents!.env!.QA = 'before'
    settings.claudePermissionMode = 'plan'
    expect(await planner().revalidate(agent(), plan)).toBe(false)
    settings.claudePermissionMode = DEFAULT_SETTINGS.claudePermissionMode
    await fs.rename(project.cwd!, project.cwd! + '-old')
    await fs.mkdir(project.cwd!)
    expect(await planner().revalidate(agent(), plan)).toBe(false)
  })

  it('keeps the policy fence after appending its own node while rejecting a closed or missing owner', async () => {
    const plan = await planner().plan(agent(), nodeId)
    project.nodes.push(plan.node)
    expect(await planner().revalidate(agent(), plan)).toBe(true)
    project.closed = true
    expect(await planner().revalidate(agent(), plan)).toBe(false)
    project.closed = false
    workspace.projects = []
    expect(await planner().revalidate(agent(), plan)).toBe(false)
    expect(await planner().revalidate(agent(), { ...plan, validation: undefined })).toBe(false)
  })

  for (const surface of ['main', 'server']) {
    it(`${surface} startup waits for ownership and wires supported tmux creation, verification and host policy`, async () => {
      const source = await fs.readFile(new URL(`../${surface}/index.ts`, import.meta.url), 'utf8')
      const at = source.indexOf('const managedPlanner = createManagedTerminalPlanner(')
      expect(at).toBeGreaterThan(0)
      expect(source.lastIndexOf('await workspaceStore.load(', at)).toBeGreaterThan(0)
      if (surface === 'main') expect(source.slice(at - 200, at)).toContain('await workspaceStore.load({ sideline: false })')
      const wiring = source.slice(at, source.indexOf('managedTerminals)', at) + 'managedTerminals)'.length)
      for (const needed of ['store: workspaceStore', 'settings: () => settingsStore.get()', 'trust: projectTrustStore',
        'executable: findInLoginPath', 'sessionShell: resolveLocalSessionShell', 'claudeCaps: claudeCliCaps',
        'codexCaps: codexCliCaps', 'grokCaps: grokCliCaps', 'codexIdentity: codexIdentityCaps',
        'ptyManager.supportsManagedCreation() ? new ManagedTerminals(',
        'supported: () => ptyManager.supportsManagedCreation(), ...managedPlanner,\n      create:',
        'ptyManager.createManagedHeadless(options, creationId, current)',
        'ptyManager.verifyManagedPane(receipt, current)', 'ptyManager.deliverManagedLaunch(receipt, command, current)']) {
        expect(wiring, needed).toContain(needed)
      }
      expect(wiring).toContain(surface === 'main' ? 'hostBridge.nodeActions, true, managedTerminals)' : 'undefined, false, managedTerminals)')
    })
  }
})
