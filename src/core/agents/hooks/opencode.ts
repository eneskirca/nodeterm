// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: JS modules in
// ~/.config/opencode/plugins/ whose hooks fire on session/tool/permission events.
// nodeterm owns its plugin files outright (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugins are env-gated: without the
// NODETERM_* env of a nodeterm-spawned session they do nothing.
//
// TWO plugin APIs exist, and one file cannot serve both (issue #1136). MEASURED, 2026-10-16:
//  - OpenCode 2.x (@opencode/cli 2.0.30) loads `plugins/*.js` AND plugin directories
//    (`plugins/<name>/index.js`) and requires a DEFAULT export object `{ id, setup }`; a module
//    without one is skipped with a WARN ("Plugin must export a default definition…"). A function
//    default is refused too ("Expected object at [\"default\"]").
//  - OpenCode 1.x loads only `{plugin,plugins}/*.{ts,js}` FILES, and up to 1.2.10 it calls EVERY
//    export as a function: an object default throws `fn is not a function` and kills every opencode
//    command on the machine, inside nodeterm or not (bisected: 1.2.10 crashes, 1.2.11 does not).
// So the V1 plugin stays a file with only the named export (V2 merely WARNs about it), and the V2
// plugin is a DIRECTORY, which no 1.x glob matches.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

/** The OpenCode 1.x plugin file. */
export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The OpenCode 2.x plugin DIRECTORY (see the header: a directory is invisible to every 1.x). */
export function v2PluginDir(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status-v2')
}

export function v2PluginPath(): string {
  return path.join(v2PluginDir(), 'index.js')
}

/** Which API armed in this process. Both plugins can end up loaded by one process (V2 loads the
 *  V1 file too and only skips it because it has no default export; a future build with a V1
 *  compatibility layer might run it). The first API to arm owns the process and the other stays
 *  inert, so no build posts every event twice. Keyed by API, not by call: one process may arm the
 *  same API more than once (one plugin instance per project directory). */
const LATCH = "Symbol.for('nodeterm.opencode.status.api')"

/** The shared poster, embedded verbatim in both plugins. Mirrors the managed POSIX script's wire
 *  contract exactly (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no poster);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP, like the POSIX script's `curl --unix-socket`
 *  branch. opencode runs on Bun, whose fetch takes a `unix` option; the node:http
 *  socketPath fallback covers any non-Bun runtime (and is what the tests exercise). */
function sharedPrelude(): string {
  return `import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware parser every TS consumer of the endpoint file uses, embedded verbatim
// (this plugin runs standalone under Bun/node — it cannot import from the app). Values are
// posixQuote'd since #351; a quote-blind read would present a token wrapped in literal quotes,
// which the hook server's constant-time bearer check rejects on every POST.
const parseEndpointEnv = ${parseEndpointEnv.toString()}

const LATCH = ${LATCH}
// true when this API may arm: nothing armed yet, or this same API armed first.
const claim = (api) => {
  const owner = globalThis[LATCH]
  if (owner && owner !== api) return false
  globalThis[LATCH] = api
  return true
}

const makePoster = () => {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return null
  const live = () => {
    const conf = {
      port: process.env.NODETERM_HOOK_PORT,
      sock: process.env.NODETERM_HOOK_SOCK,
      token: process.env.NODETERM_HOOK_TOKEN,
      version: process.env.NODETERM_HOOK_VERSION,
      tokenDir: process.env.NODETERM_NODE_TOKEN_DIR
    }
    try {
      const file = process.env.NODETERM_HOOK_ENDPOINT
      if (file) {
        const env = parseEndpointEnv(fs.readFileSync(file, 'utf8'))
        if ('NODETERM_HOOK_PORT' in env) conf.port = env.NODETERM_HOOK_PORT
        if ('NODETERM_HOOK_SOCK' in env) conf.sock = env.NODETERM_HOOK_SOCK
        if ('NODETERM_HOOK_TOKEN' in env) conf.token = env.NODETERM_HOOK_TOKEN
        if ('NODETERM_HOOK_VERSION' in env) conf.version = env.NODETERM_HOOK_VERSION
        // The v2 endpoint line: where this instance keeps per-node tokens.
        if ('NODETERM_NODE_TOKEN_DIR' in env) conf.tokenDir = env.NODETERM_NODE_TOKEN_DIR
      }
    } catch {}
    return conf
  }
  // The PER-NODE capability, read fresh per POST from <dir>/<nodeId> — a lookup by name, never a
  // scan, so this session can only ever present its own. Missing (pre-v2 endpoint, a node whose
  // token was never materialised) is an ordinary state: the header goes out EMPTY and the server
  // reads that as legacy, exactly like every client that predates this.
  const nodeToken = (dir) => {
    try {
      if (!dir) return ''
      return fs.readFileSync(dir + '/' + nodeId, 'utf8').split('\\n')[0].trim()
    } catch {
      return ''
    }
  }
  return (event, extra) => {
    try {
      const { port, sock, token, version, tokenDir } = live()
      if (!token || (!sock && !port)) return
      const payload = JSON.stringify({ event, ...extra })
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-hook-token': token,
        'x-nodeterm-node-token': nodeToken(tokenDir)
      }
      const body =
        'nodeId=' + encodeURIComponent(nodeId) +
        '&version=' + encodeURIComponent(version || '') +
        '&payload=' + encodeURIComponent(payload)
      if (sock && typeof Bun !== 'undefined') {
        fetch('http://localhost/hook/opencode', { method: 'POST', unix: sock, headers, body }).catch(() => {})
      } else if (sock) {
        const req = http.request(
          { socketPath: sock, path: '/hook/opencode', method: 'POST', headers },
          (res) => res.resume()
        )
        req.on('error', () => {})
        req.end(body)
      } else {
        fetch('http://127.0.0.1:' + port + '/hook/opencode', { method: 'POST', headers, body }).catch(() => {})
      }
    } catch {}
  }
}
`
}

