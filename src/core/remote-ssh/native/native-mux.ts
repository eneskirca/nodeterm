// The in-process SSH transport: one ssh2 connection per ControlPath, multiplexing every exec,
// pty and forward the app runs for an SSH project — the job OpenSSH's ControlMaster does on POSIX.
//
// WHY it exists (measured on windows-latest, 2026-09-30, OpenSSH_for_Windows_9.5p2): Windows'
// own ssh cannot multiplex at all. `ssh -M` fails with `getsockname failed: Not a socket`, and a
// child carrying `ControlPath` does not even fall back to a direct connection — it FAILS, so on a
// stock Windows machine an SSH project opened no terminal and ran no remote command. Git for
// Windows' ssh (10.5p1) brings a master up but every session request over it dies with
// `mux_client_request_session: read from master failed: Connection reset by peer` and falls back
// to a full login per command. Neither is a transport. POSIX keeps OpenSSH untouched; this module
// is what `native-invoke.ts` routes to on win32.
//
// Semantics are the ones the argv builders ask OpenSSH for, so a call site cannot tell which
// transport ran it:
//  - ControlMaster=auto: a command on a path with no live connection ESTABLISHES one (the first
//    child becomes the master), and it is shared from then on;
//  - ControlMaster=no: never create the shared connection — a missing one runs the command on a
//    one-off connection, as OpenSSH's direct fallback does (BatchMode: no prompts on it);
//  - -O check/exit/forward/cancel answer from the shared connection;
//  - StrictHostKeyChecking=accept-new (known-hosts.ts), PasswordAuthentication=no and
//    KbdInteractiveAuthentication=no: publickey only, via agent then key files;
//  - ServerAliveInterval/CountMax → ssh2 keepalive; ConnectTimeout bounds the TCP connect only
//    (a passphrase prompt is not cut off by it, as with OpenSSH);
//  - a connection that drops ends every channel on it with exit 255, which is what a mux'd
//    OpenSSH client reports and what the renderer's SshReconnector already listens for;
//  - ProxyJump: each hop is its own SSH connection with its OWN `ssh -G` config (user, port,
//    identity files, known hosts, agent), and the next hop — finally the target — runs over a
//    direct-tcpip channel of the previous one, which is what OpenSSH's `ssh -W` jump process does.
//    See `jumpChain` for how a chain and a hop's own ProxyJump are resolved. ProxyCommand is
//    refused by name (it runs an arbitrary local program as the transport).

import net from 'net'
import type { Duplex } from 'stream'
import fs from 'fs'
import { Client, createAgent, utils, type Channel, type ClientChannel, type ConnectConfig, type UNIXConnectionDetails, type ParsedKey, type SFTPWrapper } from 'ssh2'
import type { ParsedSsh, ReverseForward, SshOptions, SshTarget } from './ssh-argv'
import { parseProxyJump, type HostQuery, type JumpSpec, type ResolvedHost } from './ssh-config'
import { acceptNewHostKey } from './known-hosts'
import { addKeyToAgent, type AgentAddResult } from './agent-add'

/** Result of one remote command, in the shape execFile callers already handle. */
export interface ExecResult {
  code: number | null
  signal: string | null
  stdout: Buffer
  stderr: Buffer
  /** True when the timeout ended it (execFile's `killed`). */
  timedOut: boolean
}

export interface NativeMuxDeps {
  /** Effective config for a destination (`ssh -G`; see ssh-config.ts). A ProxyJump hop is asked
   *  with only what its spec names (user/port may be absent — the hop's own config answers). */
  resolveHost(target: HostQuery): Promise<ResolvedHost>
  /** Ask the user for a key's passphrase; null = cancelled (or nobody answered). Absent = never
   *  prompt. `retry`: the previous answer was wrong. `target`: `user@host`, for the dialog. */
  askPassphrase?(identityFile: string, req: { retry: boolean; target: string }): Promise<string | null>
  /** Default agent when the config names none (`SSH_AUTH_SOCK` / Windows' openssh-ssh-agent pipe). */
  defaultAgent?(): string | undefined
  readFile?(p: string): Buffer | null
  /**
   * Whether (and how) to load a key the user just unlocked with a passphrase into `agentPath` —
   * the native transport's `AddKeysToAgent`. null = do not. Absent = never. Asked only after the
   * connection authenticated WITH that key; the add itself is fire-and-forget and fail-open.
   */
  agentAdd?(req: { agentPath: string; host: ResolvedHost; identityFile: string }): { lifetimeSec?: number } | null
  /** Test seam: the agent add (agent-add.ts's addKeyToAgent). */
  addKeyToAgent?: typeof addKeyToAgent
  /** Test seam: the TCP (or proxy) socket to run the protocol over. */
  connectSocket?(host: string, port: number, timeoutMs: number): Promise<net.Socket>
  log?(line: string): void
}

