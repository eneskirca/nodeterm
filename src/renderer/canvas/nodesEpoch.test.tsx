// @vitest-environment jsdom
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { create } from 'zustand'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mirrorLatest, rebaseOnLatest, useNodesEpoch } from './nodesEpoch'
import { canCommitCanvas, liveCanvasHolds } from '../state/persistGuards'

// The field bug (2026-09-26): a project switch loaded project B, but a zustand store the load
// effect writes (worktrees reset, keep-alive pool, …) re-rendered Canvas at SyncLane BEFORE the
// DefaultLane `setNodes(flowB)` landed. That render mirrored the OLD `nodes` state into `nodesRef`
// while the epoch tag already said B — and the next commit wrote A's nodes into B's
// .nodeterm/project.json. These tests run real React (createRoot, no act batching) because the
// interleaving IS the bug: act() would flush both lanes together and hide it.
//
// The replica below is Canvas's load effect, its commit (`commitActiveToStore`) and its peer
// receive path (`canvas:mut`) cut down to string ids; `store` stands in for the projects store.

const useActive = create<{ id: string | null }>(() => ({ id: 'A' }))
const useOther = create<{ n: number }>(() => ({ n: 0 }))

/** One render: the `nodes` STATE it rendered, and the ref pair as that render left it. */
interface Seen { state: string[]; nodes: string[]; epoch: string | null }
let seen: Seen[] = []
/** Per render: the edge ref (Canvas's `linkEdgesRef`) and the tag it sat beside. */
let edgeSeen: Array<{ edges: string[]; epoch: string | null }> = []
let root: ReturnType<typeof createRoot> | null = null
/** The projects store: each project's serialized nodes. */
let store: Record<string, string[]> = {}
/** The project the load effect last ran for, and how many renders there were at that moment. */
let loaded: { id: string | null; at: number } = { id: null, at: 0 }
let live: {
  nodesRef: { current: string[] }
  nodesProjectIdRef: { current: string | null }
  setNodes: (next: string[] | ((ns: string[]) => string[])) => void
  setEdges: (next: string[] | ((es: string[]) => string[])) => void
} | null = null

function Canvas() {
  const active = useActive((s) => s.id)
  useOther((s) => s.n)
  const [nodes, setNodes] = useState<string[]>([])
  const [edges, setEdges] = useState<string[]>([])
  const { nodesRef, nodesProjectIdRef, renderedProjectId, installEpoch } = useNodesEpoch(nodes)
  // Canvas's edge lists: a latest ref beside the state, mirrored under the node mirror's rule.
  const edgesRef = useRef<string[]>(edges)
  const edgesMirroredRef = useRef<string[]>(edges)
  mirrorLatest(edges, edgesMirroredRef, edgesRef, renderedProjectId === nodesProjectIdRef.current)
  seen.push({ state: nodes, nodes: nodesRef.current, epoch: nodesProjectIdRef.current })
  edgeSeen.push({ edges: edgesRef.current, epoch: nodesProjectIdRef.current })
  live = { nodesRef, nodesProjectIdRef, setNodes, setEdges }
  useEffect(() => {
    loaded = { id: active, at: seen.length }
    const saved = active ? store[active] : undefined
    if (!saved) {
      // Canvas's bail-outs (welcome screen, unknown project): the previous nodes stay MOUNTED.
      installEpoch(null)
      useOther.setState((s) => ({ n: s.n + 1 }))
      return
    }
    const flow = [...saved]
    setNodes(flow)
    // The load writes the edge ref synchronously beside its setter, as Canvas's does.
    const flowEdges = [`${active}-edge`]
    edgesRef.current = flowEdges
    setEdges(flowEdges)
    installEpoch(active, flow)
    // Canvas subscribes to stores its load effect writes; each write is a SyncLane re-render.
    useOther.setState((s) => ({ n: s.n + 1 }))
  }, [active, installEpoch])
  return null
}

