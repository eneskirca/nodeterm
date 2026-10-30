import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import type { SshServer } from '@shared/ssh'
import { countOpenProjects } from '@shared/project-limit'
import { opensProject } from './projectOpens'
import { useProjects } from '../state/projects'

/**
 * `opensProject` decides whether the project-limit gate is asked at all (docs/project-limit.md,
 * Definitions: "Activating a project that is already open is not an open"). Each case is checked
 * against the store action the call site runs right after it, so the prediction cannot drift from
 * what the store does.
 */

const server = (over: Partial<SshServer> = {}): SshServer => ({
  id: 'srv-1',
  label: 'box',
  host: 'box.example',
  user: 'me',
  ...over
})

function project(id: string, over: Partial<Project> = {}): Project {
  return { id, name: id, color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over }
}

describe('opensProject — new', () => {
  it('always opens a project', () => {
    expect(opensProject([], { kind: 'new' })).toBe(true)
    expect(opensProject([project('a', { cwd: '/a' })], { kind: 'new' })).toBe(true)
  })
})

describe('opensProject — folder (openFolderProject / adopt)', () => {
  it('opens when no project has that cwd', () => {
    expect(opensProject([project('a', { cwd: '/x' })], { kind: 'folder', folder: '/a/b' })).toBe(true)
  })

  it('does not open when an OPEN project already has that cwd (it is only activated)', () => {
    expect(opensProject([project('a', { cwd: '/a/b' })], { kind: 'folder', folder: '/a/b' })).toBe(false)
  })

  it('opens when the project with that cwd is closed (it is reopened)', () => {
    expect(opensProject([project('a', { cwd: '/a/b', closed: true })], { kind: 'folder', folder: '/a/b' })).toBe(true)
  })

  it('opens when only a relay tab carries that cwd (the store never routes a local folder to it)', () => {
    expect(opensProject([project('r', { cwd: '/a/b', remote: true })], { kind: 'folder', folder: '/a/b' })).toBe(true)
  })

  it('matches the cwd exactly, like openFolderProject', () => {
    expect(opensProject([project('a', { cwd: '/a/b' })], { kind: 'folder', folder: '/a/b/' })).toBe(true)
  })
})

describe('opensProject — ssh (openSshProject)', () => {
  const ssh = { server: server(), remoteCwd: '/srv/app' }

  it('opens when no project has that endpoint and remote folder', () => {
    expect(opensProject([project('a', { cwd: '/srv/app' })], { kind: 'ssh', ssh })).toBe(true)
    expect(
      opensProject([project('a', { ssh: { server: server(), remoteCwd: '/srv/other' } })], { kind: 'ssh', ssh })
    ).toBe(true)
  })

  it('does not open when an open project already serves that folder — even under another server entry', () => {
    const reAdded = { server: server({ id: 'srv-2', label: 'renamed' }), remoteCwd: '/srv/app' }
    expect(opensProject([project('a', { ssh: reAdded })], { kind: 'ssh', ssh })).toBe(false)
  })

  it('treats a missing port as 22, like sameSshEndpoint', () => {
    const explicit = { server: server({ port: 22 }), remoteCwd: '/srv/app' }
    expect(opensProject([project('a', { ssh: explicit })], { kind: 'ssh', ssh })).toBe(false)
    const other = { server: server({ port: 2222 }), remoteCwd: '/srv/app' }
    expect(opensProject([project('a', { ssh: other })], { kind: 'ssh', ssh })).toBe(true)
  })

  it('opens when that SSH project is closed (it is reopened)', () => {
    expect(opensProject([project('a', { ssh, closed: true })], { kind: 'ssh', ssh })).toBe(true)
  })
})

describe('opensProject — reopen', () => {
  it('opens a closed project', () => {
    expect(opensProject([project('a', { closed: true })], { kind: 'reopen', id: 'a' })).toBe(true)
  })

  it('does not open an already-open project (activation only)', () => {
    expect(opensProject([project('a')], { kind: 'reopen', id: 'a' })).toBe(false)
  })

  it('does not open a relay tab (reopenProjectUnchecked refuses it, and relay tabs never count)', () => {
    expect(opensProject([project('r', { closed: true, remote: true })], { kind: 'reopen', id: 'r' })).toBe(false)
  })

  it('does not open a project that does not exist', () => {
    expect(opensProject([project('a', { closed: true })], { kind: 'reopen', id: 'gone' })).toBe(false)
  })
})