/** How long a passphrase prompt may hold the handshake open (matches the askpass PROMPT_WAIT_MS). */
const AUTH_WAIT_MS = 5 * 60_000 + 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

interface Conn {
  key: string
  client: Client
  ready: Promise<void>
  alive: boolean
  closed: Promise<string>
  forwards: Map<string, ReverseForward>
  target: SshTarget
  options: SshOptions
  /** Channels open on this connection right now. */
  channels: number
  /** The server refused a channel here (its MaxSessions): skip it until one closes. */
  full: boolean
  /** The ProxyJump chain this connection runs over, first hop first ([] = direct). An overflow
   *  connection BORROWS its primary's chain, so only the primary owns (and ends) these. */
  jumps: Client[]
  ownsJumps: boolean
}

/** How deep a first hop's own ProxyJump may recurse before we call it a loop. */
const MAX_JUMP_DEPTH = 8

interface Hop {
  /** How the hop was named (alias as written), for messages and the passphrase dialog. */
  query: HostQuery & { user: string }
  host: ResolvedHost
}

/**
 * Connections a group may grow to when the server refuses channels (MaxSessions — 10 on a stock
 * sshd). OpenSSH's answer to the same refusal is a full login per refused client with no bound at
 * all; this one is bounded so a runaway cannot trip the host's MaxStartups.
 */
export const MAX_OVERFLOW_CONNECTIONS = 12

/** ssh2's error for a channel the server refused to open (MaxSessions reached). */
function isChannelRefused(e: unknown): boolean {
  return e instanceof Error && /Channel open failure/i.test(e.message)
}

function targetKey(t: SshTarget): string {
  return `${t.user}@${t.host}:${t.port}|${t.identityFile ?? ''}`
}

/** The error text OpenSSH prints for a control socket nobody is listening on. */
export function noMasterMessage(controlPath: string): string {
  return `Control socket connect(${controlPath}): No such file or directory`
}

function defaultConnectSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new Error(`ssh: connect to host ${host} port ${port}: Operation timed out`))
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`ssh: connect to host ${host} port ${port}: ${e.message}`))
    })
  })
}

export class NativeMux {
  /** The PRIMARY connection per ControlPath — the one -O check/exit and forwards speak about. */
  private conns = new Map<string, Conn>()
  /**
   * Extra connections a ControlPath grew because its primary's server refused channels. They live
   * and die with the primary, exactly as mux clients die with their ControlMaster.
   */
  private overflow = new Map<string, Conn[]>()
  /**
   * Keys unlocked with a passphrase during this process, so an overflow connection (never
   * interactive) can authenticate without asking again. Held only while some connection is alive —
   * the "decrypted key in memory for the connection's life" tradeoff of this transport on Windows,
   * where there is no app-private ssh-agent to hold it instead. (The Windows OpenSSH agent service
   * would PERSIST it, so the key reaches that agent only on an explicit opt-in — agent-add.ts.)
   */
  private unlocked = new Map<string, ParsedKey>()

  constructor(private deps: NativeMuxDeps) {}

  /** Is there a live shared connection on this path (`-O check`)? */
  check(controlPath: string): boolean {
    return this.conns.get(controlPath)?.alive === true
  }

  /** End the shared connection (`-O exit`). Resolves once it is closed. */
  async exit(controlPath: string): Promise<boolean> {
    const c = this.conns.get(controlPath)
    if (!c) return false
    this.conns.delete(controlPath)
    c.alive = false
    c.client.end()
    this.endOverflow(controlPath)
    await Promise.race([c.closed, new Promise((r) => setTimeout(r, 2000))])
    return true
  }

  /** End every connection (app quit). */
  exitAll(): void {
    for (const [cp, c] of this.conns) {
      this.conns.delete(cp)
      c.alive = false
      c.client.end()
      this.endOverflow(cp)
    }
    this.unlocked.clear()
  }

  /** Connections a ControlPath has open (primary + overflow) — diagnostics and tests. */
  connectionCount(controlPath: string): number {
    return (this.conns.get(controlPath)?.alive ? 1 : 0) + (this.overflow.get(controlPath)?.length ?? 0)
  }

  private endOverflow(controlPath: string): void {
    for (const o of this.overflow.get(controlPath) ?? []) {
      o.alive = false
      o.client.end()
    }
    this.overflow.delete(controlPath)
  }

