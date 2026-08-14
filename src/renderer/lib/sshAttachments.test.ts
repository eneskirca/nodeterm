import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sshAttachmentId, type SshConnection } from '@shared/ssh'
import { useSshConn } from '../state/sshConn'
import {
  connectHostAttachment,
  hostAttachmentsFor,
  resetHostAttachmentDials,
  type AttachableNode
} from './sshAttachments'

const DEVBOX: SshConnection = { host: 'devbox', user: 'corvin', port: 2222 }
const OTHER: SshConnection = { host: 'other', user: 'corvin' }

const remote = (id: string, ssh: SshConnection, cwd?: string): AttachableNode => ({
  id,
  ssh,
  sshRemoteTmux: true,
  cwd
})

describe('hostAttachmentsFor', () => {
  it('attaches every remote node of a LOCAL project to its host', () => {
    const found = hostAttachmentsFor('local-1', [remote('n1', DEVBOX, '/srv/app')])
    expect(found).toHaveLength(1)
    expect(found[0].scopeId).toBe(sshAttachmentId('local-1', DEVBOX))
    expect(found[0].hostKey).toBe('corvin@devbox')
    expect(found[0].remoteCwd).toBe('/srv/app')
    expect(found[0].nodeIds).toEqual(['n1'])
  })

  it('leaves an SSH project alone: its own master already serves its nodes', () => {
    expect(hostAttachmentsFor('ssh-1', [remote('n1', DEVBOX)], DEVBOX)).toEqual([])
  })

  it('attaches a node inside an SSH project that points at a DIFFERENT machine', () => {
    const found = hostAttachmentsFor('ssh-1', [remote('n1', DEVBOX), remote('n2', OTHER)], DEVBOX)
    expect(found.map((a) => a.hostKey)).toEqual(['corvin@other'])
  })

  it('opens ONE master per machine, however many nodes are on it', () => {
    const found = hostAttachmentsFor('local-1', [
      remote('n1', DEVBOX, '/srv/app'),
      remote('n2', { ...DEVBOX }, '/srv/other'),
      remote('n3', OTHER)
    ])
    expect(found).toHaveLength(2)
    const devbox = found.find((a) => a.hostKey === 'corvin@devbox')!
    expect(devbox.nodeIds).toEqual(['n1', 'n2'])
    // The connection is opened at the FIRST node's cwd; each node still spawns in its own.
    expect(devbox.remoteCwd).toBe('/srv/app')
  })

  it('ignores a plain `ssh <host>` node — it runs ssh as its own local pty, no master needed', () => {
    const local: AttachableNode = { id: 'n1', ssh: DEVBOX, sshRemoteTmux: false }
    expect(hostAttachmentsFor('local-1', [local])).toEqual([])
  })

  it('ignores nodes with no ssh binding at all', () => {
    expect(hostAttachmentsFor('local-1', [{ id: 'n1', cwd: '/home/me' }])).toEqual([])
  })

  it('gives two projects on the same machine their own scope', () => {
    const a = hostAttachmentsFor('local-1', [remote('n1', DEVBOX)])[0]
    const b = hostAttachmentsFor('local-2', [remote('n1', DEVBOX)])[0]
    expect(a.scopeId).not.toBe(b.scopeId)
  })

  it('never returns the project id as a scope (that master is not this node’s)', () => {
    for (const scope of hostAttachmentsFor('local-1', [remote('n1', DEVBOX), remote('n2', OTHER)])) {
      expect(scope.scopeId).not.toBe('local-1')
    }
  })
})

