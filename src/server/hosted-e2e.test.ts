// The hosted team relay, end to end, on a REAL `startServer` boot (headless, no hooks, temp data dir).
//
// Every piece below has its own unit suite; this one proves they COMPOSE: the admin socket's `team`
// verbs drive the same service the relay listeners belong to, the access policy sees the node and
// project ids the real workspace store answers, the relay peer's requests reach the real platform
// handlers, and a viewer's terminal is the owner's live one. The flow:
//   (the canvas is seeded through a WorkspaceStore before boot: a relay peer cannot save the host's
//   workspace) team init → add-owner → share → the owner joins (auto-approved) and opens a terminal → a guest
//   knocks and waits → the owner approves it as a viewer → the viewer joins the owner's live
//   session, cannot start one, cannot write a file, cannot read the enclosing repository through git
//   → `team status` lists it as a connected viewer → the canvas authority (no browser attached):
//   the owner's canvas ops are written to the shared project's file by this core, the viewer hears
//   them and cannot cast one, an outside edit of the file reaches the owner as ops → `team unshare`
//   silences the viewer's terminal → a restart on the same data dir keeps every edit.
//
// What is real and what is not:
//  - REAL: startServer and every core service it boots, the admin unix socket and its client, the
//    hosted service, the relay E2EE handshake and trust gates on both ends (core `connectRelayClient`
//    is the desktop joiner's own connector), the access policy, WorkspaceStore, PtyManager.
//  - FAKE: the relay server (an in-process transport pair per listener, `relayTestTransport`), the
//    host-token API (`relayTestFetch`), and `node-pty` (a recording fake — no process is spawned).
//    The server's terminals are plain shells here (settings.json `tmuxEnabled: false`), so the test
//    runs the same with or without tmux on the machine and leaves NO tmux session anywhere: there is
//    nothing to kill afterwards, and it never touches a tmux server (the vitest sandbox re-points
//    TMUX_TMPDIR regardless). A viewer's join is the in-process co-attach either way — the branch a
//    tmux-backed session takes too once its owner is attached.
//
// No sleeps: every step waits on an event it is owed (a transport the scheduler opened, a frame, an
// approval, pty bytes). `step()` puts a deadline on each wait ONLY so that a hang fails with that
// step's name instead of the test timeout; nothing ever waits on the clock to succeed. The one wait
// that polls is the project file (`projectFileWhen`): the authority's flush is a disk write, and no
// client is sent an event for it. It polls every 100 ms under a step deadline.
//
// One data dir per file (see hosted-boot.test.ts: some core paths are memoized per process, so a
// boot on ANOTHER data dir would write into this one). The restart boots a second server on the
// SAME data dir, which is exactly where those memoized paths already point.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from './index'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { WorkspaceStore } from '../core/workspace-store'
import { writeFileAtomic } from '../core/fs-atomic'
import type { ProjectFileV1 } from '../core/workspace-files'
import { callTeamAdmin, type AdminInitResult, type AdminReply, type AdminStatusResult } from '../core/relay/team-admin'
import { transportPair } from '../core/relay/transport-pair'
import { connectRelayClient, type RelayClientSession } from '../core/relay/relay-client'
import { decodeJoinCode, type JoinCode } from '../core/relay/join-code'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../core/relay/e2ee'
import { createTestPopServer } from '../core/relay/relay-pop.test-server'
import type { RelayTransport } from '../core/relay/relay-socket'
import { IPC } from '../shared/ipc'
import { mutationKey } from '../shared/canvas-order'
import { seededColumnId } from '../shared/kanban-default-board'
import type { CanvasMutation, CanvasNodeState, Project, PtyCreateResult, Workspace } from '../shared/types'

// A broken seam must fail HERE, never reach production. index.ts reads NODETERM_RELAY_URL at module
// load (hoisted above the imports): if `relayTestTransport` ever stopped being plumbed through, the
// listeners would dial this dead loopback port instead of the real relay. The mint's twin is the
// global-fetch trap below.
const env = vi.hoisted(() => {
  const prev = process.env.NODETERM_RELAY_URL
  process.env.NODETERM_RELAY_URL = 'ws://127.0.0.1:9/hosted-e2e-seam-missing'
  return { prev }
})

/** One recorded fake pty per spawn (the pty-coattach.test.ts harness): "spawned nothing" is
 *  `spawned.length`, "the viewer never sized it" is `resizes`, and `onDataCb` pushes output. */