  /**
   * Open a channel on the ControlPath's group: the first connection not known to be full; on a
   * refusal, mark it full and move on, growing an overflow connection when every one is. `open`
   * is the ssh2 call that opens the channel on a given client.
   */
  private async openOn<T extends NodeJS.EventEmitter>(
    controlPath: string,
    primary: Conn,
    open: (client: Client, cb: (err: Error | undefined, ch: T) => void) => void,
    /** Runs INSIDE ssh2's callback, before any await: a consumer attached later can miss the
     *  channel's exit and close, which may arrive in the same read as the open confirmation. */
    onOpen?: (ch: T) => void
  ): Promise<T> {
    for (let attempt = 0; attempt <= MAX_OVERFLOW_CONNECTIONS + 1; attempt++) {
      if (!primary.alive) throw new Error(noMasterMessage(controlPath))
      const group = [primary, ...(this.overflow.get(controlPath) ?? [])].filter((c) => c.alive)
      let conn = group.find((c) => !c.full)
      if (!conn) {
        const extra = this.overflow.get(controlPath) ?? []
        if (extra.length >= MAX_OVERFLOW_CONNECTIONS) {
          throw new Error('ssh: channel open failed: the server refused more sessions (MaxSessions)')
        }
        // Over the primary's own jump chain (see `connect`): one bastion login per project, and the
        // group already lives and dies with the primary, which is what owns the chain.
        conn = this.open(`${controlPath}#${extra.length + 1}`, primary.target, primary.options, { interactive: false }, primary)
        const added = conn
        extra.push(added)
        this.overflow.set(controlPath, extra)
        void added.closed.then(() => {
          const list = this.overflow.get(controlPath)
          if (list) this.overflow.set(controlPath, list.filter((o) => o !== added))
        })
      }
      await conn.ready
      const c = conn
      try {
        return await new Promise<T>((resolve, reject) =>
          open(c.client, (err, ch) => {
            if (err) return reject(err)
            c.channels++
            ch.once('close', () => {
              c.channels--
              c.full = false
            })
            onOpen?.(ch)
            resolve(ch)
          })
        )
      } catch (e) {
        if (!isChannelRefused(e)) throw e
        c.full = true
      }
    }
    throw new Error('ssh: channel open failed')
  }

  /**
   * Bring up (or reuse) the shared connection — `ssh -M -N`, or the implicit master of a
   * ControlMaster=auto child. Resolves when authenticated; rejects with an OpenSSH-shaped message.
   * `closed` resolves (never rejects) with the reason once the connection is gone, which is what a
   * master PROCESS's exit is to the manager.
   */
  async master(controlPath: string, target: SshTarget, options: SshOptions): Promise<{ closed: Promise<string> }> {
    const existing = this.conns.get(controlPath)
    if (existing?.alive) {
      await existing.ready
      return { closed: existing.closed }
    }
    const conn = this.open(controlPath, target, options, { interactive: options.batchMode !== true })
    this.conns.set(controlPath, conn)
    try {
      await conn.ready
    } catch (e) {
      if (this.conns.get(controlPath) === conn) this.conns.delete(controlPath)
      throw e
    }
    return { closed: conn.closed }
  }

