// Dev-server port discovery: which TCP ports each node's session is LISTENING on.
//
// Ownership, never probing. A port is attributed to a node only when its listening socket belongs
// to a process inside that node's tmux pane tree (the same tree session memory rolls up). Nothing
// is ever connected to, and another user's or another program's port is never reported.
//
// ONE generated POSIX sh script answers the whole question in one round trip — the panes of every
// nodeterm tmux socket, the process table, and the listening sockets with their owning pids — and
// the SAME script runs for a local project (`/bin/sh -c`) and over an SSH project's ControlMaster.
// One script, one parser: a local leg written separately would drift from the remote one, which is
// what this repo's session-memory ledger records happening three times.
//
// Which listener tool answers, in order:
//   - `ss -ltnp` (Linux, iproute2): only listeners, with `users:(("node",pid=123,fd=21))` for
//     sockets of processes we own — a few lines of output.
//   - `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (macOS, and Linux hosts without ss). lsof exits 1 when
//     nothing matched, which is an ANSWER here, not a failure.
//   - `/proc/net/tcp{,6}` + `ls -l /proc/<pid>/fd` (a Linux host with neither): the socket inode
//     joins the two. One `ls` process, not one `readlink` per descriptor.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { DEV_PORT_EPHEMERAL_MIN, type DevPort, type DevPortsReport } from '../shared/dev-ports'
import { REMOTE_TMUX_PATH_DIRS } from '../shared/ssh'
import { shellSingleQuote } from '../shared/shell-quote'
import { indexProcesses, type PaneRef } from './session-memory'
import { fencedListPanesCommand, parseFencedPanes } from './session-memory-remote'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

const runAsync = promisify(execFile)

const PANES = '##PANES'
const PROCS = '##PROCS'
const LISTEN = '##LISTEN'
const FD = '##FD'
const END = '##END'

/** The sockets nodeterm's sessions live on — a local project's (`node-terminal`) and an SSH
 *  project's on its host (`nodeterm-rmt`). Both are listed on either machine, like session memory,
 *  because a host can run a nodeterm of its own. */
export const DEV_PORT_SOCKETS: readonly string[] = [TMUX_SOCKET, RMT_TMUX_SOCKET]

export interface DevPortsProbeOptions {
  /** tmux sockets to list. Tests pass a private one; production uses DEV_PORT_SOCKETS. */
  sockets?: readonly string[]
  /** Root of the proc filesystem for the last-resort branch. Tests point it at a fake tree. */
  procRoot?: string
  /**
   * An absolute tmux binary to ask. The LOCAL leg passes the app's own (`PtyManager.getTmuxBin()`,
   * the same one session memory is given): a Mac whose only tmux is the bundled one, or a Linux
   * box whose tmux is only on the login-shell PATH (nix, linuxbrew), has NO `tmux` on this
   * process's PATH, so a bare `tmux` answered 127 on both sockets and the chip never appeared —
   * and a different tmux CLIENT against the app's server can hit a protocol mismatch. Omitted on
   * an SSH host, where the host's own tmux is found through the PATH append.
   */
  tmuxBin?: string
}

/**
 * The generated script. Load-bearing details:
 *  - Every marker is QUOTED: an unquoted `#` at the start of a word begins a comment in POSIX sh,
 *    so `echo ##PANES` prints an empty line (measured under dash in session-memory-remote.ts).
 *  - `##END` is printed last and unconditionally; a missing one means the stream was cut short.
 *  - PATH is APPENDED with the tmux dirs (Homebrew — issue #449) and `/usr/sbin:/sbin`, where `ss`
 *    and `lsof` live on some distributions and macOS, and which an ssh exec channel's non-login
 *    PATH often lacks. Append, never prepend: the host's own binaries win.
 *  - `ps -eo pid=,ppid=,comm=` is POSIX (`=` suppresses the header) and works on macOS.
 */
