import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_MARKER,
  buildOpencodePlugin,
  buildOpencodeV2Plugin,
  installOpencodeHooks,
  opencodeConfigDir,
  pluginPath,
  removeOpencodeHooks,
  v2PluginPath
} from './opencode'
import { normalizeOpencode } from '../../../shared/agents/normalize'

// Both generated plugins share one process-wide latch (which plugin API armed first). Every test
// loads fresh module copies into the SAME process, so the latch is reset before each one.
const LATCH = Symbol.for('nodeterm.opencode.status.api')
const g = globalThis as unknown as Record<symbol, unknown>

let tmp: string
beforeEach(() => {
  delete g[LATCH]
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  // CI runners export XDG_CONFIG_HOME (GitHub Actions: /home/runner/.config), which wins
  // over the mocked homedir in opencodeConfigDir() — the installer then writes outside the
  // temp dir and every read here misses. Clear it so the homedir fallback is what's tested;
  // the XDG describe block below stubs its own value on top.
  vi.stubEnv('XDG_CONFIG_HOME', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const planted = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js')

describe('opencode plugin install', () => {
  it('writes the marker-bearing plugin file (idempotent)', () => {
    installOpencodeHooks()
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user file without the marker', () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing file', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
  })
  it('generated plugin is env-gated and fail-open', () => {
    const body = buildOpencodePlugin()
    expect(body).toContain('return {}') // missing env → no-op
    expect(body).toContain('catch') // POSTs never throw into opencode
  })
})

// Execute the generated plugin body against SDK-shaped inputs. opencode delivers bus
// events (session.created/idle/error, message.updated, permission.*) ONLY through the
// `event` catch-all hook — a hook keyed by the event name itself is never called (the
// original bug: every handler was dead, so no status ever reached the hook server).
describe('generated plugin behavior (executed)', () => {
  let posts: Array<{ url: string; payload: Record<string, unknown>; nodeId: string }>

  async function loadHooks(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    posts = []
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      const params = new URLSearchParams(init.body)
      posts.push({
        url,
        nodeId: params.get('nodeId') ?? '',
        payload: JSON.parse(params.get('payload') ?? '{}')
      })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    // A developer may be running this test from a live nodeterm PTY. Never let the
    // generated plugin inherit that session's socket and post test events to it.
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
    const file = path.join(tmp, `plugin-under-test-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    return mod.NodetermStatus()
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('forwards bus events through the `event` catch-all with the wire-contract names', async () => {
    const hooks = await loadHooks()
    expect(typeof hooks.event).toBe('function')

    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_1' } } } })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await hooks.event({ event: { type: 'session.error', properties: { sessionID: 'ses_1' } } })
    await hooks.event({ event: { type: 'permission.updated', properties: { id: 'perm1', sessionID: 'ses_1' } } })
    await hooks.event({
      event: { type: 'permission.replied', properties: { sessionID: 'ses_1', permissionID: 'perm1', response: 'once' } }
    })
    // The question (elicitation) flow, measured on 1.18.3: the TUI dialog blocks the turn
    // but the session never goes idle, so without these the badge sat on RUNNING.
    await hooks.event({
      event: { type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_1', questions: [] } }
    })
    await hooks.event({
      event: { type: 'question.replied', properties: { sessionID: 'ses_1', requestID: 'que_1', answers: [['Red']] } }
    })
    await hooks.event({
      event: { type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } }
    })

    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'session.created', sessionID: 'ses_1' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'session.error', sessionID: 'ses_1' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' },
      { event: 'question.rejected', sessionID: 'ses_1' }
    ])
    expect(posts[0].url).toBe('http://127.0.0.1:43210/hook/opencode')
    expect(posts[0].nodeId).toBe('node-1')
  })

  it('forwards message.updated only for user messages (turn start)', async () => {
    const hooks = await loadHooks()
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { id: 'm1', sessionID: 'ses_1', role: 'user' } } }
    })
    await hooks.event({
      event: { type: 'message.updated', properties: { info: { id: 'm2', sessionID: 'ses_1', role: 'assistant' } } }
    })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'message.updated', sessionID: 'ses_1', role: 'user' }])
  })

  it('posts a user message.updated ONCE per messageID — later updates of the same message are not new turns', async () => {
    // Measured on opencode 1.18.3 (TUI): the user message record is updated again both at
    // turn start (created → completed) and AFTER session.idle (title/bookkeeping touch).
    // Each re-forward became working+newTurn, which bypasses the done-holdoff by design —
    // so the node bounced back to RUNNING right after done and stuck there forever.
    const hooks = await loadHooks()
    const user = (id: string) => ({
      event: { type: 'message.updated', properties: { info: { id, sessionID: 'ses_1', role: 'user' } } }
    })
    await hooks.event(user('m1'))
    await hooks.event(user('m1')) // turn-start double fire
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    await hooks.event(user('m1')) // post-idle bookkeeping touch — must NOT resurrect the turn
    await hooks.event(user('m2')) // a genuinely new prompt still counts
    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' }
    ])
  })

  it('ignores unrelated bus events (token-stream deltas never reach the hook server)', async () => {
    const hooks = await loadHooks()
    await hooks.event({ event: { type: 'message.part.delta', properties: {} } })
    await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses_1' } } } })
    expect(posts).toEqual([])
  })

  it('posts tool.execute.before from the real plugin hook of that name', async () => {
    const hooks = await loadHooks()
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c1' })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'tool.execute.before', sessionID: 'ses_1' }])
  })
})

// SSH hosts advertise a UNIX SOCKET (NODETERM_HOOK_SOCK), not a TCP port — the endpoint
// file on a remote host has no PORT line at all. The POSIX managed script posts with
// `curl --unix-socket`; the plugin must speak the socket too or every opencode status
// on an SSH project silently vanishes (fetch can't do unix sockets in Node — node:http
// socketPath is the fallback; under Bun (opencode's runtime) fetch takes `unix`).
describe('generated plugin unix-socket transport', () => {
  let sockDir: string
  beforeEach(() => {
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-sock-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    const file = path.join(tmp, `plugin-sock-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    return mod.NodetermStatus()
  }

  it('posts over the unix socket via node:http when NODETERM_HOOK_SOCK is set (no port)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<{ url: string; token: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', token: String(req.headers['x-nodeterm-hook-token']), body })
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0].url).toBe('/hook/opencode')
      expect(received[0].token).toBe('socktok')
      const params = new URLSearchParams(received[0].body)
      expect(params.get('nodeId')).toBe('node-ssh')
      expect(JSON.parse(params.get('payload') ?? '{}')).toEqual({ event: 'session.idle', sessionID: 'ses_ssh' })
    } finally {
      server.close()
    }
  })

  it('reads NODETERM_HOOK_SOCK from the live endpoint file (restart handoff) and prefers it over a TCP port', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook2.sock')
    const received: string[] = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(req.url ?? '')
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const tcpFetch = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('fetch', tcpFetch)
    try {
      const envFile = path.join(sockDir, 'hook-endpoint.env')
      fs.writeFileSync(envFile, `NODETERM_HOOK_SOCK=${sock}\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=1\n`)
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', envFile)
      vi.stubEnv('NODETERM_HOOK_PORT', '59999') // stale env port — socket from the file must win
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'stale')
      vi.stubEnv('NODETERM_HOOK_SOCK', '')
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(tcpFetch).not.toHaveBeenCalled()
    } finally {
      server.close()
    }
  })

  it('uses Bun fetch with the `unix` option when running under Bun', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_ssh' } } })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('http://localhost/hook/opencode')
    expect(calls[0].init.unix).toBe('/tmp/some.sock')
  })
})

