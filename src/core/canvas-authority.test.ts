// The Server Edition canvas authority: the one writer of a shared project's content. Every case
// drives it through its deps only — a manual clock for the flush timers, in-memory maps for the
// store's read and write, and a publish that can echo back through `onReflected` the way the real
// reflector does (sanitized, stamped with the next `seq`, synchronously) — and asserts the state
// that reached the "disk" or came back from an overlay, never the module's internals.
import { describe, it, expect } from 'vitest'
import { applyCanvasOp, type CanvasContent } from '../shared/canvas-content'
import { isCanvasMutation, MUTATION_MAX_BYTES, sanitizeCanvasMutation } from '../shared/canvas-mutations'
import { defaultKanbanFor } from '../shared/kanban-default-board'
import type { CanvasMutation, CanvasNodeState, Project, ProjectKanban, Workspace } from '../shared/types'
import { createCanvasAuthority, type CanvasAuthority, type CanvasAuthorityDeps } from './canvas-authority'
import type { ContentAuthorityHooks } from './workspace-store'

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
  title: id, color: '#fff', group: null, ...over
})
const at = (id: string, x: number, over: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  node(id, { position: { x, y: 0 }, ...over })
const content = (nodes: CanvasNodeState[], over: Partial<CanvasContent> = {}): CanvasContent =>
  ({ nodes, bridges: [], ropes: [], ...over })
const project = (over: Partial<Project> = {}): Project => ({
  id: 'P', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a')], ...over
})
const ws = (...projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects })
const ids = (nodes: Array<{ id: string }>): string[] => nodes.map((n) => n.id)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const shellOf = (n: CanvasNodeState | undefined): string | undefined => (n as { shell?: string } | undefined)?.shell
const byId = (nodes: CanvasNodeState[], id: string): CanvasNodeState | undefined => nodes.find((n) => n.id === id)

/** Let every pending promise chain (the fake store's async read/write) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r))
}

/** A manual clock: `setTimer`/`clearTimer` for the authority, `advanceTo` fires due timers in
 *  order and lets each one's async work finish before the next. */
function manualClock() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    get now() {
      return now
    },
    pending: () => timers.size,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (t: unknown): void => {
      timers.delete(t as number)
    },
    async advanceTo(t: number): Promise<void> {
      for (;;) {
        await settle()
        let best: [number, { at: number; fn: () => void }] | null = null
        for (const entry of timers) {
          if (entry[1].at > t) continue
          if (!best || entry[1].at < best[1].at || (entry[1].at === best[1].at && entry[0] < best[0])) best = entry
        }
        if (!best) break
        timers.delete(best[0])
        now = best[1].at
        best[1].fn()
      }
      now = t
      await settle()
    },
    advance(ms: number): Promise<void> {
      return this.advanceTo(now + ms)
    }
  }
}

interface HarnessOpts {
  shared?: string[]
  disk?: Record<string, CanvasContent>
  /** Answers for successive writes; true once exhausted. */
  writeResults?: boolean[]
  /** Echo every published op back through onReflected, as the real reflector listener does. */
  echo?: boolean
}