export function devPortsProbeCommand(opts: DevPortsProbeOptions = {}): string {
  const sockets = opts.sockets ?? DEV_PORT_SOCKETS
  const proc = opts.procRoot ?? '/proc'
  const tmux = opts.tmuxBin ? shellSingleQuote(opts.tmuxBin) : 'tmux'
  return [
    `PATH="$PATH:${REMOTE_TMUX_PATH_DIRS}:/usr/sbin:/sbin"`,
    `echo '${PANES}'`,
    ...sockets.map((s) => fencedListPanesCommand(s, tmux)),
    `echo '${PROCS}'`,
    `ps -eo pid=,ppid=,comm= 2>/dev/null`,
    `echo '${LISTEN}'`,
    `if command -v ss >/dev/null 2>&1; then`,
    `  echo '##VIA ss'`,
    `  ss -ltnp 2>/dev/null`,
    `  echo "##LISTENRC $?"`,
    `elif command -v lsof >/dev/null 2>&1; then`,
    `  echo '##VIA lsof'`,
    `  lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null`,
    `  echo "##LISTENRC $?"`,
    `elif [ -r '${proc}/net/tcp' ]; then`,
    `  echo '##VIA proc'`,
    `  cat '${proc}/net/tcp' '${proc}/net/tcp6' 2>/dev/null`,
    `  echo '${FD}'`,
    // `-q`: a non-printable in a link target prints as `?`. Without it GNU ls prints a NEWLINE in
    // an fd's target raw, and a file named `a\n/proc/100/fd:\nl -> socket:[999]` forges a pid
    // header and hands socket 999 to pid 100 (reproduced).
    `  ls -lq '${proc}'/[0-9]*/fd 2>/dev/null`,
    `  echo '##LISTENRC 0'`,
    `else`,
    `  echo '##VIA none'`,
    `fi`,
    `echo '${END}'`
  ].join('\n')
}

/** A process holding a listening socket, with the name the listener tool printed for it ('' when
 *  the tool names none — the /proc branch). */
export interface SocketOwner {
  pid: number
  command: string
}

/** One listening socket and the process(es) that hold it. */
export interface Listener {
  owners: SocketOwner[]
  address: string
  port: number
}

export interface ProcRow {
  pid: number
  ppid: number
  command: string
}

/** `ps -eo pid=,ppid=,comm=`. `comm` is a full path on macOS; only its basename is kept. */
export function parseProcRows(text: string): ProcRow[] {
  const out: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line)
    if (!m) continue
    const command = m[3].trim()
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: command.split('/').pop() ?? command })
  }
  return out
}

/**
 * Split `host:port` as ss and lsof print it: `127.0.0.1:5173`, `*:3000`, `[::1]:5173`, `[::]:80`,
 * the old ss spelling `:::8080`, and a scoped `127.0.0.53%lo:53`. Returns null for anything whose
 * port is not a plain number (a peer column's `*`).
 */
export function splitHostPort(token: string): { address: string; port: number } | null {
  const i = token.lastIndexOf(':')
  if (i < 0) return null
  const portText = token.slice(i + 1)
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port < 1 || port > 65535) return null
  let address = token.slice(0, i)
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  const pct = address.indexOf('%')
  if (pct >= 0) address = address.slice(0, pct)
  if (address === '::' || address === '') address = '::'
  // An IPv4-mapped bind (`::ffff:127.0.0.1`) IS its IPv4 address — the /proc decoder already says
  // so, and leaving it mapped made `forwardTarget` answer null for an ordinary loopback server.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped) address = mapped[1]
  return { address, port }
}

/**
 * `ss -ltnp`. The local address is the first `addr:port` token with a numeric port — the peer
 * column (`0.0.0.0:*`) never has one, which also makes this indifferent to whether the installed
 * ss prints a State column.
 *
 * **The owner column is attacker-influenced text.** ss prints each holder as
 * `("<name>",pid=N,fd=M)` with the process NAME raw — any process can rename itself (15 bytes of
 * comm), and a name of `vite",pid=12345` printed `users:(("vite",pid=12345",pid=219072,fd=3))`
 * (reproduced as root against a listener owned by `nobody`). Collecting every `pid=N` on the line
 * handed that stranger's port to whichever node's tree holds 12345 — pane pids are visible to every
 * user through `ps` — and the forward then served the attacker's page on `localhost`, where it
 * reads the cookies of every other localhost dev app. So each group is parsed on its own and only
 * the LAST `,pid=N,fd=M` before its closing `)` is the pid: ss cannot print `)` inside a name
 * (it would end the group), so a greedy `[^)]*` cannot be steered past it. `assembleDevPorts`
 * then cross-checks that name against `ps` for that pid.
 */
