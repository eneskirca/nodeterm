import { describe, it, expect, beforeEach } from 'vitest'
import { EMPTY_LINKS, liveChipSig, startWatchLinkSync, useWatchLinks, viewLinkThread } from './watchLinks'
import type { WatchChatMessage, WatchLinkNotice, WatchLinkView } from '@shared/watch-link-types'

const link = (id: string, nodeId: string, over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: id,
  nodeId,
  role: 'commenter',
  label: 'A',
  title: 't',
  createdAt: 0,
  expiresAt: 0,
  url: 'u',
  status: 'live',
  viewers: [],
  ...over
})
const msg = (id: string, from: 'viewer' | 'sharer' = 'viewer', at = 0): WatchChatMessage => ({
  id,
  name: from === 'viewer' ? 'V' : 'A',
  text: 'x',
  at,
  from
})

beforeEach(() => useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false }))

describe('watchLinks store', () => {
  it('indexes by node, in list order', () => {
    useWatchLinks.getState().setLinks([link('a', 'n1'), link('b', 'n1'), link('c', 'n2')])
    const s = useWatchLinks.getState()
    expect(s.byNode.n1.map((l) => l.linkId)).toEqual(['a', 'b'])
    expect(s.byNode.n2.map((l) => l.linkId)).toEqual(['c'])
    expect(s.byNode.n3).toBeUndefined()
  })

  it('keeps references for what did not change — a push for one node re-renders nothing else', () => {
    const s = useWatchLinks.getState()
    s.setLinks([link('a', 'n1'), link('c', 'n2')])
    const before = useWatchLinks.getState()
    // A fresh deserialized list (new objects, same content) except n2's link gained a viewer.
    s.setLinks([link('a', 'n1'), link('c', 'n2', { viewers: [{ viewerId: 'v', name: null, joinedAt: 1, waiting: false }] })])
    const after = useWatchLinks.getState()
    expect(after.byNode.n1).toBe(before.byNode.n1)
    expect(after.byNode.n1[0]).toBe(before.byNode.n1[0])
    expect(after.byNode.n2).not.toBe(before.byNode.n2)
    // A push identical in content changes nothing at all.
    s.setLinks([link('a', 'n1'), link('c', 'n2', { viewers: [{ viewerId: 'v', name: null, joinedAt: 1, waiting: false }] })])
    expect(useWatchLinks.getState()).toBe(after)
  })

  it('compares EVERY field: a change to any one of them is a new object (M2)', () => {
    // A fixture with every field of the type, iterated by key: a field added to WatchLinkView (and
    // to this fixture, which the type forces) is covered without editing the comparison.
    const base: WatchLinkView = link('a', 'n1', {
      viewers: [{ viewerId: 'v', name: 'Eve', joinedAt: 5, waiting: false }]
    })
    const bump = (v: unknown): unknown =>
      typeof v === 'number'
        ? v + 1
        : typeof v === 'string'
          ? `${v}x`
          : typeof v === 'boolean'
            ? !v
            : Array.isArray(v)
              ? []
              : v
    for (const key of Object.keys(base) as (keyof WatchLinkView)[]) {
      useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {}, hydrated: false })
      useWatchLinks.getState().setLinks([base])
      const before = useWatchLinks.getState().links[0]
      const changed = { ...base, [key]: bump(base[key]) } as WatchLinkView
      expect(changed[key], key).not.toEqual(base[key])
      useWatchLinks.getState().setLinks([changed])
      expect(useWatchLinks.getState().links[0], key).not.toBe(before)
    }
    // Every field of a viewer, the name included (a viewer who starts chatting gains a name).
    const viewer = base.viewers[0]
    for (const key of Object.keys(viewer) as (keyof typeof viewer)[]) {
      useWatchLinks.getState().setLinks([base])
      const before = useWatchLinks.getState().links[0]
      useWatchLinks.getState().setLinks([{ ...base, viewers: [{ ...viewer, [key]: bump(viewer[key]) }] }])
      expect(useWatchLinks.getState().links[0], `viewer.${key}`).not.toBe(before)
    }
    useWatchLinks.getState().setLinks([{ ...base, viewers: [{ ...viewer, name: null }] }])
    const unnamed = useWatchLinks.getState().links[0]
    useWatchLinks.getState().setLinks([base])
    expect(useWatchLinks.getState().links[0]).not.toBe(unnamed)
    // A field this build has never heard of is compared too.
    const known = useWatchLinks.getState().links[0]
    useWatchLinks.getState().setLinks([{ ...base, fromANewerCore: 1 } as WatchLinkView])
    expect(useWatchLinks.getState().links[0]).not.toBe(known)
  })

  it('counts unread viewer messages, not the sharer\'s own', () => {
    const s = useWatchLinks.getState()
    s.addChat('a', msg('1'))
    s.addChat('a', msg('2', 'sharer'))
    expect(useWatchLinks.getState().unread.a).toBe(1)
    useWatchLinks.getState().markRead('a')
    expect(useWatchLinks.getState().unread.a).toBe(0)
    // Marking a read link read again is not a store change.
    const st = useWatchLinks.getState()
    useWatchLinks.getState().markRead('a')
    expect(useWatchLinks.getState()).toBe(st)
  })

  it('a dropped link takes its chat and unread count with it (H21)', () => {
    const s = useWatchLinks.getState()
    s.setLinks([link('a', 'n1'), link('b', 'n1')])
    s.addChat('a', msg('1'))
    s.addChat('b', msg('2'))
    s.setLinks([link('b', 'n1')])
    const st = useWatchLinks.getState()
    expect(st.chats.a).toBeUndefined()
    expect(st.unread.a).toBeUndefined()
    expect(st.chats.b).toHaveLength(1)
    expect(st.unread.b).toBe(1)
  })

  it('a chat for a link the list no longer holds is dropped once a list has landed (N1)', () => {
    const s = useWatchLinks.getState()
    // Before any list: kept — it can only be for a link not listed yet.
    s.addChat('early', msg('0'))
    expect(useWatchLinks.getState().chats.early).toHaveLength(1)
    s.setLinks([link('a', 'n1')])
    expect(useWatchLinks.getState().chats.early).toBeUndefined()
    s.addChat('gone', msg('1'))
    s.setChat('gone', [msg('2')])
    expect(useWatchLinks.getState().chats.gone).toBeUndefined()
    expect(useWatchLinks.getState().unread.gone).toBeUndefined()
    s.addChat('a', msg('3'))
    expect(useWatchLinks.getState().chats.a).toHaveLength(1)
  })

  it('a message that lands while its thread is on screen never counts as unread (N2)', () => {
    const s = useWatchLinks.getState()
    s.setLinks([link('a', 'n1')])
    const seen: number[] = []
    const off = useWatchLinks.subscribe((st) => seen.push(st.unread.a ?? 0))
    const release = viewLinkThread('a')
    const release2 = viewLinkThread('a')
    s.addChat('a', msg('1'))
    release()
    s.addChat('a', msg('2')) // still on screen in the other mount
    expect(seen.every((n) => n === 0)).toBe(true)
    release2()
    release2() // idempotent
    s.addChat('a', msg('3'))
    expect(useWatchLinks.getState().unread.a).toBe(1)
    off()
  })

  it('a history answer never drops a message that arrived while it was in flight', () => {
    const s = useWatchLinks.getState()
    s.addChat('a', msg('3', 'viewer', 30)) // pushed after the history snapshot was taken
    s.setChat('a', [msg('1', 'viewer', 10), msg('2', 'sharer', 20)])
    expect(useWatchLinks.getState().chats.a.map((m) => m.id)).toEqual(['1', '2', '3'])
    // The same message twice (history + push) is kept once.
    s.setChat('a', [msg('1', 'viewer', 10), msg('2', 'sharer', 20), msg('3', 'viewer', 30)])
    expect(useWatchLinks.getState().chats.a.map((m) => m.id)).toEqual(['1', '2', '3'])
  })

  it('a push that lands after a history answer already holding it is not a second message', () => {
    const s = useWatchLinks.getState()
    s.setChat('a', [msg('1', 'viewer', 10)])
    s.addChat('a', msg('1', 'viewer', 10))
    expect(useWatchLinks.getState().chats.a).toHaveLength(1)
    expect(useWatchLinks.getState().unread.a ?? 0).toBe(0)
  })

  it('keeps the last 200 messages', () => {
    const s = useWatchLinks.getState()
    for (let i = 0; i < 205; i++) s.addChat('a', msg(String(i), 'viewer', i))
    const chat = useWatchLinks.getState().chats.a
    expect(chat).toHaveLength(200)
    expect(chat[0].id).toBe('5')
    expect(chat[199].id).toBe('204')
  })

  it('the chip signature changes with what the chip shows, and is empty without a link', () => {
    const s = useWatchLinks.getState()
    expect(liveChipSig(useWatchLinks.getState(), 'n1')).toBe('')
    s.setLinks([link('a', 'n1')])
    const one = liveChipSig(useWatchLinks.getState(), 'n1')
    expect(one).not.toBe('')
    s.addChat('a', msg('1'))
    expect(liveChipSig(useWatchLinks.getState(), 'n1')).not.toBe(one)
    // Another node's change does not move this node's signature.
    const mine = liveChipSig(useWatchLinks.getState(), 'n1')
    s.setLinks([link('a', 'n1'), link('z', 'n9', { status: 'refused' })])
    expect(liveChipSig(useWatchLinks.getState(), 'n1')).toBe(mine)
    expect(EMPTY_LINKS).toHaveLength(0)
  })
})