function harness(opts: HarnessOpts = {}) {
  const clock = manualClock()
  const shared = new Set(opts.shared ?? ['P'])
  const disk = new Map<string, CanvasContent>(
    Object.entries(opts.disk ?? { P: content([node('a')]) }).map(([k, v]) => [k, clone(v)])
  )
  const writes: Array<{ id: string; at: number; content: CanvasContent }> = []
  const published: Array<{ id: string; m: CanvasMutation }> = []
  const logs: string[] = []
  const reads: string[] = []
  const results = [...(opts.writeResults ?? [])]
  let seq = 0
  let authority!: CanvasAuthority
  const deps: CanvasAuthorityDeps = {
    sharedProjectIds: () => shared,
    readContent: async (id) => {
      reads.push(id)
      const v = disk.get(id)
      return v ? clone(v) : null
    },
    writeContent: async (id, c) => {
      writes.push({ id, at: clock.now, content: clone(c) })
      const ok = results.length ? (results.shift() as boolean) : true
      if (ok) disk.set(id, clone(c))
      return ok
    },
    publish: (id, m) => {
      published.push({ id, m })
      if (!opts.echo) return
      // What publishCanvasMutation does before the reflected listener sees it: refuse what the
      // wire refuses, sanitize, stamp the next seq of the ONE counter.
      if (!isCanvasMutation(m)) return
      const clean = sanitizeCanvasMutation(m)
      if (clean) authority.onReflected(id, { ...clean, seq: ++seq })
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (msg) => logs.push(msg)
  }
  authority = createCanvasAuthority(deps)
  /** A client's cast as the reflector hands it on: stamped with the next seq. */
  const cast = (m: CanvasMutation, id = 'P'): void => authority.onReflected(id, { ...m, seq: ++seq } as CanvasMutation)
  return { authority, clock, shared, disk, writes, published, logs, reads, cast, nextSeq: () => ++seq }
}

describe('canvas authority — governing', () => {
  it('1. an op for a project that is not shared changes nothing and schedules no write', async () => {
    const h = harness({ shared: [] })
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advance(60_000)
    expect(h.reads).toEqual([])
    expect(h.writes).toEqual([])
    expect(h.clock.pending()).toBe(0)
    const p = project({ nodes: [node('zzz')] })
    const out = await h.authority.overlaySave(ws(p))
    expect(out.projects[0]).toBe(p)
    expect(h.authority.governs('P')).toBe(false)
  })

  it('2. adopts lazily on the first op: reads the content once, applies the op, writes once', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advance(1000)
    expect(h.reads).toEqual(['P'])
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b'])
  })

  it('3. coalesces a burst: 60 upserts of one node in 900 ms, then quiet → one write, last position', async () => {
    // Disk holds a at -1, so the very first upsert (x=0) is already a change.
    const h = harness({ disk: { P: content([at('a', -1)]) } })
    for (let i = 0; i < 60; i++) {
      await h.clock.advanceTo(i * 15)
      h.cast({ op: 'upsert', node: at('a', i) })
    }
    await h.clock.advance(5000)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].at).toBe(59 * 15 + 1000)
    expect(byId(h.writes[0].content.nodes, 'a')?.position.x).toBe(59)
  })

  it('4. a stream that never goes quiet is still written by the max wait, and again after it ends', async () => {
    // Disk holds a at -1, so the max-wait window opens on the very first op (t=0).
    const h = harness({ disk: { P: content([at('a', -1)]) } })
    for (let t = 0; t <= 7000; t += 500) {
      await h.clock.advanceTo(t)
      h.cast({ op: 'upsert', node: at('a', t) })
    }
    await h.clock.advance(10_000)
    expect(h.writes.map((w) => w.at)).toEqual([5000, 8000])
    expect(h.writes[0].at).toBeLessThan(7000)
    expect(byId(h.writes[1].content.nodes, 'a')?.position.x).toBe(7000)
  })

  it('5. applies ops in the total order, including the order\'s causal delete (a stale frame cannot resurrect a delete)', async () => {
    const h = harness({ disk: { P: content([at('a', 1), at('b', 1)]) } })
    h.authority.onReflected('P', { op: 'remove', id: 'a', seq: 5 })
    h.authority.onReflected('P', { op: 'upsert', node: at('a', 42), seq: 6, seen: 3 })
    // …and a straggler below what the order has already seen for b is dropped.
    h.authority.onReflected('P', { op: 'upsert', node: at('b', 10), seq: 8 })
    h.authority.onReflected('P', { op: 'upsert', node: at('b', 7), seq: 7 })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['b'])
    expect(byId(h.writes[0].content.nodes, 'b')?.position.x).toBe(10)
  })

  it('5c. the causal delete holds for an edge: a stale re-upsert cannot bring back a removed link', async () => {
    const e1 = { id: 'e1', source: 'a', target: 'b' }
    const h = harness({ disk: { P: content([node('a'), node('b')], { bridges: [e1] }) } })
    h.authority.onReflected('P', { op: 'edge-remove', kind: 'bridge', id: 'e1', seq: 5 })
    h.authority.onReflected('P', { op: 'edge-upsert', kind: 'bridge', edge: e1, seq: 6, seen: 3 })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].content.bridges).toEqual([])
    expect(h.writes[0].content.ropes).toEqual([])
  })

  it('5d. the causal delete holds for a board column: a stale re-upsert cannot bring back a removed column', async () => {
    const c1 = { id: 'c1', title: 'One', color: '#fff' }
    const c2 = { id: 'c2', title: 'Two', color: '#fff' }
    const h = harness({ disk: { P: content([node('a')], { kanban: { columns: [c1, c2], assignments: [] } }) } })
    h.authority.onReflected('P', { op: 'kb-column-remove', id: 'c2', seq: 5 })
    h.authority.onReflected('P', { op: 'kb-column', column: c2, seq: 6, seen: 3 })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(h.writes[0].content.kanban?.columns.map((c) => c.id)).toEqual(['c1'])
  })

  it('5b. an op carrying any src tag is judged like every other op (none is taken for its own echo)', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    h.authority.onReflected('P', { op: 'upsert', node: node('b'), src: 'canvas-authority', seq: 1 })
    h.authority.onReflected('P', { op: 'upsert', node: node('c'), src: '', seq: 2 })
    await h.clock.advance(1000)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b', 'c'])
  })

  it('15. a shared project whose content cannot be read stays governed, drops its ops and logs once', async () => {
    const h = harness({ shared: ['proj-unknown'], disk: {} })
    h.cast({ op: 'upsert', node: node('b') }, 'proj-unknown')
    await settle()
    h.cast({ op: 'upsert', node: node('c') }, 'proj-unknown')
    await h.clock.advance(10_000)
    expect(h.writes).toEqual([])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('proj-unknown')
    expect(h.authority.governs('proj-unknown')).toBe(true)
    expect(h.authority.governedIds()).toEqual(['proj-unknown'])
    expect(h.authority.adoptedIds()).toEqual([])
  })
})

