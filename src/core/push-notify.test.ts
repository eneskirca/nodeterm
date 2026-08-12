import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  createPushNotify,
  createLiveUpdatePush,
  type PushNotifyDeps,
  type PushHostIdentity,
  type LiveUpdateDeps
} from './push-notify'
import {
  onInboxActionable,
  onNodeStateChange,
  onNodeNowChange,
  recordAgentEvent,
  recordRawToolEvent,
  initAgentStatusMirror,
  _resetForTest,
  type InboxEvent,
  type NodeStateChange,
  type NodeNowChange
} from './agent-status-mirror'
import { syntheticAnsweredEvent } from './agents/pending-approvals'

/** A generic manual event source standing in for the mirror subscribe seams. */
function emitter<T>(): { subscribe: (cb: (e: T) => void) => () => void; emit: (e: T) => void } {
  const cbs = new Set<(e: T) => void>()
  return {
    subscribe: (cb) => {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    emit: (e) => {
      for (const cb of cbs) cb(e)
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------

/** A manual actionable-event source standing in for `onInboxActionable`. */
function makeEmitter(): {
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  emit: (e: InboxEvent) => void
} {
  const cbs = new Set<(e: InboxEvent) => void>()
  return {
    subscribe: (cb) => {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    emit: (e) => {
      for (const cb of cbs) cb(e)
    }
  }
}

function iev(p: Partial<InboxEvent>): InboxEvent {
  return { id: 'id', ts: 1000, nodeId: 'n1', kind: 'approval', title: 'Approve write', ...p }
}

const IDENTITY: PushHostIdentity = {
  hostDeviceId: 'host-device-1',
  hostPublicKeyB64: 'PUBKEYB64==',
  hostLabel: 'niova',
  hasPairedPhone: true
}

let fetchMock: ReturnType<typeof vi.fn>
let clock: number

function baseDeps(over: Partial<PushNotifyDeps> = {}): PushNotifyDeps {
  return {
    subscribe: () => () => {},
    getHostIdentity: () => IDENTITY,
    mobilePushEnabled: () => true,
    mobilePushNeedsYou: () => true,
    mobilePushDone: () => true,
    isPackaged: () => true,
    getNodeTitle: () => undefined,
    env: {},
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => clock,
    batchWindowMs: 2000,
    throttleMs: 5000,
    ...over
  }
}

function bodyOf(callIndex = 0): {
  hostDeviceId: string
  hostPublicKeyB64: string
  hostLabel: string
  events: Array<Record<string, unknown>>
} {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
}

// ---- actionable-hook seam (via the REAL mirror) --------------------------------------------

describe('onInboxActionable seam (agent-status-mirror)', () => {
  let dir: string
  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-hook-'))
    initAgentStatusMirror(path.join(dir, 'agent-status.json'))
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function ev(p: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
    return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...p } as NormalizedAgentEvent
  }

  it('fires approval ONCE for a re-asserted identical prompt (dedup)', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    expect(seen.filter((e) => e.kind === 'approval')).toHaveLength(1)
    expect(seen[0].title).toBe('Approve write to /etc/hosts')
  })

  it('fires again when the ask genuinely changes', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to A' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to B' }))
    expect(seen.filter((e) => e.kind === 'approval')).toHaveLength(2)
  })

  it('fires done on the turn edge, once', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done', lastMessage: 'All set.' }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done' })) // no second edge
    const dones = seen.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0].detail).toBe('All set.')
  })

  it('a subscriber that throws never breaks production or siblings', () => {
    const seen: InboxEvent[] = []
    onInboxActionable(() => {
      throw new Error('boom')
    })
    onInboxActionable((e) => seen.push(e))
    expect(() => recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick one' }))).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('question')
  })
})

// ---- push-notify service -------------------------------------------------------------------

