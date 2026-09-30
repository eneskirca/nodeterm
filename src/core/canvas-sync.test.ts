import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { fakePlatform, makeFakeUserDataDir } from './platform-fake'
import {
  initCanvasSync,
  publishCanvasMutation,
  reflectTargets,
  setReflectedListener,
  stampMutation,
  isCanvasMutation,
  MUTATION_MAX_BYTES
} from './canvas-sync'
import { IPC } from '../shared/ipc'
import { createCanvasOrder } from '../shared/canvas-order'
import type { CanvasMutation, CanvasNodeState } from '../shared/types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

/** Recording CorePlatform with a cast() that carries the sender id (the Stage-1 onWithSender seam). */
function testPlatform() {
  const sent: Array<{ to: number; channel: string; args: unknown[] }> = []
  const registrations: string[] = []
  let clients: number[] = []
  const senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  const p: CorePlatform = {
    // A fresh mkdtemp dir, never a fixed literal: this platform is registered via initPlatform,
    // so a predictable '/tmp/...' here reads (to CodeQL's js/insecure-temporary-file, and to a
    // parallel test run) as every production write through platform().userDataDir landing on a
    // shared guessable temp path — the exact fix platform-fake.ts documents. Made under the run's
    // root (makeFakeUserDataDir), so the run's teardown removes it; a bare mkdtemp in os.tmpdir()
    // here left one directory behind per test, for good.
    userDataDir: makeFakeUserDataDir(),
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => {
      registrations.push(ch)
      senderListeners.set(ch, fn)
    },
    clientIds: () => clients,
    sendTo: (to, channel, ...args) => void sent.push({ to, channel, args }),
    broadcast: () => {},
    openExternal: async () => {}
  }
  return {
    p,
    sent,
    registrations,
    setClients: (ids: number[]) => (clients = ids),
    cast: (senderId: number, ...args: unknown[]) =>
      senderListeners.get(IPC.canvasMut)?.(senderId, ...args)
  }
}

let t: ReturnType<typeof testPlatform>

beforeEach(() => {
  t = testPlatform()
  initPlatform(t.p)
  initCanvasSync()
})
afterEach(() => {
  setReflectedListener(null)
  resetPlatformForTests()
})

describe('reflectTargets', () => {
  // The sender IS a target: its copy is the ACK that tells it where its own edit landed in the
  // total order — without which two clients editing one node cannot converge (canvas-order rule 2).
  it('is every attached client, the sender included', () => {
    expect(reflectTargets([1, 2, 3], 2)).toEqual([1, 2, 3])
    expect(reflectTargets([1], 1)).toEqual([1])
    expect(reflectTargets([], 1)).toEqual([])
  })
})

describe('stampMutation', () => {
  it('stamps the total order and keeps the sender tag', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', src: 'cv-abc' }, 7)).toEqual({
      op: 'remove',
      id: 'n1',
      src: 'cv-abc',
      seq: 7
    })
  })

  it('overwrites a client-supplied seq: the order is the server\'s, never the client\'s', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', seq: 999_999 }, 3).seq).toBe(3)
  })

  it('drops a malformed src rather than reflecting it to every peer', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', src: 'x'.repeat(129) }, 1).src).toBeUndefined()
    expect(stampMutation({ op: 'remove', id: 'n1', src: '' }, 1).src).toBeUndefined()
    expect(
      stampMutation({ op: 'remove', id: 'n1', src: 42 as unknown as string }, 1).src
    ).toBeUndefined()
  })

  // `seen` (canvas-order rule 4): an upsert claiming to have seen a node's delete is applied over it.
  // It can never legitimately reach the order it is being given, so it is clamped below it. The
  // clamp is hygiene, not protection: it changes no verdict (every earlier remove is at most
  // `seq - 1`), so a forged `seen` still resurrects a deleted node, clamp or no clamp.
  it('passes an honest `seen` through untouched', () => {
    expect(stampMutation({ op: 'upsert', node: node('n1'), seen: 6 }, 9).seen).toBe(6)
    expect(stampMutation({ op: 'upsert', node: node('n1'), seen: 0 }, 1).seen).toBe(0)
  })

  it('clamps a forged `seen` to just below the order it is being given', () => {
    expect(stampMutation({ op: 'upsert', node: node('n1'), seen: 999_999 }, 9).seen).toBe(8)
    expect(stampMutation({ op: 'upsert', node: node('n1'), seen: 9 }, 9).seen).toBe(8)
  })

  // Unstamped is judged exactly as before rule 4: never stale, so an unstamped upsert ordered after a
  // remove IS applied over it (canvas-order `supersededByRemove`). Not protection either: omitting
  // `seen` gets the same verdict.
  it('drops a non-integer / negative `seen`, degrading to unstamped (judged as before rule 4)', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '5', null]) {
      expect(
        stampMutation({ op: 'upsert', node: node('n1'), seen: bad as unknown as number }, 4).seen
      ).toBeUndefined()
    }
    expect(stampMutation({ op: 'upsert', node: node('n1') }, 4).seen).toBeUndefined()
  })

  // canvas-order's reset() keeps a client's causal position (a same-core reconnect needs it). If the
  // core REALLY restarted, that kept value is above every `seq` the new core hands out, so the cast
  // reads as "never stale" on a peer (the pre-rule-4 verdict: a degrade, never a split) WITH OR
  // WITHOUT the clamp: unclamped, 40 is also ≥ the tombstone's 3 (canvas-order `supersededByRemove`).
  // The clamp to `seq - 1` asserted below is hygiene; it changes no verdict.
  it('a causal position kept across a real core restart reads as never stale (the clamp is hygiene)', () => {
    const me = createCanvasOrder('me')
    me.accept({ op: 'upsert', node: node('n2'), src: 'x', seq: 40 }) // the old core had reached 40
    me.reset() // …and restarted at 0
    const peer = createCanvasOrder('peer')
    expect(peer.accept({ op: 'remove', id: 'n1', src: 'x', seq: 3 })).toBe(true) // the new core's delete
    const cast = stampMutation(me.stamp({ op: 'upsert', node: node('n1') }), 5)
    expect(cast.seen).toBe(4)
    expect(peer.accept(cast)).toBe(true)
  })
})

