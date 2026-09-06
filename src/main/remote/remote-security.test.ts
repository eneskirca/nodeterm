// Security regression tests for the remote subsystem hardening:
//   R1 — host serves no `pty.create`; `fs.*` is confined to the shared roots.
//   R2 — the channel SAS is deterministic + identical on both peers.
//   R3 — replayed/reordered encrypted boxes are dropped (per-direction monotonic counter).
//   R4 — killing a stream forgets it in the SAME synchronous turn, so a late Input frame for that
//        streamId can never be written into a session that is already released.
import { describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { genKeyPair, deriveSharedKey, sasFromSharedKey, publicKeyToB64 } from './e2ee'
import { connectRelay, type RelaySocket, type RelayTransport } from './relay-socket'
import { OP, type Frame } from './framing'

// --- R1: pty.create rejected + fs jail --------------------------------------

function makeHostFakes() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const reads: string[] = []
  const fs: HostFsOps = {
    listDir: async (p) => {
      reads.push(p)
      return [{ name: 'x', isDirectory: false } as never]
    },
    readText: async (p) => {
      reads.push(p)
      return 'secret'
    },
    readBinary: async () => '',
    writeText: async () => true
  }
  const pty = {
    createDetached: vi.fn(() => 'sess'),
    attachDetached: vi.fn(() => 'sess'),
    captureSnapshot: vi.fn(async () => ''),
    // Asked before every attach so the client learns whether the session had to be created.
    sessionExists: vi.fn(async () => true),
    write: vi.fn(),
    resize: vi.fn(),
    setFlow: vi.fn(),
    kill: vi.fn()
  } as unknown as HostPtyManager
  return { socket, responses, fs, reads, pty }
}

describe('R1: remote pty.create is not served', () => {
  it('responds with an error and never spawns a PTY', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'pty.create', params: { shell: '/bin/sh', cwd: '/' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: expect.stringContaining('not permitted') } }
    ])
    expect((pty.createDetached as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('R1: fs.* is confined to the shared roots', () => {
  it('denies a path outside the roots (no fs-ops call, empty result)', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/Users/me/.ssh/id_ed25519' } })
    await Promise.resolve()
    expect(reads).toEqual([]) // fs-ops never touched
    expect(responses).toEqual([{ id: '1', ok: true, body: { content: '' } }])
  })

  it('denies a ../ traversal escape from a root', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/work/../etc/passwd' } })
    await Promise.resolve()
    expect(reads).toEqual([])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { content: '' } })
  })

  it('allows a path inside a root', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/work/src/app.ts' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(['/work/src/app.ts'])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { content: 'secret' } })
  })

  it('denies everything when no roots are shared (deny-by-default)', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => [])
    handlers.onRpc({ id: '1', method: 'fs.list', params: { path: '/work' } })
    await Promise.resolve()
    expect(reads).toEqual([])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { entries: [] } })
  })
})

// --- projects.list: read-only browse RPC ------------------------------------

describe('projects.list serves the host projects blob', () => {
  it('responds ok with the listProjects output', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const listProjects = vi.fn(async () => 'FIXTURE')
    const handlers = createHostHandlers(pty, socket, fs, () => [], listProjects)
    handlers.onRpc({ id: '1', method: 'projects.list', params: undefined })
    await Promise.resolve()
    await Promise.resolve()
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(responses).toEqual([{ id: '1', ok: true, body: { output: 'FIXTURE' } }])
  })

  it('defaults to an empty blob when no provider is injected (4-arg call)', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => [])
    handlers.onRpc({ id: '2', method: 'projects.list', params: undefined })
    await Promise.resolve()
    await Promise.resolve()
    expect(responses).toEqual([{ id: '2', ok: true, body: { output: '' } }])
  })
})

// --- R2: SAS determinism -----------------------------------------------------

describe('R2: channel SAS', () => {
  it('is identical for both peers and stable, formatted NNN NNN', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const hostShared = deriveSharedKey(publicKeyToB64(client.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(host.publicKey), client.secretKey)
    const a = sasFromSharedKey(hostShared)
    const b = sasFromSharedKey(clientShared)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{3} \d{3}$/)
    expect(sasFromSharedKey(hostShared)).toBe(a) // deterministic
  })
})

// --- R3: replay protection (end-to-end over paired fake transports) ----------

