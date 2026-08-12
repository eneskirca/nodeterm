import fs from 'fs'
import os from 'os'
import { execFile } from 'child_process'

/**
 * How many pty DEVICES this machine can hand out, and how many exist right now.
 *
 * The limit that bit on 2026-08-11 was neither the app's descriptors nor node-pty's architecture:
 * macOS caps pty devices system-wide at `kern.tty.ptmx_max` (511 by default), and with 62 live app
 * PTYs, 18 tmux sessions and ~19 ssh children there were 515 `/dev/ttys*` entries. Every spawn from
 * then on failed with a bare `posix_spawnp failed.` — the SAME opaque error a cross-arch
 * spawn-helper produces, which is why the old message sent the report chasing an architecture that
 * was fine.
 *
 * `null` means "could not be measured", which is a different statement from zero and is rendered as
 * silence rather than as a number (same rule as `SpawnResources`).
 */
export interface PtyDevices {
  /** `kern.tty.ptmx_max` — the system-wide ceiling. */
  ceiling: number | null
  /** `/dev/ttys*` entries in existence right now. */
  inUse: number | null
}

/**
 * How close to the ceiling counts as "at" it.
 *
 * Opening a terminal takes a device, and a tmux-backed one takes two in quick succession (the app's
 * client plus, on a cold start, the pane) — so the spawn fails a hair before the count is literally
 * equal, and the count itself is a snapshot taken after the failure, by which time a device or two
 * may already have been returned. Small, because unlike the descriptor check this one names a
 * SYSTEM limit: claiming the machine is full when it has room would be a worse sentence than saying
 * nothing.
 *
 * TWO CONSUMERS NOW, and the slack means something different to each:
 *  - the post-mortem hint above — the reading is a snapshot taken after the fact, so the slack
 *    absorbs devices returned between the failure and the count;
 *  - `PtyManager.spawnSession`'s pre-flight, where it is not slack at all but a PRE-EMPTIVE band:
 *    a refusal starts at `ceiling - 4` (507 of 511), while the machine still has four devices.
 *
 * The band is deliberate, and it is the same arithmetic read forwards. A tmux-backed spawn wants
 * two devices, so a create begun at 508 lands ON the wall rather than under it — and a spawn that
 * reaches the wall does not merely fail, it LEAKS two devices doing so (node-pty; see the
 * pre-flight's comment). Refusing inside the band trades at most four devices of capacity, on a
 * machine already at 99% of a system limit, for the guarantee that no failure-with-leak is ever
 * started. Those four are the cheapest possible price for closing the spiral, and the user is told
 * the true numbers either way.
 */
export const PTY_DEVICE_HEADROOM = 4

/**
 * How long a read of `kern.tty.ptmx_max` is trusted.
 *
 * The value effectively never changes — but a user who follows the advice below and raises it with
 * `sysctl -w` must not be told the same wrong thing for the rest of the session, so it expires.
 */
const CEILING_TTL_MS = 60_000

let ceiling: { value: number | null; at: number } | null = null
let refreshing = false

/**
 * Kick an async read of the ceiling (darwin only). Fire-and-forget by design: `execFile` cannot be
 * awaited from the synchronous spawn path this diagnostic serves, so the value is read AHEAD of the
 * failure (PtyManager.init primes it) and re-read in the background when it goes stale. A read that
 * has not landed yet leaves `ceiling: null`, i.e. the hint stays silent rather than guessing.
 */
export function primePtyCeiling(): void {
  if (os.platform() !== 'darwin' || refreshing) return
  refreshing = true
  try {
    execFile('sysctl', ['-n', 'kern.tty.ptmx_max'], { timeout: 5_000 }, (err, stdout) => {
      refreshing = false
      // A failed/odd read is recorded as `null` WITH a timestamp: on a machine where sysctl is
      // unavailable this stops us re-spawning it on every subsequent spawn failure.
      const parsed = err ? NaN : Number.parseInt(String(stdout).trim(), 10)
      ceiling = { value: Number.isFinite(parsed) && parsed > 0 ? parsed : null, at: Date.now() }
    })
  } catch {
    refreshing = false // diagnostics only — never mask the real spawn error
  }
}