export function parseSsListeners(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n')) {
    let hp: { address: string; port: number } | null = null
    for (const tok of line.trim().split(/\s+/)) {
      hp = splitHostPort(tok)
      if (hp) break
    }
    if (!hp) continue
    const owners: SocketOwner[] = []
    for (const group of line.matchAll(/\("([^)]*)",pid=(\d+),fd=\d+\)/g)) {
      owners.push({ pid: Number(group[2]), command: group[1] })
    }
    out.push({ owners, ...hp })
  }
  return out
}

/** `lsof -Fpcn`: `p<pid>` opens a process, `c<cmd>` names it, each `n<addr:port>` is one socket. */
export function parseLsofListeners(text: string): Listener[] {
  const out: Listener[] = []
  let pid = 0
  let command = ''
  for (const line of text.split('\n')) {
    const tag = line[0]
    const val = line.slice(1).trim()
    if (tag === 'p') {
      pid = Number(val) || 0
      command = ''
    } else if (tag === 'c') {
      command = val
    } else if (tag === 'n' && pid > 0) {
      // An established connection prints `a->b`; LISTEN never does, but be explicit.
      if (val.includes('->')) continue
      const hp = splitHostPort(val)
      if (hp) out.push({ owners: [{ pid, command }], ...hp })
    }
  }
  return out
}

/** Decode a `/proc/net/tcp{,6}` address word: each 32-bit group is in host (little-endian) order. */
export function decodeProcAddress(hex: string): string | null {
  const le = (h: string): number[] => [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((b) => parseInt(b, 16))
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return le(hex).join('.')
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null
  const bytes: number[] = []
  for (let g = 0; g < 4; g++) bytes.push(...le(hex.slice(g * 8, g * 8 + 8)))
  // IPv4-mapped (::ffff:a.b.c.d) is reported as its IPv4 address.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12).join('.')
  }
  const words: string[] = []
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  return compressIpv6(words)
}

function compressIpv6(words: string[]): string {
  // Longest run (≥ 2) of zero words becomes `::`.
  let best = -1
  let bestLen = 0
  for (let i = 0; i < words.length; ) {
    if (words[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < words.length && words[j] === '0') j++
    if (j - i > bestLen && j - i >= 2) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  if (best < 0) return words.join(':')
  return `${words.slice(0, best).join(':')}::${words.slice(best + bestLen).join(':')}`
}

/** LISTEN rows (`st == 0A`) of `/proc/net/tcp` + `tcp6`, keyed by socket inode. */
export function parseProcNetTcp(text: string): Map<string, { address: string; port: number }> {
  const out = new Map<string, { address: string; port: number }>()
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== '0A') continue
    const [addrHex, portHex] = f[1].split(':')
    const address = decodeProcAddress(addrHex ?? '')
    const port = parseInt(portHex ?? '', 16)
    const inode = f[9]
    if (address === null || !Number.isInteger(port) || port < 1 || !/^\d+$/.test(inode) || inode === '0') continue
    out.set(inode, { address, port })
  }
  return out
}

/** `ls -l <proc>/[0-9]*\/fd`: directory headers name the pid, `-> socket:[N]` names the inode. */
export function parseProcFdSockets(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  let pid = 0
  for (const line of text.split('\n')) {
    const head = /\/(\d+)\/fd:\s*$/.exec(line)
    if (head) {
      pid = Number(head[1])
      continue
    }
    const sock = /->\s*socket:\[(\d+)\]/.exec(line)
    if (!sock || pid <= 0) continue
    const list = out.get(sock[1])
    if (list) {
      if (!list.includes(pid)) list.push(pid)
    } else out.set(sock[1], [pid])
  }
  return out
}

/**
 * Does the name a listener tool printed for a pid agree with `ps`'s name for it? Defence in depth
 * behind the per-group ss parse: a pid the tool attributes must be a process `ps` knows by that
 * name. Prefix-tolerant, because the tools truncate differently (Linux comm is 15 bytes, lsof's
 * default `c` field 9, macOS ps prints the full basename). A tool that names nothing ('' — the
 * /proc branch, where the pid comes from the kernel's fd table) is not checked.
 */
