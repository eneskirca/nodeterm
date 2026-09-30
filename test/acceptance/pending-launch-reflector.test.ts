// `pendingLaunch` (a machine-local held launch, @shared/node-exec) through the REAL core reflector
// and into the renderer that applies what it delivered.
//
// CROSS-LAYER on purpose, which is why it lives here rather than in `src/`: the per-recipient
// decision is the core's (core/canvas-sync.ts) and the apply is the renderer's (applyMutationToFlow,
// the projects store), and production layering forbids the renderer importing core. Testing the
// renderer half against a hand-built copy of the core's decision would stay green if the two drifted.
import { describe, it, expect, afterEach } from 'vitest'
import { applyMutationToFlow, nodeStatesToFlow, flowToNodeStates, type CanvasNode } from '../../src/renderer/state/workspace'
import { useProjects } from '../../src/renderer/state/projects'
import { launchesToFire } from '../../src/renderer/lib/pendingLaunch'
import { stripCastNodeExec } from '../../src/shared/node-exec'
import { applyCanvasMutation } from '../../src/shared/canvas-mutations'
import { IPC } from '../../src/shared/ipc'
import { initCanvasSync, publishCanvasMutation } from '../../src/core/canvas-sync'
import { initPlatform, resetPlatformForTests, type CorePlatform } from '../../src/core/platform'
import type { CanvasMutation, CanvasNodeState, PendingLaunch } from '../../src/shared/types'

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

/**
 * The REAL reflector (core/canvas-sync.ts: `initCanvasSync` → stampMutation → fanOutMutation), on a
 * fake platform with three clients: tab A (1) and tab B (2) are owner browser tabs of one Server
 * Edition core, 3 is a relay-hosted guest. What each client receives is exactly what the core sent
 * it; the renderer half then applies it. No hand-built copy of the core's per-recipient decision.
 */
const TAB_A = 1
const TAB_B = 2
const GUEST = 3
function reflectorPlatform(owners: number[]) {
  const sent: Array<{ to: number; m: CanvasMutation }> = []
  let listener: ((senderId: number, ...args: unknown[]) => void) | undefined
  const p: CorePlatform = {
    userDataDir: '/nonexistent',
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => {
      if (ch === IPC.canvasMut) listener = fn
    },
    clientIds: () => [TAB_A, TAB_B, GUEST],
    isOwnerClient: (id) => owners.includes(id),
    sendTo: (to, channel, _projectId, m) => {
      if (channel === IPC.canvasMut) sent.push({ to, m: m as CanvasMutation })
    },
    broadcast: () => {},
    openExternal: async () => {}
  }
  initPlatform(p)
  initCanvasSync()
  return {
    /** Client `from` casts `m`; returns what the core delivered to each client. */
    cast(from: number, m: CanvasMutation): Map<number, CanvasMutation> {
      sent.length = 0
      listener?.(from, 'p1', m)
      return new Map(sent.map((s) => [s.to, s.m]))
    },
    /** The core publishes `m` itself (the headless factory's path); returns each delivery. */
    publish(m: CanvasMutation): Map<number, CanvasMutation> {
      sent.length = 0
      expect(publishCanvasMutation('p1', m)).toBe(true)
      return new Map(sent.map((s) => [s.to, s.m]))
    }
  }
}
afterEach(() => resetPlatformForTests())

const claimedLaunch: PendingLaunch = { ...armed, attempted: true, manualOnly: true }
/** Tab A's cast of its claim (the write-ahead `attempted:true, manualOnly:true`), as the renderer
 *  publisher builds it. */
const claimCast = (): CanvasMutation => ({
  op: 'upsert',
  node: stripCastNodeExec(flowToNodeStates(flow(state({ pendingLaunch: claimedLaunch }))))[0],
  src: 'cv-a',
  seq: 1
})

