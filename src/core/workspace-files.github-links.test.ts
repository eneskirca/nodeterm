import { describe, expect, it } from 'vitest'
import type { GitHubLink } from '../shared/github-issues'
import type { CanvasNodeState, Project } from '../shared/types'
import { fileToProject, projectToFile } from './workspace-files'

const links: GitHubLink[] = [
  { kind: 'issue', number: 462, title: 'GitHub issues on the board' },
  { kind: 'pull', number: 584 }
]

const node = (extra?: Partial<CanvasNodeState>): CanvasNodeState => ({
  id: 'term-a-1',
  kind: 'terminal',
  position: { x: 10, y: 20 },
  size: { width: 300, height: 170 },
  title: 'Work',
  color: '#888',
  group: null,
  github: links,
  ...extra
})

const project = (nodes: CanvasNodeState[]): Project => ({
  id: 'project-1',
  name: 'Test',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes
})

describe('github links at the project-file boundary', () => {
  it('round-trips links through projectToFile → fileToProject', () => {
    const file = projectToFile(project([node()]), 1, '2026-09-02T00:00:00Z')
    expect(file.nodes[0].github).toEqual(links)
    const back = fileToProject(file, { id: 'project-1' })
    expect(back.nodes[0].github).toEqual(links)
  })

  it('round-trips links on a group frame', () => {
    const frame = node({ id: 'group-a-1', kind: 'group', github: [{ kind: 'pull', number: 7 }] })
    const back = fileToProject(projectToFile(project([frame]), 1, 'ts'), { id: 'project-1' })
    expect(back.nodes[0].github).toEqual([{ kind: 'pull', number: 7 }])
  })

  it('normalizes a hostile file on READ — bad kinds, numbers, titles and overflow', () => {
    const file = projectToFile(project([node()]), 1, 'ts')
    const hostile = {
      ...file,
      nodes: [{
        ...file.nodes[0],
        github: [
          { kind: 'commit', number: 1 },
          { kind: 'issue', number: -1 },
          { kind: 'issue', number: 5, title: 'x'.repeat(500), extra: 'smuggled' },
          ...Array.from({ length: 40 }, (_, index) => ({ kind: 'pull', number: index + 100 }))
        ] as never
      }]
    }
    const back = fileToProject(hostile, { id: 'project-1' })
    expect(back.nodes[0].github).toHaveLength(20)
    expect(back.nodes[0].github?.[0]).toEqual({ kind: 'issue', number: 5 })
    expect(JSON.stringify(back.nodes[0].github)).not.toContain('smuggled')
  })

  it('never writes a malformed array into the shared file', () => {
    const bad = node({ github: [{ kind: 'commit', number: 1 }] as never })
    const file = projectToFile(project([bad]), 1, 'ts')
    expect(file.nodes[0].github).toBeUndefined()
  })

  it('leaves a link-less node byte-identical', () => {
    const plain = node()
    delete plain.github
    const file = projectToFile(project([plain]), 1, 'ts')
    expect('github' in file.nodes[0]).toBe(false)
  })
})
