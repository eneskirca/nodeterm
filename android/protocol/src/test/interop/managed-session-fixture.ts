// Real Kotlin request -> selected-profile SshActionsService -> ManagedTerminals -> host planner
// -> WorkspaceStore save chain and PtyManager create/verify/deliver. The managed-native recorder
// replaces only native PTY/tmux/foreground probes and login-PATH discovery. No shell/CLI runs;
// the separate real native-Pty/tmux runtime gate is required before release claims.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { initPlatform } from '../../../../../src/core/platform'
import { fakePlatform } from '../../../../../src/core/platform-fake'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { ProjectTrustStore, localTrustKey, hashTrustContent } from '../../../../../src/core/project-trust-store'
import { makeProjectSpawnOverrides } from '../../../../../src/core/project-spawn-overrides'
import { projectTrustContent, type ProjectSettingsFileV1 } from '../../../../../src/shared/project-settings'
import { DEFAULT_SETTINGS, UNKNOWN_CLAUDE_CLI_CAPS, UNKNOWN_CODEX_CLI_CAPS, UNKNOWN_GROK_CLI_CAPS, type Workspace } from '../../../../../src/shared/types'
import { createManagedTerminalPlanner } from '../../../../../src/core/managed-terminal-plan'
import { ManagedTerminals } from '../../../../../src/core/managed-terminals'
import { PtyManager, resolveLocalSessionShell } from '../../../../../src/core/pty-manager'
import { registerClaudeAccountsSource } from '../../../../../src/core/claude-config-dir'
import { SshActionsService } from '../../../../../src/core/ssh-actions'
import { nativeProof } from './managed-native'

const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }
async function main(): Promise<void> {
  if (process.argv[2] !== 'managed-session' || !process.env.FIXTURE_USERDATA || !process.env.FIXTURE_HOME)
    throw new Error('managed session fixture needs a private selected profile')
  const userData = path.resolve(process.env.FIXTURE_USERDATA), home = path.resolve(process.env.FIXTURE_HOME)
  if (!userData.startsWith(home + path.sep)) throw new Error('managed session profile must be inside its private home')
  await fs.mkdir(os.homedir(), { recursive: true, mode: 0o700 })
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  const platform = fakePlatform({ userDataDir: userData }); initPlatform(platform)
  const cwd = path.join(home, 'managed-project'); await fs.mkdir(cwd, { mode: 0o700 })
  const store = new WorkspaceStore()
  const projectId = 'managed-project'
  const workspace: Workspace = { version: 2, activeProjectId: projectId, projects: [{ id: projectId,
    name: 'Managed', cwd, color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    defaultPermissionMode: 'auto', defaultAccountId: 'fixture-account' }] }
  await store.save(workspace)
  const document: ProjectSettingsFileV1 = { version: 1, rev: 1, savedAt: 'fixture',
    agents: { defaultAgentId: 'claude', launchCmd: 'trusted-wrapper claude', env: { MANAGED_TEST_ENV: 'trusted' } },
    terminal: { shell: '/bin/sh' } }
  await fs.writeFile(path.join(cwd, '.nodeterm/settings.json'), JSON.stringify(document))
  const trust = new ProjectTrustStore()
  if (process.env.FIXTURE_MANAGED_TRUSTED === '1') for (const family of ['agents', 'shell'] as const) {
    const content = projectTrustContent(family, document)
    if (content === null) throw new Error('fixture trust family has no content')
    await trust.record(localTrustKey(cwd), family, hashTrustContent(content), 'fixture')
  }
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.tmuxEnabled = true; settings.defaultShell = '/bin/bash'
  settings.claudePermissionMode = 'bypassPermissions'
  settings.agentLaunchCommands = { claude: 'global-wrapper claude' }
  settings.claudeAccounts = [{ id: 'fixture-account', label: 'Fixture', color: '#123abc', createdAt: 1 }]
  await fs.mkdir(path.join(userData, 'claude-accounts/fixture-account'), { recursive: true, mode: 0o700 })
  registerClaudeAccountsSource(() => settings.claudeAccounts)
  const pty = new PtyManager(); pty.init(() => settings)
  pty.setProjectSpawnOverrides(makeProjectSpawnOverrides({ readSettings: (id) => store.readProjectSettings(id),
    targetInfo: (id) => store.projectTargetInfo(id), trust }))
  const planner = createManagedTerminalPlanner({ store, userData, settings: () => settings, trust,
    executable: async (program) => ['/bin/sh', '/bin/bash', 'claude', 'trusted-wrapper', 'global-wrapper'].includes(program) ? program : null,
    sessionShell: resolveLocalSessionShell,
    claudeCaps: async () => ({ ...UNKNOWN_CLAUDE_CLI_CAPS, autoPermissionMode: true, sessionIdFlag: true }),
    codexCaps: async () => UNKNOWN_CODEX_CLI_CAPS, grokCaps: async () => UNKNOWN_GROK_CLI_CAPS,
    codexIdentity: async () => ({ shared: false, launcherPath: null }), env: {} })
  const coordinator = (): ManagedTerminals => new ManagedTerminals(userData, store, {
    supported: () => pty.supportsManagedCreation(), ...planner,
    create: async (options, creationId, current) => {
      try { return await pty.createManagedHeadless(options, creationId, current) }
      catch (error) { console.error('[managed native recorder failure]', String(error)); throw error }
    },
    verify: (receipt, current) => pty.verifyManagedPane(receipt, current),
    deliver: (receipt, command, current) => pty.deliverManagedLaunch(receipt, command, current) })
  await store.load({ sideline: false })
  let service = new SshActionsService(userData, store, undefined, false, coordinator())
  await service.start()
  if (!pty.supportsManagedCreation()) throw new Error('managed native recorder was not installed')
  emit({ ready: true, userData, cwd, projectId, nativeBoundary: 'managed-native-recorder',
    recorderPid: process.pid, advertisement: path.join(service.root, 'advertisement.json') })
  const lines = readline.createInterface({ input: process.stdin })
  for await (const line of lines) {
    if (line === 'snapshot') emit({ event: 'snapshot', file: JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')),
      native: nativeProof(), broadcasts: platform.sent })
    else if (line === 'restart') {
      await service.stop(); service = new SshActionsService(userData, store, undefined, false, coordinator())
      await service.start(); emit({ event: 'restarted' })
    } else if (line === 'stop') { await service.stop(); emit({ event: 'stopped' }) }
    else throw new Error('Unknown managed fixture driver command')
  }
  await service.stop()
}
void main().catch((error) => { emit({ event: 'fatal', message: String(error) }); process.exit(1) })
