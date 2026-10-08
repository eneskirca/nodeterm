// Host-side consumer of the phone's read-acks (spec: cross-surface read sync).
//
// The desktop→phone direction (a desktop/browser READ of a finished session → `ackDone` → mirror
// resolve + live-update dismiss) already exists. This module is the phone→host direction: the phone,
// which can write files on the session host as the user, drops a read-ack at
// `~/.nodeterm/acks/<nodeId>.seen` (content = the acked inbox event id, atomic write, umask 077). The
// mirror-owning process sweeps that directory and, for each ack:
//   - calls `ackDone(nodeId)` — resolves the node's done inbox event(s) + fires the end seam so
//     OTHER phones / the phone's own activities sync (same path the desktop-side read uses);
//   - clears the DESKTOP renderer's unread flag for that node (the missing piece the owner hit),
//     via an injected broadcast — WITHOUT re-acking (the renderer's clearUnread must not loop back
//     into another ackDone; see `onUnreadClear` at the call site, which threads an `external` flag);
//   - deletes the `.seen` file so it is consumed exactly once.
//
// Pure + electron-free (`src/core`): all fs access is behind an injectable seam so it is unit-testable
// and boots from either shell. Tolerant of junk/partial files (a phone mid-write, or an unrelated file
// in the dir, must never break the scan) — mirrors push-grants.ts.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { isSafeNodeId } from '../shared/safe-id'

/** The slice of `fs` the sweeper needs — injectable so tests drive it without touching disk. */
export interface AckSweepFsLike {
  readdirSync(dir: string): string[]
  readFileSync(p: string, enc: 'utf8'): string
  statSync(p: string): { mtimeMs: number }
  rmSync(p: string, opts: { force: boolean }): void
}

const nodeFs: AckSweepFsLike = {
  readdirSync: (d) => fs.readdirSync(d),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  statSync: (p) => fs.statSync(p),
  rmSync: (p, o) => fs.rmSync(p, o)
}

/** `~/.nodeterm/acks` — where the phone drops `<nodeId>.seen` files. */
export function defaultAckDir(): string {
  return path.join(os.homedir(), '.nodeterm', 'acks')
}

const ACK_EXT = '.seen'

export interface AckSweepHandlers {
  /** Positive ownership in this mirror. Another desktop's ack must remain unread and untouched. */
  ownsNode(nodeId: string): boolean
  /** Resolve the node's done inbox event(s) + fire the end seam (the core mirror's `ackDone`). */
  ackDone(nodeId: string): void
  /** Drop the renderer's unread flag for the node. MUST NOT re-ack (external, non-looping clear). */
  onUnreadClear(nodeId: string): void
}

/**
 * One pass over `dir`: for each owned `<nodeId>.seen` file, run `ackDone` + `onUnreadClear`, then delete
 * the file. Returns the node ids it consumed. Tolerant at every step: a missing dir, an
 * unreadable/unstattable file, or an odd name are skipped silently (a half-written file simply
 * isn't consumed until it is complete, and re-appears next pass). The file content (the acked event
 * id) is read only to confirm the file is fully written; `ackDone(nodeId)` resolves the node's
 * newest unresolved done regardless (a stray/duplicate ack is an idempotent no-op in the mirror).
 * Pure apart from the injected handlers + the delete.
 */
export function sweepAckDir(
  dir: string,
  fsi: AckSweepFsLike,
  handlers: AckSweepHandlers,
  onRetained?: () => void
): string[] {
  let names: string[]
  try {
    names = fsi.readdirSync(dir)
  } catch {
    // No dir yet (the common case: the phone hasn't acked anything) — nothing to consume.
    return []
  }
  const consumed: string[] = []
  for (const name of names) {
    if (!name.endsWith(ACK_EXT)) continue
    const nodeId = name.slice(0, -ACK_EXT.length)
    if (!nodeId) continue
    let owned = false
    try {
      owned = handlers.ownsNode(nodeId) === true
    } catch {
      // A failed ownership lookup is not permission to consume another mirror's ack.
    }
    if (!owned) {
      onRetained?.()
      continue
    }
    const full = path.join(dir, name)
    // Read the content as a completeness gate: an unreadable file (transient / mid-write) is skipped
    // and retried next pass. The value itself (the event id) is informational — see the docblock.
    try {
      fsi.readFileSync(full, 'utf8')
    } catch {
      onRetained?.()
      continue
    }
    // A handler must never break the sweep (or leave the file un-consumed): ack + clear, then delete.
    try {
      handlers.ackDone(nodeId)
    } catch {
      // ackDone is best-effort; keep going so the file is still deleted + unread still cleared.
    }
    try {
      handlers.onUnreadClear(nodeId)
    } catch {
      // ignore
    }
    try {
      fsi.rmSync(full, { force: true })
    } catch {
      onRetained?.()
      // Couldn't delete (rare): re-processing next pass is harmless — ackDone/clearUnread are both
      // idempotent no-ops once the node has no unresolved done / no unread.
    }
    consumed.push(nodeId)
  }
  return consumed
}