/** `commitActiveToStore`: write the live canvas into the ACTIVE project, if the epoch pairs. */
function commit() {
  const active = useActive.getState().id
  if (!active || !live || !canCommitCanvas(live.nodesProjectIdRef.current, active)) return
  store[active] = live.nodesRef.current
}

/** The `canvas:mut` receive path for a node upsert — Canvas's: the same route and the same updater. */
function receive(projectId: string, id: string) {
  if (!live) return
  const { nodesRef, nodesProjectIdRef, setNodes } = live
  if (!liveCanvasHolds(nodesProjectIdRef.current, useActive.getState().id, projectId)) {
    // Not on screen: the serialized nodes (an unknown project has none to patch).
    if (store[projectId]) store[projectId] = [...store[projectId], id]
    return
  }
  const apply = (ns: string[]) => (ns.includes(id) ? ns : [...ns, id])
  const base = nodesRef.current
  const flow = apply(base)
  if (flow === base) return
  nodesRef.current = flow
  setNodes(rebaseOnLatest(base, flow, apply))
}

const settle = () => new Promise((r) => setTimeout(r, 30))
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await settle()
  expect(ok()).toBe(true)
}

/**
 * Wait — on MICROTASKS only, so the DefaultLane render (a macrotask) cannot run — for the window
 * itself: the load effect for `id` has run, and a render after it still shows the previous nodes.
 * Fails loudly if the window never opened, rather than passing a test that never exercised it.
 */
async function untilWindow(id: string) {
  const open = () =>
    loaded.id === id && seen.length > loaded.at && !seen.at(-1)?.state.includes(`${id}-node`)
  for (let i = 0; i < 100 && !open(); i++) await Promise.resolve()
  expect(open(), 'the SyncLane window never opened').toBe(true)
}

async function mount() {
  useActive.setState({ id: 'A' })
  const el = document.createElement('div')
  root = createRoot(el)
  root.render(<Canvas />)
  await until(() => seen.at(-1)?.epoch === 'A' && seen.at(-1)?.nodes[0] === 'A-node')
  seen = []
  edgeSeen = []
}

beforeEach(() => {
  store = { A: ['A-node'], B: ['B-node'] }
  loaded = { id: null, at: 0 }
})

afterEach(() => {
  root?.unmount()
  root = null
  live = null
})

/** Every render must pair the nodes it mirrors with the project they belong to. */
function expectPaired() {
  for (const s of seen) {
    if (s.epoch === null) continue
    expect(s.nodes.every((n) => n.startsWith(`${s.epoch}-`)), JSON.stringify(s)).toBe(true)
  }
}

it('never pairs the previous project nodes with the incoming project epoch', async () => {
  await mount()
  useActive.setState({ id: 'B' })
  await until(() => seen.at(-1)?.epoch === 'B')
  await settle()
  expectPaired()
  expect(seen.at(-1)).toEqual({ state: ['B-node'], nodes: ['B-node'], epoch: 'B' })
})

it('keeps the tag cleared after a bail-out (welcome screen) instead of re-mirroring the old project', async () => {
  await mount()
  useActive.setState({ id: null })
  await until(() => seen.length > 1)
  await settle()
  expect(seen.at(-1)?.epoch).toBeNull()
})

// THE PERSISTED-CORRUPTION HALF (Task 2 review, risk E). In the window above, the render-time mirror
// put A's nodes back into `nodesRef` (paired with A's tag, so no commit took them) — but a peer's op
// for B, the ACTIVE project, was applied to that array and `setNodes`'d as a plain value queued
// AFTER the load's: the canvas ended on A's nodes plus the op, tagged B, and the next commit wrote
// them into B's project file.
it('a peer op in the switch window lands on the incoming project, never on the outgoing nodes', async () => {
  await mount()
  commit() // every switch handler commits before it switches
  useActive.setState({ id: 'B' })
  await untilWindow('B')
  receive('B', 'B-peer') // a teammate's upsert for B, in the window
  commit() // an autosave / switch handler in the same window
  await until(() => !!seen.at(-1)?.state.includes('B-peer'))
  await settle()
  commit()
  expectPaired()
  expect(seen.at(-1)).toEqual({ state: ['B-node', 'B-peer'], nodes: ['B-node', 'B-peer'], epoch: 'B' })
  expect(store).toEqual({ A: ['A-node'], B: ['B-node', 'B-peer'] })
})

