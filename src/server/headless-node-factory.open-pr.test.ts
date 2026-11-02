// Server Edition `open-pr`: the agent that made a PR opens it as a pull request node beside itself,
// joined by a context link. Open-only, idempotent, and the repository comes from the host.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Workspace } from '../shared/types'
import { HeadlessNodeFactory, type HeadlessPty } from './headless-node-factory'
import { createServerEditionControlHandler } from './control-unsupported'

const noPty = {
  persistentSpawnAvailable: () => true,
  onOutput: () => () => {},
  writeHeadless: () => false,
  releaseHeadless: () => {},
  createHeadless: async () => { throw new Error('open-pr must not spawn anything') },
  paneCommand: async () => null,
  sessionExists: async () => false,
  sendText: async () => false,
  destroySession: async () => {}
} as unknown as HeadlessPty

const source: CanvasNodeState = {
  id: 'term-source',
  kind: 'terminal',
  position: { x: 20, y: 30 },
  size: { width: 640, height: 440 },
  title: 'Director',
  color: '#d97757',
  group: null,
  tags: [],
  agentId: 'claude'
}

describe('Server Edition open-pr', () => {
  let dataDir = ''
  let store: WorkspaceStore
  let factory: HeadlessNodeFactory
  let repo: { repository?: string; approved: boolean } | undefined

  const project = async () => (await store.load({ sideline: false })).projects[0]

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-open-pr-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    repo = { repository: 'acme/app', approved: true }
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: noPty,
      settings: () => DEFAULT_SETTINGS,
      cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
      codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
      codexSharedIdentity: async () => false,
      stateOf: () => undefined,
      pullRepository: async () => repo
    })
    const projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1', name: 'Test', color: '#0a84ff', cwd: projectDir,
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [source], bridges: [], ropes: []
      }]
    }
    await store.save(workspace)
  })

  afterEach(() => {
    factory.stop()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('places a pull node beside the agent, records openedBy, and context-links them', async () => {
    const reply = await factory.openPr('term-source', { pr: '42' }, true)
    expect(reply).toMatchObject({ ok: true, result: { created: true } })
    const p = await project()
    const pull = p.nodes.find((n) => n.kind === 'pull')!
    expect(pull.pull).toEqual({ repository: 'acme/app', pullNumber: 42, tab: 'overview' })
    expect(pull.openedBy).toBe('term-source')
    expect(pull.position.x).toBeGreaterThan(source.position.x + source.size!.width)
    expect(p.bridges).toEqual([expect.objectContaining({ source: 'term-source', target: pull.id })])
    expect((reply as { result: { id: string } }).result.id).toBe(pull.id)
  })

  it('is idempotent: a second call links the existing node and adds none', async () => {
    const first = await factory.openPr('term-source', { pr: '42' }, true)
    const second = await factory.openPr('term-source', { pr: '#42' }, true)
    expect(second).toMatchObject({ ok: true, result: { created: false, id: (first as { result: { id: string } }).result.id } })
    const p = await project()
    expect(p.nodes.filter((n) => n.kind === 'pull')).toHaveLength(1)
    expect(p.bridges).toHaveLength(1)
  })

  it('refuses with nothing written when the project has no approved repository', async () => {
    repo = { repository: 'acme/app', approved: false }
    const reply = await factory.openPr('term-source', { pr: '42' }, true)
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('open-pr-no-repo') })
    expect((await project()).nodes).toHaveLength(1)
  })

  it('reaches the factory through the Server Edition handler, which refuses a repository flag first', async () => {
    const handler = createServerEditionControlHandler({
      openPr: (nodeId: string, args: Record<string, string>, verified: boolean) => factory.openPr(nodeId, args, verified)
    } as never)
    const refused = await handler({ verb: 'open-pr', nodeId: 'term-source', args: { pr: '1', repository: 'x/y' }, verified: true })
    expect(refused).toMatchObject({ ok: false, error: 'open-pr: unknown flag --repository' })
    const ok = await handler({ verb: 'open-pr', nodeId: 'term-source', args: { pr: '1' }, verified: true })
    expect(ok.ok).toBe(true)
  })
})
