/**
 * Pure helpers for launching the system `ssh` binary as a terminal session program.
 * No Electron, no node-pty — unit-testable in isolation.
 */

/** A single SSH connection's parameters (inline-persisted on a node as `data.ssh`). */
export interface SshConnection {
  host: string
  user: string
  /** Defaults to 22. */
  port?: number
  /** Optional `-i` identity file path. */
  identityFile?: string
  /** Optional raw extra ssh args (advanced), POSIX-tokenized. */
  extraArgs?: string
  /**
   * PROVENANCE, in memory only: this machine's own `extraArgs`, set by the two local producers —
   * `createSshTerminalNode` (copied from the machine-local SSH server store, i.e. typed by the user)
   * and `applyLocalNodeExec` (re-attached from the machine-local workspace index). It is NEVER
   * written to a project file (`stripSharedNodeExec`) and NEVER accepted off the wire
   * (`sanitizeInboundNode`), so a cloned project.json or a canvas-sync peer cannot set it.
   *
   * Only a trusted `extraArgs` may carry the ssh options that make the LOCAL machine execute a
   * command (`ProxyCommand` & co). A corporate jump host is a legitimate reason to have one — an
   * untrusted document is not. See `stripLocalExecArgs`.
   */
  execTrusted?: boolean
  /** Display label, copied from the saved server when the node is created. */
  label?: string
}

/**
 * ssh options that make ssh RUN SOMETHING, on this machine unless noted. `-o ProxyCommand=<cmd>`
 * is the classic one: ssh executes `<cmd>` locally through /bin/sh, every time the node opens.
 *
 * - `proxycommand`, `localcommand` (+ `permitlocalcommand`), `knownhostscommand` — local exec.
 * - `match` — `Match exec "<cmd>"` runs `<cmd>` locally to decide whether the block applies.
 * - `include` — pulls in another config file, which may carry any of the above.
 * - `pkcs11provider`, `securitykeyprovider` — dlopen a local shared object: code execution.
 * - `proxyusefdpass` — only meaningful alongside ProxyCommand; refused with it.
 * - `remotecommand` — exec on the far side rather than here, but still not something a document
 *   gets to choose.
 */
const LOCAL_EXEC_SSH_OPTIONS = new Set([
  'proxycommand',
  'localcommand',
  'permitlocalcommand',
  'knownhostscommand',
  'match',
  'include',
  'pkcs11provider',
  'securitykeyprovider',
  'proxyusefdpass',
  'remotecommand'
])

/** The keyword of an ssh `-o` value: `ProxyCommand=x`, `ProxyCommand x` and a bare `Match` all
 *  yield `proxycommand` / `match`. */
function optionKeyword(value: string): string {
  return value.split(/[=\s]/, 1)[0].trim().toLowerCase()
}

/**
 * Remove the exec-enabling options from a tokenized extra-args list — the exec-site guard, in the
 * same idiom as `permissionModeFlag` / `SAFE_SESSION_ID`: re-validate where the value BECOMES a
 * command, and degrade safely (the connection is still attempted, just without the option that
 * would have run code). Everything else — `-J jump`, `-o StrictHostKeyChecking=no`, `-A`, `-v` —
 * passes through untouched.
 *
 * Both spellings of an option are covered (`-o ProxyCommand=x` and `-oProxyCommand=x`), and `-F`
 * (an alternate ssh_config, which may itself carry a ProxyCommand) counts as exec-enabling.
 */
export function stripLocalExecArgs(tokens: string[]): { args: string[]; dropped: string[] } {
  const args: string[] = []
  const dropped: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // `-F <file>` / `-F<file>`: an ssh_config we did not write.
    if (t === '-F') {
      dropped.push(t, ...(i + 1 < tokens.length ? [tokens[++i]] : []))
      continue
    }
    if (t.startsWith('-F') && t.length > 2) {
      dropped.push(t)
      continue
    }
    if (t === '-o') {
      const value = tokens[i + 1]
      if (value !== undefined && LOCAL_EXEC_SSH_OPTIONS.has(optionKeyword(value))) {
        dropped.push(t, value)
        i++
        continue
      }
      args.push(t)
      continue
    }
    if (t.startsWith('-o') && t.length > 2 && LOCAL_EXEC_SSH_OPTIONS.has(optionKeyword(t.slice(2)))) {
      dropped.push(t)
      continue
    }
    args.push(t)
  }
  return { args, dropped }
}

