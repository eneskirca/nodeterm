import fs from 'node:fs'
import { StationHandoverTracker } from '../core/station-handover'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { createCanvasAuthority } from '../core/canvas-authority'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from '../core/canvas-sync'
import type { AgentState } from '../shared/agents/normalize'
import { MAX_LAUNCH_LINE_BYTES } from '../shared/canonical-line'
import { RUN_NOW_AFTER_REFUSAL } from '../shared/control-verbs'
import { RUN_NOW_AFTER_SUCCESS_REFUSAL, type StationOutcomeRecord } from '../shared/station-outcome'
import {
  DEFAULT_SETTINGS,
  type CanvasMutation,
  type CanvasNodeState,
  type Project,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  launchFailedError,
  type HeadlessNodeFactoryDeps,
  type HeadlessNodeOwnership,
  type HeadlessPty,
  type HeadlessWorkspace
} from './headless-node-factory'

class FakePty implements HeadlessPty {
  readonly creates: PtyCreateOptions[] = []
  readonly sends: Array<{ nodeId: string; text: string }> = []
  readonly destroys: Array<{
    clientId: number | null
    nodeId: string
    everySocket: boolean | undefined
    wasLive: boolean
  }> = []
  readonly live = new Set<string>()
  readonly alreadyDead = new Set<string>()
  readonly released: string[] = []
  private readonly taps = new Map<string, Set<(c: string) => void>>()
  private readonly lines = new Map<string, string>()

  persistentSpawnAvailable(): boolean {
    return true
  }

  onOutput(key: string, cb: (c: string) => void): () => void {
    let set = this.taps.get(key)
    if (!set) this.taps.set(key, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }

  // An interactive shell: echoes what it is typed; Enter submits the line (recorded in `sends`,
  // so every pre-existing `pty.sends` assertion keeps its meaning); Ctrl-U / Esc clear it.
  writeHeadless(key: string, data: string): boolean {
    if (!this.live.has(key)) return false
    if (data === '\r') {
      this.sends.push({ nodeId: key, text: this.lines.get(key) ?? '' })
      this.lines.set(key, '')
      return true
    }
    if (data === '\x15' || data === '\x1b') {
      this.lines.set(key, '')
      return true
    }
    this.lines.set(key, (this.lines.get(key) ?? '') + data)
    for (const cb of [...(this.taps.get(key) ?? [])]) cb(data)
    return true
  }

  releaseHeadless(key: string): void {
    this.released.push(key)
  }

  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.creates.push(options)
    if (options.persistKey) this.live.add(options.persistKey)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }

  async paneCommand(): Promise<string | null> { return 'bash' }

  async sessionExists(persistKey: string): Promise<boolean> {
    return this.live.has(persistKey)
  }

  async sendText(nodeId: string, text: string): Promise<boolean> {
    this.sends.push({ nodeId, text })
    return true
  }

  async destroySession(
    clientId: number | null,
    nodeId: string,
    opts?: { everySocket?: boolean }
  ): Promise<void> {
    const wasLive = this.live.delete(nodeId)
    this.destroys.push({ clientId, nodeId, everySocket: opts?.everySocket, wasLive })
    this.alreadyDead.add(nodeId)
  }

  killOutOfBand(nodeId: string): void {
    this.live.delete(nodeId)
    this.alreadyDead.add(nodeId)
  }
}

const terminal = (
  id: string,
  title: string,
  agentId: 'claude' | 'codex' | 'gemini' = 'claude',
  x = 20
): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 30 },
  size: { width: 640, height: 440 },
  title,
  color: '#d97757',
  group: null,
  tags: [],
  agentId
})

describe('launchFailedError (#925)', () => {
  it('groups ids by reason, says what each reason means, and keeps the launch-failed prefix', () => {
    const msg = launchFailedError(
      [
        { id: 'a', reason: 'no-shell', retained: true },
        { id: 'b', reason: 'line-too-long', retained: true },
        { id: 'c', reason: 'no-shell', retained: true },
        { id: 'd', reason: 'spawn-failed', retained: false }
      ],
      'open-agent'
    )
    expect(msg).toMatch(/^launch-failed: node\(s\) a, b, c, d were persisted/)
    expect(msg).toContain('no-shell: a, c (launch retained for Run now in the node)')
    expect(msg).toContain('line-too-long: b (the launch line is longer than a terminal line takes, so Run now will fail the same way; shorten the prompt)')
    // A plain terminal that never spawned held no launch: promising Run now would be false.
    expect(msg).toContain('spawn-failed: d (no launch was held)')
    expect(msg).toMatch(/; do not repeat the open request$/)
  })

  it('an open-terminal --cmd that is too long is a command, not a prompt', () => {
    expect(launchFailedError([{ id: 't', reason: 'line-too-long', retained: true }], 'open-terminal')).toContain(
      'shorten the command'
    )
  })
})

