// The owned-endpoint walk (hook-endpoint-failover-sh.ts), exercised for real: both generated shims
// under the real /bin/sh, against fixture endpoints that implement the one server contract the walk
// relies on — `/hook/verify` answers 204 for the endpoint's own bearer and 421 for any other, the
// way HookServer does. Follow-ups to PR #911 (the 2026-09-28/29 incident, see
// src/server/control-owner-tunnel-down.test.ts for the incident itself):
//
//  1. A reverse-tunnel socket whose sshd outlived the desktop's connection (the Mac asleep) ACCEPTS
//     and never answers. Once the foreign Server Edition stopped absorbing the walk, the walk posted
//     straight into such sockets — and the control POST has no --max-time on purpose (a confirm-
//     gated verb waits for a human), so the call hung. Fallback candidates are now probed first,
//     with a bound; the primary's POST, and a probed candidate's POST, stay unbounded.
//  2. The owner token came from the global dir search, so a Server Edition holding a token for the
//     same node id (the same project.json open in both) passed as the owner when the desktop's own
//     token write had failed.
//  3. The stale-endpoint hint ("retry once") printed after the owner-unreachable sentence ("retry
//     after it reconnects"): two pieces of advice for one failure.
//  4. A skipped foreign candidate left its SOCK behind, so the macOS codex-sandbox hint could name
//     the foreign socket.
import { describe, it, expect, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createNetServer, type Server, type Socket } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONTROL_SHIM_SCRIPT, CONTROL_UNREACHABLE_MSG } from './canvas-control-core'
import { CONTEXT_SHIM_SCRIPT, CONTEXT_UNREACHABLE_MSG } from './context-link-core'
import {
  FOREIGN_ENDPOINT_HINT,
  STALE_ENDPOINT_HINT,
  TUNNEL_DOWN_HINT
} from './agents/hook-endpoint-failover-sh'

const NODE = 'n1'
const OWNER_TOKEN = 'owner-kid.owner-mac'
const SE_REFUSAL =
  'control-unsupported-on-this-edition: Canvas control is not available on the nodeterm Server Edition. ' +
  'This is permanent on this host, not a temporary failure — do not retry.'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function tmp(): string {
  // Short: every socket below must fit sun_path (104 bytes on macOS).
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ow-'))
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

interface Recorded { url: string; nodeToken?: string }

/** An endpoint that behaves like HookServer on the two routes the walk uses. */
async function endpoint(
  sock: string,
  bearer: string,
  post: { status: number; body: string; delayMs?: number }
): Promise<{ probes: Recorded[]; posts: Recorded[] }> {
  const probes: Recorded[] = []
  const posts: Recorded[] = []
  const server = createHttpServer((req: IncomingMessage, res) => {
    const tok = req.headers['x-nodeterm-node-token']
    const rec = { url: req.url ?? '', nodeToken: Array.isArray(tok) ? tok[0] : tok }
    req.resume()
    req.on('end', () => {
      if (req.headers['x-nodeterm-hook-token'] !== bearer) {
        res.writeHead(421)
        res.end('hook-endpoint-wrong-owner\n')
        return
      }
      if (req.url === '/hook/verify' || req.url === '/verify') {
        probes.push(rec)
        res.writeHead(204)
        res.end()
        return
      }
      posts.push(rec)
      setTimeout(() => {
        res.writeHead(post.status, { 'content-type': 'text/plain' })
        res.end(post.body)
      }, post.delayMs ?? 0)
    })
  })
  await new Promise<void>((r) => server.listen(sock, r))
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
  return { probes, posts }
}

/** What an sshd-held reverse-tunnel socket does while the desktop is asleep: accept, never answer. */
async function hangingSocket(sock: string): Promise<{ data: () => string }> {
  let data = ''
  const conns = new Set<Socket>()
  const server: Server = createNetServer((c) => {
    conns.add(c)
    c.on('data', (d) => (data += d.toString()))
    c.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(sock, r))
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const c of conns) c.destroy()
        server.close(() => r())
      })
  )
  return { data: () => data }
}

/** A socket FILE with no listener — what a dead sshd leaves (a SIGKILLed holder never unlinks). */
async function staleSocket(sock: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['-e', "require('net').createServer().listen(process.argv[1], () => process.stdout.write('up'))", sock],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  await new Promise<void>((r) => child.stdout!.once('data', () => r()))
  await new Promise<void>((r) => {
    child.once('exit', () => r())
    child.kill('SIGKILL')
  })
}

