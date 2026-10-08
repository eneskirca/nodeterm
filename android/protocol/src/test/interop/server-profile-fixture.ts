// Actual Server config/platform/store/mirror/actions producer. Full startServer is NOT invoked:
// no hook listener, installed hooks, CLI/account probing or user services. The plain-shell plan
// and create/verify boundary below are fixture scaffolding around real private tmux, not PtyManager.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveConfig } from '../../../../../src/server/config'
import { ServerPlatform } from '../../../../../src/server/platform-server'
import { initPlatform } from '../../../../../src/core/platform'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { initAgentStatusMirror, recordAgentEvent, flush, setMirrorServerProvider } from '../../../../../src/core/agent-status-mirror'
import { ManagedTerminals, type ManagedTerminalPlan } from '../../../../../src/core/managed-terminals'
import { SshActionsService } from '../../../../../src/core/ssh-actions'
import { MANAGED_PANE_FORMAT, parseManagedPane, readManagedProcessBirth, sameManagedPane } from '../../../../../src/core/managed-pane'
import type { ManagedPaneReceipt } from '../../../../../src/shared/managed-terminal'
import type { PtyCreateOptions, Workspace } from '../../../../../src/shared/types'

const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }
const run = promisify(execFile)
async function main(): Promise<void> {
  if (process.argv[2] !== 'server-profile' || !process.env.FIXTURE_USERDATA || !process.env.FIXTURE_HOME ||
      !process.env.FIXTURE_TMUX_DIR || !process.env.FIXTURE_TMUX_BIN) throw new Error('Server fixture inputs missing')
  const home = path.resolve(process.env.FIXTURE_HOME), userData = path.resolve(process.env.FIXTURE_USERDATA)
  const tmuxDirectory = path.resolve(process.env.FIXTURE_TMUX_DIR)
  if (os.homedir() !== home || !userData.startsWith(home + path.sep) || !tmuxDirectory.startsWith(path.dirname(home) + path.sep) ||
      tmuxDirectory === home || tmuxDirectory === userData) throw new Error('Server fixture scope changed')
  const tmuxStat = await fs.lstat(tmuxDirectory)
  if (!tmuxStat.isDirectory() || tmuxStat.isSymbolicLink() || tmuxStat.uid !== process.getuid?.()) throw new Error('Private tmux directory unavailable')
  const tmuxBin = await fs.realpath(process.env.FIXTURE_TMUX_BIN)
  const tmuxEnv = { PATH: '/usr/bin:/bin', TMUX_TMPDIR: tmuxDirectory, LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' }
  const tmux = async (args: string[]): Promise<string> => (await run(tmuxBin, ['-L', 'node-terminal', ...args], { env: tmuxEnv, timeout: 5000 })).stdout
  const config = { ...resolveConfig({ NODETERM_HEADLESS: '1' }, ['--data-dir', userData]), installHooks: false }
  if (config.dataDir !== userData || !config.headless || config.installHooks !== false) throw new Error('Actual Server config disagreed')
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  const defaultData = path.join(home, '.config/node-terminal'), defaultCwd = path.join(home, 'server-default-project')
  const cwd = path.join(home, 'server-custom-project')
  await fs.mkdir(defaultCwd, { mode: 0o700 }); await fs.mkdir(cwd, { mode: 0o700 })
  const workspace = (id: string, name: string, projectCwd: string, nodeId: string): Workspace => ({
    version: 2, activeProjectId: id, projects: [{ id, name, cwd: projectCwd, color: '#0a84ff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: nodeId, kind: 'terminal', title: name,
        color: '#0a84ff', group: null, cwd: projectCwd, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }] }]
  })
  // Both profiles are genuine WorkspaceStore publications; no hand-written workspace/project blob.
  await fs.mkdir(defaultData, { recursive: true, mode: 0o700 })
  initPlatform(new ServerPlatform({ userDataDir: defaultData, appVersion: 'fixture' }))
  await new WorkspaceStore().save(workspace('server-default', 'Default desktop', defaultCwd, 'term-server-default'))
  const platform = new ServerPlatform({ userDataDir: config.dataDir, appVersion: 'fixture' }); initPlatform(platform)
  const store = new WorkspaceStore(); await store.save(workspace('server-custom', 'Custom server', cwd, 'term-server-seed'))
  await store.load({ sideline: false })
  initAgentStatusMirror()
  setMirrorServerProvider(() => ({ version: 'fixture-custom', commit: 'custom-profile' }))
  recordAgentEvent({ nodeId: 'term-server-seed', agentId: 'claude', kind: 'state', state: 'done' })
  await flush()
  const created: ManagedPaneReceipt[] = []
  const read = async (r: Pick<ManagedPaneReceipt, 'creationId' | 'session' | 'nodeId' | 'projectId'>): Promise<ManagedPaneReceipt> => {
    const raw = await tmux(['list-panes', '-s', '-t', '=' + r.session, '-F', MANAGED_PANE_FORMAT])
    const pane = parseManagedPane(raw, r)
    if (!pane) throw new Error('Owned fixture pane identity changed')
    return { version: 1, ...r, socket: 'node-terminal', ...pane, paneBirth: await readManagedProcessBirth(pane.panePid) }
  }
  const coordinator = new ManagedTerminals(userData, store, {
    supported: () => true,
    plan: async (request, nodeId): Promise<ManagedTerminalPlan> => {
      const target = store.projectTargetInfo(request.projectId)
      if (request.kind !== 'shell' || request.projectId !== 'server-custom' || target?.cwd !== cwd || target.ssh)
        throw new Error('Only the fixture owned plain-shell project is supported')
      const node = { id: nodeId, kind: 'terminal' as const, title: request.title ?? 'Managed shell', cwd,
        shell: '/bin/sh', color: '#0a84ff', group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }
      return { node, options: { persistKey: nodeId, ownerProjectId: request.projectId, cwd, shell: '/bin/sh', cols: request.cols, rows: request.rows } }
    },
    revalidate: async (request, plan) => request.projectId === 'server-custom' && store.projectTargetInfo(request.projectId)?.cwd === cwd && plan.node.cwd === cwd,
    create: async (options: PtyCreateOptions, creationId, current) => {
      if (!current() || options.ownerProjectId !== 'server-custom' || options.cwd !== cwd || !options.persistKey) throw new Error('Fixture create admission changed')
      const session = 'nt-' + options.persistKey
      await tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', cwd, '-x', String(options.cols), '-y', String(options.rows),
        '-e', 'NODETERM_MANAGED_CREATION_ID=' + creationId, '/usr/bin/env', 'ENV=', 'BASH_ENV=', 'INPUTRC=/dev/null', '/bin/sh'])
      const receipt = await read({ creationId, session, nodeId: options.persistKey, projectId: 'server-custom' })
      created.push(receipt); return receipt
    },
    verify: async (r, current) => current() && sameManagedPane(r, await read(r)),
    deliver: async () => { throw new Error('The plain-shell fixture must never deliver an agent command') }
  })
  const service = new SshActionsService(userData, store, undefined, false, coordinator)
  await service.start()
  emit({ ready: true, userData, cwd, projectId: 'server-custom', nodeId: 'term-server-seed', defaultData,
    boundary: 'actual Server config/platform/store/mirror/file service; fixture plain-shell plan/native tmux boundary; no full boot/hooks' })
  const lines = readline.createInterface({ input: process.stdin })
  try {
    for await (const line of lines) {
      if (line === 'snapshot') emit({ event: 'snapshot', created,
        file: JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')),
        defaultFile: JSON.parse(await fs.readFile(path.join(defaultCwd, '.nodeterm/project.json'), 'utf8')) })
      else if (line === 'stop') { await service.stop(); emit({ event: 'stopped' }) }
      else throw new Error('Unknown Server fixture driver command')
    }
  } finally {
    await service.stop()
    // Exact recorded sessions only. The surrounding SSH fixture owns its socket/server teardown.
    for (const pane of created) await tmux(['kill-session', '-t', '=' + pane.session]).catch(() => {})
  }
}
void main().catch(error => { emit({ event: 'fatal', message: String(error) }); process.exit(1) })