describe('HeadlessNodeFactory', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: FakePty
  let states: Record<string, AgentState | undefined>
  let published: CanvasNodeState[]
  let removed: string[]
  let publishedProjects: Workspace['projects']
  let factory: HeadlessNodeFactory
  let ownership: HeadlessNodeOwnership
  let codexSharedIdentity: boolean
  let codexApprovalValues: { approvalValues: string[] | null }
  let outcomes: Record<string, StationOutcomeRecord>
  /** Stations with unfinished handed-over work (core/station-handover.ts), as the tracker answers. */
  let handedOver: Set<string>

  const settings = (): Settings => ({
    ...DEFAULT_SETTINGS,
    // Makes command expectations independent of the local Claude version probe.
    claudePermissionMode: 'manual'
  })

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-headless-factory-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    pty = new FakePty()
    states = {}
    outcomes = {}
    handedOver = new Set()
    published = []
    removed = []
    publishedProjects = []
    codexSharedIdentity = false
    codexApprovalValues = { approvalValues: ['on-request', 'never'] }
    ownership = createHeadlessNodeOwnership()
    ownership.record('term-upstream', {
      sourceNodeId: 'term-source',
      projectId: 'project-1'
    })
    ownership.record('term-owned', {
      sourceNodeId: 'term-source',
      projectId: 'project-1'
    })
    const initial: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Test',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            terminal('term-source', 'Director'),
            terminal('term-upstream', 'Upstream', 'codex', 80),
            terminal('term-owned', 'Owned', 'gemini', 900)
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    await store.save(initial)
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false
      }),
      // Stated, not defaulted — the required fields are what stop a probe being forgotten.
      // `models: []` is grok's own "no catalogue" answer (a failed/absent `grok models`), which is
      // the pre-feature behaviour: no model switching offered, never a partial list.
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
      // Likewise stated. The default is the CURRENT codex vocabulary (0.149.0 dropped `untrusted`),
      // so the assembled lines below are the ones a Server Edition on a current CLI really sends;
      // the old vocabulary gets its own case rather than being the silent default.
      codexCaps: async () => codexApprovalValues,
      codexSharedIdentity: async () => codexSharedIdentity,
      ownership,
      stateOf: (id) => states[id],
      outcomeOf: (id) => outcomes[id],
      handedOver: (id) => handedOver.has(id),
      launchTiming: { quietMs: 0, capMs: 0 },
      // Every content op the factory casts; `published` / `removed` keep the node halves these
      // tests assert on (edges and board ops are cast too — see the cast-before-save suite).
      // `published` holds a SNAPSHOT, as the real publisher takes one at call time: the factory
      // goes on to update the same node object in place after it publishes.
      publishMutation: (_projectId, m) => {
        if (m.op === 'upsert') published.push(structuredClone(m.node))
        else if (m.op === 'remove') removed.push(m.id)
      },
      publishProject: (project) => publishedProjects.push(structuredClone(project))
    })
  })

  afterEach(() => {
    factory.stop()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates a terminal PTY, persists both workspace index and project file, and publishes it', async () => {
    const reply = await factory.openTerminal(
      'term-source',
      { cwd: projectDir, cmd: 'printf hello' },
      true
    )
    expect(reply).toMatchObject({ ok: true, result: { id: expect.stringMatching(/^term-/) } })
    const id = (reply.result as { id: string }).id

    expect(pty.creates).toEqual([
      expect.objectContaining({
        cwd: projectDir,
        cols: 120,
        rows: 36,
        persistKey: id,
        ownerProjectId: 'project-1'
      })
    ])
    expect(pty.sends).toEqual([{ nodeId: id, text: 'printf hello' }])
    // The persisted hold is published first, then its acknowledged delivery.
    expect(published.map((node) => node.id)).toEqual([id, id])
    // …and the first publish CARRIES the claimed hold: an owner tab appends this brand-new node
    // with its launch (test/acceptance/pending-launch-reflector.test.ts), so its next save
    // cannot drop what this core persisted. The second is the delivery, which clears it.
    expect(published[0].pendingLaunch).toMatchObject({ command: 'printf hello', attempted: true, manualOnly: true })
    expect(published[1].pendingLaunch).toBeUndefined()

    expect(fs.existsSync(path.join(dataDir, 'workspace.json'))).toBe(true)
    const projectFile = path.join(projectDir, '.nodeterm', 'project.json')
    expect(fs.existsSync(projectFile)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as { nodes: CanvasNodeState[] }
    const created = raw.nodes.find((node) => node.id === id)
    // Local project files store cwd portably; WorkspaceStore resolves it back to absolute on load.
    expect(created).toMatchObject({ kind: 'terminal', cwd: '.' })
    expect(created!.position.x).toBeGreaterThan(terminal('x', 'x').position.x)

    const reloaded = await new WorkspaceStore().load({ sideline: false })
    expect(reloaded.projects[0].nodes.find((node) => node.id === id)).toMatchObject({
      cwd: projectDir
    })
  })

  it('re-grants an exact saved local project after a Server restart before cross-project open', async () => {
    const targetDir = path.join(dataDir, 'loop-project')
    fs.mkdirSync(targetDir, { recursive: true })
    const workspace = await store.load({ sideline: false })
    workspace.projects.push({
      id: 'project-loop',
      name: 'Loop',
      color: '#6ac4dc',
      cwd: targetDir,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [],
      bridges: [],
      ropes: []
    })
    await store.save(workspace)

    await expect(
      factory.openAgent(
        'term-source',
        { agent: 'claude', project: 'project-loop', prompt: 'resume loop' },
        true
      )
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('project-target-refused')
    })

    await expect(
      factory.openProject('term-source', { cwd: targetDir }, true)
    ).resolves.toMatchObject({
      ok: true,
      result: {
        projectId: 'project-loop',
        cwd: targetDir,
        created: false,
        serverExistingOnly: true
      }
    })

    // A grant belongs to the exact verified caller. Another agent in the same source project may
    // not consume it merely because it learned the returned project id.
    await expect(
      factory.openAgent(
        'term-upstream',
        { agent: 'claude', project: 'project-loop', prompt: 'steal grant' },
        true
      )
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('project-target-refused')
    })

    const opened = await factory.openAgent(
      'term-source',
      { agent: 'claude', project: 'project-loop', prompt: 'resume loop' },
      true
    )
    expect(opened.ok).toBe(true)
    const id = (opened.result as { id: string }).id
    expect(pty.creates.at(-1)).toMatchObject({
      persistKey: id,
      ownerProjectId: 'project-loop',
      cwd: targetDir
    })
    expect((await store.load({ sideline: false })).projects
      .find((project) => project.id === 'project-loop')?.nodes
      .some((node) => node.id === id)).toBe(true)
  })

  it('never creates or enumerates a project through Server open-project', async () => {
    const missing = path.join(dataDir, 'not-registered')
    fs.mkdirSync(missing, { recursive: true })

    await expect(
      factory.openProject('term-source', { cwd: missing }, true)
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('server-existing-only')
    })
    await expect(
      factory.openProject('term-source', { cwd: projectDir }, false)
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('identity-refused')
    })

    const reloaded = await store.load({ sideline: false })
    expect(reloaded.projects).toHaveLength(1)
  })

  it('lets a verified caller close its own spawn, killing the pane before persisted edge removal and fanout', async () => {
    const opened = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'owned work' },
      true
    )
    const id = (opened.result as { id: string }).id
    const closed = await factory.close('term-source', { node: id }, true)

    expect(closed).toMatchObject({ ok: true, result: { ids: [id] } })
    expect(pty.destroys).toEqual([
      { clientId: null, nodeId: id, everySocket: true, wasLive: true }
    ])
    expect(removed).toEqual([id])

    const workspace = await new WorkspaceStore().load({ sideline: false })
    const project = workspace.projects[0]
    expect(project.nodes.some((node) => node.id === id)).toBe(false)
    expect(project.ropes?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(project.bridges?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(publishedProjects.at(-1)?.nodes.some((node) => node.id === id)).toBe(false)

    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as {
      nodes: CanvasNodeState[]
      ropes?: Array<{ source: string; target: string }>
      bridges?: Array<{ source: string; target: string }>
    }
    expect(projectFile.nodes.some((node) => node.id === id)).toBe(false)
    expect(projectFile.ropes?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(projectFile.bridges?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
  })

  it('refuses a different caller without killing or removing the owned spawn', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id

    await expect(factory.close('term-upstream', { node: id }, true)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-not-owner')
    })
    expect(pty.destroys).toEqual([])
    expect((await store.load({ sideline: false })).projects[0].nodes.some((node) => node.id === id))
      .toBe(true)
    expect(removed).toEqual([])
  })

  it('closes a persisted owned node cleanly when its pane was already killed out of band', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id
    pty.killOutOfBand(id)

    await expect(factory.close('term-source', { node: id }, true)).resolves.toMatchObject({
      ok: true,
      result: { ids: [id] }
    })
    expect(pty.destroys.at(-1)).toEqual({
      clientId: null,
      nodeId: id,
      everySocket: true,
      wasLive: false
    })
    expect((await store.load({ sideline: false })).projects[0].nodes.some((node) => node.id === id))
      .toBe(false)
  })

  it('requires verified node identity before applying the process-local ownership ledger', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id

    await expect(factory.close('term-source', { node: id }, false)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-identity-refused')
    })
    expect(pty.destroys).toEqual([])
  })

  it('refuses every node mutation against an unowned target without a partial write or spawn', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push(
      terminal('term-foreign', 'Foreign', 'claude', 900),
      {
        id: 'sticky-foreign',
        kind: 'sticky',
        position: { x: 1200, y: 30 },
        size: { width: 240, height: 200 },
        title: 'Foreign note',
        color: '#ffd60a',
        group: null,
        text: 'do not touch'
      }
    )
    await store.save(workspace)
    const before = structuredClone((await store.load({ sideline: false })).projects[0])

    const replies = [
      await factory.link('term-source', { to: 'term-foreign' }, true),
      await factory.group('term-source', { nodes: 'term-source,term-foreign' }),
      await factory.rename('term-source', { node: 'term-foreign', title: 'Stolen' }),
      await factory.color('term-source', { node: 'term-foreign', color: '#32d74b' }),
      await factory.sticky('term-source', { node: 'sticky-foreign', append: 'stolen' }),
      await factory.openAgent(
        'term-source',
        { agent: 'claude', after: 'term-foreign', prompt: 'wait on foreign work' },
        true
      )
    ]

    expect(replies.map((reply) => reply.ok)).toEqual([false, false, false, false, false, false])
    expect(replies.map((reply) => reply.error)).toEqual([
      expect.stringContaining('link-not-owner'),
      expect.stringContaining('group-not-owner'),
      expect.stringContaining('rename-not-owner'),
      expect.stringContaining('color-not-owner'),
      expect.stringContaining('sticky-not-owner'),
      expect.stringContaining('open-agent-not-owner')
    ])
    expect((await store.load({ sideline: false })).projects[0]).toEqual(before)
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    expect(published).toEqual([])
    expect(publishedProjects).toEqual([])
  })

  it('refuses to close an owned frame if doing so would reparent an unowned child', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const ownedId = (opened.result as { id: string }).id
    const grouped = await factory.group('term-source', { nodes: ownedId })
    const groupId = (grouped.result as { groupId: string }).groupId
    const workspace = await store.load({ sideline: false })
    const foreign = terminal('term-foreign-child', 'Foreign child')
    foreign.parentId = groupId
    workspace.projects[0].nodes.push(foreign)
    await store.save(workspace)
    pty.destroys.length = 0

    await expect(factory.close('term-source', { node: groupId }, true)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-not-owner')
    })
    expect(pty.destroys).toEqual([])
    const after = (await store.load({ sideline: false })).projects[0]
    expect(after.nodes.find((node) => node.id === groupId)).toBeDefined()
    expect(after.nodes.find((node) => node.id === 'term-foreign-child')?.parentId).toBe(groupId)
  })

  it('refuses a default link endpoint because the caller did not spawn its own node', async () => {
    const reply = await factory.link('term-source', { to: 'term-upstream' }, true)

    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('link-not-owner')
    })
    expect(pty.sends).toEqual([])
    const workspace = await new WorkspaceStore().load({ sideline: false })
    expect(workspace.projects[0].bridges).toEqual([])
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as { bridges?: Array<{ source: string; target: string }> }
    expect(projectFile.bridges).toEqual([])
    expect(published).toEqual([])
    expect(publishedProjects).toEqual([])
  })

  it('links two arbitrary existing nodes in the caller project', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push(terminal('term-third', 'Third', 'gemini', 900))
    await store.save(workspace)
    ownership.record('term-third', { sourceNodeId: 'term-source', projectId: 'project-1' })

    await expect(
      factory.link('term-source', { from: 'term-upstream', to: 'term-third' }, true)
    ).resolves.toMatchObject({
      ok: true,
      result: { from: 'term-upstream', linked: ['term-third'] }
    })
    expect((await store.load({ sideline: false })).projects[0].bridges).toEqual([
      expect.objectContaining({ source: 'term-upstream', target: 'term-third' })
    ])
    expect(pty.sends).toEqual([])
  })

  it('refuses unverified and cross-project link endpoints without a partial graph edit', async () => {
    await expect(factory.link('term-source', { to: 'term-upstream' }, false)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('link-identity-refused')
    })

    const workspace = await store.load({ sideline: false })
    const otherDir = path.join(dataDir, 'other-project')
    fs.mkdirSync(otherDir, { recursive: true })
    workspace.projects.push({
      id: 'project-2',
      name: 'Other',
      color: '#32d74b',
      cwd: otherDir,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [terminal('term-other-project', 'Elsewhere', 'claude')],
      bridges: [],
      ropes: []
    })
    await store.save(workspace)

    await expect(
      factory.link('term-source', { to: 'term-upstream,term-other-project' }, true)
    ).resolves.toMatchObject({
      ok: false,
      error: "link-project-refused: term-other-project is not exclusively in the caller's project; cross-project linking is not supported"
    })
    expect((await store.load({ sideline: false })).projects[0].bridges).toEqual([])
    expect(publishedProjects).toEqual([])
    expect(pty.sends).toEqual([])
  })

  it('wraps loose nodes in a labeled persisted group and fans out every structural mutation', async () => {
    const before = (await store.load({ sideline: false })).projects[0]
    const beforePositions = new Map(before.nodes.map((node) => [node.id, node.position]))
    const reply = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Director team'
    })
    expect(reply).toMatchObject({
      ok: true,
      result: {
        groupId: expect.stringMatching(/^group-/),
        grouped: ['term-upstream', 'term-owned'],
        skipped: 0
      }
    })
    const groupId = (reply.result as { groupId: string }).groupId
    const project = (await new WorkspaceStore().load({ sideline: false })).projects[0]
    const group = project.nodes.find((node) => node.id === groupId)!
    expect(project.nodes[0]).toMatchObject({ id: groupId, kind: 'group' })
    expect(group.title).toBe('Director team')
    for (const id of ['term-upstream', 'term-owned']) {
      const child = project.nodes.find((node) => node.id === id)!
      expect(child.parentId).toBe(groupId)
      expect({
        x: group.position.x + child.position.x,
        y: group.position.y + child.position.y
      }).toEqual(beforePositions.get(id))
    }
    expect(published.map((node) => node.id)).toEqual(
      expect.arrayContaining([groupId, 'term-upstream', 'term-owned'])
    )
    expect(publishedProjects.at(-1)?.nodes.find((node) => node.id === groupId)?.title).toBe(
      'Director team'
    )
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as { nodes: CanvasNodeState[] }
    expect(projectFile.nodes.find((node) => node.id === groupId)).toMatchObject({
      kind: 'group',
      title: 'Director team'
    })
  })

  it('lets the creator close a nested frame only, promoting surviving members to its parent', async () => {
    const outerReply = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Outer'
    })
    const outerId = (outerReply.result as { groupId: string }).groupId
    const innerReply = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Inner'
    })
    const innerId = (innerReply.result as { groupId: string }).groupId
    const before = (await store.load({ sideline: false })).projects[0]
    const root = (project: (typeof before), id: string): { x: number; y: number } => {
      const node = project.nodes.find((candidate) => candidate.id === id)!
      let x = node.position.x
      let y = node.position.y
      let parentId = node.parentId
      const seen = new Set<string>()
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = project.nodes.find((candidate) => candidate.id === parentId)
        if (!parent) break
        x += parent.position.x
        y += parent.position.y
        parentId = parent.parentId
      }
      return { x, y }
    }
    const rootsBefore = new Map(
      ['term-upstream', 'term-owned'].map((id) => [id, root(before, id)])
    )
    published.length = 0
    publishedProjects.length = 0
    removed.length = 0

    await expect(factory.close('term-source', { node: innerId }, true)).resolves.toMatchObject({
      ok: true,
      result: { ids: [innerId] }
    })

    const after = (await new WorkspaceStore().load({ sideline: false })).projects[0]
    expect(after.nodes.some((node) => node.id === innerId)).toBe(false)
    expect(after.nodes.some((node) => node.id === outerId)).toBe(true)
    for (const id of ['term-upstream', 'term-owned']) {
      expect(after.nodes.find((node) => node.id === id)?.parentId).toBe(outerId)
      expect(root(after, id)).toEqual(rootsBefore.get(id))
    }
    expect(pty.destroys).toEqual([])
    expect(removed).toEqual([innerId])
    expect(published.map((node) => node.id)).toEqual(
      expect.arrayContaining(['term-upstream', 'term-owned'])
    )
    expect(publishedProjects.at(-1)?.nodes.some((node) => node.id === innerId)).toBe(false)
  })

  it('refuses a non-creator that tries to close a headless-created frame', async () => {
    const grouped = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned'
    })
    const groupId = (grouped.result as { groupId: string }).groupId
    publishedProjects.length = 0

    await expect(factory.close('term-upstream', { node: groupId }, true)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-not-owner')
    })
    expect((await store.load({ sideline: false })).projects[0].nodes.some(
      (node) => node.id === groupId
    )).toBe(true)
    expect(pty.destroys).toEqual([])
    expect(removed).toEqual([])
    expect(publishedProjects).toEqual([])
  })

  it('closes an owned empty frame after its members were separately closed', async () => {
    const first = await factory.openTerminal('term-source', {}, true)
    const second = await factory.openTerminal('term-source', {}, true)
    const memberIds = [
      (first.result as { id: string }).id,
      (second.result as { id: string }).id
    ]
    const grouped = await factory.group('term-source', { nodes: memberIds.join(',') })
    const groupId = (grouped.result as { groupId: string }).groupId

    for (const id of memberIds) {
      await expect(factory.close('term-source', { node: id }, true)).resolves.toMatchObject({
        ok: true
      })
    }
    expect((await store.load({ sideline: false })).projects[0].nodes.find(
      (node) => node.id === groupId
    )).toMatchObject({ kind: 'group' })

    await expect(factory.close('term-source', { node: groupId }, true)).resolves.toMatchObject({
      ok: true,
      result: { ids: [groupId] }
    })
    const after = await store.load({ sideline: false })
    expect(after.projects[0].nodes.some((node) => node.id === groupId)).toBe(false)
    expect(pty.destroys.map((entry) => entry.nodeId)).toEqual(memberIds)
    expect(removed).toEqual([...memberIds, groupId])
  })

  it('applies a validated palette color when creating a group', async () => {
    const reply = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Purple team',
      color: '#bf5af2'
    })
    const groupId = (reply.result as { groupId: string }).groupId
    const project = (await new WorkspaceStore().load({ sideline: false })).projects[0]
    expect(project.nodes.find((node) => node.id === groupId)).toMatchObject({
      title: 'Purple team',
      color: '#bf5af2'
    })
    expect(publishedProjects.at(-1)?.nodes.find((node) => node.id === groupId)?.color).toBe(
      '#bf5af2'
    )
    expect(pty.sends).toEqual([])
  })

  it('recolors a node, frame, and sticky with persistence and fanout but no PTY write', async () => {
    const grouped = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Color targets'
    })
    const groupId = (grouped.result as { groupId: string }).groupId
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      id: 'sticky-color',
      kind: 'sticky',
      position: { x: 1200, y: 30 },
      size: { width: 240, height: 200 },
      title: 'Color note',
      color: '#ffd60a',
      group: null,
      text: 'ready'
    })
    await store.save(workspace)
    ownership.record('sticky-color', { sourceNodeId: 'term-source', projectId: 'project-1' })
    published.length = 0
    publishedProjects.length = 0

    await expect(factory.color('term-source', {
      node: `term-upstream,${groupId},sticky-color`,
      color: '#32d74b'
    })).resolves.toMatchObject({
      ok: true,
      result: {
        colored: ['term-upstream', groupId, 'sticky-color'],
        skipped: 0,
        color: '#32d74b'
      }
    })
    const project = (await new WorkspaceStore().load({ sideline: false })).projects[0]
    for (const id of ['term-upstream', groupId, 'sticky-color']) {
      expect(project.nodes.find((node) => node.id === id)?.color, id).toBe('#32d74b')
    }
    // Cast in the project's node order (frames first), one upsert each.
    expect(published.map((node) => node.id).sort()).toEqual(
      ['term-upstream', groupId, 'sticky-color'].sort()
    )
    expect(publishedProjects).toHaveLength(1)
    expect(pty.sends).toEqual([])
    expect(pty.destroys).toEqual([])
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as { nodes: CanvasNodeState[] }
    expect(projectFile.nodes.find((node) => node.id === 'sticky-color')?.color).toBe('#32d74b')
  })

  it('accepts a palette NAME and a mixed-case hex, persisting the canonical value', async () => {
    // Complaint (1): `--color '#d97757'` — the colour a Claude node is BORN with — used to be
    // refused by the boundary. It is in the palette now, and so is its name.
    await expect(factory.color('term-source', {
      node: 'term-upstream',
      color: 'claude'
    })).resolves.toMatchObject({ ok: true, result: { color: '#d97757' } })
    await expect(factory.color('term-source', {
      node: 'term-upstream',
      color: '#0A84FF'
    })).resolves.toMatchObject({ ok: true, result: { color: '#0a84ff' } })
    const project = (await store.load({ sideline: false })).projects[0]
    expect(project.nodes.find((node) => node.id === 'term-upstream')?.color).toBe('#0a84ff')
  })

  it('refuses invalid group and recolor values by name without persistence or fanout', async () => {
    await expect(factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      color: 'var(--danger)'
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('node-color-invalid')
    })
    await expect(factory.color('term-source', {
      node: 'term-source',
      color: '#ffffff'
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('node-color-invalid')
    })
    const project = (await store.load({ sideline: false })).projects[0]
    expect(project.nodes.filter((node) => node.kind === 'group')).toEqual([])
    expect(project.nodes.find((node) => node.id === 'term-source')?.color).toBe('#d97757')
    expect(published).toEqual([])
    expect(publishedProjects).toEqual([])
    expect(pty.sends).toEqual([])
  })

  it('refuses grouping across containers or across an ancestor boundary', async () => {
    const workspace = await store.load({ sideline: false })
    const frame: CanvasNodeState = {
      id: 'group-existing',
      kind: 'group',
      position: { x: 700, y: 20 },
      size: { width: 760, height: 560 },
      title: 'Existing frame',
      color: '#32d74b',
      group: null
    }
    const child = terminal('term-inside', 'Inside', 'gemini', 40)
    child.parentId = frame.id
    workspace.projects[0].nodes.unshift(frame)
    workspace.projects[0].nodes.push(child)
    await store.save(workspace)
    ownership.record('group-existing', { sourceNodeId: 'term-source', projectId: 'project-1' })
    ownership.record('term-inside', { sourceNodeId: 'term-source', projectId: 'project-1' })

    for (const nodes of ['term-inside,term-upstream', 'group-existing,term-inside']) {
      await expect(factory.group('term-source', { nodes })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('siblings in one container')
      })
    }
    const after = await store.load({ sideline: false })
    expect(after.projects[0].nodes.filter((node) => node.kind === 'group')).toHaveLength(1)
    expect(after.projects[0].nodes.find((node) => node.id === 'term-inside')?.parentId).toBe(
      'group-existing'
    )
    expect(publishedProjects).toEqual([])
  })

  it('renames a node, group, and sticky durably without ever writing into their panes', async () => {
    const grouped = await factory.group('term-source', {
      nodes: 'term-upstream,term-owned',
      label: 'Old group'
    })
    const groupId = (grouped.result as { groupId: string }).groupId
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      id: 'sticky-status',
      kind: 'sticky',
      position: { x: 1200, y: 30 },
      size: { width: 240, height: 200 },
      title: 'Old note',
      color: '#ffd60a',
      group: null,
      text: 'ready'
    })
    await store.save(workspace)
    ownership.record('sticky-status', { sourceNodeId: 'term-source', projectId: 'project-1' })
    published.length = 0
    publishedProjects.length = 0

    await expect(
      factory.rename('term-source', { node: 'term-upstream', title: 'Reviewed\nUpstream' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      factory.rename('term-source', { node: groupId, title: 'Director group' })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      factory.rename('term-source', { node: 'sticky-status', title: 'Round status' })
    ).resolves.toMatchObject({ ok: true })

    const project = (await new WorkspaceStore().load({ sideline: false })).projects[0]
    expect(project.nodes.find((node) => node.id === 'term-upstream')).toMatchObject({
      title: 'Reviewed Upstream',
      titleAuto: false
    })
    expect(project.nodes.find((node) => node.id === groupId)).toMatchObject({
      title: 'Director group',
      titleAuto: false
    })
    expect(project.nodes.find((node) => node.id === 'sticky-status')).toMatchObject({
      title: 'Round status',
      titleAuto: false
    })
    expect(published.map((node) => node.id)).toEqual([
      'term-upstream',
      groupId,
      'sticky-status'
    ])
    expect(publishedProjects).toHaveLength(3)
    expect(pty.sends).toEqual([])
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as { nodes: CanvasNodeState[] }
    expect(projectFile.nodes.find((node) => node.id === 'sticky-status')?.title).toBe(
      'Round status'
    )
  })

  it('places repeated spawns in the first free deterministic slots without overlapping busy nodes', async () => {
    const workspace = await store.load({ sideline: false })
    // Slot zero to the right of the source is already busy before any control request arrives.
    workspace.projects[0].nodes.push(terminal('term-busy-slot', 'Busy slot', 'gemini', 740))
    await store.save(workspace)

    const spawnedIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const reply = await factory.openTerminal('term-source', {}, true)
      spawnedIds.push((reply.result as { id: string }).id)
    }

    const nodes = (await store.load({ sideline: false })).projects[0].nodes
    const overlap = (a: CanvasNodeState, b: CanvasNodeState): boolean =>
      a.position.x < b.position.x + b.size.width &&
      a.position.x + a.size.width > b.position.x &&
      a.position.y < b.position.y + b.size.height &&
      a.position.y + a.size.height > b.position.y
    for (const id of spawnedIds) {
      const node = nodes.find((candidate) => candidate.id === id)!
      expect(nodes.filter((candidate) => candidate.id !== id).some((candidate) => overlap(node, candidate)), id)
        .toBe(false)
    }
    expect(new Set(spawnedIds.map((id) => {
      const node = nodes.find((candidate) => candidate.id === id)!
      return `${node.position.x},${node.position.y}`
    })).size).toBe(spawnedIds.length)
  })

  it.each([
    ['claude', "claude 'do work'"],
    // Manual is the resolved mode in this fixture, and on a current codex it has NO expressible
    // value — `untrusted` was removed in 0.149.0 and clap exits on it (issue #785). The honest
    // line is the bare one; the case below pins the old CLI, which still gets the flag.
    ['codex', "codex 'do work'"],
    ['gemini', "gemini 'do work'"]
  ] as const)('assembles the %s launch through the shared command builder', async (agent, command) => {
    const reply = await factory.openAgent(
      'term-source',
      { agent, prompt: 'do   work' },
      true
    )
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.creates.at(-1)).toMatchObject({
      persistKey: id,
      ownerProjectId: 'project-1',
      agentId: agent
    })
    expect(pty.sends.at(-1)).toEqual({ nodeId: id, text: command })
  })

  it('never cold-spawns a persisted arm during boot reconciliation', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      ...terminal('term-dormant', 'Dormant'),
      pendingLaunch: {
        after: [],
        command: "claude 'must stay dormant'",
        executor: 'server'
      }
    })
    await store.save(workspace)

    const load = vi.spyOn(store, 'load')
    await factory.start()

    expect(load).not.toHaveBeenCalled()
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    load.mockRestore()
    expect((await store.load({ sideline: false })).projects[0].nodes
      .find((node) => node.id === 'term-dormant')?.pendingLaunch).toBeDefined()
  })

  it('does not adopt or control a persisted arm even when its backend survived', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      ...terminal('term-survivor', 'Survivor'),
      pendingLaunch: {
        after: [],
        command: "claude 'resume owned work'",
        executor: 'server'
      }
    })
    await store.save(workspace)
    pty.live.add('term-survivor')

    await factory.start()

    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    expect((await store.load({ sideline: false })).projects[0].nodes
      .find((node) => node.id === 'term-survivor')?.pendingLaunch).toBeDefined()
  })

  it('does not grant a plain shell Claude control authority by default', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      ...terminal('term-plain', 'Plain shell'),
      agentId: undefined
    })
    await store.save(workspace)

    await expect(factory.openTerminal('term-plain', {}, true)).resolves.toEqual({
      ok: false,
      error: 'source node is not a control-capable agent'
    })
    expect(pty.creates).toEqual([])
  })

  it('routes a Codex launch through the managed launcher when Server shared identity is ready', async () => {
    codexSharedIdentity = true

    const reply = await factory.openAgent(
      'term-source',
      { agent: 'codex', prompt: 'do work' },
      true
    )

    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends.at(-1)).toEqual({
      nodeId: id,
      text: "nodeterm-codex 'do work'"
    })
  })

  /**
   * The Server Edition's Codex sessions run on THIS host's `codex`, so the host's own probe is the
   * authority for them — not a constant, and not the desktop's. A host still on <= 0.148.0 keeps
   * "Ask each time" working; the case above shows the same factory dropping it on a host that
   * cannot express it. Both come out of one probe, which is the whole point of #785's fix.
   */
  it('keeps `untrusted` for a host whose codex still advertises it', async () => {
    codexApprovalValues = { approvalValues: ['untrusted', 'on-request', 'never'] }

    const reply = await factory.openAgent('term-source', { agent: 'codex', prompt: 'do work' }, true)

    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends.at(-1)).toEqual({
      nodeId: id,
      text: "codex 'do work' --ask-for-approval untrusted"
    })
  })

  it.each(['claude', 'codex'])('reports delivered, not running, for %s', async (agent) => {
    const reply = await factory.openAgent('term-source', { agent, prompt: 'work' }, true)
    const id = (reply.result as { id: string }).id
    expect(reply).toMatchObject({ ok: true, result: { queued: false, queuedIds: [], deliveredIds: [id], failed: [] } })
    expect(reply.message).toContain('agent startup is not confirmed')
    const workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toBeUndefined()
  })

  it.each(['refused', 'throws', 'no-pty'])('retains the exact initial command after %s', async (failure) => {
    if (failure === 'no-pty') vi.spyOn(pty, 'createHeadless').mockRejectedValueOnce(new Error('unavailable'))
    else if (failure === 'throws') {
      vi.spyOn(pty, 'writeHeadless').mockImplementation(() => {
        throw new Error('disconnected')
      })
    } else vi.spyOn(pty, 'writeHeadless').mockReturnValue(false)
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'keep this brief' }, true)
    const id = (reply.result as { id: string }).id
    expect(reply).toMatchObject({ ok: false, result: { deliveredIds: [], failed: [id] } })
    expect(reply.error).toContain('do not repeat the open request')
    const workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toMatchObject({
      after: [], command: "claude 'keep this brief'", executor: 'server'
    })
  })

  it.each(['vim', null])('refuses initial input when the pane is %s and never retries on hooks', async (pane) => {
    vi.spyOn(pty, 'paneCommand').mockResolvedValue(pane)
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'brief' }, true)
    expect(reply.ok).toBe(false)
    expect(pty.sends).toEqual([])
    await factory.refreshArmed({ nodeId: 'term-upstream', state: 'done' })
    expect(pty.sends).toEqual([])
  })

  it('saves manual recovery intent before sending, including a successful send whose clearing save fails', async () => {
    const save = vi.spyOn(store, 'save')
    const typeInto = pty.writeHeadless.bind(pty)
    // The headless write is synchronous, so the durable read starts at the first typed byte and is
    // awaited afterwards. Nothing reaches the disk in between: the next save is the one failed here.
    let firstWrite: { id: string; durable: ReturnType<WorkspaceStore['load']> } | undefined
    vi.spyOn(pty, 'writeHeadless').mockImplementation((id, data) => {
      firstWrite ??= { id, durable: store.load({ sideline: false }) }
      if (data === '\r') save.mockRejectedValueOnce(new Error('disk unavailable after delivery'))
      return typeInto(id, data)
    })
    await expect(factory.openAgent('term-source', { agent: 'claude', prompt: 'brief' }, true))
      .rejects.toThrow('disk unavailable')
    const durable = await firstWrite!.durable
    expect(durable.projects[0].nodes.find((n) => n.id === firstWrite!.id)?.pendingLaunch)
      .toMatchObject({ command: "claude 'brief'", manualOnly: true })
    expect(pty.sends).toEqual([{ nodeId: firstWrite!.id, text: "claude 'brief'" }])
    await factory.refreshArmed({ nodeId: 'term-upstream', state: 'done' })
    expect(pty.sends).toHaveLength(1)
  })

  it('a failed dependent launch is retained durably and not replayed after unrelated hooks', async () => {
    states['term-upstream'] = 'working'
    const reply = await factory.openAgent('term-source', {
      agent: 'claude', prompt: 'brief', after: 'term-upstream'
    }, true)
    const id = (reply.result as { id: string }).id
    const send = vi.spyOn(pty, 'sendText').mockResolvedValue(false)
    await factory.refreshArmed({ nodeId: 'term-upstream', state: 'done' })
    await factory.refreshArmed({ nodeId: 'term-source', state: 'done' })
    await factory.refreshArmed()
    expect(send).toHaveBeenCalledTimes(1)
    const durable = await store.load({ sideline: false })
    expect(durable.projects[0].nodes.find((n) => n.id === id)?.pendingLaunch)
      .toMatchObject({ command: "claude 'brief'", manualOnly: true })
  })

  it('reports a partial batch and never retries the retained launch on unrelated hooks', async () => {
    // The first node's writes land; every write into the second is refused.
    const typeInto = pty.writeHeadless.bind(pty)
    let firstId: string | undefined
    vi.spyOn(pty, 'writeHeadless').mockImplementation((id, data) => {
      firstId ??= id
      return id === firstId ? typeInto(id, data) : false
    })
    const reply = await factory.openAgent('term-source', { agent: 'codex', prompt: 'work', count: '2' }, true)
    const [delivered, failed] = (reply.result as { ids: string[] }).ids
    expect(reply).toMatchObject({ ok: false, result: { deliveredIds: [delivered], failed: [failed], queuedIds: [] } })
    const workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === failed)?.pendingLaunch?.command)
      .toContain("codex 'work'")
    pty.sends.length = 0
    await factory.refreshArmed()
    await factory.refreshArmed()
    expect(pty.sends).toEqual([])
    expect(workspace.projects[0].nodes.find((node) => node.id === failed)?.pendingLaunch?.manualOnly).toBe(true)
  })

  it('persists --after without launching, then flushes exactly once on the idle state', async () => {
    states['term-upstream'] = 'working'
    const reply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: 'term-upstream' },
      true
    )
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends).toEqual([])
    expect(reply.result).toMatchObject({ queued: true, queuedIds: [id], deliveredIds: [] })
    expect(reply.message).toContain('queued:')

    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toEqual({
      after: ['term-upstream'],
      command: "claude 'consume result'",
      attempted: false,
      executor: 'server'
    })
    expect(workspace.projects[0].bridges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'term-source', target: id }),
        expect.objectContaining({ source: id, target: 'term-upstream' })
      ])
    )

    states['term-upstream'] = 'done'
    await factory.refreshArmed()
    await factory.refreshArmed()
    expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'consume result'" }])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toBeUndefined()
  })

  describe('plain --after on a station handed new work (core/station-handover.ts)', () => {
    it('does NOT take the creation shortcut on a done from before the hand-over', async () => {
      // The station reads `done` — from its PREVIOUS task — and was just handed the next one.
      states['term-upstream'] = 'done'
      handedOver.add('term-upstream')
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'consume result', after: 'term-upstream' },
        true
      )
      expect(reply.ok).toBe(true)
      const id = (reply.result as { id: string }).id
      expect(pty.sends).toEqual([])
      expect(reply.result).toMatchObject({ queued: true, queuedIds: [id] })
      // refreshArmed on the same old `done` still holds.
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      // The new work's turn ends: the tracker drops the station, and the next done releases D once.
      handedOver.delete('term-upstream')
      factory.onAgentEvent({ nodeId: 'term-upstream', state: 'done' })
      await factory.refreshArmed()
      await factory.refreshArmed()
      expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'consume result'" }])
    })

    it('an already-armed dependent is held by a hand-over that arrives before the station idles', async () => {
      states['term-upstream'] = 'working'
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'consume result', after: 'term-upstream' },
        true
      )
      const id = (reply.result as { id: string }).id
      handedOver.add('term-upstream')
      states['term-upstream'] = 'done'
      factory.onAgentEvent({ nodeId: 'term-upstream', state: 'done' })
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      handedOver.delete('term-upstream')
      await factory.refreshArmed()
      expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'consume result'" }])
    })

    it('with a REAL tracker, a done still listing a background subagent holds; none left releases', async () => {
      // Wired as canvas-control.ts wires it: the tracker is fed every event BEFORE the factory.
      const tracker = new StationHandoverTracker()
      handedOver = { has: (id: string) => tracker.isHandedOver(id) } as unknown as Set<string>
      const feed = (ev: { nodeId: string; state: 'working' | 'done'; backgroundSubagentIds?: string[] }) => {
        states[ev.nodeId] = ev.state
        tracker.onAgentEvent(ev)
        factory.onAgentEvent(ev)
      }
      feed({ nodeId: 'term-upstream', state: 'working' })
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'consume result', after: 'term-upstream' },
        true
      )
      const id = (reply.result as { id: string }).id
      feed({ nodeId: 'term-upstream', state: 'done', backgroundSubagentIds: ['a1b2c3'] })
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      feed({ nodeId: 'term-upstream', state: 'working' })
      feed({ nodeId: 'term-upstream', state: 'done', backgroundSubagentIds: [] })
      await factory.refreshArmed()
      await factory.refreshArmed()
      expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'consume result'" }])
    })

    it('a success wait holds too: its turn is not over while handed-over work is unfinished', async () => {
      states['term-upstream'] = 'done'
      outcomes['term-upstream'] = { nodeId: 'term-upstream', outcome: 'succeeded', at: Date.now() }
      handedOver.add('term-upstream')
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'ship it', 'after-success': 'term-upstream' },
        true
      )
      expect(reply.ok).toBe(true)
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
    })
  })

  describe('--after-success: the dependent waits for a REPORTED success, not a turn ending', () => {
    const report = (nodeId: string, outcome: 'succeeded' | 'failed', note?: string) => {
      outcomes[nodeId] = { nodeId, outcome, at: Date.now(), ...(note ? { note } : {}) }
    }
    const openWaiting = async () => {
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'ship it', 'after-success': 'term-upstream' },
        true
      )
      expect(reply.ok).toBe(true)
      return (reply.result as { id: string }).id
    }

    it('holds on an idle station with no report, and releases once it reports success', async () => {
      states['term-upstream'] = 'done'
      const id = await openWaiting()
      expect(pty.sends).toEqual([])
      const held = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
      expect(held?.pendingLaunch).toMatchObject({
        after: ['term-upstream'],
        afterSuccess: { deps: ['term-upstream'], deadlineAt: expect.any(Number) },
        executor: 'server'
      })
      // The turn is over and nothing was reported: `--after` alone would fire here.
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      report('term-upstream', 'succeeded')
      await factory.refreshArmed()
      await factory.refreshArmed()
      expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'ship it'" }])
    })

    it('a reported failure blocks it for good', async () => {
      states['term-upstream'] = 'done'
      const id = await openWaiting()
      report('term-upstream', 'failed', 'tests red')
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      const still = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
      expect(still?.pendingLaunch?.afterSuccess).toBeDefined()
    })

    it('holds when the station\'s last turn ERRORED after it reported success (#521, like the desktop)', async () => {
      states['term-upstream'] = 'done'
      const id = await openWaiting()
      report('term-upstream', 'succeeded')
      factory.onAgentEvent({ nodeId: 'term-upstream', state: 'done', errored: true })
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      // The next genuine new turn clears the verdict; a clean end of it releases.
      factory.onAgentEvent({ nodeId: 'term-upstream', state: 'working', newTurn: true })
      states['term-upstream'] = 'done'
      factory.onAgentEvent({ nodeId: 'term-upstream', state: 'done' })
      await vi.waitFor(() => expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'ship it'" }]))
    })

    it('a reported success mid-turn waits for the turn to end', async () => {
      states['term-upstream'] = 'working'
      await openWaiting()
      report('term-upstream', 'succeeded')
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
      states['term-upstream'] = 'done'
      await factory.refreshArmed()
      expect(pty.sends).toHaveLength(1)
    })

    it('a station already reported successful and idle releases the open at once', async () => {
      states['term-upstream'] = 'done'
      report('term-upstream', 'succeeded')
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'go', 'after-success': 'term-upstream' },
        true
      )
      expect(reply.result).toMatchObject({ deliveredIds: [expect.any(String)], afterSuccess: ['term-upstream'] })
      expect(pty.sends).toHaveLength(1)
    })

    it('never fires past its deadline', async () => {
      states['term-upstream'] = 'done'
      const reply = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'x', 'after-success': 'term-upstream', 'success-deadline': '1m' },
        true
      )
      expect(reply.ok).toBe(true)
      const ws = await store.load({ sideline: false })
      const node = ws.projects[0].nodes.find((n) => n.id === (reply.result as { id: string }).id)
      node!.pendingLaunch!.afterSuccess!.deadlineAt = 1
      await store.save(ws)
      report('term-upstream', 'succeeded')
      await factory.refreshArmed()
      expect(pty.sends).toEqual([])
    })

    it('a hostile persisted hold never fires and never throws', async () => {
      states['term-upstream'] = 'done'
      const id = await openWaiting()
      const ws = await store.load({ sideline: false })
      const node = ws.projects[0].nodes.find((n) => n.id === id)
      ;(node!.pendingLaunch as unknown as { afterSuccess: unknown }).afterSuccess = { deps: 'term-upstream' }
      await store.save(ws)
      report('term-upstream', 'succeeded')
      await expect(factory.refreshArmed()).resolves.toBeUndefined()
      expect(pty.sends).toEqual([])
    })

    it('refuses a station that could never report, and --run-now, before creating anything', async () => {
      const ws = await store.load({ sideline: false })
      ws.projects[0].nodes.push({ ...terminal('term-agy', 'Agy'), agentId: 'antigravity' })
      await store.save(ws)
      ownership.record('term-agy', { sourceNodeId: 'term-source', projectId: 'project-1' })
      const before = (await store.load({ sideline: false })).projects[0].nodes.length
      const r = await factory.openAgent(
        'term-source',
        { agent: 'claude', prompt: 'x', 'after-success': 'term-agy' },
        true
      )
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('cannot report an outcome') })
      await expect(
        factory.openAgent(
          'term-source',
          { agent: 'claude', prompt: 'x', 'after-success': 'term-upstream', 'run-now': '1' },
          true
        )
      ).resolves.toEqual({ ok: false, error: RUN_NOW_AFTER_SUCCESS_REFUSAL })
      expect((await store.load({ sideline: false })).projects[0].nodes.length).toBe(before)
    })
  })

  it('holds a fresh dependency through its boot done blip, then releases after working -> done', async () => {
    const upstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'produce result' },
      true
    )
    const upstreamId = (upstreamReply.result as { id: string }).id
    pty.sends.length = 0

    const downstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: upstreamId },
      true
    )
    const downstreamId = (downstreamReply.result as { id: string }).id
    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toMatchObject({ after: [upstreamId], awaitWorking: [upstreamId] })

    // Fresh Claude briefly idles at its composer before its argv prompt begins. This done is not
    // terminal evidence because no working turn has been observed since the downstream was armed.
    states[upstreamId] = 'done'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'done' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([])

    states[upstreamId] = 'working'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'working' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .not.toHaveProperty('awaitWorking')

    states[upstreamId] = 'done'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'done' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([{ nodeId: downstreamId, text: "claude 'consume result'" }])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toBeUndefined()
  })

  it('launches immediately when a fresh dependency is already done at arm time', async () => {
    const upstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'produce result' },
      true
    )
    const upstreamId = (upstreamReply.result as { id: string }).id
    states[upstreamId] = 'done'
    pty.sends.length = 0

    const downstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: upstreamId },
      true
    )
    const downstreamId = (downstreamReply.result as { id: string }).id
    expect(pty.sends).toEqual([{ nodeId: downstreamId, text: "claude 'consume result'" }])
    const workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toBeUndefined()
  })

  it('creates and updates a persisted sticky with lineage and an accountable byline', async () => {
    const createdReply = await factory.sticky('term-source', {
      node: 'Round status',
      create: 'yes',
      text: 'Round 1 complete'
    })
    expect(createdReply).toMatchObject({
      ok: true,
      result: { id: expect.stringMatching(/^sticky-/), created: true, mode: 'replace' }
    })
    const id = (createdReply.result as { id: string }).id

    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)).toMatchObject({
      kind: 'sticky',
      title: 'Round status',
      text: 'Round 1 complete',
      textUpdatedBy: 'Director'
    })
    expect(workspace.projects[0].ropes).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'term-source', target: id })])
    )

    const updatedReply = await factory.sticky('term-source', {
      node: id,
      append: 'Round 2 ready'
    })
    expect(updatedReply).toMatchObject({
      ok: true,
      result: { id, created: false, mode: 'append' }
    })
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.text).toBe(
      'Round 1 complete\nRound 2 ready'
    )
    expect(published.filter((node) => node.id === id)).toHaveLength(2)
  })

  it('refuses a non-v1 agent before a node or PTY is created', async () => {
    const reply = await factory.openAgent('term-source', { agent: 'grok' }, true)
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('claude|codex|gemini') })
    expect(pty.creates).toEqual([])
  })

  it('immediate delivery is echo-verified and keeps the server client attached (#925)', async () => {
    // `sends` records the blind paste and the typed-then-Enter line identically, so the path taken
    // is only visible here: the immediate open must never fall back to `sendText`.
    const paste = vi.spyOn(pty, 'sendText')
    const reply = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hello' }, true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends).toEqual([{ nodeId: id, text: 'printf hello' }])
    expect(paste).not.toHaveBeenCalled()
    expect(pty.released).toEqual([]) // release:false — the server keeps client 0, as it always has
  })

  it('a refused headless write retains the launch for Run now (#925)', async () => {
    vi.spyOn(pty, 'writeHeadless').mockReturnValue(false)
    const reply = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hello' }, true)
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/^launch-failed:/)
    const id = (reply.result as { id: string }).id
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
    expect(node?.pendingLaunch).toMatchObject({ command: 'printf hello', manualOnly: true })
  })

  it('a failed open names each node\'s reason, per id and in the message (#925)', async () => {
    vi.spyOn(pty, 'writeHeadless').mockReturnValue(false)
    const reply = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hello' }, true)
    const id = (reply.result as { id: string }).id
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/^launch-failed:/)
    expect(reply.error).toContain(`cancelled: ${id} (launch retained for Run now in the node)`)
    expect(reply.error).toContain('do not repeat the open request')
    // The result shape is unchanged; the per-id reasons ride beside it.
    expect(reply.result).toMatchObject({ failed: [id], deliveredIds: [], reasons: { [id]: 'cancelled' } })
  })

  it('line-too-long says Run now fails the same way and to shorten the prompt: --prompt-file is not a flag here (#925)', async () => {
    // A canonical-mode tty drops everything past its cap, so the echo never matches the command.
    const write = pty.writeHeadless.bind(pty)
    vi.spyOn(pty, 'writeHeadless').mockImplementation((key, data) =>
      write(key, data.length > MAX_LAUNCH_LINE_BYTES ? data.slice(0, MAX_LAUNCH_LINE_BYTES) : data)
    )
    // Only the delivery's timers are faked (3 x VERIFY_TIMEOUT_MS of real time otherwise); the
    // workspace store's file I/O stays real, so each step also yields to the event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let reply!: Awaited<ReturnType<HeadlessNodeFactory['openAgent']>>
    try {
      let settled = false
      const pending = factory
        .openAgent('term-source', { agent: 'claude', prompt: 'x'.repeat(1100) }, true)
        .finally(() => (settled = true))
      for (let i = 0; i < 400 && !settled; i++) {
        await new Promise((r) => setImmediate(r))
        await vi.advanceTimersByTimeAsync(100)
      }
      reply = await pending
    } finally {
      vi.useRealTimers()
    }
    const id = (reply.result as { id: string }).id
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/^launch-failed:/)
    expect(reply.error).toContain(`line-too-long: ${id}`)
    expect(reply.error).toContain('Run now will fail the same way')
    expect(reply.error).toContain('shorten the prompt')
    expect(reply.error).not.toContain('retained for Run now')
    expect(reply.error).not.toContain('--prompt-file')
    expect(reply.result).toMatchObject({ failed: [id], reasons: { [id]: 'line-too-long' } })
    expect(pty.sends).toEqual([]) // killed, never submitted
    // Still held, exactly as every other failure: the user can edit the node or delete it.
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
    expect(node?.pendingLaunch).toMatchObject({ manualOnly: true })
  })

  it('--prompt-file is not an open-agent flag on the Server Edition (the reply above relies on it)', async () => {
    const reply = await factory.openAgent('term-source', { agent: 'claude', 'prompt-file': '/tmp/brief.md' }, true)
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(/prompt-file/)
    expect(pty.creates).toEqual([])
  })

  it('accepts --run-now on open verbs as a no-op: server opens are already immediate (#925)', async () => {
    const reply = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hi', 'run-now': '' }, true)
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends).toEqual([{ nodeId: id, text: 'printf hi' }])
  })

  it('accepts --run-now on open-agent as the same no-op (#925)', async () => {
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'brief', 'run-now': '' }, true)
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'brief'" }])
  })

  it('refuses --run-now with --after on open-terminal before anything is created, saved or sent (#925)', async () => {
    states['term-upstream'] = 'working'
    const save = vi.spyOn(store, 'save')
    const reply = await factory.openTerminal(
      'term-source',
      { cwd: projectDir, cmd: 'printf hi', after: 'term-upstream', 'run-now': '' },
      true
    )
    expect(reply).toEqual({ ok: false, error: RUN_NOW_AFTER_REFUSAL })
    expect(save).not.toHaveBeenCalled()
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    expect(published).toEqual([])
    expect((await store.load({ sideline: false })).projects[0].nodes).toHaveLength(3)
  })

  it('refuses --run-now with --after on open-agent in the same words (#925)', async () => {
    states['term-upstream'] = 'working'
    const save = vi.spyOn(store, 'save')
    const reply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'brief', after: 'term-upstream', 'run-now': '1' },
      true
    )
    expect(reply).toEqual({ ok: false, error: RUN_NOW_AFTER_REFUSAL })
    expect(save).not.toHaveBeenCalled()
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
  })

  it('refuses --after-pr by name: the Server Edition keeps no pull request watch', async () => {
    // A silent drop would open the node and start it at once — before the PR the caller named.
    const save = vi.spyOn(store, 'save')
    for (const reply of [
      await factory.openAgent('term-source', { agent: 'claude', prompt: 'brief', 'after-pr': '7:merged' }, true),
      await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'make', 'after-pr': '7:merged' }, true)
    ]) {
      expect(reply).toMatchObject({ ok: false })
      expect((reply as { error: string }).error).toMatch(/--after-pr is not supported by Server Edition canvas control/)
    }
    expect(save).not.toHaveBeenCalled()
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
  })

  it('an explicit --run-now 0 is off, so --after still arms (#925)', async () => {
    states['term-upstream'] = 'working'
    const reply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: 'term-upstream', 'run-now': '0' },
      true
    )
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(reply.result).toMatchObject({ queued: true, queuedIds: [id], deliveredIds: [] })
    expect(pty.sends).toEqual([])
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
    expect(node?.pendingLaunch).toMatchObject({ after: ['term-upstream'], attempted: false })
  })

  it('run delivers a retained launch for the node owner (#925)', async () => {
    const spy = vi.spyOn(pty, 'writeHeadless').mockReturnValue(false)
    const opened = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hi' }, true)
    const id = (opened.result as { id: string }).id
    spy.mockRestore()
    pty.sends.length = 0
    const reply = await factory.run('term-source', { node: id }, true)
    expect(reply).toMatchObject({ ok: true, result: { started: true, startedIds: [id] } })
    expect(pty.sends).toEqual([{ nodeId: id, text: 'printf hi' }])
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
    expect(node?.pendingLaunch).toBeUndefined()
  })

  it('run saves its claim before typing; a failed delivery stays queued and names the reason (#925)', async () => {
    // An --after arm is the one held launch that has never been attempted, so the claim below is
    // run's own write-ahead and not one left behind by the open.
    states['term-upstream'] = 'working'
    const opened = await factory.openTerminal(
      'term-source',
      { cwd: projectDir, cmd: 'printf hi', after: 'term-upstream' },
      true
    )
    const id = (opened.result as { id: string }).id
    expect((await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)?.pendingLaunch)
      .toMatchObject({ attempted: false })
    expect(pty.sends).toEqual([])
    let durableAtFirstWrite: ReturnType<WorkspaceStore['load']> | undefined
    const refuse = vi.spyOn(pty, 'writeHeadless').mockImplementation(() => {
      durableAtFirstWrite ??= store.load({ sideline: false })
      return false
    })
    const reply = await factory.run('term-source', { node: id }, true)
    refuse.mockRestore()
    expect(reply).toMatchObject({
      ok: true,
      result: { started: false, startedIds: [], queued: true, queuedIds: [id], reason: 'cancelled' }
    })
    const claimed = (await durableAtFirstWrite!).projects[0].nodes.find((n) => n.id === id)
    expect(claimed?.pendingLaunch).toMatchObject({ command: 'printf hi', attempted: true, manualOnly: true })
    expect(pty.sends).toEqual([])
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)
    expect(node?.pendingLaunch).toMatchObject({ command: 'printf hi', attempted: true, manualOnly: true })
    // manualOnly: the dependency finishing never replays it.
    await factory.refreshArmed({ nodeId: 'term-upstream', state: 'done' })
    expect(pty.sends).toEqual([])
  })

  it('run refuses a non-owner, an unknown node and a node with nothing queued (#925)', async () => {
    const opened = await factory.openTerminal('term-source', { cwd: projectDir, cmd: 'printf hi' }, true)
    const id = (opened.result as { id: string }).id
    expect((await factory.run('someone-else', { node: id }, true)).error).toMatch(/^run-not-owner:/)
    expect((await factory.run('term-source', { node: id }, true)).error).toMatch(/^run-nothing-queued:/)
    expect((await factory.run('term-source', { node: id, cmd: 'x' }, true)).error).toMatch(/not supported/)
    expect((await factory.run('term-source', { node: id }, false)).error).toMatch(/^run-identity-refused:/)
    // Owned by this caller but gone from the canvas: the desktop's own wording.
    ownership.record('term-vanished', { sourceNodeId: 'term-source', projectId: 'project-1' })
    expect((await factory.run('term-source', { node: 'term-vanished' }, true)).error)
      .toBe('run: no node with id term-vanished')
  })

  it('run marks an agent it freshly spawned as awaiting its first working turn, as open does (#925)', async () => {
    // The open's spawn fails, so the node has no session and was never marked; run spawns it fresh.
    const spawn = vi.spyOn(pty, 'createHeadless').mockResolvedValueOnce({ sessionId: '', fresh: true })
    const opened = await factory.openAgent('term-source', { agent: 'claude', prompt: 'brief' }, true)
    spawn.mockRestore()
    expect(opened.ok).toBe(false)
    const agentNode = (opened.result as { id: string }).id
    expect(await factory.run('term-source', { node: agentNode }, true))
      .toMatchObject({ ok: true, result: { started: true } })
    // A dependent armed now must not be released by the fresh CLI's boot `done` blip.
    const dependent = await factory.openTerminal(
      'term-source',
      { cwd: projectDir, cmd: 'printf after', after: agentNode },
      true
    )
    const depId = (dependent.result as { id: string }).id
    pty.sends.length = 0
    await factory.refreshArmed({ nodeId: agentNode, state: 'done' })
    expect(pty.sends).toEqual([])
    await factory.refreshArmed({ nodeId: agentNode, state: 'working' })
    await factory.refreshArmed({ nodeId: agentNode, state: 'done' })
    expect(pty.sends).toEqual([{ nodeId: depId, text: 'printf after' }])
  })

  describe('run with a node id that two projects share (#925)', () => {
    // A committed `.nodeterm/project.json` opened from a second folder carries the same node ids.
    // The copy this caller spawned is in `project-1`; the stranger sorts FIRST.
    const held = { after: [], command: 'printf dup', executor: 'server' as const, attempted: false }
    let otherDir = ''

    beforeEach(async () => {
      otherDir = path.join(dataDir, 'other')
      fs.mkdirSync(otherDir, { recursive: true })
      const workspace = await store.load({ sideline: false })
      workspace.projects[0].nodes.push({ ...terminal('term-dup', 'Owned copy'), pendingLaunch: held })
      workspace.projects.unshift({
        id: 'project-0',
        name: 'Other checkout',
        color: '#0a84ff',
        cwd: otherDir,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [terminal('term-dup', 'Stranger copy')],
        bridges: [],
        ropes: []
      })
      await store.save(workspace)
      ownership.record('term-dup', { sourceNodeId: 'term-source', projectId: 'project-1' })
      const ordered = (await store.load({ sideline: false })).projects.map((p) => p.id)
      expect(ordered).toEqual(['project-0', 'project-1'])
    })

    const copies = async (): Promise<Record<string, CanvasNodeState | undefined>> => {
      const workspace = await store.load({ sideline: false })
      return Object.fromEntries(
        workspace.projects.map((p) => [p.id, p.nodes.find((n) => n.id === 'term-dup')])
      )
    }

    it('delivers and clears the OWNED copy, leaving the other project untouched', async () => {
      const before = (await copies())['project-0']
      const reply = await factory.run('term-source', { node: 'term-dup' }, true)
      expect(reply).toMatchObject({ ok: true, result: { started: true, startedIds: ['term-dup'] } })
      expect(pty.creates).toEqual([
        expect.objectContaining({ persistKey: 'term-dup', ownerProjectId: 'project-1' })
      ])
      expect(pty.sends).toEqual([{ nodeId: 'term-dup', text: 'printf dup' }])
      const after = await copies()
      expect(after['project-1']?.pendingLaunch).toBeUndefined()
      expect(after['project-0']).toEqual(before)
    })

    it('refuses a --project that is not the owned node\'s project, as the desktop does', async () => {
      expect(await factory.run('term-source', { node: 'term-dup', project: 'project-0' }, true))
        .toEqual({ ok: false, error: 'run: no node with id term-dup' })
      expect(pty.creates).toEqual([])
      expect((await copies())['project-1']?.pendingLaunch).toEqual(held)
      // The owned project named explicitly is the same as naming none.
      expect(await factory.run('term-source', { node: 'term-dup', project: 'project-1' }, true))
        .toMatchObject({ ok: true, result: { started: true } })
    })
  })

  it('run refuses an SSH node before any claim (#925)', async () => {
    const held = { after: [], command: 'printf hi', executor: 'server' as const, attempted: false }
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].nodes.push({
      ...terminal('term-remote', 'Remote'),
      sshRemoteTmux: true,
      pendingLaunch: held
    })
    await store.save(workspace)
    ownership.record('term-remote', { sourceNodeId: 'term-source', projectId: 'project-1' })
    const reply = await factory.run('term-source', { node: 'term-remote' }, true)
    expect(reply).toEqual({
      ok: false,
      error: 'run-remote-unsupported: term-remote is an SSH node; the Server Edition cannot start it'
    })
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    const node = (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === 'term-remote')
    expect(node?.pendingLaunch).toEqual(held)
  })
})

