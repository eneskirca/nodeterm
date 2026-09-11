import { describe, it, expect } from 'vitest'
import {
  adoptedNodesNotice,
  canonicalJson,
  conflictBarMessage,
  decideExternalChange,
  mergeIncomingNodes
} from './externalChange'
import type { CanvasNodeState, Project } from '@shared/types'

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 100, y: 100 },
  size: { width: 900, height: 560 },
  title: id,
  color: '#7aa2f7',
  group: null,
  ...over
})

const project = (nodes: CanvasNodeState[], over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Project',
  color: '#0a84ff',
  cwd: '/work/p1',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  ...over
})

/** The phone's registration: our canvas plus one node id nobody here has ever seen. */
const phoneNode = node('term-mmm-9f2a', { title: 'Mobile session', agentId: 'claude' })

describe('decideExternalChange', () => {
  it('reloads wholesale when there are no unsaved local edits (unchanged behavior)', () => {
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1'), phoneNode])
    expect(
      decideExternalChange({ dirty: false, base, incoming, liveNodeIds: ['term-a-1'] }).kind
    ).toBe('reload')
  })

  it('MERGES a phone registration that lands while the canvas is dirty — no bar', () => {
    // The field failure: this used to park behind the conflict bar, and "Keep my version" (or just
    // switching tabs) then wrote our canvas over disk, deleting a node whose tmux session is live.
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1'), phoneNode])
    const decision = decideExternalChange({
      dirty: true,
      base,
      incoming,
      liveNodeIds: ['term-a-1']
    })
    expect(decision.kind).toBe('merge')
    expect(decision.added.map((n) => n.id)).toEqual(['term-mmm-9f2a'])
  })

  it('still adopts the new session when the rest of the file DID conflict', () => {
    // A git pull that both moved an existing node and carried the phone's registration: the
    // overlapping half is the user's choice, the added node is nobody's to lose.
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1', { position: { x: 900, y: 40 } }), phoneNode])
    const decision = decideExternalChange({
      dirty: true,
      base,
      incoming,
      liveNodeIds: ['term-a-1']
    })
    expect(decision.kind).toBe('conflict')
    expect(decision.added.map((n) => n.id)).toEqual(['term-mmm-9f2a'])
  })

  it('conflicts when a shared field other than the nodes changed on disk', () => {
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1')], { name: 'Renamed elsewhere' })
    expect(
      decideExternalChange({ dirty: true, base, incoming, liveNodeIds: ['term-a-1'] }).kind
    ).toBe('conflict')
  })

  it('conflicts when a node we hold was DELETED on disk', () => {
    const base = project([node('term-a-1'), node('term-a-2')])
    const incoming = project([node('term-a-1'), phoneNode])
    const decision = decideExternalChange({
      dirty: true,
      base,
      incoming,
      liveNodeIds: ['term-a-1', 'term-a-2']
    })
    expect(decision.kind).toBe('conflict')
    // …and the phone's node still rides along.
    expect(decision.added.map((n) => n.id)).toEqual(['term-mmm-9f2a'])
  })

  it('never resurrects a node deleted locally but still listed on disk', () => {
    // Present in base, gone from the live canvas (unsaved delete): adding it back would undo the
    // user's edit, which is exactly the destruction this fix exists to prevent, mirrored.
    const base = project([node('term-a-1'), node('term-a-2')])
    const incoming = project([node('term-a-1'), node('term-a-2')])
    const decision = decideExternalChange({
      dirty: true,
      base,
      incoming,
      liveNodeIds: ['term-a-1']
    })
    expect(decision.added).toEqual([])
    expect(decision.kind).toBe('ignore')
  })

  it('does not re-add a node the canvas already holds (the SSH poll re-delivers the same file)', () => {
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1'), phoneNode])
    const decision = decideExternalChange({
      dirty: true,
      base,
      incoming,
      liveNodeIds: ['term-a-1', 'term-mmm-9f2a']
    })
    expect(decision.added).toEqual([])
    expect(decision.kind).toBe('ignore')
  })

  it('conflicts when we have no baseline to classify against', () => {
    const incoming = project([phoneNode])
    const decision = decideExternalChange({
      dirty: true,
      base: undefined,
      incoming,
      liveNodeIds: []
    })
    expect(decision.kind).toBe('conflict')
    expect(decision.added.map((n) => n.id)).toEqual(['term-mmm-9f2a'])
  })

  it('ignores a machine-local difference (viewport) — it never came from the shared file', () => {
    const base = project([node('term-a-1')])
    const incoming = project([node('term-a-1'), phoneNode], {
      viewport: { x: -40, y: 12, zoom: 0.75 }
    })
    expect(
      decideExternalChange({ dirty: true, base, incoming, liveNodeIds: ['term-a-1'] }).kind
    ).toBe('merge')
  })

  it('treats key order as irrelevant when comparing nodes', () => {
    const base = project([node('term-a-1')])
    // Same node, keys emitted in the opposite order (two serializers, one shape).
    const reordered = Object.fromEntries(
      Object.entries(node('term-a-1')).reverse()
    ) as unknown as CanvasNodeState
    const incoming = project([reordered, phoneNode])
    expect(
      decideExternalChange({ dirty: true, base, incoming, liveNodeIds: ['term-a-1'] }).kind
    ).toBe('merge')
  })
})

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe('mergeIncomingNodes', () => {
  it('appends only the ids the canvas does not already hold', () => {
    const current = [{ id: 'a' }, { id: 'b' }]
    expect(mergeIncomingNodes(current, [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' }
    ])
  })
  it('returns the SAME array when there is nothing new (no needless re-render)', () => {
    const current = [{ id: 'a' }]
    expect(mergeIncomingNodes(current, [{ id: 'a' }])).toBe(current)
  })
})

describe('conflict copy', () => {
  it('keeps the historical sentence when nothing was added', () => {
    expect(conflictBarMessage(0)).toContain(
      'Project file changed on disk (git pull or another machine).'
    )
  })
  it('always says the autosave is suspended — in every wording', () => {
    // The bar SUSPENDS the debounced whole-workspace save for as long as it is up (Canvas's
    // autosaveDelay returns null on a conflict), and it is cleared only by its own two buttons or
    // a project switch. A user who read this strip as an FYI about someone else's git pull had no
    // way to know their own canvas had stopped being written — 2026-09-02: two and a half hours,
    // eight session cards opened and never persisted, no signal anywhere.
    for (const n of [0, 1, 2])
      expect(conflictBarMessage(n)).toContain('not being saved until you choose')
  })
  it('names what arrived, and says it is already on the canvas', () => {
    const msg = conflictBarMessage(1)
    expect(msg).toContain('1 session')
    expect(msg).toContain('not on this canvas')
    expect(msg).toContain('added')
  })
  it('pluralizes', () => {
    expect(conflictBarMessage(2)).toContain('2 sessions')
    expect(conflictBarMessage(2)).toContain('were not on this canvas')
    expect(adoptedNodesNotice(1)).toContain('1 session')
    expect(adoptedNodesNotice(1)).toContain('was not on this canvas')
    expect(adoptedNodesNotice(3)).toContain('3 sessions')
    expect(adoptedNodesNotice(3)).toContain('were not on this canvas')
  })
  // 2026-09-06 field report: 16 terminals deleted on a slow SSH link came back announced as
  // sessions "registered from another device (your phone, or another machine)" — the reporter owns
  // no phone and runs no second machine. The source was our own stale server file (a mirror write
  // acked by the 5 s throttle and then dropped). Nothing at this layer knows where an adopted node
  // came from, so neither surface may name a device: it names the FILE, which is what was observed,
  // and offers the possibilities without asserting one.
  it('never attributes the sessions to a device it cannot have observed', () => {
    for (const msg of [conflictBarMessage(16), adoptedNodesNotice(16)]) {
      expect(msg).not.toMatch(/phone/i)
      expect(msg).not.toMatch(/registered from/i)
      expect(msg).toContain('project file')
      expect(msg).toContain('or from an older copy of the file')
    }
  })
  it('says the same thing on both surfaces — one clause, no drift', () => {
    expect(conflictBarMessage(4).startsWith(adoptedNodesNotice(4))).toBe(true)
  })
})