describe('canvas authority — save and load overlays', () => {
  it('6. a stale save cannot revert content, and still carries everything else', async () => {
    const h = harness({ disk: { P: content([at('a', 0)]) } })
    h.cast({ op: 'upsert', node: at('a', 10) })
    await settle()
    const out = await h.authority.overlaySave(ws(project({ name: 'Renamed', nodes: [at('a', 0)] })))
    expect(out.projects[0].name).toBe('Renamed')
    expect(out.projects[0].nodes).toHaveLength(1)
    expect(byId(out.projects[0].nodes, 'a')?.position.x).toBe(10)
  })

  it('6b. an empty edge list adds no key the save lacked, and keeps the one it carried', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    const out = await h.authority.overlaySave(ws(project()))
    expect('bridges' in out.projects[0]).toBe(false)
    expect('ropes' in out.projects[0]).toBe(false)
    const out2 = await h.authority.overlaySave(ws(project({ bridges: [{ id: 'stale', source: 'a', target: 'a' }], ropes: [] })))
    expect(out2.projects[0].bridges).toEqual([])
    expect(out2.projects[0].ropes).toEqual([])
  })

  it('7. carries this machine\'s exec fields from the save onto the overlay; the state keeps none', async () => {
    const h = harness({ disk: { P: content([at('a', 0)]) } })
    const out = await h.authority.overlaySave(ws(project({ nodes: [at('a', 0, { shell: '/bin/zsh' })] })))
    expect(shellOf(byId(out.projects[0].nodes, 'a'))).toBe('/bin/zsh')
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(shellOf(byId(h.writes[0].content.nodes, 'a'))).toBeUndefined()
  })

  it('8. the board is field-level: items from the authority, github from the save', async () => {
    const c1 = { id: 'c1', title: 'One', color: '#fff' }
    const c9 = { id: 'c9', title: 'Nine', color: '#000' }
    const diskBoard = { columns: [c1], assignments: [], github: { repository: 'disk/x', columnMappings: [] } } as ProjectKanban
    const h = harness({ disk: { P: content([node('a')], { kanban: diskBoard }) } })
    const saved = { columns: [c9], assignments: [], github: { repository: 'a/b', columnMappings: [] } } as ProjectKanban
    const out = await h.authority.overlaySave(ws(project({ kanban: saved })))
    expect(out.projects[0].kanban).toEqual({
      columns: [c1], assignments: [], github: { repository: 'a/b', columnMappings: [] }
    })
  })

  it('8b. with no board of its own, the save\'s github rides on the project\'s lazy default board', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    const github = { repository: 'a/b', columnMappings: [] }
    const saved = { columns: [{ id: 'c9', title: 'Nine', color: '#000' }], assignments: [], github } as ProjectKanban
    const out = await h.authority.overlaySave(ws(project({ kanban: saved })))
    expect(out.projects[0].kanban).toEqual({ ...defaultKanbanFor('P'), github })
    // …and with neither a board nor a config, the save's board items do not survive.
    const out2 = await h.authority.overlaySave(ws(project({ kanban: { columns: [], assignments: [] } })))
    expect(out2.projects[0].kanban).toBeUndefined()
    expect('kanban' in out2.projects[0]).toBe(false)
  })

  it('9. a node too large to travel as an op is adopted from the save and written', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    const big = node('big', { kind: 'sticky', text: 'x'.repeat(MUTATION_MAX_BYTES + 10) })
    expect(isCanvasMutation({ op: 'upsert', node: big })).toBe(false)
    const out = await h.authority.overlaySave(ws(project({ nodes: [node('a'), big] })))
    expect(ids(out.projects[0].nodes)).toEqual(['a', 'big'])
    expect(byId(out.projects[0].nodes, 'big')?.text).toBe(big.text)
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(byId(h.writes[0].content.nodes, 'big')?.text).toBe(big.text)
  })

  it('9b. two identical saves of an unchanged big node write once, and the state keeps no exec', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    const big = node('big', { kind: 'sticky', text: 'y'.repeat(MUTATION_MAX_BYTES + 10), shell: '/bin/zsh' })
    const out = await h.authority.overlaySave(ws(project({ nodes: [node('a'), clone(big)] })))
    expect(shellOf(byId(out.projects[0].nodes, 'big'))).toBe('/bin/zsh') // carried onto the overlay
    await h.clock.advance(1000)
    await h.authority.overlaySave(ws(project({ nodes: [node('a'), clone(big)] })))
    await h.clock.advance(10_000)
    expect(h.writes).toHaveLength(1)
    expect(shellOf(byId(h.writes[0].content.nodes, 'big'))).toBeUndefined()
  })

  it('10. a load is overlaid with the unflushed state', async () => {
    const h = harness({ disk: { P: content([at('a', 0)]) } })
    h.cast({ op: 'upsert', node: at('a', 10) })
    await settle()
    expect(h.writes).toEqual([])
    const out = await h.authority.overlayLoad(ws(project({ nodes: [at('a', 0)] })))
    expect(byId(out.projects[0].nodes, 'a')?.position.x).toBe(10)
  })

  it('an unavailable placeholder, a relay tab and an SSH project are never overlaid, and never seed the state', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    const placeholder = project({ nodes: [], unavailable: true })
    const loaded = await h.authority.overlayLoad(ws(placeholder))
    expect(loaded.projects[0]).toBe(placeholder)
    const relay = project({ nodes: [], remote: true })
    expect((await h.authority.overlaySave(ws(relay))).projects[0]).toBe(relay)
    const ssh = project({ nodes: [], ssh: { server: { host: 'h' }, remoteCwd: '~' } as unknown as Project['ssh'] })
    expect((await h.authority.overlayLoad(ws(ssh))).projects[0]).toBe(ssh)
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(1000)
    expect(h.reads).toEqual(['P'])
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b', 'c'])
  })

  it('satisfies the store\'s ContentAuthorityHooks', () => {
    const hooks: ContentAuthorityHooks = harness().authority
    expect(typeof hooks.overlaySave).toBe('function')
  })
})