function namesAgree(toolName: string, psName: string | undefined): boolean {
  if (!toolName) return true
  if (psName === undefined || psName === '') return false
  return psName.startsWith(toolName) || toolName.startsWith(psName)
}

/** `node id → ports`, from the three facts. Pure. */
export function assembleDevPorts(
  panes: readonly PaneRef[],
  procs: readonly ProcRow[],
  listeners: readonly Listener[]
): Record<string, DevPort[]> {
  const { kids } = indexProcesses(procs.map((p) => ({ pid: p.pid, ppid: p.ppid, rssKb: 0 })))
  const commandOf = new Map(procs.map((p) => [p.pid, p.command]))
  // pid → owning node. Every pane of a session counts (a session can carry a lead pane), and a
  // `seen` set guards the walk against a cyclic ppid chain captured mid-recycle.
  const owner = new Map<number, string>()
  for (const pane of panes) {
    if (!pane.session.startsWith('nt-')) continue
    const nodeId = pane.session.slice('nt-'.length)
    if (!nodeId) continue
    const stack = [pane.panePid]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      if (owner.has(pid)) continue
      owner.set(pid, nodeId)
      for (const k of kids.get(pid) ?? []) stack.push(k)
    }
  }
  const byNode = new Map<string, Map<number, DevPort>>()
  for (const l of listeners) {
    const holder = l.owners.find((o) => owner.has(o.pid) && namesAgree(o.command, commandOf.get(o.pid)))
    if (holder === undefined) continue
    const pid = holder.pid
    const nodeId = owner.get(pid) as string
    let ports = byNode.get(nodeId)
    if (!ports) byNode.set(nodeId, (ports = new Map()))
    const existing = ports.get(l.port)
    if (existing) {
      if (!existing.addresses.includes(l.address)) existing.addresses.push(l.address)
      continue
    }
    ports.set(l.port, {
      port: l.port,
      addresses: [l.address],
      command: holder.command || commandOf.get(pid) || '',
      ephemeral: l.port >= DEV_PORT_EPHEMERAL_MIN
    })
  }
  const out: Record<string, DevPort[]> = {}
  for (const [nodeId, ports] of byNode) out[nodeId] = [...ports.values()].sort((a, b) => a.port - b.port)
  return out
}

const fail = (reason: DevPortsReport['reason']): DevPortsReport => ({ ok: false, reason, nodes: {} })

/**
 * Parse the whole probe. Every failure reads as "could not look", never as "no ports":
 *  - a missing or out-of-order marker (a cut stream, an rc file that echoes into the channel);
 *  - an empty process table (a host always has processes, so `ps` never ran);
 *  - no tmux socket answered (see `parseFencedPanes` — "no server running" IS an answer);
 *  - a listener tool that failed (`ss` non-zero; `lsof` non-zero WITH output).
 */
