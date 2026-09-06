import { describe, it, expect } from 'vitest'
import { projectToFile, fileToProject, validClosedSessions, sanitizeLoadedClosedSessions } from './workspace-files'
import { CLOSED_SESSIONS_CAP } from '../shared/types'
import type { ClosedSessionEntry, Project } from '../shared/types'

const closedEntry = (id: string, over: Partial<ClosedSessionEntry['node']> = {}): ClosedSessionEntry => ({
  id,
  closedAt: 1000,
  node: {
    id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
    title: 'shell', color: '#fff', group: null, cwd: '/tmp/x', ...over
  },
  absolutePosition: { x: 0, y: 0 }
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over
})

describe('closedSessions is machine-local, never in the shared project file', () => {
  it('projectToFile never emits closedSessions, even when the project carries entries', () => {
    const entries = [closedEntry('e1'), closedEntry('e2')]
    const file = projectToFile(project({ cwd: '/tmp/x', closedSessions: entries }), 1, 'now')
    expect((file as { closedSessions?: unknown }).closedSessions).toBeUndefined()
    expect(JSON.stringify(file)).not.toContain('closedSessions')
  })

  it('fileToProject ignores a `closedSessions` field forged onto the file — only base.closedSessions counts', () => {
    const file = projectToFile(project({ cwd: '/tmp/x' }), 1, 'now')
    const forged = { ...file, closedSessions: [closedEntry('forged')] } as never
    expect(fileToProject(forged, { id: 'p1', cwd: '/tmp/x' }).closedSessions).toBeUndefined()
  })

  it('fileToProject surfaces base.closedSessions verbatim (already sanitized by the caller)', () => {
    const file = projectToFile(project({ cwd: '/tmp/x' }), 1, 'now')
    const entries = [closedEntry('e1'), closedEntry('e2')]
    const loaded = fileToProject(file, { id: 'p1', cwd: '/tmp/x', closedSessions: entries })
    expect(loaded.closedSessions?.map((e) => e.id)).toEqual(['e1', 'e2'])
    // Unlike the shared-file path, this data never leaves the machine — no exec-strip, no
    // cwd-portability rewrite. It rides straight through.
    expect(loaded.closedSessions?.[0].node.cwd).toBe('/tmp/x')
  })

  it('omits closedSessions entirely when base carries none', () => {
    const file = projectToFile(project({ cwd: '/tmp/x' }), 1, 'now')
    expect(fileToProject(file, { id: 'p1', cwd: '/tmp/x' }).closedSessions).toBeUndefined()
    expect(fileToProject(file, { id: 'p1', cwd: '/tmp/x', closedSessions: [] }).closedSessions).toBeUndefined()
  })
})

describe('validClosedSessions', () => {
  it('accepts a well-formed array and rejects garbage', () => {
    expect(validClosedSessions([closedEntry('e1')])).toBe(true)
    expect(validClosedSessions([{ id: 'e1' }])).toBe(false) // missing closedAt/node
    expect(validClosedSessions('nope')).toBe(false)
    expect(validClosedSessions(undefined)).toBe(false)
  })

  // recreateNodeFromSnapshot assigns `node.position = reattach ? snapshot.position :
  // snapshot.absolutePosition` UNGUARDED, and React Flow's adoptUserNodes then dereferences
  // `position.x`. So an entry missing either point is not a cosmetic defect — it is a white-screen
  // renderer crash reachable from a hand-edited workspace.json. Reject it at the boundary.
  it('rejects an entry with no absolutePosition', () => {
    const { absolutePosition: _dropped, ...noAbs } = closedEntry('e1')
    expect(validClosedSessions([noAbs])).toBe(false)
    expect(validClosedSessions([{ ...closedEntry('e1'), absolutePosition: { x: 1 } }])).toBe(false)
    expect(validClosedSessions([{ ...closedEntry('e1'), absolutePosition: 'nope' }])).toBe(false)
  })

  it('rejects an entry whose node has no position', () => {
    const bad = closedEntry('e1')
    const { position: _dropped, ...node } = bad.node
    expect(validClosedSessions([{ ...bad, node }])).toBe(false)
  })

  // A garbage kind reaches buildBase's switch, returns null, and the sidebar row silently consumes
  // itself and vanishes — the same dead-row failure the `trigger` exclusion was added to prevent.
  it('rejects an entry with a missing or empty node kind', () => {
    expect(validClosedSessions([closedEntry('e1', { kind: '' as never })])).toBe(false)
    expect(validClosedSessions([closedEntry('e1', { kind: undefined as never })])).toBe(false)
    expect(validClosedSessions([closedEntry('e1', { kind: 7 as never })])).toBe(false)
  })
})

describe('sanitizeLoadedClosedSessions', () => {
  it('drops a non-array/malformed value to undefined', () => {
    expect(sanitizeLoadedClosedSessions({ not: 'an array' })).toBeUndefined()
    expect(sanitizeLoadedClosedSessions(undefined)).toBeUndefined()
    expect(sanitizeLoadedClosedSessions([])).toBeUndefined()
  })

  it('a well-formed entry with no position data loads as no history at all, never a broken entry', () => {
    const entry = closedEntry('e1')
    const { absolutePosition: _dropped, ...maimed } = entry
    expect(sanitizeLoadedClosedSessions([maimed])).toBeUndefined()
  })

  it('strips a trigger spec off a surviving entry\'s node, same as a live node', () => {
    const entry = closedEntry('e1', { trigger: { kind: 'cron', expr: '* * * * *' } } as never)
    const out = sanitizeLoadedClosedSessions([entry])
    expect(out).toHaveLength(1)
    expect(out?.[0].node.trigger).toBeUndefined()
  })

  // The cap is enforced where entries are ADMITTED, not only where we append them: workspace.json
  // is hand-editable input too, so an inflated list can arrive from outside and would otherwise
  // render unbounded sidebar rows and be persisted back in full on the next save.
  it('caps an oversized array, newest-first (drops the tail)', () => {
    const many = Array.from({ length: CLOSED_SESSIONS_CAP + 12 }, (_, i) => closedEntry(`e${i}`))
    const out = sanitizeLoadedClosedSessions(many)
    expect(out).toHaveLength(CLOSED_SESSIONS_CAP)
    expect(out?.[0].id).toBe('e0')
  })
})
