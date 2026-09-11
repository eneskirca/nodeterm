import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests, platform } from './platform'
import { fakePlatform } from './platform-fake'
import {
  drainPendingRemoteKills,
  pendingRemoteKillsFor,
  readPendingRemoteKills,
  recordPendingRemoteKill,
  settlePendingRemoteKills,
  PENDING_REMOTE_KILL_MAX
} from './pending-remote-kills'

const HOST = 'deploy@h1.test'

describe('pending remote kills', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-prk-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })
  afterEach(async () => {
    resetPlatformForTests()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const file = (): string => path.join(platform().userDataDir, 'pending-remote-kills.json')

  it('records, reads back and settles by host', async () => {
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'not-connected', projectId: 'p1' })
    await recordPendingRemoteKill({ hostKey: 'root@h2.test', session: 'nt-b', reason: 'no-ssh' })

    expect((await pendingRemoteKillsFor(HOST)).map((e) => e.session)).toEqual(['nt-a'])
    await settlePendingRemoteKills(HOST, ['nt-a'])
    expect(await pendingRemoteKillsFor(HOST)).toEqual([])
    // The other host's debt is untouched — settling is scoped, not a wipe.
    expect((await readPendingRemoteKills()).map((e) => e.session)).toEqual(['nt-b'])
  })

  it('settling is scoped to ONE host even when two owe the SAME session name', async () => {
    // Not hypothetical: node ids live in the git-shared project file, so two hosts holding a
    // clone of the same canvas carry identical `nt-<id>` names. Settling by name alone would
    // forget a debt nobody paid, which is the silent leak this store exists to prevent.
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'not-connected' })
    await recordPendingRemoteKill({ hostKey: 'root@h2.test', session: 'nt-a', reason: 'not-connected' })
    // Recording is scoped the same way: the second host's debt must not have displaced the first.
    expect(await readPendingRemoteKills()).toHaveLength(2)

    await settlePendingRemoteKills(HOST, ['nt-a'])

    expect(await pendingRemoteKillsFor(HOST)).toEqual([])
    expect((await pendingRemoteKillsFor('root@h2.test')).map((e) => e.session)).toEqual(['nt-a'])
  })

  it('is idempotent per (host, session): a re-delete refreshes rather than stacks', async () => {
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'not-connected' })
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'delivery-failed' })
    const owed = await pendingRemoteKillsFor(HOST)
    expect(owed).toHaveLength(1)
    expect(owed[0].reason).toBe('delivery-failed')
  })

  it('serializes concurrent records — a multi-select delete loses none', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordPendingRemoteKill({ hostKey: HOST, session: `nt-${i}`, reason: 'not-connected' })
      )
    )
    expect(await pendingRemoteKillsFor(HOST)).toHaveLength(12)
  })

  it('caps the file, dropping the oldest', async () => {
    for (let i = 0; i < PENDING_REMOTE_KILL_MAX + 5; i++)
      await recordPendingRemoteKill({ hostKey: HOST, session: `nt-${i}`, reason: 'not-connected' })
    const all = await readPendingRemoteKills()
    expect(all).toHaveLength(PENDING_REMOTE_KILL_MAX)
    expect(all[0].session).toBe('nt-5')
  })

  it('a corrupt file yields no debts instead of throwing into a delete', async () => {
    await fs.writeFile(file(), '{ not json', 'utf8')
    expect(await readPendingRemoteKills()).toEqual([])
    // …and the next record repairs it.
    await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'no-ssh' })
    expect(await pendingRemoteKillsFor(HOST)).toHaveLength(1)
  })

  it('drops entries that are not shaped like a debt (hand-edited file)', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify([{ hostKey: HOST, session: 'nt-a', at: 1 }, { hostKey: HOST }, null, 7]),
      'utf8'
    )
    expect((await readPendingRemoteKills()).map((e) => e.session)).toEqual(['nt-a'])
  })

  describe('drain', () => {
    beforeEach(async () => {
      await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-a', reason: 'not-connected' })
      await recordPendingRemoteKill({ hostKey: HOST, session: 'nt-b', reason: 'not-connected' })
      await recordPendingRemoteKill({ hostKey: 'root@h2.test', session: 'nt-c', reason: 'no-ssh' })
    })

    it('settles only what the killer PROVED gone, and only on this host', async () => {
      const seen: string[] = []
      const r = await drainPendingRemoteKills(HOST, async (session) => {
        seen.push(session)
        return session === 'nt-a'
      })
      expect(seen).toEqual(['nt-a', 'nt-b'])
      expect(r).toEqual({ settled: ['nt-a'], owed: 2 })
      // 'nt-b' is still owed: a kill that could not be confirmed is never evidence of absence.
      expect((await pendingRemoteKillsFor(HOST)).map((e) => e.session)).toEqual(['nt-b'])
      expect((await pendingRemoteKillsFor('root@h2.test')).map((e) => e.session)).toEqual(['nt-c'])
    })

    it('a throwing killer settles nothing and never rejects', async () => {
      const r = await drainPendingRemoteKills(HOST, async () => {
        throw new Error('master died again')
      })
      expect(r.settled).toEqual([])
      expect(await pendingRemoteKillsFor(HOST)).toHaveLength(2)
    })

    it('does nothing at all for a host that owes nothing', async () => {
      let calls = 0
      const r = await drainPendingRemoteKills('nobody@h9.test', async () => {
        calls++
        return true
      })
      expect(calls).toBe(0)
      expect(r).toEqual({ settled: [], owed: 0 })
    })
  })
})