// Every content change this factory makes is CAST before it is SAVED (docs/hosted-team-relay.md):
// on a project a canvas authority governs, the save is overlaid with the authority's content, which
// holds only what it heard as ops — so a change that is not cast first is dropped from disk.
describe('HeadlessNodeFactory — casts every content change before it saves', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: FakePty
  let ownership: HeadlessNodeOwnership

  const deps = (over: Partial<HeadlessNodeFactoryDeps>): HeadlessNodeFactoryDeps => ({
    workspaceStore: store,
    ptyManager: pty,
    settings: () => ({ ...DEFAULT_SETTINGS, claudePermissionMode: 'manual' }),
    cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
    grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
    codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
    codexSharedIdentity: async () => false,
    ownership,
    stateOf: () => undefined,
    launchTiming: { quietMs: 0, capMs: 0 },
    ...over
  })

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-headless-cast-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    pty = new FakePty()
    ownership = createHeadlessNodeOwnership()
    ownership.record('term-owned', { sourceNodeId: 'term-source', projectId: 'project-1' })
    await store.save({
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Test',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [terminal('term-source', 'Director'), terminal('term-owned', 'Owned', 'gemini', 900)],
          bridges: [],
          ropes: []
        }
      ]
    })
  })

  afterEach(() => {
    setReflectedListener(null)
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const label = (m: CanvasMutation): string =>
    m.op === 'upsert'
      ? `upsert ${m.node.id}`
      : m.op === 'remove'
        ? `remove ${m.id}`
        : m.op === 'edge-upsert'
          ? `edge-upsert ${m.kind} ${m.edge.source}->${m.edge.target}`
          : m.op === 'edge-remove'
            ? `edge-remove ${m.id}`
            : m.op

  it('an open-agent that draws a rope and a bridge casts the node and BOTH edges, all before the save', async () => {
    const log: string[] = []
    const recording: HeadlessWorkspace = {
      load: (o) => store.load(o),
      save: async (ws) => {
        log.push('save')
        return store.save(ws)
      }
    }
    const factory = new HeadlessNodeFactory(
      deps({ workspaceStore: recording, publishMutation: (_p, m) => log.push(label(m)) })
    )
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    factory.stop()
    expect(reply).toMatchObject({ ok: true })
    const id = (reply.result as { id: string }).id
    // The first save persists the node, its hold, the rope and the bridge: every one of them was
    // cast BEFORE it, node first (an edge naming a node a peer does not have yet would be dropped).
    const firstSave = log.indexOf('save')
    expect(log.slice(0, firstSave)).toEqual([
      `upsert ${id}`,
      `edge-upsert bridge term-source->${id}`,
      `edge-upsert rope term-source->${id}`
    ])
    // The delivery's own save (the hold cleared) is cast before it too.
    expect(log.slice(firstSave + 1)).toEqual([`upsert ${id}`, 'save'])
  })

  it('a close casts the node removal and the edges it takes with it, before the save', async () => {
    const workspace = await store.load({ sideline: false })
    workspace.projects[0].ropes = [{ id: 'rope-1', source: 'term-source', target: 'term-owned' }]
    workspace.projects[0].bridges = [{ id: 'bridge-1', source: 'term-source', target: 'term-owned' }]
    await store.save(workspace)
    const log: string[] = []
    const recording: HeadlessWorkspace = {
      load: (o) => store.load(o),
      save: async (ws) => {
        log.push('save')
        return store.save(ws)
      }
    }
    const factory = new HeadlessNodeFactory(
      deps({ workspaceStore: recording, publishMutation: (_p, m) => log.push(label(m)) })
    )
    expect(await factory.close('term-source', { node: 'term-owned' }, true)).toMatchObject({ ok: true })
    factory.stop()
    expect(log).toEqual(['edge-remove bridge-1', 'edge-remove rope-1', 'remove term-owned', 'save'])
  })

  it('a verb that changes nothing casts nothing', async () => {
    const cast: CanvasMutation[] = []
    const factory = new HeadlessNodeFactory(deps({ publishMutation: (_p, m) => cast.push(m) }))
    // A refusal (unowned target) saves nothing and casts nothing.
    expect(await factory.rename('term-source', { node: 'term-source', title: 'x' })).toMatchObject({ ok: false })
    factory.stop()
    expect(cast).toEqual([])
  })

  it('on a GOVERNED project the new node and its rope survive the overlaid save (a real authority)', async () => {
    initCanvasSync()
    // No flush timer ever fires: what is on disk after the verb is exactly what its own save wrote.
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set(['project-1']),
      readContent: (id) => store.readProjectContent(id),
      writeContent: (id, c) => store.writeProjectContent(id, c),
      publish: (id, m) => {
        publishCanvasMutation(id, m)
      },
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {}
    })
    store.setContentAuthority(authority)
    setReflectedListener((id, m) => authority.onReflected(id, m))
    // The production default: casts go through the real reflector.
    const factory = new HeadlessNodeFactory(deps({}))
    const reply = await factory.openTerminal('term-source', {}, true)
    expect(reply).toMatchObject({ ok: true })
    const id = (reply.result as { id: string }).id
    const file = JSON.parse(fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')) as {
      nodes: CanvasNodeState[]
      ropes?: Array<{ source: string; target: string }>
    }
    expect(file.nodes.map((n) => n.id)).toContain(id)
    expect(file.ropes).toEqual([expect.objectContaining({ source: 'term-source', target: id })])

    // A verb with ONE save (the open above saves twice, so its second save would carry what the
    // first one's cast delivered late): the rename is on disk the moment the verb returns.
    const renamed = await factory.rename('term-source', { node: 'term-owned', title: 'Renamed' })
    factory.stop()
    expect(renamed).toMatchObject({ ok: true })
    const after = JSON.parse(fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')) as {
      nodes: CanvasNodeState[]
    }
    expect(after.nodes.find((n) => n.id === 'term-owned')?.title).toBe('Renamed')
    await authority.stop()
    store.setContentAuthority(null)
  })
})