describe('isCanvasMutation', () => {
  it('accepts well-formed mutations and rejects malformed ones', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'n1' })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert', node: node('n1') })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert' })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { position: { x: 1, y: 1 } } })).toBe(false)
    expect(isCanvasMutation({ op: 'remove' })).toBe(false)
    expect(isCanvasMutation({ op: 'nope', id: 'n1' })).toBe(false)
    expect(isCanvasMutation(null)).toBe(false)
    expect(isCanvasMutation('n1')).toBe(false)
  })

  it('rejects a non-finite position (NaN/Infinity would wedge React Flow)', () => {
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: NaN, y: 0 } } })).toBe(false)
    expect(
      isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: 0, y: Infinity } } })
    ).toBe(false)
  })

  it('bounds what comes off the wire: over-long ids and oversized nodes are rejected', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'x'.repeat(129) })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('x'.repeat(129)) } })).toBe(false)
    const fat = { ...node('n1'), data: { text: 'a'.repeat(MUTATION_MAX_BYTES) } }
    expect(isCanvasMutation({ op: 'upsert', node: fat })).toBe(false)
  })
})

describe('initCanvasSync (reflector)', () => {
  // Every client, sender included — the sender's copy is its ack (see reflectTargets above). The
  // client drops its own echo instead of re-applying it (canvas-order rule 1), so this is not a
  // loop: the publisher's adopt guard means nothing is ever re-published.
  it('fans a mutation to every attached client, stamped with the total order', () => {
    t.setClients([1, 2, 3])
    const m: CanvasMutation = { op: 'upsert', node: node('n1', 42), src: 'cv-b' }
    t.cast(2, 'p1', m)
    const stamped = { ...m, seq: 1 }
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', stamped] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', stamped] },
      { to: 3, channel: IPC.canvasMut, args: ['p1', stamped] }
    ])
  })

  it('seq is monotone across senders and projects — one total order for everyone', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'remove', id: 'n1' })
    t.cast(2, 'p2', { op: 'remove', id: 'n2' })
    t.cast(2, 'p1', { op: 'remove', id: 'n3' })
    expect(t.sent.map((s) => (s.args[1] as CanvasMutation).seq)).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('a solo client still gets its own mutation back (the ack), and nothing else happens', () => {
    t.setClients([1])
    t.cast(1, 'p1', { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'n1', seq: 1 }] }
    ])
  })

  it('drops a malformed mutation instead of reflecting it', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert' })
    t.cast(1, 'p1', undefined)
    t.cast(1, undefined, { op: 'remove', id: 'n1' })
    t.cast(1, 'p'.repeat(129), { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([])
  })

  it('holds no canvas state: it reflects each mutation verbatim (bar the stamp), in order', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert', node: node('a') })
    t.cast(2, 'p1', { op: 'remove', id: 'a' })
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'upsert', node: node('a'), seq: 1 }] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'upsert', node: node('a'), seq: 1 }] },
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'a', seq: 2 }] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'a', seq: 2 }] }
    ])
  })

  it('forwards only the fields a remove or an edge op defines, and refuses an oversized remove (D1)', () => {
    t.setClients([1, 2])
    const pad = 'x'.repeat(100_000)
    t.cast(1, 'p1', { op: 'remove', id: 'a', pad, src: 'cv-a' })
    t.cast(1, 'p1', { op: 'edge-upsert', kind: 'rope', edge: { id: 'e', source: 'a', target: 'b', pad }, pad })
    t.cast(1, 'p1', { op: 'remove', id: 'b', pad: 'x'.repeat(MUTATION_MAX_BYTES) })
    const to2 = t.sent.filter((x) => x.to === 2).map((x) => x.args[1])
    expect(to2).toEqual([
      { op: 'remove', id: 'a', src: 'cv-a', seq: 1 },
      { op: 'edge-upsert', kind: 'rope', edge: { id: 'e', source: 'a', target: 'b' }, seq: 2 }
    ])
  })

  it('is NOT rate-limited: a bulk delete of many nodes reflects every one', () => {
    t.setClients([1, 2])
    for (let i = 0; i < 200; i++) t.cast(1, 'p1', { op: 'remove', id: `n${i}` })
    expect(t.sent).toHaveLength(400) // 200 mutations × (peer + sender ack)
    expect(t.sent[399]).toEqual({
      to: 2,
      channel: IPC.canvasMut,
      args: ['p1', { op: 'remove', id: 'n199', seq: 200 }]
    })
  })

  // `on` and `onWithSender` COMPOSE on the same channel — on BOTH shells (see
  // pty-manager-platform.test.ts). A second, plain listener on canvas:mut would reflect every
  // mutation TWICE to every peer. Registration must be sender-aware and singular.
  it('registers canvas:mut EXACTLY ONCE, sender-aware (no composed plain listener)', () => {
    resetPlatformForTests()
    const fake = fakePlatform()
    initPlatform(fake)
    initCanvasSync()
    expect(fake.senderListeners[IPC.canvasMut]).toBeDefined()
    expect(fake.listeners[IPC.canvasMut]).toBeUndefined()
    expect(fake.handlers[IPC.canvasMut]).toBeUndefined()
  })

  // ServerPlatform keeps an ORDERED SET of listeners per channel, so a second registration on the
  // same platform is not an overwrite — it would reflect every mutation twice to every peer.
  it('is idempotent per platform: initCanvasSync twice registers the listener once', () => {
    expect(t.registrations).toEqual([IPC.canvasMut]) // beforeEach registered it
    initCanvasSync()
    expect(t.registrations).toEqual([IPC.canvasMut])
  })
})

