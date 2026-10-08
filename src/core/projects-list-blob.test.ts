// The `projects.list` blob (core/projects-list-blob.ts): the one assembly the desktop's
// `listProjectsOutput` and the Android interop fixture share (audit A64). These pin its contract on
// the desktop side, where every CI run sees it; the Android relay interop test parses what the same
// function produces with the Kotlin client.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, promises as fs, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import {
  AGENT_STATUS_FILE,
  _resetForTest as resetMirror,
  flush as flushMirror,
  initAgentStatusMirror,
  recordAgentEvent
} from './agent-status-mirror'
import { buildProjectsListBlob, PROJECTS_SPLIT_MARK, STATUS_SPLIT_MARK } from './projects-list-blob'
import type { Workspace } from '../shared/types'

let userData = ''

beforeEach(() => {
  userData = mkdtempSync(path.join(os.tmpdir(), 'nt-projects-blob-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: userData }))
  resetMirror()
})

afterEach(() => {
  resetMirror()
  resetPlatformForTests()
  rmSync(userData, { recursive: true, force: true })
})

const EMPTY: Workspace = { version: 2, activeProjectId: '', projects: [] }

/** Split exactly the way both phone clients do: on the marker lines. */
function sections(blob: string): { workspace: string; sessions: string; status: string } {
  const [workspace, rest] = blob.split(`\n${PROJECTS_SPLIT_MARK}\n`)
  const [sessions, status] = rest.split(`\n${STATUS_SPLIT_MARK}\n`)
  return { workspace, sessions, status }
}

describe('buildProjectsListBlob', () => {
  it('lays out workspace, session names and the mirror file between the two markers the phones split on', async () => {
    await fs.writeFile(path.join(userData, AGENT_STATUS_FILE), '{"v":1}')
    const blob = await buildProjectsListBlob({
      workspace: { load: async () => EMPTY },
      userDataDir: userData,
      listSessions: async () => ['nt-a', 'nt-b']
    })
    // The markers are wire contract (NodetermProjects.swift, ProjectsParser.kt): pinned verbatim.
    expect(PROJECTS_SPLIT_MARK).toBe('--NT-PROJECTS-SPLIT--')
    expect(STATUS_SPLIT_MARK).toBe('--NT-STATUS-SPLIT--')
    expect(blob).toBe(`${JSON.stringify(EMPTY)}\n--NT-PROJECTS-SPLIT--\nnt-a\nnt-b\n--NT-STATUS-SPLIT--\n{"v":1}`)
  })

  it('loads the workspace read-only, so a listing mid git-merge never sidelines a project file', async () => {
    const seen: Array<{ sideline: boolean }> = []
    await buildProjectsListBlob({
      workspace: {
        load: async (opts) => {
          seen.push(opts)
          return EMPTY
        }
      },
      userDataDir: userData,
      listSessions: async () => []
    })
    expect(seen).toEqual([{ sideline: false }])
  })

  it('degrades each failed read to an empty section and never rejects', async () => {
    const blob = await buildProjectsListBlob({
      workspace: { load: () => Promise.reject(new Error('index unreadable')) },
      userDataDir: path.join(userData, 'missing'),
      listSessions: () => Promise.reject(new Error('no tmux'))
    })
    expect(blob).toBe(`\n${PROJECTS_SPLIT_MARK}\n\n${STATUS_SPLIT_MARK}\n`)
  })

  it('serves the ASSEMBLED v2 workspace from a v3 index, and the file the mirror itself wrote', async () => {
    // The real store: a folder ref's nodes live only in its .nodeterm/project.json, never in the index.
    const repo = path.join(userData, 'repo')
    await new WorkspaceStore().save({
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Demo',
          color: '#0a84ff',
          cwd: repo,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            { id: 'term-1', kind: 'terminal', title: 'T', color: '#000', group: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
          ]
        }
      ]
    })
    expect(JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf8')).version).toBe(3)
    // The real mirror, at its default path: writer and reader must agree on the file.
    initAgentStatusMirror()
    recordAgentEvent({ nodeId: 'term-1', agentId: 'claude', kind: 'state', state: 'working', sessionId: 's-1' })
    await flushMirror()

    const blob = await buildProjectsListBlob({
      workspace: new WorkspaceStore(),
      userDataDir: userData,
      listSessions: async () => ['nt-term-1']
    })
    const s = sections(blob)
    const workspace = JSON.parse(s.workspace) as Workspace
    expect(workspace.version).toBe(2)
    expect(workspace.projects[0]).toMatchObject({ id: 'p1', name: 'Demo', cwd: repo })
    expect(workspace.projects[0].nodes.map((n) => n.id)).toEqual(['term-1'])
    expect(s.sessions).toBe('nt-term-1')
    expect(JSON.parse(s.status).nodes['term-1']).toMatchObject({ state: 'working', agentId: 'claude', sessionId: 's-1' })
  })
})
