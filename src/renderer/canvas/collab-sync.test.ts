import { describe, it, expect, beforeEach } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import {
  createSession,
  setActiveSession,
  bindProjectToSession,
  sessionForProject,
  resetSessionsForTest,
} from '../session/session'
import { canvasSyncTarget, EVERY_PROJECT, followGoverned, NO_PROJECTS, provesPeer, shouldPublish } from './collab-sync'

const localApi = { marker: 'local' } as unknown as NodeTerminalApi
const relayApi = { marker: 'relay' } as unknown as NodeTerminalApi

describe('canvasSyncTarget (Task 4 — publisher/onMutation follow the ACTIVE session)', () => {
  beforeEach(() => resetSessionsForTest())

  it('relay tab: the mutate/subscribe target is the RELAY api, and the gate arms when the relay presence has a peer', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    const relay = createSession('relay', relayApi, "Ayşe's Mac")
    bindProjectToSession('remote-tab', relay.id)

    // The active tab is the relay one → publisher/onMutation must hit the RELAY core, not local.
    const active = sessionForProject('remote-tab')

    // A teammate is attached on the relay presence (peers includes me + Ayşe) → publish.
    const withPeer = canvasSyncTarget(active, { peers: { me: {}, ayse: {} } })
    expect(withPeer.api).toBe(relayApi)
    expect(withPeer.api).not.toBe(localApi)
    expect(withPeer.hasPeers).toBe(true)

    // Solo on the relay (only my own row) → no publish, but the target api is unchanged.
    const solo = canvasSyncTarget(active, { peers: { me: {} } })
    expect(solo.api).toBe(relayApi)
    expect(solo.hasPeers).toBe(false)
  })

  it('local tab: the target is window.nodeTerminal (the local api) — byte-identical to today', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    createSession('relay', relayApi, "Ayşe's Mac") // registered but not the active tab's binding

    const active = sessionForProject('some-local-tab') // unbound → resolves local
    expect(canvasSyncTarget(active, { peers: { me: {} } }).api).toBe(localApi)
    expect(canvasSyncTarget(active, { peers: { me: {}, other: {} } }).hasPeers).toBe(true)
  })

  it('empty peer table → no peers (nothing published on a fresh, still-connecting session)', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    expect(canvasSyncTarget(local, { peers: {} }).hasPeers).toBe(false)
  })
})

describe('shouldPublish (the solo gate, and the canvas authority that overrides it)', () => {
  it('a governed project publishes even when nobody else is attached; neither = nothing is cast', () => {
    const governed = new Set(['p1'])
    expect(shouldPublish(false, governed, 'p1')).toBe(true)
    expect(shouldPublish(true, NO_PROJECTS, 'p1')).toBe(true)
    expect(shouldPublish(true, governed, 'p1')).toBe(true)
    expect(shouldPublish(false, governed, 'p2')).toBe(false)
    expect(shouldPublish(false, NO_PROJECTS, 'p1')).toBe(false)
    // While a core has not answered yet, every project on it counts as governed.
    expect(shouldPublish(false, EVERY_PROJECT, 'anything')).toBe(true)
  })

  it('asks for a peer first: the governed set is not consulted when a peer is attached', () => {
    let asked = 0
    const counting = { has: () => (asked++, false) }
    expect(shouldPublish(true, counting, 'p1')).toBe(true)
    expect(asked).toBe(0)
  })
})

describe('provesPeer (the sticky proof that someone else is attached)', () => {
  it('a mutation cast by ANOTHER client proves a peer; our own echo and a core-originated op do not', () => {
    expect(provesPeer({ src: 'cv-other' }, 'cv-me')).toBe(true)
    // Our own echo is our ack: a lone client that casts must not start publishing everything.
    expect(provesPeer({ src: 'cv-me' }, 'cv-me')).toBe(false)
    // No `src`: the core itself (the canvas authority's diff, server canvas control) — no client.
    expect(provesPeer({}, 'cv-me')).toBe(false)
    // Before this Canvas has a tag, any tagged op is someone else's.
    expect(provesPeer({ src: 'cv-other' }, null)).toBe(true)
  })
})