// Kanban ops ride the same reflector (@shared/kanban-ops): the same ingest verdict, the same stamp —
// and, because every peer and the authority must receive the SAME repaired op rather than each
// repairing the raw one, the reflector reflects the SANITIZED op (stamp fields kept).
describe('initCanvasSync (reflector) — kanban ops', () => {
  // Ruling R5: a name is REPAIRED (control and bidi characters stripped), never refused — the UI
  // has no length cap, so a refused rename would silently never sync. A name with nothing left once
  // repaired is still refused, and so is a bad id.
  it('refuses a kb-label whose name is empty once repaired, and one with a bad id', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'kb-label', label: { id: 'l1', name: '\u0007\u202e ', color: 'red' }, src: 'cv-a' })
    t.cast(1, 'p1', { op: 'kb-label', label: { id: '', name: 'Bug', color: 'red' }, src: 'cv-a' })
    expect(t.sent).toEqual([])
  })

  it('reflects a kb-label whose name carried control / bidi characters with them stripped', () => {
    t.setClients([1])
    t.cast(1, 'p1', { op: 'kb-label', label: { id: 'l1', name: 'a\u0007b\u202e', color: 'red' }, src: 'cv-a' })
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'kb-label', label: { id: 'l1', name: 'ab', color: 'red' }, src: 'cv-a', seq: 1 }] }
    ])
  })

  it('reflects a valid kb-label to every client, stamped with the total order', () => {
    t.setClients([1, 2])
    const m = { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'red' }, src: 'cv-a', seen: 0 }
    t.cast(1, 'p1', m)
    const stamped = { ...m, seq: 1 }
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', stamped] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', stamped] }
    ])
  })

  it('reflects the REPAIRED op: a label colour off the palette becomes default, src/seen kept', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'kb-label', label: { id: 'l1', name: ' Bug ', color: 'neon', junk: 'x' }, src: 'cv-a', seen: 0 })
    const repaired = { op: 'kb-label', label: { id: 'l1', name: 'Bug', color: 'default' }, src: 'cv-a', seen: 0, seq: 1 }
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', repaired] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', repaired] }
    ])
  })

  it('the core\'s own publish path reflects the repaired op too', () => {
    t.setClients([1])
    const ok = publishCanvasMutation('p1', {
      op: 'kb-card',
      assignment: { nodeId: 'n1', columnId: 'c1', rank: '!!' }
    } as CanvasMutation)
    expect(ok).toBe(true)
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'kb-card', assignment: { nodeId: 'n1', columnId: 'c1' }, seq: 1 }] }
    ])
  })

  it('the core\'s own publish path refuses what the reflector refuses', () => {
    t.setClients([1])
    expect(publishCanvasMutation('p1', { op: 'kb-card-remove', nodeId: '' } as CanvasMutation)).toBe(false)
    expect(t.sent).toEqual([])
  })
})