// A pair of in-process transports wired host<->client. Records every binary box delivered to the
// client so a test can re-deliver (replay) it. Handshake control strings pass through too.
function makeTransportPair() {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  const toClient: Uint8Array[] = []
  const host: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => clientOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (hostOnMsg = cb),
    onClose: () => {}
  }
  const client: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (clientOnMsg = cb),
    onClose: () => {}
  }
  // Capture host→client binary boxes by wrapping host.send.
  const realHostSend = host.send
  host.send = (d) => {
    if (d instanceof Uint8Array) toClient.push(d)
    realHostSend(d)
  }
  return {
    host,
    client,
    replayToClient: (box: Uint8Array) => clientOnMsg?.(box),
    capturedToClient: toClient
  }
}

describe('R3: replayed encrypted frames are dropped', () => {
  it('delivers a frame once; a replay of the same box is ignored', () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const pair = makeTransportPair()

    let hostSocket: RelaySocket | null = null
    const clientFrames: Frame[] = []

    // Host first (passive), then client (sends hello → drives the synchronous handshake).
    hostSocket = connectRelay({
      url: 'x',
      token: 't',
      role: 'host',
      ourKeys: hostKeys,
      transport: pair.host,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })
    connectRelay({
      url: 'x',
      token: 't',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: pair.client,
      onReady: () => {},
      onRpc: () => {},
      onFrame: (f) => clientFrames.push(f),
      onClose: () => {}
    })

    // Host sends one output frame to the client.
    const ok = hostSocket.sendFrame(OP.Output, 1, 0, new TextEncoder().encode('hi'))
    expect(ok).toBe(true)
    expect(clientFrames).toHaveLength(1)

    // The last captured host→client box is that frame. Replay it verbatim.
    const lastBox = pair.capturedToClient[pair.capturedToClient.length - 1]
    pair.replayToClient(lastBox)
    expect(clientFrames).toHaveLength(1) // dropped — not re-delivered
  })
})

// `attachDetached` goes through `tmux new-session -A`, so an attach to a node whose tmux session
// is gone CREATES a bare login shell in $HOME. Without being told, a mirrored client showed that
// empty shell under the node's own title — a phone tapping a Claude session after the host's tmux
// server died got `~ %` and no agent. The attach reply now says which happened, so the client can
// run its cold restore (cd + `claude --resume`) instead.
describe('pty.attach reports whether it had to CREATE the session', () => {
  const attach = (handlers: ReturnType<typeof createHostHandlers>): void => {
    handlers.onRpc({ id: 'a', method: 'pty.attach', params: { nodeId: 'node-a', cols: 80, rows: 24 } })
  }
  const reply = async (responses: unknown[]): Promise<Record<string, unknown>> => {
    // The probe precedes the response, so let the microtasks settle.
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0))
    return responses.at(-1) as Record<string, unknown>
  }

  it('reports fresh=false when the session is already live (a warm join types nothing)', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    attach(createHostHandlers(pty, socket, fs, () => ['/work']))
    expect(await reply(responses)).toMatchObject({ ok: true, body: { fresh: false } })
  })

  it('reports fresh=true when the session is gone, so the client cold-restores', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    attach(createHostHandlers(pty, socket, fs, () => ['/work']))
    expect(await reply(responses)).toMatchObject({ ok: true, body: { fresh: true } })
  })

  it('a probe that throws answers WARM — never invent a cold start over a live agent', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux wedged'))
    attach(createHostHandlers(pty, socket, fs, () => ['/work']))
    expect(await reply(responses)).toMatchObject({ ok: true, body: { fresh: false } })
  })

  it('asks BEFORE attaching — after `new-session -A` the answer is always "exists"', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    attach(createHostHandlers(pty, socket, fs, () => ['/work']))
    await reply(responses)
    const probedAt = (pty.sessionExists as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    await vi.waitFor(() => expect(pty.attachDetached).toHaveBeenCalled())
    const attachedAt = (pty.attachDetached as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(probedAt).toBeLessThan(attachedAt)
  })
})

