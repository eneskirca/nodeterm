// SSH-possession push grants that live on a REMOTE host (the Mac → SSH-host topology).
//
// `push-grants.ts` reads `~/.nodeterm/push-grants` on the machine that owns the agent-status
// mirror. That is the whole story when the phone and the mirror owner are the same box (a headless
// Server Edition the phone SSHes into). It is NOT the story for the common desktop setup:
//
//   phone --SSH--> Linux dev host <--SSH-- macOS nodeterm (owns the canvas, the hooks, the mirror)
//
// There the phone drops its grant on the HOST — the only machine it can reach — while the process
// that has something to push runs on the Mac and scans only its own `$HOME`. Result: an SSH-only
// user gets no push at all, and no error anywhere (`resolveTarget` just returns null: no paired
// phone, no grants). The remote read-acks already had their counterpart sweep
// (`SshProjectManager.sweepRemoteAcks`); grants did not. This module is that missing half.
//
// It stays pure + electron-free (`src/core`): the ssh execution is injected, so the command is
// unit-testable and the cache's dead-mark lifecycle is testable without a host. Tolerant of junk
// at every step, exactly like `push-grants.ts` — a phone mid-write must never break a sweep.

import type { PushGrant } from './push-grants'

/**
 * One host's grant listing, as ONE literal `sh` line (no interpolation — nothing from a host or a
 * project id is ever spliced in). Prints `<deviceId>\t<json>` per grant file:
 *
 *   - `[ -e "$f" ] || break` handles the no-glob case (the pattern stays literal when nothing
 *     matches) — same idiom as the ack sweep.
 *   - `tr -d '\r\n'` flattens the JSON to one line so the reply is line-parseable; a pretty-printed
 *     or CRLF file still parses.
 *   - `cut -c1-4096` bounds a junk/huge file. A truncation yields invalid JSON, which the parser
 *     skips — the tolerant outcome, not a crash.
 *
 * Read-only: unlike the ack sweep, grants are NOT consumed. A grant is re-usable until the phone
 * re-mints it (and the backend is what actually validates it).
 */
export const REMOTE_GRANT_SCAN_CMD =
  'd="$HOME/.nodeterm/push-grants"; [ -d "$d" ] || exit 0; ' +
  'for f in "$d"/*.grant; do [ -e "$f" ] || break; ' +
  'printf \'%s\\t\' "$(basename "$f" .grant)"; ' +
  "tr -d '\\r\\n' < \"$f\" | cut -c1-4096; printf '\\n'; done"

/** Longest device id we accept from a filename (it is only ever a map key, never a path). */
const DEVICE_ID_MAX = 128

/**
 * Parse the sweep's stdout into grants. Every malformed line is skipped silently: a partial write,
 * a non-JSON file someone dropped in the directory, a schema-version bump, a truncated giant.
 */
export function parseRemoteGrants(stdout: string): PushGrant[] {
  const out: PushGrant[] = []
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const deviceId = line.slice(0, tab)
    if (!deviceId || deviceId.length > DEVICE_ID_MAX) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.slice(tab + 1))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const rec = parsed as { v?: unknown; grant?: unknown; connectionId?: unknown }
    if (rec.v !== 1) continue
    if (typeof rec.grant !== 'string' || rec.grant.length === 0) continue
    out.push({
      deviceId,
      grant: rec.grant,
      ...(typeof rec.connectionId === 'string' ? { connectionId: rec.connectionId } : {})
    })
  }
  return out
}

export interface RemoteGrantsCache {
  /** The live remote grants: dead-marked tokens dropped, then ONE per device id. Sync, so it can
   *  sit behind `push-notify`'s `getGrants`. */
  get(): PushGrant[]
  /** Replace the cache with a completed sweep's result (all hosts). */
  set(grants: readonly PushGrant[]): void
  /** Mark a grant dead after a 401/403 — dropped until it disappears from a later sweep (which is
   *  what a re-minted, re-dropped grant looks like: a NEW token, so the dead mark never blocks it). */
  markDead(grant: string): void
}

/**
 * The cache `src/main` refreshes on a timer and `push-notify` reads synchronously.
 *
 * Device-id dedupe happens at READ time, after the dead filter, deliberately: one phone paired to
 * two hosts drops a different token on each, and pushing both would double every notification.
 * Picking the survivor after the dead filter means a 401 on the first host's (stale) token
 * promotes the other host's on the very next send — self-healing, no extra round-trip.
 */
export function createRemoteGrantsCache(): RemoteGrantsCache {
  let all: PushGrant[] = []
  const dead = new Set<string>()

  return {
    get() {
      const seen = new Set<string>()
      const out: PushGrant[] = []
      for (const g of all) {
        if (dead.has(g.grant)) continue
        if (seen.has(g.deviceId)) continue
        seen.add(g.deviceId)
        out.push(g)
      }
      return out
    },
    set(grants) {
      all = [...grants]
      // Forget dead marks for tokens no longer on any host — the phone re-minted, or the grant was
      // revoked. Without this the set grows for the life of the process.
      const live = new Set(all.map((g) => g.grant))
      for (const g of [...dead]) if (!live.has(g)) dead.delete(g)
    },
    markDead(grant) {
      dead.add(grant)
    }
  }
}
