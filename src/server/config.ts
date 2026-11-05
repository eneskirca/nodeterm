import os from 'os'
import { parseControlScope, type ControlScope } from './control-scope'
import path from 'path'
import {
  parseTrustedNets,
  describeTrustedNets,
  netsCoverLoopback,
  DEFAULT_TRUSTED_NETS_SPEC,
  MIN_PROXY_SECRET_LENGTH,
  type TrustProxyConfig
} from './proxy-trust'
import type { RelayTransport } from '../core/relay/relay-socket'

/**
 * Fully-resolved server configuration. Produced by {@link resolveConfig} from the
 * process environment + CLI argv, then consumed by `startServer` (src/server/index.ts).
 */
export type ServerConfig = {
  port: number
  host: string
  dataDir: string
  rendererDir: string
  insecureHttp: boolean
  passwordSeed?: string
  /**
   * Headless notification-host mode (`NODETERM_HEADLESS=1`). When set, the server does NOT
   * bind the HTTP/WS listener at all — no renderer serving, no auth surface, no open port —
   * but boots every other core service exactly as usual (the loopback hook server, agent-status
   * mirror, usage poll, granted push senders, pending-approvals sweep). A phone that SSHes into
   * the host still gets full push / Live-Activity coverage as long as this process runs. See the
   * "Headless notification host" section of docs/SERVER.md.
   */
  headless: boolean
  /**
   * Merge the managed agent hooks into the user's real agent config dirs (~/.claude,
   * ~/.codex, ~/.gemini) at boot. Defaults to true — the server needs them to receive
   * agent status. Tests MUST pass false: installing rewrites the machine's REAL settings.json
   * (the script lives at the stable `~/.nodeterm/agent-hooks/<agent>.sh`, shared by every
   * instance), so a test run would silently take over the developer's own hooks — and, before
   * that path was stabilized, leave them pointing into a temp dataDir that gets removed after
   * the run, which is exactly how a machine ends up with hooks that quietly do nothing.
   */
  installHooks?: boolean
  /**
   * Enable the Server Edition `/control/*` canvas runtime. Defaults OFF so an upgrade cannot
   * silently grant agents a new local execution surface. Environment:
   * NODETERM_SERVER_CANVAS_CONTROL=1;
   * CLI: --canvas-control.
   *
   * Enabling it lets an agent session run arbitrary commands on this host as the user the server
   * runs as: `open-terminal --cmd <command>` is executed in a PTY this process spawns, with that
   * user's environment, files and credentials. Hook endpoint authentication, verified node
   * identity and per-project capability gates still apply when enabled, but they decide WHICH
   * agent may ask, not WHAT may be asked for — the surface this flag opens is the host, not the
   * canvas. Boot announces it on stdout for the same reason (see startServer).
   *
   * The server-process env name is deliberately distinct from the per-session
   * NODETERM_CANVAS_CONTROL discovery bit injected by HookServer.
   */
  canvasControl?: boolean
  /**
   * Which nodes a canvas-control caller may read and act on (src/server/control-scope.ts):
   * `creator` (default) or `project`. Environment: NODETERM_SERVER_CONTROL_SCOPE; CLI:
   * --control-scope. Only meaningful with canvas control enabled.
   */
  controlScope?: ControlScope
  /**
   * Reverse-proxy SSO trust (issue #29): requests whose TCP peer is inside `nets` and
   * which carry `header` (non-empty) are authenticated without a session cookie.
   * Absent = feature off (default). See src/server/proxy-trust.ts and docs/SERVER.md.
   */
  trustProxy?: TrustProxyConfig
  /**
   * Set when header trust was configured but refused (S2): the trusted nets include loopback and no
   * `NODETERM_TRUST_PROXY_SECRET` is set, so every local process would count as the proxy. Header
   * trust is then OFF (`trustProxy` undefined, password sign-in still works) and the boot prints
   * this message, which names exactly what to set in the proxy and the environment.
   */
  trustProxyRefused?: string
  /**
   * The public https origin the server is reached at (`NODETERM_PUBLIC_ORIGIN`, e.g.
   * `https://term.example.com`), normalized to its origin. When set, the session cookie is always
   * `Secure`, every response carries HSTS, and an `Origin` equal to it passes the same-origin checks
   * even when the proxy rewrites `Host`. Unset = the old behaviour (`Secure` follows
   * `X-Forwarded-Proto`), with a one-time warning when a non-loopback Host arrives.
   */
  publicOrigin?: string
  /**
   * TEST ONLY: an in-process relay transport for each hosted-team listener, in place of the real
   * WebSocket to the relay. Passed straight to `createHostedService`'s `transport`.
   * `resolveConfig` NEVER sets it — no env var or flag reaches it (pinned in config.test.ts) — so a
   * production boot always dials the real relay. See src/server/hosted-e2e.test.ts.
   */
  relayTestTransport?: () => RelayTransport
  /**
   * TEST ONLY: the fetch the hosted-team host-token mint uses in place of the global one. Passed
   * straight to `createHostedService`'s `fetch`. `resolveConfig` NEVER sets it (pinned in
   * config.test.ts).
   */
  relayTestFetch?: typeof fetch
}

