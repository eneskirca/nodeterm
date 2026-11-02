// omp hook service. omp's hook seam is ambient discovery: a default-exported factory dropped in
// ~/.omp/agent/hooks/pre/*.js is loaded into every session (docs: hooks.md / extensions.md —
// the factory receives the ExtensionAPI and binds handlers with pi.on(...)).
// nodeterm owns its hook file outright (marker-gated — a user's own file is never touched).
// omp runs the factory in nodeterm-spawned panes AND bare terminals alike, so the plugin is
// env-gated: without the NODETERM_NODE_ID of a nodeterm-spawned session it does nothing.
//
// The plugin posts the OPENCODE dialect deliberately (session.created / message.updated{user} /
// permission.* / tool.execute.before / session.idle): normalizeOpencode then serves both agents,
// and the whole receiving tract (statuses, notifications, kanban) is reused as-is — one
// normalizer, one wire contract, two integrations.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'

export const HOOK_MARKER = '// nodeterm managed hook — do not edit (reinstalled at app launch)'

/** omp's agent dir is PI_CODING_AGENT_DIR-aware (docs: hooks.md, native discovery): honour it the
 *  same way omp resolves it, else the hook lands where omp never looks. A relative value is
 *  cwd-dependent — refuse it rather than plant the file somewhere cwd-shifting. */
export function ompAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR
  return dir && path.isAbsolute(dir) ? dir : path.join(os.homedir(), '.omp', 'agent')
}
export function ompHookDir(): string {
  return path.join(ompAgentDir(), 'hooks', 'pre')
}

export function ompHookPath(): string {
  return path.join(ompHookDir(), 'nodeterm-status.js')
}

/** The skills root omp discovers `SKILL.md` bundles under (the same agent dir as the hooks). */
export function ompSkillsDir(): string {
  return path.join(ompAgentDir(), 'skills')
}

/** The poster, embedded verbatim in the plugin. Mirrors the opencode plugin's wire contract
 *  exactly (see hooks/opencode.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no poster);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/omp.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP. omp runs on Bun, whose fetch takes a `unix`
 *  option; the node:http socketPath fallback covers any non-Bun runtime (and is what the
 *  tests exercise). */
function sharedPrelude(): string {
  return `import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware parser every TS consumer of the endpoint file uses, embedded verbatim
// (this plugin runs standalone under Bun/node — it cannot import from the app). Values are
// posixQuote'd since #351; a quote-blind read would present a token wrapped in literal quotes,
// which the hook server's constant-time bearer check rejects on every POST.
const parseEndpointEnv = ${parseEndpointEnv.toString()}

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
  // scan, so this session can only ever present its own. Missing is an ordinary state: the header
  // goes out EMPTY and the server reads that as legacy, exactly like every client that predates it.
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
        fetch('http://localhost/hook/omp', { method: 'POST', unix: sock, headers, body }).catch(() => {})
      } else if (sock) {
        const req = http.request(
          { socketPath: sock, path: '/hook/omp', method: 'POST', headers },
          (res) => res.resume()
        )
        req.on('error', () => {})
        req.end(body)
      } else {
        fetch('http://127.0.0.1:' + port + '/hook/omp', { method: 'POST', headers, body }).catch(() => {})
      }
    } catch {}
  }
}
`
}

/** The omp hook plugin: a default factory (the ONLY shape ambient discovery accepts — hooks.md).
 *  omp events → opencode wire names, so normalizeOpencode has one dialect:
 *  session_start → session.created, turn_start → message.updated (user), the ask tool's
 *  call/result pair → permission.asked/replied, other tool calls → tool.execute.before,
 *  turn_end and agent_end → session.idle (idempotent belt-and-braces: turn_end lands mid-run
 *  between model rounds, but the working that follows — the next tool call or turn start —
 *  overtakes it inside the server's done-holdoff, so only the real end of the run publishes done).
 *  session_shutdown is NOT posted: the pane process exiting is what the liveness watcher sees
 *  anyway, and a shutdown post racing the pane's death would be dropped. Every handler swallows
 *  its own errors: the runner contains throws for notification events, but tool_call handler
 *  errors PROPAGATE and would fail the tool call — a status post must never cost omp a tool. */
export function buildOmpHookPlugin(): string {
  return `${HOOK_MARKER}
// omp → nodeterm status. No-ops outside nodeterm (no NODETERM_NODE_ID → no poster).
${sharedPrelude()}
export default function (pi) {
  const post = makePoster()
  if (!post) return
  let sid = ''
  let awaitingAsk = false
  // The wire sessionID must be the bare omp session id, NOT the file path: nodeterm's chat reader
  // locates transcripts by id (SESSION_ID_RE rejects anything with separators). omp's file name is
  // an ISO timestamp, an underscore, then the session id, with a .jsonl extension, so the id is
  // parsed back out of the basename; the path is kept as fallback for a runtime that names files
  // differently.
  const session = (ctx) => {
    try {
      const f = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile()
      if (f) {
        const base = f.slice(Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\\\')) + 1)
        const m = base.match(/_([0-9a-fA-F-]{8,64})\.jsonl$/)
        sid = m ? m[1] : base
      }
    } catch {}
    return sid
  }
  pi.on('session_start', async (_e, ctx) => {
    try { post('session.created', { sessionID: session(ctx) }) } catch {}
  })
  pi.on('turn_start', async (_e, ctx) => {
    try { post('message.updated', { sessionID: session(ctx), role: 'user' }) } catch {}
  })
  pi.on('tool_call', async (e, ctx) => {
    try {
      if (e && e.toolName === 'ask') {
        awaitingAsk = true
        return post('permission.asked', { sessionID: session(ctx) })
      }
      return post('tool.execute.before', { sessionID: session(ctx) })
    } catch {}
  })
  pi.on('tool_result', async (_e, ctx) => {
    try {
      if (!awaitingAsk) return
      awaitingAsk = false
      return post('permission.replied', { sessionID: session(ctx) })
    } catch {}
  })
  pi.on('turn_end', async (_e, ctx) => {
    try { post('session.idle', { sessionID: session(ctx) }) } catch {}
  })
  pi.on('agent_end', async (_e, ctx) => {
    try { post('session.idle', { sessionID: session(ctx) }) } catch {}
  })
}
`
}

/** Write `body` to `file` unless a file WITHOUT our marker is there (a user's own — never touched). */
function plantManaged(file: string, body: string): void {
  try {
    const existing = fs.readFileSync(file, 'utf8')
    if (!existing.startsWith(HOOK_MARKER)) return
    if (existing === body) return
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
}

export function installOmpHooks(): void {
  plantManaged(ompHookPath(), buildOmpHookPlugin())
}

function removeManaged(file: string): void {
  try {
    if (fs.readFileSync(file, 'utf8').startsWith(HOOK_MARKER)) fs.rmSync(file, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}

export function removeOmpHooks(): void {
  removeManaged(ompHookPath())
}