describe('canvas authority — outside edits', () => {
  it('11. adopts the outside edit, re-applies unflushed ops on top, publishes the difference, writes once', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    h.cast({ op: 'upsert', node: node('c') })
    await settle()
    expect(h.writes).toEqual([])
    await h.authority.adoptOutsideEdit(project({ nodes: [node('a'), node('d')] }))
    const ops = h.published.map((p) => p.m)
    expect(ops).toEqual([{ op: 'upsert', node: node('d') }, { op: 'remove', id: 'b' }])
    // The ops turn every client's old state into the new one.
    let replica = content([node('a'), node('b'), node('c')])
    for (const m of ops) replica = applyCanvasOp(replica, m, 'P')
    expect(ids(replica.nodes).sort()).toEqual(['a', 'c', 'd'])
    await h.clock.advance(10_000)
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'd', 'c'])
  })

  it('11b. an outside edit alone (nothing unflushed) publishes its difference and writes nothing', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    await h.authority.overlayLoad(ws(project({ nodes: [node('a'), node('b')] })))
    await h.authority.adoptOutsideEdit(project({ nodes: [node('a'), node('d')] }))
    expect(h.published.map((p) => p.m.op)).toEqual(['upsert', 'remove'])
    await h.clock.advance(10_000)
    expect(h.writes).toEqual([])
  })

  it('11c. the echo of its own published diff is a no-op, and the order still judges later ops', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) }, echo: true })
    await h.authority.overlayLoad(ws(project({ nodes: [node('a'), node('b')] })))
    const extra = { id: 'kx', title: 'Extra', color: '#fff' }
    const board: ProjectKanban = {
      columns: [...defaultKanbanFor('P').columns, extra],
      assignments: [{ nodeId: 'a', columnId: 'kx' }]
    }
    const edited = project({
      nodes: [node('a'), at('d', 5)],
      bridges: [{ id: 'e1', source: 'a', target: 'd' }],
      kanban: board
    })
    await h.authority.adoptOutsideEdit(edited)
    const ops = h.published.map((p) => p.m)
    expect(ops.map((m) => m.op)).toEqual(['upsert', 'edge-upsert', 'kb-column', 'kb-column-order', 'kb-card', 'remove'])
    // Bare ops: valid on the wire, and nothing that would make the order take their echo for an ack.
    for (const m of ops) {
      expect(isCanvasMutation(m)).toBe(true)
      expect(m.src).toBeUndefined()
      expect(m.seq).toBeUndefined()
    }
    await h.clock.advance(10_000)
    expect(h.writes).toEqual([]) // the echoes changed nothing, so nothing is dirty
    // A later op for the same node applies…
    h.cast({ op: 'upsert', node: at('d', 50) })
    // …and a straggler ordered before the echo does not.
    h.authority.onReflected('P', { op: 'upsert', node: at('d', 99), seq: 1 })
    await h.clock.advance(10_000)
    expect(h.writes).toHaveLength(1)
    expect(byId(h.writes[0].content.nodes, 'd')?.position.x).toBe(50)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'd'])
    expect(h.writes[0].content.bridges).toEqual([{ id: 'e1', source: 'a', target: 'd' }])
    expect(h.writes[0].content.kanban?.assignments).toEqual([{ nodeId: 'a', columnId: 'kx' }])
  })

  it('11f. answers the project as a load now returns it: the edit\'s own fields, the authority\'s content (R15)', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    await h.authority.overlayLoad(ws(project({ nodes: [node('a'), node('b')] })))
    h.cast({ op: 'upsert', node: node('c') })
    await settle()
    const adopted = await h.authority.adoptOutsideEdit(
      project({
        name: 'Renamed',
        defaultPermissionMode: 'manual',
        nodes: [node('a', { shell: '/bin/zsh' }), node('d')]
      })
    )
    expect(adopted?.asOps).toBe(true)
    const persisted = adopted?.project
    // The non-content fields come from the edit: they are what a stale tab would otherwise revert.
    expect(persisted?.name).toBe('Renamed')
    expect(persisted?.defaultPermissionMode).toBe('manual')
    // The content is the authority's: the edit with the unflushed op re-applied on top.
    expect(ids(persisted?.nodes ?? [])).toEqual(['a', 'd', 'c'])
    // This machine's exec rides from the edit's own copy, exactly as on a load.
    expect(shellOf(byId(persisted?.nodes ?? [], 'a'))).toBe('/bin/zsh')
  })

  it('11d. an unavailable or relay project is never adopted as an outside edit', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    await h.authority.overlayLoad(ws(project({ nodes: [node('a'), node('b')] })))
    await h.authority.adoptOutsideEdit(project({ nodes: [], unavailable: true }))
    await h.authority.adoptOutsideEdit(project({ nodes: [], remote: true }))
    expect(h.published).toEqual([])
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(1000)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b', 'c'])
  })

  it('11e. a project shared after boot is adopted at share time, so an outside edit has a baseline', async () => {
    const h = harness({ shared: [], disk: { P: content([node('a'), node('b')]) } })
    h.shared.add('P')
    h.authority.sharedChanged()
    await settle()
    expect(h.reads).toEqual(['P'])
    expect(h.authority.adoptedIds()).toEqual(['P'])
    // The store records the re-read before it hands the project over, so from here a read answers
    // the NEW content — a baseline taken now would see no difference at all.
    h.disk.set('P', content([node('a')]))
    await h.authority.adoptOutsideEdit(project({ nodes: [node('a')] }))
    expect(h.published.map((p) => p.m)).toEqual([{ op: 'remove', id: 'b' }])
  })
})