/** Would this raw extra-args string make ssh execute something? (Used to decide whether a value of
 *  unknown provenance may enter the machine-local store — see `localNodeExec`.) */
export function sshExtraArgsEnableLocalExec(extraArgs: string | undefined): boolean {
  return stripLocalExecArgs(parseExtraArgs(extraArgs)).dropped.length > 0
}

/** A saved server in the app's SSH store. `label` is required for display. */
export interface SshServer extends SshConnection {
  id: string
  label: string
  /** Where browsing this machine STARTS: the folder the "New remote" project dialog opens at, and
   *  the folder Test connection dials. It is a starting point, not an inherited default — a node's
   *  cwd comes from the project or node it was created in, never from here. Absent means `~`. */
  remoteCwd?: string
}

/**
 * Stable live-connection scope for an SSH host ATTACHED to a canvas project — i.e. a remote node
 * living in a project that is not itself that endpoint's SSH project.
 *
 * Scoped by project AND endpoint, so two projects attaching the same host get their own
 * ControlMaster (and their own reconnect loop), and one project attaching two hosts gets two. The
 * endpoint is FNV-1a hashed rather than embedded: this id reaches the filesystem as part of the
 * ControlMaster socket path, where a raw `user@host:port` would both leak the inventory and blow
 * the sun_path length budget on a long hostname.
 */