interface FakePty {
  file: string
  args: string[]
  onDataCb?: (d: string) => void
  resizes: Array<{ cols: number; rows: number }>
}
const spawned = vi.hoisted(() => [] as FakePty[])

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    const p: FakePty = { file, args: [...(args ?? [])], resizes: [] }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: () => {},
      write: () => {},
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4242
    }
  }
}))
// Pin the plain-shell backend: a checkout that ran `npm run build` has the session-host bundle on
// disk (src/core/__fixtures__/no-session-host.ts says why a suite must SAY which backend it runs).
vi.mock('../core/session-host-backend', async () =>
  (await import('../core/__fixtures__/no-session-host')).noSessionHost()
)
// A machine with pty devices to spare, always: the spawn preflight reads the HOST's device count,
// and a busy host must not refuse the owner's terminal before our fake spawn is ever reached.
vi.mock('../core/pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

// A unix socket path is ~107 bytes at most: boot under a SHORT base so the admin socket fits.
const SHORT_BASE = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir()
const STEP_MS = 20_000

const SHARED = 'p-team'
const PRIVATE = 'p-private'
const LIVE = 'term-e2e-live' // the owner opens it
const IDLE = 'term-e2e-idle' // shared, but nobody runs it
const SECRET = 'term-e2e-secret' // in a project that is not shared

const pub = (k: KeyPair): string => publicKeyToB64(k.publicKey)

/** Fail with the step's NAME if its event never comes. A bound on a hang, never a success condition:
 *  a timing claim (the authority's 1 s / 5 s flush) is pinned by its unit tests on a manual clock,
 *  never by a wall-clock bound on a loaded CI machine (ruling R14). */
function step<T>(name: string, p: Promise<T>, ms: number = STEP_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`step "${name}" never completed`)), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

/** FIFO whose `next()` resolves as soon as an item is (or already was) pushed. */
function fifo<T>() {
  const items: T[] = []
  const waiters: Array<(v: T) => void> = []
  return {
    push(v: T): void {
      const w = waiters.shift()
      if (w) w(v)
      else items.push(v)
    },
    next(): Promise<T> {
      return items.length > 0 ? Promise.resolve(items.shift() as T) : new Promise<T>((r) => waiters.push(r))
    }
  }
}

type Frame = { t: string; id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; channel?: string; args?: unknown[] }

/** The canvas op a frame carries, when it is a `canvas:mut` event for `projectId` (args = [projectId, op]). */
function mutOf(f: Frame, projectId: string = SHARED): CanvasMutation | null {
  if (f.t !== 'ev' || f.channel !== IPC.canvasMut || f.args?.[0] !== projectId) return null
  const m = f.args[1]
  return m && typeof m === 'object' ? (m as CanvasMutation) : null
}

/** The order key of the canvas op a frame carries (`mutationKey`), or null for any other frame. */
const mutKeyOf = (f: Frame, projectId: string = SHARED): string | null => {
  const m = mutOf(f, projectId)
  return m ? mutationKey(m, projectId) : null
}

/** A fire-and-forget cast over the E2EE tunnel. A canvas op has no reply: its reflection is its ack. */
function cast(conn: RelayClientSession, method: string, args: unknown[]): boolean {
  return conn.send(JSON.stringify({ t: 'cast', method, args }))
}

/** A teammate's desktop, as far as the host can tell: core `connectRelayClient` (what the desktop
 *  joiner runs) over one of the host's listeners. `pinned` = a bookmarked, already-approved host
 *  (auto-confirm); otherwise the human compares the SAS and confirms at once. */