// A higher-priority update in the same window: a discrete event (a click, a key) renders its
// `setNodes(fn)` at SyncLane on top of the OUTGOING nodes — a CHANGED array under A's tag state. A
// mirror that copied every changed array would put it into `nodesRef` under B's tag, and a commit
// would write it into B.
it('a discrete update in the switch window never puts the outgoing nodes under the incoming tag', async () => {
  await mount()
  commit()
  useActive.setState({ id: 'B' })
  await untilWindow('B')
  flushSync(() => live?.setNodes((ns) => [...ns, ns[0].replace('-node', '-local')]))
  commit()
  await until(() => seen.at(-1)?.epoch === 'B' && !!seen.at(-1)?.state.includes('B-node'))
  await settle()
  expectPaired()
  expect(seen.at(-1)).toEqual({ state: ['B-node', 'B-local'], nodes: ['B-node', 'B-local'], epoch: 'B' })
  expect(store.B.every((n) => n.startsWith('B-'))).toBe(true)
})

// D4: the edge refs follow the node mirror's epoch rule. A discrete `setLinkEdges(fn)` in the switch
// window renders fn(the OUTGOING project's edges) — a CHANGED array — and a mirror that copied it put
// A's edges under B's tag, so Canvas's edge publisher diffed B against them and cast spurious
// `edge-remove`s into B.
it('a discrete edge update in the switch window never puts the outgoing edges under the incoming tag (D4)', async () => {
  await mount()
  useActive.setState({ id: 'B' })
  await untilWindow('B')
  flushSync(() => live?.setEdges((es) => [...es, es[0].replace('-edge', '-local')]))
  await until(() => seen.at(-1)?.epoch === 'B' && !!seen.at(-1)?.state.includes('B-node'))
  await settle()
  for (const e of edgeSeen) {
    if (e.epoch === null) continue
    expect(e.edges.every((x) => x.startsWith(`${e.epoch}-`)), JSON.stringify(e)).toBe(true)
  }
  expect(edgeSeen.at(-1)).toEqual({ edges: ['B-edge', 'B-local'], epoch: 'B' })
})

// Route by the TAG, not only by the active id: a peer's op for the active project belongs on React
// Flow only if React Flow holds that project. After a bail-out (an unknown project) the previous
// nodes stay mounted with the tag cleared; the op must not be mixed into them.
it('a peer op for a project whose canvas is not mounted never lands on the nodes on screen', async () => {
  await mount()
  commit()
  useActive.setState({ id: 'C' }) // not in the store: the load bails out, A's nodes stay mounted
  await until(() => seen.at(-1)?.epoch === null)
  receive('C', 'C-peer')
  await settle()
  expect(seen.at(-1)?.state).toEqual(['A-node'])
  expect(store).toEqual({ A: ['A-node'], B: ['B-node'] })
})

// The receive `setNodes` is FUNCTIONAL: it applies the op to the latest QUEUED state, not only to
// the ref. A local edit still queued when a peer's op lands (a React Flow change mid-drag) used to be
// overwritten by the plain value built from the last rendered array.
it('a peer op landing while a local edit is still queued keeps both', async () => {
  await mount()
  live?.setNodes((ns) => [...ns, 'A-local']) // queued, not yet rendered
  receive('A', 'A-peer') // same tick
  await until(() => !!seen.at(-1)?.state.includes('A-peer'))
  await settle()
  expect(seen.at(-1)?.state).toEqual(['A-node', 'A-local', 'A-peer'])
})