describe('canvas authority — an outside edit with no baseline to diff (N5)', () => {
  // A shared project whose file could not be read holds no state, so an edit that makes it readable
  // (a pull resolving conflict markers) adopts the edited file AS its baseline and has no difference
  // to publish. No op can carry it to a client, so it is answered as a WHOLE project to send.
  it('adopts it, publishes no op, and answers it as a whole project to send', async () => {
    const h = harness({ disk: {} })
    h.authority.sharedChanged()
    await settle()
    expect(h.logs).toHaveLength(1) // unreadable: said once
    h.disk.set('P', content([node('a'), node('b')]))
    const adopted = await h.authority.adoptOutsideEdit(project({ name: 'Fixed', nodes: [node('a'), node('b')] }))
    expect(h.published).toEqual([])
    expect(adopted?.asOps).toBe(false)
    expect(adopted?.project.name).toBe('Fixed')
    expect(ids(adopted?.project.nodes ?? [])).toEqual(['a', 'b'])
    expect(h.authority.adoptedIds()).toEqual(['P'])
    // From here on it is an ordinary governed project: the next edit is diffed.
    h.disk.set('P', content([node('a')]))
    const next = await h.authority.adoptOutsideEdit(project({ nodes: [node('a')] }))
    expect(next?.asOps).toBe(true)
    expect(h.published.map((x) => x.m)).toEqual([{ op: 'remove', id: 'b' }])
  })

  it('answers null when nothing adopted it (still unreadable), so the edit is sent as for an ungoverned project', async () => {
    const h = harness({ disk: {} })
    expect(await h.authority.adoptOutsideEdit(project({ nodes: [node('a')] }))).toBeNull()
  })
})