/** The OpenCode 1.x plugin: ONLY the named export — never a default (see the header).
 *  Bus events (session.created/idle/error, message.updated, permission.updated/replied)
 *  reach a plugin ONLY through the `event` catch-all hook as { event: { type, properties } }
 *  — opencode never calls a hook keyed by the event name itself, so per-event-name exports
 *  are dead code (the bug that made every status silently missing). `tool.execute.before`
 *  is the exception: it IS a real named plugin hook. The event NAME posted is the contract
 *  with normalizeOpencode (permission.updated is posted as `permission.asked`);
 *  sessionID/role are extracted defensively per the SDK payload shapes. message.updated
 *  forwards ONLY user messages (turn start) so assistant token streaming never floods the
 *  hook server — and only ONCE per messageID: measured on 1.18.3 (TUI), the user message
 *  record is updated again after session.idle (title/bookkeeping), and re-forwarding that
 *  as a turn start resurrected `working` right after `done` (newTurn bypasses the
 *  done-holdoff by design), pinning the node on RUNNING forever. */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
// OpenCode 1.x plugin. OpenCode 2.x logs "failed to load plugin … must export a default
// definition" for this file at every start: expected and harmless — 2.x is served by the
// nodeterm-status-v2/ directory beside it. A default export here would crash opencode <= 1.2.10.
${sharedPrelude()}
export const NodetermStatus = async () => {
  const post = makePoster()
  if (!post) return {}
  if (!claim('v1')) return {}
  const seenUserMsgs = new Set()
  return {
    event: async (input) => {
      const ev = input && input.event
      if (!ev || !ev.type) return
      const p = ev.properties || {}
      const info = p.info || {}
      switch (ev.type) {
        case 'session.created':
          return post('session.created', { sessionID: info.id || p.sessionID })
        case 'session.idle':
        case 'session.error':
          return post(ev.type, { sessionID: p.sessionID })
        case 'permission.updated':
          return post('permission.asked', { sessionID: p.sessionID })
        case 'permission.replied':
          return post('permission.replied', { sessionID: p.sessionID })
        // The question (elicitation) dialog blocks the turn WITHOUT idling the session —
        // unforwarded, the badge sat on RUNNING while the TUI waited for an answer.
        case 'question.asked':
        case 'question.replied':
        case 'question.rejected':
          return post(ev.type, { sessionID: p.sessionID })
        case 'message.updated': {
          if ((info.role || p.role) !== 'user') return
          if (info.id) {
            if (seenUserMsgs.has(info.id)) return
            seenUserMsgs.add(info.id)
            if (seenUserMsgs.size > 500) {
              for (const first of seenUserMsgs) { seenUserMsgs.delete(first); break }
            }
          }
          return post('message.updated', { sessionID: info.sessionID || p.sessionID, role: 'user' })
        }
      }
    },
    'tool.execute.before': async (input) =>
      post('tool.execute.before', { sessionID: input && input.sessionID })
  }
}
`
}

/** The OpenCode 2.x plugin: a default `{ id, setup }` (the only shape 2.x accepts). MEASURED on
 *  @opencode/cli 2.0.30 (TUI and `run`, both `--standalone`):
 *  - `setup(ctx)` runs in the SERVER process; `ctx.event.subscribe()` is an async iterable of
 *    `{ id, created, type, location, data }`; `ctx.tool.hook('execute.before', cb)` hands cb
 *    `{ tool, sessionID, … }` and fires BEFORE that call's permission.asked;
 *  - a turn is `session.execution.started` … `session.execution.succeeded | failed | interrupted`
 *    (Esc) — there is no `session.idle` any more; questions are forms (`form.created` carries the
 *    session under `data.form`, `form.replied|cancelled` under `data`);
 *  - `session.created` carries `parentID` for a subagent's child session.
 *  Every event is translated to the 1.x wire names above, so normalizeOpencode has one dialect:
 *  execution.started → message.updated (user), succeeded|interrupted → session.idle, failed →
 *  session.error, form.* → question.*.
 *  THE SHARED SERVER: by default every 2.x CLI talks to ONE background server (`serve --service`)
 *  that keeps the environment of whichever pane started it and outlives it (MEASURED: a second
 *  pane's events ran under the first pane's NODETERM_NODE_ID). Posting from there would paint one
 *  node's status on another, so the plugin refuses to run in it. Only a `--standalone` server (the
 *  pane's own child, `serve --stdio`, which inherits the pane's env) reports. */
export function buildOpencodeV2Plugin(): string {
  return `${PLUGIN_MARKER}