function endpointFile(file: string, sock: string, bearer: string, tokenDir?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `NODETERM_HOOK_SOCK='${sock}'\nNODETERM_HOOK_TOKEN='${bearer}'\nNODETERM_HOOK_VERSION='2'\n` +
      (tokenDir ? `NODETERM_NODE_TOKEN_DIR='${tokenDir}'\n` : '')
  )
}

/** Force the tunnel walk's `ls -t` order: larger `ageSec` = older = tried later. */
function age(file: string, ageSec: number): void {
  const t = Date.now() / 1000 - ageSec
  fs.utimesSync(file, t, t)
}

interface Run { code: number; stdout: string; stderr: string; ms: number }

async function shim(
  d: string,
  which: 'control' | 'context',
  args: string[],
  env: Record<string, string>
): Promise<Run> {
  const file = path.join(d, `${which}.sh`)
  fs.writeFileSync(file, which === 'control' ? CONTROL_SHIM_SCRIPT : CONTEXT_SHIM_SCRIPT, { mode: 0o755 })
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [file, ...args],
      {
        timeout: 12_000,
        env: {
          PATH: process.env.PATH ?? '',
          NODETERM_CANVAS_CONTROL: '1',
          NODETERM_NODE_ID: NODE,
          ...env
        }
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout, stderr, ms: Date.now() - started })
      }
    )
  })
}

/** The SSH-host layout: the session's own tunnel (dead) + the desktop's token dir. */
async function sshHost(opts: { ownerToken?: boolean } = {}): Promise<{
  d: string
  home: string
  tokens: string
  primary: string
  env: Record<string, string>
}> {
  const d = tmp()
  const home = path.join(d, 'h')
  const tokens = path.join(home, '.nodeterm', 'node-tokens')
  fs.mkdirSync(tokens, { recursive: true })
  // Another node's token: the dir is real and in use, whatever this node's own file says.
  fs.writeFileSync(path.join(tokens, 'someone-else'), 'other\n')
  if (opts.ownerToken !== false) fs.writeFileSync(path.join(tokens, NODE), `${OWNER_TOKEN}\n`)
  const sock = path.join(home, '.nodeterm', 'a.sock')
  await staleSocket(sock)
  const primary = path.join(home, '.nodeterm', 'hook-endpoint-pa.env')
  endpointFile(primary, sock, 'desk-bearer', tokens)
  return { d, home, tokens, primary, env: { HOME: home, NODETERM_HOOK_ENDPOINT: primary } }
}

/** An unrelated local Server Edition in the first slot the walk tries. */
async function serverEdition(home: string, opts: { tokenForNode?: string } = {}) {
  const dir = path.join(home, '.nodeterm-server')
  const tokens = path.join(dir, 'node-tokens')
  fs.mkdirSync(tokens, { recursive: true })
  if (opts.tokenForNode) fs.writeFileSync(path.join(tokens, NODE), `${opts.tokenForNode}\n`)
  const sock = path.join(dir, 's.sock')
  const ep = await endpoint(sock, 'se-bearer', { status: 400, body: SE_REFUSAL })
  endpointFile(path.join(dir, 'hook-endpoint.env'), sock, 'se-bearer', tokens)
  return ep
}

const skipWin = describe.skipIf(process.platform === 'win32')
// A hang is what item 1 is about: give every case room to FAIL (the shim's own 12 s exec bound)
// rather than letting vitest's 5 s default report a timeout that looks like any other flake.
const T = 20_000

