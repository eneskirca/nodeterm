import { describe, expect, it, vi } from 'vitest'

vi.mock('../session/session', () => ({
  sessionForProject: (id: string) => {
    if (id === 'p-none') throw new Error('no session')
    return { source: id === 'p-relay' ? 'relay' : 'local' }
  }
}))

import { projectSessionSource } from './projectSessionSource'

describe('projectSessionSource', () => {
  it('a project resolves through its session', () => {
    expect(projectSessionSource('p-local')).toBe('local')
    expect(projectSessionSource('p-relay')).toBe('relay')
  })

  it('no session resolves to null, never a throw', () => {
    expect(projectSessionSource('p-none')).toBeNull()
  })
})
