// Pty-device pressure: the WARNING that was missing when the 2026-08-11 field incident hit.
//
// We already diagnose the wall correctly once it is hit (pty-devices.ts writes the real sentence
// into the spawn failure), and we already have a session reaper — but the reaper only woke on
// MEMORY pressure, and during the incident RAM was plentiful while `/dev/ttys*` was full. So the
// machine walked into a hard stop with nothing said and nothing reclaimed.
//
// This module is the missing signal, and only the signal: pure classification plus a timer that
// reports LEVEL CHANGES. What each shell does with a level (banner, reaper sweep) is the shell's
// business — same split as memory-pressure.ts, whose cadence/dedupe design this deliberately
// copies rather than reinventing.

import { readPtyDevices, ptyDevicesExhausted, type PtyDevices } from './pty-devices'
import type { PtyPressure, PtyPressureLevel } from '@shared/types'

/**
 * Where "getting full" starts: 80% of the ceiling.
 *
 * A default macOS ceiling is 511 devices, so this is ~409 — a number no ordinary session reaches
 * (the incident host sat at 515 with 62 app PTYs, 18 tmux sessions and ~19 ssh children). It buys
 * roughly a hundred devices of runway, which is many terminals' worth of time to act, while
 * staying far enough from normal use that the banner is not wallpaper.
 */
export const PTY_PRESSURE_ELEVATED_RATIO = 0.8

/**
 * How often the level is re-measured.
 *
 * One `readdir('/dev')` (the ceiling is already cached in pty-devices), so the cost is nil — but
 * the condition it watches builds over minutes to hours, never in a second, and the memory monitor
 * beside it is already the fast lane at 30s. A minute is the slowest cadence that still puts the
 * banner up while there is runway left to use.
 */
export const PTY_PRESSURE_INTERVAL_MS = 60_000

/**
 * How long a HELD level stays quiet before it is said again.
 *
 * Five minutes, not one: unlike memory pressure — whose re-fire drives idempotent reclaim levers
 * the user never sees — a re-announce here can re-raise a BANNER, so the interval is a nagging
 * budget, not just a refresh rate. A level CHANGE always fires immediately; `none` is never
 * re-announced (there is nothing to re-say — the banner is already gone).
 *
 * What a re-announce MEANS is the renderer's call, and the two bands answer differently
 * (PtyPressureBanner): a dismissed `elevated` stays dismissed through these — it is an early
 * warning and the user has been told — while a dismissed `critical` comes back on the next one,
 * because terminals are failing to open while it is up. So this constant is the reminder cadence
 * for the wall, and the freshness cadence for the warning.
 */
export const PTY_PRESSURE_RE_ANNOUNCE_MS = 300_000

/**
 * Which band a device count falls in. Pure, so the boundaries can be pinned.
 *
 * `critical` reuses `ptyDevicesExhausted` rather than a second threshold of its own: the banner
 * must turn red at exactly the line the spawn error calls "out of pty devices", or the two would
 * contradict each other on the same machine at the same moment. It is checked FIRST because on a
 * small ceiling the two bands overlap and the worse reading is the true one.
 *
 * Unmeasured (non-darwin, or a sysctl/readdir that failed) ⇒ `none`: a guess must degrade to
 * silence, never to an alarm — same rule as the spawn hint.
 */
export function classifyPtyPressure(d: PtyDevices): PtyPressureLevel {
  if (d.ceiling === null || d.inUse === null) return 'none'
  if (ptyDevicesExhausted(d)) return 'critical'
  return d.inUse >= d.ceiling * PTY_PRESSURE_ELEVATED_RATIO ? 'elevated' : 'none'
}

/** One reading: the level plus the two numbers the banner prints ("N of M pty devices"). */
export function readPtyPressure(read: () => PtyDevices = readPtyDevices): PtyPressure {
  const d = read()
  return { level: classifyPtyPressure(d), usage: d.inUse, ceiling: d.ceiling }
}

export interface PtyPressureMonitor {
  start(): void
  stop(): void
  /** The current reading, without touching the dedupe state. */
  check(): PtyPressure
  /**
   * Report a reading through the same funnel a tick uses, unconditionally, and adopt it as the
   * held level. The "Fix automatically…" handler uses this so the banner clears the instant the
   * limit is raised, without the next tick then repeating what it just said.
   */
  announce(p: PtyPressure): void
}

export function createPtyPressureMonitor(opts: {
  read?: () => PtyDevices
  intervalMs?: number
  reAnnounceMs?: number
  onLevel: (p: PtyPressure) => void
}): PtyPressureMonitor {
  const read = opts.read ?? readPtyDevices
  const reAnnounceMs = opts.reAnnounceMs ?? PTY_PRESSURE_RE_ANNOUNCE_MS
  let timer: ReturnType<typeof setInterval> | null = null
  // Starting at 'none' is what makes a healthy machine silent: there is no transition to report.
  let held: PtyPressureLevel = 'none'
  let heldAt = 0

  const fire = (p: PtyPressure): void => {
    held = p.level
    heldAt = Date.now()
    // A consumer throw must never take the timer down with it (the responders send to a possibly
    // destroyed window and sweep the reaper) — same backstop as memory-pressure's onPressure.
    try {
      opts.onLevel(p)
    } catch (e) {
      console.warn('[pty-pressure] onLevel threw', e)
    }
  }

  const tick = (): void => {
    const p = readPtyPressure(read)
    if (p.level !== held) return fire(p)
    if (p.level === 'none') return
    if (Date.now() - heldAt >= reAnnounceMs) fire(p)
  }

  return {
    check: () => readPtyPressure(read),
    announce: fire,
    start(): void {
      if (timer) return
      timer = setInterval(tick, opts.intervalMs ?? PTY_PRESSURE_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