  /** Run one parsed `exec` argv. Never rejects: failures are exit 255 with stderr, like ssh. */
  async exec(
    p: Extract<ParsedSsh, { kind: 'exec' }>,
    io: { stdin?: string | Buffer; timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const cp = p.options.controlPath
    let conn: Conn | undefined = cp ? this.conns.get(cp) : undefined
    let oneOff: Conn | undefined
    try {
      if (!conn?.alive) {
        if (cp && p.options.controlMaster !== 'no') {
          await this.master(cp, p.target, p.options)
          conn = this.conns.get(cp)
        } else {
          oneOff = this.open(`oneoff:${Math.random()}`, p.target, p.options, { interactive: false })
          conn = oneOff
        }
      }
      if (!conn) throw new Error(cp ? noMasterMessage(cp) : 'ssh: no connection')
      await conn.ready
      const c = conn
      let result!: Promise<ExecResult>
      const start = (ch: ClientChannel): void => {
        recordExit(ch)
        result = this.collect(ch, io)
      }
      if (cp && !oneOff) {
        await this.openOn<ClientChannel>(cp, c, (client, cb) => client.exec(p.command ?? '', cb), start)
      } else {
        await new Promise<void>((resolve, reject) =>
          c.client.exec(p.command ?? '', (err, ch) => {
            if (err) return reject(err)
            start(ch)
            resolve()
          })
        )
      }
      return await result
    } catch (e) {
      return fail(e)
    } finally {
      oneOff?.client.end()
    }
  }

  /** A pty channel for an interactive session (`ssh -t … <command>`). */
  async shell(
    p: Extract<ParsedSsh, { kind: 'exec' }>,
    pty: { cols: number; rows: number; term?: string }
  ): Promise<ClientChannel> {
    return this.channel(p, pty)
  }

  /**
   * A channel for `p`'s command, with a pty or without — the streaming form of `exec` for a caller
   * that reads output as it arrives (the setup runner). Same master rules as `exec`.
   */
  async channel(
    p: Extract<ParsedSsh, { kind: 'exec' }>,
    pty?: { cols: number; rows: number; term?: string }
  ): Promise<ClientChannel> {
    const cp = p.options.controlPath
    if (!cp) throw new Error('ssh: a pty needs a ControlPath')
    if (!this.conns.get(cp)?.alive) {
      if (p.options.controlMaster === 'no') throw new Error(noMasterMessage(cp))
      await this.master(cp, p.target, p.options)
    }
    const conn = this.conns.get(cp)!
    await conn.ready
    const ptyOpts = pty ? { cols: pty.cols, rows: pty.rows, term: pty.term ?? 'xterm-256color' } : undefined
    return this.openOn<ClientChannel>(cp, conn, (client, cb) => {
      // recordExit runs INSIDE ssh2's callback, before anything can be awaited (see recordExit).
      const done = (err: Error | undefined, ch: ClientChannel): void => {
        if (!err) recordExit(ch)
        cb(err, ch)
      }
      if (!ptyOpts) client.exec(p.command ?? '', done)
      else if (p.command) client.exec(p.command, { pty: ptyOpts }, done)
      else client.shell(ptyOpts, done)
    })
  }

  /**
   * An SFTP session for scp's argv. The shared connection when there is one; otherwise a one-off
   * connection (scp's builders say ControlMaster=no, i.e. never become the master) that closes
   * with the session.
   */
  async sftp(controlPath: string | undefined, target: SshTarget, options: SshOptions): Promise<SFTPWrapper> {
    let conn = controlPath ? this.conns.get(controlPath) : undefined
    let oneOff = false
    if (!conn?.alive) {
      conn = this.open(`oneoff:${Math.random()}`, target, options, { interactive: false })
      oneOff = true
    }
    const c = conn
    try {
      await c.ready
      const s =
        controlPath && !oneOff
          ? await this.openOn<SFTPWrapper>(controlPath, c, (client, cb) => client.sftp(cb))
          : await new Promise<SFTPWrapper>((resolve, reject) =>
              c.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
            )
      if (oneOff) s.on('close', () => c.client.end())
      return s
    } catch (e) {
      if (oneOff) c.client.end()
      throw e
    }
  }

  /** `-O forward -R <remoteSock>:<host>:<port>`: remote unix socket → local TCP. */
  async forward(controlPath: string, fwd: ReverseForward): Promise<void> {
    const conn = this.conns.get(controlPath)
    if (!conn?.alive) throw new Error(noMasterMessage(controlPath))
    await conn.ready
    await new Promise<void>((resolve, reject) =>
      conn.client.openssh_forwardInStreamLocal(fwd.remoteSocket, (err) => (err ? reject(err) : resolve()))
    )
    conn.forwards.set(fwd.remoteSocket, fwd)
  }

  /** `-O cancel -R …`. A forward that is not there is not an error (same as ssh). */
  async cancel(controlPath: string, fwd: ReverseForward): Promise<void> {
    const conn = this.conns.get(controlPath)
    if (!conn?.alive || !conn.forwards.has(fwd.remoteSocket)) return
    conn.forwards.delete(fwd.remoteSocket)
    await new Promise<void>((resolve) =>
      conn.client.openssh_unforwardInStreamLocal(fwd.remoteSocket, () => resolve())
    )
  }

  // ---------------------------------------------------------------------------------------------

  /** Drain an exec channel into an ExecResult (stdin written, timeout enforced). */
  private collect(ch: ClientChannel, io: { stdin?: string | Buffer; timeoutMs?: number }): Promise<ExecResult> {
    return new Promise((resolve) => {
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      if (io.timeoutMs && io.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          ch.close()
        }, io.timeoutMs)
      }
      ch.on('data', (d: Buffer) => out.push(d))
      ch.stderr.on('data', (d: Buffer) => errOut.push(d))
      ch.on('close', () => {
        if (timer) clearTimeout(timer)
        const { code: c, signal } = channelExit(ch)
        // A channel that closed with no exit status was cut off (connection dropped, or our own
        // timeout): report it the way a mux'd ssh does, 255.
        const code = c === null && signal === null ? 255 : c
        resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(errOut), timedOut })
      })
      if (io.stdin !== undefined) ch.end(io.stdin)
      else ch.end()
    })
  }

  private open(
    controlPath: string,
    target: SshTarget,
    options: SshOptions,
    mode: { interactive: boolean },
    via?: Conn
  ): Conn {
    const client = new Client()
    let resolveClosed!: (why: string) => void
    const closed = new Promise<string>((r) => (resolveClosed = r))
    const conn: Conn = {
      key: targetKey(target),
      client,
      ready: Promise.resolve(),
      alive: true,
      closed,
      forwards: new Map(),
      target,
      options,
      channels: 0,
      full: false,
      jumps: [],
      ownsJumps: false
    }
    let lastError = ''
    client.on('error', (e: Error & { level?: string }) => {
      lastError = e.message
      this.deps.log?.(`[native-ssh] ${target.user}@${target.host}: ${e.message}`)
    })
    client.on('close', () => {
      conn.alive = false
      // The jump connections belong to the target connection: they end with it.
      if (conn.ownsJumps) for (const j of conn.jumps) j.end()
      if (this.conns.get(controlPath) === conn) {
        this.conns.delete(controlPath)
        // The group dies with its primary, as mux clients die with their ControlMaster.
        this.endOverflow(controlPath)
      }
      if (this.conns.size === 0) this.unlocked.clear()
      resolveClosed(lastError || 'connection closed')
    })
    client.on('unix connection', (info: UNIXConnectionDetails, accept: () => Channel) => {
      const fwd = conn.forwards.get(info.socketPath)
      if (!fwd) return
      const ch = accept()
      const local = net.connect({ host: fwd.localHost, port: fwd.localPort })
      local.on('error', () => ch.close())
      ch.on('error', () => local.destroy())
      ch.pipe(local).pipe(ch)
    })
    conn.ready = this.connect(conn, target, options, mode, via).catch((e: Error) => {
      conn.alive = false
      client.end()
      throw e
    })
    // Nobody may be awaiting `ready` when it fails (a master whose caller gave up): never let
    // that become an unhandled rejection.
    conn.ready.catch(() => {})
    return conn
  }

  private async connect(
    conn: Conn,
    target: SshTarget,
    options: SshOptions,
    mode: { interactive: boolean },
    via?: Conn
  ): Promise<void> {
    const host = await this.deps.resolveHost(target)
    if (host.proxyCommand) {
      throw new Error(`ssh: ProxyCommand is not supported by nodeterm's Windows SSH transport (host ${target.host})`)
    }
    const timeoutMs = (options.connectTimeout ?? host.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS / 1000) * 1000
    const connectSocket = this.deps.connectSocket ?? defaultConnectSocket
    let sock: Duplex
    const borrowed = via?.jumps.length ? via.jumps[via.jumps.length - 1] : undefined
    if (borrowed && via?.alive) {
      conn.jumps = via.jumps
      conn.ownsJumps = false
      sock = await forwardTo(borrowed, host.hostname, host.port)
    } else if (host.proxyJump) {
      const hops = await this.jumpChain(host, target.host, 0, new Set())
      const built: Client[] = []
      conn.jumps = built
      conn.ownsJumps = true
      try {
        let next: Duplex = await connectSocket(
          hops[0].host.hostname,
          hops[0].host.port,
          (options.connectTimeout ?? hops[0].host.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS / 1000) * 1000
        )
        for (let i = 0; i < hops.length; i++) {
          const hop = hops[i]
          const jump = new Client()
          built.push(jump)
          // A jump client with no 'error' listener would throw from its emitter after the handshake.
          jump.on('error', (e: Error) => this.deps.log?.(`[native-ssh] jump ${hop.query.host}: ${e.message}`))
          await this.handshake(jump, next, hop.query, hop.host, jumpOptions(options), mode, `jump host ${hop.query.host}: `)
          const to = i + 1 < hops.length ? hops[i + 1].host : host
          next = await forwardTo(jump, to.hostname, to.port)
        }
        sock = next
      } catch (e) {
        for (const j of built) j.end()
        throw e
      }
    } else {
      sock = await connectSocket(host.hostname, host.port, timeoutMs)
    }
    // A jump that drops takes the target with it: every channel then ends with 255 (the forwarded
    // stream closing already does this; ending explicitly does not depend on ssh2 noticing it).
    for (const j of conn.jumps) j.once('close', () => conn.client.end())
    try {
      await this.handshake(conn.client, sock, target, host, options, mode, '')
    } catch (e) {
      if (conn.ownsJumps) for (const j of conn.jumps) j.end()
      throw e
    }
  }

  /**
   * The hops to cross for `host`, first hop first, with OpenSSH's meaning: `ssh -J a,b t` runs
   * `ssh -J a -W t b`, whose own jump is `ssh -W b a`. So every hop is resolved by ITS OWN
   * `ssh -G` (never the target's -i, IdentitiesOnly or IdentityAgent, which OpenSSH does not pass
   * on either), a later hop's own ProxyJump is overridden by the chain before it, and only the
   * FIRST hop's own ProxyJump is followed — recursively, which is what OpenSSH does too.
   */
  private async jumpChain(host: ResolvedHost, name: string, depth: number, seen: Set<string>): Promise<Hop[]> {
    if (depth >= MAX_JUMP_DEPTH) {
      throw new Error(`ssh: ProxyJump chain for ${name} is deeper than ${MAX_JUMP_DEPTH} hops (a loop in ~/.ssh/config?)`)
    }
    const specs: JumpSpec[] = parseProxyJump(host.proxyJump ?? '')
    const hops: Hop[] = []
    for (const spec of specs) {
      const resolved = await this.deps.resolveHost({ user: spec.user, host: spec.host, port: spec.port })
      hops.push({ query: { user: resolved.user, host: spec.host, port: resolved.port }, host: resolved })
    }
    const first = hops[0]
    if (first.host.proxyCommand) {
      throw new Error(
        `ssh: ProxyCommand is not supported by nodeterm's Windows SSH transport (jump host ${first.query.host})`
      )
    }
    if (first.host.proxyJump) {
      const key = `${first.host.user}@${first.host.hostname}:${first.host.port}`
      if (seen.has(key)) throw new Error(`ssh: ProxyJump loop at ${first.query.host}`)
      seen.add(key)
      return [...(await this.jumpChain(first.host, first.query.host, depth + 1, seen)), ...hops]
    }
    return hops
  }

  /** The SSH handshake over `sock`: host key (accept-new) and publickey auth, for one hop or the target. */
  private async handshake(
    client: Client,
    sock: Duplex,
    target: HostQuery & { user: string },
    host: ResolvedHost,
    options: SshOptions,
    mode: { interactive: boolean },
    prefix: string
  ): Promise<void> {
    // OpenSSH checks the key under the REAL host name (HostName) unless HostKeyAlias says otherwise.
    const knownAs = host.hostKeyAlias ?? host.hostname
    let hostKeyRefusal = ''
    const cancelled = { value: false }
    const auth = this.authPlan(target, host, options, mode, cancelled)
    const cfg: ConnectConfig = {
      sock,
      username: host.user,
      readyTimeout: AUTH_WAIT_MS,
      keepaliveInterval: (options.serverAliveInterval ?? 0) * 1000,
      keepaliveCountMax: options.serverAliveCountMax ?? 3,
      hostVerifier: (key: Buffer): boolean => {
        // accept-new is the only policy the builders ask for; `ask`/`yes` from the user's config
        // are overridden by the command line exactly as they are for OpenSSH.
        const v = acceptNewHostKey(
          { userFiles: host.userKnownHostsFiles, globalFiles: host.globalKnownHostsFiles },
          knownAs,
          host.port,
          key
        )
        if (!v.accept) {
          hostKeyRefusal =
            prefix +
            (v.verdict === 'revoked'
              ? `@@@ WARNING: REVOKED HOST KEY DETECTED FOR ${knownAs} @@@`
              : `@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@ Host key verification failed for ${knownAs}.`)
        }
        return v.accept
      },
      authHandler: (_methods: unknown, _partial: unknown, next: (a: unknown) => void) => {
        auth.next().then(next, () => next(false))
      }
    } as ConnectConfig
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.removeListener('error', onErr)
        client.removeListener('close', onClose)
        resolve()
        this.maybeAddToAgent(host, auth.succeeded())
      }
      const onErr = (e: Error & { level?: string }): void => {
        client.removeListener('ready', onReady)
        client.removeListener('close', onClose)
        if (hostKeyRefusal) return reject(new Error(hostKeyRefusal))
        if (e.level === 'client-authentication') {
          // A passphrase the user declined is the reason, not a denial by the server; say so the
          // way the POSIX path does (SshProjectManager's cancelled message).
          if (cancelled.value) return reject(new Error('SSH connection cancelled: this key needs its passphrase.'))
          return reject(new Error(`${prefix}${target.user}@${target.host}: Permission denied (publickey).`))
        }
        reject(new Error(`ssh: ${prefix}${e.message}`))
      }
      // A stream socket (a jump's forwarded channel) can end before the handshake with no 'error'.
      const onClose = (): void => {
        client.removeListener('ready', onReady)
        client.removeListener('error', onErr)
        reject(new Error(hostKeyRefusal || `ssh: ${prefix}connection closed during the handshake`))
      }
      client.once('ready', onReady)
      client.once('error', onErr)
      client.once('close', onClose)
      client.connect(cfg)
    })
  }

  /**
   * After a connection authenticated with a key the user just typed the passphrase for, load it
   * into the host's agent when the policy says so (the POSIX path gets the same from OpenSSH's
   * `AddKeysToAgent`). Never awaited and never throws: the connection is already up, and the agent
   * only saves the NEXT connection a prompt.
   */
  private maybeAddToAgent(host: ResolvedHost, offer: UnlockedOffer | null): void {
    if (!offer?.agentPath || !this.deps.agentAdd) return
    let decision: { lifetimeSec?: number } | null = null
    try {
      decision = this.deps.agentAdd({ agentPath: offer.agentPath, host, identityFile: offer.file })
    } catch {
      decision = null
    }
    if (!decision) return
    const add = this.deps.addKeyToAgent ?? addKeyToAgent
    void Promise.resolve()
      .then(() => add(offer.agentPath as string, offer.key, offer.file, { lifetimeSec: decision?.lifetimeSec }))
      .catch((): AgentAddResult => 'error')
      .then((r) => {
        if (r !== 'added') this.deps.log?.(`[native-ssh] could not add ${offer.file} to the ssh agent (${r}); it will ask for the passphrase again next time`)
      })
  }

  /**
   * The publickey sequence: the agent first (filtered to the pinned key under IdentitiesOnly, so a
   * big agent cannot burn the server's MaxAuthTries), then each identity file, asking for a
   * passphrase when one is encrypted and prompting is allowed.
   */
  private authPlan(
    target: HostQuery & { user: string },
    host: ResolvedHost,
    options: SshOptions,
    mode: { interactive: boolean },
    cancelled: { value: boolean }
  ): { next(): Promise<unknown>; succeeded(): UnlockedOffer | null } {
    const username = host.user
    const identitiesOnly = options.identitiesOnly ?? host.identitiesOnly
    const files = target.identityFile ? [target.identityFile] : host.identityFiles
    const read = this.deps.readFile ?? ((p: string) => {
      try {
        return fs.readFileSync(p)
      } catch {
        return null
      }
    })
    const agentPath = resolveAgentPath(target.identityAgent ?? host.identityAgent, this.deps.defaultAgent?.())
    const steps: (() => Promise<unknown | null>)[] = []
    // The key file behind the LAST method handed to ssh2 — on 'ready' that is the one that worked.
    let last: UnlockedOffer | null = null
    if (agentPath) {
      steps.push(async () => {
        if (!identitiesOnly) return { type: 'agent', username, agent: agentPath }
        const pubs = files.map((f) => read(`${f}.pub`)).filter((b): b is Buffer => !!b)
        if (!pubs.length) return null
        return { type: 'agent', username, agent: filteredAgent(agentPath, pubs) }
      })
    }
    for (const file of files) {
      steps.push(async () => {
        const cachedKey = this.unlocked.get(file)
        // Unlocked earlier this run: its agent add (if any) was decided then.
        if (cachedKey) return { type: 'publickey', username, key: cachedKey }
        const data = read(file)
        if (!data) return null
        let key = utils.parseKey(data)
        let prompted = false
        if (key instanceof Error && /encrypted|passphrase/i.test(key.message)) {
          if (!mode.interactive || options.batchMode || !this.deps.askPassphrase) return null
          // Up to three tries, like ssh's NumberOfPasswordPrompts default.
          for (let i = 0; i < 3 && key instanceof Error; i++) {
            prompted = true
            const pass = await this.deps.askPassphrase(file, { retry: i > 0, target: `${target.user}@${target.host}` })
            if (pass === null) {
              cancelled.value = true
              return null
            }
            key = utils.parseKey(data, pass)
          }
        }
        if (key instanceof Error) return null
        const parsed = Array.isArray(key) ? key[0] : key
        if (prompted) this.unlocked.set(file, parsed)
        return { type: 'publickey', username, key: parsed, [UNLOCKED]: prompted ? { file, key: parsed, agentPath } : undefined }
      })
    }
    let i = 0
    return {
      async next() {
        while (i < steps.length) {
          const step = steps[i++]
          const auth = (await step()) as ({ [UNLOCKED]?: UnlockedOffer } & Record<string, unknown>) | null
          if (auth) {
            last = auth[UNLOCKED] ?? null
            delete auth[UNLOCKED]
            return auth
          }
        }
        last = null
        return false
      },
      succeeded: () => last
    }
  }
}

