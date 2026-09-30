// The one revoke primitive: unpin from exactly the named role stores, then run EVERY registered
// host killer — and report, never swallow, a leg that did not happen.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovedDevices } from './approved-devices-core'

const disks: Record<string, ApprovedDevices> = {}
const failUpdate = new Set<string>()
vi.mock('./approved-devices', () => {
  const mem = (role: string) => ({
    load: async () => (disks[role] ??= { pubkeys: [] }),
    save: async (s: ApprovedDevices) => { disks[role] = s },
    update: async (u: (s: ApprovedDevices) => ApprovedDevices) => {
      if (failUpdate.has(role)) throw Object.assign(new Error('fixture'), { code: 'EACCES' })
      disks[role] = u((disks[role] ??= { pubkeys: [] }))
    }
  })
  const stores: Record<string, ReturnType<typeof mem>> = { phone: mem('phone'), guest: mem('guest'), joinedHost: mem('joinedHost') }
  return { PIN_ROLES: ['phone', 'guest', 'joinedHost'], phonePins: stores.phone, pinStore: (r: string) => stores[r] }
})

import {
  killPeerSessions,
  registerPeerSessionKiller,
  revokeAllPhones,
  revokePeerKey
} from './peer-revoke'

const unregister: Array<() => void> = []
beforeEach(() => {
  for (const k of Object.keys(disks)) delete disks[k]
  failUpdate.clear()
  while (unregister.length) unregister.pop()!()
})

/** A fake host holding sessions by key; returns which keys it was told to cut. */
function fakeHost(surface: 'phone' | 'desktop', keys: string[]) {
  const live = new Set(keys)
  const cut: string[] = []
  unregister.push(
    registerPeerSessionKiller(surface, (match) => {
      for (const k of [...live]) if (match(k)) { live.delete(k); cut.push(k) }
    })
  )
  return { live, cut }
}

describe('revokePeerKey', () => {
  it('unpins from the named roles only, and cuts that key on EVERY surface', async () => {
    disks.phone = { pubkeys: ['k', 'other'] }
    disks.guest = { pubkeys: ['k'] }
    disks.joinedHost = { pubkeys: ['k'] }
    const standing = fakeHost('phone', ['k', 'other'])
    const team = fakeHost('desktop', ['k'])

    expect(await revokePeerKey('k', ['guest'])).toEqual({ persisted: true, killed: true })
    expect(disks.guest.pubkeys).toEqual([])
    expect(disks.phone.pubkeys).toEqual(['k', 'other'])
    expect(disks.joinedHost.pubkeys).toEqual(['k'])
    expect(standing.cut).toEqual(['k'])
    expect(team.cut).toEqual(['k'])
    expect([...standing.live]).toEqual(['other'])
  })

  it('a failed unpin still cuts the live session and reports persisted:false', async () => {
    failUpdate.add('phone')
    disks.guest = { pubkeys: ['k'] }
    const host = fakeHost('phone', ['k'])
    expect(await revokePeerKey('k', ['phone', 'guest'])).toEqual({ persisted: false, killed: true })
    expect(host.cut).toEqual(['k'])
    expect(disks.guest.pubkeys).toEqual([]) // the other stores are still attempted
  })

  it('one killer throwing does not spare the sessions the others hold, and reports killed:false', async () => {
    unregister.push(registerPeerSessionKiller('phone', () => { throw new Error('boom') }))
    const team = fakeHost('desktop', ['k'])
    expect(await revokePeerKey('k', ['phone'])).toEqual({ persisted: true, killed: false })
    expect(team.cut).toEqual(['k'])
  })
})

describe('revokeAllPhones (phone "Remove")', () => {
  it('clears every phone pin and cuts every phone session, leaving desktop peers and stores alone', async () => {
    disks.phone = { pubkeys: ['p1', 'p2'] }
    disks.guest = { pubkeys: ['g'] }
    const standing = fakeHost('phone', ['p1', 'never-pinned'])
    const team = fakeHost('desktop', ['g'])
    expect(await revokeAllPhones()).toEqual({ persisted: true, killed: true })
    expect(disks.phone.pubkeys).toEqual([])
    expect(disks.guest.pubkeys).toEqual(['g'])
    expect(standing.cut.sort()).toEqual(['never-pinned', 'p1'])
    expect(team.cut).toEqual([])
  })

  it('reports a pin store it could not write', async () => {
    failUpdate.add('phone')
    const standing = fakeHost('phone', ['p1'])
    expect(await revokeAllPhones()).toEqual({ persisted: false, killed: true })
    expect(standing.cut).toEqual(['p1'])
  })
})

describe('killPeerSessions', () => {
  it('filters by surface', () => {
    const a = fakeHost('phone', ['x'])
    const b = fakeHost('desktop', ['x'])
    killPeerSessions(() => true, ['desktop'])
    expect(a.cut).toEqual([])
    expect(b.cut).toEqual(['x'])
  })
})
