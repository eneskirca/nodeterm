// Power guards for keep-awake: when holding the machine out of idle sleep stops being worth it.
//
// The tracker (keep-awake.ts) holds while a local agent is `working`. That is the right call on
// a charger and a cool machine, and the wrong one on a laptop at 3% battery or one the OS reports
// as critically hot — there, letting the machine sleep is the safer outcome for the user than a
// finished agent turn. Two rules, both RELEASE the assertion (never anything stronger):
//   - battery: on battery power below KEEP_AWAKE_BATTERY_FLOOR_PCT. Plugging back in re-holds.
//   - thermal: macOS reports `critical`. Latched until the state drops back to `fair`/`nominal`
//     (or `unknown`), so a machine hovering on the serious/critical boundary does not flap the
//     assertion on every notification.
//
// Fail-open, deliberately: an unreadable battery level (Windows, a reader that broke, no battery
// at all) or an unknown thermal state leaves today's behavior untouched. Keep-awake predates these
// guards and a broken reader must not silently switch the feature off. The stale-working sweep
// still caps the worst case, exactly as before.
//
// Electron-free: `onBattery` / `thermal` are injected (Electron's powerMonitor in
// src/main/keep-awake.ts); only the battery LEVEL is read here, because Electron's main process
// has no API for it.

import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import path from 'path'

/** On battery below this percent, keep-awake lets the machine sleep. */
export const KEEP_AWAKE_BATTERY_FLOOR_PCT = 5
/** How often the battery level is re-read while holding on battery. */
export const KEEP_AWAKE_BATTERY_POLL_MS = 60_000

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical'

export interface PowerGuardDeps {
  /** Live: is the machine running on battery right now? (powerMonitor.isOnBatteryPower) */
  onBattery(): boolean
  /** Live thermal state; 'unknown' where the platform reports none. */
  thermal(): ThermalState
  /** Battery level 0–100, or null when it cannot be read. */
  readPercent(): Promise<number | null>
  /** A guard input changed — the tracker should re-evaluate (tracker.refresh). */
  onChange(): void
  floorPct?: number
  pollMs?: number
  log?(msg: string): void
}

export interface PowerGuard {
  /** Does power allow holding the assertion right now? */
  allows(): boolean
  /** The reason it does not, for the log (null when it allows). */
  blockReason(): string | null
  /** Re-read the battery level, then notify. Call on on-battery / resume. */
  refreshBattery(): Promise<void>
  /** Thermal state or AC/battery changed — notify. */
  poke(): void
  /** The tracker started (true) / stopped (false) holding: polls the level only while holding. */
  setHolding(holding: boolean): void
  dispose(): void
}

export function createPowerGuard(deps: PowerGuardDeps): PowerGuard {
  const floor = deps.floorPct ?? KEEP_AWAKE_BATTERY_FLOOR_PCT
  const pollMs = deps.pollMs ?? KEEP_AWAKE_BATTERY_POLL_MS
  const log = deps.log ?? ((m: string): void => console.log(m))
  let percent: number | null = null
  let hot = false
  let poll: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let lastReason: string | null = null

  const reason = (): string | null => {
    const t = deps.thermal()
    if (t === 'critical') hot = true
    else if (t !== 'serious') hot = false // nominal / fair / unknown clear the latch
    if (hot) return `thermal state ${t}`
    if (deps.onBattery() && percent !== null && percent < floor) {
      return `on battery at ${percent}% (below ${floor}%)`
    }
    return null
  }

  const notify = (): void => {
    if (disposed) return
    const r = reason()
    if (r !== lastReason) {
      if (r) log(`[keep-awake] power guard: letting the machine sleep — ${r}`)
      else if (lastReason) log(`[keep-awake] power guard cleared (was: ${lastReason})`)
      lastReason = r
    }
    deps.onChange()
  }

  const refreshBattery = async (): Promise<void> => {
    let next: number | null = null
    try {
      next = await deps.readPercent()
    } catch {
      next = null
    }
    if (disposed) return
    percent = next
    notify()
  }

  return {
    allows: () => reason() === null,
    blockReason: reason,
    refreshBattery,
    poke: notify,
    setHolding(holding: boolean): void {
      if (holding && !poll && !disposed) {
        // Read once now: the cached level may be hours old by the time a hold begins.
        void refreshBattery()
        poll = setInterval(() => {
          if (deps.onBattery()) void refreshBattery()
        }, pollMs)
        poll.unref?.()
      } else if (!holding && poll) {
        clearInterval(poll)
        poll = undefined
      }
    },
    dispose(): void {
      disposed = true
      if (poll) clearInterval(poll)
      poll = undefined
    }
  }
}