// The per-node token (task A10). The plugin is the one client that is not sh: it must learn the
// token dir from the SAME endpoint file (a new KEY=VALUE line the file's regex has to accept),
// read `<dir>/<nodeId>`, and put the header on BOTH transports — the Bun `fetch` (TCP and unix)
// and the node:http socketPath fallback.
describe('generated plugin presents the per-node token', () => {
  let tokenDir: string
  let sockDir: string

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tok-'))
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tsock-'))
    fs.writeFileSync(path.join(tokenDir, 'node-1'), 'OPENCODE-NODE-TOKEN\n', { mode: 0o600 })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(tokenDir, { recursive: true, force: true })
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<Record<string, (input: unknown) => Promise<void>>> {
    const file = path.join(tmp, `plugin-token-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, buildOpencodePlugin())
    const mod = await import(/* @vite-ignore */ `file://${file}`)
    return mod.NodetermStatus()
  }

  /** Fires one event over the plain TCP `fetch` path and returns the headers it sent. */
  async function tcpHeaders(env: Record<string, string>): Promise<Record<string, string>> {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers)
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(calls.length).toBe(1)
    return calls[0]
  }

  it('sends the token on the fetch path when the file exists', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
  })

  it('sends an EMPTY token — and still posts — when there is no token file', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: path.join(tokenDir, 'nope') })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('sends an empty token when no dir is advertised at all (pre-v2 endpoint)', async () => {
    const headers = await tcpHeaders({})
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('never presents ANOTHER node\'s token file — the path is keyed by the node id', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir, NODETERM_NODE_ID: 'node-9' })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('learns the dir from the ENDPOINT FILE (the v2 line), not only the env', async () => {
    const envFile = path.join(sockDir, 'hook-endpoint.env')
    fs.writeFileSync(
      envFile,
      `NODETERM_HOOK_PORT=43210\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokenDir}\n`
    )
    const headers = await tcpHeaders({ NODETERM_HOOK_ENDPOINT: envFile, NODETERM_HOOK_PORT: '' })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
    expect(headers['x-nodeterm-hook-token']).toBe('filetok')
  })

  it('sends it on the Bun unix-fetch path too', async () => {
    const calls: Array<{ init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (_url: string, init: Record<string, unknown>) => {
      calls.push({ init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
    const hooks = await importPlugin()
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(calls.length).toBe(1)
    expect((calls[0].init.headers as Record<string, string>)['x-nodeterm-node-token']).toBe(
      'OPENCODE-NODE-TOKEN'
    )
  })

  it('sends it on the node:http socketPath path too (real unix server)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('OPENCODE-NODE-TOKEN')
    } finally {
      server.close()
    }
  })

  it('posts over node:http with an EMPTY token when the file is missing', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook-empty.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', path.join(tokenDir, 'nope'))
      const hooks = await importPlugin()
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('')
    } finally {
      server.close()
    }
  })
})