describe('canvas authority — exec stays out of the state (R9)', () => {
  it('a read that carries this machine\'s shell is stripped: never written, and a sanitized echo is a no-op', async () => {
    const h = harness({ disk: { P: content([node('a', { shell: '/bin/zsh' })]) } })
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(shellOf(byId(h.writes[0].content.nodes, 'a'))).toBeUndefined()
    h.cast({ op: 'upsert', node: node('a') }) // what the reflector sends for a: sanitized
    await h.clock.advance(10_000)
    expect(h.writes).toHaveLength(1)
  })

  it('a load seed that carries a shell is stripped, while the load result keeps it', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    const out = await h.authority.overlayLoad(ws(project({ nodes: [node('a', { shell: '/bin/zsh' })] })))
    expect(shellOf(byId(out.projects[0].nodes, 'a'))).toBe('/bin/zsh')
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advance(1000)
    expect(h.reads).toEqual([])
    expect(shellOf(byId(h.writes[0].content.nodes, 'a'))).toBeUndefined()
  })

  it('an outside edit that carries a shell publishes no spurious change for that node', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    await h.authority.overlayLoad(ws(project({ nodes: [node('a')] })))
    await h.authority.adoptOutsideEdit(project({ nodes: [node('a', { shell: '/bin/zsh' })] }))
    expect(h.published).toEqual([])
    await h.clock.advance(10_000)
    expect(h.writes).toEqual([])
  })
})