describe('opensProject — register (the agent verb’s registerProject)', () => {
  it('opens when no project has that cwd', () => {
    expect(opensProject([], { kind: 'register', cwd: '/a/b' })).toBe(true)
  })

  it('normalizes the trailing slash exactly as registerProject does', () => {
    expect(opensProject([project('a', { cwd: '/a/b' })], { kind: 'register', cwd: '/a/b/' })).toBe(false)
    expect(opensProject([project('a', { cwd: '/a/b' })], { kind: 'register', cwd: '/a/b//' })).toBe(false)
  })

  it('keeps root as "/" — it does not match a cwd-less project', () => {
    expect(opensProject([project('a')], { kind: 'register', cwd: '/' })).toBe(true)
    expect(opensProject([project('a', { cwd: '/' })], { kind: 'register', cwd: '/' })).toBe(false)
  })

  it('opens when the project with that cwd is closed (registerProject un-closes it)', () => {
    expect(opensProject([project('a', { cwd: '/a/b', closed: true })], { kind: 'register', cwd: '/a/b/' })).toBe(true)
  })
})

describe('opensProject agrees with what the store action then does to the open count', () => {
  type Case = { name: string; projects: Project[]; act: () => void; predict: Parameters<typeof opensProject>[1] }
  const ssh = { server: server(), remoteCwd: '/srv/app' }
  const cases: Case[] = [
    {
      name: 'openFolderProject on an open folder',
      projects: [project('a', { cwd: '/a/b' })],
      act: () => useProjects.getState().openFolderProject('/a/b'),
      predict: { kind: 'folder', folder: '/a/b' }
    },
    {
      name: 'openFolderProject on a closed folder',
      projects: [project('a', { cwd: '/a/b', closed: true }), project('o')],
      act: () => useProjects.getState().openFolderProject('/a/b'),
      predict: { kind: 'folder', folder: '/a/b' }
    },
    {
      name: 'openFolderProject beside a relay tab with the same cwd',
      projects: [project('r', { cwd: '/a/b', remote: true })],
      act: () => useProjects.getState().openFolderProject('/a/b'),
      predict: { kind: 'folder', folder: '/a/b' }
    },
    {
      name: 'openSshProject on an open endpoint',
      projects: [project('a', { ssh })],
      act: () => useProjects.getState().openSshProject('box', ssh),
      predict: { kind: 'ssh', ssh }
    },
    {
      name: 'openSshProject on a closed endpoint',
      projects: [project('a', { ssh, closed: true })],
      act: () => useProjects.getState().openSshProject('box', ssh),
      predict: { kind: 'ssh', ssh }
    },
    {
      name: 'openSshProject on a new endpoint',
      projects: [],
      act: () => useProjects.getState().openSshProject('box', ssh),
      predict: { kind: 'ssh', ssh }
    },
    {
      name: 'reopenProject on a closed project',
      projects: [project('a', { closed: true })],
      act: () => useProjects.getState().reopenProject('a'),
      predict: { kind: 'reopen', id: 'a' }
    },
    {
      name: 'registerProject with a trailing slash on an open folder',
      projects: [project('a', { cwd: '/a/b' })],
      act: () => useProjects.getState().registerProject({ resolvedCwd: '/a/b/' }),
      predict: { kind: 'register', cwd: '/a/b/' }
    },
    {
      name: 'registerProject on a closed folder',
      projects: [project('a', { cwd: '/a/b', closed: true })],
      act: () => useProjects.getState().registerProject({ resolvedCwd: '/a/b' }),
      predict: { kind: 'register', cwd: '/a/b' }
    },
    {
      name: 'registerProject on a new folder',
      projects: [project('a', { cwd: '/x' })],
      act: () => useProjects.getState().registerProject({ resolvedCwd: '/a/b/' }),
      predict: { kind: 'register', cwd: '/a/b/' }
    }
  ]
  for (const c of cases) {
    it(c.name, () => {
      useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: c.projects })
      const before = countOpenProjects(useProjects.getState().projects)
      const predicted = opensProject(useProjects.getState().projects, c.predict)
      c.act()
      const after = countOpenProjects(useProjects.getState().projects)
      expect(predicted).toBe(after > before)
    })
  }
})
