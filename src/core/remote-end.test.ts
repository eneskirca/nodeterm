import { describe, it, expect } from 'vitest'
import { planRemoteEnd } from './remote-end'

const CONN = { host: 'h1.test', user: 'deploy' }
const OTHER = { host: 'h2.test', user: 'root' }
const LIVE = { conn: CONN, controlPath: '/cm/live.sock' }
const OWNED = { conn: CONN, controlPath: '/cm/owner.sock' }

describe('planRemoteEnd', () => {
  it('is a no-op for a node nothing claims — the local path is untouched', () => {
    expect(planRemoteEnd({ live: undefined, owner: null, ssh: '/usr/bin/ssh' })).toEqual({
      kind: 'none'
    })
  })

  it('uses the LIVE handle when there is one, even if a resolver also answers', () => {
    const plan = planRemoteEnd({
      live: LIVE,
      owner: { projectId: 'p1', hostKey: 'root@h2.test', remote: { conn: OTHER, controlPath: '/cm/owner.sock' } },
      ssh: '/usr/bin/ssh'
    })
    // The live handle is the master this session was actually spawned over; it cannot disagree
    // with itself, so it wins over anything the index believes.
    expect(plan).toMatchObject({ kind: 'deliver', controlPath: '/cm/live.sock', conn: CONN })
  })

  it('derives the host key from the live connection when only a live handle exists', () => {
    const plan = planRemoteEnd({ live: LIVE, owner: null, ssh: '/usr/bin/ssh' })
    expect(plan).toMatchObject({ kind: 'deliver', hostKey: 'deploy@h1.test', projectId: undefined })
  })

  it('THE FIX: with no live session, the persisted owner supplies the master', () => {
    const plan = planRemoteEnd({
      live: undefined,
      owner: { projectId: 'p1', hostKey: 'deploy@h1.test', remote: OWNED },
      ssh: '/usr/bin/ssh'
    })
    expect(plan).toEqual({
      kind: 'deliver',
      ssh: '/usr/bin/ssh',
      conn: CONN,
      controlPath: '/cm/owner.sock',
      hostKey: 'deploy@h1.test',
      projectId: 'p1'
    })
  })

  it('defers when the owning project has no ControlMaster', () => {
    const plan = planRemoteEnd({
      live: undefined,
      owner: { projectId: 'p1', hostKey: 'deploy@h1.test' },
      ssh: '/usr/bin/ssh'
    })
    expect(plan).toEqual({
      kind: 'defer',
      reason: 'not-connected',
      hostKey: 'deploy@h1.test',
      projectId: 'p1'
    })
  })

  it('defers when there is no ssh binary at all — including for a live handle', () => {
    expect(planRemoteEnd({ live: LIVE, owner: null, ssh: null })).toEqual({
      kind: 'defer',
      reason: 'no-ssh',
      hostKey: 'deploy@h1.test',
      projectId: undefined
    })
    expect(
      planRemoteEnd({ live: undefined, owner: { projectId: 'p1', hostKey: 'deploy@h1.test' }, ssh: null })
    ).toMatchObject({ kind: 'defer', reason: 'no-ssh' })
  })

  it('a missing ssh binary is decided BEFORE connectedness — the reason names what is wrong', () => {
    // Both are true at once for a disconnected project on a machine with no ssh. Reporting
    // 'not-connected' would send the user to reconnect a project that could never be killed from
    // here anyway.
    const plan = planRemoteEnd({
      live: undefined,
      owner: { projectId: 'p1', hostKey: 'deploy@h1.test', remote: OWNED },
      ssh: null
    })
    expect(plan).toMatchObject({ kind: 'defer', reason: 'no-ssh' })
  })
})
