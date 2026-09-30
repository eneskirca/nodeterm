import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { createCanvasAuthority } from '../core/canvas-authority'
import { initCanvasSync, publishCanvasMutation, setReflectedListener } from '../core/canvas-sync'
import { IPC } from '../shared/ipc'
import type { CanvasMutation, CanvasNodeState, Project, Workspace } from '../shared/types'
import { createServerWorkspaceWatcher, outsideEditPublisher } from './workspace-external-watch'

const node = (id: string, x: number): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 640, height: 440 },
  title: id,
  color: '#0a84ff',
  group: null
})

describe('Server Edition external workspace watcher', () => {
  let dataDir = ''
  let projectDir = ''
  let fake: FakePlatform
  let watcher: ReturnType<typeof createServerWorkspaceWatcher> | null = null

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-server-watch-data-'))
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-server-watch-project-'))
    fake = fakePlatform({ userDataDir: dataDir })
    initPlatform(fake)
  })

  afterEach(async () => {
    watcher?.dispose()
    watcher = null
    resetPlatformForTests()
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(projectDir, { recursive: true, force: true })
  })

  it('adopts a hand-edited node/edge removal and broadcasts the complete project live', async () => {
    const source = node('term-source', 0)
    const removed = node('term-removed', 720)
    const kept = node('term-kept', 1440)
    const project: Project = {
      id: 'project-1',
      name: 'Project',
      color: '#0a84ff',
      cwd: projectDir,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [source, removed, kept],
      bridges: [
        { id: 'bridge-removed', source: source.id, target: removed.id },
        { id: 'bridge-kept', source: source.id, target: kept.id }
      ],
      ropes: [
        { id: 'rope-removed', source: source.id, target: removed.id },
        { id: 'rope-kept', source: source.id, target: kept.id }
      ]
    }
    const workspace: Workspace = {
      version: 2,
      activeProjectId: project.id,
      projects: [project]
    }
    const store = new WorkspaceStore()
    await store.save(workspace)
    fake.sent.length = 0
    watcher = createServerWorkspaceWatcher(store, { debounceMs: 20 })

    const file = path.join(projectDir, '.nodeterm', 'project.json')
    const edited = JSON.parse(await fs.readFile(file, 'utf8')) as {
      rev: number
      updatedAt: string
      nodes: CanvasNodeState[]
      bridges: Array<{ id: string; source: string; target: string }>
      ropes: Array<{ id: string; source: string; target: string }>
    }
    edited.rev += 1
    edited.updatedAt = new Date(Date.now() + 1_000).toISOString()
    edited.nodes = edited.nodes.filter((candidate) => candidate.id !== removed.id)
    edited.bridges = edited.bridges.filter(
      (edge) => edge.source !== removed.id && edge.target !== removed.id
    )
    edited.ropes = edited.ropes.filter(
      (edge) => edge.source !== removed.id && edge.target !== removed.id
    )
    await fs.writeFile(file, JSON.stringify(edited), 'utf8')

    await vi.waitFor(() => {
      expect(fake.sent.some((event) => event.channel === IPC.workspaceExternalChange)).toBe(true)
    }, { timeout: 3_000, interval: 20 })

    const event = fake.sent.filter((entry) => entry.channel === IPC.workspaceExternalChange).at(-1)!
    const incoming = event.args[0] as Project
    expect(incoming.nodes.map((candidate) => candidate.id)).toEqual([source.id, kept.id])
    expect(incoming.bridges).toEqual([{ id: 'bridge-kept', source: source.id, target: kept.id }])
    expect(incoming.ropes).toEqual([{ id: 'rope-kept', source: source.id, target: kept.id }])
    // This one IS an outside edit — a hand edit or a git pull — so it belongs on the channel the
    // renderer answers with the conflict bar, and must never be swapped onto the server-write
    // channel a later refactor might mistake it for (that one merges silently, no question asked).
    expect(fake.sent.filter((entry) => entry.channel === IPC.workspaceServerChange)).toEqual([])
  })

  it('routes a GOVERNED project\'s outside edit through the canvas authority: ops, never the conflict bar', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-server-watch-other-'))
    try {
      const a = node('term-a', 0)
      const b = node('term-b', 720)
      const governedProject: Project = {
        id: 'project-g',
        name: 'Governed',
        color: '#0a84ff',
        cwd: projectDir,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [a, b],
        bridges: [{ id: 'bridge-ab', source: a.id, target: b.id }],
        ropes: []
      }
      const plainProject: Project = {
        id: 'project-u',
        name: 'Ungoverned',
        color: '#0a84ff',
        cwd: otherDir,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [node('term-u', 0)],
        bridges: [],
        ropes: []
      }
      const store = new WorkspaceStore()
      await store.save({ version: 2, activeProjectId: governedProject.id, projects: [governedProject, plainProject] })
      initCanvasSync()
      fake.clients.push(1)
      const authority = createCanvasAuthority({
        sharedProjectIds: () => new Set([governedProject.id]),
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
      // Boot adopts every shared project eagerly, BEFORE any outside edit can arrive: a lazy adoption
      // after the edit would read the edited file as its baseline and publish no diff at all.
      authority.sharedChanged()
      await authority.flushAll()
      fake.sent.length = 0
      watcher = createServerWorkspaceWatcher(store, {
        debounceMs: 20,
        publish: outsideEditPublisher(
          () => authority,
          (p) => fake.broadcast(IPC.workspaceExternalChange, p),
          (p) => fake.broadcast(IPC.workspaceServerChange, p)
        )
      })

      // A git pull removes the bridge from the governed project.
      const file = path.join(projectDir, '.nodeterm', 'project.json')
      const edited = JSON.parse(await fs.readFile(file, 'utf8')) as { rev: number; updatedAt: string; bridges: unknown[] }
      edited.rev += 1
      edited.updatedAt = new Date(Date.now() + 1_000).toISOString()
      edited.bridges = []
      await fs.writeFile(file, JSON.stringify(edited), 'utf8')
      const muts = (): CanvasMutation[] =>
        fake.sent.filter((e) => e.channel === IPC.canvasMut && e.args[0] === governedProject.id).map((e) => e.args[1] as CanvasMutation)
      await vi.waitFor(() => {
        expect(muts().map((m) => m.op)).toEqual(['edge-remove'])
      }, { timeout: 3_000, interval: 20 })
      expect(muts()[0]).toMatchObject({ op: 'edge-remove', id: 'bridge-ab', seq: expect.any(Number) })
      expect(fake.sent.filter((e) => e.channel === IPC.workspaceExternalChange)).toEqual([])

      // The ungoverned project keeps the whole-project broadcast.
      const otherFile = path.join(otherDir, '.nodeterm', 'project.json')
      const other = JSON.parse(await fs.readFile(otherFile, 'utf8')) as { rev: number; updatedAt: string; nodes: CanvasNodeState[] }
      other.rev += 1
      other.updatedAt = new Date(Date.now() + 2_000).toISOString()
      other.nodes = []
      await fs.writeFile(otherFile, JSON.stringify(other), 'utf8')
      await vi.waitFor(() => {
        expect(fake.sent.some((e) => e.channel === IPC.workspaceExternalChange)).toBe(true)
      }, { timeout: 3_000, interval: 20 })
      const broadcast = fake.sent.filter((e) => e.channel === IPC.workspaceExternalChange)
      expect(broadcast.map((e) => (e.args[0] as Project).id)).toEqual([plainProject.id])
      expect(fake.sent.filter((e) => e.channel === IPC.canvasMut && e.args[0] === plainProject.id)).toEqual([])
      await authority.stop()
    } finally {
      setReflectedListener(null)
      await fs.rm(otherDir, { recursive: true, force: true })
    }
  })

  it('a GOVERNED outside edit\'s other fields reach clients on workspace:server-change, and a stale tab\'s next save keeps them (R15)', async () => {
    const a = node('term-a', 0)
    const governedProject: Project = {
      id: 'project-g',
      name: 'Governed',
      color: '#0a84ff',
      cwd: projectDir,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [a],
      defaultPermissionMode: 'bypassPermissions'
    }
    const store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: governedProject.id, projects: [governedProject] })
    initCanvasSync()
    fake.clients.push(1)
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set([governedProject.id]),
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
    try {
      authority.sharedChanged()
      await authority.flushAll()
      fake.sent.length = 0
      watcher = createServerWorkspaceWatcher(store, {
        debounceMs: 20,
        publish: outsideEditPublisher(
          () => authority,
          (p) => fake.broadcast(IPC.workspaceExternalChange, p),
          (p) => fake.broadcast(IPC.workspaceServerChange, p)
        )
      })

      // A git pull renames the project and TIGHTENS its permission default (and moves a node).
      const file = path.join(projectDir, '.nodeterm', 'project.json')
      const edited = JSON.parse(await fs.readFile(file, 'utf8')) as {
        rev: number
        updatedAt: string
        name: string
        defaultPermissionMode?: string
        nodes: CanvasNodeState[]
      }
      edited.rev += 1
      edited.updatedAt = new Date(Date.now() + 1_000).toISOString()
      edited.name = 'Renamed'
      edited.defaultPermissionMode = 'manual'
      edited.nodes = edited.nodes.map((n) => ({ ...n, position: { x: 500, y: 0 } }))
      await fs.writeFile(file, JSON.stringify(edited), 'utf8')

      await vi.waitFor(() => {
        expect(fake.sent.some((e) => e.channel === IPC.workspaceServerChange)).toBe(true)
      }, { timeout: 3_000, interval: 20 })
      const changes = fake.sent.filter((e) => e.channel === IPC.workspaceServerChange)
      expect(changes).toHaveLength(1)
      const incoming = changes[0].args[0] as Project
      expect(incoming.id).toBe(governedProject.id)
      expect(incoming.name).toBe('Renamed')
      expect(incoming.defaultPermissionMode).toBe('manual')
      expect(incoming.nodes.map((n) => n.position.x)).toEqual([500])
      // Still no conflict bar: the content travelled as ops, the rest merges silently.
      expect(fake.sent.filter((e) => e.channel === IPC.workspaceExternalChange)).toEqual([])
      // The ops went out BEFORE the project, so a client merging it already holds the content.
      const lastOp = fake.sent.map((e) => e.channel).lastIndexOf(IPC.canvasMut)
      expect(lastOp).toBeGreaterThanOrEqual(0)
      expect(lastOp).toBeLessThan(fake.sent.findIndex((e) => e.channel === IPC.workspaceServerChange))

      // A tab that still held the OLD copy adopts the incoming project (`replaceProject`, which is
      // what the renderer does with workspace:server-change) and saves: the pulled values stay.
      const tabCopy: Project = incoming
      await store.save({ version: 2, activeProjectId: tabCopy.id, projects: [tabCopy] })
      const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { name: string; defaultPermissionMode?: string }
      expect(onDisk.name).toBe('Renamed')
      expect(onDisk.defaultPermissionMode).toBe('manual')
      await authority.stop()
    } finally {
      setReflectedListener(null)
      store.setContentAuthority(null)
    }
  })

  // N5: an edit the authority could not turn into ops is still delivered — whole, on the channel the
  // ungoverned path uses — instead of being swallowed.
  it('routes by what the authority did: ops → server change; no baseline → whole project; nothing → as ungoverned', async () => {
    const external: Project[] = []
    const server: Project[] = []
    const p = { id: 'g', name: 'g', color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] } as Project
    const persisted = { ...p, name: 'persisted' }
    for (const answer of [{ project: persisted, asOps: true }, { project: persisted, asOps: false }, null]) {
      const route = outsideEditPublisher(
        () => ({ governs: () => true, adoptOutsideEdit: async () => answer }),
        (x) => external.push(x),
        (x) => server.push(x)
      )
      route(p)
      await new Promise((r) => setImmediate(r))
    }
    expect(server).toEqual([persisted])
    expect(external).toEqual([persisted, p])
  })

  it('with no authority (another server owns this data dir), every outside edit is broadcast', () => {
    const sent: Project[] = []
    const route = outsideEditPublisher(() => null, (p) => sent.push(p), () => {
      throw new Error('an ungoverned edit is never a server change')
    })
    const p = { id: 'x', name: 'x', color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] } as Project
    route(p)
    expect(sent).toEqual([p])
  })
})