/** The cached ceiling, refreshing in the background once it is stale. */
function ptyCeiling(): number | null {
  if (os.platform() !== 'darwin') return null
  if (!ceiling || Date.now() - ceiling.at >= CEILING_TTL_MS) primePtyCeiling()
  // The stale value is still the best answer we have while the refresh is in flight — it is only
  // stale in the sense of "read a minute ago", and a sysctl that changed since is exactly the case
  // the refresh above is for.
  return ceiling?.value ?? null
}

/**
 * Count the pty devices that exist right now.
 *
 * A directory listing, not a subprocess: this runs inside an error path that is already one failed
 * spawn deep, and shelling out to `ls` to count files would need the very resource that just ran
 * out. `/dev/ttys*` is the macOS naming (`ttys000`, `ttys001`, …): entries are created on demand
 * and RECLAIMED when the pty is closed — measured on this host going 492 → 500 → 492 across a batch
 * of terminals opening and closing. Nothing is cached, so every call is a fresh readdir, which is
 * what lets a machine that just freed some devices spawn again immediately instead of staying
 * refused until a restart. (It is also why a LEAKED master is so costly: a device whose master fd
 * is never closed is never reclaimed either, so it counts against the ceiling until the process
 * that leaked it exits.)
 */
function countPtyDevices(): number | null {
  if (os.platform() !== 'darwin') return null
  try {
    return fs.readdirSync('/dev').filter((name) => name.startsWith('ttys')).length
  } catch {
    return null
  }
}

/** Both numbers, measured now. Fail-open in every direction (see `readSpawnResources`). */
export function readPtyDevices(): PtyDevices {
  return { ceiling: ptyCeiling(), inUse: countPtyDevices() }
}

/** True when the machine has no pty device left to hand out. Unmeasured ⇒ false (stay silent). */
export function ptyDevicesExhausted(d: PtyDevices): boolean {
  if (d.ceiling === null || d.inUse === null) return false
  return d.inUse >= d.ceiling - PTY_DEVICE_HEADROOM
}

/**
 * The ONE sentence a spawn failure ends with, chosen from what was actually measured. Pure, so the
 * wording and the precedence can be pinned.
 *
 * The order matters as much as the wording:
 *  1. `archNote` — the only hint derived from reading THIS build's spawn-helper. When the helper
 *     cannot be exec'd at all, nothing else can be the cause.
 *  2. pty devices — the machine is out of them, so no process can open a terminal until some are
 *     returned. Stated INSTEAD of the generic advice, never alongside it: "rebuild node-pty" is
 *     precisely as wrong here as it was in the 2026-08-06 report.
 *  3. the caller's generic text, which is what it has always been — a guess of last resort.
 */
export function spawnFailureHint(
  archNote: string | null,
  devices: PtyDevices,
  generic: string
): string {
  if (archNote) return archNote
  if (!ptyDevicesExhausted(devices)) return generic
  return (
    `This MACHINE is out of pty devices (${devices.inUse} of ${devices.ceiling} allowed by ` +
    `\`kern.tty.ptmx_max\`), so no process can open a terminal until some are returned — close ` +
    `some terminals (a tmux session's pane holds one too), or raise the limit with ` +
    `\`sudo sysctl -w kern.tty.ptmx_max=<bigger>\`. Rebuilding node-pty will not help.`
  )
}

/**
 * Forget the cached ceiling because something just CHANGED it (the "Fix automatically…" button's
 * `sysctl -w`). Without this the TTL would keep serving the pre-fix number for up to a minute — and
 * the pressure banner it feeds would keep saying the machine is full after it was emptied.
 */
export function invalidatePtyCeiling(): void {
  ceiling = null
}

/** Test seam: forget the cached ceiling so a test can pin the read itself. */
export function resetPtyDevicesCacheForTests(): void {
  ceiling = null
  refreshing = false
}
