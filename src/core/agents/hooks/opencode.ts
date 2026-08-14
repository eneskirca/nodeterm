// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: a JS module in
// ~/.config/opencode/plugins/ whose exported hooks fire on session/tool/permission events.
// nodeterm owns one whole plugin file (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugin is env-gated: without the
// NODETERM_* env of a nodeterm-spawned session it returns {} and does nothing.
import fs from 'fs'
import os from 'os'
import path from 'path'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The managed plugin body. Mirrors the managed POSIX script's wire contract exactly
 *  (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no-op `{}`);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
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
 *  done-holdoff by design), pinning the node on RUNNING forever.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP, like the POSIX script's `curl --unix-socket`
 *  branch. opencode runs on Bun, whose fetch takes a `unix` option; the node:http
 *  socketPath fallback covers any non-Bun runtime (and is what the tests exercise). */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
import fs from 'node:fs'
import http from 'node:http'

export const NodetermStatus = async () => {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return {}
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
        for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
          const m = line.match(/^NODETERM_HOOK_(PORT|SOCK|TOKEN|VERSION)=(.*)$/)
          if (m) conf[m[1].toLowerCase()] = m[2]
          // The v2 endpoint line: where this instance keeps per-node tokens. It has its own
          // prefix, so it needs its own match rather than a widened NODETERM_HOOK_ group.
          const d = line.match(/^NODETERM_NODE_TOKEN_DIR=(.*)$/)
          if (d) conf.tokenDir = d[1]
        }
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
  const post = (event, extra) => {
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

export function installOpencodeHooks(): void {
  const p = pluginPath()
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return // a user's own file — never touch it
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buildOpencodePlugin(), 'utf8')
}

export function removeOpencodeHooks(): void {
  const p = pluginPath()
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
