import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import { fileToProject, projectToFile, sanitizeLinks } from './workspace-files'

// `bridges` / `ropes` come straight out of the git-shared, hand-editable project file, and every
// reader maps them as `BridgeLink[]` — the canvas's rope restore did `ropes.map((r) => r.id)`, so a
// single `null` entry threw on project load.
const node: CanvasNodeState = {
  id: 'a', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
  title: 't', color: '#fff', group: null
}
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })

describe('sanitizeLinks', () => {
  it('returns the same array when every entry is well-formed', () => {
    const links = [rope('a', 'b'), { ...rope('b', 'c'), extra: 1 }]
    expect(sanitizeLinks(links)).toBe(links)
  })

  it('drops the entries a reader cannot use, keeping the rest in order', () => {
    const hostile: unknown[] = [
      null, 5, 'ctrl-a-b', [], rope('a', 'b'),
      { id: 'x', source: {}, target: 'b' }, { id: '', source: 'a', target: 'b' },
      { source: 'a', target: 'b' }, { id: 'y', source: 'a', target: '' }, rope('b', 'c')
    ]
    expect(sanitizeLinks(hostile)).toEqual([rope('a', 'b'), rope('b', 'c')])
  })

  it('a non-list is dropped', () => {
    for (const bad of ['ropes', 5, {}, null, undefined, { length: 1, 0: rope('a', 'b') }]) {
      expect(sanitizeLinks(bad)).toBeUndefined()
    }
  })
})

describe('the file seams admit only readable links', () => {
  it('fileToProject', () => {
    const file = {
      version: 1, rev: 1, savedAt: 1, id: 'legacy', name: 'p', color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node],
      ropes: [null, rope('a', 'b')],
      bridges: 'nope'
    }
    const p = fileToProject(file as never, { id: 'p1' })
    expect(p.ropes).toEqual([rope('a', 'b')])
    expect(p.bridges).toBeUndefined()
  })

  it('projectToFile (what we write is what the next machine trusts)', () => {
    const project = {
      id: 'p1', name: 'p', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node],
      ropes: [rope('a', 'b'), { id: 7 }], bridges: [rope('a', 'b')]
    } as unknown as Project
    const file = projectToFile(project, 1, '2026-09-29T00:00:00.000Z')
    expect(file.ropes).toEqual([rope('a', 'b')])
    expect(file.bridges).toEqual([rope('a', 'b')])
  })
})