describe('startWatchLinkSync', () => {
  function fakeApi(list: () => Promise<WatchLinkView[]>) {
    const h: {
      state: ((l: WatchLinkView[]) => void) | null
      chat: ((id: string, m: WatchChatMessage) => void) | null
      notice: ((n: WatchLinkNotice) => void) | null
      unsubscribed: number
    } = { state: null, chat: null, notice: null, unsubscribed: 0 }
    const api = {
      watchLink: {
        list,
        onState: (cb: (l: WatchLinkView[]) => void) => {
          h.state = cb
          return () => h.unsubscribed++
        },
        onChat: (cb: (id: string, m: WatchChatMessage) => void) => {
          h.chat = cb
          return () => h.unsubscribed++
        },
        onNotice: (cb: (n: WatchLinkNotice) => void) => {
          h.notice = cb
          return () => h.unsubscribed++
        }
      }
    }
    return { api: api as never, h }
  }

  it('hydrates from list() and follows state, chat and notice events', async () => {
    const notices: WatchLinkNotice[] = []
    const { api, h } = fakeApi(async () => [link('a', 'n1')])
    const stop = startWatchLinkSync(api, (n) => notices.push(n))
    await Promise.resolve()
    await Promise.resolve()
    expect(useWatchLinks.getState().links).toHaveLength(1)
    h.chat!('a', msg('1'))
    expect(useWatchLinks.getState().chats.a).toHaveLength(1)
    h.state!([])
    expect(useWatchLinks.getState().links).toHaveLength(0)
    expect(useWatchLinks.getState().chats.a).toBeUndefined()
    h.notice!({ kind: 'not-persistent' })
    expect(notices).toEqual([{ kind: 'not-persistent' }])
    stop()
    expect(h.unsubscribed).toBe(3)
  })

  it('a list() answer that lands after a state push is ignored (H20)', async () => {
    let answer!: (l: WatchLinkView[]) => void
    const { api, h } = fakeApi(() => new Promise((r) => (answer = r)))
    const stop = startWatchLinkSync(api, () => {})
    // The newer state arrives first on its own channel: the link was stopped.
    h.state!([])
    // The slow list() then answers with the list from before the stop.
    answer([link('a', 'n1')])
    await Promise.resolve()
    await Promise.resolve()
    expect(useWatchLinks.getState().links).toHaveLength(0)
    stop()
  })

  it('nothing lands after stop, and a rejected list() is quiet', async () => {
    let answer!: (l: WatchLinkView[]) => void
    const { api } = fakeApi(() => new Promise((r) => (answer = r)))
    const stop = startWatchLinkSync(api, () => {})
    stop()
    answer([link('a', 'n1')])
    await Promise.resolve()
    await Promise.resolve()
    expect(useWatchLinks.getState().links).toHaveLength(0)
    const rejecting = fakeApi(() => Promise.reject(new Error('socket down')))
    const stop2 = startWatchLinkSync(rejecting.api, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(useWatchLinks.getState().links).toHaveLength(0)
    stop2()
  })
})