// Scrolling belongs to tmux (mouse on, alternate screen), and the phone cannot deliver the wheel
// itself — its emulator swallows the gesture — so it asks the host to write it into the stream's
// pty, which IS a tmux client. `lines` and the stream target both come off the wire.
describe('pty.scroll drives tmux through the session pty', () => {
  const attach = (handlers: ReturnType<typeof createHostHandlers>): void => {
    handlers.onRpc({ id: 'a', method: 'pty.attach', params: { nodeId: 'node-a', cols: 80, rows: 24 } })
  }
  const writes = (pty: HostPtyManager): string[] =>
    (pty.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string)

  it('writes one SGR wheel event per notch, up or down', () => {
    const { socket, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    attach(handlers)
    handlers.onRpc({ id: '1', method: 'pty.scroll', params: { streamId: 1, dir: 'up', lines: 3 } })
    expect(writes(pty)).toEqual(['\x1b[<64;1;1M', '\x1b[<64;1;1M', '\x1b[<64;1;1M'])
    handlers.onRpc({ id: '2', method: 'pty.scroll', params: { streamId: 1, dir: 'down', lines: 1 } })
    expect(writes(pty).at(-1)).toBe('\x1b[<65;1;1M')
  })

  it('clamps a hostile `lines` (it arrives from a remote client) and ignores an unknown stream', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    attach(handlers)
    handlers.onRpc({ id: '1', method: 'pty.scroll', params: { streamId: 1, dir: 'up', lines: 1e9 } })
    expect(writes(pty)).toHaveLength(20) // capped, not a million writes
    ;(pty.write as ReturnType<typeof vi.fn>).mockClear()
    handlers.onRpc({ id: '2', method: 'pty.scroll', params: { streamId: 1, lines: -5 } })
    expect(writes(pty)).toHaveLength(1) // floored at one notch
    ;(pty.write as ReturnType<typeof vi.fn>).mockClear()
    // An unknown streamId is a no-op, and still answers — never a hang.
    handlers.onRpc({ id: '3', method: 'pty.scroll', params: { streamId: 99, dir: 'up', lines: 2 } })
    expect(pty.write).not.toHaveBeenCalled()
    expect(responses.at(-1)).toMatchObject({ id: '3', ok: true })
  })
})

// --- R4: kill → dropStream is ONE synchronous step ---------------------------

// The invariant: a client's Input frame must never be written into a session the host has already
// released. Nothing enforces that but the ADJACENCY of two statements — `pty.kill(null, sessionId)`
// and the `dropStream` that forgets the streamId (handleKill; closeAll's `streams.clear()`). Put any
// yield between them and every frame the relay delivers in that window is written into a session on
// its way out (and, once a session is released, a background write can re-reach its tmux pane).
//
// So these tests pin the adjacency rather than the outcome: the late frame is queued as a microtask
// BEFORE the kill turn runs, which is exactly the window an `await` between the two statements would
// open. They pass only while the drop is synchronous with the kill.
function inputFrame(streamId: number, data: string): Frame {
  return { op: OP.Input, streamId, seq: 0, payload: new TextEncoder().encode(data) }
}