describe('connectHostAttachment', () => {
  const ATTACHMENT = {
    conn: DEVBOX,
    hostKey: 'corvin@devbox',
    remoteCwd: '/srv/app',
    ownerProjectId: 'local-1'
  }

  beforeEach(() => {
    resetHostAttachmentDials()
    useSshConn.setState({
      byProject: {},
      attachments: {},
      autoPermByProject: {},
      remoteClaudeVersionByProject: {}
    })
  })

  it('records the endpoint BEFORE dialing, not after it succeeds', async () => {
    // Ordering, not end state: main emits `status:'connected'` from inside its connect, over the
    // same IPC pipe, so that event lands BEFORE this promise resolves. Anything reading the scope
    // at that moment — `ownerProjectId`, which decides whether respawn bumps the nonce or takes
    // the "switched away" branch — must already find the record.
    let seenDuringDial: unknown
    const connect = vi.fn(async () => {
      seenDuringDial = useSshConn.getState().getAttachment('a1')
      return { controlPath: '/tmp/cm' }
    })

    await connectHostAttachment('a1', ATTACHMENT, connect)

    expect(seenDuringDial).toEqual(ATTACHMENT)
    expect(useSshConn.getState().ownerProjectId('a1')).toBe('local-1')
  })

  it('keeps the endpoint on record when the FIRST connect fails', async () => {
    // A cold load against a sleeping host. The reconnect coordinator's connect dep reads the
    // endpoint back out of the store; without this it returns false on every backoff step and
    // the offline overlay's Reconnect is inert for the rest of the app run.
    const connect = vi.fn(async () => {
      throw new Error('ssh: connect to host devbox port 2222: Host is down')
    })

    await expect(connectHostAttachment('a1', ATTACHMENT, connect)).resolves.toBe(false)

    expect(useSshConn.getState().getAttachment('a1')).toEqual(ATTACHMENT)
    expect(useSshConn.getState().getControlPath('a1')).toBeUndefined()
  })

  it('a failed dial does not poison the scope against the retry', async () => {
    const connect = vi
      .fn<() => Promise<{ controlPath: string }>>()
      .mockRejectedValueOnce(new Error('Host is down'))
      .mockResolvedValueOnce({ controlPath: '/tmp/cm' })

    expect(await connectHostAttachment('a1', ATTACHMENT, connect)).toBe(false)
    expect(await connectHostAttachment('a1', ATTACHMENT, connect)).toBe(true)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(useSshConn.getState().getControlPath('a1')).toBe('/tmp/cm')
  })

  it('collapses concurrent callers into ONE dial', async () => {
    // Every node on the machine calls this at spawn, on top of Canvas's pre-warm.
    const connect = vi.fn(async () => ({ controlPath: '/tmp/cm' }))

    const all = await Promise.all([
      connectHostAttachment('a1', ATTACHMENT, connect),
      connectHostAttachment('a1', ATTACHMENT, connect),
      connectHostAttachment('a1', ATTACHMENT, connect)
    ])

    expect(all).toEqual([true, true, true])
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('still dials when a controlPath is already cached — the reconnect path depends on it', async () => {
    // The regression this guards: treating a cached path as "already connected". NOTHING in the
    // renderer clears it when a connection drops, so the reconnect coordinator's connect dep
    // would answer true forever after one success — no `-O check`, no redial — and the respawned
    // ptys would run against a dead socket, which `ControlMaster=auto` silently turns into a
    // DIRECT connection per node (the ~72k-logins/day pattern). Only main can tell a live master
    // from a dead one, and its reuse branch costs one mux'd `-O check`.
    const connect = vi.fn(async () => ({ controlPath: '/tmp/fresh' }))
    useSshConn.getState().setConn('a1', { controlPath: '/tmp/stale-after-a-drop' })

    expect(await connectHostAttachment('a1', ATTACHMENT, connect)).toBe(true)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(useSshConn.getState().getControlPath('a1')).toBe('/tmp/fresh')
    expect(useSshConn.getState().getAttachment('a1')).toEqual(ATTACHMENT)
  })

  it('a dial that lands after the canvas was deleted is handed back, not recorded', async () => {
    let release: (v: { controlPath: string }) => void
    const connect = vi.fn(() => new Promise<{ controlPath: string }>((r) => (release = r)))
    const disconnect = vi.fn(async () => {})

    const pending = connectHostAttachment('a1', ATTACHMENT, connect, disconnect)
    useSshConn.getState().clearAttachment('a1') // the project was deleted mid-dial
    release!({ controlPath: '/tmp/cm' })

    expect(await pending).toBe(false)
    // Neither resurrected in the store nor leaked on the host.
    expect(useSshConn.getState().getControlPath('a1')).toBeUndefined()
    expect(disconnect).toHaveBeenCalledWith('a1')
  })

  it('dials each machine separately', async () => {
    const connect = vi.fn(async () => ({ controlPath: '/tmp/cm' }))

    await Promise.all([
      connectHostAttachment('a1', ATTACHMENT, connect),
      connectHostAttachment('a2', { ...ATTACHMENT, conn: OTHER, hostKey: 'corvin@other' }, connect)
    ])

    expect(connect).toHaveBeenCalledTimes(2)
  })
})