describe('two owner tabs on one Server Edition core: a launch is typed exactly once', () => {
  it('an owner tab B receives A\'s claim through the reflector and does not fire', () => {
    const got = reflectorPlatform([TAB_A, TAB_B]).cast(TAB_A, claimCast())
    const b = applyMutationToFlow(flow(state({ pendingLaunch: armed })), got.get(TAB_B)!)
    expect(b[0].data.pendingLaunch?.manualOnly).toBe(true)
    expect(launchesToFire(b as never, {}, new Set(['n1']))).toEqual([])
  })
  it('A\'s delivery (the claim cleared) clears it on B too', () => {
    const r = reflectorPlatform([TAB_A, TAB_B])
    const b = applyMutationToFlow(flow(state({ pendingLaunch: claimedLaunch })), r.cast(TAB_A, { op: 'upsert', node: state(), src: 'cv-a', seq: 2 }).get(TAB_B)!)
    expect(b[0].data.pendingLaunch).toBeUndefined()
  })
  it('the relay guest gets the node WITHOUT the owner\'s launch, and keeps its own', () => {
    const got = reflectorPlatform([TAB_A, TAB_B]).cast(TAB_A, claimCast())
    const guest = applyMutationToFlow(flow(state({ pendingLaunch: armed })), got.get(GUEST)!)
    expect(guest[0].data.pendingLaunch).toEqual(armed)
  })
  it('control: if B were not an owner, it would not receive the claim and would fire a second time', () => {
    const got = reflectorPlatform([TAB_A]).cast(TAB_A, claimCast())
    const b = applyMutationToFlow(flow(state({ pendingLaunch: armed })), got.get(TAB_B)!)
    expect(launchesToFire(b as never, {}, new Set(['n1'])).map((l) => l.id)).toEqual(['n1'])
  })
  it('a relay guest\'s cast (even stamped origin:\'core\') neither sets nor clears an owner\'s launch', () => {
    const r = reflectorPlatform([TAB_A, TAB_B])
    const forged: CanvasMutation = { op: 'upsert', node: state(), src: 'cv-g', seq: 1, origin: 'core' }
    const b = applyMutationToFlow(flow(state({ pendingLaunch: armed })), r.cast(GUEST, forged).get(TAB_B)!)
    expect(b[0].data.pendingLaunch).toEqual(armed)
    const planted: CanvasMutation = { ...forged, node: state({ id: 'x', pendingLaunch: armed }) }
    const b2 = applyMutationToFlow(flow(state()), r.cast(GUEST, planted).get(TAB_B)!)
    expect(b2.find((n) => n.id === 'x')?.data.pendingLaunch).toBeUndefined()
  })
})

describe('the core publishes a brand-new held node (Server Edition headless factory)', () => {
  // headless-node-factory.test.ts pins that the factory publishes the held node first; this is what
  // an owner tab does with that publish — the APPEND branch, on screen and in the store.
  const held = (): CanvasNodeState => state({ id: 'h1', pendingLaunch: claimedLaunch })
  it('an owner tab appends it with its launch (live canvas and a background project alike)', () => {
    const got = reflectorPlatform([TAB_A, TAB_B]).publish({ op: 'upsert', node: held() })
    const live = applyMutationToFlow(flow(state()), got.get(TAB_B)!)
    expect(live.find((n) => n.id === 'h1')?.data.pendingLaunch).toEqual(claimedLaunch)
    expect(applyCanvasMutation([state()], got.get(TAB_B)!).find((n) => n.id === 'h1')?.pendingLaunch).toEqual(claimedLaunch)

    useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
    const p = useProjects.getState().addProject('p', '/tmp/p')
    expect(useProjects.getState().applyNodeMutation(p.id, got.get(TAB_B)!)).toBe(true)
    expect(useProjects.getState().getProject(p.id)!.nodes.find((n) => n.id === 'h1')?.pendingLaunch).toEqual(claimedLaunch)
  })
  it('the relay guest appends it without the launch', () => {
    const got = reflectorPlatform([TAB_A, TAB_B]).publish({ op: 'upsert', node: held() })
    expect(applyMutationToFlow([], got.get(GUEST)!)[0].data.pendingLaunch).toBeUndefined()
  })
})