/**
 * Minimal `--flag value` / `--bool` argv parser. Only understands the flags we
 * define below; anything else is ignored. A flag whose next token is another
 * flag (or missing) is treated as a boolean.
 */
function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) continue
    const key = tok.slice(2)
    if (key === 'insecure-http') {
      out[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

/**
 * The boot error for header trust on loopback nets with no secret (S2). Exported for the tests and
 * the docs; it must name exactly what to set, because the operator's next step is to set it.
 */
export function trustProxyRefusedMessage(nets: string): string {
  return [
    `Proxy header trust is OFF: NODETERM_TRUST_PROXY_HEADER is set, but the trusted networks [${nets}] include loopback and NODETERM_TRUST_PROXY_SECRET is not set.`,
    `On loopback every local process and every local user counts as "your proxy", so the header alone would sign any of them in as the owner, without a password. Password sign-in still works.`,
    `To turn header trust on:`,
    `  1. Generate a secret:            openssl rand -hex 32`,
    `  2. Give it to nodeterm-server:   NODETERM_TRUST_PROXY_SECRET=<secret>   (environment only — never a command-line flag)`,
    `  3. Make the proxy send it on every request, WebSocket upgrades included:   X-Nodeterm-Proxy-Secret: <secret>`,
    `     nginx:   proxy_set_header X-Nodeterm-Proxy-Secret "<secret>";`,
    `     Caddy:   header_up X-Nodeterm-Proxy-Secret "<secret>"`,
    `     Traefik: a headers middleware with customRequestHeaders.X-Nodeterm-Proxy-Secret`,
    `See "Reverse-proxy SSO" in docs/SERVER.md.`
  ].join('\n')
}

/** Validate `NODETERM_PUBLIC_ORIGIN` into a normalized https origin. Throws (never echoing more than
 *  the value the operator typed) on anything that is not exactly an https origin. */
function parsePublicOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`NODETERM_PUBLIC_ORIGIN must be an https origin such as https://term.example.com (got "${value}").`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      `NODETERM_PUBLIC_ORIGIN must be an https origin with no path, query or credentials, such as https://term.example.com (got "${value}").`
    )
  }
  return url.origin
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * The server's data directory, exactly as `resolveConfig` resolves it (argv > env > default). Split
 * out for the `team` admin CLI, which needs the data dir — where the admin socket lives — but none of
 * the serving config, and must not trip `resolveConfig`'s serving-only refusals (a non-loopback
 * NODETERM_HOST in the operator's shell, a trust-proxy half-configuration).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, argv: string[]): string {
  const arg = parseArgv(argv)['data-dir']
  if (typeof arg === 'string') return arg
  const ev = env.NODETERM_DATA_DIR
  if (ev !== undefined && ev !== '') return ev
  return path.join(os.homedir(), '.nodeterm-server')
}

/**
 * Resolve the server config from `env` + `argv`. Precedence is argv > env > default.
 * Binding a non-loopback host without `--insecure-http` throws: plain HTTP on a
 * public interface would leak the session cookie, so the server insists on being
 * kept behind a TLS-terminating reverse proxy (loopback) unless explicitly overridden.
 */
