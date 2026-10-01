// The effective OpenSSH client config for one destination, as `ssh -G` prints it.
//
// The in-process transport (native-mux.ts) replaces the ssh BINARY on Windows, not the user's
// ~/.ssh/config: a Host alias, a non-default port, a per-host IdentityFile, a HostKeyAlias or a
// ProxyJump must mean the same thing whichever transport carries the connection. Re-implementing
// the config grammar (Match blocks, Include, token expansion, first-obtained-wins) would be a second
// definition of it that drifts, so we ask OpenSSH itself: `ssh -G` evaluates the config and prints
// the resolved values without connecting. Windows' own OpenSSH (9.5p2, measured on windows-latest)
// supports it, and so does every OpenSSH a POSIX desktop has.
//
// Command-line values win over the config, exactly as they do for ssh: the argv builders pass
// `-p`, `-i` and `-o IdentitiesOnly=yes`, and `ssh -G` is invoked with the same flags, so what it
// prints already has them applied.

import os from 'os'
import path from 'path'

/** What the native transport needs to know about a destination. */
export interface ResolvedHost {
  /** Real host to dial (HostName, after alias resolution). */
  hostname: string
  port: number
  user: string
  /** Candidate private keys, in config order, `~` expanded. */
  identityFiles: string[]
  /** `IdentitiesOnly yes`: offer only `identityFiles`, never other agent keys. */
  identitiesOnly: boolean
  /** Agent to use: a socket / pipe path, `none`, or undefined for the platform default. */
  identityAgent?: string
  /** `ProxyJump` chain as written (`[user@]host[:port],…`), or undefined. */
  proxyJump?: string
  /** `ProxyCommand`, present so the caller can REFUSE it by name (not supported natively). */
  proxyCommand?: string
  /** Name the host key is recorded under in known_hosts (`HostKeyAlias`), else the host. */
  hostKeyAlias?: string
  userKnownHostsFiles: string[]
  globalKnownHostsFiles: string[]
  /** `yes` | `no` | `ask` | `accept-new` | `off` — the config's own answer; our argv overrides it. */
  strictHostKeyChecking: string
  /** Seconds, or undefined for none. */
  connectTimeout?: number
  /**
   * The config's `AddKeysToAgent`, as `ssh -G` prints it: `false` / `true` / `ask` / `confirm`, a
   * lifetime in seconds, or `confirm <seconds>`. Parsed by `parseAddKeysToAgent` (agent-add.ts);
   * kept raw here so an unknown spelling reads as "not asked for", never as yes.
   */
  addKeysToAgent?: string
}

/** `~` / `%d` expansion for path-valued options. `ssh -G` leaves `~` unexpanded. */
export function expandHomePath(p: string, home: string = os.homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2))
  return p.replace(/%d/g, home)
}

/**
 * Parse `ssh -G` output. Keys are printed lower-case, one `key value…` per line; multi-valued
 * options (identityfile) repeat, list-valued ones (userknownhostsfile) are space-separated.
 */
export function parseSshG(out: string, home: string = os.homedir()): ResolvedHost {
  const single = new Map<string, string>()
  const multi = new Map<string, string[]>()
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const sp = line.indexOf(' ')
    const key = (sp === -1 ? line : line.slice(0, sp)).toLowerCase()
    const value = sp === -1 ? '' : line.slice(sp + 1).trim()
    if (!single.has(key)) single.set(key, value)
    const list = multi.get(key)
    if (list) list.push(value)
    else multi.set(key, [value])
  }
  const hostname = single.get('hostname')
  const user = single.get('user')
  const port = Number(single.get('port') ?? '22')
  if (!hostname || !user || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('ssh -G did not report a hostname, user and port')
  }
  const words = (k: string): string[] =>
    (single.get(k) ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => expandHomePath(p, home))
  const opt = (k: string): string | undefined => {
    const v = single.get(k)
    return v && v !== 'none' ? v : undefined
  }
  const timeout = Number(single.get('connecttimeout'))
  return {
    hostname,
    port,
    user,
    identityFiles: (multi.get('identityfile') ?? []).map((p) => expandHomePath(p, home)),
    identitiesOnly: single.get('identitiesonly') === 'yes',
    identityAgent: opt('identityagent'),
    proxyJump: opt('proxyjump'),
    proxyCommand: opt('proxycommand'),
    hostKeyAlias: opt('hostkeyalias'),
    userKnownHostsFiles: words('userknownhostsfile'),
    globalKnownHostsFiles: words('globalknownhostsfile'),
    strictHostKeyChecking: single.get('stricthostkeychecking') ?? 'ask',
    connectTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    addKeysToAgent: single.get('addkeystoagent')
  }
}

