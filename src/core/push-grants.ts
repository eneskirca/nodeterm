// SSH-possession push grants — host-side loader (spec: nodeterm-server/docs/specs/2026-07-21-push-grants.md).
//
// A host the phone reaches by plain SSH (the Server Edition on a Linux box) has NO relay identity,
// so it can push nothing through the backend's host-identity auth. The fix: SSH possession IS the
// authorization. The phone, which can already write files on the host as the user, drops a signed,
// device-scoped grant token at `~/.nodeterm/push-grants/<deviceId>.grant`; a host that holds that
// grant may push to THAT one phone only (Authorization: Bearer <grant>). Compromise of the host
// adds no new power beyond spamming its own operator.
//
// This module reads that directory and hands the live grant list to `push-notify.ts`'s granted
// mode. It is pure + electron-free (`src/core`): all fs access is behind an injectable seam so the
// loader is unit-testable, and it is tolerant of junk/partial files (a phone mid-write, or an
// unrelated file in the dir, must never break the scan).

import fs from 'fs'
import os from 'os'
import path from 'path'

/** A grant loaded from `<deviceId>.grant`. `connectionId` (the phone's own UUID for the host
 *  connection) rides inside the signed token; it is surfaced here only for diagnostics/routing. */
export interface PushGrant {
  /** deviceId parsed from the filename (`<deviceId>.grant`). */
  deviceId: string
  /** The signed grant token (the `Authorization: Bearer` value). */
  grant: string
  /** The phone's connection UUID, if the file carried one. */
  connectionId?: string
  /** The SSH host (`user@host`, `sshHostKey`) this grant was swept FROM, when it lives on a remote
   *  host rather than in this machine's own `~/.nodeterm/push-grants` (then absent). A grant
   *  authorizes pushes about the host it was dropped on and nothing else: the phone signs it for
   *  that host's connectionId, which is also the scope its per-host mute is keyed by — so the
   *  senders route a node's events to the grants of the node's OWN host (issue #435). */
  host?: string
}

/** The slice of `fs` the loader needs — injectable so tests drive it without touching disk. */
export interface GrantsFsLike {
  readdirSync(dir: string): string[]
  readFileSync(p: string, enc: 'utf8'): string
  statSync(p: string): { mtimeMs: number }
}

const nodeFs: GrantsFsLike = {
  readdirSync: (d) => fs.readdirSync(d),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  statSync: (p) => fs.statSync(p)
}

/** `~/.nodeterm/push-grants` — where the phone drops `<deviceId>.grant` files over SSH. */
export function defaultGrantDir(): string {
  return path.join(os.homedir(), '.nodeterm', 'push-grants')
}

const GRANT_EXT = '.grant'
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** Internal scan result — carries the per-file mtime the dead-mark lifecycle keys on. */
interface ScannedGrant extends PushGrant {
  mtimeMs: number
}

/**
 * Scan `dir` for `*.grant` files, returning the parseable ones. Tolerant at every step: a missing
 * dir, an unreadable/unstattable file, non-JSON, the wrong schema version, or a missing `grant`
 * string are all skipped silently (a half-written file simply doesn't appear until it's complete).
 */
function scanGrantDir(dir: string, fsi: GrantsFsLike): ScannedGrant[] {
  let names: string[]
  try {
    names = fsi.readdirSync(dir)
  } catch {
    // No dir yet (the common case: the phone hasn't dropped anything) — no grants.
    return []
  }
  const out: ScannedGrant[] = []
  for (const name of names) {
    if (!name.endsWith(GRANT_EXT)) continue
    const deviceId = name.slice(0, -GRANT_EXT.length)
    if (!deviceId) continue
    const full = path.join(dir, name)
    let mtimeMs: number
    try {
      mtimeMs = fsi.statSync(full).mtimeMs
    } catch {
      continue
    }
    let text: string
    try {
      text = fsi.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
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
      ...(typeof rec.connectionId === 'string' ? { connectionId: rec.connectionId } : {}),
      mtimeMs
    })
  }
  return out
}

