/**
 * A PHONE-SPAWNED session is `verified`, and this test is why nobody has to re-derive that.
 *
 * The phone injects exactly two vars (nodeterm-ios TerminalTransport.swift:188):
 * NODETERM_HOOK_ENDPOINT and NODETERM_NODE_ID. No bearer, no port, no token. It does NOT go through
 * ptyManager.create — it types `tmux new-session -A` over its own SSH transport — so the token file
 * it reads was materialised by the PERSIST-time sweep (node-token-service.refreshNodeTokens, wired
 * to onPersist on both shells), not by the spawn path.
 *
 * That distinction is the whole reason this test exists: narrowing materialisation to the spawn path
 * would silently drop every phone-spawned session to `legacy`, and rev.3 of the messaging design
 * would become right by accident, after the fact, with no error anywhere.
 *
 * WHICH HARNESS (the plan offered two): this drives the REAL generated script END-TO-END against a
 * real `node:http` listener on 127.0.0.1 with the real `curl`, and asserts the headers that actually
 * arrived — the same shape as the 2026-08-15 measurement, and the stronger of the two options.
 * Sourcing the script to call `nt_hook_headers` in isolation would prove the emitter and nothing
 * about whether the POST carries it.
 *
 * The env handed to `sh` is EXACTLY the phone's — HOME + PATH (so `curl` and `head` resolve) plus
 * the two vars HookEnv.flags sets. In particular NODETERM_PERM_WAIT_SECS is deliberately absent, so
 * the script takes its normal backgrounded-POST branch; the assertions wait on the listener rather
 * than on the child, because that is what the phone's sessions really do.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildManagedScript,
  MANAGED_SCRIPT_REVISION,
  MIN_TOKEN_AWARE_REVISION
} from './hooks/managed-script'
import { nodeAuthToken, verifyNodeToken } from './node-auth-token'

const SECRET = Buffer.alloc(32, 7)

interface Received {
  url: string
  headers: Record<string, string>
  body: string
}

describe('a phone-spawned session presents its per-node token', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const curl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' })
  const available = sh.status === 0 && !sh.error && curl.status === 0

  let dir = ''
  let server: Server | null = null
  let port = 0
  let received: Received[] = []
  let waiters: (() => void)[] = []

  beforeAll(async () => {
    if (!available) return
    dir = mkdtempSync(join(tmpdir(), 'phoneid-'))
    server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v
        }
        received.push({ url: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(204)
        res.end()
        for (const w of waiters.splice(0)) w()
      })
    })
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address()
        if (addr && typeof addr === 'object') port = addr.port
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    received = []
    waiters = []
  })

  /** Resolve when one more POST has landed (or reject after `ms` — a silent script is a failure). */
  function nextPost(ms = 5000): Promise<Received> {
    if (received.length > 0) return Promise.resolve(received[received.length - 1])
    return new Promise<Received>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no POST arrived')), ms)
      waiters.push(() => {
        clearTimeout(timer)
        resolve(received[received.length - 1])
      })
    })
  }

  /**
   * The phone's own spawn, minus tmux: `sh <script>` with EXACTLY HookEnv.flags' two vars. `body`
   * is what claude pipes in on stdin.
   */
  function runPhoneHook(script: string, home: string, nodeId: string, endpoint: string): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn('sh', [script], {
        env: {
          HOME: home,
          PATH: process.env.PATH ?? '',
          NODETERM_HOOK_ENDPOINT: endpoint,
          NODETERM_NODE_ID: nodeId
        },
        stdio: ['pipe', 'ignore', 'ignore']
      })
      child.stdin.end('{"hook_event_name":"Stop","session_id":"s1"}')
      child.on('close', (code) => resolve(code ?? -1))
    })
  }

  /** A fresh $HOME so the failover glob (~/.nodeterm/hook-endpoint-*.env) finds nothing of its own. */
  function newHome(name: string): string {
    const home = join(dir, name)
    mkdirSync(join(home, '.nodeterm'), { recursive: true })
    return home
  }

  /** The 0600 endpoint file the host wrote; `tokenDir` absent reproduces a pre-v2 (v1) file. */
  function endpointFile(name: string, tokenDir: string | null, version = 2): string {
    const p = join(dir, name)
    writeFileSync(
      p,
      `NODETERM_HOOK_PORT=${port}\nNODETERM_HOOK_TOKEN=bearer-xyz\n` +
        `NODETERM_HOOK_VERSION=${version}\n` +
        (tokenDir ? `NODETERM_NODE_TOKEN_DIR=${tokenDir}\n` : ''),
      { encoding: 'utf8', mode: 0o600 }
    )
    return p
  }

  function tokenDirWith(name: string, files: Record<string, string>): string {
    const d = join(dir, name)
    mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const [nodeId, token] of Object.entries(files)) {
      writeFileSync(join(d, nodeId), `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    return d
  }

  function writeScript(name: string, source: string): string {
    const p = join(dir, name)
    writeFileSync(p, source, { encoding: 'utf8', mode: 0o755 })
    return p
  }

  it.skipIf(!available)(
    'reads the token dir out of the endpoint file it was handed, and sends the header',
    async () => {
      const token = nodeAuthToken(SECRET, 'phone-1')
      const tokens = tokenDirWith('tokens-1', { 'phone-1': token })
      const ep = endpointFile('hook-endpoint-1.env', tokens)
      const script = writeScript('hook-1.sh', buildManagedScript('claude', null))

      expect(await runPhoneHook(script, newHome('home-1'), 'phone-1', ep)).toBe(0)
      const post = await nextPost()

      expect(post.url).toBe('/hook/claude')
      expect(post.headers['x-nodeterm-node-token']).toBe(token)
      // The bearer rides the same stdin config, and the body names the node.
      expect(post.headers['x-nodeterm-hook-token']).toBe('bearer-xyz')
      expect(post.body).toContain('nodeId=phone-1')
      // The REAL verifier's verdict on what really arrived — not a re-derivation of it here.
      expect(verifyNodeToken(SECRET, 'phone-1', post.headers['x-nodeterm-node-token'])).toBe(
        'verified'
      )
    }
  )

  it.skipIf(!available)(
    'degrades to no header at all (legacy, never an error) when no token file exists',
    async () => {
      // NEGATIVE CONTROL 1 of the 2026-08-15 measurement: a node id the sweep never materialised.
      // curl drops a header whose value is empty, so "absent" and "empty" are the same wire state,
      // and the server reads both as `legacy`.
      const tokens = tokenDirWith('tokens-2', { 'phone-1': nodeAuthToken(SECRET, 'phone-1') })
      const ep = endpointFile('hook-endpoint-2.env', tokens)
      const script = writeScript('hook-2.sh', buildManagedScript('claude', null))

      expect(await runPhoneHook(script, newHome('home-2'), 'phone-2', ep)).toBe(0)
      const post = await nextPost()

      expect(post.body).toContain('nodeId=phone-2')
      expect(post.headers['x-nodeterm-node-token'] ?? '').toBe('')
      expect(verifyNodeToken(SECRET, 'phone-2', post.headers['x-nodeterm-node-token'])).toBe('legacy')
    }
  )

  it.skipIf(!available)('degrades the same way on a pre-v2 endpoint file', async () => {
    // NEGATIVE CONTROL 2: the endpoint file advertises no NODETERM_NODE_TOKEN_DIR, so there is
    // nowhere to look. Still a POST, still 204, still `legacy`.
    const ep = endpointFile('hook-endpoint-3.env', null, 1)
    const script = writeScript('hook-3.sh', buildManagedScript('claude', null))

    expect(await runPhoneHook(script, newHome('home-3'), 'phone-1', ep)).toBe(0)
    const post = await nextPost()

    expect(post.body).toContain('nodeId=phone-1')
    expect(post.headers['x-nodeterm-node-token'] ?? '').toBe('')
  })

  // ---- Finding F2: the client stamp, on the same wire, from the same phone-shaped env ----------

  it.skipIf(!available)('stamps its own revision beside the node token', async () => {
    const tokens = tokenDirWith('tokens-4', { 'phone-1': nodeAuthToken(SECRET, 'phone-1') })
    const ep = endpointFile('hook-endpoint-4.env', tokens)
    const script = writeScript('hook-4.sh', buildManagedScript('claude', null))

    expect(await runPhoneHook(script, newHome('home-4'), 'phone-1', ep)).toBe(0)
    const post = await nextPost()

    expect(post.headers['x-nodeterm-hook-client']).toBe(String(MANAGED_SCRIPT_REVISION))
    expect(Number(post.headers['x-nodeterm-hook-client'])).toBeGreaterThanOrEqual(
      MIN_TOKEN_AWARE_REVISION
    )
    expect(post.headers['x-nodeterm-node-token']).toBeTruthy()
    // The `version` field is the SERVER's protocol version, sourced from the endpoint file — which
    // is exactly why it could never answer "what is the client?" and the stamp had to exist.
    expect(post.body).toContain('version=2')
  })

  it.skipIf(!available)(
    'an OLDER script sends neither header — so a stale script and a missing token are now distinguishable',
    async () => {
      // A pre-#195 build, constructed from the current one by removing the two things it did not
      // have: the token read and the revision stamp. Both header values are then empty, curl drops
      // both, and the POST is byte-identical to what such a build really sent.
      const tokens = tokenDirWith('tokens-5', { 'phone-1': nodeAuthToken(SECRET, 'phone-1') })
      const ep = endpointFile('hook-endpoint-5.env', tokens)
      const current = buildManagedScript('claude', null)
      const old = current
        // Blanked rather than deleted: an empty header value is dropped by curl, so the wire is
        // byte-identical to a script that never had the line — while the generated sh stays valid
        // (deleting the assignment would leave an empty `if … then fi`, and a script that fails to
        // parse proves nothing about what a real old script sent).
        // The token read is a `read` redirect now (no `head` process); blank that line the same way.
        .replace(/\{ IFS= read -r nt_node_token <[^\n]*/, 'nt_node_token=""')
        .replace(/nt_client_rev=\d+\n/, '')
      expect(old).not.toContain('IFS= read -r nt_node_token')
      expect(old).not.toContain('nt_client_rev=')
      expect(old).not.toContain('$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID')
      const script = writeScript('hook-5.sh', old)

      expect(await runPhoneHook(script, newHome('home-5'), 'phone-1', ep)).toBe(0)
      const post = await nextPost()

      expect(post.body).toContain('nodeId=phone-1')
      // The defect, stated as an assertion: the token header is absent HERE for a different reason
      // than in the "no token file" case above — and only the client stamp tells them apart.
      expect(post.headers['x-nodeterm-node-token'] ?? '').toBe('')
      expect(post.headers['x-nodeterm-hook-client'] ?? '').toBe('')
    }
  )
})