/** Attach a stream (id = n-th attach) and settle the async capture → attachDetached handoff. */
async function attachStream(
  handlers: ReturnType<typeof createHostHandlers>,
  nodeId: string
): Promise<void> {
  handlers.onRpc({ id: `a-${nodeId}`, method: 'pty.attach', params: { nodeId, cols: 80, rows: 24 } })
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('R4: a killed stream stops accepting input in the same turn', () => {
  it('drops an Input frame that lands one microtask after pty.kill', async () => {
    const { socket, fs, pty } = makeHostFakes()
    const writeMock = pty.write as ReturnType<typeof vi.fn>
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    await attachStream(handlers, 'node-a')

    // Control: while the stream lives, this exact frame IS written — so a later "not written"
    // cannot be an artifact of a wrong streamId or an attach that never completed.
    handlers.onFrame(inputFrame(1, 'echo live\n'))
    expect(writeMock).toHaveBeenCalledWith(null, 'sess', 'echo live\n')
    writeMock.mockClear()

    // Queue the frame FIRST: its microtask runs immediately after the kill's synchronous turn,
    // i.e. inside the gap any `await` between kill() and dropStream() would create.
    const late = Promise.resolve().then(() => handlers.onFrame(inputFrame(1, 'echo late\n')))
    handlers.onRpc({ id: 'k', method: 'pty.kill', params: { streamId: 1 } })
    expect(pty.kill).toHaveBeenCalledWith(null, 'sess')
    await late

    expect(writeMock).not.toHaveBeenCalled()
  })

  it('drops Input frames for every stream that closeAll killed', async () => {
    const { socket, fs, pty } = makeHostFakes()
    const writeMock = pty.write as ReturnType<typeof vi.fn>
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    await attachStream(handlers, 'node-a')
    await attachStream(handlers, 'node-b')
    handlers.onFrame(inputFrame(2, 'echo live\n')) // control: stream 2 is real and routable
    expect(writeMock).toHaveBeenCalledTimes(1)
    writeMock.mockClear()

    const late = Promise.resolve().then(() => {
      handlers.onFrame(inputFrame(1, 'echo late\n'))
      handlers.onFrame(inputFrame(2, 'echo late\n'))
    })
    handlers.closeAll()
    expect(pty.kill).toHaveBeenCalledTimes(2)
    await late

    expect(writeMock).not.toHaveBeenCalled()
  })
})

// --- pty.kill honesty + pty.destroy (issue #374) ------------------------------

// `pty.kill` used to answer `true` unconditionally — including when no stream matched — so every
// failure on that path was invisible to the client. And no relay method could END a session at
// all: `pty.kill` only drops the viewer (tmux keeps running, by design), while the desktop's
// "End session" is `destroySession(…, {everySocket:true})` + node removal. `pty.destroy` now
// reaches that path through an injected `destroyNode`, honestly refused when un-wired.

describe('pty.kill answers honestly', () => {
  it('an unknown streamId is an error, not a silent success', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'pty.kill', params: { streamId: 99 } })
    expect(pty.kill).not.toHaveBeenCalled()
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: expect.stringContaining('Unknown streamId') } }
    ])
  })

  it('a live stream still kills the viewer and answers ok', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    await attachStream(handlers, 'node-a')
    handlers.onRpc({ id: 'k', method: 'pty.kill', params: { streamId: 1 } })
    expect(pty.kill).toHaveBeenCalledWith(null, 'sess')
    expect(responses.at(-1)).toMatchObject({ id: 'k', ok: true })
  })
})

describe('pty.destroy ends the session through the injected destroyNode', () => {
  it('is honestly refused when no destroyNode is wired (old/partial hosts)', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    await attachStream(handlers, 'node-a')
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
    expect(responses.at(-1)).toEqual({
      id: 'd',
      ok: false,
      body: { message: expect.stringContaining('not served') }
    })
    // The refusal must not have touched the stream either.
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('destroys the STREAM’s node (never a client-sent id) and answers a VERIFIED ok', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    // The destroy actually lands: after it, the session no longer exists.
    const destroyNode = vi.fn(async () => {
      ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    })
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    await attachStream(handlers, 'node-a')
    // A hostile nodeId param rides along — it must be ignored in favor of the stream's own key.
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1, nodeId: 'victim' } })
    await vi.waitFor(() => expect(responses.at(-1)).toMatchObject({ id: 'd', ok: true }))
    expect(destroyNode).toHaveBeenCalledTimes(1)
    expect(destroyNode).toHaveBeenCalledWith('node-a')
    // The viewer is dropped like pty.kill does — the destroy ends the underlying session.
    expect(pty.kill).toHaveBeenCalledWith(null, 'sess')
  })

  // Issue #581: `destroyNode` resolving proves only that nothing threw — every per-step failure
  // inside the destroy chain is swallowed by design, so a chain that quietly ended NOTHING used to
  // answer success, and the app (which surfaces failures in an alert) had nothing to show over a
  // session that kept running. The verb now verifies the outcome itself.
  it('a destroy that resolves while the session still exists answers an honest error, not success', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const destroyNode = vi.fn(async () => {}) // resolves — and ends nothing (sessionExists stays true)
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    await attachStream(handlers, 'node-a')
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
    await vi.waitFor(() =>
      expect(responses.at(-1)).toEqual({
        id: 'd',
        ok: false,
        body: { message: expect.stringContaining('still running') }
      })
    )
  })

  it('an unprobeable outcome is a failure too — never success on uncertainty', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const destroyNode = vi.fn(async () => {
      ;(pty.sessionExists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux wedged'))
    })
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    await attachStream(handlers, 'node-a')
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
    await vi.waitFor(() =>
      expect(responses.at(-1)).toMatchObject({ id: 'd', ok: false })
    )
  })

  it('an unknown streamId is refused without calling destroyNode', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const destroyNode = vi.fn(async () => {})
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 42 } })
    expect(destroyNode).not.toHaveBeenCalled()
    expect(responses).toEqual([
      { id: 'd', ok: false, body: { message: expect.stringContaining('Unknown streamId') } }
    ])
  })

  it('a failed destroy is an honest error carrying the reason', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const destroyNode = vi.fn(async () => {
      throw new Error('tmux kill-session failed')
    })
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    await attachStream(handlers, 'node-a')
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
    await vi.waitFor(() =>
      expect(responses.at(-1)).toEqual({
        id: 'd',
        ok: false,
        body: { message: 'tmux kill-session failed' }
      })
    )
  })

  it('R4 adjacency: a late Input frame after pty.destroy is dropped, even while destroy is in flight', async () => {
    const { socket, fs, pty } = makeHostFakes()
    const writeMock = pty.write as ReturnType<typeof vi.fn>
    // A destroyNode that never resolves inside the test window — the drop must not wait for it.
    const destroyNode = vi.fn(() => new Promise<void>(() => {}))
    const handlers = createHostHandlers(
      pty, socket, fs, () => ['/work'], async () => '', () => null, undefined, undefined, destroyNode
    )
    await attachStream(handlers, 'node-a')
    handlers.onFrame(inputFrame(1, 'echo live\n'))
    expect(writeMock).toHaveBeenCalledWith(null, 'sess', 'echo live\n')
    writeMock.mockClear()

    const late = Promise.resolve().then(() => handlers.onFrame(inputFrame(1, 'echo late\n')))
    handlers.onRpc({ id: 'd', method: 'pty.destroy', params: { streamId: 1 } })
    await late
    expect(writeMock).not.toHaveBeenCalled()
  })
})