describe('canvas authority — flushing and lifecycle', () => {
  it('12. a failed write keeps the state (and its unflushed ops) and retries on the backoff schedule', async () => {
    const h = harness({ disk: { P: content([node('a')]) }, writeResults: [false, false, true] })
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advanceTo(2500) // write 1 at 1000 fails, write 2 at 2000 fails
    expect(h.writes.map((w) => w.at)).toEqual([1000, 2000])
    // An outside edit between failures: the ops never written must survive it.
    h.disk.set('P', content([node('a'), node('x')]))
    await h.authority.adoptOutsideEdit(project({ nodes: [node('a'), node('x')] }))
    // An op during the backoff does not arm the quiet timer: the retry owns the next attempt, so a
    // failing disk is not written once per quiet period (it would be at 3600 here).
    await h.clock.advanceTo(2600)
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(60_000)
    expect(h.writes.map((w) => w.at)).toEqual([1000, 2000, 4000])
    expect(ids(h.writes[2].content.nodes)).toEqual(['a', 'x', 'b', 'c'])
    expect(h.logs).toHaveLength(2) // one per failed write
  })

  // N7: a write that fails for good (the file is gone or unreadable) retried every 30 s and logged
  // every time, forever. One line when a failure streak starts, one when it ends.
  it('12b. logs a failing write once per failure streak, and once on recovery', async () => {
    const h = harness({ disk: { P: content([node('a')]) }, writeResults: [false, false, false, false, true, false, true] })
    h.cast({ op: 'upsert', node: node('b') })
    await h.clock.advanceTo(20_000) // fails at 1 s, 2 s, 4 s, 8 s; lands at 16 s
    expect(h.writes).toHaveLength(5)
    expect(h.logs.filter((l) => l.includes('failed'))).toHaveLength(1)
    expect(h.logs.filter((l) => l.includes('succeeded'))).toHaveLength(1)
    // A new streak says so again.
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(10_000)
    expect(h.logs.filter((l) => l.includes('failed'))).toHaveLength(2)
    expect(h.logs.filter((l) => l.includes('succeeded'))).toHaveLength(2)
  })

  it('13. unsharing flushes the pending state once, then releases the project', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    h.cast({ op: 'upsert', node: node('b') })
    await settle()
    h.shared.delete('P')
    h.authority.sharedChanged()
    await settle()
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b'])
    expect(h.authority.governs('P')).toBe(false)
    expect(h.authority.governedIds()).toEqual([])
    expect(h.authority.adoptedIds()).toEqual([])
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(60_000)
    expect(h.writes).toHaveLength(1)
    expect(h.reads).toEqual(['P'])
  })

  it('13b. governedIds lists every shared project, adopted or not; adoptedIds only the adopted ones', async () => {
    const h = harness({ shared: ['P', 'Q'], disk: { P: content([node('a')]), Q: content([node('q')]) } })
    h.cast({ op: 'upsert', node: node('b') })
    await settle()
    expect([...h.authority.governedIds()].sort()).toEqual(['P', 'Q'])
    expect(h.authority.adoptedIds()).toEqual(['P'])
    expect(h.authority.governs('Q')).toBe(true)
  })

  it('13c. an unshared project whose write fails keeps retrying, and is released once it lands', async () => {
    const h = harness({ disk: { P: content([node('a')]) }, writeResults: [false] })
    h.cast({ op: 'upsert', node: node('b') })
    await settle()
    h.shared.delete('P')
    h.authority.sharedChanged()
    await settle()
    expect(h.writes).toHaveLength(1)
    await h.clock.advance(1000) // the retry
    expect(h.writes).toHaveLength(2)
    expect(ids(h.writes[1].content.nodes)).toEqual(['a', 'b'])
    // Released: sharing it again starts from a fresh read, not from the old state.
    h.disk.set('P', content([node('z')]))
    h.shared.add('P')
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(1000)
    expect(h.reads).toEqual(['P', 'P'])
    expect(ids(h.writes[2].content.nodes)).toEqual(['z', 'c'])
  })

  it('14. stop() resolves after the pending write; ops after it are ignored', async () => {
    const h = harness({ disk: { P: content([node('a')]) } })
    h.cast({ op: 'upsert', node: node('b') })
    await settle()
    await h.authority.stop()
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'b'])
    expect(h.authority.governs('P')).toBe(false)
    expect(h.authority.governedIds()).toEqual([])
    h.cast({ op: 'upsert', node: node('c') })
    await h.clock.advance(60_000)
    expect(h.writes).toHaveLength(1)
    expect(h.clock.pending()).toBe(0)
  })

  it('flushAll writes every dirty project now, without waiting for the quiet period', async () => {
    const h = harness({ shared: ['P', 'Q'], disk: { P: content([node('a')]), Q: content([node('q')]) } })
    h.cast({ op: 'upsert', node: node('b') })
    h.cast({ op: 'upsert', node: node('r') }, 'Q')
    await h.authority.flushAll()
    expect(h.writes.map((w) => [w.id, ids(w.content.nodes)]).sort()).toEqual([
      ['P', ['a', 'b']],
      ['Q', ['q', 'r']]
    ])
    expect(h.writes.every((w) => w.at === 0)).toBe(true)
  })
})

