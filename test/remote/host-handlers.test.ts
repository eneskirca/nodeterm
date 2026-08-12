import { describe, it, expect, vi } from 'vitest'
import {
  createHostHandlers,
  type HostPtyManager,
  type HostRelaySocket
} from '../../src/main/remote/host-service'
import { OP } from '../../src/main/remote/framing'
import type { DetachedSinks } from '../../src/main/pty-manager'
import type { PtyCreateOptions } from '../../src/shared/types'

// A fake pty-manager that records calls and lets the test fire the captured sinks.
function fakePty() {
  const calls: { method: string; args: unknown[] }[] = []
  let lastSinks: DetachedSinks | null = null
  let lastOptions: PtyCreateOptions | null = null
  let counter = 0
  let snapshot = ''
  let sessionLive = true
  const mgr: HostPtyManager = {
    createDetached(options, sinks) {
      lastOptions = options
      lastSinks = sinks
      const id = `pty-${++counter}`
      calls.push({ method: 'createDetached', args: [options, id] })
      return id
    },
    attachDetached(persistKey, sinks, options) {
      lastSinks = sinks
      const id = `pty-${++counter}`
      calls.push({ method: 'attachDetached', args: [persistKey, id, options] })
      return id
    },
    captureSnapshot: async (persistKey) => {
      calls.push({ method: 'captureSnapshot', args: [persistKey] })
      return snapshot
    },
    sessionExists: async (persistKey) => {
      calls.push({ method: 'sessionExists', args: [persistKey] })
      return sessionLive
    },
    write: (clientId, sessionId, data) =>
      calls.push({ method: 'write', args: [clientId, sessionId, data] }),
    resize: (clientId, sessionId, cols, rows) =>
      calls.push({ method: 'resize', args: [clientId, sessionId, cols, rows] }),
    // A relay-served (detached) pty has no ClientId: its pause is owed by the host's sink (null).
    setFlow: (clientId, sessionId, resume) =>
      calls.push({ method: 'setFlow', args: [clientId, sessionId, resume] }),
    // Relay-served ptys are killed with clientId null (they have no UI subscribers).
    kill: (clientId, sessionId) => calls.push({ method: 'kill', args: [clientId, sessionId] })
  }
  return {
    mgr,
    calls,
    sinks: () => lastSinks!,
    options: () => lastOptions!,
    setSnapshot: (s: string) => {
      snapshot = s
    },
    setSessionLive: (live: boolean) => {
      sessionLive = live
    }
  }
}

function fakeSocket(sendOk = true) {
  const responses: { id: string; ok: boolean; body: unknown }[] = []
  const frames: { op: number; streamId: number; seq: number; payload: Uint8Array }[] = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: (op, streamId, seq, payload) => {
      frames.push({ op, streamId, seq, payload })
      return sendOk
    }
  }
  return { socket, responses, frames }
}

const resizePayload = (cols: number, rows: number) => {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  return buf
}

// Open a stream the only way a remote client can: pty.attach to an existing session. Resolves
// once the async snapshot+attach has bound the sinks (sessionId 'pty-1'). Returns streamId 1.
async function openViaAttach(
  h: ReturnType<typeof createHostHandlers>,
  nodeId = 'node-1'
): Promise<void> {
  h.onRpc({ id: `open-${nodeId}`, method: 'pty.attach', params: { nodeId, cols: 80, rows: 24 } })
  await new Promise((r) => setTimeout(r, 0))
}

