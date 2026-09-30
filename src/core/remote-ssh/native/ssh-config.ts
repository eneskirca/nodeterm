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
    connectTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
  }
}

/** `ssh -G` argv for a destination with the same command-line overrides the transport applies. */
export function sshGArgs(t: { user: string; host: string; port?: number; identityFile?: string }): string[] {
  const args = ['-G', '-p', String(t.port ?? 22)]
  if (t.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', t.identityFile)
  args.push(`${t.user}@${t.host}`)
  return args
}