// The downgrade contract (CLAUDE.md, the group-frame bullet): a frame precedes its descendants in
// the persisted array, so a pre-nesting build's flat, STABLE groups-first sort still hydrates a
// nested tree parent-first. A governed project's file is written from the authority's array, not
// from React Flow's, so its reducer has to keep that order itself.
describe('canvas authority — the written node order is parent-first', () => {
  const group = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => node(id, { kind: 'group', ...over })
  const under = (parentId: string) => ({ parentId })
  /** Every node's parent (when it has one in the list) appears before it. */
  const parentFirst = (nodes: CanvasNodeState[]): boolean =>
    nodes.every((n, i) => !n.parentId || !nodes.some((p) => p.id === n.parentId) || nodes.findIndex((p) => p.id === n.parentId) < i)
  /** What a build that predates nesting does on load: a flat, stable "groups first" sort. */
  const preNestingSort = (nodes: CanvasNodeState[]): CanvasNodeState[] =>
    [...nodes].sort((a, b) => (a.kind === 'group' ? 0 : 1) - (b.kind === 'group' ? 0 : 1))

  it('grouping two nodes (the new frame is an append) writes the frame first', async () => {
    const h = harness({ disk: { P: content([node('a'), node('b')]) } })
    // The ops a client's publisher sends for groupSelectedNodes: next-array order, frame first.
    h.cast({ op: 'upsert', node: group('G') })
    h.cast({ op: 'upsert', node: node('a', under('G')) })
    h.cast({ op: 'upsert', node: node('b', under('G')) })
    await h.clock.advance(1000)
    expect(h.writes).toHaveLength(1)
    expect(ids(h.writes[0].content.nodes)).toEqual(['G', 'a', 'b'])
  })

  it('wrapping a frame into a new outer frame writes outer, inner, then the leaf', async () => {
    const h = harness({ disk: { P: content([group('I'), node('x', under('I'))]) } })
    h.cast({ op: 'upsert', node: group('O') })
    h.cast({ op: 'upsert', node: group('I', under('O')) })
    await h.clock.advance(1000)
    const written = h.writes[0].content.nodes
    expect(ids(written)).toEqual(['O', 'I', 'x'])
    // …and that is exactly what the downgrade contract needs: the flat sort leaves it parent-first.
    expect(parentFirst(preNestingSort(written))).toBe(true)
  })

  it('the same holds when the reparent reaches it before the new frame does', async () => {
    const h = harness({ disk: { P: content([group('I'), node('x', under('I'))]) } })
    h.cast({ op: 'upsert', node: group('I', under('O')) })
    h.cast({ op: 'upsert', node: group('O') })
    await h.clock.advance(1000)
    expect(ids(h.writes[0].content.nodes)).toEqual(['O', 'I', 'x'])
  })

  it('an upsert that neither appends nor reparents keeps the order it found, even a legacy one', async () => {
    // A file written before this order was enforced: the leaf ahead of its frame.
    const h = harness({ disk: { P: content([node('a', under('G')), group('G'), node('b')]) } })
    h.cast({ op: 'upsert', node: at('a', 42, under('G')) })
    h.cast({ op: 'upsert', node: group('G', { title: 'renamed' }) })
    await h.clock.advance(1000)
    expect(ids(h.writes[0].content.nodes)).toEqual(['a', 'G', 'b'])
    expect(byId(h.writes[0].content.nodes, 'a')?.position.x).toBe(42)
  })
})
