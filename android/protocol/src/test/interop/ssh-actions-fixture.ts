// Real SSH companion producer, WorkspaceStore save chain and filesystem transport. No sockets,
// Electron, credential/token files, user profile, project launch or native PTY execution.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { initPlatform } from '../../../../../src/core/platform'
import { fakePlatform } from '../../../../../src/core/platform-fake'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { SshActionsService } from '../../../../../src/core/ssh-actions'
import type { Workspace } from '../../../../../src/shared/types'

const emit = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n') }
async function main(): Promise<void> {
  if (process.argv[2] !== 'ssh-actions' || !process.env.FIXTURE_USERDATA || !process.env.FIXTURE_HOME || process.env.HOME !== process.env.FIXTURE_HOME) throw new Error('SSH actions fixture needs a private home and selected profile')
  const userData = path.resolve(process.env.FIXTURE_USERDATA)
  const home = path.resolve(process.env.FIXTURE_HOME)
  if (!userData.startsWith(home + path.sep)) throw new Error('SSH actions fixture profile must be inside its private home')
  await fs.mkdir(userData, { recursive: true, mode: 0o700 })
  const fake = fakePlatform({ userDataDir: userData }); initPlatform(fake)
  const cwd = path.join(home, 'ssh-actions-project')
  await fs.mkdir(cwd, { mode: 0o700 })
  const store = new WorkspaceStore()
  const workspace: Workspace = { version: 2, activeProjectId: 'ssh-actions-project', projects: [{
    id: 'ssh-actions-project', name: 'SSH Board', cwd, color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'term-ssh-actions', kind: 'terminal', title: 'Synthetic', color: '#0a84ff', group: null,
      position: { x: 0, y: 0 }, size: { width: 80, height: 24 } }]
  }] }
  await store.save(workspace)
  const nudges: Array<{ method: string; nodeId: string; title?: string }> = []
  const deliver = (method: string, nodeId: string, title?: string): boolean => {
    const nudge = { method, nodeId, ...(title !== undefined ? { title } : {}) }; nudges.push(nudge)
    emit({ event: 'node-action', ...nudge }); return true
  }
  let service = new SshActionsService(userData, store, {
    wake: (id) => deliver('wake', id), refresh: (id) => deliver('refresh', id), rename: (id, title) => deliver('rename', id, title)
  })
  await service.start()
  const ready = (): void => emit({ ready: true, userData, cwd, projectId: 'ssh-actions-project', nodeId: 'term-ssh-actions', advertisement: path.join(service.root, 'advertisement.json'), instanceDir: service.directory })
  ready()
  const lines = readline.createInterface({ input: process.stdin })
  // The test driver controls reads/restart only; it never bypasses the production request handler.
  for await (const line of lines) {
    if (line === 'snapshot') emit({ event: 'snapshot', file: JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')), broadcasts: fake.sent, nudges })
    else if (line === 'restart') {
      await service.stop()
      service = new SshActionsService(userData, store, { wake: (id) => deliver('wake', id), refresh: (id) => deliver('refresh', id), rename: (id, title) => deliver('rename', id, title) })
      await service.start(); emit({ event: 'restarted', advertisement: path.join(service.root, 'advertisement.json'), instanceDir: service.directory })
    } else if (line === 'stop') { await service.stop(); emit({ event: 'stopped' }) }
    else throw new Error('Unknown fixture driver command')
  }
  await service.stop()
}
void main().catch((error) => { emit({ event: 'fatal', message: String(error) }); process.exitCode = 1 })
