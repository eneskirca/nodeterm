import path from 'path'
import { promises as fs } from 'fs'
import { platform } from './platform'
import { writeFileAtomic } from './fs-atomic'
import type { RemoteEndDeferReason } from './remote-end'

/**
 * Remote sessions this machine still owes a `kill-session`.
 *
 * A node delete is a canvas edit, and the canvas edit must succeed: the user asked for the node to
 * be gone, and refusing while the host is unreachable strands it on the canvas with no better
 * offer than "try again later" — which is the same leak plus friction, and which they will answer
 * by deleting it again the moment the refusal is out of the way. So the delete goes through and
 * the KILL is written down instead, to be paid the next time that host is reachable.
 *
 * That is the repo rule about `ok:false` applied to a side effect rather than to a read: an
 * undelivered kill is not a delivered one, and the difference is recorded rather than swallowed by
 * the `catch {}` that used to stand here. Between the record and the drain the session is visible
 * where it has always been visible — the session-memory panel lists every `nt-` session on the
 * host — and it is now also listed here, by name, with the reason it was not killed.
 *
 * Keyed by `hostKey` (`user@host`), not by project: several projects share one host's `$HOME` and
 * one tmux server, so a host reached again through ANY of them can settle every session owed on
 * it. `projectId` rides along as provenance only.
 *
 * Desktop only in practice — the Server Edition wires no owner resolver, so it records nothing —
 * but the store itself is shell-neutral and lives in core for that reason.
 */
export interface PendingRemoteKill {
  /** `user@host` — what the drain matches on. */
  hostKey: string
  /** The tmux session NAME (`nt-<nodeId>`), already sanitized by `sessionName`. */
  session: string
  reason: RemoteEndDeferReason | 'delivery-failed'
  /** ms epoch, for the age cap and for saying how long a debt has been outstanding. */
  at: number
  /** Which project the node belonged to. Provenance; never the match key. */
  projectId?: string
}

/**
 * Bounded because this file is forever and a canvas churns through node ids: an unreachable host
 * that a user keeps deleting nodes on would otherwise grow it without limit. Oldest entries are
 * dropped first — a kill owed for months is the one least likely to still be worth sending, and
 * the session-memory panel remains the honest view of what is actually running on a host.
 */
export const PENDING_REMOTE_KILL_MAX = 500

const FILE = 'pending-remote-kills.json'

function filePath(): string {
  return path.join(platform().userDataDir, FILE)
}

/**
 * All writes go through one chain. Two deletes landing in the same tick otherwise read the file
 * before either wrote it and the second one's rewrite loses the first one's entry — the exact
 * shape of lost write this store exists to prevent, and the exact shape a canvas produces (a
 * multi-select Delete ends N nodes at once).
 */
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = chain.then(op, op)
  chain = run.catch(() => undefined)
  return run
}

function isPending(value: unknown): value is PendingRemoteKill {
  const e = value as Partial<PendingRemoteKill> | null
  return (
    !!e &&
    typeof e.hostKey === 'string' &&
    !!e.hostKey &&
    typeof e.session === 'string' &&
    !!e.session &&
    typeof e.at === 'number'
  )
}

/** Tolerant read: a hand-mangled or half-written file yields NO debts rather than throwing into a
 *  delete. Losing a record here costs a leaked session; throwing costs the delete itself. */
async function read(): Promise<PendingRemoteKill[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isPending) : []
  } catch {
    return []
  }
}

async function write(entries: PendingRemoteKill[]): Promise<void> {
  const capped = entries.slice(-PENDING_REMOTE_KILL_MAX)
  await writeFileAtomic(filePath(), JSON.stringify(capped))
}

/** Every outstanding debt, oldest first. */
export function readPendingRemoteKills(): Promise<PendingRemoteKill[]> {
  return serialize(read)
}

/** What is owed on one host. */
export async function pendingRemoteKillsFor(hostKey: string): Promise<PendingRemoteKill[]> {
  return (await readPendingRemoteKills()).filter((e) => e.hostKey === hostKey)
}

/**
 * Record one undelivered kill. Idempotent per `(hostKey, session)` — re-deleting the same node, or
 * a drain attempt that failed again, refreshes the existing entry instead of stacking duplicates
 * that would each cost their own ssh round trip at drain time.
 *
 * Never throws: this runs inside a teardown whose other half has already committed, and a failed
 * bookkeeping write must not turn a delete the user watched succeed into a rejected promise.
 */
export function recordPendingRemoteKill(entry: Omit<PendingRemoteKill, 'at'>): Promise<void> {
  return serialize(async () => {
    try {
      const entries = (await read()).filter(
        (e) => !(e.hostKey === entry.hostKey && e.session === entry.session)
      )
      entries.push({ ...entry, at: Date.now() })
      await write(entries)
    } catch (error) {
      console.warn(
        `[pty] could not record the undelivered remote kill for ${entry.session}`,
        error instanceof Error ? error.message : String(error)
      )
    }
  })
}

/** Forget debts that have been settled (or that we have decided will never be). */
export function settlePendingRemoteKills(hostKey: string, sessions: string[]): Promise<void> {
  const done = new Set(sessions)
  return serialize(async () => {
    const entries = await read()
    const left = entries.filter((e) => !(e.hostKey === hostKey && done.has(e.session)))
    if (left.length !== entries.length) await write(left)
  })
}

/**
 * Pay off what a host owes, now that it is reachable again.
 *
 * `kill` returns whether the session is PROVEN gone — delivered, or answered by tmux's own "can't
 * find session". A `false` leaves the entry exactly where it was, because a failed read (or a
 * master that dropped again mid-drain) is never evidence of absence: dropping the debt there would
 * reintroduce the silent leak one layer up.
 *
 * Best-effort by contract, and never throws: it runs off the back of a `connected` event, which
 * must never fail because a cleanup could not.
 */
export async function drainPendingRemoteKills(
  hostKey: string,
  kill: (session: string) => Promise<boolean>
): Promise<{ settled: string[]; owed: number }> {
  let owed: PendingRemoteKill[] = []
  try {
    owed = await pendingRemoteKillsFor(hostKey)
  } catch {
    return { settled: [], owed: 0 }
  }
  const settled: string[] = []
  for (const entry of owed) {
    try {
      if (await kill(entry.session)) settled.push(entry.session)
    } catch {
      /* still owed — leave the entry alone */
    }
  }
  if (settled.length) await settlePendingRemoteKills(hostKey, settled).catch(() => undefined)
  return { settled, owed: owed.length }
}