describe('opencodeConfigDir honors XDG_CONFIG_HOME', () => {
  it('lands the plugin under $XDG_CONFIG_HOME/opencode when the (absolute) env var is set', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-xdg-'))
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    try {
      expect(opencodeConfigDir()).toBe(path.join(xdg, 'opencode'))
      expect(pluginPath()).toBe(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'))
      installOpencodeHooks()
      const body = fs.readFileSync(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'), 'utf8')
      expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
      // and NOT under ~/.config
      expect(fs.existsSync(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  })
  it('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    try {
      expect(opencodeConfigDir()).toBe(path.join(tmp, '.config', 'opencode'))
      expect(pluginPath()).toBe(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

// Issue #1136. OpenCode 2.x needs a default export object `{ id, setup }`; OpenCode <= 1.2.10
// calls every export as a function and dies on an object (bisected on real builds). So there are
// TWO plugins: the 1.x file (named export only) and a 2.x DIRECTORY no 1.x glob matches.
const planted2 = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status-v2', 'index.js')

describe('opencode plugin install — the 2.x directory plugin', () => {
  it('plants both plugins, each marker-bearing, at the paths each opencode generation loads', () => {
    installOpencodeHooks()
    expect(v2PluginPath()).toBe(planted2())
    expect(fs.readFileSync(planted(), 'utf8')).toBe(buildOpencodePlugin())
    expect(fs.readFileSync(planted2(), 'utf8')).toBe(buildOpencodeV2Plugin())
    expect(fs.readFileSync(planted2(), 'utf8').startsWith(PLUGIN_MARKER)).toBe(true)
  })
  it('refreshes a stale managed copy (an older build\'s body) but never a user file', () => {
    fs.mkdirSync(path.dirname(planted2()), { recursive: true })
    fs.writeFileSync(planted2(), PLUGIN_MARKER + '\n// old body\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted2(), 'utf8')).toBe(buildOpencodeV2Plugin())
    fs.writeFileSync(planted2(), '// my own v2 plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted2(), 'utf8')).toBe('// my own v2 plugin\n')
  })
  it('does not rewrite an up-to-date file (opencode 2.x watches plugin files and reloads on change)', () => {
    installOpencodeHooks()
    const past = Math.floor(Date.now() / 1000) - 60 // whole seconds: mtimeMs is a float
    fs.utimesSync(planted2(), past, past)
    installOpencodeHooks()
    expect(Math.round(fs.statSync(planted2()).mtimeMs / 1000)).toBe(past)
  })
  it('remove deletes both managed plugins and the now-empty directory, but keeps anything else', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    expect(fs.existsSync(path.dirname(planted2()))).toBe(false)
    installOpencodeHooks()
    fs.writeFileSync(path.join(path.dirname(planted2()), 'notes.txt'), 'mine')
    removeOpencodeHooks()
    expect(fs.existsSync(planted2())).toBe(false)
    expect(fs.readFileSync(path.join(path.dirname(planted2()), 'notes.txt'), 'utf8')).toBe('mine')
  })
})

describe('generated plugins, module shapes (executed)', () => {
  let posts: Array<Record<string, unknown>>

  beforeEach(() => {
    posts = []
    vi.stubGlobal('fetch', (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(new URLSearchParams(init.body).get('payload') ?? '{}'))
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  type V1Hooks = Record<string, (input: unknown) => Promise<void>>
  type V2Def = { id: string; setup: (ctx: unknown) => Promise<(() => void) | void> }

  async function load(body: string): Promise<Record<string, unknown>> {
    const file = path.join(tmp, `plugin-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, body)
    return import(/* @vite-ignore */ `file://${file}`)
  }
  const loadV1 = async (): Promise<{ NodetermStatus: () => Promise<V1Hooks> }> =>
    (await load(buildOpencodePlugin())) as unknown as { NodetermStatus: () => Promise<V1Hooks> }
  const loadV2 = async (): Promise<V2Def> => (await load(buildOpencodeV2Plugin())).default as V2Def

  /** A 2.x context: an event stream we push into, and a tool-hook registry. */
  function v2Context(): {
    ctx: unknown
    push: (type: string, data: Record<string, unknown>) => void
    end: () => void
    toolHooks: Array<{ name: string; cb: (input: unknown) => unknown }>
    subscribed: () => number
    signal: () => AbortSignal | undefined
  } {
    const queue: unknown[] = []
    let wake: (() => void) | null = null
    let done = false
    let subs = 0
    let sig: AbortSignal | undefined
    const toolHooks: Array<{ name: string; cb: (input: unknown) => unknown }> = []
    const ctx = {
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => {
          subs++
          sig = options?.signal
          return {
            async *[Symbol.asyncIterator]() {
              for (;;) {
                if (queue.length) {
                  yield queue.shift()
                  continue
                }
                if (done || sig?.aborted) return
                await new Promise<void>((r) => (wake = r))
              }
            }
          }
        }
      },
      tool: {
        hook: async (name: string, cb: (input: unknown) => unknown) => {
          toolHooks.push({ name, cb })
          return { dispose: () => {} }
        }
      }
    }
    return {
      ctx,
      push: (type, data) => {
        queue.push({ id: 'evt_' + queue.length, created: 1, type, location: { directory: '/p' }, data })
        wake?.()
      },
      end: () => {
        done = true
        wake?.()
      },
      toolHooks,
      subscribed: () => subs,
      signal: () => sig
    }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('1.x file: ONLY the named function export — a default would crash opencode <= 1.2.10', async () => {
    const mod = await load(buildOpencodePlugin())
    // opencode <= 1.2.10 does `for (const [, fn] of Object.entries(mod)) await fn(input)`.
    expect(Object.keys(mod)).toEqual(['NodetermStatus'])
    for (const v of Object.values(mod)) expect(typeof v).toBe('function')
  })

  it('2.x directory plugin: a default OBJECT with an id and a setup function, nothing else exported', async () => {
    const mod = await load(buildOpencodeV2Plugin())
    expect(Object.keys(mod)).toEqual(['default'])
    const def = mod.default as V2Def
    expect(typeof def).toBe('object')
    expect(def.id).toBe('nodeterm-status')
    expect(typeof def.setup).toBe('function')
  })

  it('2.x: translates the event stream to the 1.x wire names normalizeOpencode reads', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(1)
    v2.push('session.created', { sessionID: 'ses_1', projectID: 'p', slug: 's', version: '2.0.30' })
    v2.push('session.inbox.enqueued', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.text.delta', { sessionID: 'ses_1', delta: 'hi' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_1', action: 'shell' })
    v2.push('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Questions' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_1', answer: { q0: 'Red' } })
    v2.push('form.created', { form: { id: 'frm_2', sessionID: 'ses_1' } })
    v2.push('form.cancelled', { id: 'frm_2', sessionID: 'ses_1' })
    v2.push('session.execution.succeeded', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.execution.interrupted', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    v2.push('session.execution.failed', { sessionID: 'ses_1', error: {} })
    await flush()
    expect(posts).toEqual([
      { event: 'session.created', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.rejected', sessionID: 'ses_1' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.error', sessionID: 'ses_1' }
    ])
    v2.end()
  })

  it('2.x: a real 2.0.30 TUI turn (as captured) normalizes to the same states as a 1.x turn', async () => {
    // The order a measured `opencode --standalone` turn produced: a shell call behind a
    // permission prompt, then a question form, then the end of the turn.
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    const hook = v2.toolHooks[0].cb
    v2.push('session.created', { sessionID: 'ses_1' })
    v2.push('session.execution.started', { sessionID: 'ses_1' })
    await flush()
    hook({ tool: 'shell', sessionID: 'ses_1' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_1' })
    v2.push('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' })
    await flush()
    hook({ tool: 'question', sessionID: 'ses_1' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_1' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_1', answer: { q0: 'Red' } })
    v2.push('session.execution.succeeded', { sessionID: 'ses_1' })
    await flush()
    const states = posts.map((payload) => {
      const n = normalizeOpencode({ nodeId: 'node-1', agentId: 'opencode', payload })
      return n && (n.kind === 'state' ? n.state + (n.newTurn ? '+newTurn' : '') : n.kind)
    })
    expect(states).toEqual([
      'session',
      'working+newTurn',
      'working',
      'blocked',
      'working',
      'working',
      'blocked',
      'working',
      'done'
    ])
    v2.end()
  })

  it('2.x: the tool hook posts tool.execute.before and never throws into the tool call', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.toolHooks.map((h) => h.name)).toEqual(['execute.before'])
    expect(() => v2.toolHooks[0].cb({ tool: 'shell', sessionID: 'ses_1', id: 'call_1' })).not.toThrow()
    expect(() => v2.toolHooks[0].cb(undefined)).not.toThrow()
    expect(posts[0]).toEqual({ event: 'tool.execute.before', sessionID: 'ses_1' })
    v2.end()
  })

  it('2.x: a subagent child session does not move the node, but its blocking prompts do (under the root id)', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    v2.push('session.created', { sessionID: 'ses_c', parentID: 'ses_1' })
    v2.push('session.created', { sessionID: 'ses_g', parentID: 'ses_c' })
    v2.push('session.execution.started', { sessionID: 'ses_c' })
    v2.push('permission.asked', { id: 'per_1', sessionID: 'ses_g' })
    v2.push('form.created', { form: { id: 'frm_1', sessionID: 'ses_c' } })
    v2.push('form.replied', { id: 'frm_1', sessionID: 'ses_c' })
    v2.push('session.execution.succeeded', { sessionID: 'ses_c' })
    await flush()
    v2.toolHooks[0].cb({ tool: 'read', sessionID: 'ses_c' })
    expect(posts).toEqual([
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' }
    ])
    v2.end()
  })

  it('2.x: stays inert inside the shared background server (`serve --service`) — its env names another pane', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    const argv = process.argv
    process.argv = ['bun', '/$bunfs/root/opencode', 'serve', '--service']
    try {
      await def.setup(v2.ctx)
    } finally {
      process.argv = argv
    }
    expect(v2.subscribed()).toBe(0)
    expect(v2.toolHooks).toEqual([])
    expect(g[LATCH]).toBeUndefined()
  })

  it('2.x: no NODETERM_NODE_ID (outside nodeterm) → no subscription, no hook', async () => {
    vi.stubEnv('NODETERM_NODE_ID', '')
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(0)
    expect(v2.toolHooks).toEqual([])
  })

  it('2.x: a context without an event stream (a 1.x compatibility pass) is a no-op', async () => {
    const def = await loadV2()
    await def.setup({ options: {}, agent: {}, catalog: {} })
    await def.setup(undefined)
    expect(g[LATCH]).toBeUndefined()
  })

  it('both plugins in ONE process: 1.x armed first keeps 2.x inert (no double posts)', async () => {
    const v1 = await loadV1()
    const hooks = await v1.NodetermStatus()
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    expect(v2.subscribed()).toBe(0)
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } })
    expect(posts).toEqual([{ event: 'session.idle', sessionID: 'ses_1' }])
  })

  it('both plugins in ONE process: 2.x armed first keeps the 1.x hooks empty', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    await def.setup(v2.ctx)
    const v1 = await loadV1()
    expect(await v1.NodetermStatus()).toEqual({})
    v2.end()
  })

  it('the latch is per API, not per call: a second plugin instance of the SAME API still arms', async () => {
    const v1 = await loadV1()
    expect(typeof (await v1.NodetermStatus()).event).toBe('function')
    expect(typeof (await v1.NodetermStatus()).event).toBe('function')
    const def = await loadV2()
    delete g[LATCH]
    const a = v2Context()
    const b = v2Context()
    await def.setup(a.ctx)
    await def.setup(b.ctx)
    expect(a.subscribed()).toBe(1)
    expect(b.subscribed()).toBe(1)
    a.end()
    b.end()
  })

  it('2.x: the cleanup setup returns aborts the subscription', async () => {
    const def = await loadV2()
    const v2 = v2Context()
    const cleanup = await def.setup(v2.ctx)
    expect(typeof cleanup).toBe('function')
    expect(v2.signal()?.aborted).toBe(false)
    ;(cleanup as () => void)()
    expect(v2.signal()?.aborted).toBe(true)
    v2.end()
  })
})