skipWin('1. a fallback tunnel that accepts and never answers cannot hang the call', () => {
  it.each(['control', 'context'] as const)(
    '%s: probes past a hanging sibling and reaches the live owner behind it',
    async (which) => {
      const host = await sshHost()
      const hang = await hangingSocket(path.join(host.home, '.nodeterm', 'b.sock'))
      const pb = path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env')
      endpointFile(pb, path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', host.tokens)
      age(pb, 10)
      const live = await endpoint(path.join(host.home, '.nodeterm', 'c.sock'), 'desk-bearer', {
        status: 200,
        body: 'owner reply'
      })
      const pc = path.join(host.home, '.nodeterm', 'hook-endpoint-pc.env')
      endpointFile(pc, path.join(host.home, '.nodeterm', 'c.sock'), 'desk-bearer', host.tokens)
      age(pc, 100)

      const r = await shim(host.d, which, ['list'], host.env)
      expect(r).toMatchObject({ code: 0, stdout: 'owner reply' })
      expect(r.ms).toBeLessThan(6000)
      // The hanging socket saw a probe and nothing else: no verb was ever parked inside it.
      expect(hang.data()).toContain('/hook/verify')
      expect(hang.data()).not.toMatch(/\/control\/|\/context-link\//)
      expect(live.posts.map((p) => p.nodeToken)).toEqual([OWNER_TOKEN])
    },
    T
  )

  it("last night's shape with sshd still holding every sibling: fails in bounded time, as owner-unreachable", async () => {
    const host = await sshHost()
    const se = await serverEdition(host.home)
    const hangs = []
    for (const [i, n] of ['b', 'c', 'd'].entries()) {
      const sock = path.join(host.home, '.nodeterm', `${n}.sock`)
      hangs.push(await hangingSocket(sock))
      const f = path.join(host.home, '.nodeterm', `hook-endpoint-p${n}.env`)
      endpointFile(f, sock, 'desk-bearer', host.tokens)
      age(f, 10 * (i + 1))
    }
    const [ctl, ctx] = await Promise.all([
      shim(host.d, 'control', ['close', '--node', 'a,b'], host.env),
      shim(host.d, 'context', ['list'], host.env)
    ])
    for (const r of [ctl, ctx]) {
      expect(r.code).toBe(1)
      expect(r.ms).toBeLessThan(9000)
      expect(r.stderr).toContain(FOREIGN_ENDPOINT_HINT)
      // 3. ONE piece of advice: the owner-unreachable sentence, not also "retry once".
      expect(r.stderr).not.toContain(STALE_ENDPOINT_HINT)
      expect(r.stderr).not.toMatch(/retry once/i)
      expect(r.stderr).not.toMatch(/permanent|do not retry/i)
    }
    expect(se.probes).toEqual([])
    expect(se.posts).toEqual([])
    for (const h of hangs) expect(h.data()).not.toMatch(/\/control\/|\/context-link\//)
  }, T)

  // The bound is on the PROBE only. A real POST — the primary's, or a probed candidate's — may be a
  // confirm-gated verb waiting for a human (up to CONTROL_REQUEST_TIMEOUT_MS), and a client-side
  // timeout there would fail over mid-wait and let a second instance raise a second dialog.
  it("the primary's slow answer is waited for and stays final", async () => {
    const d = tmp()
    const home = path.join(d, 'h')
    const tokens = path.join(home, '.nodeterm', 'node-tokens')
    fs.mkdirSync(tokens, { recursive: true })
    fs.writeFileSync(path.join(tokens, NODE), `${OWNER_TOKEN}\n`)
    const primary = await endpoint(path.join(home, '.nodeterm', 'a.sock'), 'desk-bearer', {
      status: 200,
      body: 'confirmed after a while',
      delayMs: 2500
    })
    const primaryFile = path.join(home, '.nodeterm', 'hook-endpoint-pa.env')
    endpointFile(primaryFile, path.join(home, '.nodeterm', 'a.sock'), 'desk-bearer', tokens)
    const sibling = await endpoint(path.join(home, '.nodeterm', 'b.sock'), 'desk-bearer', {
      status: 200,
      body: 'sibling'
    })
    endpointFile(path.join(home, '.nodeterm', 'hook-endpoint-pb.env'), path.join(home, '.nodeterm', 'b.sock'), 'desk-bearer', tokens)

    const r = await shim(d, 'control', ['close', '--node', 'a'], { HOME: home, NODETERM_HOOK_ENDPOINT: primaryFile })
    expect(r).toMatchObject({ code: 0, stdout: 'confirmed after a while' })
    expect(primary.probes).toEqual([]) // the primary is never probed: its POST is the question
    expect(sibling.probes).toEqual([])
    expect(sibling.posts).toEqual([])
  }, T)

  it("a probed fallback owner's slow answer is waited for too", async () => {
    const host = await sshHost()
    const live = await endpoint(path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', {
      status: 200,
      body: 'confirmed via sibling',
      delayMs: 2500
    })
    endpointFile(path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env'), path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', host.tokens)
    const r = await shim(host.d, 'control', ['close', '--node', 'a'], host.env)
    expect(r).toMatchObject({ code: 0, stdout: 'confirmed via sibling' })
    expect(live.probes).toHaveLength(1)
    expect(live.posts).toHaveLength(1)
  }, T)
})

skipWin("2. the owner token comes from the primary's own dir, never the global search", () => {
  // The desktop's remote token write failed, so the dir the session's endpoint advertises exists
  // but holds no file for this node — while a local Server Edition that opened the same
  // project.json holds one for the same node id. The global search used to adopt that token as
  // "the owner's", and the Server Edition then passed the owner check.
  it.each(['control', 'context'] as const)(
    '%s: a Server Edition holding a token for the same node id is not the owner',
    async (which) => {
      const host = await sshHost({ ownerToken: false })
      const se = await serverEdition(host.home, { tokenForNode: 'se-kid.se-mac' })
      const sibling = await endpoint(path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', {
        status: 200,
        body: 'owner reply'
      })
      endpointFile(path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env'), path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', host.tokens)

      const r = await shim(host.d, which, ['list'], host.env)
      expect(r).toMatchObject({ code: 0, stdout: 'owner reply' })
      expect(se.probes).toEqual([])
      expect(se.posts).toEqual([])
      // The owner's dir holds nothing for this node, so nothing is presented — never the SE's token.
      expect(sibling.posts.map((p) => p.nodeToken)).toEqual([undefined])
    },
    T
  )

  it('with no owning endpoint alive, says so instead of relaying the Server Edition refusal', async () => {
    const host = await sshHost({ ownerToken: false })
    const se = await serverEdition(host.home, { tokenForNode: 'se-kid.se-mac' })
    const r = await shim(host.d, 'control', ['list'], host.env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(FOREIGN_ENDPOINT_HINT)
    expect(r.stderr).not.toContain('control-unsupported-on-this-edition')
    expect(se.posts).toEqual([])
  }, T)
})

skipWin('4. a skipped foreign candidate leaves no endpoint behind', () => {
  // Codex's macOS sandbox hint names $NODETERM_HOOK_SOCK as the socket to allow. After the walk it
  // must be an endpoint this node could actually use — never one that was skipped as foreign.
  it('the sandbox hint names the owned socket, not the foreign one adopted last', async () => {
    const host = await sshHost()
    // Primary answers 421 (the one failure a sandboxed walk may act on).
    const primarySock = path.join(host.home, '.nodeterm', 'p.sock')
    await endpoint(primarySock, 'the-real-bearer', { status: 200, body: 'unreachable' })
    endpointFile(host.primary, primarySock, 'stale-bearer', host.tokens)
    // Owned candidate, dead; then a foreign one, later in the walk's fixed local order.
    const ownedSock = path.join(host.home, 'o.sock')
    await staleSocket(ownedSock)
    endpointFile(path.join(host.home, '.config', 'node-terminal', 'hook-endpoint.env'), ownedSock, 'desk-bearer', host.tokens)
    const foreignTokens = path.join(host.home, 'ft')
    fs.mkdirSync(foreignTokens)
    const foreignSock = path.join(host.home, 'f.sock')
    const foreign = await endpoint(foreignSock, 'f-bearer', { status: 200, body: 'foreign' })
    endpointFile(
      path.join(host.home, 'Library', 'Application Support', 'node-terminal', 'hook-endpoint.env'),
      foreignSock,
      'f-bearer',
      foreignTokens
    )
    // The hint's socket line is macOS-only; pretend.
    const bin = path.join(host.d, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })

    const r = await shim(host.d, 'control', ['list'], {
      ...host.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CODEX_SANDBOX_NETWORK_DISABLED: '1'
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`"${ownedSock}"`)
    expect(r.stderr).not.toContain(foreignSock)
    expect(foreign.probes).toEqual([])
    expect(foreign.posts).toEqual([])
  }, T)
})

// Review round 2 on #1018: three more shapes of the same incident class.
skipWin('5. a probe that answers 421 still leaves the agent a sentence', () => {
  // The primary is dead and the only fallback refuses this bearer (421) at the probe. The probe used
  // to write to /dev/null, so the control shim exited 1 with EMPTY stderr — an agent sees a failed
  // call and nothing to act on. It must print what a POST's 421 would have printed.
  it.each(['control', 'context'] as const)('%s: exits 1 naming the wrong-owner answer', async (which) => {
    const host = await sshHost()
    const sock = path.join(host.home, '.nodeterm', 'b.sock')
    const other = await endpoint(sock, 'rebound-bearer', { status: 200, body: 'never' })
    endpointFile(path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env'), sock, 'desk-bearer', host.tokens)
    const r = await shim(host.d, which, ['list'], host.env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('hook-endpoint-wrong-owner')
    expect(r.stderr).toContain(which === 'control' ? CONTROL_UNREACHABLE_MSG : CONTEXT_UNREACHABLE_MSG)
    expect(other.posts).toEqual([])
  }, T)
})

skipWin('6. an EMPTY owner reference compares where tokens are kept, not what they say', () => {
  // The primary's token dir exists but holds nothing for this node (the desktop's token write
  // failed), and the Server Edition holds nothing for it either. "" === "" matched, the Server
  // Edition was adopted, and its permanent refusal was relayed — measured in review.
  it.each(['control', 'context'] as const)(
    '%s: a Server Edition with no token for this node is skipped; the sibling tunnel is not',
    async (which) => {
      const host = await sshHost({ ownerToken: false })
      const se = await serverEdition(host.home)
      const sibling = await endpoint(path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', {
        status: 200,
        body: 'owner reply'
      })
      endpointFile(path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env'), path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', host.tokens)
      const r = await shim(host.d, which, ['list'], host.env)
      expect(r).toMatchObject({ code: 0, stdout: 'owner reply' })
      expect(se.probes).toEqual([])
      expect(se.posts).toEqual([])
    },
    T
  )

  it('with no sibling alive, the refusal is never relayed', async () => {
    const host = await sshHost({ ownerToken: false })
    const se = await serverEdition(host.home)
    const r = await shim(host.d, 'control', ['list'], host.env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(FOREIGN_ENDPOINT_HINT)
    expect(r.stderr).not.toMatch(/permanent|do not retry|control-unsupported/i)
    expect(se.posts).toEqual([])
  }, T)

  // The comparison is by the directory's REAL path: an older sibling file that advertises no dir
  // (so its dir is derived as <file's dir>/node-tokens) and a spelling through a symlink are the
  // same place.
  it('matches an adjacent-derived or symlinked spelling of the same dir', async () => {
    const host = await sshHost({ ownerToken: false })
    const alias = path.join(host.home, 'tok-alias')
    fs.symlinkSync(host.tokens, alias)
    endpointFile(host.primary, path.join(host.home, '.nodeterm', 'a.sock'), 'desk-bearer', alias)
    const sibling = await endpoint(path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer', {
      status: 200,
      body: 'owner reply'
    })
    endpointFile(path.join(host.home, '.nodeterm', 'hook-endpoint-pb.env'), path.join(host.home, '.nodeterm', 'b.sock'), 'desk-bearer')
    const r = await shim(host.d, 'control', ['list'], host.env)
    expect(r).toMatchObject({ code: 0, stdout: 'owner reply' })
    expect(sibling.posts).toHaveLength(1)
  }, T)
})

skipWin('7. a dead SSH tunnel with nothing foreign around says the desktop is down, once', () => {
  // The common host: no Server Edition, just the session's own tunnel gone quiet. "retry once — it
  // re-advertises the endpoint on start" is advice about an app restart; here the fix is the
  // desktop reconnecting.
  it.each(['control', 'context'] as const)('%s: tunnel primary → the tunnel advice, not the stale one', async (which) => {
    const host = await sshHost()
    const r = await shim(host.d, which, ['list'], host.env)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(TUNNEL_DOWN_HINT)
    expect(r.stderr).not.toContain(STALE_ENDPOINT_HINT)
    expect(r.stderr).not.toContain(FOREIGN_ENDPOINT_HINT)
    expect(r.stderr).not.toMatch(/retry once|permanent|do not retry/i)
  }, T)

  it('a primary that is not an SSH tunnel file keeps the stale-endpoint advice', async () => {
    const d = tmp()
    const home = path.join(d, 'h')
    const userData = path.join(home, '.config', 'node-terminal')
    fs.mkdirSync(path.join(userData, 'node-tokens'), { recursive: true })
    const primary = path.join(userData, 'hook-endpoint.env')
    const sock = path.join(userData, 'x.sock')
    await staleSocket(sock)
    endpointFile(primary, sock, 'b', path.join(userData, 'node-tokens'))
    const r = await shim(d, 'control', ['list'], { HOME: home, NODETERM_HOOK_ENDPOINT: primary })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(STALE_ENDPOINT_HINT)
    expect(r.stderr).not.toContain(TUNNEL_DOWN_HINT)
  }, T)
})

