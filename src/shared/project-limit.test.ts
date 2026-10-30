import { describe, it, expect } from 'vitest'
import { countOpenProjects } from './project-limit'

describe('countOpenProjects — the one definition of an open project', () => {
  it('counts every project that is neither closed nor a relay tab', () => {
    expect(countOpenProjects([{}, { closed: true }, { remote: true }, { closed: false }])).toBe(2)
  })

  it('is 0 for an empty workspace', () => {
    expect(countOpenProjects([])).toBe(0)
  })
})