function teammate(code: JoinCode, transport: RelayTransport, keys: KeyPair, pinned: boolean) {
  const frames: Frame[] = []
  const frameWaiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
  const byteWaiters: Array<{ sessionId: string; resolve: (d: string) => void }> = []
  /** Every terminal chunk received, in order: "received nothing" is as much a result as a chunk. */
  const received: Array<[string, string]> = []
  const denied: string[] = []
  let approve!: () => void
  const approved = new Promise<void>((r) => {
    approve = r
  })
  const waitFrame = (test: (f: Frame) => boolean): Promise<Frame> => {
    const seen = frames.find(test)
    return seen ? Promise.resolve(seen) : new Promise((resolve) => frameWaiters.push({ test, resolve }))
  }
  const c: RelayClientSession = connectRelayClient({
    url: code.relayEndpoint,
    token: 'relay-token',
    hostKeyB64: code.hostPublicKeyB64,
    ourKeys: keys,
    transport,
    autoApprove: pinned,
    onSas: (s) => {
      if (!pinned) s.confirm()
    },
    onApproved: () => approve(),
    onFrame: (json) => {
      const f = JSON.parse(json) as Frame
      frames.push(f)
      for (const w of [...frameWaiters]) {
        if (!w.test(f)) continue
        frameWaiters.splice(frameWaiters.indexOf(w), 1)
        w.resolve(f)
      }
    },
    onPtyData: (sessionId, data) => {
      received.push([sessionId, data])
      for (const w of [...byteWaiters]) {
        if (w.sessionId !== sessionId) continue
        byteWaiters.splice(byteWaiters.indexOf(w), 1)
        w.resolve(data)
      }
    },
    onClose: () => {},
    onDenied: (r) => denied.push(r)
  })
  let nextId = 1
  return {
    c,
    approved,
    denied,
    received,
    /** Every frame received, in arrival order (one tunnel delivers in order). */
    frames: frames as readonly Frame[],
    /** One RPC round trip over the E2EE tunnel. */
    call(method: string, args: unknown[] = []): Promise<Frame> {
      const id = nextId++
      const res = waitFrame((f) => f.t === 'res' && f.id === id)
      expect(c.send(JSON.stringify({ t: 'req', id, method, args })), `${method} sent`).toBe(true)
      return step(`${method} answered`, res)
    },
    /** The first event on `channel` whose payload passes `match` (one already received counts). */
    event(channel: string, match: (payload: Record<string, unknown>) => boolean = () => true): Promise<Frame> {
      return waitFrame((f) => f.t === 'ev' && f.channel === channel && match((f.args?.[0] ?? {}) as Record<string, unknown>))
    },
    /** The first reflected `canvas:mut` of the shared project whose op is `op` and whose order key
     *  is `key` (`mutationKey`), and that passes `where` when given. One already received counts. */
    mut(op: CanvasMutation['op'], key: string, where: (m: CanvasMutation) => boolean = () => true): Promise<Frame> {
      return waitFrame((f) => {
        const m = mutOf(f)
        return !!m && m.op === op && mutationKey(m, SHARED) === key && where(m)
      })
    },
    /** The next terminal output for `sessionId`. */
    bytes(sessionId: string): Promise<string> {
      return new Promise((resolve) => byteWaiters.push({ sessionId, resolve }))
    }
  }
}

const terminalNode = (id: string, x: number): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 0 },
  size: { width: 600, height: 400 },
  title: id,
  color: '#0a84ff',
  group: null
})
const project = (id: string, nodes: CanvasNodeState[]): Project => ({
  id,
  name: id,
  color: '#0a84ff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes
})
/** The shared project is a FOLDER project: `cwd` is a subfolder of a real git repository (C1). */
const workspaceWith = (sharedCwd: string): Workspace => ({
  version: 2,
  activeProjectId: SHARED,
  projects: [
    { ...project(SHARED, [terminalNode(LIVE, 0), terminalNode(IDLE, 700)]), cwd: sharedCwd },
    project(PRIVATE, [terminalNode(SECRET, 0)])
  ]
})

/** A real repository with a committed secret OUTSIDE the shared subfolder: `repo/shared/` is what
 *  the team sees, `repo/secret/key.txt` is not. Outside the server's data dir on purpose (M7 would
 *  refuse a viewer anything in there for another reason). */
function repoWithSecret(base: string): { repo: string; shared: string } {
  const repo = path.join(base, 'repo')
  fs.mkdirSync(path.join(repo, 'shared'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'secret'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'shared', 'a.txt'), 'shared file\n')
  fs.writeFileSync(path.join(repo, 'secret', 'key.txt'), 'TOPSECRET\n')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      stdio: 'ignore'
    })
  }
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { repo, shared: path.join(repo, 'shared') }
}

/** A folder project's committed file. */
const projectFilePath = (cwd: string): string => path.join(cwd, '.nodeterm', 'project.json')

/** A folder project's committed file as it is on disk now, raw and parsed. Throws if unreadable. */
function readProjectFile(cwd: string): { raw: string; file: ProjectFileV1 } {
  const raw = fs.readFileSync(projectFilePath(cwd), 'utf8')
  return { raw, file: JSON.parse(raw) as ProjectFileV1 }
}

/**
 * Read a project file every 100 ms until `ready` holds, under a step deadline, and return that read.
 * The one polling wait in this file: the authority's flush is a disk write no client hears about.
 * A file that cannot be read or parsed yet (mid-rename) is simply not ready.
 */
async function projectFileWhen(
  name: string,
  cwd: string,
  ready: (raw: string, file: ProjectFileV1) => boolean,
  ms: number = STEP_MS
): Promise<ProjectFileV1> {
  let timer: ReturnType<typeof setInterval> | undefined
  const found = new Promise<ProjectFileV1>((resolve) => {
    const look = (): void => {
      let read: { raw: string; file: ProjectFileV1 }
      try {
        read = readProjectFile(cwd)
      } catch {
        return
      }
      if (!ready(read.raw, read.file)) return
      clearInterval(timer)
      resolve(read.file)
    }
    timer = setInterval(look, 100)
    look()
  })
  try {
    return await step(name, found, ms)
  } finally {
    clearInterval(timer)
  }
}

/** A node's position in a project file or a loaded project (undefined = no such node). */
const positionOf = (nodes: CanvasNodeState[] | undefined, id: string): CanvasNodeState['position'] | undefined =>
  nodes?.find((n) => n.id === id)?.position