// OpenCode 2.x plugin (a directory, so that no OpenCode 1.x ever loads it).
${sharedPrelude()}
// A subagent runs in a CHILD session (session.created carries parentID). Its turn boundaries are
// not the node's — a child's execution.started would re-key the node to the child's session and
// its succeeded would read as the node going idle mid-turn — but a child's permission or form
// DOES block the node's work, so those are forwarded under the root session id.
const translate = (post, children) => {
  const root = (id) => {
    let cur = id
    for (let i = 0; i < 16 && cur && children.has(cur); i++) cur = children.get(cur)
    return cur
  }
  return (ev) => {
    if (!ev || typeof ev.type !== 'string') return
    const d = ev.data || {}
    const sid = typeof d.sessionID === 'string' ? d.sessionID : undefined
    switch (ev.type) {
      case 'session.created':
        if (sid && typeof d.parentID === 'string' && d.parentID) {
          children.set(sid, d.parentID)
          if (children.size > 500) {
            for (const first of children.keys()) { children.delete(first); break }
          }
          return
        }
        return post('session.created', { sessionID: sid })
      case 'session.execution.started':
        if (sid && children.has(sid)) return
        return post('message.updated', { sessionID: sid, role: 'user' })
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        if (sid && children.has(sid)) return
        return post('session.idle', { sessionID: sid })
      case 'session.execution.failed':
        if (sid && children.has(sid)) return
        return post('session.error', { sessionID: sid })
      case 'permission.asked':
      case 'permission.replied':
        return post(ev.type, { sessionID: root(sid) })
      case 'form.created': {
        const f = d.form || {}
        return post('question.asked', { sessionID: root(typeof f.sessionID === 'string' ? f.sessionID : sid) })
      }
      case 'form.replied':
        return post('question.replied', { sessionID: root(sid) })
      case 'form.cancelled':
        return post('question.rejected', { sessionID: root(sid) })
    }
  }
}

export default {
  id: 'nodeterm-status',
  async setup(ctx) {
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return
    // The shared background server's env belongs to whichever pane started it (see above).
    const argv = (typeof process !== 'undefined' && process.argv) || []
    if (argv.includes('--service')) return
    const post = makePoster()
    if (!post) return
    if (!claim('v2')) return
    const children = new Map()
    const onEvent = translate(post, children)
    const controller = new AbortController()
    ;(async () => {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        try { onEvent(ev) } catch {}
      }
    })().catch(() => {})
    try {
      if (ctx.tool && typeof ctx.tool.hook === 'function') {
        // A throw here would FAIL the tool call (execute.before may reject one) — never throw.
        await ctx.tool.hook('execute.before', (input) => {
          try {
            const sid = input && input.sessionID
            if (sid && children.has(sid)) return
            post('tool.execute.before', { sessionID: sid })
          } catch {}
        })
      }
    } catch {}
    return () => controller.abort()
  }
}
`
}

/** Write `body` to `file` unless a file WITHOUT our marker is there (a user's own — never touched). */
function plantManaged(file: string, body: string): void {
  try {
    const existing = fs.readFileSync(file, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return
    if (existing === body) return
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}

export function installOpencodeHooks(): void {
  plantManaged(pluginPath(), buildOpencodePlugin())
  plantManaged(v2PluginPath(), buildOpencodeV2Plugin())
}

function removeManaged(file: string): void {
  try {
    if (fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(file, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}

export function removeOpencodeHooks(): void {
  removeManaged(pluginPath())
  removeManaged(v2PluginPath())
  // The directory is ours by name; drop it only when nothing of anyone else's is left in it.
  try {
    fs.rmdirSync(v2PluginDir())
  } catch {
    /* absent, or not empty — leave it */
  }
}