const UNLOCKED = Symbol('unlocked-offer')

/** A key the user unlocked with a passphrase during this connect, and the agent the host uses. */
interface UnlockedOffer {
  file: string
  key: ParsedKey
  agentPath: string | undefined
}

/** Which agent to use: an explicit config value wins; `SSH_AUTH_SOCK`-style references and an
 *  absent value fall to the default; `none` disables it. */
export function resolveAgentPath(configured: string | undefined, fallback: string | undefined): string | undefined {
  if (configured === 'none') return undefined
  if (!configured || configured === 'SSH_AUTH_SOCK' || configured === '$SSH_AUTH_SOCK' || configured === '${SSH_AUTH_SOCK}') {
    return fallback
  }
  return configured
}

/** An agent that only offers keys whose public blob is in `pubs` (IdentitiesOnly). */
function filteredAgent(agentPath: string, pubFiles: Buffer[]): ReturnType<typeof createAgent> {
  const base = createAgent(agentPath)
  const wanted = pubFiles
    .map((b) => {
      const k = utils.parseKey(b)
      const one = Array.isArray(k) ? k[0] : k
      return one instanceof Error ? null : one.getPublicSSH()
    })
    .filter((b): b is Buffer => !!b)
  type AnyKey = string | Buffer | ParsedKey | { pubKey: AnyKey }
  const publicOf = (k: AnyKey): Buffer | null => {
    if (typeof k === 'object' && !Buffer.isBuffer(k) && 'pubKey' in k) return publicOf(k.pubKey)
    if (typeof k === 'string' || Buffer.isBuffer(k)) {
      const p = utils.parseKey(k)
      const one = Array.isArray(p) ? p[0] : p
      return one instanceof Error ? null : one.getPublicSSH()
    }
    return k.getPublicSSH()
  }
  const getIdentities = base.getIdentities.bind(base)
  base.getIdentities = (cb) =>
    getIdentities((err, keys) => {
      if (err || !keys) return cb(err, keys)
      cb(
        undefined,
        keys.filter((k) => {
          const pub = publicOf(k)
          return !!pub && wanted.some((w) => w.equals(pub))
        })
      )
    })
  return base
}