export function resolveConfig(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const args = parseArgv(argv)

  const pick = (argKey: string, envKey: string, def: string): string => {
    if (typeof args[argKey] === 'string') return args[argKey] as string
    const ev = env[envKey]
    if (ev !== undefined && ev !== '') return ev
    return def
  }

  const port = Number(pick('port', 'NODETERM_PORT', '8443'))
  const host = pick('host', 'NODETERM_HOST', '127.0.0.1')
  const dataDir = resolveDataDir(env, argv)
  const rendererDir = pick('renderer-dir', 'NODETERM_RENDERER_DIR', path.resolve('out/renderer'))
  const insecureHttp = args['insecure-http'] === true
  const passwordSeed = env.NODETERM_SERVER_PASSWORD || undefined
  // Headless mode is env-only (a deployment/systemd knob, not an interactive flag). Accept the two
  // truthy spellings the install script + systemd unit emit.
  const headlessEnv = (env.NODETERM_HEADLESS || '').trim().toLowerCase()
  const headless = headlessEnv === '1' || headlessEnv === 'true'
  const truthy = (value: unknown): boolean => {
    if (value === true) return true
    if (typeof value !== 'string') return false
    const normalized = value.trim().toLowerCase()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }
  const canvasControl =
    args['canvas-control'] !== undefined
      ? truthy(args['canvas-control'])
      : truthy(env.NODETERM_SERVER_CANVAS_CONTROL)
  if (args['control-scope'] === true) {
    throw new Error('--control-scope needs a value: creator or project')
  }
  const controlScope = parseControlScope(pick('control-scope', 'NODETERM_SERVER_CONTROL_SCOPE', ''))

  // Headless binds nothing, so the "plain HTTP on a public interface" hazard the loopback refusal
  // guards against does not apply — a stray NODETERM_HOST must not fail a headless boot.
  if (!isLoopback(host) && !insecureHttp && !headless) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" over plain HTTP. Run nodeterm-server ` +
        `behind a TLS-terminating reverse proxy and keep it bound to a loopback address ` +
        `(127.0.0.1 / localhost / ::1), or pass --insecure-http to acknowledge you are ` +
        `serving plain HTTP directly on this interface.`
    )
  }

  // Reverse-proxy SSO trust. `pick` with an empty default so "unset" and "" coincide.
  const trustHeader = pick('trust-proxy-header', 'NODETERM_TRUST_PROXY_HEADER', '')
  const trustNetsSpec = pick('trust-proxy-nets', 'NODETERM_TRUST_PROXY_NETS', '')
  // The proxy secret is ENVIRONMENT ONLY: a command line is readable by every local user, which is
  // exactly who the secret keeps out. A flag is refused rather than ignored, so it is not mistaken
  // for working. Neither refusal ever echoes the value.
  if (args['trust-proxy-secret'] !== undefined) {
    throw new Error(
      `--trust-proxy-secret is not accepted: a command line is readable by every local user. Pass the secret through the environment as NODETERM_TRUST_PROXY_SECRET instead.`
    )
  }
  const trustSecret = env.NODETERM_TRUST_PROXY_SECRET ?? ''
  if (trustSecret !== '') {
    if (trustHeader === '') {
      throw new Error(
        `NODETERM_TRUST_PROXY_SECRET is set but no trust header is configured. Set NODETERM_TRUST_PROXY_HEADER (or --trust-proxy-header) too, or unset the secret.`
      )
    }
    if (trustSecret.length < MIN_PROXY_SECRET_LENGTH) {
      throw new Error(
        `NODETERM_TRUST_PROXY_SECRET must be at least ${MIN_PROXY_SECRET_LENGTH} characters (header trust is not rate-limited, so every request is a guess). Generate one with: openssl rand -hex 32`
      )
    }
    if (!/^[\x21-\x7e]+$/.test(trustSecret)) {
      throw new Error(
        `NODETERM_TRUST_PROXY_SECRET must be printable ASCII with no spaces (it travels as a request header). Generate one with: openssl rand -hex 32`
      )
    }
  }
  let trustProxy: TrustProxyConfig | undefined
  let trustProxyRefused: string | undefined
  if (trustHeader !== '') {
    // parseTrustedNets throws on a typo — a bad trust config must fail the boot, not
    // silently change who is trusted.
    const nets = parseTrustedNets(trustNetsSpec || DEFAULT_TRUSTED_NETS_SPEC)
    if (trustSecret === '' && netsCoverLoopback(nets)) {
      // Fail CLOSED, not loud: the server still boots with password sign-in, and the boot prints
      // what to set. Refusing the boot would take down a deployment that worked yesterday.
      trustProxyRefused = trustProxyRefusedMessage(describeTrustedNets(nets))
    } else {
      trustProxy = { header: trustHeader, nets, ...(trustSecret !== '' ? { secret: trustSecret } : {}) }
    }
  } else if (trustNetsSpec !== '') {
    throw new Error(
      `--trust-proxy-nets / NODETERM_TRUST_PROXY_NETS is set but no trust header is configured. ` +
        `Set NODETERM_TRUST_PROXY_HEADER (or --trust-proxy-header) to the identity header your ` +
        `reverse proxy asserts (e.g. Cf-Access-Authenticated-User-Email), or unset the nets.`
    )
  }

  const publicOriginRaw = pick('public-origin', 'NODETERM_PUBLIC_ORIGIN', '')
  const publicOrigin = publicOriginRaw !== '' ? parsePublicOrigin(publicOriginRaw) : undefined

  return {
    port,
    host,
    dataDir,
    rendererDir,
    insecureHttp,
    passwordSeed,
    trustProxy,
    ...(trustProxyRefused !== undefined ? { trustProxyRefused } : {}),
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    headless,
    canvasControl,
    controlScope
  }
}
