import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomUUID, timingSafeEqual } from 'crypto'
import { writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'fs'
import path from 'path'
import { platform } from '../platform'
import { hookSockPath } from './hook-sock-path'
import { canControlCanvas, type AgentId } from '../../shared/agents/config'
import { normalizeFor, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { CodexIdentityEvent } from '../../shared/types'
import type { NodeTokenVerdict } from './node-auth-token'
import { nodeTokenDir } from './node-token-files'
import { isForeignKidToken, isSafeNodeId, verifyNodeToken } from './node-auth-token'
import { isSafeThreadId } from '../codex-identity-proxy'
import { isSafeAccountId } from '../../shared/codex-account'
import {
  controlPolicy,
  CONTEXT_LINK_POLICY_VERB,
  IDENTITY_REFUSED_NOTE,
  IDENTITY_RESTART_NOTE,
  IDENTITY_UNMINTABLE_NOTE,
  IDENTITY_UNMINTABLE_WARN_NOTE,
  STRICT_CONTROL_REFUSAL,
  STRICT_CONTROL_VERBS,
  type IdentityDecision
} from './node-identity-policy'
import { posixQuote } from '../../shared/ssh'

// v2 advertises NODETERM_NODE_TOKEN_DIR so clients read their per-node capability from a file
// rather than receiving it in argv. Nothing consumes the posted version server-side, so the bump
// is free; it is a marker a client can key on.
export const NODETERM_HOOK_PROTOCOL_VERSION = '2'
const SLOWLORIS_MS = 2000

// Once the body is fully read the slowloris guard has done its job — it exists for the RECEIVE
// phase (a client that dribbles bytes to pin a socket), not for the handler. But it is replaced
// with a HIGHER ceiling, never removed: a confirmation-gated control verb legitimately parks
// while the renderer waits for the user's answer, yet nothing may park forever. The desktop shell
// bounds a control request at 120s (`pendingControl` in src/main/index.ts) — a bound that lives
// OUTSIDE core, so a future core-side handler with no bound of its own would inherit an unbounded
// socket if this were `setTimeout(0)`. 130s sits comfortably above that, so in the desktop the
// handler's own timeout always wins and this only ever fires as a backstop.
// Exported so a caller that parks on this socket can assert its own deadline sits under it by
// RUNNING the comparison rather than by copying the number into a comment (the delivery receipt,
// `agent-message.ts`, does exactly that).
export const CONTROL_CEILING_MS = 130_000

// The context-link handler has no timeout of its own, and its remote leg reads over an SSH
// ControlMaster that can wedge (ConnectTimeout only covers the connect). Race it so the agent
// gets the same prose failure it would get from any other read error, instead of a session that
// blocks indefinitely — pre-fix the 2s destroy at least unblocked the agent's curl.
const CONTEXT_LINK_READ_MS = 30_000
const CONTEXT_LINK_TIMEOUT_TEXT = 'Could not read linked context.'

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

/**
 * Resolve to `fallback` if `p` has not settled within `ms`. The timer is always cleared, so a
 * losing race never holds the process open. There is nothing to cancel in a read already in
 * flight, so a rejection must be swallowed either way — otherwise it surfaces as an unhandled
 * rejection once the timeout has already answered. A rejection that loses no race therefore also
 * yields `fallback`, which for the context-link route means the caller reads the same prose
 * failure it gets from any other read error instead of a bare 204.
 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms)
    })
  ]).finally(() => clearTimeout(timer))
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

/**
 * `X-Nodeterm-Hook-Client` → the posting script's revision, or `undefined`.
 *
 * Strict on purpose: only an unsigned decimal integer counts. Anything else — a version string
 * someone thought would be friendlier, a duplicated header (node hands those over as an array,
 * which is not a string and so lands here as undefined), an empty value — is "no stamp", which is
 * the same answer a pre-#195 script gives. Guessing a number out of "v3-beta" would be inventing
 * evidence for a gate.
 */
function parseClientRevision(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * What the hook server knows about the POST an event arrived on, beyond the event itself.
 *
 * `verified` = the caller presented a per-node token THIS instance minted for THAT node id. It is
 * a LABEL, nothing more: `false` is the overwhelmingly common, entirely legitimate case (any client
 * that predates the token, the phone, a cross-instance failover), so nothing may gate behaviour on
 * it. A later task makes the label useful; until then, false must cost a caller nothing.
 */
export interface HookEventMeta {
  verified: boolean
}

/**
 * Control verbs that admit ONLY a `verified` caller — the agent-messaging verbs, plus `sticky`.
 *
 * `sticky` is here because its whole accountability story is the byline: it is deliberately not
 * confirm-gated, and the note's "↻ <agent> · when" stamp is what replaces the dialog — a stamp
 * forged by any bearer-holding process naming someone else's node id would be worse than no stamp.
 * Like the messaging verbs it is NEW, so fail-closed from day one strands nobody.
 *
 * A route that admits only `verified` is untouched by the foreign-kid escape: an invented kid is
 * FOREIGN, therefore `legacy` (invariant 3, required or cross-instance failover dies), therefore
 * never `verified` (node-identity-policy.ts, `verifyNodeToken`'s foreign-kid rule). The escape
 * defeats the latch and the window. It does not defeat this.
 *
 * Deliberately NOT routed through controlPolicy: `settings.hookIdentityStrict: false` releases the
 * latch and the dated cutoff, and it must never release these. There is no upgrade population to
 * protect — the routes are new — which is the one place in the whole control surface where
 * fail-closed from day one costs nobody anything.
 *
 * `open-project` (issue #338) is here for the same class of reason as `sticky`: the main-side
 * grant ledger (src/main/project-grants.ts) mints per-caller targeting rights off a successful
 * `open-project`, and a grant recorded for an unverifiable caller would authorize whoever can
 * name that caller's node id. NEW verb, so fail-closed from day one strands nobody.
 *
 * Consulted in the `/control/` route BEFORE `identityGate`'s decision is, so no future change to
 * the policy table can widen it; `messaging-verified-only.test.ts` drives the route on both sides
 * of every hatch and is the test that fails if either half of this comment stops being true.
 */
export const requiresVerified: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'notify',
  'sticky',
  'open-project'
])

/**
 * The refusal for a messaging verb: one sentence, no diagnosis, no hint about tokens or restarts —
 * the same posture as STRICT_CONTROL_REFUSAL, for the same reason. Advice here is advice to an
 * attacker and a lie to nobody else.
 */
export const MESSAGING_CONTROL_REFUSAL = 'Agent messaging refused.'

/** Same one-sentence posture for the verified-only sticky verb — named for what was refused,
 *  because "agent messaging refused" answering a note write is a diagnosis-delaying lie. */
export const STICKY_CONTROL_REFUSAL = 'Sticky write refused.'

/** Same posture again for `open-project` (issue #338): one sentence naming what was refused, no
 *  diagnosis, no token or restart advice — a designed refusal, not a rollout accident. */
export const OPEN_PROJECT_CONTROL_REFUSAL = 'Project open refused.'

/** The verified-only refusal, worded for the verb that was refused. */
export function verifiedRefusalFor(verb: string): string {
  if (verb === 'sticky') return STICKY_CONTROL_REFUSAL
  if (verb === 'open-project') return OPEN_PROJECT_CONTROL_REFUSAL
  return MESSAGING_CONTROL_REFUSAL
}

class HookServer {
  private server: Server | null = null
  /**
   * The unix-domain twin of the loopback TCP listener (issue #367). Same HTTP handler, same
   * bearer + per-node token auth — the whole identity machinery is transport-agnostic (nothing
   * in the handler reads `remoteAddress`), so the socket is never an auth bypass. Two reasons it
   * exists: it lets a sandboxed macOS Codex regain hook connectivity via codex's
   * `network.allow_unix_sockets` allowlist (the TCP loopback can never be allowlisted), and it
   * gives local traffic a filesystem-permissioned path (0700 dir, 0600 socket) that a
   * defense-in-depth follow-up to #195 can eventually make the ONLY door. It does not close #195
   * on its own: the TCP listener STAYS (existing tmux panes hold pre-socket env, and the Linux
   * codex sandbox blocks unix sockets anyway), so any local user can still reach the (bearer-gated)
   * TCP port until that port is retired. Best-effort: if the socket cannot bind,
   * nothing advertises it and everything runs on TCP exactly as before.
   */
  private unixServer: Server | null = null
  private sockPath = ''
  private port = 0
  private token = ''
  private listener: ((e: NormalizedAgentEvent) => void) | null = null
  private rawListener:
    | ((
        agentId: string,
        nodeId: string,
        payload: Record<string, unknown>,
        meta: HookEventMeta
      ) => void)
    | null = null
  /**
   * Nodes that have presented a token this instance minted for THAT node id. In memory only and
   * deliberately so: it is a record of what happened on this process's socket, not a durable claim,
   * and a restart must re-earn it. Bounded by the number of node ids that ever post here.
   */
  private provenNodes = new Set<string>()
  /** Node ids the materialiser refuses to mint for (see `markNodeIdentityUnmintable`). */
  private unmintableNodes = new Set<string>()
  private controlHandler:
    | ((cmd: {
        verb: string
        nodeId: string
        args: Record<string, string>
        // The caller's IDENTITY verdict for THIS request, decided at the gate above and passed on
        // rather than re-derived in main. `true` only when the caller presented a per-node token
        // this instance minted for this node id. The browser ownership ledger (PR 4 Task 4.3)
        // claims a node ONLY when this is true — a `legacy`/warned caller opens a browser but owns
        // nothing, so it can drive nothing. `browser-ownership-source.test.ts` guards the source.
        verified: boolean
      }) => Promise<{
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
  /**
   * The shared-identity spine's handlers (see core/codex-identity-proxy.ts). Both are injected by
   * the shell, and BOTH routes below additionally require a per-node capability — see
   * `nodeTokenVerified`.
   */
  private codexThreadStartHandler:
    | ((req: {
        nodeId: string
        cwd: string
        hookEndpoint: string
        accountId?: string
      }) => Promise<string>)
    | null = null
  private codexThreadBindHandler:
    | ((req: {
        nodeId: string
        threadId: string
        hookEndpoint: string
        accountId?: string
      }) => Promise<void>)
    | null = null
  private codexIdentityListener: ((e: CodexIdentityEvent) => void) | null = null
  private endpointPath = ''
  private nodeAuthSecret: Buffer | null = null
  /**
   * `settings.hookIdentityStrict`, read LIVE (a getter, not a snapshot) so flipping it in Settings
   * takes effect on the next request rather than the next launch. `undefined` — the default, and
   * what an un-wired shell gets — means "follow NODE_IDENTITY_STRICT_AFTER".
   */
  private identityStrict: () => boolean | undefined = () => undefined
  /** The clock the cutoff is read against. A seam, so a suite can stand on either side of a DATE
   *  without touching the machine's own. */
  private identityNow: () => Date = () => new Date()

  endpointFilePath(): string {
    if (!this.endpointPath) this.endpointPath = path.join(platform().userDataDir, 'hook-endpoint.env')
    return this.endpointPath
  }

  getPort(): number {
    return this.port
  }
  /** The unix listener's socket path, or '' when it is not live (bind failed, win32). */
  getSockPath(): string {
    return this.sockPath
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
  // `meta` carries what the transport knows about the caller (see HookEventMeta).
  setRawListener(
    cb: (
      agentId: string,
      nodeId: string,
      payload: Record<string, unknown>,
      meta: HookEventMeta
    ) => void
  ): void {
    this.rawListener = cb
  }

  /** Has this node ever posted with a token this instance minted for it? Read by the routing task
   *  that consumes the label; never a gate on /hook/* itself. */
  isNodeProven(nodeId: string): boolean {
    return this.provenNodes.has(nodeId)
  }

  /**
   * Drop a node from the latch — called whenever its token file is SWEPT
   * (`node-token-service.ts`), local or remote.
   *
   * The latch says "this node can authenticate, so a caller that cannot is not it". Sweeping the
   * token takes that ability away, and a latch left standing over a node that no longer has a token
   * to read is a hard 403 on every canvas-control call for the life of the session, with no window
   * and no advice that works. The two ways in are both real: a case-folding collision (a hostile or
   * merely careless `project.json` adds `term-1` beside a `Term-1` that had already proven itself,
   * and the whole colliding set is refused tokens by design), and a node deleted and re-created
   * with the same id.
   *
   * Un-proving is cheap to get wrong in the other direction and it does not matter: the node
   * re-proves on its very next hook event carrying a valid token, which is the same ceremony a
   * restart performs. Fail-open is the designed state of this whole series.
   */
  forgetProvenNode(nodeId: string): void {
    this.provenNodes.delete(nodeId)
  }

  /**
   * Node ids the materialiser has REFUSED to mint for, and will keep refusing until a file on disk
   * changes — today, the members of a case-folding collision group (`node-token-service.ts`).
   *
   * It exists only to pick the right refusal SENTENCE. `IDENTITY_REFUSED_NOTE` tells the user to
   * reopen the node to pick up an identity; for these nodes there is nothing to pick up, so that
   * advice sends them round a loop while the only other signal is a `console.warn` in a log they
   * are not reading. The other unmintable population — an id outside `isSafeNodeId`, which reaches
   * the canvas because `fileToProject` does not validate ids out of `project.json` — needs no
   * registration: this server can see it in the id itself.
   *
   * Marked/cleared rather than recomputed because the collision is a property of the whole CANVAS,
   * which the hook server has no view of.
   */
  markNodeIdentityUnmintable(nodeId: string): void {
    this.unmintableNodes.add(nodeId)
  }

  /** The twin left the canvas (or the id was fixed): this node can be minted for again. */
  clearNodeIdentityUnmintable(nodeId: string): void {
    this.unmintableNodes.delete(nodeId)
  }

  /**
   * Can this node id NEVER hold a token, however often it is restarted?
   *
   * Two sources, and neither is recomputed here: the collision set the materialiser registers, and
   * the id itself — `isSafeNodeId` is precisely the predicate `nodeAuthToken` refuses on, so an id
   * it rejects mints '' forever.
   */
  private identityUnmintable(nodeId: string): boolean {
    return !isSafeNodeId(nodeId) || this.unmintableNodes.has(nodeId)
  }

  /**
   * Which refusal sentence this node should hear. `IDENTITY_UNMINTABLE_NOTE` names the real cause
   * and deliberately does NOT advise a restart; see it for why that distinction is worth a Set.
   */
  private identityRefusalNote(nodeId: string): string {
    return this.identityUnmintable(nodeId) ? IDENTITY_UNMINTABLE_NOTE : IDENTITY_REFUSED_NOTE
  }

  /**
   * The same choice for the WARNING WINDOW, and the reason the unmintable sentence is reachable at
   * all before the cutoff.
   *
   * An unmintable node is `allow-with-warning` for the whole window — `controlPolicy` cannot see
   * that it is unmintable, and would not change its verdict if it could, because running is the
   * right answer there. So the window was the ONE period in which these nodes were guaranteed to be
   * told to "Close and reopen this node to pick one up", which is the loop
   * `IDENTITY_UNMINTABLE_NOTE` was written to end. The note was unreachable exactly while it was
   * needed.
   */
  private identityWarningNote(nodeId: string): string {
    return this.identityUnmintable(nodeId) ? IDENTITY_UNMINTABLE_WARN_NOTE : IDENTITY_RESTART_NOTE
  }

  setControlHandler(cb: NonNullable<HookServer['controlHandler']>): void {
    this.controlHandler = cb
  }

  setContextLinkHandler(cb: NonNullable<HookServer['contextLinkHandler']>): void {
    this.contextLinkHandler = cb
  }

  setCodexThreadStartHandler(cb: NonNullable<HookServer['codexThreadStartHandler']>): void {
    this.codexThreadStartHandler = cb
  }

  setCodexThreadBindHandler(cb: NonNullable<HookServer['codexThreadBindHandler']>): void {
    this.codexThreadBindHandler = cb
  }

  /** Where a node's identity mode goes on its way to the UI (both shells forward it). */
  setCodexIdentityListener(cb: (e: CodexIdentityEvent) => void): void {
    this.codexIdentityListener = cb
  }

  /**
   * The shell injects a restart-stable node-auth secret before any identity-scoped PTY is created —
   * sealed via safeStorage on the desktop, raw 0600 bytes on the Server Edition (see
   * core/agents/node-auth-secret.ts). Called on BOTH shells at boot. Rejects a secret under 32
   * bytes so a truncated/garbage load can never arm a weak identity.
   */
  setNodeAuthSecret(secret: Uint8Array): void {
    if (secret.byteLength < 32) throw new Error('Invalid NodeTerm node-auth secret')
    this.nodeAuthSecret = Buffer.from(secret)
  }

  /** True once a valid secret is set; false before, and after a failed load (nothing was set). The
   *  later routing tasks gate every identity-scoped decision on this. */
  identityAvailable(): boolean {
    return !!this.nodeAuthSecret
  }

  /** The raw secret for the routing tasks that must derive/verify per-node capabilities themselves,
   *  or null when identity is unavailable (legacy mode). Callers must handle null — never throw. */
  nodeAuthSecretOrNull(): Buffer | null {
    return this.nodeAuthSecret
  }

  /** Test seam only: this server is a module singleton, so its secret otherwise leaks across tests. */
  clearNodeAuthSecretForTests(): void {
    this.nodeAuthSecret = null
  }

  /**
   * The escape hatch, injected by the shell from `settings.hookIdentityStrict`.
   *
   * `undefined` follows the dated constant. `true` opts in early. `false` keeps the warning window
   * open past the cutoff AND releases the trust-on-first-proof latch — so a user whose upgrade goes
   * wrong gets their canvas back without downgrading the app. Never releases `forged`.
   */
  setIdentityStrictOverride(read: () => boolean | undefined): void {
    this.identityStrict = read
  }

  /** Test seam only: see `identityNow`. */
  setIdentityClockForTests(now: () => Date): void {
    this.identityNow = now
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomUUID()
    // ONE handler, shared verbatim by the TCP and the unix-socket listeners: every gate (bearer,
    // per-node verdict, verified-only verbs) runs identically on both transports.
    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
        // THE TUNNEL PROBE. `RemoteHooks.verifyTunnel` curls this through the reverse socket and
        // requires exactly 204 before it will write the remote endpoint file or install a single
        // hook script. It proves ONE thing — the socket reaches this server — and it must answer on
        // the bearer alone, with no node identity of any kind, permanently: the caller is the
        // desktop itself, `verify` is not a node id, and a 403 here would silently cost that host
        // its whole remote hook + skill install.
        //
        // Until this route existed, `/hook/verify` 204'd only because the probe sends no `payload`
        // field and fell out of the generic branch — a coincidence that the identity label on
        // `/hook/*` would have turned into a 403 for any probe carrying a token. `/hook/verify`
        // therefore stays answering forever: a host connected by an older desktop still has that
        // path baked into the script on its disk.
        if (reqUrl.pathname === '/verify' || reqUrl.pathname === '/hook/verify') {
          await readBody(req) // drain, so the probe's body is never left unread on the socket
          res.writeHead(204)
          res.end()
          return
        }
        if (reqUrl.pathname.startsWith('/codex-thread/')) {
          await this.handleCodexThread(reqUrl.pathname, req, res)
          return
        }
        if (reqUrl.pathname.startsWith('/control/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/control\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Body fully received: hand the socket from the receive-phase guard to the much larger
          // handler ceiling. A destructive control verb parks here for as long as the user takes
          // to answer the confirmation dialog, and the 2s guard used to destroy the socket mid-
          // dialog — the caller saw "endpoint unreachable" while the dialog was still up, and a
          // late confirm still delivered, so the agent was told nothing happened when it had.
          req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
          const wantsText = String(req.headers.accept ?? '').includes('text/plain')
          // IDENTITY, and it runs BEFORE the handler: the promise of a refusal is that nothing
          // happened, and a check after the handler is a check that happened too late.
          const { verdict, decision } = this.identityGate(
            nodeId,
            verb,
            req.headers['x-nodeterm-node-token']
          )
          if (verdict === 'forged') {
            res.writeHead(403)
            res.end()
            return
          }
          // VERIFIED-ONLY VERBS, decided on the VERDICT and never on the decision: the policy's
          // `decision` is what the escape hatch and the warning window can reach, and neither may
          // reach these. See `requiresVerified` for the whole argument.
          if (requiresVerified.has(verb) && verdict !== 'verified') {
            const refusal = verifiedRefusalFor(verb)
            if (wantsText) {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`${refusal}\n`)
            } else {
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: refusal }))
            }
            return
          }
          if (decision === 'refuse') {
            // The route's own refusal shape, so the sh shim (which prints any non-200 body to
            // stderr and exits 1) shows the sentence and nothing else.
            // Which sentence: a node in a case-folding collision group, or with an id
            // `isSafeNodeId` refuses, can NEVER pick up an identity, and telling it to restart is
            // an instruction to loop forever. See `identityRefusalNote`.
            //
            // A STRICT verb answers with its own flat sentence instead: those refusals are not a
            // rollout accident to be talked through, they are the designed state for anything but
            // a verified caller, and naming tokens or restarts there is advice to whoever is
            // probing. See STRICT_CONTROL_VERBS.
            const note = STRICT_CONTROL_VERBS.has(verb)
              ? STRICT_CONTROL_REFUSAL
              : this.identityRefusalNote(nodeId)
            if (wantsText) {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`${note}\n`)
            } else {
              res.writeHead(403, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: note }))
            }
            return
          }
          const result = this.controlHandler
            ? await this.controlHandler({ verb, nodeId, args, verified: verdict === 'verified' })
            : { ok: false, error: 'control unavailable' }
          // Which note, not whether: an unmintable node warned with the restart line is sent round
          // the same loop the refusal path already knows better than to send it round.
          const note = decision === 'allow-with-warning' ? this.identityWarningNote(nodeId) : ''
          // The POSIX-sh shim asks for text/plain: it has no JSON parser, so the server does the
          // rendering the Node CLI used to do client-side. Everything else keeps the JSON shape.
          if (wantsText) {
            // A FAILURE may now carry both: `error` is the machine-readable name a JSON client
            // keys on, `message` the sentence a human (or a language model) reads. The text
            // dialect has no fields, so it prefers the sentence and falls back to the name — which
            // is what every existing handler still sends, so this is inert for all of them.
            const text = result.ok
              ? result.message ?? JSON.stringify(result.result ?? {})
              : result.message ?? result.error ?? 'control request failed'
            res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(note ? `${note}\n${text}\n` : `${text}\n`)
            return
          }
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' })
          // A field, not a prefix: the JSON dialect is a STRUCTURED reply a legacy client parses,
          // and folding the note into `message` would either hide `result` (text rendering falls
          // back to it only when `message` is absent) or corrupt a field somebody reads.
          res.end(JSON.stringify(note ? { ...result, warning: note } : result))
          return
        }
        if (reqUrl.pathname.startsWith('/context-link/')) {
          const verb = decodeURIComponent(reqUrl.pathname.replace(/^\/context-link\//, ''))
          const { nodeId, args } = parseControlBody(
            await readBody(req),
            String(req.headers['content-type'] ?? '')
          )
          // Same hand-off as /control/: the receive phase is over, so raise the guard to the
          // handler ceiling rather than dropping it. The effective bound here is the race below;
          // the socket ceiling is only the backstop behind it.
          req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
          // Same latch as /control/, and every verb here is a READ, so it is presented to the
          // policy as the tolerant verb: an unproven legacy caller keeps its transcript.
          const gate = this.identityGate(
            nodeId,
            CONTEXT_LINK_POLICY_VERB,
            req.headers['x-nodeterm-node-token']
          )
          if (gate.verdict === 'forged') {
            res.writeHead(403)
            res.end()
            return
          }
          if (gate.decision === 'refuse') {
            // PROSE, not a 403. The agent explicitly asked for a read; the shim turns any non-200
            // into "Could not read linked context (nodeterm unreachable)", which would be a lie and
            // tells it nothing it can act on. A sentence it can act on is the better failure.
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`${this.identityRefusalNote(nodeId)}\n`)
            return
          }
          // Always text: the caller is the sh shim, and the payload IS prose (a rendered
          // transcript). The handler owns the authorization — see context-link.ts.
          const text = this.contextLinkHandler
            ? await withTimeout(
                this.contextLinkHandler({ verb, nodeId, args }),
                CONTEXT_LINK_READ_MS,
                CONTEXT_LINK_TIMEOUT_TEXT
              )
            : 'Context link is unavailable in this session.'
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`${text}\n`)
          return
        }
        const agentId = decodeURIComponent(reqUrl.pathname.replace(/^\/hook\//, ''))
        const form = parseForm(await readBody(req))
        const nodeId = form.nodeId ?? ''
        // Identity is a LABEL here, not a gate. The three-way verdict maps to:
        //   forged  — our own kid with a mac that is not this node's ⇒ 403. Nothing legitimate can
        //             produce it (only a holder of a token for ANOTHER node, or a mutation of one),
        //             so it is the single case this route refuses.
        //   legacy  — no token, or another instance's kid. THE COMMON CASE, and it must keep
        //             behaving exactly as it did before this label existed: 204, listeners fired.
        //             Every client that predates the token, the phone, and the documented
        //             cross-instance failover land here. Do not gate this on identityAvailable(),
        //             on the agent, or on anything else — the fail-open is the contract.
        //   verified — the caller holds this node's token; remember the node and pass the flag on.
        const verdict = verifyNodeToken(
          this.nodeAuthSecretOrNull(),
          nodeId,
          req.headers['x-nodeterm-node-token']
        )
        if (verdict === 'forged') {
          res.writeHead(403)
          res.end()
          return
        }
        const verified = verdict === 'verified'
        if (verified) this.provenNodes.add(nodeId)
        // WHICH CLIENT posted. A LABEL like `verified`, and for the same reason a second one was
        // needed: an old managed script and a current one whose token file is missing send exactly
        // the same bytes otherwise (the `version` form field is sourced from the endpoint file, so
        // it reports OUR protocol version, not the client's). Absent or unparseable stays
        // `undefined` — never 0 — because "no stamp" and "revision zero" are different claims and
        // only the first one is true of a pre-#195 script.
        const clientRevision = parseClientRevision(req.headers['x-nodeterm-hook-client'])
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
          this.rawListener?.(agentId, nodeId, payload, { verified })
          const normalized = normalizeFor(agentId, { nodeId, agentId, payload })
          if (normalized && this.listener) this.listener({ ...normalized, verified, clientRevision })
        }
        res.writeHead(204)
        res.end()
      } catch {
        res.writeHead(204)
        res.end()
      }
    }
    this.server = createServer(handler)
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
        resolve()
      }
      this.server!.once('error', onErr)
      this.server!.listen(0, '127.0.0.1', onOk)
    })
    // Second leg, then ONE endpoint write that advertises whatever actually came up. A failed
    // socket bind must not cost the TCP endpoint file (or the boot).
    await this.startUnixListener(handler)
    this.writeEndpointFile()
  }

  /** Bind the unix-socket twin (see `unixServer`). Never throws — a socket that cannot bind is
   *  simply not advertised, and everything keeps running on loopback TCP. */
  private async startUnixListener(
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  ): Promise<void> {
    // Node's AF_UNIX support on Windows is not the discipline this path was built around, and no
    // generated sh client runs there anyway.
    if (process.platform === 'win32') return
    const p = hookSockPath(platform().userDataDir)
    try {
      const dir = path.dirname(p)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // mkdir's mode is ignored when the dir already exists — enforce it, because the DIRECTORY
      // mode is what actually keeps other local users off the socket (the file chmod below only
      // lands after listen, and the socket is world-connectable for that instant otherwise).
      chmodSync(dir, 0o700)
      // A stale socket file BLOCKS bind with EADDRINUSE even when nothing is listening — the
      // StreamLocalBindUnlink lesson from the SSH reverse tunnels. Unlink-then-bind is safe here:
      // the path is ours alone (0700 dir, digest-keyed fallback), so anything at it is our own
      // leftover from a crash.
      try {
        unlinkSync(p)
      } catch {
        /* nothing stale to clear */
      }
      const srv = createServer(handler)
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => {
          srv.off('listening', onOk)
          reject(e)
        }
        const onOk = (): void => {
          srv.off('error', onErr)
          resolve()
        }
        srv.once('error', onErr)
        srv.once('listening', onOk)
        srv.listen(p)
      })
      chmodSync(p, 0o600)
      srv.on('error', (e) => console.error('[agent-hooks] unix listener error', e))
      this.unixServer = srv
      this.sockPath = p
    } catch (e) {
      console.warn('[agent-hooks] unix hook socket unavailable, staying TCP-only', e)
      this.unixServer = null
      this.sockPath = ''
    }
  }

  // Constant-time bearer-token check (avoids a timing side channel on the compare).
  private tokenMatches(provided: string | string[] | undefined): boolean {
    if (typeof provided !== 'string' || !this.token) return false
    const a = Buffer.from(provided)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * The identity routes' gate: ONE derivation, the same `verifyNodeToken` /hook/* is labelled by.
   *
   * These routes are STRICT — only `verified` proceeds. `legacy` (no token, an empty header,
   * another instance's kid, no secret at all) is refused here, deliberately and unlike /hook/*:
   * they were strict from the day they existed, so there is no upgrade population to protect. A
   * session that predates the per-node capability has no launcher that calls `/codex-thread/*` at
   * all; failing it open would buy nothing and hand back the authorization hole the capability
   * exists to close (any session holding the shared bearer binding its own codex thread to a
   * SIBLING node — reparenting that node's status and, through the hook prelude which re-exports
   * the recorded node id and endpoint, aiming that node's hook traffic).
   */
  private nodeTokenVerified(nodeId: string, provided: string | string[] | undefined): boolean {
    return verifyNodeToken(this.nodeAuthSecretOrNull(), nodeId, provided) === 'verified'
  }

  /**
   * The identity gate for `/control/*` and `/context-link/*` — one call site for the verdict, the
   * latch and the policy, so the two routes cannot drift into two different rules.
   *
   * Both halves of the answer come back: the routes agree on the POLICY but not on the SHAPE of a
   * refusal (a 403 on control, prose on context-link), and `forged` is a bare 403 on both — it is
   * an attack signal, and handing it "restart this node" would be advice to an attacker and a lie
   * to nobody else.
   */
  private identityGate(
    nodeId: string,
    verb: string,
    presented: string | string[] | undefined
  ): { verdict: NodeTokenVerdict; decision: IdentityDecision } {
    const secret = this.nodeAuthSecretOrNull()
    // NO SECRET ⇒ NO GATE, ever. This instance cannot mint a token, so nothing can be `verified`,
    // so a policy that warns or refuses `legacy` here would warn or refuse EVERY caller on the
    // machine — and the advice it would give ("restart this node to pick up an identity") is
    // advice that cannot work, because there is no identity to pick up. This is the state a
    // desktop lands in when safeStorage is unavailable and the state a Server Edition lands in
    // when the key file cannot be created; both must keep working exactly as they did.
    if (!secret) return { verdict: 'legacy', decision: 'allow' }
    const verdict = verifyNodeToken(secret, nodeId, presented)
    // Proof is earned on ANY route that can present a valid token, not just /hook/*: a session's
    // first act may well be a canvas-control call.
    if (verdict === 'verified') this.provenNodes.add(nodeId)
    return {
      verdict,
      decision: controlPolicy({
        verdict,
        // A FOREIGN kid is the documented cross-instance failover. It never proved this node (only
        // `verified` adds to the set) and it must never be caught by the latch either, or the
        // first day a second instance exists is the day failover stops working.
        proven: this.provenNodes.has(nodeId) && !isForeignKidToken(secret, presented),
        verb,
        now: this.identityNow(),
        override: this.identityStrict()
      })
    }
  }

  /**
   * `/codex-thread/{start,bind,fallback}`.
   *
   * start/bind are the identity spine and require the per-node capability on top of the shared
   * bearer. `fallback` deliberately does NOT: it is the launcher telling us it gave up and is
   * running plain codex, it grants nothing, and requiring a token there would silence the report
   * in exactly the case (no token) it exists to surface.
   */
  private async handleCodexThread(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const verb = pathname.replace(/^\/codex-thread\//, '')
    const form = parseForm(await readBody(req))
    // SAME HAND-OFF as /control/ and /context-link/, and for the same reason — this route needs it
    // MOST. The receive phase is over, so the 2s slowloris guard has done its job; leaving it armed
    // destroys the socket while the HANDLER is still working. `/codex-thread/start` mints a thread
    // through a five-step conversation with the app-server (initialize, start, a turn, an
    // interrupt, a fork, a delete) against a server that is typically COLD — the first codex node
    // after boot is the common case, not the edge one. At 2s that fails every time, and it fails in
    // the worst possible way: curl gives up, the launcher falls back to plain codex, and main goes
    // on to create the thread and write a record for it — an orphan thread plus an orphan record
    // per attempt. The client budget is deliberately set ABOVE the server's own (see
    // CODEX_THREAD_START_TIMEOUT_MS / the launcher's --max-time) so the server is always the one
    // that gives up first and can clean up after itself.
    req.setTimeout(CONTROL_CEILING_MS, () => req.destroy())
    const nodeId = form.nodeId ?? ''
    // `isSafeNodeId`, not a local regex: the same predicate the token derivation and the token
    // FILE path use, so an id one of them would refuse can never reach the other two.
    if (!isSafeNodeId(nodeId)) {
      res.writeHead(400)
      res.end()
      return
    }
    if (verb === 'fallback') {
      // This is the ONE route that may be called without the per-node capability, because the
      // commonest thing it reports is "there was no capability to present" — requiring one would
      // silence it in exactly the case it exists for. So only `forged` is refused here, the same
      // rule /hook/* follows and the one the per-route table documents.
      //
      // It used to refuse anything that was not `verified`, which caught the CROSS-INSTANCE
      // FAILOVER: another instance's token is `legacy`, and invariant 3 says a foreign kid is
      // never refused anywhere. That check also bought nothing it was meant to buy — a hostile
      // sibling wanting to flag another node as fallen back simply omits the header, which was
      // always accepted — so it only ever silenced a legitimate report.
      if (verifyNodeToken(this.nodeAuthSecretOrNull(), nodeId, req.headers['x-nodeterm-node-token']) === 'forged') {
        res.writeHead(403)
        res.end()
        return
      }
      // A reason is free text from a generated script we wrote; bound it and let the UI show it.
      const reason = (form.reason ?? '').slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '') || 'unknown'
      this.codexIdentityListener?.({ nodeId, mode: 'plain', reason })
      res.writeHead(204)
      res.end()
      return
    }
    if (verb !== 'start' && verb !== 'bind') {
      res.writeHead(404)
      res.end()
      return
    }
    if (!this.nodeTokenVerified(nodeId, req.headers['x-nodeterm-node-token'])) {
      res.writeHead(403)
      res.end()
      return
    }
    // The account scope for this thread's ownership record (S6). Absent ⇒ system account. A
    // non-empty id that is not a safe account id is refused BEFORE it reaches the record store,
    // where it would become a directory component (Supply-chain guard, Constraint 7). Both routes
    // share the same normalisation so a managed thread is never mis-filed under `system`.
    const rawAccountId = form.accountId ?? ''
    if (rawAccountId !== '' && !isSafeAccountId(rawAccountId)) {
      res.writeHead(400)
      res.end()
      return
    }
    const accountId = rawAccountId || undefined
    if (verb === 'start') {
      const cwd = form.cwd ?? ''
      if (!path.isAbsolute(cwd)) {
        res.writeHead(400)
        res.end()
        return
      }
      try {
        if (!this.codexThreadStartHandler) throw new Error('start handler unavailable')
        const threadId = await this.codexThreadStartHandler({
          nodeId,
          cwd,
          hookEndpoint: this.endpointFilePath(),
          accountId
        })
        // Same predicate the record store gates on, so a thread id the store would refuse can
        // never be handed back to a launcher that will then `resume` it.
        if (!isSafeThreadId(threadId)) throw new Error('invalid thread id')
        this.codexIdentityListener?.({ nodeId, mode: 'shared' })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`${threadId}\n`)
      } catch {
        res.writeHead(503)
        res.end()
      }
      return
    }
    const threadId = form.threadId ?? ''
    // `isSafeThreadId`, not a local regex — the twin of the `isSafeNodeId` gate above and for the
    // same reason. This id is caller-supplied and becomes a PATH SEGMENT under the record store;
    // the bare charset the route used to carry accepts `.` and `..`.
    if (!isSafeThreadId(threadId)) {
      res.writeHead(400)
      res.end()
      return
    }
    try {
      if (!this.codexThreadBindHandler) throw new Error('bind handler unavailable')
      await this.codexThreadBindHandler({
        nodeId,
        threadId,
        hookEndpoint: this.endpointFilePath(),
        accountId
      })
      this.codexIdentityListener?.({ nodeId, mode: 'shared' })
      res.writeHead(204)
      res.end()
    } catch {
      res.writeHead(409)
      res.end()
    }
  }

  // The managed script sources this file at invocation to get the LIVE port/token.
  // tmux sessions outlive the app, so env-baked coords go stale after a restart.
  private writeEndpointFile(): void {
    try {
      const p = this.endpointFilePath()
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(
        p,
        // Every value is `posixQuote`d: the managed script SOURCES this file (`. "$file"`) under
        // /bin/sh, so an unquoted space or shell metachar in a path or token would break the source
        // (issue #351: macOS userDataDir lives under "Application Support" — the space made sh try
        // to run the tail of the path, exit 127, and the hook fell back to plain mode for EVERY
        // macOS user). Quoting all four keeps the file a valid POSIX assignment list regardless.
        `NODETERM_HOOK_PORT=${posixQuote(String(this.port))}\n` +
          `NODETERM_HOOK_TOKEN=${posixQuote(this.token)}\n` +
          `NODETERM_HOOK_VERSION=${posixQuote(NODETERM_HOOK_PROTOCOL_VERSION)}\n` +
          // Where clients read their PER-NODE capability from, keyed by $NODETERM_NODE_ID.
          // Advertised (not compiled in) so a failover that sources ANOTHER instance's endpoint
          // file also picks up THAT instance's token dir: it then finds a token that instance can
          // verify, or none — never a mismatched one.
          `NODETERM_NODE_TOKEN_DIR=${posixQuote(nodeTokenDir())}\n` +
          // The unix-socket twin, only when it actually bound. Every generated client (managed
          // hook script, both sh shims, opencode plugin, codex launcher) is already sock-first —
          // `[ -n "$NODETERM_HOOK_SOCK" ]` — so advertising it moves local hook traffic off the
          // TCP port; the PORT line stays above for sessions holding a pre-socket script. Quoted
          // like every other value (#351/#358): macOS data dirs carry a space.
          (this.sockPath ? `NODETERM_HOOK_SOCK=${posixQuote(this.sockPath)}\n` : ''),
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
  buildPtyEnv(
    nodeId: string,
    agentId: AgentId,
    permWaitSecs = 0,
    /** Node-persisted harness snapshot; authoritative if the custom definition was deleted. */
    capabilityAgentId: AgentId = agentId
  ): Record<string, string> {
    if (this.port <= 0 || !this.token) return {}
    return {
      // NO NODETERM_HOOK_TOKEN, NO NODETERM_HOOK_PORT — measured 2026-08-13: these ride the tmux
      // `-e` argv into a long-lived tmux CLIENT process whose /proc/<pid>/cmdline is mode 444 on a
      // stock Linux (no hidepid), so any unprivileged local user read a live app-wide bearer and
      // could drive canvas control — including `open-terminal --cmd`, which is NOT in the
      // confirm-gated DESTRUCTIVE_VERBS set (src/shared/control-verbs.ts). Every client already
      // sources the 0600 endpoint file FIRST
      // and prefers it, so nothing legitimate loses anything: the only regression surface is a
      // session whose endpoint file is unreadable AND whose env held a good token, a state that
      // means the data dir has vanished and the hook is meant to be inert anyway.
      NODETERM_HOOK_VERSION: NODETERM_HOOK_PROTOCOL_VERSION,
      NODETERM_HOOK_ENDPOINT: this.endpointFilePath(),
      // The socket PATH is fine on the tmux -e argv where the token/port were not: it is an
      // address, not a credential — connecting still takes the bearer from the 0600 endpoint
      // file, and the socket itself sits in a 0700 dir. Advertised in env (not only the endpoint
      // file) so the codex sandbox shim can name the exact path in its macOS
      // `network.allow_unix_sockets` remedy line (issue #367) even when the endpoint file is
      // what a sandboxed sh could not read.
      ...(this.sockPath ? { NODETERM_HOOK_SOCK: this.sockPath } : {}),
      NODETERM_NODE_ID: nodeId,
      NODETERM_AGENT_ID: agentId,
      ...(permWaitSecs > 0 ? { NODETERM_PERM_WAIT_SECS: String(permWaitSecs) } : {}),
      ...(canControlCanvas(capabilityAgentId) ? { NODETERM_CANVAS_CONTROL: '1' } : {})
      // NO NODETERM_CODEX_NODE_TOKEN either. The per-node capability is the same class of leak as
      // the app-wide bearer above, and a worse one to reason about: it is the credential that
      // proves WHICH node is calling, so a sibling uid reading it off /proc/<pid>/cmdline could
      // bind its own codex thread to that node — the exact reparenting this capability exists to
      // prevent. It reaches the client through the 0600 token file instead (nodeTokenDir(), keyed
      // by $NODETERM_NODE_ID and advertised in the endpoint file) — where the launcher
      // (core/codex-identity-proxy.ts) reads it, exactly as the managed script and both sh shims
      // do, so shared identity is LIVE with no credential in anyone's argv.
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.unixServer?.close()
    this.unixServer = null
    // Unlink so the NEXT bind is clean even if close() lost the race with process exit; the
    // startup unlink above is still the backstop for a crash that skipped this entirely.
    if (this.sockPath) {
      try {
        unlinkSync(this.sockPath)
      } catch {
        /* already gone */
      }
      this.sockPath = ''
    }
    this.port = 0
    this.token = ''
  }
}

export const hookServer = new HookServer()
