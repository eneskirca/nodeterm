// Real managed launch producer/client contract: WorkspaceStore's settings.json reader + recorded
// family trust -> PtyManager's actual environment/shell builder -> encrypted relay -> Android.
// Only native PTY execution/login PATH/os.home are boundary recorders (bundle-fixture.cjs).
import fs from 'node:fs'
import os from 'os'
import path from 'node:path'
import { startBroker } from './host-fixture'
import { platform } from '../../../../../src/core/platform'
import { PtyManager } from '../../../../../src/core/pty-manager'
import { WorkspaceStore } from '../../../../../src/core/workspace-store'
import { ProjectTrustStore, localTrustKey, hashTrustContent } from '../../../../../src/core/project-trust-store'
import { projectTrustContent, type ProjectSettingsFileV1 } from '../../../../../src/shared/project-settings'
import { makeProjectSpawnOverrides } from '../../../../../src/core/project-spawn-overrides'
import { DEFAULT_SETTINGS, type Workspace } from '../../../../../src/shared/types'
import { createHostNewSessions } from '../../../../../src/main/remote/host-new-sessions'
import { connectHostSession } from '../../../../../src/main/remote/host-service'
import { genKeyPair, publicKeyToB64 } from '../../../../../src/main/remote/e2ee'

const emit = (event: unknown): void => { process.stdout.write(JSON.stringify(event) + '\n') }
async function main(): Promise<void> {
  if (process.argv[2] !== 'project-launch' || !process.env.FIXTURE_USERDATA) throw new Error('launch fixture scope missing')
  fs.mkdirSync(os.homedir(), { recursive: true })
  const cwd = path.join(platform().userDataDir, 'launch-project')
  const sub = path.join(cwd, 'sub')
  fs.mkdirSync(sub, { recursive: true })
  const store = new WorkspaceStore()
  const workspace: Workspace = { version: 2, activeProjectId: 'launch-project', projects: [{
    id: 'launch-project', name: 'Launch', cwd, color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: 'term-settings-saved', kind: 'terminal', title: 'Saved', cwd: sub, agentId: 'claude',
      color: '#0a84ff', group: null, position: { x: 0, y: 0 }, size: { width: 80, height: 24 } }]
  }] }
  await store.save(workspace)
  const doc: ProjectSettingsFileV1 = { version: 1, rev: 1, savedAt: 'fixture',
    agents: { env: { A72_PROJECT_ENV: 'trusted-project' } }, terminal: { shell: '/bin/sh' } }
  fs.writeFileSync(path.join(cwd, '.nodeterm', 'settings.json'), JSON.stringify(doc))
  const trust = new ProjectTrustStore()
  if (process.env.FIXTURE_LAUNCH_TRUSTED === '1') {
    for (const family of ['agents', 'shell'] as const) {
      const content = projectTrustContent(family, doc)
      if (content === null) throw new Error('fixture trust family has no content')
      await trust.record(localTrustKey(cwd), family, hashTrustContent(content), 'fixture')
    }
  }
  const pty = new PtyManager()
  // Pin the ordinary plain-shell leg even if the developer has a built session-host bundle.
  pty.init(() => ({ ...DEFAULT_SETTINGS, tmuxEnabled: false }))
  pty.setProjectSpawnOverrides(makeProjectSpawnOverrides({
    readSettings: (id) => store.readProjectSettings(id),
    targetInfo: (id) => store.projectTargetInfo(id), trust,
    requestTrust: (projectId, family) => emit({ event: 'launch-trust', projectId, family })
  }))
  const keys = genKeyPair()
  const port = await startBroker()
  connectHostSession({
    url: `ws://127.0.0.1:${port}`, token: 'host-room', ourKeys: keys, pty,
    getLatestCanvas: () => null, subscribeCanvas: () => () => {}, applyMutation: () => {},
    newSessions: createHostNewSessions({
      projectTargetInfo: (id) => store.projectTargetInfo(id), claudeAccounts: () => [],
      persistedCanvases: () => store.persistedCanvases()
    }),
    onPeerReady: (session) => { session.approve() }, onClose: () => {}
  })
  emit({ ready: true, relayUrl: `ws://127.0.0.1:${port}`, clientToken: 'client-room',
    hostPublicKeyB64: publicKeyToB64(keys.publicKey), projectCwd: cwd, savedCwd: sub })
}
void main().catch((error) => { emit({ event: 'fatal', message: String(error) }); process.exit(1) })