export interface AckSweeperOpts {
  /** Directory holding `<nodeId>.seen` files. Defaults to `~/.nodeterm/acks`. */
  dir?: string
  /** Injectable fs (tests). Defaults to node `fs`. */
  fs?: AckSweepFsLike
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Sweep interval for `start()`. Defaults to 15s (a cheap dir-mtime check gates the readdir). */
  intervalMs?: number
  handlers: AckSweepHandlers
}

export interface AckSweeper {
  /** Sweep once. A cheap dir-mtime check skips readdir after a fully consumed pass; retained
   *  acks are retried so a newly learned owner can consume an existing file. Returns consumed ids. */
  sweep(): string[]
  /** Begin sweeping on the interval. Idempotent. */
  start(): void
  /** Stop the interval. */
  stop(): void
}

/**
 * A self-scheduling ack sweeper for the mirror-owning process. `sweep()` re-reads the directory only
 * when its mtime changed since the last fully consumed pass. A retained ack disables this cache:
 * ownership can change without a filesystem write. Any fs error yields "nothing consumed", never a
 * throw. `start()`/`stop()` drive it on a 15s interval (the desktop shell drives its own combined
 * local+remote cadence, so it uses `sweep()` directly; the server shell just calls `start()`).
 */
export function createAckSweeper(opts: AckSweeperOpts): AckSweeper {
  const dir = opts.dir ?? defaultAckDir()
  const fsi = opts.fs ?? nodeFs
  const intervalMs = opts.intervalMs ?? 15_000
  let dirMtime = -1
  let timer: NodeJS.Timeout | null = null

  function dirMtimeMs(): number {
    try {
      return fsi.statSync(dir).mtimeMs
    } catch {
      return -1 // no dir / stat error → treated as "unchanged from initial"
    }
  }

  function sweep(): string[] {
    const dm = dirMtimeMs()
    // Cheap gate: nothing changed since the last sweep → skip the readdir. On the very first pass
    // (dirMtime === -1) this also skips when the dir doesn't exist yet (dm === -1), which is correct
    // — there is nothing to consume. A first `.seen` drop moves the mtime off -1 and triggers a scan.
    if (dm === dirMtime) return []
    let retained = false
    const consumed = sweepAckDir(dir, fsi, opts.handlers, () => {
      retained = true
    })
    // Our deletes moved the mtime again — re-capture so the next tick re-scans only on a NEW drop.
    // Learning a node from a hook or restored project does not change this directory's mtime.
    // Retry retained acks until their owner consumes them, even without another phone write.
    dirMtime = retained ? -1 : dirMtimeMs()
    return consumed
  }

  return {
    sweep,
    start() {
      if (timer) return
      timer = setInterval(sweep, intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}

/** A remote sweep receives ONLY this desktop's owned node ids on stdin, one per line. Never glob
 * the shared ack directory: a host may also run another nodeterm whose files must remain intact. */
export const REMOTE_ACK_SWEEP_CMD =
  'd="$HOME/.nodeterm/acks"; [ -d "$d" ] || exit 0; ' +
  'while IFS= read -r id; do ' +
  "case \"$id\" in ''|*[!a-zA-Z0-9_-]*) continue ;; esac; " +
  '[ "${#id}" -le 128 ] || continue; ' +
  'f="$d/$id.seen"; [ -f "$f" ] || continue; ' +
  'cat "$f" >/dev/null 2>&1 || continue; ' +
  'rm -f "$f" || continue; printf "%s\\n" "$id"; done'

/** Data stays on stdin rather than in the shell command, including large canvases. */
export function remoteAckSweepInput(nodeIds: Iterable<string>): string {
  const ids = [...new Set(nodeIds)].filter(isSafeNodeId)
  return ids.length ? ids.join('\n') + '\n' : ''
}