/**
 * One-shot read of the grant directory. Pure + injectable fs. Returns the parseable grants; junk
 * and partial files are skipped. (The cached accessor below is what production wires — this is the
 * primitive it and tests share.)
 */
export function loadPushGrants(
  dir: string = defaultGrantDir(),
  fsi: GrantsFsLike = nodeFs
): PushGrant[] {
  return scanGrantDir(dir, fsi).map(({ deviceId, grant, connectionId }) => ({
    deviceId,
    grant,
    ...(connectionId ? { connectionId } : {})
  }))
}

export interface GrantsAccessorOpts {
  /** Directory holding `<deviceId>.grant` files. Defaults to `~/.nodeterm/push-grants`. */
  dir?: string
  /** Injectable fs (tests). Defaults to node `fs`. */
  fs?: GrantsFsLike
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Full re-scan interval. Defaults to 5 min (a cheap dir-mtime check forces an early rescan). */
  ttlMs?: number
}

export interface GrantsAccessor {
  /** The live grants, minus any currently dead-marked ones. Cheap: re-scans only on a dir-mtime
   *  change or once the TTL elapses. */
  get(): PushGrant[]
  /** Mark a grant dead after a 401/403 — it's dropped from `get()` until its file changes
   *  (mtime/content), which the phone triggers by re-minting + re-dropping. */
  markDead(grant: string): void
  /** Test-only: force the next `get()` to re-scan the directory. */
  _forceRescan(): void
}

/**
 * A cached grant accessor for `push-notify.ts`'s granted mode. Re-scans the directory at most once
 * per `ttlMs`, plus whenever the directory's mtime changes (a file added/removed/re-dropped — the
 * cheap stat the spec calls for before each send batch). A 401/403 marks a grant dead; the mark is
 * cleared when that grant's file changes (a different mtime) or vanishes, so a phone that re-mints
 * and re-drops recovers automatically. Fails open: any fs error yields "no grants", never a throw.
 */
export function createGrantsAccessor(opts: GrantsAccessorOpts = {}): GrantsAccessor {
  const dir = opts.dir ?? defaultGrantDir()
  const fsi = opts.fs ?? nodeFs
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS

  let cache: ScannedGrant[] = []
  let scannedAt = -Infinity
  let dirMtime = -1
  // grant token -> the file's mtime when it was marked dead (so a later change clears the mark).
  const dead = new Map<string, number>()

  function dirMtimeMs(): number {
    try {
      return fsi.statSync(dir).mtimeMs
    } catch {
      return -1
    }
  }

  function refreshIfNeeded(): void {
    const t = now()
    const dm = dirMtimeMs()
    // Cheap gate: skip the full readdir unless the TTL elapsed or the dir mtime moved (add/remove/
    // atomic re-drop all touch the directory's mtime).
    if (t - scannedAt < ttlMs && dm === dirMtime) return
    cache = scanGrantDir(dir, fsi)
    scannedAt = t
    dirMtime = dm
    // Clear any dead mark whose backing file changed (re-dropped/re-minted) or disappeared.
    for (const [g, deadMtime] of [...dead]) {
      const cur = cache.find((r) => r.grant === g)
      if (!cur || cur.mtimeMs !== deadMtime) dead.delete(g)
    }
  }

  return {
    get() {
      refreshIfNeeded()
      return cache
        .filter((r) => !dead.has(r.grant))
        .map(({ deviceId, grant, connectionId }) => ({
          deviceId,
          grant,
          ...(connectionId ? { connectionId } : {})
        }))
    },
    markDead(grant: string) {
      const cur = cache.find((r) => r.grant === grant)
      dead.set(grant, cur ? cur.mtimeMs : -1)
    },
    _forceRescan() {
      scannedAt = -Infinity
      dirMtime = -1
    }
  }
}