async function admin<T>(dataDir: string, req: Parameters<typeof callTeamAdmin>[1]): Promise<T> {
  const r: AdminReply = await step(`team ${req.cmd}`, callTeamAdmin(dataDir, req))
  if (!r.ok) throw new Error(`team ${req.cmd} failed: ${r.error}`)
  return r.result as T
}

// Torn down whatever happened, a hang included: a test that times out never reaches its own finally.
const teardown: Array<() => void | Promise<void>> = []
// The hook outlives one step deadline, so a teardown that runs into it still lets the rest run.
afterEach(async () => {
  for (const f of teardown.splice(0).reverse()) {
    try {
      await f()
    } catch (err) {
      console.warn('[hosted-e2e] teardown step failed', err)
    }
  }
}, 2 * STEP_MS)
afterAll(() => {
  vi.unstubAllGlobals()
  if (env.prev === undefined) delete process.env.NODETERM_RELAY_URL
  else process.env.NODETERM_RELAY_URL = env.prev
})

// The admin channel is a unix socket, which Windows does not have (team-admin.ts refuses it by
// name there), so no hosted team can be set up on that platform. Linux and macOS run it.
describe.skipIf(process.platform === 'win32')('hosted team relay, end to end on a headless server', () => {
  it('admin setup → owner auto-approved → guest waits → approved as viewer → watches the owner’s terminal, starts none, writes nothing → shared canvas edits persist with no browser attached and survive a restart', async () => {
    spawned.length = 0
    const dataDir = fs.mkdtempSync(path.join(SHORT_BASE, 'nthe-'))
    teardown.push(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    // Plain-shell terminals (see the header), from the server's own settings file.
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ tmuxEnabled: false }))

    // The relay: each listener the scheduler opens is one in-process transport pair, and its peer end
    // is handed to whichever teammate connects next — the relay's pairing, minus the network. A fresh
    // queue per boot (step 9): the listeners a closed server opened are dead ends.
    let listeners = fifo<RelayTransport>()
    const relayTestTransport = (): RelayTransport => {
      const { hostT, peerT } = transportPair()
      listeners.push(peerT)
      return hostT
    }
    // The host-token API, proof of possession included: a byte-exact mirror of the backend issues
    // the challenge and refuses a mint whose proof does not verify, so a host that stopped proving it
    // holds its key (or proved the wrong thing) never gets a listener. A token good for an hour, so
    // no listener refresh lands mid-test.
    const popServer = createTestPopServer()
    const mints: Array<{ url: string; body: Record<string, unknown> }> = []
    const relayTestFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { date: new Date().toUTCString() } })
      if (String(url).endsWith('/v1/relay/challenge')) {
        return json(200, popServer.issue(String(body.hostPublicKeyB64), body.purpose as 'host-token'))
      }
      mints.push({ url: String(url), body })
      const proven = popServer.verify({
        hostPublicKeyB64: String(body.hostPublicKeyB64),
        purpose: 'host-token',
        subject: typeof body.deviceId === 'string' ? body.deviceId : '',
        popChallenge: body.popChallenge,
        popProof: body.popProof
      })
      if (!proven) return json(403, { error: 'pop_invalid' })
      return json(200, { pairingToken: 'relay-token', hostId: 'H', exp: Math.floor(Date.now() / 1000) + 3600 })
    }) as typeof fetch
    // The mint's production twin of the relay trap above: if `relayTestFetch` stopped being plumbed
    // through, the mint would fall back to the global fetch — which refuses here instead of minting
    // a host token against the real API.
    const globalHostTokenCalls: string[] = []
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      if (String(url).includes('/v1/relay/')) globalHostTokenCalls.push(String(url))
      throw new Error('hosted-e2e: the global fetch is not used in this test')
    }) as typeof fetch)

    // The shared project's folder: a subfolder of a real repository, in its own temp dir.
    const repoBase = fs.mkdtempSync(path.join(SHORT_BASE, 'nther-'))
    teardown.push(() => fs.rmSync(repoBase, { recursive: true, force: true }))
    const { shared: sharedCwd } = repoWithSecret(repoBase)

    // The canvas is on this core before it boots: written through a WorkspaceStore on the SAME data
    // dir (the index, and the shared project's own .nodeterm/project.json). A relay peer can no longer
    // put it there — a hosted team never saves the host's workspace (step 2 checks the refusal).
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    try {
      await step('seed the workspace', new WorkspaceStore().save(workspaceWith(sharedCwd)))
    } finally {
      resetPlatformForTests()
    }

    // Both boots (step 9 restarts on the same data dir) take this config.
    const config: Parameters<typeof startServer>[0] = {
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      headless: true,
      // Never touch the developer's real agent configs (see ServerConfig.installHooks).
      installHooks: false,
      relayTestTransport,
      relayTestFetch
    }
    const booting = startServer(config)
    // Registered BEFORE the boot is awaited: a boot that outlives its step deadline is still closed
    // once it lands, instead of leaking a server (and its admin socket) into the next test. The wait
    // is itself a step: a boot that never settles must not hang afterEach, or the teardowns
    // registered before this one (the repository and data dirs) would never run. Closed ONCE: step 9
    // closes this server itself, and the teardown then only waits for that close.
    let closing: Promise<void> | undefined
    const closeFirstServer = (): Promise<void> => (closing ??= booting.catch(() => null).then((s) => s?.close()))
    teardown.push(() => step('server teardown', closeFirstServer()))
    await step('server boot', booting)
    // After the boot, so the log sink the server installs is what this spy calls through to.
    const warn = vi.spyOn(console, 'warn')
    teardown.push(() => warn.mockRestore())

    // ---- 1. The admin socket sets the team up, and hosting starts.
    const init = await admin<AdminInitResult>(dataDir, { cmd: 'init' })
    expect(init).toMatchObject({ created: true, start: 'started' })
    // What a teammate is given: a code that decodes, whose host id derives from its host key.
    const code = decodeJoinCode(init.joinCode ?? '')
    expect(code).not.toBeNull()
    if (!code) return
    expect(code.hostPublicKeyB64).toBe(init.info?.hostPublicKeyB64)

    const ownerKeys = genKeyPair()
    await admin(dataDir, { cmd: 'add-owner', pubkey: pub(ownerKeys), label: 'Owner' })
    await admin(dataDir, { cmd: 'share', projectId: SHARED, on: true })

    // ---- 2. The owner connects: a team member, so the host approves it without a human.
    const owner = teammate(code, await step('first listener', listeners.next()), ownerKeys, true)
    teardown.push(() => owner.c.close())
    await step('owner approved', owner.approved)
    // The host minted that listener's token for THIS host key, through the seam, proving it holds it.
    expect(mints[0]).toMatchObject({
      url: expect.stringMatching(/\/v1\/relay\/host-token$/),
      body: {
        hostPublicKeyB64: code.hostPublicKeyB64,
        deviceId: code.hostDeviceId,
        popChallenge: expect.any(String),
        popProof: expect.any(String)
      }
    })

    // Even the owner cannot save the host's workspace over the relay: shared content travels as
    // canvas ops, which the host's canvas authority writes (docs/hosted-team-relay.md).
    expect(await owner.call(IPC.workspaceSave, [workspaceWith(sharedCwd)])).toMatchObject({
      ok: false,
      error: { code: 'E_ROLE', message: expect.stringMatching(/cannot save the host's workspace over the relay/) }
    })
    // The owner opens one terminal of the seeded canvas: that session is now live.
    const opened = await owner.call(IPC.ptyCreate, [{ cols: 120, rows: 40, persistKey: LIVE }])
    expect(opened).toMatchObject({ ok: true, result: { fresh: true } })
    const ownerSessionId = (opened.result as PtyCreateResult).sessionId
    expect(ownerSessionId).not.toBe('')
    expect(spawned).toHaveLength(1)
    // A plain shell, never a tmux client: there is no tmux session to clean up after this test.
    expect(path.basename(spawned[0].file)).not.toBe('tmux')
    expect(spawned[0].args).not.toContain('new-session')

    // ---- 3. A guest knocks. It waits; only the owner hears of it, with the SAS the guest sees.
    const guestKeys = genKeyPair()
    const knock = owner.event(IPC.relayHostedPeerPending)
    const guest = teammate(code, await step('second listener', listeners.next()), guestKeys, false)
    teardown.push(() => guest.c.close())
    const pending = (await step('owner told of the guest', knock)).args?.[0] as { pendingId: string; sas: string; peerKeyB64: string }
    expect(pending.peerKeyB64).toBe(pub(guestKeys))
    expect(pending.sas).toBe(guest.c.sas())
    expect(guest.c.isOpen()).toBe(false)
    const waiting = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(waiting.pending.map((p) => p.pendingId)).toEqual([pending.pendingId])
    expect(waiting.peers).toEqual([{ label: 'Owner', role: 'owner', connected: true }])

    // ---- 4. The owner approves the guest as a VIEWER.
    expect(await owner.call(IPC.relayHostedApprove, [pending.pendingId, 'viewer'])).toMatchObject({ ok: true, result: true })
    await step('guest approved', guest.approved)

    // ---- 5. The viewer watches the owner's live terminal: the same session, not a new one.
    const joined = await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: LIVE }])
    expect(joined).toMatchObject({ ok: true, result: { sessionId: ownerSessionId, fresh: false } })
    expect((joined.result as PtyCreateResult).unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    // Joined as a non-voting view: the viewer's smaller window never resized the shared pty.
    expect(spawned[0].resizes).toEqual([])
    // …and the owner's session output reaches it.
    const out = guest.bytes(ownerSessionId)
    spawned[0].onDataCb?.('hello from the owner\r\n')
    expect(await step('viewer receives the owner’s output', out)).toContain('hello from the owner')

    // It can watch a running terminal but never start one: the idle node is refused, nothing spawns.
    expect(await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: IDLE }])).toMatchObject({
      ok: true,
      result: { sessionId: '', unavailable: 'join-only' }
    })
    expect(spawned).toHaveLength(1)
    // A terminal in a project nobody shared is not reachable at all, and the refusal is the access
    // policy's own sentence (not some other E_ROLE).
    expect(await guest.call(IPC.ptyCreate, [{ cols: 80, rows: 24, persistKey: SECRET }])).toMatchObject({
      ok: false,
      error: { code: 'E_ROLE', message: 'Viewers can only watch terminals in a shared project that are already running.' }
    })
    expect(spawned).toHaveLength(1)
    // Its workspace is the shared project only.
    const ws = await guest.call(IPC.workspaceLoad)
    expect(ws).toMatchObject({ ok: true, result: { activeProjectId: SHARED } })
    expect((ws.result as Workspace).projects.map((p) => p.id)).toEqual([SHARED])

    // ---- 6. A viewer cannot write a file.
    const target = path.join(dataDir, 'written-by-a-viewer.txt')
    expect(await guest.call(IPC.fsWrite, [target, 'x'])).toMatchObject({
      ok: false,
      error: { code: 'E_ROLE', message: "Viewers can't do that here. Ask an owner for Editor access." }
    })
    expect(fs.existsSync(target)).toBe(false)

    // ---- 6b. Git (C1): the shared folder is a SUBFOLDER of a repository. `git show HEAD:<path>`
    // resolves the path against the repository's top level, so the real handler hands the owner the
    // secret outside the shared folder — which is exactly why a viewer is refused git there. Its
    // files are still readable.
    const showSecret = [sharedCwd, 'HEAD', 'secret/key.txt']
    expect(await owner.call(IPC.gitShowFile, showSecret)).toMatchObject({ ok: true, result: 'TOPSECRET' })
    const gitRefusal =
      'Git is available to viewers only in a project that is the top folder of its own repository, never in a subfolder of a larger one.'
    expect(await guest.call(IPC.gitShowFile, showSecret)).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: gitRefusal } })
    expect(await guest.call(IPC.gitStatus, [sharedCwd])).toMatchObject({ ok: false, error: { code: 'E_ROLE', message: gitRefusal } })
    expect(await guest.call(IPC.fsRead, [path.join(sharedCwd, 'a.txt')])).toMatchObject({ ok: true })
    // Its own view of itself says so.
    expect(await guest.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'viewer' } })

    // ---- 7. `team status`: the guest is a connected viewer; nothing is waiting.
    const status = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(status).toMatchObject({ enabled: true, off: null, pending: [] })
    expect(status.peers).toEqual([
      { label: 'Owner', role: 'owner', connected: true },
      { label: '', role: 'viewer', connected: true }
    ])
    expect(owner.denied).toEqual([])
    expect(guest.denied).toEqual([])

    // ---- 7a. The canvas authority, with no browser attached: this core is the one writer of the
    // shared project's content. The owner's edits travel as canvas ops, which the authority applies
    // in the reflector's order and writes into the project's own file.
    const column2 = seededColumnId(SHARED, 1)
    const moved: CanvasMutation = { op: 'upsert', node: terminalNode(LIVE, 321), src: 'owner-e2e' }
    const bridged: CanvasMutation = {
      op: 'edge-upsert',
      kind: 'bridge',
      edge: { id: 'bridge-e2e', source: LIVE, target: IDLE },
      src: 'owner-e2e'
    }
    const carded: CanvasMutation = { op: 'kb-card', assignment: { nodeId: LIVE, columnId: column2 }, src: 'owner-e2e' }
    const ownerOps = [moved, bridged, carded]
    for (const m of ownerOps) expect(cast(owner.c, IPC.canvasMut, [SHARED, m]), `${m.op} cast`).toBe(true)
    // Each op's reflection is its ack: the reflector stamped it, so the authority has applied it (the
    // reflector hands a stamped op to the authority synchronously, before it fans it out).
    for (const m of ownerOps) {
      const ack = mutOf(await step(`the owner’s ${m.op} is reflected`, owner.mut(m.op, mutationKey(m, SHARED))))
      expect(ack, m.op).toMatchObject({ ...m, seq: expect.any(Number) })
    }
    // The authority writes it with nobody saving (its 1 s / 5 s bounds are pinned on a manual clock
    // in canvas-authority.test.ts): read the file until it holds ALL THREE ops, parsed — a raw
    // substring would also match a half-applied write.
    const flushed = await projectFileWhen(
      'the authority writes the shared project',
      sharedCwd,
      (_raw, file) =>
        !!file.bridges?.some((b) => b.id === 'bridge-e2e') &&
        positionOf(file.nodes, LIVE)?.x === 321 &&
        !!file.kanban?.assignments.some((a) => a.nodeId === LIVE && a.columnId === column2),
      STEP_MS
    )
    expect(positionOf(flushed.nodes, LIVE)).toEqual({ x: 321, y: 0 })
    expect(flushed.bridges).toContainEqual({ id: 'bridge-e2e', source: LIVE, target: IDLE })
    // The card, in the SECOND column of the project's lazy default board (seeded, so every client
    // and the authority name the same three columns).
    expect(flushed.kanban?.columns.map((c) => c.id)[1]).toBe(column2)
    expect(flushed.kanban?.assignments).toContainEqual(expect.objectContaining({ nodeId: LIVE, columnId: column2 }))
    // The viewer is a client of the same total order: it heard all three.
    for (const m of ownerOps) {
      await step(`the viewer receives the ${m.op}`, guest.mut(m.op, mutationKey(m, SHARED)))
    }

    // A viewer cannot write the canvas: its cast is refused before the reflector, so nobody (not the
    // viewer, not the owner, not the authority) ever hears of it.
    const viewerCard: CanvasMutation = {
      op: 'kb-card',
      assignment: { nodeId: IDLE, columnId: seededColumnId(SHARED, 0) },
      src: 'viewer-e2e'
    }
    const viewerKey = mutationKey(viewerCard, SHARED)
    expect(cast(guest.c, IPC.canvasMut, [SHARED, viewerCard])).toBe(true)
    // One round trip on the viewer's own tunnel: the host has handled everything the viewer sent
    // before this answer, the cast included (a cast is served synchronously, in arrival order).
    expect(await guest.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'viewer' } })
    // So a marker the owner casts NOW is stamped after the viewer's op would have been. Each tunnel
    // delivers in order, so a reflected viewer op would reach both peers before the marker does.
    const marker: CanvasMutation = { op: 'upsert', node: terminalNode(IDLE, 777), src: 'owner-e2e' }
    const markerKey = mutationKey(marker, SHARED)
    expect(cast(owner.c, IPC.canvasMut, [SHARED, marker])).toBe(true)
    const isMarker = (m: CanvasMutation): boolean => m.op === 'upsert' && m.node.position.x === 777
    for (const [who, peer] of [['owner', owner], ['viewer', guest]] as const) {
      const markerFrame = await step(`the ${who} receives the marker`, peer.mut('upsert', markerKey, isMarker))
      const before = peer.frames.slice(0, peer.frames.indexOf(markerFrame))
      expect(before.filter((f) => mutKeyOf(f) === viewerKey), `the ${who} heard the viewer’s card`).toEqual([])
    }
    // Nor does the file: once the NEXT flush has written the marker, the viewer's card is not there
    // (and the owner's card still is).
    const afterMarker = await projectFileWhen(
      'the marker reaches the project file',
      sharedCwd,
      (_raw, file) => positionOf(file.nodes, IDLE)?.x === 777,
      STEP_MS
    )
    expect(afterMarker.kanban?.assignments.map((a) => a.nodeId)).not.toContain(IDLE)
    expect(afterMarker.kanban?.assignments).toContainEqual(expect.objectContaining({ nodeId: LIVE, columnId: column2 }))

    // An outside edit (what a `git pull` does to the file): the bridge is gone and `rev` moved on. The
    // authority adopts it and publishes the difference as canvas ops; the whole-project
    // `workspace:external-change` (and the conflict bar it raises on a dirty canvas) is NOT sent for
    // a governed project.
    const pulled: ProjectFileV1 = {
      ...afterMarker,
      rev: afterMarker.rev + 1,
      bridges: (afterMarker.bridges ?? []).filter((b) => b.id !== 'bridge-e2e')
    }
    const framesBeforePull = owner.frames.length
    await writeFileAtomic(projectFilePath(sharedCwd), `${JSON.stringify(pulled, null, 2)}\n`)
    const unbridged = mutationKey({ op: 'edge-remove', kind: 'bridge', id: 'bridge-e2e' }, SHARED)
    await step('the outside edit reaches the owner as an edge-remove', owner.mut('edge-remove', unbridged))
    // One round trip on the owner's tunnel: whatever the host sent the owner before this answer
    // (an external-change broadcast is sent synchronously, ahead of the adopted diff) has arrived.
    expect(await owner.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'owner' } })
    const duringPull = owner.frames.slice(framesBeforePull)
    const externalChanges = duringPull.filter(
      (f) => f.t === 'ev' && f.channel === IPC.workspaceExternalChange && (f.args?.[0] as { id?: unknown } | undefined)?.id === SHARED
    )
    expect(externalChanges).toEqual([])
    // The edit, and nothing but the edit: the authority's diff is exactly the removed bridge.
    expect(duringPull.map((f) => mutKeyOf(f)).filter((k) => k !== null)).toEqual([unbridged])

    // ---- 7b. `team unshare`: the viewer stays connected, but the terminal it is already watching
    // goes quiet for it at once (R45); its owner keeps the output. The session's node is looked up
    // through the real PtyManager on every frame.
    await admin(dataDir, { cmd: 'share', projectId: SHARED, on: false })
    const ownerAfterUnshare = owner.bytes(ownerSessionId)
    spawned[0].onDataCb?.('after the unshare\r\n')
    expect(await step('owner receives output after the unshare', ownerAfterUnshare)).toContain('after the unshare')
    // One round trip on the viewer's own tunnel: anything sent to it before this answer has arrived.
    expect(await guest.call(IPC.relayHostedSelf)).toMatchObject({ ok: true, result: { role: 'viewer' } })
    expect(guest.received.map(([, d]) => d).join('')).toContain('hello from the owner')
    expect(guest.received.map(([, d]) => d).join('')).not.toContain('after the unshare')

    // ---- 8. The viewer's desktop goes away: its membership stays, its connection does not, and the
    // owner's terminal keeps running for the owner.
    const left = owner.event(IPC.presencePeer, (d) => d.op === 'leave')
    guest.c.close()
    await step('owner told the viewer left', left)
    const after = await admin<AdminStatusResult>(dataDir, { cmd: 'status' })
    expect(after.peers).toEqual([
      { label: 'Owner', role: 'owner', connected: true },
      { label: '', role: 'viewer', connected: false }
    ])
    // An ordinary disconnect is not a dead socket: no send to the leaver was counted as a failure.
    expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[ui-sink]'))).toEqual([])
    const stillThere = owner.bytes(ownerSessionId)
    spawned[0].onDataCb?.('still running\r\n')
    expect(await step('owner still receives output', stillThere)).toContain('still running')

    // ---- 9. A restart on the SAME data dir keeps every shared edit. The project is shared again
    // first (7b took it out of the team; a relay peer's workspace:load holds shared projects only).
    // Then one op is left unwritten on purpose: the close must write what the authority still owes.
    await admin(dataDir, { cmd: 'share', projectId: SHARED, on: true })
    const owed: CanvasMutation = { op: 'upsert', node: terminalNode(IDLE, 654), src: 'owner-e2e' }
    expect(cast(owner.c, IPC.canvasMut, [SHARED, owed])).toBe(true)
    await step(
      'the owner’s last op is reflected',
      owner.mut('upsert', mutationKey(owed, SHARED), (m) => m.op === 'upsert' && m.node.position.x === 654)
    )
    await step('server close', closeFirstServer())
    // On disk once close() resolves. Timing-dependent in the GREEN direction only: the authority's
    // own 1 s flush may already have written the op before close() began, so a pass does not prove
    // that close() waited for the flush; a failure does prove the op was lost. That close() awaits
    // the authority's stop (which writes what is owed) is pinned in hosted-boot.test.ts.
    expect(positionOf(readProjectFile(sharedCwd).file.nodes, IDLE)).toEqual({ x: 654, y: 0 })

    listeners = fifo<RelayTransport>()
    const rebooting = startServer(config)
    teardown.push(() => step('second server teardown', rebooting.catch(() => null).then((s) => s?.close())))
    await step('server boot after the restart', rebooting)
    // The owner comes back the way a bookmarked, already-approved host is rejoined: pinned.
    const back = teammate(code, await step('listener after the restart', listeners.next()), ownerKeys, true)
    teardown.push(() => back.c.close())
    await step('owner approved after the restart', back.approved)
    const reloaded = await back.call(IPC.workspaceLoad)
    expect(reloaded).toMatchObject({ ok: true, result: { activeProjectId: SHARED } })
    const again = (reloaded.result as Workspace).projects.find((p) => p.id === SHARED)
    expect(positionOf(again?.nodes, LIVE)).toEqual({ x: 321, y: 0 })
    expect(positionOf(again?.nodes, IDLE)).toEqual({ x: 654, y: 0 })
    expect(again?.kanban?.assignments).toContainEqual(expect.objectContaining({ nodeId: LIVE, columnId: column2 }))
    // The bridge stays gone: the outside edit, not the owner's earlier op, is what was kept.
    expect((again?.bridges ?? []).map((b) => b.id)).not.toContain('bridge-e2e')

    // Nothing ever went around the seams.
    expect(globalHostTokenCalls).toEqual([])
  }, 90_000)
})