describe('followGoverned (the governed set Canvas gates on, per core)', () => {
  const authority = (assumeAllUntilAnswered = false, fail = false) => {
    const answers: Array<{ resolve: (ids: string[]) => void; reject: (e: Error) => void }> = []
    let listener: ((ids: string[]) => void) | null = null
    return {
      api: {
        canvasAuthority: {
          assumeAllUntilAnswered,
          governed: () =>
            new Promise<string[]>((resolve, reject) => {
              answers.push({ resolve, reject })
              if (fail) reject(new Error('E_NO_HANDLER'))
            }),
          onChanged: (l: (ids: string[]) => void) => {
            listener = l
            return () => (listener = null)
          }
        }
      } as unknown as Pick<NodeTerminalApi, 'canvasAuthority'>,
      answer: (i: number, ids: string[]) => answers[i].resolve(ids),
      asks: () => answers.length,
      change: (ids: string[]) => listener?.(ids),
      subscribed: () => listener !== null
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const as = (g: { has(id: string): boolean }): string =>
    g === EVERY_PROJECT ? '*' : [...(g as ReadonlySet<string>)].join(',')

  it('takes the core\'s answer, then every change', async () => {
    const a = authority()
    const seen: string[] = []
    followGoverned(a.api, (g) => seen.push(as(g)))
    a.answer(0, ['p1'])
    await flush()
    a.change(['p1', 'p2'])
    expect(seen).toEqual(['p1', 'p1,p2'])
  })

  it('a core that governs nothing in advance (desktop, Team Access) is NEVER treated as governing', async () => {
    const a = authority(false)
    const seen: string[] = []
    followGoverned(a.api, (g) => seen.push(as(g)))
    expect(seen).toEqual([])
    a.answer(0, [])
    await flush()
    expect(seen).toEqual([''])
  })

  it('a Server Edition core counts EVERY project as governed until it answers', async () => {
    const a = authority(true)
    const seen: string[] = []
    followGoverned(a.api, (g) => seen.push(as(g)))
    expect(seen).toEqual(['*'])
    a.answer(0, ['p1'])
    await flush()
    expect(seen).toEqual(['*', 'p1'])
  })

  it('a failed answer falls back to nothing governed', async () => {
    const a = authority(true, true)
    const seen: string[] = []
    followGoverned(a.api, (g) => seen.push(as(g)))
    await flush()
    expect(seen).toEqual(['*', ''])
  })

  it('a change that lands before an answer wins over that (older) answer', async () => {
    const a = authority()
    const seen: string[] = []
    followGoverned(a.api, (g) => seen.push(as(g)))
    a.change(['p2'])
    a.answer(0, ['p1'])
    await flush()
    expect(seen).toEqual(['p2'])
  })

  it('refresh (a reconnect) asks again, recovering a change missed while disconnected', async () => {
    const a = authority()
    const seen: string[] = []
    const f = followGoverned(a.api, (g) => seen.push(as(g)))
    a.answer(0, ['p1'])
    await flush()
    f.refresh()
    expect(a.asks()).toBe(2)
    a.answer(1, ['p1', 'p3'])
    await flush()
    expect(seen).toEqual(['p1', 'p1,p3'])
  })

  it('only the newest ask counts: an older answer arriving late is dropped', async () => {
    const a = authority()
    const seen: string[] = []
    const f = followGoverned(a.api, (g) => seen.push(as(g)))
    f.refresh()
    a.answer(1, ['new'])
    a.answer(0, ['old'])
    await flush()
    expect(seen).toEqual(['new'])
  })

  it('after release nothing more is applied, no ask is made, and the subscription is gone', async () => {
    const a = authority()
    const seen: string[] = []
    const f = followGoverned(a.api, (g) => seen.push(as(g)))
    f.release()
    f.refresh()
    expect(a.asks()).toBe(1)
    a.answer(0, ['p1'])
    await flush()
    expect(seen).toEqual([])
    expect(a.subscribed()).toBe(false)
  })
})