export function sshAttachmentId(projectId: string, conn: SshConnection): string {
  const input = `${conn.user}\0${conn.host}\0${conn.port ?? 22}`
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `attached-${projectId}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * Connection scope used by a remote node inside a project.
 *
 * An SSH PROJECT owns its ControlMaster under the project id — that is the whole of today's
 * model, and this returns exactly that whenever the project's own binding already reaches the
 * node's machine. A remote node embedded in a LOCAL project (or in an SSH project bound to a
 * DIFFERENT machine) owns a host attachment instead, under the stable project × endpoint id.
 *
 * Every consumer of that connection — spawn (`resolveSshRemote`), reconnect (`SshReconnector`),
 * upload — must make the same choice, or a node resolves a master that was opened for someone
 * else. Hence one function rather than the rule written out at each site.
 *
 * ## Why the project's binding wins on a HOST match, user and port included
 *
 * A node's `ssh` is a SNAPSHOT persisted into the canvas, and an SSH project's canvas lives in
 * `<remoteCwd>/.nodeterm/project.json` ON THE HOST — shared with everyone who opens that folder.
 * So the `user` (and port) on a node is whoever created it, not whoever is reading it: alice's
 * nodes say `alice@box`, and when bob opens the same project as `bob@box` every one of them would
 * ask for a second master dialing `alice@box` — which fails for bob, or worse sits on an askpass
 * prompt. The project's binding is the authority on how THIS user reaches that machine, so a node
 * naming the same host is served by it.
 *
 * The cost is a deliberate one: inside an SSH project you cannot pin a node to a second ACCOUNT on
 * the same host. A different machine still gets its own attachment, which is the case this is for.
 */
export function sshConnectionIdForProject(
  projectId: string,
  conn: SshConnection,
  projectServer?: SshConnection
): string {
  // `conn.host` is checked explicitly: a node whose binding lost its host (bad persisted data)
  // must not match a LOCAL project's absent one through `undefined === undefined` and get served
  // from a master that was never opened for it. Unroutable either way — but failing as an
  // attachment ends at `requireRemote` refusing the spawn, which is the safe direction.
  return conn.host && projectServer?.host === conn.host
    ? projectId
    : sshAttachmentId(projectId, conn)
}

/**
 * Split a raw extra-args string into argv tokens, honoring single and double quotes.
 * Unquoted whitespace separates tokens; quotes group; quote chars are stripped.
 */
export function parseExtraArgs(s: string | undefined): string[] {
  if (!s || !s.trim()) return []
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) tokens.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) tokens.push(cur)
  return tokens
}

/**
 * Stable identity key for the host a connection targets, used to scope managed Claude accounts to
 * an SSH project (`ClaudeAccount.host`). `${user}@${host}` — the same target string ssh itself
 * builds. Port and identity file are intentionally excluded: a remote account is defined by which
 * remote `$HOME` (i.e. which user on which host) its config dir lives under, and two projects that
 * reach the same account over different ports still share that one remote dir.
 */
export function sshHostKey(conn: Pick<SshConnection, 'host' | 'user'>): string {
  return `${conn.user}@${conn.host}`
}

/**
 * Build the `ssh` argv: `-p <port> [-i <id>] [...extra] user@host`.
 *
 * `extraArgs` is spliced in verbatim ONLY when the connection is `execTrusted` — i.e. the value
 * came from this machine (the user's SSH server store, or the machine-local workspace index). Any
 * other value contributes NOTHING: a `.nodeterm/project.json` from a cloned repo, or a canvas-sync
 * peer's node, must never be able to add ssh flags at all. The connection is still attempted —
 * degrade, never block.
 */
export function buildSshArgs(conn: SshConnection): string[] {
  const args = ['-p', String(conn.port ?? 22)]
  if (conn.identityFile) args.push('-i', conn.identityFile)
  const extra = parseExtraArgs(conn.extraArgs)
  if (conn.execTrusted) {
    args.push(...extra)
  }
  // else: an UNTRUSTED extraArgs contributes no tokens. `stripLocalExecArgs` removes the
  // exec-enabling OPTIONS, but the survivors are still not safe to splice: a bare token
  // (`evilhost`) has no exec option so it passes the strip with dropped=[], and ssh reads the
  // first positional argument as the DESTINATION — silently retargeting the connection. Flags like
  // `-A` (agent forwarding) or `-J` (jump host) from a document are unwanted too. An untrusted
  // source has no legitimate need to add ssh args (this branch isn't even reached today —
  // untrusted extraArgs is stripped upstream), so the empty list is the only safe degrade; there
  // is no residue to reason about token by token.
  args.push(`${conn.user}@${conn.host}`)
  return args
}

/** Single-quote a string for use as ONE POSIX shell token (safe inside a remote command). */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a remote path as one shell token, but leave a leading `~` / `~/` UNQUOTED so the remote
 * shell tilde-expands it (single quotes suppress `~` expansion). The remainder stays quoted, so a
 * directory name can never inject shell. `~` alone → `~`; `~/a b` → `~/'a b'`; `/srv/x` → `'/srv/x'`.
 */
export function quoteRemotePath(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) return p.length > 2 ? `~/${posixQuote(p.slice(2))}` : '~/'
  return posixQuote(p)
}

/** Remote variant of pty-manager's tmuxConf — same behavior, same reasoning (see `tmuxConf` for
 *  the long version). Mouse ON: tmux owns scrolling and selection, the pane is on the alternate
 *  screen, and NOTHING is hydrated on reattach (tmux redraws and its own history is scrollable).
 *  Copy goes out as OSC 52, which the client's handler writes to the LOCAL clipboard — this is the
 *  only thing that ever made copying work over SSH. It needs `terminal-features ",*:clipboard"`:
 *  the `terminal-overrides ',xterm*:Ms=...'` entry this config used to carry emits NOTHING on
 *  tmux 3.2+ (measured), so it is gone — do not add it back. */
export function remoteTmuxConf(scrollback: number): string {
  return `# auto-generated by node-terminal (remote) — do not edit
set -g status off
set -g mouse on
set -g history-limit ${Math.max(1000, scrollback)}
set -g default-terminal "xterm-256color"
set -sg escape-time 10
set -g destroy-unattached off
setw -g aggressive-resize on
# OSC 52 to the client, which writes the LOCAL clipboard. BOTH lines are needed on tmux 3.2+ — see
# remoteTmuxConf's doc comment before touching either.
# MIGRATION — do not remove. Older versions of this file blanked smcup/rmcup/indn via
# terminal-overrides, and a long-lived tmux server keeps every entry ever sourced into it (the
# array only grows; -f is read once at server start). With those stale entries present the client
# never returns to the alternate screen and scrolling stays broken NO MATTER what this file sets
# below. Unset both arrays back to defaults, then re-add the one feature we actually want.
set -su terminal-overrides
set -su terminal-features
set -g set-clipboard on
set -as terminal-features ",*:clipboard"
# Mouse copy: tmux copies to its buffer AND emits OSC 52. No pipe to a local command — it would run
# on the REMOTE host, which is nobody's clipboard.
bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel
bind -T copy-mode    DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi DoubleClick1Pane send-keys -X select-word \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode    TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
bind -T copy-mode-vi TripleClick1Pane send-keys -X select-line \\; send-keys -X copy-pipe-and-cancel
`
}

/** Build the remote shell command that attaches-or-creates this node's remote tmux session. */
export function remoteTmuxCommand(opts: {
  sessionId: string
  remoteCwd: string
  program?: string
  programArgs?: string[]
  socket?: string
  /** When set, sources this remote conf via `-f` (spliced before `new-session`). */
  confPath?: string
}): string {
  const socket = opts.socket ?? 'nodeterm-rmt'
  const parts = [
    'tmux',
    '-L',
    socket,
    ...(opts.confPath ? ['-f', posixQuote(opts.confPath)] : []),
    'new-session',
    '-A',
    '-s',
    posixQuote(opts.sessionId),
    '-c',
    quoteRemotePath(opts.remoteCwd)
  ]
  if (opts.program) {
    parts.push(posixQuote(opts.program))
    for (const a of opts.programArgs ?? []) parts.push(posixQuote(a))
  }
  return parts.join(' ')
}

/** Parse `ls -1Ap <dir>` output into sorted directory names (trailing `/`), excluding . and .. */
export function parseLsDirs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('/') && l !== './' && l !== '../')
    .map((l) => l.slice(0, -1))
    .sort((a, b) => a.localeCompare(b))
}

/** A host parsed from `~/.ssh/config`, ready to seed a saved server (no id yet). */
export interface ParsedSshHost {
  /** The `Host` alias (display label). */
  label: string
  /** `HostName` if set, else the alias. */
  host: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * Parse `~/.ssh/config` text into named hosts. Each non-wildcard `Host` alias becomes one
 * entry, taking the block's `HostName`/`User`/`Port`/`IdentityFile`. Wildcard aliases
 * (containing `*` or `?`) and the bare `Host *` catch-all are skipped — they aren't concrete
 * servers. Keys are case-insensitive; `key=value` and `key value` forms are both accepted.
 */
export function parseSshConfig(text: string): ParsedSshHost[] {
  const hosts: ParsedSshHost[] = []
  // Aliases sharing one `Host` line all receive the block's settings.
  let current: { aliases: string[]; settings: Record<string, string> } | null = null

  const flush = () => {
    if (!current) return
    for (const alias of current.aliases) {
      if (alias.includes('*') || alias.includes('?')) continue
      const s = current.settings
      const port = s.port ? Number(s.port) : undefined
      hosts.push({
        label: alias,
        host: s.hostname || alias,
        user: s.user || undefined,
        port: Number.isFinite(port) ? port : undefined,
        identityFile: s.identityfile || undefined
      })
    }
    current = null
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const eq = line.indexOf('=')
    const sp = line.search(/\s/)
    let key: string
    let value: string
    if (eq !== -1 && (sp === -1 || eq < sp)) {
      key = line.slice(0, eq).trim()
      value = line.slice(eq + 1).trim()
    } else if (sp !== -1) {
      key = line.slice(0, sp).trim()
      value = line.slice(sp + 1).trim()
    } else {
      key = line
      value = ''
    }
    const lkey = key.toLowerCase()
    if (lkey === 'host') {
      flush()
      current = { aliases: value.split(/\s+/).filter(Boolean), settings: {} }
    } else if (current) {
      current.settings[lkey] = value
    }
  }
  flush()
  return hosts
}