describe('createHostHandlers', () => {
  it('rejects pty.create — remote clients may only attach to existing sessions', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 100, rows: 30, cwd: '/', shell: '/bin/sh' } })

    expect(sock.responses[0]).toMatchObject({ id: 'r1', ok: false })
    expect(pty.calls.some((c) => c.method === 'createDetached')).toBe(false)
  })

  it('maps pty.attach to a snapshot sequence then attachDetached on the existing session', async () => {
    const pty = fakePty()
    pty.setSnapshot('CURRENT SCREEN')
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'node-9', cols: 100, rows: 30 } })
    // The stream is reserved SYNCHRONOUSLY — that, not the timing of the response, is what lets
    // the host route this streamId's inbound frames right away. The response itself now waits on
    // the `fresh` probe (a tmux side-call), because whether the attach CREATED the session has to
    // be asked before `attachDetached` does it.
    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls.some((c) => c.method === 'write')).toBe(true)
    // Capture + attach are async (a tmux side-call).
    await new Promise((r) => setTimeout(r, 0))
    expect(sock.responses).toEqual([{ id: 'r1', ok: true, body: { streamId: 1, fresh: false } }])

    expect(pty.calls).toContainEqual({ method: 'captureSnapshot', args: ['node-9'] })
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['node-9', 'pty-1', { cols: 100, rows: 30 }]
    })

    // Snapshot frames precede any live output: Start, one Chunk (the screen text), End.
    expect(sock.frames[0]).toMatchObject({ op: OP.SnapshotStart, streamId: 1 })
    expect(sock.frames[1]).toMatchObject({ op: OP.SnapshotChunk, streamId: 1 })
    expect(Buffer.from(sock.frames[1].payload).toString('utf8')).toBe('CURRENT SCREEN')
    expect(sock.frames[2]).toMatchObject({ op: OP.SnapshotEnd, streamId: 1 })

    // Live output then drives the same stream.
    pty.sinks().onData('live')
    const out = sock.frames.find((f) => f.op === OP.Output)
    expect(out).toBeDefined()
    expect(Buffer.from(out!.payload).toString('utf8')).toBe('live')
  })

  // A node whose tmux session died (host reboot, tmux server gone) still ATTACHES — the client
  // needs a live pane to type its cold restore (`cd <cwd>; claude --resume <id>`) into, exactly as
  // the SSH path gets one from `tmux new-session -A`. What changed is that the reply now SAYS it
  // was a cold start, so the client runs that restore instead of presenting the bare login shell
  // under the node's title, which is what a phone saw as `~ %` on a Claude session.
  it('still creates on a cold node, but reports fresh=true so the client can restore', async () => {
    const pty = fakePty()
    pty.setSessionLive(false)
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'cold-1', cols: 80, rows: 24 } })
    await new Promise((r) => setTimeout(r, 0))

    expect(sock.responses).toEqual([{ id: 'r1', ok: true, body: { streamId: 1, fresh: true } }])
    // Deliberately NOT a refusal: refusing would leave the client with nowhere to resume.
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['cold-1', 'pty-1', { cols: 80, rows: 24 }]
    })
  })

  it('attach sends an empty snapshot when the session has no current screen', async () => {
    const pty = fakePty() // snapshot defaults to ''
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.attach', params: { nodeId: 'node-1', cols: 80, rows: 24 } })
    await new Promise((r) => setTimeout(r, 0))

    // Empty snapshot: Start, End, no Chunk.
    expect(sock.frames.map((f) => f.op)).toContain(OP.SnapshotStart)
    expect(sock.frames.map((f) => f.op)).toContain(OP.SnapshotEnd)
    expect(sock.frames.some((f) => f.op === OP.SnapshotChunk)).toBe(false)
    expect(pty.calls).toContainEqual({
      method: 'attachDetached',
      args: ['node-1', 'pty-1', { cols: 80, rows: 24 }]
    })
  })

  it('rejects pty.attach without a nodeId', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.attach', params: { cols: 80, rows: 24 } })
    expect(sock.responses[0]).toMatchObject({ id: 'r1', ok: false })
  })

  it('pipes PTY output into OP.Output frames with an incrementing seq', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    pty.sinks().onData('hello')
    pty.sinks().onData('world')

    const outs = sock.frames.filter((f) => f.op === OP.Output)
    expect(outs).toHaveLength(2)
    expect(outs[0]).toMatchObject({ op: OP.Output, streamId: 1 })
    expect(Buffer.from(outs[0].payload).toString('utf8')).toBe('hello')
    expect(outs[1].seq).toBe(outs[0].seq + 1) // monotonic
  })

  it('routes OP.Input frames to write and OP.Resize frames to resize', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('ls\n') })
    h.onFrame({ op: OP.Resize, streamId: 1, seq: 0, payload: resizePayload(120, 40) })

    // No presence slot wired (getClientId defaults to null) → the input still reaches the pty, it
    // is simply not attributed to a typing peer.
    expect(pty.calls).toContainEqual({ method: 'write', args: [null, 'pty-1', 'ls\n'] })
    // clientId null: the relay-served pty's size is recorded against its sink, not a UI client.
    expect(pty.calls).toContainEqual({ method: 'resize', args: [null, 'pty-1', 120, 40] })
  })

  it('attributes an OP.Input frame to the bridged phone (typing badge, no iOS change needed)', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    // The phone's presence ClientId, read per frame from its PhonePresence slot (joined on bridge).
    const h = createHostHandlers(pty.mgr, sock.socket, undefined, undefined, undefined, () => 1_000_001)
    await openViaAttach(h)

    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('ls\n') })

    expect(pty.calls).toContainEqual({ method: 'write', args: [1_000_001, 'pty-1', 'ls\n'] })
  })

  it('ignores frames for unknown streams', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onFrame({ op: OP.Input, streamId: 99, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  it('pauses the PTY on backpressure and resumes on the next successful send', async () => {
    const pty = fakePty()
    const sock = fakeSocket(false) // sendFrame returns false → backpressure
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    pty.sinks().onData('a') // send fails → pause
    expect(pty.calls).toContainEqual({ method: 'setFlow', args: [null, 'pty-1', false] })

    // Flip the socket to succeed, then deliver more output → resume.
    sock.socket.sendFrame = vi.fn(() => true)
    pty.sinks().onData('b')
    expect(pty.calls).toContainEqual({ method: 'setFlow', args: [null, 'pty-1', true] })
  })

  it('rejects unknown RPC methods', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r9', method: 'pty.bogus', params: {} })
    expect(sock.responses[0]).toMatchObject({ id: 'r9', ok: false })
  })

  it('pty.kill kills the session and forgets the stream', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)
    h.onRpc({ id: 'r2', method: 'pty.kill', params: { streamId: 1 } })

    expect(pty.calls).toContainEqual({ method: 'kill', args: [null, 'pty-1'] })
    // After kill, input for the dropped stream is ignored.
    pty.calls.length = 0
    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  it('emits an OP.Error frame on PTY exit and drops the stream', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h)

    pty.sinks().onExit(0)
    const errFrame = sock.frames.find((f) => f.op === OP.Error)
    expect(errFrame).toBeDefined()
    expect(JSON.parse(Buffer.from(errFrame!.payload).toString('utf8'))).toEqual({ exitCode: 0 })
  })

  it('closeAll kills every live session', async () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    await openViaAttach(h, 'node-1')
    await openViaAttach(h, 'node-2')
    h.closeAll()
    expect(pty.calls.filter((c) => c.method === 'kill')).toHaveLength(2)
  })
})
