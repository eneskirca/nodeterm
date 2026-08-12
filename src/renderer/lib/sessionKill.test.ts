import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import { planSessionKill } from './sessionKill'

const project = (id: string, nodeIds: string[], over: Partial<Project> = {}): Project =>
  ({
    id,
    name: id,
    color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: nodeIds.map((n) => ({ id: n, kind: 'terminal', title: n, position: { x: 0, y: 0 } })),
    ...over
  }) as unknown as Project

const ssh = (id: string, nodeIds: string[], over: Partial<Project> = {}): Project =>
  project(id, nodeIds, {
    ssh: { server: { host: 'box', user: 'enes', port: 22 } as never, remoteCwd: '/srv' },
    ...over
  })

describe('planSessionKill', () => {
  it('finds the owner across every project, closed ones included', () => {
    const plan = planSessionKill('c', [project('p1', ['a']), project('p2', ['c'], { closed: true })], 'p1')
    expect(plan.ownerProjectId).toBe('p2')
  })

  it('reports no owner for an orphan', () => {
    expect(planSessionKill('ghost', [project('p1', ['a'])], 'p1').ownerProjectId).toBeNull()
  })

  it('kills an ORPHAN on the host when the scope is an SSH project', () => {
    // The whole point. `transport.destroy` reaches a remote session only through a LIVE client
    // carrying `sshRemote`; an orphan has no node and therefore no client, so destroy alone would
    // touch the local socket and leave the host's `nt-ghost` running — after a confirm that said
    // otherwise.
    const plan = planSessionKill('ghost', [ssh('s1', ['a'])], 's1')
    expect(plan).toEqual({ ownerProjectId: null, remoteProjectId: 's1' })
  })

  it('kills a NON-ACTIVE project´s session on the host too', () => {
    // Same trap one step along: an unmounted node has no live client either. This is the case the
    // sessions sidebar has always got wrong; it never listed another machine's sessions, and this
    // panel's whole purpose is to.
    const plan = planSessionKill('b', [ssh('s1', ['a']), ssh('s2', ['b'], { closed: true })], 's1')
    expect(plan).toEqual({ ownerProjectId: 's2', remoteProjectId: 's1' })
  })

  it('routes the remote kill through the ACTIVE project, never the owner', () => {
    // The panel shows ONE machine — the active project's — and the sweep that produced these rows
    // ran over that project's master. The owner's own connection may be down, or on another host.
    expect(planSessionKill('b', [ssh('s1', ['a']), ssh('s2', ['b'])], 's1').remoteProjectId).toBe('s1')
  })

  it('never reaches for a host when the scope is this machine', () => {
    // A local sweep lists LOCAL sessions. A local `nt-b` whose node belongs to an SSH project is
    // the stranded local fallback `requireRemote` exists to prevent — killing it on the host would
    // leave it running here.
    const plan = planSessionKill('b', [project('p1', ['a']), ssh('s2', ['b'])], 'p1')
    expect(plan).toEqual({ ownerProjectId: 's2', remoteProjectId: null })
  })

  it('survives an unknown active project', () => {
    expect(planSessionKill('a', [project('p1', ['a'])], '').remoteProjectId).toBeNull()
  })
})