describe('setReflectedListener (the Server Edition canvas authority hears the total order)', () => {
  // The authority (core/canvas-authority.ts) applies ops in the reflector's order and must see each
  // one synchronously, right after its stamp: its own published diff echoes back through here while
  // it is still publishing, and a later op for the same key must never overtake an earlier one.
  it('sees every reflected op of BOTH ingest paths, in seq order, with its seq', () => {
    t.setClients([1])
    const heard: Array<[string, CanvasMutation]> = []
    setReflectedListener((projectId, m) => heard.push([projectId, m]))
    t.cast(1, 'p1', { op: 'upsert', node: node('a', 1), src: 'c1' })
    expect(publishCanvasMutation('p2', { op: 'remove', id: 'b' })).toBe(true)
    t.cast(1, 'p1', { op: 'edge-upsert', kind: 'bridge', edge: { id: 'e1', source: 'a', target: 'b' } })
    expect(heard.map(([p, m]) => [p, m.op, m.seq])).toEqual([
      ['p1', 'upsert', 1],
      ['p2', 'remove', 2],
      ['p1', 'edge-upsert', 3]
    ])
    // What it hears is exactly what the clients were sent.
    expect(heard.map(([, m]) => m)).toEqual(t.sent.map((s) => s.args[1]))
  })

  it('is called synchronously, before the ingest returns', () => {
    t.setClients([1])
    let heard = 0
    setReflectedListener(() => heard++)
    publishCanvasMutation('p1', { op: 'remove', id: 'a' })
    expect(heard).toBe(1)
    t.cast(1, 'p1', { op: 'remove', id: 'b' })
    expect(heard).toBe(2)
  })

  it('hears nothing for a refused op, on either path', () => {
    t.setClients([1])
    const heard: CanvasMutation[] = []
    setReflectedListener((_p, m) => heard.push(m))
    t.cast(1, 'p1', { op: 'upsert', node: { id: 'bad' } })
    t.cast(1, '', { op: 'remove', id: 'a' })
    expect(publishCanvasMutation('p1', { op: 'kb-card-remove', nodeId: '' } as CanvasMutation)).toBe(false)
    expect(publishCanvasMutation('', { op: 'remove', id: 'a' })).toBe(false)
    expect(heard).toEqual([])
  })

  it('hears ops even with no client attached (a headless core still persists them)', () => {
    const heard: CanvasMutation[] = []
    setReflectedListener((_p, m) => heard.push(m))
    expect(publishCanvasMutation('p1', { op: 'remove', id: 'a' })).toBe(true)
    expect(heard).toHaveLength(1)
  })

  it('a throwing listener never stops the fan-out', () => {
    t.setClients([1, 2])
    setReflectedListener(() => {
      throw new Error('boom')
    })
    t.cast(1, 'p1', { op: 'remove', id: 'a' })
    expect(t.sent.map((s) => s.to)).toEqual([1, 2])
  })

  it('null detaches it, and a re-init of the reflector does not', () => {
    t.setClients([1])
    const heard: CanvasMutation[] = []
    setReflectedListener((_p, m) => heard.push(m))
    resetPlatformForTests()
    const again = testPlatform()
    initPlatform(again.p)
    initCanvasSync()
    again.setClients([1])
    again.cast(1, 'p1', { op: 'remove', id: 'a' })
    expect(heard).toHaveLength(1)
    setReflectedListener(null)
    again.cast(1, 'p1', { op: 'remove', id: 'b' })
    expect(heard).toHaveLength(1)
  })
})
