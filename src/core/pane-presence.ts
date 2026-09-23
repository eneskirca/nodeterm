// Mobile display evidence only. Never use this cached observation as a messaging/kill gate.
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  AGENT_BINARIES, binariesFor, isAgentPane, type PaneOwner
} from '../shared/agents/pane-owner-predicate'
import { isShellCommand } from '../shared/agents/pane'
import type { SshConnection } from '../shared/ssh'
import { REMOTE_TMUX_PATH_DIRS } from '../shared/ssh'
import { PANE_OWNER_FMT, PS_FOREGROUND_FLAGS, paneOwnerFrom, parsePaneOwner } from './agents/pane-owner'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { childArgs, RMT_TMUX_SOCKET } from './remote-ssh/control-master'

export const PRESENCE_POLL_MS = 15_000
export const PRESENCE_TTL_MS = 30_000
export interface PanePresence {
  kind: 'agent' | 'shell' | 'unknown'
  checkedAt: number
  expiresAt: number
}
export type PresenceMap = Record<string, PanePresence>
type CustomAgent = { id: string; launchCmd: string }

export function classifyPresence(
  owner: PaneOwner | null,
  custom: readonly CustomAgent[] = []
): PanePresence['kind'] {
  if (!owner) return 'unknown'
  for (const id of [...Object.keys(AGENT_BINARIES), ...custom.map((a) => a.id)]) {
    if (isAgentPane(owner, id, binariesFor(id, custom)) === 'agent') return 'agent'
  }
  // A foreground tool shell is not evidence that its parent agent exited. Only the pane's
  // root shell alone in the foreground group supports this claim. vim/python/etc stay unknown.
  return owner.argv.length === 1 && owner.pids?.[0] === owner.panePid &&
    isShellCommand(owner.command) && isShellCommand(owner.argv[0]) ? 'shell' : 'unknown'
}

export const PRESENCE_PANE_FMT = `#{session_name}|${PANE_OWNER_FMT}`
const PS_ARGS = ['-e', '-o', 'tty=', ...PS_FOREGROUND_FLAGS]

/** One process table for ALL panes, with tty removed before reusing the ownership parser. */
export function parsePresenceBatch(panes: string, processes: string): Map<string, PaneOwner | null> {
  const byTty = new Map<string, string[]>()
  for (const line of processes.split('\n')) {
    const match = /^\s*(\S+)\s+(\d+\s+\d+\s+\S+\s+.+)$/.exec(line)
    if (!match) continue
    const tty = match[1].replace(/^\/dev\//, '')
    const rows = byTty.get(tty) ?? []
    rows.push(match[2])
    byTty.set(tty, rows)
  }
  const out = new Map<string, PaneOwner | null>()
  for (const line of panes.trim().split('\n')) {
    const split = line.indexOf('|')
    if (split < 0) continue
    const name = line.slice(0, split)
    const identity = parsePaneOwner(line.slice(split + 1))
    // Multiple panes in a session are ambiguous: never pick one by incidental listing order.
    if (out.has(name)) {
      out.set(name, null)
      continue
    }
    const rows = identity ? byTty.get(identity.tty.replace(/^\/dev\//, '')) ?? [] : []
    out.set(name, paneOwnerFrom(identity, rows.join('\n')))
  }
  return out
}

/** Display polling must not create a new SSH connection when a master disappears. OpenSSH
 * uses the existing mux first; ProxyCommand=false makes its direct-connect fallback fail. */
export function presenceSshArgs(conn: SshConnection, controlPath: string, command: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', ...childArgs(conn, controlPath, command)]
}

/** Constant script: no project/node/user value is interpolated into a remote shell. */
export function remotePresenceCommand(): string {
  return [
    `PATH="$PATH:${REMOTE_TMUX_PATH_DIRS}"`,
    `tmux -L ${RMT_TMUX_SOCKET} list-panes -a -F '${PRESENCE_PANE_FMT}' || exit 1`,
    "printf '\\n##NTPROCS\\n'",
    `ps ${PS_ARGS.join(' ')} || exit 1`
  ].join('\n')
}
export function parseRemotePresence(stdout: string | null): Map<string, PaneOwner | null> {
  if (!stdout) return new Map()
  const parts = stdout.split('\n##NTPROCS\n')
  return parts.length === 2 ? parsePresenceBatch(parts[0], parts[1]) : new Map()
}

const exec = promisify(execFile)
export async function readLocalPresence(
  tmux: string | null,
  socket = TMUX_SOCKET
): Promise<Map<string, PaneOwner | null>> {
  if (!tmux || process.platform === 'win32') return new Map()
  try {
    const panes = await exec(tmux, ['-L', socket, 'list-panes', '-a', '-F', PRESENCE_PANE_FMT], {
      timeout: 5000, maxBuffer: 4 * 1024 * 1024
    })
    const ps = await exec('ps', PS_ARGS, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    return parsePresenceBatch(panes.stdout, ps.stdout)
  } catch {
    return new Map()
  }
}

interface Deps {
  canvases: () => Array<{ id: string; nodes: Array<{ id: string; kind: string }> }>
  isRemote: (projectId: string) => boolean
  local: () => Promise<Map<string, PaneOwner | null>>
  remote?: (projectId: string, command: string) => Promise<string | null>
  customAgents: () => readonly CustomAgent[]
  publish: (presence: PresenceMap) => void
  now?: () => number
}

/** One serialized sweep, at most two remote projects concurrently. Cached snapshots are pushed
 * to the mirror; hook bursts never trigger probes. A stuck remote cannot accumulate new probes.
 * Timestamp at START, so a late answer cannot extend stale evidence into the future. */
export function startPanePresence(deps: Deps): { dispose(): void; refresh(): Promise<void> } {
  let stopped = false
  let pending: Promise<void> | undefined
  const now = deps.now ?? Date.now
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const checkedAt = now()
      const canvases = deps.canvases()
      const custom = deps.customAgents()
      const snapshot: PresenceMap = {}
      const tasks = new Map<string, string[]>()
      for (const canvas of canvases) {
        const key = deps.isRemote(canvas.id) ? canvas.id : ''
        for (const node of canvas.nodes) {
          if (node.kind !== 'terminal') continue
          snapshot[node.id] = { kind: 'unknown', checkedAt, expiresAt: checkedAt + PRESENCE_TTL_MS }
          const ids = tasks.get(key) ?? []
          ids.push(node.id)
          tasks.set(key, ids)
        }
      }
      const work = [...tasks]
      await Promise.all([0, 1].map(async () => {
        while (work.length) {
          const [project, ids] = work.shift()!
          let owners = new Map<string, PaneOwner | null>()
          try {
            owners = project
              ? parseRemotePresence(await deps.remote?.(project, remotePresenceCommand()) ?? null)
              : await deps.local()
          } catch { /* unknown; never reuse a previous success */ }
          for (const id of ids) {
            snapshot[id].kind = classifyPresence(owners.get(sessionName(id)) ?? null, custom)
          }
        }
      }))
      if (!stopped) deps.publish(snapshot)
    })().catch(() => {
      if (!stopped) deps.publish({})
    }).finally(() => {
      pending = undefined
    })
    return pending
  }
  const timer = setInterval(() => void refresh(), PRESENCE_POLL_MS)
  timer.unref?.()
  void refresh()
  return {
    refresh,
    dispose: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
