import { expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { CanvasDeletions } from './canvasDeletions'

it('rejects stale resurrection after an optimistic commit, but permits undo and new ids', () => {
  const memory = new CanvasDeletions()
  const project = { id: 'p', nodes: [{ id: 'a' }, { id: 'b' }, { id: 'new' }] } as Project
  memory.record('p', ['a', 'b'], ['a'])
  expect(memory.filter(project).nodes.map((n) => n.id)).toEqual(['a', 'new'])
  expect(memory.filter({ ...project, id: 'other' })).toBeDefined()
  memory.record('p', ['a'], ['a', 'b'])
  expect(memory.filter(project)).toBe(project)
})
