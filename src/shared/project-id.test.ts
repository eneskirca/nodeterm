import { describe, it, expect } from 'vitest'
import { collisionSeed, derivedProjectId, shortHash } from './project-id'

const never = (): boolean => false

describe('shortHash', () => {
  it('is deterministic and stays inside the safe id charset', () => {
    expect(shortHash('/home/enes/repo')).toBe(shortHash('/home/enes/repo'))
    for (const s of ['', '/a', '/home/mustafa/mustafa', 'ünïcødé/ようこそ', 'x'.repeat(500)]) {
      expect(shortHash(s)).toMatch(/^[a-z0-9]+$/)
      expect(shortHash(s).length).toBeLessThanOrEqual(7)
    }
  })

  it('separates the folders that actually collide in the field', () => {
    expect(shortHash('/root/nodeterm-ios')).not.toBe(shortHash('/root/nodeterm-ios-keyux'))
    expect(shortHash('/home/mustafa/mustafa')).not.toBe(shortHash('/home/projects/mustafa'))
  })
})

describe('derivedProjectId', () => {
  it('keeps the base id as a prefix and appends the seed hash', () => {
    const id = derivedProjectId('project-ms4zdpc0-1', '/root/nodeterm-ios', never)
    expect(id.startsWith('project-ms4zdpc0-1-')).toBe(true)
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
  })

  it('CONVERGES: the same (id, seed) always derives the same id — the repair may not churn the file', () => {
    const a = derivedProjectId('p1', '/two', never)
    const b = derivedProjectId('p1', '/two', never)
    expect(a).toBe(b)
  })

  it('re-derives (still deterministically) when the derived id is itself taken', () => {
    const collide = derivedProjectId('p1', '/two', never)
    const salted = derivedProjectId('p1', '/two', (id) => id === collide)
    expect(salted).not.toBe(collide)
    expect(derivedProjectId('p1', '/two', (id) => id === collide)).toBe(salted)
  })

  it('gives two different folders two different ids', () => {
    expect(derivedProjectId('p1', '/a', never)).not.toBe(derivedProjectId('p1', '/b', never))
  })
})

describe('collisionSeed', () => {
  it('is the folder, then the server folder, then the name', () => {
    expect(collisionSeed({ cwd: '/a', ssh: { remoteCwd: '~/b' }, name: 'n' })).toBe('/a')
    expect(collisionSeed({ ssh: { remoteCwd: '~/b' }, name: 'n' })).toBe('~/b')
    expect(collisionSeed({ name: 'n' })).toBe('n')
  })
})