// --- relay-viewer presence (Eco × phone) --------------------------------------

// `remoteViewer` tells the desktop who is WATCHING a session from a phone: `attached` fires at
// stream-reserve time, and every stream drop — kill, destroy, closeAll — funnels through one
// `detached`, so the calls stay balanced per stream. The desktop turns this into the
// `agent:remote-viewers` set (Eco must not /exit a phone-watched session) and the attach edge
// into an `agent:wake` nudge.
describe('remoteViewer presence reporting', () => {
  function viewerFakes() {
    const events: string[] = []
    const remoteViewer = {
      attached: (id: string) => events.push(`+${id}`),
      detached: (id: string) => events.push(`-${id}`)
    }
    return { events, remoteViewer }
  }
  const make = (base: ReturnType<typeof makeHostFakes>, rv: { attached(id: string): void; detached(id: string): void }) =>
    createHostHandlers(
      base.pty, base.socket, base.fs, () => [], async () => '', () => null,
      undefined, undefined, undefined, rv
    )

  it('attach reports the viewer; kill reports the departure — balanced per stream', async () => {
    const base = makeHostFakes()
    const { events, remoteViewer } = viewerFakes()
    const handlers = make(base, remoteViewer)
    await attachStream(handlers, 'node-a')
    expect(events).toEqual(['+node-a'])
    handlers.onRpc({ id: 'k', method: 'pty.kill', params: { streamId: 1 } })
    expect(events).toEqual(['+node-a', '-node-a'])
  })

  it('closeAll reports every departure (relay dropped mid-view)', async () => {
    const base = makeHostFakes()
    const { events, remoteViewer } = viewerFakes()
    const handlers = make(base, remoteViewer)
    await attachStream(handlers, 'node-a')
    await attachStream(handlers, 'node-b')
    handlers.closeAll()
    expect(events.sort()).toEqual(['+node-a', '+node-b', '-node-a', '-node-b'])
  })

  it('a throwing callback breaks neither the attach nor the teardown', async () => {
    const base = makeHostFakes()
    const remoteViewer = {
      attached: () => {
        throw new Error('bookkeeping boom')
      },
      detached: () => {
        throw new Error('bookkeeping boom')
      }
    }
    const handlers = make(base, remoteViewer)
    await attachStream(handlers, 'node-a')
    // The stream is live despite the throwing callback: input still routes.
    handlers.onFrame(inputFrame(1, 'echo ok\n'))
    expect(base.pty.write).toHaveBeenCalledWith(null, 'sess', 'echo ok\n')
    handlers.onRpc({ id: 'k', method: 'pty.kill', params: { streamId: 1 } })
    expect(base.responses.at(-1)).toMatchObject({ id: 'k', ok: true })
  })
})