/** The internal battery's percent from `pmset -g batt`, or null. */
export function parsePmsetBatt(out: string): number | null {
  for (const line of out.split('\n')) {
    if (!line.includes('InternalBattery')) continue
    const m = /(\d{1,3})%/.exec(line)
    if (!m) return null
    const n = Number(m[1])
    return n >= 0 && n <= 100 ? n : null
  }
  return null
}

/** One `/sys/class/power_supply/<name>` entry, as the Linux reader needs it. */
export interface LinuxSupply {
  type?: string
  scope?: string
  capacity?: string
  energyNow?: string
  energyFull?: string
  chargeNow?: string
  chargeFull?: string
}

/**
 * The system battery level from Linux power_supply entries, or null. Peripheral batteries
 * (`scope` = Device: a mouse, a headset) are ignored. Several system batteries (ThinkPad
 * BAT0+BAT1) are combined by energy (or charge) when every one reports it, else averaged.
 */
export function linuxBatteryPercent(supplies: LinuxSupply[]): number | null {
  const bats = supplies.filter((s) => s.type?.trim() === 'Battery' && s.scope?.trim() !== 'Device')
  if (bats.length === 0) return null
  const num = (v?: string): number | null => {
    if (v === undefined) return null
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  const pairs = bats.map((b) => {
    const now = num(b.energyNow) ?? num(b.chargeNow)
    const full = num(b.energyFull) ?? num(b.chargeFull)
    return now !== null && full !== null && full > 0 ? { now, full } : null
  })
  if (pairs.every((p) => p !== null)) {
    const now = pairs.reduce((a, p) => a + p!.now, 0)
    const full = pairs.reduce((a, p) => a + p!.full, 0)
    return Math.max(0, Math.min(100, Math.round((now / full) * 100)))
  }
  const caps = bats.map((b) => num(b.capacity)).filter((n): n is number => n !== null)
  if (caps.length === 0) return null
  return Math.max(0, Math.min(100, Math.round(caps.reduce((a, n) => a + n, 0) / caps.length)))
}

const SUPPLY_ROOT = '/sys/class/power_supply'

async function readLinuxSupplies(root = SUPPLY_ROOT): Promise<LinuxSupply[]> {
  const names = await fsp.readdir(root)
  const read = (dir: string, f: string): Promise<string | undefined> =>
    fsp.readFile(path.join(dir, f), 'utf8').catch(() => undefined)
  return Promise.all(
    names.map(async (n) => {
      const d = path.join(root, n)
      const [type, scope, capacity, energyNow, energyFull, chargeNow, chargeFull] = await Promise.all(
        ['type', 'scope', 'capacity', 'energy_now', 'energy_full', 'charge_now', 'charge_full'].map((f) =>
          read(d, f)
        )
      )
      return { type, scope, capacity, energyNow, energyFull, chargeNow, chargeFull }
    })
  )
}

/** Battery level on this machine, or null (unsupported platform, no battery, read failed). */
export async function readBatteryPercent(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  try {
    if (platform === 'darwin') {
      const out = await new Promise<string>((resolve, reject) =>
        execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout))
        )
      )
      return parsePmsetBatt(out)
    }
    if (platform === 'linux') return linuxBatteryPercent(await readLinuxSupplies())
  } catch {
    return null
  }
  return null
}