export function parseDevPortsProbe(stdout: string, sockets: readonly string[] = DEV_PORT_SOCKETS): DevPortsReport {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''))
  const iPanes = lines.indexOf(PANES)
  const iProcs = lines.indexOf(PROCS)
  const iListen = lines.indexOf(LISTEN)
  const iEnd = lines.lastIndexOf(END)
  if (iPanes < 0 || iProcs < 0 || iListen < 0 || iEnd < 0) return fail('unreachable')
  if (!(iPanes < iProcs && iProcs < iListen && iListen < iEnd)) return fail('unreachable')

  const { answered, panes } = parseFencedPanes(lines.slice(iPanes + 1, iProcs), sockets)
  if (answered === 0) return fail('unreachable')
  const procs = parseProcRows(lines.slice(iProcs + 1, iListen).join('\n'))
  if (procs.length === 0) return fail('unreachable')

  const listen = lines.slice(iListen + 1, iEnd)
  const via = /^##VIA (\w+)$/.exec(listen[0] ?? '')?.[1]
  if (via === 'none') return fail('no-listener-tool')
  const rcLine = listen.findIndex((l) => /^##LISTENRC \d+$/.test(l))
  if (!via || rcLine < 0) return fail('unreachable')
  const rc = Number(listen[rcLine].slice('##LISTENRC '.length))
  const body = listen.slice(1, rcLine).join('\n')

  let listeners: Listener[]
  if (via === 'ss') {
    if (rc !== 0) return fail('unreachable')
    listeners = parseSsListeners(body)
  } else if (via === 'lsof') {
    // lsof exits 1 when it matched nothing: with no output that is "no listeners", an answer.
    if (rc !== 0 && !(rc === 1 && body.trim() === '')) return fail('unreachable')
    listeners = parseLsofListeners(body)
  } else if (via === 'proc') {
    const fdAt = body.split('\n').indexOf(FD)
    const bodyLines = body.split('\n')
    if (fdAt < 0) return fail('unreachable')
    const sockets4 = parseProcNetTcp(bodyLines.slice(0, fdAt).join('\n'))
    const owners = parseProcFdSockets(bodyLines.slice(fdAt + 1).join('\n'))
    listeners = []
    for (const [inode, hp] of sockets4) {
      listeners.push({ owners: (owners.get(inode) ?? []).map((pid) => ({ pid, command: '' })), ...hp })
    }
  } else {
    return fail('unreachable')
  }

  // Both sockets print into one section; first pane of a (session, pid) is enough.
  return { ok: true, nodes: assembleDevPorts(panes, procs, listeners) }
}

/**
 * Which address the HOST side of a forward should connect to, from the addresses a port is bound
 * on. A server bound only to `::1` (common: `localhost` resolving to IPv6 first) refuses
 * `127.0.0.1`, so the target must follow the bind:
 *   - any IPv4 wildcard/loopback (`0.0.0.0`, `*`, `127.x`) → `127.0.0.1`;
 *   - else IPv6 loopback or wildcard → `::1`;
 *   - else the one specific address it is bound on.
 * Returns null for anything that is not a plain IPv4/IPv6 literal — the value came off another
 * machine's command output and lands in an ssh argument.
 */
export function forwardTarget(addresses: readonly string[]): string | null {
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/
  const v6 = /^[0-9A-Fa-f:]+$/
  if (addresses.some((a) => a === '0.0.0.0' || a === '*' || /^127\./.test(a))) return '127.0.0.1'
  if (addresses.some((a) => a === '::1' || a === '::')) return '::1'
  const specific = addresses.find((a) => v4.test(a) || (v6.test(a) && a.includes(':')))
  return specific ?? null
}

export interface LocalDevPortsOptions {
  /** The app's tmux (`PtyManager.getTmuxBin()`); null = no tmux, so there is no pane tree at all. */
  tmuxBin: () => string | null
  exec?: (command: string) => Promise<string>
  platformName?: NodeJS.Platform
}

/** Runs the probe on this machine. Windows has no `/bin/sh` and no tmux: honestly unsupported. */
export async function collectLocalDevPorts(opts: LocalDevPortsOptions): Promise<DevPortsReport> {
  const platformName = opts.platformName ?? process.platform
  if (platformName === 'win32') return fail('unsupported')
  // No tmux means every terminal is a plain shell (PtyManager's fallback): no nt- pane tree exists
  // to own a port. Unsupported for this run rather than a "could not look" asked every 30 s.
  const tmuxBin = opts.tmuxBin()
  if (!tmuxBin) return fail('unsupported')
  const exec =
    opts.exec ??
    (async (command: string): Promise<string> => {
      const { stdout } = await runAsync('/bin/sh', ['-c', command], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
      return stdout
    })
  try {
    return parseDevPortsProbe(await exec(devPortsProbeCommand({ tmuxBin })))
  } catch {
    return fail('unreachable')
  }
}

/** Runs a POSIX sh command on the project's host; resolves stdout, or null if it could not run. */
export type RemoteDevPortsRunner = (projectId: string, command: string) => Promise<string | null>

export async function fetchRemoteDevPorts(projectId: string, run: RemoteDevPortsRunner): Promise<DevPortsReport> {
  let stdout: string | null
  try {
    stdout = await run(projectId, devPortsProbeCommand())
  } catch {
    return fail('unreachable')
  }
  if (stdout === null) return fail('unreachable')
  return parseDevPortsProbe(stdout)
}