/**
 * A destination to evaluate: a project's target (every field the argv gave), or one ProxyJump hop,
 * which names only what its spec wrote — an absent user or port is the hop's OWN config's answer,
 * exactly as OpenSSH's jump ssh (`ssh [-l user] [-p port] -W … hop`) resolves it.
 */
export interface HostQuery {
  user?: string
  host: string
  port?: number
  identityFile?: string
  identityAgent?: string
}

/** `ssh -G` argv for a destination with the same command-line overrides the transport applies. */
export function sshGArgs(t: HostQuery): string[] {
  // A destination beginning with `-` would be read as an option by ssh.
  if (t.host.startsWith('-') || t.user?.startsWith('-')) throw new Error(`ssh: invalid destination ${t.host}`)
  const args = ['-G']
  if (t.port !== undefined) args.push('-p', String(t.port))
  if (t.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', t.identityFile)
  if (t.user) args.push('-l', t.user)
  args.push(t.host)
  return args
}

/** One ProxyJump hop as written: `[user@]host[:port]` or `ssh://[user@]host[:port]`. */
export interface JumpSpec {
  user?: string
  host: string
  port?: number
}

/**
 * Parse a ProxyJump value (a comma-separated chain, first hop first) the way OpenSSH's
 * parse_jump does. `ssh -G` prints the last hop normalized (`user@[host]:port`, numeric hosts in
 * brackets) and the earlier ones as written, so both forms are accepted. Throws on anything else —
 * a hop we cannot read must not be guessed at.
 */
export function parseProxyJump(value: string): JumpSpec[] {
  const hops = value.split(',').map((h) => h.trim())
  if (!hops.length || hops.some((h) => !h)) throw new Error(`ssh: invalid ProxyJump "${value}"`)
  return hops.map((raw) => {
    const bad = (): Error => new Error(`ssh: invalid ProxyJump hop "${raw}"`)
    let rest = raw
    if (/^ssh:\/\//i.test(rest)) {
      rest = rest.slice(6)
      if (rest.endsWith('/')) rest = rest.slice(0, -1)
      if (rest.includes('/')) throw bad()
    }
    let user: string | undefined
    const at = rest.lastIndexOf('@')
    if (at !== -1) {
      user = rest.slice(0, at)
      rest = rest.slice(at + 1)
      if (!user) throw bad()
    }
    let host: string
    let portText: string | undefined
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']')
      if (close === -1) throw bad()
      host = rest.slice(1, close)
      const after = rest.slice(close + 1)
      if (after) {
        if (!after.startsWith(':')) throw bad()
        portText = after.slice(1)
      }
    } else {
      const colon = rest.indexOf(':')
      if (colon !== -1 && rest.indexOf(':', colon + 1) !== -1) throw bad() // bare IPv6: needs [ ]
      host = colon === -1 ? rest : rest.slice(0, colon)
      portText = colon === -1 ? undefined : rest.slice(colon + 1)
    }
    if (!host || host.startsWith('-') || /[\s,]/.test(host) || user?.startsWith('-')) throw bad()
    let port: number | undefined
    if (portText !== undefined) {
      port = Number(portText)
      if (!/^\d+$/.test(portText) || port <= 0 || port > 65535) throw bad()
    }
    return { user, host, port }
  })
}
