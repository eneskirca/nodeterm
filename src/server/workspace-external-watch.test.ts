import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform, type FakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { IPC } from '../shared/ipc'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { createServerWorkspaceWatcher } from './workspace-external-watch'

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
})
