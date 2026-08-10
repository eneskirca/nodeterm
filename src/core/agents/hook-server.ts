import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { writeFileSync, mkdirSync } from 'fs'
import path from 'path'
import { platform } from '../platform'
import { canControlCanvas, type AgentId } from '../../shared/agents/config'
import { normalizeFor, type NormalizedAgentEvent } from '../../shared/agents/normalize'

export const NODETERM_HOOK_PROTOCOL_VERSION = '1'
const SLOWLORIS_MS = 2000

// Default seconds the managed permission hook holds for a phone/canvas answer before falling
// through to Claude's interactive prompt (must stay under Claude's own hook timeout). Injected
// into a claude session's env as NODETERM_PERM_WAIT_SECS when hook-reply approvals are enabled.
// See docs/hook-reply-approvals.md.
export const PERM_WAIT_SECS_DEFAULT = 45

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    // Collect Buffers and decode ONCE at the end: `data += chunk` coerced every chunk through
    // a string concat (quadratic churn on big bodies) and could split a multibyte UTF-8
    // sequence at a chunk boundary, corrupting the decoded text.
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (c: Buffer) => {
      chunks.push(c)
      bytes += c.length
      if (bytes > 5_000_000) req.destroy() // cap absurd bodies
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(''))
  })
}

// Parses application/x-www-form-urlencoded bodies (what the managed script posts).
function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    const i = pair.indexOf('=')
    if (i < 0) continue
    out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '))
  }
  return out
}

/**
 * Read a /control/ request body in either dialect. The POSIX-sh shim — since it retired the Node
 * CLI, the only client there is — sends form-urlencoded: `nodeId` plus one `arg.<name>` field per
 * flag, because `curl --data-urlencode` is the only escaping sh can be trusted with (hand-built
 * JSON would break on the first quote in a `--prompt` or `--html` value). The JSON dialect is
 * kept because the route is a stable local API that a session predating an app upgrade may still
 * be holding a copy of. Exported for tests.
 */
export function parseControlBody(
  raw: string,
  contentType: string
): { nodeId: string; args: Record<string, string> } {
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = parseForm(raw)
    const args: Record<string, string> = {}
    for (const [k, v] of Object.entries(form)) {
      if (k.startsWith('arg.') && k.length > 4) args[k.slice(4)] = v
    }
    return { nodeId: form.nodeId ?? '', args }
  }
  try {
    const parsed = JSON.parse(raw) as { nodeId?: string; args?: Record<string, string> }
    return { nodeId: parsed.nodeId ?? '', args: parsed.args ?? {} }
  } catch {
    return { nodeId: '', args: {} }
  }
}

class HookServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private listener: ((e: NormalizedAgentEvent) => void) | null = null
  private rawListener: ((agentId: string, nodeId: string, payload: Record<string, unknown>) => void) | null = null
  private controlHandler:
    | ((cmd: { verb: string; nodeId: string; args: Record<string, string> }) => Promise<{
        ok: boolean
        message?: string
        result?: unknown
        error?: string
      }>)
    | null = null
  // Context-link reads. Same shape as the control handler, but it answers with TEXT (a rendered
  // transcript / summary / terminal capture) rather than acting on the canvas.
  private contextLinkHandler:
    | ((req: { verb: string; nodeId: string; args: Record<string, string> }) => Promise<string>)
    | null = null
  private endpointPath = ''

  endpointFilePath(): string {
    if (!this.endpointPath) this.endpointPath = path.join(platform().userDataDir, 'hook-endpoint.env')
    return this.endpointPath
  }

  getPort(): number {
    return this.port
  }
  getToken(): string {
    return this.token
  }
  getVersion(): string {
    return NODETERM_HOOK_PROTOCOL_VERSION
  }

  setListener(cb: (e: NormalizedAgentEvent) => void): void {
    this.listener = cb
  }

  // Raw payload listener: receives the parsed (un-normalized) hook JSON. Drives the
  // contextTail/subagentTail features, which need transcript_path (not in NormalizedAgentEvent).
  setRawListener(cb: (agentId: string, nodeId: string, payload: Record<string, unknown>) => void): void {
    this.rawListener = cb
  }

  setControlHandler(cb: NonNullable<HookServer['controlHandler']>): void {
    this.controlHandler = cb
  }

  setContextLinkHandler(cb: NonNullable<HookServer['contextLinkHandler']>): void {
    this.contextLinkHandler = cb
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomUUID()
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Hooks fail open: any error path still ends 204 so a broken hook never blocks the agent.
      try {
        if (req.method !== 'POST') {
          res.writeHead(404)
          res.end()
          return
        }
        if (!this.tokenMatches(req.headers['x-nodeterm-hook-token'])) {
          res.writeHead(403)
          res.end()
          return
        }
        req.setTimeout(SLOWLORIS_MS, () => req.destroy())
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (reqUrl.pathname.startsWith('/control/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/control\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Body fully received: disarm the slowloris guard. A destructive
          // control verb legitimately parks here while the renderer waits for
          // the user's confirmation (up to the 120s control timeout), and the
          // receive-phase guard used to destroy the socket after 2s of that
          // wait -- the caller saw "endpoint unreachable" while the dialog
          // was still up.
          req.setTimeout(0)
          const result = this.controlHandler
            ? await this.controlHandler({ verb, nodeId, args })
            : { ok: false, error: 'control unavailable' }
          // The POSIX-sh shim asks for text/plain: it has no JSON parser, so the server does the
          // rendering the Node CLI used to do client-side. Everything else keeps the JSON shape.
          if (String(req.headers.accept ?? '').includes('text/plain')) {
            const text = result.ok
              ? result.message ?? JSON.stringify(result.result ?? {})
              : result.error ?? 'control request failed'
            res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`${text}\n`)
            return
          }
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
          return
        }
        if (reqUrl.pathname.startsWith('/context-link/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/context-link\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Always text: the caller is the sh shim, and the payload IS prose (a rendered
          // transcript). The handler owns the authorization — see context-link.ts.
          // Disarm the receive-phase guard here too: a linked-transcript
          // read over SSH can take longer than 2s to render its response.
          req.setTimeout(0)
          const text = this.contextLinkHandler
            ? await this.contextLinkHandler({ verb, nodeId, args })
            : 'Context link is unavailable in this session.'
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`${text}\n`)
          return
        }
        const agentId = decodeURIComponent(reqUrl.pathname.replace(/^\/hook\//, ''))
        const form = parseForm(await readBody(req))
        const nodeId = form.nodeId ?? ''
        if (agentId && nodeId && form.payload) {
          let payload: Record<string, unknown> = {}
          try {
            payload = JSON.parse(form.payload) as Record<string, unknown>
          } catch {
            payload = {}
          }
          // Deterministic-approval ticket: the managed permission hook adds `nodeterm_pending_id`
          // as a separate form field (it can't edit the agent's JSON payload in POSIX sh). Merge it
          // into the payload object so both the raw listener and the normalizers see it as if it
          // rode inside the hook JSON. See docs/hook-reply-approvals.md.
          if (form.nodeterm_pending_id) payload.nodeterm_pending_id = form.nodeterm_pending_id
          // Same treatment for the "answered" signal the wait branch fires on a valid allow/deny
          // answer (a separate form field it can't fold into the agent's JSON in POSIX sh). Merged
          // so the normalizer sees it and maps it to a synthetic working transition. See
          // docs/hook-reply-approvals.md.
          if (form.nodeterm_answered) payload.nodeterm_answered = form.nodeterm_answered
          // Raw listener first: it drives the transcript-tailing features (which need
          // transcript_path). Inside the try so a throwing raw listener still ends 204.
          this.rawListener?.(agentId, nodeId, payload)
          const normalized = normalizeFor(agentId, { nodeId, agentId, payload })
          if (normalized && this.listener) this.listener(normalized)
        }
        res.writeHead(204)
        res.end()
      } catch {
        res.writeHead(204)
        res.end()
      }
    })
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => {
        this.server?.off('listening', onOk)
        reject(e)
      }
      const onOk = (): void => {
        this.server?.off('error', onErr)
        this.server?.on('error', (e) => console.error('[agent-hooks] server error', e))
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        this.writeEndpointFile()
        resolve()
      }
      this.server!.once('error', onErr)
      this.server!.listen(0, '127.0.0.1', onOk)
    })
  }

  // Constant-time bearer-token check (avoids a timing side channel on the compare).
  private tokenMatches(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string' || !this.token) return false
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // The managed script sources this file at invocation to get the LIVE port/token.
  // tmux sessions outlive the app, so env-baked coords go stale after a restart.
  private writeEndpointFile(): void {
    try {
      const p = this.endpointFilePath()
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(
        p,
        `NODETERM_HOOK_PORT=${this.port}\nNODETERM_HOOK_TOKEN=${this.token}\nNODETERM_HOOK_VERSION=${NODETERM_HOOK_PROTOCOL_VERSION}\n`,
        // 0o600: this file holds the bearer token — owner read/write only so another local user
        // can't read it and forge hook events.
        { encoding: 'utf8', mode: 0o600 }
      )
    } catch (e) {
      console.warn('[agent-hooks] could not write endpoint file', e)
    }
  }

  // `permWaitSecs > 0` opts this session into the deterministic hook-reply approval flow: the
  // managed permission hook holds for that many seconds for a phone/canvas answer file before
  // falling through to Claude's interactive prompt. 0/undefined ⇒ NODETERM_PERM_WAIT_SECS absent ⇒
  // the hook's wait-branch is inert (exact legacy behavior). See docs/hook-reply-approvals.md.
  buildPtyEnv(nodeId: string, agentId: AgentId, permWaitSecs = 0): Record<string, string> {
    if (this.port <= 0 || !this.token) return {}
    return {
      NODETERM_HOOK_PORT: String(this.port),
      NODETERM_HOOK_TOKEN: this.token,
      NODETERM_HOOK_VERSION: NODETERM_HOOK_PROTOCOL_VERSION,
      NODETERM_HOOK_ENDPOINT: this.endpointFilePath(),
      NODETERM_NODE_ID: nodeId,
      NODETERM_AGENT_ID: agentId,
      ...(permWaitSecs > 0 ? { NODETERM_PERM_WAIT_SECS: String(permWaitSecs) } : {}),
      ...(canControlCanvas(agentId) ? { NODETERM_CANVAS_CONTROL: '1' } : {})
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
  }
}

export const hookServer = new HookServer()
