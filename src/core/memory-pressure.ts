// Two-signal memory pressure (cmux's MemoryPressureMonitor pattern, Electron-free): host
// available-memory watermarks (readMemInfo — the same source session-budget trusts, except on
// darwin, where it is not measuring what its name says; see hostMemReader) plus this process's
// own RSS, because the host signal alone can't tell you YOU are the problem.
// Consumers hang reclaim levers off onPressure; all levers must be idempotent — the monitor
// re-fires a held severity at most once per RE_FIRE_FLOOR_MS.
import { hostMemReader, type MemInfo } from './session-budget'

export { hostMemReader }

export type PressureSeverity = 'warning' | 'critical'

export const PRESSURE_INTERVAL_MS = 30_000
export const RE_FIRE_FLOOR_MS = 60_000
export const SELF_RSS_WARN_MB = 4096
export const SELF_RSS_CRIT_MB = 8192


export interface MemoryPressureMonitor {
  start(): void
  stop(): void
  /** One classification pass; null = no pressure (including "could not read"). */
  check(): PressureSeverity | null
}

export function createMemoryPressureMonitor(opts: {
  readMem?: () => MemInfo | null
  selfRssMb?: () => number
  intervalMs?: number
  onPressure: (s: PressureSeverity) => void
}): MemoryPressureMonitor {
  const readMem = opts.readMem ?? hostMemReader()
  // `memoryUsage.rss()` reads just the one number; `memoryUsage()` builds the whole stats object
  // (heap walk included) every 30 s for a field we throw away.
  const selfRss = opts.selfRssMb ?? ((): number => Math.round(process.memoryUsage.rss() / 1048576))
  let timer: ReturnType<typeof setInterval> | null = null
  let lastFired = 0

  const check = (): PressureSeverity | null => {
    const rss = selfRss()
    const m = readMem()
    // A failed read is never evidence of pressure; self-RSS still counts.
    const hostCrit = m !== null && m.availableMb < m.totalMb * 0.05
    const hostWarn = m !== null && m.availableMb < m.totalMb * 0.1
    if (hostCrit || rss > SELF_RSS_CRIT_MB) return 'critical'
    if (hostWarn || rss > SELF_RSS_WARN_MB) return 'warning'
    return null
  }

  return {
    check,
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        const s = check()
        if (!s) return
        const now = Date.now()
        if (now - lastFired < RE_FIRE_FLOOR_MS) return
        lastFired = now
        // A consumer throw must never take the shell down with it — the responders run in a
        // shell (`webContents.send` on a destroyed window, a reaper sweep) and this timer is the
        // only thing on the stack. Log and keep the monitor alive, like session-budget's sweep.
        try {
          opts.onPressure(s)
        } catch (e) {
          console.warn('[memory-pressure] onPressure threw', e)
        }
      }, opts.intervalMs ?? PRESSURE_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
