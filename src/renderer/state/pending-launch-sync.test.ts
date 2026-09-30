// `pendingLaunch` across the live canvas (applyMutationToFlow), the background-project store
// (applyNodeMutation / applyOwnNodeMutation), and a relay tab's receive path. The two-owner-tabs
// half (through the real core reflector) is cross-layer and lives in
// test/acceptance/pending-launch-reflector.test.ts.
//
// The launch is machine-local (@shared/node-exec): a peer or relay guest may never set, replace or
// clear it. Two OWNER tabs, though, must still agree on who claimed a launch, or both would type it
// — so the core forwards an owner's copy to the other owners with `origin: 'core'`, and that copy
// is authoritative. The peer/relay half is pinned here.
import { describe, it, expect, beforeEach } from 'vitest'
import { applyMutationToFlow, nodeStatesToFlow, type CanvasNode } from './workspace'
import { useProjects } from './projects'
import { receivedCanvasMutation } from '../session/relay-ssh'
import type { CanvasMutation, CanvasNodeState, PendingLaunch } from '@shared/types'

const armed: PendingLaunch = { after: [], command: 'claude "brief"', attempted: false }
const state = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'n1',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 480, height: 320 },
  title: 'n1',
  color: '#fff',
  group: null,
  ...over
})
const flow = (s: CanvasNodeState): CanvasNode[] => nodeStatesToFlow([s])

describe('applyMutationToFlow (live canvas)', () => {
  it('a peer upsert carrying a launch neither arms a node nor replaces ours', () => {
    const fresh = applyMutationToFlow([], { op: 'upsert', node: state({ pendingLaunch: { after: [], command: 'evil' } }) })
    expect(fresh[0].data.pendingLaunch).toBeUndefined()
    const mine = flow(state({ pendingLaunch: armed }))
    const moved = applyMutationToFlow(mine, { op: 'upsert', node: state({ position: { x: 9, y: 9 } }) })
    expect(moved[0].data.pendingLaunch).toEqual(armed)
    expect(moved[0].position).toEqual({ x: 9, y: 9 })
  })
  it('a relay guest keeps its own launch through the host\'s stripped echo', () => {
    // The host strips the guest's launch before reflecting; the guest's own live copy survives.
    const guest = flow(state({ pendingLaunch: armed }))
    const echo = applyMutationToFlow(guest, { op: 'upsert', node: state(), seq: 4 })
    expect(echo[0].data.pendingLaunch).toEqual(armed)
  })
  it('a core-vouched copy sets and clears', () => {
    const mine = flow(state({ pendingLaunch: armed }))
    const cleared = applyMutationToFlow(mine, { op: 'upsert', node: state(), origin: 'core' })
    expect(cleared[0].data.pendingLaunch).toBeUndefined()
  })
  it('a core-vouched copy of a node we do NOT have yet is appended WITH its launch', () => {
    // The append branch: the Server Edition's headless factory publishes a brand-new held node.
    const other = flow(state({ id: 'n0' }))
    const out = applyMutationToFlow(other, { op: 'upsert', node: state({ pendingLaunch: armed }), origin: 'core' })
    expect(out.find((n) => n.id === 'n1')?.data.pendingLaunch).toEqual(armed)
  })
})

describe('projects store (a project not on screen)', () => {
  beforeEach(() => useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] }))
  it('patchStored(..., undefined) through applyOwnNodeMutation CLEARS the launch', () => {
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().commitCanvas(p.id, [state({ pendingLaunch: armed })], { x: 0, y: 0, zoom: 1 })
    const stored = useProjects.getState().getProject(p.id)!.nodes[0]
    expect(useProjects.getState().applyOwnNodeMutation(p.id, { op: 'upsert', node: { ...stored, pendingLaunch: undefined } })).toBe(true)
    expect(useProjects.getState().getProject(p.id)!.nodes[0].pendingLaunch).toBeUndefined()
  })
  it('a cold open through applyOwnNodeMutation keeps the launch it moved into pendingLaunch', () => {
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().applyOwnNodeMutation(p.id, { op: 'upsert', node: state({ pendingLaunch: armed }) })
    expect(useProjects.getState().getProject(p.id)!.nodes[0].pendingLaunch).toEqual(armed)
  })
  it('the peer path (applyNodeMutation) can neither plant nor clear one', () => {
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().applyNodeMutation(p.id, { op: 'upsert', node: state({ id: 'x', pendingLaunch: armed }) })
    expect(useProjects.getState().getProject(p.id)!.nodes[0].pendingLaunch).toBeUndefined()
    useProjects.getState().applyOwnNodeMutation(p.id, { op: 'upsert', node: state({ pendingLaunch: armed }) })
    useProjects.getState().applyNodeMutation(p.id, { op: 'upsert', node: state() })
    expect(useProjects.getState().getProject(p.id)!.nodes.find((n) => n.id === 'n1')!.pendingLaunch).toEqual(armed)
  })
})

/**
 * A relay TAB on this machine shows another machine's project; its mutations come from that
 * machine's core, which can put `origin: 'core'` on anything. Canvas.tsx passes every received
 * mutation through `receivedCanvasMutation(received, relay)` before applying it (live canvas, or
 * the store for a background project) — so a remote vouch can neither plant nor clear a launch here.
 */
describe('a relay tab: a remote core\'s origin:\'core\' vouches for nothing', () => {
  const vouchedClear: CanvasMutation = { op: 'upsert', node: state(), origin: 'core', seq: 1 }
  const vouchedPlant: CanvasMutation = { op: 'upsert', node: state({ id: 'x', pendingLaunch: { after: [], command: 'evil' } }), origin: 'core', seq: 2 }
  it('live canvas: cannot clear our launch, cannot plant one', () => {
    const mine = flow(state({ pendingLaunch: armed }))
    expect(applyMutationToFlow(mine, receivedCanvasMutation(vouchedClear, true))[0].data.pendingLaunch).toEqual(armed)
    const planted = applyMutationToFlow(mine, receivedCanvasMutation(vouchedPlant, true))
    expect(planted.find((n) => n.id === 'x')?.data.pendingLaunch).toBeUndefined()
  })
  it('background project (the store): cannot clear our launch, cannot plant one', () => {
    useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
    const p = useProjects.getState().addProject('p', '/tmp/p')
    useProjects.getState().applyOwnNodeMutation(p.id, { op: 'upsert', node: state({ pendingLaunch: armed }) })
    useProjects.getState().applyNodeMutation(p.id, receivedCanvasMutation(vouchedClear, true))
    useProjects.getState().applyNodeMutation(p.id, receivedCanvasMutation(vouchedPlant, true))
    const nodes = useProjects.getState().getProject(p.id)!.nodes
    expect(nodes.find((n) => n.id === 'n1')?.pendingLaunch).toEqual(armed)
    expect(nodes.find((n) => n.id === 'x')?.pendingLaunch).toBeUndefined()
  })
  it('control: the same vouched copy on a LOCAL session is authoritative (sets and clears)', () => {
    const mine = flow(state({ pendingLaunch: armed }))
    expect(applyMutationToFlow(mine, receivedCanvasMutation(vouchedClear, false))[0].data.pendingLaunch).toBeUndefined()
    const planted = applyMutationToFlow(mine, receivedCanvasMutation(vouchedPlant, false))
    expect(planted.find((n) => n.id === 'x')?.data.pendingLaunch).toEqual({ after: [], command: 'evil' })
  })
})
