import { describe, expect, it } from 'vitest'
import type { IndexEntryV3, WorkspaceIndexV3 } from './workspace-files'
import { ownsProject, scopeIndex } from './workspace-scope'

const entry = (id: string, over: Partial<IndexEntryV3> = {}): IndexEntryV3 => ({
  id,
  name: id.toUpperCase(),
  color: '#000',
  cwd: `/repo/${id}`,
  ...over
})
const index = (entries: IndexEntryV3[], activeProjectId = entries[0]?.id ?? ''): WorkspaceIndexV3 => ({
  version: 3,
  activeProjectId,
  entries
})

describe('ownsProject', () => {
  it('an unscoped save owns everything', () => {
    expect(ownsProject(undefined, 'a')).toBe(true)
  })
  it('main owns everything except the detached projects', () => {
    const scope = { kind: 'main', detached: ['b'] } as const
    expect(ownsProject(scope, 'a')).toBe(true)
    expect(ownsProject(scope, 'b')).toBe(false)
  })
  it('a pop-out owns exactly its project', () => {
    const scope = { kind: 'popout', projectId: 'b' } as const
    expect(ownsProject(scope, 'b')).toBe(true)
    expect(ownsProject(scope, 'a')).toBe(false)
  })
})

describe('scopeIndex — main window', () => {
  const scope = { kind: 'main', detached: ['b'] } as const

  it('keeps the store\'s previous entry for a detached project, whatever main sends for it', () => {
    const previous = index([entry('a'), entry('b', { name: 'B-fresh', viewport: { x: 9, y: 9, zoom: 2 } })])
    const incoming = index([entry('a', { name: 'A2' }), entry('b', { name: 'B-stale' })])
    const out = scopeIndex(previous, incoming, scope)
    expect(out.entries.map((e) => e.name)).toEqual(['A2', 'B-fresh'])
    expect(out.entries[1]).toBe(previous.entries[1]) // verbatim, not a copy with a stale field
    expect(out.activeProjectId).toBe('a') // main's own choice stands
  })

  it('main cannot delete a detached project: an omitted entry is kept at the end', () => {
    const previous = index([entry('a'), entry('b')])
    const incoming = index([entry('a')])
    expect(scopeIndex(previous, incoming, scope).entries.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('main cannot introduce a detached project the store does not know', () => {
    const previous = index([entry('a')])
    const incoming = index([entry('a'), entry('b')])
    expect(scopeIndex(previous, incoming, scope).entries.map((e) => e.id)).toEqual(['a'])
  })

  it('main may add, remove and reorder the projects it owns', () => {
    const previous = index([entry('a'), entry('b'), entry('c')])
    const incoming = index([entry('c'), entry('d'), entry('b')], 'd')
    const out = scopeIndex(previous, incoming, scope)
    expect(out.entries.map((e) => e.id)).toEqual(['c', 'd', 'b'])
    expect(out.activeProjectId).toBe('d')
  })

  it('with nothing previously loaded, main writes exactly what it owns', () => {
    const incoming = index([entry('a'), entry('b')])
    expect(scopeIndex(null, incoming, scope).entries.map((e) => e.id)).toEqual(['a'])
  })
})

describe('scopeIndex — pop-out window', () => {
  const scope = { kind: 'popout', projectId: 'b' } as const

  it('replaces its own entry in place and leaves order, the other entries and the active id alone', () => {
    const previous = index([entry('a'), entry('b'), entry('c')], 'a')
    const incoming = index([entry('a', { name: 'A-stale' }), entry('b', { name: 'B2' })], 'b')
    const out = scopeIndex(previous, incoming, scope)
    expect(out.entries.map((e) => e.name)).toEqual(['A', 'B2', 'C'])
    expect(out.entries[0]).toBe(previous.entries[0])
    expect(out.entries[2]).toBe(previous.entries[2])
    expect(out.activeProjectId).toBe('a')
  })

  it('cannot resurrect its project once the store no longer lists it', () => {
    const previous = index([entry('a')])
    const incoming = index([entry('a'), entry('b')])
    expect(scopeIndex(previous, incoming, scope).entries.map((e) => e.id)).toEqual(['a'])
  })

  it('with nothing previously loaded, writes only its own entry', () => {
    const incoming = index([entry('a'), entry('b')], 'b')
    const out = scopeIndex(null, incoming, scope)
    expect(out.entries.map((e) => e.id)).toEqual(['b'])
    expect(out.activeProjectId).toBe('b')
  })
})