describe('HeadlessNodeFactory — one load and one save, both through the cast helper (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'headless-node-factory.ts'), 'utf8').replace(/\r\n/g, '\n')
  it('every verb loads through loadForEdit and saves through castAndSave', () => {
    // A second `workspaceStore.save(` is a save site that casts nothing: on a governed project the
    // authority's overlay would drop whatever it changed.
    expect(src.match(/workspaceStore\.save\(/g)?.length).toBe(1)
    expect(src.match(/workspaceStore\.load\(/g)?.length).toBe(1)
    const saveAt = src.indexOf('workspaceStore.save(')
    const helper = src.lastIndexOf('private async castAndSave(', saveAt)
    expect(helper).toBeGreaterThan(0)
    expect(src.slice(helper, saveAt)).toContain('diffContent(')
    // The one read is the read-only view; every edit copies it (loadForEdit).
    const readAt = src.indexOf('workspaceStore.load(')
    expect(src.lastIndexOf('private readWorkspace(', readAt)).toBeGreaterThan(0)
  })

  it('browsers are sent the PERSISTED project, re-read after the save, never a verb\'s copy', () => {
    const calls = [...src.matchAll(/this\.deps\.publishProject/g)].map((m) => m.index ?? -1)
    const helper = src.indexOf('private async publishPersisted(')
    const end = src.indexOf('\n  }\n', helper)
    expect(helper).toBeGreaterThan(0)
    for (const at of calls) expect(at > helper && at < end, `publishProject outside publishPersisted at ${at}`).toBe(true)
    expect(src.slice(helper, end)).toContain('await this.readWorkspace()')
  })
})

// A launch can take seconds. A verb's SECOND save (after it) must never write back the copy it
// loaded before the launch: that copy predates whatever a teammate did meanwhile, and a whole-node
// upsert (or a whole-project broadcast) built from it would undo it. Each second phase re-reads, and
// re-applies only its own patch (the launch outcome).
describe('HeadlessNodeFactory — a second phase re-reads before it writes (fix round 1)', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: FakePty
  let ownership: HeadlessNodeOwnership
  let fake: FakePlatform
  let shared: Set<string>
  let states: Record<string, AgentState | undefined>
  let cast: CanvasMutation[]
  let broadcast: Project[]
  let authority: ReturnType<typeof createCanvasAuthority>

  const held = (command: string, after: string[] = []) => ({ after, command, executor: 'server' as const })
  const deps = (): HeadlessNodeFactoryDeps => ({
    workspaceStore: store,
    ptyManager: pty,
    settings: () => ({ ...DEFAULT_SETTINGS, claudePermissionMode: 'manual' }),
    cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
    grokCaps: async () => ({ sessionIdFlag: false, models: [] }),
    codexCaps: async () => ({ approvalValues: ['on-request', 'never'] }),
    codexSharedIdentity: async () => false,
    ownership,
    stateOf: (id) => states[id],
    launchTiming: { quietMs: 0, capMs: 0 },
    publishMutation: (id, m) => {
      cast.push(m)
      publishCanvasMutation(id, m)
    },
    publishProject: (project) => broadcast.push(structuredClone(project))
  })

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-headless-phase-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    fake = fakePlatform({ userDataDir: dataDir })
    initPlatform(fake)
    initCanvasSync()
    store = new WorkspaceStore()
    pty = new FakePty()
    states = {}
    cast = []
    broadcast = []
    ownership = createHeadlessNodeOwnership()
    for (const id of ['term-held', 'term-armed']) ownership.record(id, { sourceNodeId: 'term-source', projectId: 'project-1' })
    await store.save({
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Test',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            terminal('term-source', 'Director'),
            terminal('term-dep', 'Dependency', 'claude', 700),
            { ...terminal('term-held', 'Held', 'claude', 1400), pendingLaunch: held('printf held') },
            { ...terminal('term-armed', 'Armed', 'claude', 2100), pendingLaunch: held('printf armed', ['term-dep']) }
          ],
          bridges: [],
          ropes: []
        }
      ]
    })
    shared = new Set(['project-1'])
    authority = createCanvasAuthority({
      sharedProjectIds: () => shared,
      readContent: (id) => store.readProjectContent(id),
      writeContent: (id, c) => store.writeProjectContent(id, c),
      publish: (id, m) => {
        publishCanvasMutation(id, m)
      },
      // No flush timer ever fires: the disk holds exactly what the verb's own saves wrote.
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {}
    })
    store.setContentAuthority(authority)
    setReflectedListener((id, m) => authority.onReflected(id, m))
  })

  afterEach(async () => {
    await authority.stop()
    store.setContentAuthority(null)
    setReflectedListener(null)
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  /** A browser's cast, through the real reflector (the authority hears it). */
  const clientCast = (m: CanvasMutation): void => {
    fake.senderListeners[IPC.canvasMut](42, 'project-1', { ...m, src: 'browser-42' })
  }
  const liveNode = async (id: string): Promise<CanvasNodeState> =>
    (await store.load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)!
  const onDisk = (id: string): CanvasNodeState | undefined =>
    (JSON.parse(fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')) as { nodes: CanvasNodeState[] })
      .nodes.find((n) => n.id === id)
  const upsertsOf = (ms: CanvasMutation[], id: string): CanvasNodeState[] =>
    ms.flatMap((m) => (m.op === 'upsert' && m.node.id === id ? [m.node] : []))
  /**
   * A node's held launch as a RESTART would find it: a fresh store reading workspace.json and
   * project.json. `pendingLaunch` is machine-local (@shared/node-exec), so `onDisk` (project.json)
   * never has one whatever happened; the index's `localExec` is where a claim or a clear lands.
   */
  const indexed = async (id: string): Promise<CanvasNodeState['pendingLaunch']> =>
    (await new WorkspaceStore().load({ sideline: false })).projects[0].nodes.find((n) => n.id === id)?.pendingLaunch

  it('open: a move made while the launch runs survives on disk, in the cast and in the broadcast', async () => {
    const factory = new HeadlessNodeFactory(deps())
    let castAtMove = -1
    const create = pty.createHeadless.bind(pty)
    vi.spyOn(pty, 'createHeadless').mockImplementation(async (o) => {
      clientCast({ op: 'upsert', node: { ...(await liveNode(o.persistKey!)), position: { x: 999, y: 7 } } })
      castAtMove = cast.length
      return create(o)
    })
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    factory.stop()
    expect(reply).toMatchObject({ ok: true })
    const id = (reply.result as { id: string }).id
    expect(castAtMove).toBeGreaterThan(0)
    // The verb's own patch (the launch was delivered) landed; the teammate's move was kept.
    expect(onDisk(id)?.position).toEqual({ x: 999, y: 7 })
    expect(onDisk(id)?.pendingLaunch).toBeUndefined()
    expect(await indexed(id)).toBeUndefined()
    const later = upsertsOf(cast.slice(castAtMove), id)
    expect(later.length).toBeGreaterThan(0)
    for (const n of later) expect(n.position).toEqual({ x: 999, y: 7 })
    expect(broadcast.at(-1)?.nodes.find((n) => n.id === id)?.position).toEqual({ x: 999, y: 7 })
  })

  it('open: a node deleted while the launch runs stays deleted, and nothing re-creates it', async () => {
    const factory = new HeadlessNodeFactory(deps())
    let castAtDelete = -1
    let deleted = ''
    const create = pty.createHeadless.bind(pty)
    vi.spyOn(pty, 'createHeadless').mockImplementation(async (o) => {
      deleted = o.persistKey!
      clientCast({ op: 'remove', id: deleted })
      castAtDelete = cast.length
      return create(o)
    })
    await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    factory.stop()
    expect(deleted).not.toBe('')
    // Nothing is left for the verb to write (its node is gone), so the deletion reaches disk with the
    // authority's own flush — and a stale upsert from the verb would have re-created it there.
    await authority.flushAll()
    expect(onDisk(deleted)).toBeUndefined()
    expect(upsertsOf(cast.slice(castAtDelete), deleted)).toEqual([])
    expect(broadcast.at(-1)?.nodes.some((n) => n.id === deleted)).toBe(false)
  })

  it('run: a move made while the launch runs survives; the claim is cleared on the moved node', async () => {
    const factory = new HeadlessNodeFactory(deps())
    let castAtMove = -1
    const create = pty.createHeadless.bind(pty)
    vi.spyOn(pty, 'createHeadless').mockImplementation(async (o) => {
      clientCast({ op: 'upsert', node: { ...(await liveNode('term-held')), position: { x: 999, y: 7 } } })
      castAtMove = cast.length
      return create(o)
    })
    expect(await factory.run('term-source', { node: 'term-held' }, true)).toMatchObject({ ok: true, result: { started: true } })
    factory.stop()
    expect(onDisk('term-held')?.position).toEqual({ x: 999, y: 7 })
    expect(onDisk('term-held')?.pendingLaunch).toBeUndefined()
    expect(await indexed('term-held')).toBeUndefined()
    for (const n of upsertsOf(cast.slice(castAtMove), 'term-held')) expect(n.position).toEqual({ x: 999, y: 7 })
    expect(broadcast.at(-1)?.nodes.find((n) => n.id === 'term-held')?.position).toEqual({ x: 999, y: 7 })
  })

  it('refreshArmed: a move made while the held launch is typed survives; the arm is cleared on the moved node', async () => {
    const factory = new HeadlessNodeFactory(deps())
    pty.live.add('term-armed')
    let castAtMove = -1
    const send = pty.sendText.bind(pty)
    vi.spyOn(pty, 'sendText').mockImplementation(async (id, text) => {
      clientCast({ op: 'upsert', node: { ...(await liveNode('term-armed')), position: { x: 999, y: 7 } } })
      castAtMove = cast.length
      return send(id, text)
    })
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
    factory.stop()
    expect(pty.sends).toEqual([{ nodeId: 'term-armed', text: 'printf armed' }])
    expect(onDisk('term-armed')?.position).toEqual({ x: 999, y: 7 })
    expect(onDisk('term-armed')?.pendingLaunch).toBeUndefined()
    expect(await indexed('term-armed')).toBeUndefined()
    for (const n of upsertsOf(cast.slice(castAtMove), 'term-armed')) expect(n.position).toEqual({ x: 999, y: 7 })
    expect(broadcast.at(-1)?.nodes.find((n) => n.id === 'term-armed')?.position).toEqual({ x: 999, y: 7 })
  })

  it('an UNGOVERNED project: a browser save made while the launch runs is not overwritten either', async () => {
    shared.clear()
    const factory = new HeadlessNodeFactory(deps())
    const create = pty.createHeadless.bind(pty)
    vi.spyOn(pty, 'createHeadless').mockImplementation(async (o) => {
      const ws = await store.load({ sideline: false })
      const n = ws.projects[0].nodes.find((x) => x.id === o.persistKey)!
      n.position = { x: 999, y: 7 }
      await store.save(ws)
      return create(o)
    })
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    factory.stop()
    const id = (reply.result as { id: string }).id
    expect(onDisk(id)?.position).toEqual({ x: 999, y: 7 })
    expect(onDisk(id)?.pendingLaunch).toBeUndefined()
  })

  it('close: a browser save made while the panes are killed is not overwritten by the close', async () => {
    shared.clear()
    const factory = new HeadlessNodeFactory(deps())
    const destroy = pty.destroySession.bind(pty)
    vi.spyOn(pty, 'destroySession').mockImplementation(async (c, id, o) => {
      const ws = await store.load({ sideline: false })
      ws.projects[0].nodes.find((x) => x.id === 'term-dep')!.position = { x: 999, y: 7 }
      await store.save(ws)
      return destroy(c, id, o)
    })
    expect(await factory.close('term-source', { node: 'term-held' }, true)).toMatchObject({ ok: true })
    factory.stop()
    expect(onDisk('term-held')).toBeUndefined()
    expect(onDisk('term-dep')?.position).toEqual({ x: 999, y: 7 })
    expect(broadcast.at(-1)?.nodes.find((n) => n.id === 'term-dep')?.position).toEqual({ x: 999, y: 7 })
  })

  it('once canvas control stopped, a verb still mid-launch neither casts nor saves (and says so)', async () => {
    const factory = new HeadlessNodeFactory(deps())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const save = vi.spyOn(store, 'save')
    let castAtStop = -1
    let savesAtStop = -1
    const create = pty.createHeadless.bind(pty)
    vi.spyOn(pty, 'createHeadless').mockImplementation(async (o) => {
      factory.stop()
      castAtStop = cast.length
      savesAtStop = save.mock.calls.length
      return create(o)
    })
    await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    expect(castAtStop).toBeGreaterThan(0)
    expect(cast.length).toBe(castAtStop)
    expect(save.mock.calls.length).toBe(savesAtStop)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('canvas control stopped'))).toBe(true)
    warn.mockRestore()
  })

  it('a verb that stops before its FIRST save writes nothing either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const save = vi.spyOn(store, 'save')
    let factory: HeadlessNodeFactory | null = null
    factory = new HeadlessNodeFactory({
      ...deps(),
      cliCaps: async () => {
        factory!.stop()
        return { version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }
      }
    })
    const reply = await factory.openAgent('term-source', { agent: 'claude', prompt: 'hello' }, true)
    expect(cast).toEqual([])
    expect(save).not.toHaveBeenCalled()
    expect(broadcast).toEqual([])
    expect(warn.mock.calls.some((c) => String(c[0]).includes('canvas control stopped'))).toBe(true)
    // A refused creation save is a failure BEFORE any launch: no orphan agent session (D3).
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('open-agent-not-saved') })
    warn.mockRestore()
  })

  // D3: a second phase delivers ONLY what its write and its claim both landed. The claim's fresh read
  // can find the node gone or re-armed by a teammate, and a stopping factory refuses every save.
  it('run: stopped before its claim is saved, nothing is started and the launch stays queued (D3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const factory = new HeadlessNodeFactory(deps())
    const load = store.load.bind(store)
    vi.spyOn(store, 'load').mockImplementation(async (o) => {
      factory.stop()
      return load(o)
    })
    const reply = await factory.run('term-source', { node: 'term-held' }, true)
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('run-not-saved') })
    expect(pty.creates).toEqual([])
    expect(pty.sends).toEqual([])
    vi.mocked(store.load).mockRestore()
    expect(await indexed('term-held')).toMatchObject({ command: 'printf held' })
    expect((await indexed('term-held'))?.attempted).toBeUndefined()
    warn.mockRestore()
  })

  it('refreshArmed: stopped before its claim is saved, nothing is typed (D3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const factory = new HeadlessNodeFactory(deps())
    pty.live.add('term-armed')
    const exists = pty.sessionExists.bind(pty)
    vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
      if (id === 'term-armed') factory.stop()
      return exists(id)
    })
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
    expect(pty.sends).toEqual([])
    warn.mockRestore()
  })

  it('refreshArmed: a node a teammate deleted between the look and the claim is never typed into (D3)', async () => {
    const factory = new HeadlessNodeFactory(deps())
    pty.live.add('term-armed')
    const exists = pty.sessionExists.bind(pty)
    vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
      if (id === 'term-armed') clientCast({ op: 'remove', id: 'term-armed' })
      return exists(id)
    })
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
    factory.stop()
    expect(pty.sends).toEqual([])
    await authority.flushAll()
    expect(onDisk('term-armed')).toBeUndefined()
  })

  it('refreshArmed: a node re-armed with another command meanwhile is not typed the old one (D3)', async () => {
    const factory = new HeadlessNodeFactory(deps())
    pty.live.add('term-armed')
    const exists = pty.sessionExists.bind(pty)
    vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
      if (id !== 'term-armed') return exists(id)
      const ws = await store.load({ sideline: false })
      ws.projects[0].nodes.find((n) => n.id === 'term-armed')!.pendingLaunch = held('printf other', ['term-dep'])
      await store.save(ws)
      return exists(id)
    })
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
    factory.stop()
    expect(pty.sends).toEqual([])
    // The teammate's arm is left exactly as they wrote it: not claimed by the old command's pass.
    const after = await indexed('term-armed')
    expect(after).toMatchObject({ command: 'printf other' })
    expect(after?.manualOnly).toBeUndefined()
  })

  it('refreshArmed: a launch someone else claimed meanwhile is not typed a second time (D3)', async () => {
    const factory = new HeadlessNodeFactory(deps())
    pty.live.add('term-armed')
    const exists = pty.sessionExists.bind(pty)
    vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
      if (id !== 'term-armed') return exists(id)
      const ws = await store.load({ sideline: false })
      const n = ws.projects[0].nodes.find((x) => x.id === 'term-armed')!
      n.pendingLaunch = { ...n.pendingLaunch!, manualOnly: true, attempted: true }
      await store.save(ws)
      return exists(id)
    })
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
    factory.stop()
    expect(pty.sends).toEqual([])
  })

  describe('with another patch of the same pass landing in the same save (D3)', () => {
    // The save LANDS here: term-held (first in canvas order) records a dependency's first working
    // turn, which changes the file, so only the claim's own verdict can say that term-armed's claim
    // did not apply.
    const evidenceBeforeClaim = async (): Promise<void> => {
      const ws = await store.load({ sideline: false })
      const nodes = ws.projects[0].nodes
      nodes.find((n) => n.id === 'term-held')!.pendingLaunch = {
        ...held('printf held', ['term-dep']),
        awaitWorking: ['term-dep']
      }
      nodes.find((n) => n.id === 'term-armed')!.pendingLaunch = held('printf armed')
      await store.save(ws)
    }

    it('a deleted node is not typed into', async () => {
      await evidenceBeforeClaim()
      const factory = new HeadlessNodeFactory(deps())
      pty.live.add('term-armed')
      const exists = pty.sessionExists.bind(pty)
      vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
        if (id === 'term-armed') clientCast({ op: 'remove', id: 'term-armed' })
        return exists(id)
      })
      await factory.refreshArmed({ nodeId: 'term-dep', state: 'working' })
      factory.stop()
      expect(pty.sends).toEqual([])
      // The other patch of that save did land.
      expect((await indexed('term-held'))?.awaitWorking).toBeUndefined()
    })

    it('a launch someone else claimed is not typed a second time', async () => {
      await evidenceBeforeClaim()
      const factory = new HeadlessNodeFactory(deps())
      pty.live.add('term-armed')
      const exists = pty.sessionExists.bind(pty)
      vi.spyOn(pty, 'sessionExists').mockImplementation(async (id) => {
        if (id !== 'term-armed') return exists(id)
        const ws = await store.load({ sideline: false })
        const n = ws.projects[0].nodes.find((x) => x.id === 'term-armed')!
        n.pendingLaunch = { ...n.pendingLaunch!, manualOnly: true, attempted: true }
        await store.save(ws)
        return exists(id)
      })
      await factory.refreshArmed({ nodeId: 'term-dep', state: 'working' })
      factory.stop()
      expect(pty.sends).toEqual([])
      expect((await indexed('term-held'))?.awaitWorking).toBeUndefined()
    })
  })

  it('close: a close whose save is refused (stopping) says so instead of reporting success (D3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const factory = new HeadlessNodeFactory(deps())
    const destroy = pty.destroySession.bind(pty)
    vi.spyOn(pty, 'destroySession').mockImplementation(async (c, id, o) => {
      factory.stop()
      return destroy(c, id, o)
    })
    const reply = await factory.close('term-source', { node: 'term-held' }, true)
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('close-not-saved') })
    expect(broadcast).toEqual([])
    warn.mockRestore()
  })

  // `pendingLaunch` is a machine-local exec field (@shared/node-exec): never in project.json, never in
  // the authority's state (the reflector hands the authority every op without it, even an owner's).
  // On a governed project a launch therefore reaches disk ONLY through a save's exec carry
  // (`carryLocalNodeExec` in the authority's save overlay) into workspace.json's `localExec` — and
  // that is also the only way the factory's second-phase patches (claim, clear, awaitWorking) land.
  describe('a held launch on a GOVERNED project (machine-local)', () => {
    it('an armed node a browser tab adds keeps its launch across an authority flush and a reload', async () => {
      const heard: CanvasMutation[] = []
      setReflectedListener((id, m) => {
        heard.push(m)
        authority.onReflected(id, m)
      })
      // An OWNER tab (a cookie-authenticated Server Edition browser): the reflector keeps its launch
      // for the other owner tabs, and still hands the authority the op without one.
      fake.isOwnerClient = (id) => id === 42
      fake.clients.push(42)
      const launch = { after: ['term-dep'], command: 'printf new' }
      clientCast({ op: 'upsert', node: { ...terminal('term-new', 'New', 'claude', 2800), pendingLaunch: launch } })
      expect(upsertsOf(heard, 'term-new')).toHaveLength(1)
      expect(upsertsOf(heard, 'term-new')[0].pendingLaunch).toBeUndefined()
      expect(fake.sent.some((s) => s.to === 42 && (s.args[1] as CanvasMutation & { origin?: string }).origin === 'core')).toBe(true)
      // The tab's own whole-workspace save: its live node carries the launch, the overlay carries it
      // onto the authority's node, and the split keeps it in the index.
      const ws = await store.load({ sideline: false })
      ws.projects[0].nodes.find((n) => n.id === 'term-new')!.pendingLaunch = structuredClone(launch)
      await store.save(ws)
      // The authority's own write (project.json only) leaves the index alone.
      await authority.flushAll()
      expect(onDisk('term-new')).toBeDefined()
      expect(onDisk('term-new')?.pendingLaunch).toBeUndefined()
      expect(await indexed('term-new')).toEqual(launch)
      // A server restart: a fresh store under a fresh authority still hands the launch back.
      const store2 = new WorkspaceStore()
      const authority2 = createCanvasAuthority({
        sharedProjectIds: () => shared,
        readContent: (id) => store2.readProjectContent(id),
        writeContent: (id, c) => store2.writeProjectContent(id, c),
        publish: () => {},
        setTimer: () => null,
        clearTimer: () => {},
        log: () => {}
      })
      store2.setContentAuthority(authority2)
      const reloaded = (await store2.load({ sideline: false })).projects[0].nodes.find((n) => n.id === 'term-new')
      expect(reloaded?.pendingLaunch).toEqual(launch)
      await authority2.stop()
    })

    it('refreshArmed: the claim of a launch whose send fails reaches the index, never the authority, and survives a flush', async () => {
      const heard: CanvasMutation[] = []
      setReflectedListener((id, m) => {
        heard.push(m)
        authority.onReflected(id, m)
      })
      const factory = new HeadlessNodeFactory(deps())
      pty.live.add('term-armed')
      vi.spyOn(pty, 'sendText').mockResolvedValue(false)
      await factory.refreshArmed({ nodeId: 'term-dep', state: 'done' })
      factory.stop()
      const claimed = { after: ['term-dep'], command: 'printf armed', executor: 'server', attempted: true, manualOnly: true }
      // Cast (the core's own write: owner tabs get the claim), but heard by the authority without it.
      expect(upsertsOf(cast, 'term-armed').some((n) => n.pendingLaunch?.attempted === true)).toBe(true)
      expect(upsertsOf(heard, 'term-armed').length).toBeGreaterThan(0)
      for (const n of upsertsOf(heard, 'term-armed')) expect(n.pendingLaunch).toBeUndefined()
      expect(await indexed('term-armed')).toEqual(claimed)
      // A teammate's move, then the authority's flush: project.json moves, the claim stays put.
      clientCast({ op: 'upsert', node: { ...(await liveNode('term-armed')), position: { x: 5, y: 5 } } })
      await authority.flushAll()
      expect(onDisk('term-armed')?.position).toEqual({ x: 5, y: 5 })
      expect(onDisk('term-armed')?.pendingLaunch).toBeUndefined()
      expect(await indexed('term-armed')).toEqual(claimed)
    })

    it('refreshArmed: a first working turn drops awaitWorking from the index, keeping the arm', async () => {
      const ws = await store.load({ sideline: false })
      ws.projects[0].nodes.find((n) => n.id === 'term-armed')!.pendingLaunch = {
        ...held('printf armed', ['term-dep']),
        awaitWorking: ['term-dep']
      }
      await store.save(ws)
      expect((await indexed('term-armed'))?.awaitWorking).toEqual(['term-dep'])
      const factory = new HeadlessNodeFactory(deps())
      await factory.refreshArmed({ nodeId: 'term-dep', state: 'working' })
      factory.stop()
      const after = await indexed('term-armed')
      expect(after).toMatchObject({ after: ['term-dep'], command: 'printf armed', executor: 'server' })
      expect(after?.awaitWorking).toBeUndefined()
      await authority.flushAll()
      expect((await indexed('term-armed'))?.awaitWorking).toBeUndefined()
      expect((await indexed('term-armed'))?.command).toBe('printf armed')
    })
  })

  it('refreshArmed with nothing ready deep-copies nothing and saves nothing', async () => {
    const factory = new HeadlessNodeFactory(deps())
    const save = vi.spyOn(store, 'save')
    const clone = vi.spyOn(globalThis, 'structuredClone')
    // Armed, but its dependency is not done: nothing changes.
    await factory.refreshArmed({ nodeId: 'term-dep', state: 'working' })
    // A hook event from a node nobody waits on.
    await factory.refreshArmed({ nodeId: 'term-source', state: 'done' })
    factory.stop()
    expect(clone).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(cast).toEqual([])
    clone.mockRestore()
  })
})
