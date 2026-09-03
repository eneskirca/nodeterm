import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import type { AgentState } from '../shared/agents/normalize'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessNodeOwnership,
  type HeadlessPty
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

  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.creates.push(options)
    if (options.persistKey) this.live.add(options.persistKey)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }

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
    published = []
    removed = []
    publishedProjects = []
    codexSharedIdentity = false
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
      codexSharedIdentity: async () => codexSharedIdentity,
      ownership,
      stateOf: (id) => states[id],
      publishNode: (_projectId, node) => published.push(node),
      publishRemoval: (_projectId, nodeId) => removed.push(nodeId),
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
    expect(published.map((node) => node.id)).toEqual([id])

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
      error: expect.stringContaining('link-project-refused')
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
    expect(published.map((node) => node.id)).toEqual([
      'term-upstream',
      groupId,
      'sticky-color'
    ])
    expect(publishedProjects).toHaveLength(1)
    expect(pty.sends).toEqual([])
    expect(pty.destroys).toEqual([])
    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as { nodes: CanvasNodeState[] }
    expect(projectFile.nodes.find((node) => node.id === 'sticky-color')?.color).toBe('#32d74b')
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
    ['codex', "codex 'do work' --ask-for-approval untrusted"],
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
      text: "nodeterm-codex 'do work' --ask-for-approval untrusted"
    })
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

    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toEqual({
      after: ['term-upstream'],
      command: "claude 'consume result'",
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
})