describe('createPushNotify', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches events landing in the window into ONE POST', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
    em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
    em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
    expect(fetchMock).not.toHaveBeenCalled() // still buffering
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf().events).toHaveLength(3)
    h.stop()
  })

  it('per-node throttle drops a second event for the same node inside the window', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a', title: 'first' }))
    em.emit(iev({ nodeId: 'a', title: 'second' })) // throttled (clock unchanged)
    await vi.advanceTimersByTimeAsync(2000)
    expect(bodyOf().events).toHaveLength(1)
    expect(bodyOf().events[0].title).toBe('first')
    // After the throttle window, the node can push again.
    clock = 5000
    em.emit(iev({ nodeId: 'a', title: 'third' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).events[0].title).toBe('third')
    h.stop()
  })

  it('caps at 10 events per POST and sends the remainder next', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    for (let i = 0; i < 12; i++) em.emit(iev({ nodeId: `n${i}`, title: `t${i}` }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(bodyOf(0).events).toHaveLength(10)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).events).toHaveLength(2)
    h.stop()
  })

  it('emits the contract payload shape (host identity + trimmed event fields)', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(
      iev({
        nodeId: 'node-9',
        agentId: 'claude',
        kind: 'approval',
        title: 'Approve write to /etc/hosts',
        detail: 'Edit needs sudo',
        ts: 1789,
        resolved: false,
        // Deterministic-approval ticket rides the mirror to the phone but MUST NOT ride the push
        // body (the phone re-reads the mirror before acting). See docs/hook-reply-approvals.md.
        pendingId: 'node-9-1789-42'
      })
    )
    await vi.advanceTimersByTimeAsync(2000)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.nodeterm.dev/v1/push/notify')
    expect(init.method).toBe('POST')
    const body = bodyOf()
    expect(body.hostDeviceId).toBe('host-device-1')
    expect(body.hostPublicKeyB64).toBe('PUBKEYB64==')
    expect(body.hostLabel).toBe('niova')
    expect(body.events[0]).toEqual({
      kind: 'approval',
      title: 'Approve write to /etc/hosts',
      detail: 'Edit needs sudo',
      nodeId: 'node-9',
      agentId: 'claude',
      ts: 1789
    })
    // The internal InboxEvent fields do not leak into the payload.
    expect(body.events[0]).not.toHaveProperty('id')
    expect(body.events[0]).not.toHaveProperty('resolved')
    expect(body.events[0]).not.toHaveProperty('pendingId')
    h.stop()
  })

  it('honors NODETERM_API_BASE override', async () => {
    const em = makeEmitter()
    const h = createPushNotify(
      baseDeps({ subscribe: em.subscribe, env: { NODETERM_API_BASE: 'http://localhost:9999' } })
    )
    em.emit(iev({ nodeId: 'a' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/push/notify')
    h.stop()
  })

  it('drops on network error without throwing (no retry queue)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a' }))
    // The rejected fetch must not surface — flush swallows it (no retry queue).
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    h.stop()
  })

  describe('inert gates (no POST)', () => {
    async function expectNoPost(over: Partial<PushNotifyDeps>): Promise<void> {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, ...over }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    }

    it('setting off', async () => {
      await expectNoPost({ mobilePushEnabled: () => false })
    })
    it('no relay host identity', async () => {
      await expectNoPost({ getHostIdentity: () => null })
    })
    it('no paired phone', async () => {
      await expectNoPost({ getHostIdentity: () => ({ ...IDENTITY, hasPairedPhone: false }) })
    })
    it('DO_NOT_TRACK', async () => {
      await expectNoPost({ env: { DO_NOT_TRACK: '1' } })
    })
    it('NODETERM_TELEMETRY_DISABLED', async () => {
      await expectNoPost({ env: { NODETERM_TELEMETRY_DISABLED: '1' } })
    })
    it('unpackaged without a local API base', async () => {
      await expectNoPost({ isPackaged: () => false, env: {} })
    })
  })

  describe('per-kind selection', () => {
    it('defaults send all kinds (needsYou + done both on)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['approval', 'question', 'done'])
      h.stop()
    })

    it('needsYou off drops approval + question but done still sends', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, mobilePushNeedsYou: () => false })
      )
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['done'])
      h.stop()
    })

    it('done off drops done but needs-you kinds still send', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, mobilePushDone: () => false }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['approval', 'question'])
      h.stop()
    })

    it('both sub-gates off sends nothing (master stays honest)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          mobilePushNeedsYou: () => false,
          mobilePushDone: () => false
        })
      )
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    })

    it('a dropped kind does not consume the node throttle window', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, mobilePushNeedsYou: () => false })
      )
      // A dropped approval on node 'a' must not throttle a following done on 'a'.
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'dropped' }))
      em.emit(iev({ nodeId: 'a', kind: 'done', title: 'kept' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events).toHaveLength(1)
      expect(bodyOf().events[0].title).toBe('kept')
      h.stop()
    })
  })

  describe('nodeTitle enrichment', () => {
    it('includes nodeTitle when the accessor resolves one', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, getNodeTitle: (id) => (id === 'a' ? 'Backend server' : undefined) })
      )
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].nodeTitle).toBe('Backend server')
      h.stop()
    })

    it('omits nodeTitle when the accessor returns undefined', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: () => undefined }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })

    it('omits nodeTitle when no accessor is wired at all', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: undefined }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })

    it('clips nodeTitle to 80 chars', async () => {
      const em = makeEmitter()
      const long = 'x'.repeat(200)
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: () => long }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].nodeTitle).toBe('x'.repeat(80))
      h.stop()
    })

    it('omits nodeTitle when the accessor throws (fail-open)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          getNodeTitle: () => {
            throw new Error('boom')
          }
        })
      )
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })
  })

  describe('question options pass-through', () => {
    it('passes question options into the notify payload', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'question', title: 'Pick a theme', options: ['Dark', 'Light', 'System'] }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].options).toEqual(['Dark', 'Light', 'System'])
      h.stop()
    })

    it('omits options when the event has none', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'Approve' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('options')
      h.stop()
    })

    it('passes multiSelect through when the question is multi-select', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'question', title: 'Pick', options: ['A', 'B'], multiSelect: true }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].multiSelect).toBe(true)
      expect(bodyOf().events[0].options).toEqual(['A', 'B'])
      h.stop()
    })

    it('omits multiSelect when absent or false', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'question', title: 'Pick', options: ['A'], multiSelect: false }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'Pick', options: ['A'] }))
      await vi.advanceTimersByTimeAsync(2000)
      for (const e of bodyOf().events) expect(e).not.toHaveProperty('multiSelect')
      h.stop()
    })
  })

  describe('granted mode (SSH-possession push grants)', () => {
    const GRANTS = [
      { deviceId: 'dev-A', grant: 'tok-A', connectionId: 'conn-A' },
      { deviceId: 'dev-B', grant: 'tok-B' }
    ]

    function grantDeps(over: Partial<PushNotifyDeps> = {}): PushNotifyDeps {
      return baseDeps({
        getHostIdentity: () => null, // no relay identity → granted mode
        getGrants: () => GRANTS,
        hostLabel: () => 'niova',
        ...over
      })
    }

    it('fans one POST out per grant: Bearer auth + hostLabel, and NO host identity fields', async () => {
      const em = makeEmitter()
      const h = createPushNotify(grantDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const calls = fetchMock.mock.calls
      expect(calls.map((c) => c[1].headers.authorization)).toEqual(['Bearer tok-A', 'Bearer tok-B'])
      for (const c of calls) {
        expect(c[0]).toBe('https://api.nodeterm.dev/v1/push/notify')
        const body = JSON.parse(c[1].body)
        expect(body.hostLabel).toBe('niova')
        expect(body).not.toHaveProperty('hostDeviceId')
        expect(body).not.toHaveProperty('hostPublicKeyB64')
        expect(body.events).toHaveLength(1)
        expect(body.events[0].title).toBe('A')
      }
      h.stop()
    })

    it('marks a grant dead on a 401/403 (only the failing one)', async () => {
      const dead: string[] = []
      // tok-A → 403, tok-B → 200 (keyed on the Bearer header).
      fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => ({
        status: init.headers.authorization === 'Bearer tok-A' ? 403 : 200
      }))
      const em = makeEmitter()
      const h = createPushNotify(grantDeps({ subscribe: em.subscribe, markGrantDead: (g) => dead.push(g) }))
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(dead).toEqual(['tok-A'])
      h.stop()
    })

    it('only POSTs the grants getGrants currently returns (a dead grant is dropped)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(grantDeps({ subscribe: em.subscribe, getGrants: () => [GRANTS[1]] }))
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer tok-B')
      h.stop()
    })

    it('is inert when no host identity AND no grants', async () => {
      const em = makeEmitter()
      const h = createPushNotify(grantDeps({ subscribe: em.subscribe, getGrants: () => [] }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    })

    it('honors the master + sub-gates in granted mode', async () => {
      const em = makeEmitter()
      const h = createPushNotify(grantDeps({ subscribe: em.subscribe, mobilePushEnabled: () => false }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    })

    it('a paired host identity WINS: grants are never consulted (no double-push)', async () => {
      const getGrants = vi.fn(() => GRANTS)
      const em = makeEmitter()
      // getHostIdentity defaults to the paired IDENTITY via baseDeps.
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getGrants, hostLabel: () => 'niova' }))
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = bodyOf()
      expect(body.hostDeviceId).toBe('host-device-1')
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined()
      expect(getGrants).not.toHaveBeenCalled()
      h.stop()
    })
  })

  describe('single-sender matrix (granted vs host)', () => {
    // paired → host only, and neither → inert, are covered in the granted-mode block above. This
    // pins the third leg: an UNPAIRED host identity (identity present, no phone pinned) must fall
    // THROUGH to granted mode — the desktop granted-mode fallback (spec: 2026-07-21-push-grants).
    it('unpaired host identity + grants → GRANTED mode only (host fields absent)', async () => {
      const em = makeEmitter()
      const getGrants = vi.fn(() => [{ deviceId: 'd', grant: 'tok-X' }])
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          getHostIdentity: () => ({ ...IDENTITY, hasPairedPhone: false }),
          getGrants,
          hostLabel: () => 'niova'
        })
      )
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body).not.toHaveProperty('hostDeviceId')
      expect(body).not.toHaveProperty('hostPublicKeyB64')
      expect(body.hostLabel).toBe('niova')
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer tok-X')
      expect(getGrants).toHaveBeenCalled()
      h.stop()
    })
  })

  describe('presence-aware alert deferral', () => {
    /** A manual present→away poke standing in for the desktop's powerMonitor edge detector. */
    function presenceEmitter(): { subscribe: (cb: () => void) => () => void; away: () => void } {
      let cb: (() => void) | null = null
      return {
        subscribe: (fn) => {
          cb = fn
          return () => {
            cb = null
          }
        },
        away: () => cb?.()
      }
    }

    it('HOLDS alerts while the user is present, releasing them on the away edge', async () => {
      const em = makeEmitter()
      const pres = presenceEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, isUserPresent: () => true, subscribePresence: pres.subscribe })
      )
      em.emit(iev({ nodeId: 'a', id: 'e1', title: 'A' }))
      em.emit(iev({ nodeId: 'b', id: 'e2', title: 'B' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled() // held while present
      pres.away()
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.title)).toEqual(['A', 'B'])
      h.stop()
    })

    it('on the away flush, DROPS held events resolved in the mirror and sends the rest', async () => {
      const em = makeEmitter()
      const pres = presenceEmitter()
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          isUserPresent: () => true,
          subscribePresence: pres.subscribe,
          // e2 got resolved (answered / read) while held → dropped; e1 still unresolved → sent.
          isEventUnresolved: (_nodeId, eventId) => eventId !== 'e2'
        })
      )
      em.emit(iev({ nodeId: 'a', id: 'e1', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', id: 'e2', kind: 'done', title: 'B' }))
      pres.away()
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.title)).toEqual(['A'])
      h.stop()
    })

    it('presence OFF (isUserPresent false) sends immediately — no hold', async () => {
      const em = makeEmitter()
      const pres = presenceEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, isUserPresent: () => false, subscribePresence: pres.subscribe })
      )
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events[0].title).toBe('A')
      h.stop()
    })

    it('no presence deps at all = exact legacy behavior (immediate send)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      h.stop()
    })

    it('bounds the hold queue, dropping the OLDEST past the cap of 50', async () => {
      const em = makeEmitter()
      const pres = presenceEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, isUserPresent: () => true, subscribePresence: pres.subscribe })
      )
      // 60 events on distinct nodes (so the per-node throttle never interferes). Cap 50 → oldest 10
      // (t0..t9) drop.
      for (let i = 0; i < 60; i++) em.emit(iev({ nodeId: `n${i}`, id: `e${i}`, title: `t${i}` }))
      pres.away()
      // 50 survivors flush 10/POST across sequential batch windows.
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000)
      const titles = fetchMock.mock.calls.flatMap((c) =>
        JSON.parse(c[1].body).events.map((e: { title: string }) => e.title)
      )
      expect(titles).toHaveLength(50)
      expect(titles).toContain('t59') // newest kept
      expect(titles).not.toContain('t0') // oldest dropped
      h.stop()
    })

    it('stop() clears the hold queue (a later away edge sends nothing)', async () => {
      const em = makeEmitter()
      const pres = presenceEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, isUserPresent: () => true, subscribePresence: pres.subscribe })
      )
      em.emit(iev({ nodeId: 'a', title: 'A' }))
      h.stop()
      pres.away()
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it('stop() unsubscribes so later events are ignored', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    h.stop()
    em.emit(iev({ nodeId: 'a' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ---- live-update stream --------------------------------------------------------------------

describe('createLiveUpdatePush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function liveDeps(over: Partial<LiveUpdateDeps> = {}): LiveUpdateDeps {
    return {
      subscribeStateChange: () => () => {},
      subscribeNowChange: () => () => {},
      getHostIdentity: () => IDENTITY,
      mobilePushEnabled: () => true,
      mobileLiveActivities: () => true,
      isPackaged: () => true,
      getNodeTitle: () => undefined,
      env: {},
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      batchWindowMs: 1000,
      coalesceMs: 20000,
      ...over
    }
  }

  function liveBodyOf(callIndex = 0): {
    hostDeviceId: string
    hostPublicKeyB64: string
    hostLabel: string
    updates: Array<Record<string, unknown>>
  } {
    return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
  }

  function wire(over: Partial<LiveUpdateDeps> = {}): {
    h: ReturnType<typeof createLiveUpdatePush>
    st: ReturnType<typeof emitter<NodeStateChange>>
    nw: ReturnType<typeof emitter<NodeNowChange>>
  } {
    const st = emitter<NodeStateChange>()
    const nw = emitter<NodeNowChange>()
    const h = createLiveUpdatePush(
      liveDeps({ subscribeStateChange: st.subscribe, subscribeNowChange: nw.subscribe, ...over })
    )
    return { h, st, nw }
  }

  it('posts a state edge within the batch window (immediate)', async () => {
    const { h, st } = wire()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    expect(fetchMock).not.toHaveBeenCalled() // still batching
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.nodeterm.dev/v1/push/live-update')
    expect(init.method).toBe('POST')
    expect(liveBodyOf().updates[0]).toMatchObject({ nodeId: 'a', event: 'start', state: 'working' })
    h.stop()
  })

  it('emits the contract payload shape (host identity + trimmed update fields)', async () => {
    const { h, st } = wire({ getNodeTitle: () => 'api-server' })
    st.emit({ nodeId: 'node-1', agentId: 'claude', event: 'update', state: 'needsYou', message: 'Approve write', ts: 42 })
    await vi.advanceTimersByTimeAsync(1000)
    const body = liveBodyOf()
    expect(body.hostDeviceId).toBe('host-device-1')
    expect(body.hostPublicKeyB64).toBe('PUBKEYB64==')
    expect(body.hostLabel).toBe('niova')
    expect(body.updates[0]).toEqual({
      nodeId: 'node-1',
      nodeTitle: 'api-server',
      agentId: 'claude',
      event: 'update',
      state: 'needsYou',
      // A state edge (here the needsYou edge) is marked so the backend can prioritize it (10 vs 5).
      edge: true,
      message: 'Approve write',
      ts: 42
    })
    h.stop()
  })

  it('sends a now-update immediately on the leading edge, then COALESCES ticks to ≥20s/node', async () => {
    const { h, nw } = wire()
    // Leading edge (no prior send) → sent.
    clock = 0
    nw.emit({ nodeId: 'a', activity: 'Editing a.ts', contextPercent: 10, ts: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(liveBodyOf(0).updates[0]).toMatchObject({
      event: 'update',
      state: 'working',
      activity: 'Editing a.ts',
      contextPercent: 10
    })
    // A second tick 5s later is inside the 20s window → coalesced (NOT sent yet).
    clock = 5000
    nw.emit({ nodeId: 'a', activity: 'Editing b.ts', ts: 5000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // At the window edge the coalesced LATEST flushes.
    clock = 20000
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates[0].activity).toBe('Editing b.ts')
    h.stop()
  })

  // A now-tick carries no state of its own, so it used to hardcode `state: 'working'` — and it can
  // sit parked for the whole coalesce window. Two producers fire one at exactly the wrong moment
  // (the raw Stop hook clears the activity; the context tail's 1 s poll lands the turn's final
  // usage record), so a tick would land AFTER the end and flip the island back to Working, with no
  // further edge left to end it.
  describe('a coalesced tick can never resurrect a finished session', () => {
    it('drops a PARKED tick when the state edge that supersedes it goes out', async () => {
      const { h, st, nw } = wire()
      clock = 0
      nw.emit({ nodeId: 'a', activity: 'Editing a.ts', ts: 0 }) // leading edge → sent
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // A tick parked inside the window…
      clock = 5000
      nw.emit({ nodeId: 'a', activity: 'Editing b.ts', ts: 5000 })
      // …then the turn ends.
      st.emit({ nodeId: 'a', event: 'end', state: 'done', ts: 6000 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(liveBodyOf(1).updates[0]).toMatchObject({ event: 'end', state: 'done' })
      // Past the coalesce window: the parked tick must NOT flush behind the end.
      clock = 30000
      await vi.advanceTimersByTimeAsync(30000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      h.stop()
    })

    it('drops a tick that arrives AFTER the end (the 1 s context tail lands late)', async () => {
      const { h, st, nw } = wire()
      clock = 0
      st.emit({ nodeId: 'a', event: 'end', state: 'done', ts: 0 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      clock = 2000
      nw.emit({ nodeId: 'a', activity: 'Editing late.ts', contextPercent: 42, ts: 2000 })
      await vi.advanceTimersByTimeAsync(30000)
      expect(fetchMock).toHaveBeenCalledTimes(1) // nothing followed the end
      h.stop()
    })

    it('also refuses a tick once the node is NEEDS-YOU (it would drop the buttons)', async () => {
      const { h, st, nw } = wire()
      clock = 0
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'approval',
        pendingId: 'p1',
        ts: 0
      } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      clock = 2000
      nw.emit({ nodeId: 'a', activity: 'Running tests', ts: 2000 })
      await vi.advanceTimersByTimeAsync(30000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      h.stop()
    })

    it('a working node keeps ticking, and a re-entry into working resumes them', async () => {
      const { h, st, nw } = wire()
      clock = 0
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 0 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      // Still working → the tick goes out as before.
      clock = 2000
      nw.emit({ nodeId: 'a', activity: 'Editing a.ts', ts: 2000 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(liveBodyOf(1).updates[0]).toMatchObject({ state: 'working', activity: 'Editing a.ts' })
      // needsYou silences ticks…
      clock = 30000
      st.emit({ nodeId: 'a', event: 'update', state: 'needsYou', ts: 30000 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      // …and answering it (back to working) lets them through again.
      clock = 60000
      st.emit({ nodeId: 'a', event: 'update', state: 'working', ts: 60000 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      clock = 90000
      nw.emit({ nodeId: 'a', activity: 'Editing c.ts', ts: 90000 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(5)
      expect(liveBodyOf(4).updates[0]).toMatchObject({ state: 'working', activity: 'Editing c.ts' })
      h.stop()
    })

    it('a node we have seen no edge for still ticks (unchanged pre-edge behaviour)', async () => {
      const { h, nw } = wire()
      clock = 0
      nw.emit({ nodeId: 'never-edged', activity: 'Editing a.ts', ts: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(liveBodyOf(0).updates[0]).toMatchObject({ state: 'working' })
      h.stop()
    })
  })

  it('a state edge is NOT subject to the now-coalesce window', async () => {
    const { h, st, nw } = wire()
    clock = 0
    nw.emit({ nodeId: 'a', activity: 'x', ts: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A state edge on the same node 2s later still posts immediately (no 20s wait).
    clock = 2000
    st.emit({ nodeId: 'a', event: 'end', state: 'done', message: 'Finished', ts: 2000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates[0]).toMatchObject({ event: 'end', state: 'done' })
    h.stop()
  })

  it('caps at 20 updates per POST and sends the remainder next', async () => {
    const { h, st } = wire()
    for (let i = 0; i < 25; i++) st.emit({ nodeId: `n${i}`, event: 'start', state: 'working', ts: i })
    await vi.advanceTimersByTimeAsync(1000)
    expect(liveBodyOf(0).updates).toHaveLength(20)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates).toHaveLength(5)
    h.stop()
  })

  it('honors NODETERM_API_BASE override', async () => {
    const { h, st } = wire({ env: { NODETERM_API_BASE: 'http://localhost:9999' } })
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/push/live-update')
    h.stop()
  })

  it('drops on network error without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { h, st } = wire()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    h.stop()
  })

  describe('inert gates (no POST)', () => {
    async function expectNoPost(over: Partial<LiveUpdateDeps>): Promise<void> {
      const { h, st, nw } = wire(over)
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      nw.emit({ nodeId: 'a', activity: 'x', ts: 1 })
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    }

    it('master switch off', async () => {
      await expectNoPost({ mobilePushEnabled: () => false })
    })
    it('live-activities sub-gate off', async () => {
      await expectNoPost({ mobileLiveActivities: () => false })
    })
    it('no relay host identity', async () => {
      await expectNoPost({ getHostIdentity: () => null })
    })
    it('no paired phone', async () => {
      await expectNoPost({ getHostIdentity: () => ({ ...IDENTITY, hasPairedPhone: false }) })
    })
    it('DO_NOT_TRACK', async () => {
      await expectNoPost({ env: { DO_NOT_TRACK: '1' } })
    })
    it('unpackaged without a local API base', async () => {
      await expectNoPost({ isPackaged: () => false, env: {} })
    })
  })

  describe('needsYou kind/options/pendingId pass-through (interactive Dynamic Island)', () => {
    it('passes kind + pendingId on an approval needsYou edge', async () => {
      const { h, st } = wire()
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'approval',
        message: 'Approve write',
        pendingId: 'a-123-9',
        ts: 1
      })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u.kind).toBe('approval')
      expect(u.pendingId).toBe('a-123-9')
      expect(u).not.toHaveProperty('options')
      h.stop()
    })

    it('passes kind + options on a question needsYou edge', async () => {
      const { h, st } = wire()
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'question',
        message: 'Pick a theme',
        options: ['Dark', 'Light', 'System'],
        ts: 1
      })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u.kind).toBe('question')
      expect(u.options).toEqual(['Dark', 'Light', 'System'])
      expect(u).not.toHaveProperty('pendingId')
      h.stop()
    })

    it('omits kind/options/pendingId on working and done edges', async () => {
      const { h, st } = wire()
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      st.emit({ nodeId: 'b', event: 'end', state: 'done', message: 'Finished', ts: 2 })
      await vi.advanceTimersByTimeAsync(1000)
      for (const u of liveBodyOf().updates) {
        expect(u).not.toHaveProperty('kind')
        expect(u).not.toHaveProperty('options')
        expect(u).not.toHaveProperty('pendingId')
      }
      h.stop()
    })

    it('now-update (activity/context) ticks never carry kind/options/pendingId', async () => {
      const { h, nw } = wire()
      clock = 0
      nw.emit({ nodeId: 'a', activity: 'Editing a.ts', contextPercent: 10, ts: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u).not.toHaveProperty('kind')
      expect(u).not.toHaveProperty('options')
      expect(u).not.toHaveProperty('pendingId')
      h.stop()
    })

    it('passes multiSelect on a question needsYou edge; omits it when absent', async () => {
      const { h, st } = wire()
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'question',
        options: ['A', 'B'],
        multiSelect: true,
        ts: 1
      })
      st.emit({ nodeId: 'b', event: 'update', state: 'needsYou', kind: 'question', options: ['A'], ts: 2 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(liveBodyOf().updates[0].multiSelect).toBe(true)
      expect(liveBodyOf().updates[1]).not.toHaveProperty('multiSelect')
      h.stop()
    })

    it('never carries multiSelect on a working/done edge even if the change object has it', async () => {
      const { h, st } = wire()
      // Belt-and-braces: a non-needsYou change with a stray multiSelect must not leak it.
      st.emit({ nodeId: 'a', event: 'start', state: 'working', multiSelect: true, ts: 1 } as NodeStateChange)
      await vi.advanceTimersByTimeAsync(1000)
      expect(liveBodyOf().updates[0]).not.toHaveProperty('multiSelect')
      h.stop()
    })
  })

  describe('state-edge marking (edge flag)', () => {
    it('marks every state edge (start/needsYou/end) with edge:true', async () => {
      const { h, st } = wire()
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      st.emit({ nodeId: 'b', event: 'update', state: 'needsYou', message: 'Approve', ts: 2 })
      st.emit({ nodeId: 'c', event: 'end', state: 'done', message: 'Finished', ts: 3 })
      await vi.advanceTimersByTimeAsync(1000)
      for (const u of liveBodyOf().updates) expect(u.edge).toBe(true)
      h.stop()
    })

    it('never marks a now-tick (activity/context) with edge', async () => {
      const { h, nw } = wire()
      clock = 0
      nw.emit({ nodeId: 'a', activity: 'Editing a.ts', contextPercent: 10, ts: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(liveBodyOf().updates[0]).not.toHaveProperty('edge')
      h.stop()
    })

    // Wire the live-update push to the REAL mirror seams so the synthetic answered blocked→working
    // transition (built exactly as the held hook's second POST) is exercised end-to-end.
    describe('via the real mirror', () => {
      let dir: string
      beforeEach(() => {
        _resetForTest()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-edge-'))
        initAgentStatusMirror(path.join(dir, 'agent-status.json'))
      })
      afterEach(() => {
        _resetForTest()
        fs.rmSync(dir, { recursive: true, force: true })
      })

      function ev(p: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
        return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...p } as NormalizedAgentEvent
      }

      it('the answered blocked→working synthetic transition flows through onNodeStateChange as an edge', async () => {
        const h = createLiveUpdatePush(
          liveDeps({ subscribeStateChange: onNodeStateChange, subscribeNowChange: onNodeNowChange })
        )
        recordAgentEvent(ev({ state: 'working', newTurn: true })) // start edge
        recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-1-1' })) // needsYou edge
        // The answered signal (allow) → synthetic working, i.e. a blocked→working state edge.
        recordAgentEvent(syntheticAnsweredEvent('n1', 'n1-1-1', 'allow')!)
        recordAgentEvent(ev({ state: 'done', lastMessage: 'Done' })) // end edge
        await vi.advanceTimersByTimeAsync(1000)
        const updates = liveBodyOf().updates
        // Four state edges, and every one is marked.
        expect(updates.map((u: Record<string, unknown>) => [u.event, u.state])).toEqual([
          ['start', 'working'],
          ['update', 'needsYou'],
          ['start', 'working'],
          ['end', 'done']
        ])
        for (const u of updates) expect(u.edge).toBe(true)
        h.stop()
      })

      it('activity ticks interleaved with edges stay unmarked while edges are marked', async () => {
        const h = createLiveUpdatePush(
          liveDeps({ subscribeStateChange: onNodeStateChange, subscribeNowChange: onNodeNowChange })
        )
        recordAgentEvent(ev({ state: 'working', newTurn: true })) // start edge
        recordRawToolEvent('n1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }) // now-tick
        await vi.advanceTimersByTimeAsync(1000)
        const updates = liveBodyOf().updates
        const start = updates.find((u: Record<string, unknown>) => u.event === 'start')!
        const tick = updates.find((u: Record<string, unknown>) => u.activity === 'Running ls')!
        expect(start.edge).toBe(true)
        expect(tick).not.toHaveProperty('edge')
        h.stop()
      })
    })
  })

  describe('granted mode (SSH-possession push grants)', () => {
    const GRANTS = [
      { deviceId: 'dev-A', grant: 'tok-A' },
      { deviceId: 'dev-B', grant: 'tok-B' }
    ]

    it('fans a state edge out per grant: Bearer auth + hostLabel, no host identity fields', async () => {
      const { h, st } = wire({ getHostIdentity: () => null, getGrants: () => GRANTS, hostLabel: () => 'niova' })
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const calls = fetchMock.mock.calls
      expect(calls.map((c) => c[1].headers.authorization)).toEqual(['Bearer tok-A', 'Bearer tok-B'])
      for (const c of calls) {
        expect(c[0]).toBe('https://api.nodeterm.dev/v1/push/live-update')
        const body = JSON.parse(c[1].body)
        expect(body.hostLabel).toBe('niova')
        expect(body).not.toHaveProperty('hostDeviceId')
        expect(body).not.toHaveProperty('hostPublicKeyB64')
        expect(body.updates[0]).toMatchObject({ nodeId: 'a', event: 'start', state: 'working', edge: true })
      }
      h.stop()
    })

    it('marks a grant dead on a 401/403', async () => {
      const dead: string[] = []
      fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => ({
        status: init.headers.authorization === 'Bearer tok-B' ? 401 : 200
      }))
      const { h, st } = wire({
        getHostIdentity: () => null,
        getGrants: () => GRANTS,
        hostLabel: () => 'niova',
        markGrantDead: (g) => dead.push(g)
      })
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(dead).toEqual(['tok-B'])
      h.stop()
    })

    it('a paired host identity WINS: grants are never consulted (no double-push)', async () => {
      const getGrants = vi.fn(() => GRANTS)
      const { h, st } = wire({ getGrants, hostLabel: () => 'niova' })
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(liveBodyOf().hostDeviceId).toBe('host-device-1')
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBeUndefined()
      expect(getGrants).not.toHaveBeenCalled()
      h.stop()
    })

    it('is inert when no host identity AND no grants', async () => {
      const { h, st } = wire({ getHostIdentity: () => null, getGrants: () => [] })
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    })
  })

  it('stop() unsubscribes both seams so later events are ignored', async () => {
    const { h, st, nw } = wire()
    h.stop()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    nw.emit({ nodeId: 'a', activity: 'x', ts: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


describe('live-update: the You: prompt line', () => {
  it('rides the working start edge only', async () => {
    const posts: any[] = []
    let emit: ((c: any) => void) | null = null
    const h = createLiveUpdatePush({
      subscribeStateChange: (cb) => {
        emit = cb
        return () => {}
      },
      subscribeNowChange: () => () => {},
      getHostIdentity: () => ({ hostDeviceId: 'h', hostToken: 't', hasPairedPhone: true }) as never,
      mobilePushEnabled: () => true,
      mobileLiveActivities: () => true,
      isPackaged: () => true,
      apiBase: 'https://example.invalid',
      fetchImpl: (async (_u: string, init: any) => {
        posts.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({}) } as never
      }) as never
    })
    emit!({ nodeId: 'n1', event: 'start', state: 'working', prompt: 'fix the login bug', ts: 1 })
    emit!({ nodeId: 'n1', event: 'end', state: 'done', prompt: 'should be dropped', ts: 2 })
    await h._flushNow()
    const items = posts.flatMap((p) => p.updates)
    expect(items.find((i: any) => i.state === 'working')?.prompt).toBe('fix the login bug')
    // An end edge never carries a stale You: line.
    expect(items.find((i: any) => i.state === 'done')?.prompt).toBeUndefined()
    h.stop()
  })
})