const exits = new WeakMap<ClientChannel, { code: number | null; signal: string | null; closed: boolean }>()

/**
 * Record a channel's exit status the moment it is opened, synchronously. The open confirmation and
 * the exit-status can arrive in ONE TCP read (a fast command, a pty whose remote side exits at
 * once); ssh2 parses both in the same tick, so a listener attached after `await`ing the channel
 * misses `exit`, and a clean remote exit would read as 255 — "the transport dropped", which sends
 * the reconnector after a terminal that simply ended.
 */
function recordExit(ch: ClientChannel): void {
  const rec = { code: null as number | null, signal: null as string | null, closed: false }
  exits.set(ch, rec)
  ch.on('exit', (code: number | null, signal?: string) => {
    rec.code = code
    rec.signal = signal ?? null
  })
  ch.once('close', () => {
    rec.closed = true
  })
}

/** The exit status recorded for a channel from `channel()` / `shell()` (null until it arrives),
 *  and whether it has already closed — a consumer that attached late checks this first. */
export function channelExit(ch: ClientChannel): { code: number | null; signal: string | null; closed: boolean } {
  return exits.get(ch) ?? { code: null, signal: null, closed: false }
}

/** Options for a jump hop: interactivity and keepalive follow the connection being built; nothing
 *  that names an identity does (OpenSSH does not pass -i / IdentitiesOnly to its jump ssh). */
function jumpOptions(o: SshOptions): SshOptions {
  return {
    batchMode: o.batchMode,
    serverAliveInterval: o.serverAliveInterval,
    serverAliveCountMax: o.serverAliveCountMax
  }
}

/** A direct-tcpip channel from `client` to host:port (`ssh -W`), used as the next hop's socket. */
function forwardTo(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) =>
    client.forwardOut('127.0.0.1', 0, host, port, (err, ch) =>
      err ? reject(new Error(`ssh: channel open failed to ${host}:${port}: ${err.message}`)) : resolve(ch)
    )
  )
}

function fail(e: unknown): ExecResult {
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 255, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(msg + '\n'), timedOut: false }
}
