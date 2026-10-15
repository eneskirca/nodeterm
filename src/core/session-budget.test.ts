import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planReap,
  parseSessionList,
  sessionBudgetConfig,
  createSessionReaper,
  hostUnderMemoryPressure,
  readMemInfo,
  type SessionInfo,
  type SessionBudgetConfig
} from './session-budget'

const NOW = 1_753_000_000 // fixed epoch seconds for every test

const cfg = (over: Partial<SessionBudgetConfig> = {}): SessionBudgetConfig => ({
  disabled: false,
  minAvailableMb: 2048,
  maxDetached: 48,
  graceSec: 6 * 3600,
  batchMax: 8,
  swapFreeRatio: 0.2,
  swapAvailRatio: 0.25,
  psiFullAvg60: 10,
  ...over
})

/**
 * An nt- session whose PANE has been silent for `idleH` hours, with `clients` attached.
 *
 * **`activitySec` is deliberately always FRESH (60 s old), no matter how long the session has been
 * silent** — that is the shape every session on a live host has, because tmux bumps
 * `#{session_activity}` on every client attach and nodeterm attaches constantly (measured: across
 * 67 production sessions the OLDEST `session_activity` was 33 minutes, while the oldest
 * `#{window_activity}` was 37 hours).
 *
 * Encoding it in the shared helper makes the whole suite a regression test for the clock: if this
 * module ever goes back to gating on `activitySec`, nothing is ever past grace and every eligibility
 * assertion below turns red at once. A helper that set both stamps to the same value would let that
 * revert pass — the two clocks have to disagree here, because they disagree in production.
 */
const idle = (name: string, idleH: number, clients = 0): SessionInfo => ({
  name,
  clients,
  activitySec: NOW - 60,
  outputSec: NOW - idleH * 3600
})

const lowMem = { availableMb: 500, totalMb: 64_000 }
const okMem = { availableMb: 30_000, totalMb: 64_000 }

describe('planReap (pure policy)', () => {
  it('under memory pressure, reaps the least-recently-active detached sessions first', () => {
    const plan = planReap([idle('nt-old', 240), idle('nt-mid', 48), idle('nt-new', 7)], lowMem, NOW, cfg({ batchMax: 2 }))
    expect(plan).toEqual(['nt-old', 'nt-mid'])
  })

  it('never reaps an attached session, no matter how idle', () => {
    const plan = planReap([idle('nt-watched', 500, 1), idle('nt-idle', 500)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-idle'])
  })

  it('never reaps within the grace window, even under pressure', () => {
    const plan = planReap([idle('nt-recent', 1), idle('nt-old', 100)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-old'])
  })

  it('ignores sessions not named nt-* (a user session on the same socket is untouchable)', () => {
    const plan = planReap([idle('main', 500), idle('nt-x', 500)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-x'])
  })

  it('healthy memory + under cap → reaps nothing', () => {
    const plan = planReap([idle('nt-a', 500), idle('nt-b', 500)], okMem, NOW, cfg())
    expect(plan).toEqual([])
  })

  it('a FAILED memory read is not pressure (mem=null never triggers the watermark)', () => {
    const plan = planReap([idle('nt-a', 500)], null, NOW, cfg())
    expect(plan).toEqual([])
  })

  it('count cap is a backstop: excess detached sessions are reaped even with healthy memory', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, okMem, NOW, cfg({ maxDetached: 7 }))
    // 10 detached, cap 7 → 3 oldest go (highest idle hours = oldest activity)
    expect(plan).toEqual(['nt-s9', 'nt-s8', 'nt-s7'])
  })

  it('attached sessions do not count toward freeing the cap, but are never the ones killed', () => {
    const sessions = [idle('nt-live', 500, 2), ...Array.from({ length: 5 }, (_, i) => idle(`nt-d${i}`, 100 + i))]
    const plan = planReap(sessions, okMem, NOW, cfg({ maxDetached: 4 }))
    expect(plan).toEqual(['nt-d4'])
  })

  it('combined triggers stay bounded by batchMax per sweep (gradual convergence)', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, lowMem, NOW, cfg({ maxDetached: 5, batchMax: 4 }))
    expect(plan).toHaveLength(4)
  })

  it('disabled kill switch plans nothing', () => {
    const plan = planReap([idle('nt-a', 500)], lowMem, NOW, cfg({ disabled: true }))
    expect(plan).toEqual([])
  })

  it('pressure alone reaps at most batchMax even with many eligible', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, lowMem, NOW, cfg({ batchMax: 3 }))
    expect(plan).toHaveLength(3)
  })

  // The 2026-08-11 profile: plenty of RAM, well under the detached cap, and the machine still
  // could not open a terminal because it was out of pty DEVICES. Without an allowance of its own
  // that reading plans nothing at all — the sweep the shell fires on critical pty pressure would
  // be a no-op, which is exactly the bug this argument exists to close.
  it('an external pressure reason earns the same allowance low memory does', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    expect(planReap(sessions, okMem, NOW, cfg({ batchMax: 3 }))).toHaveLength(0)
    expect(planReap(sessions, okMem, NOW, cfg({ batchMax: 3 }), true)).toHaveLength(3)
  })

  it('external pressure widens NO safety gate: attached and in-grace sessions still live', () => {
    const sessions = [idle('nt-watched', 500, 1), idle('nt-fresh', 1), idle('user-shell', 500)]
    expect(planReap(sessions, okMem, NOW, cfg(), true)).toEqual([])
  })

  it('the kill switch still wins over an external pressure reason', () => {
    const plan = planReap([idle('nt-a', 500)], okMem, NOW, cfg({ disabled: true }), true)
    expect(plan).toEqual([])
  })
})

describe('the two clocks (the measurement this whole change rests on)', () => {
  // 2026-08-15, production host: `nt-term-msrblsui-9` had NO pane output for 18.1 hours while
  // `session_activity` read 15 minutes, because nodeterm had just re-attached a client to it.
  const realHostSession: SessionInfo = {
    name: 'nt-term-msrblsui-9',
    clients: 0,
    activitySec: NOW - 15 * 60, // what tmux says: 15 minutes
    outputSec: NOW - 18 * 3600 // what the pane says: 18 hours of silence
  }

  it('reaps a session tmux calls fresh when its pane has been silent past grace', () => {
    expect(planReap([realHostSession], lowMem, NOW, cfg())).toEqual(['nt-term-msrblsui-9'])
  })

  it('SPARES a session tmux calls stale when its pane is actually producing output', () => {
    // The mirror image, and the reason this is not merely "use the older number": a session whose
    // client detached hours ago but whose agent is still printing must survive. Gating on
    // `activitySec` would kill it.
    const working: SessionInfo = {
      name: 'nt-busy',
      clients: 0,
      activitySec: NOW - 40 * 3600, // no client has attached in nearly two days
      outputSec: NOW - 30 // …but the pane wrote something 30 seconds ago
    }
    expect(planReap([working], lowMem, NOW, cfg())).toEqual([])
  })

  it('orders by silence, not by attach time', () => {
    const a: SessionInfo = { name: 'nt-a', clients: 0, activitySec: NOW - 3600, outputSec: NOW - 10 * 3600 }
    const b: SessionInfo = { name: 'nt-b', clients: 0, activitySec: NOW - 90000, outputSec: NOW - 40 * 3600 }
    // `b` is the least-recently-ACTIVE by output and must die first, even though `a` looks older
    // on the attach clock's ordering.
    expect(planReap([a, b], lowMem, NOW, cfg({ batchMax: 1 }))).toEqual(['nt-b'])
  })
})

describe('parseSessionList', () => {
  it('parses names, CLIENT COUNTS, activity and OUTPUT time, skipping malformed lines', () => {
    const out = parseSessionList(
      'nt-a|0|1753000000|1752900000\nnt-b|2|1753000100|1753000100\n\njunk\nx|y|z|w\nnt-c|0|1753000000\n'
    )
    expect(out).toEqual([
      { name: 'nt-a', clients: 0, activitySec: 1_753_000_000, outputSec: 1_752_900_000 },
      { name: 'nt-b', clients: 2, activitySec: 1_753_000_100, outputSec: 1_753_000_100 }
    ])
    // `nt-c` carried the OLD three-field shape. It is dropped rather than defaulted, so a format
    // that ever regresses produces no candidates instead of candidates with a fabricated clock.
    expect(out.map((s) => s.name)).not.toContain('nt-c')
  })

  it('rejects a row with MORE than four fields rather than parsing the first four', () => {
    // The length check is pinned EXACTLY, as the original parser pinned its own. A row carrying an
    // unexpected fifth field is a row in a format we do not understand, and the safe answer is to
    // contribute no candidate rather than to trust four columns that happen to look plausible.
    //
    // Note the shape of this row: its first four fields are all individually VALID, so the numeric
    // guards below cannot reject it. Only the exact-length check can — which is what makes this an
    // assertion about that check rather than about the guards. (A row like `nt-a|b|0|1|2` proves
    // nothing here: `Number('b')` is NaN and the client-count guard rejects it either way.)
    expect(parseSessionList('nt-a|0|1753000000|1752900000|extra')).toEqual([])
    expect(parseSessionList(`nt-ok|0|${NOW - 60}|${NOW - 40 * 3600}`)).toHaveLength(1)
  })

  it('reduces a multi-window session to ONE row holding its most recent output', () => {
    // Verified against tmux: `list-windows -a` emits one line per window, and a two-window session
    // carries two distinct `#{window_activity}` stamps. A session is silent only when ALL of its
    // windows are, so the newest wins — and it must win regardless of which order they arrive in.
    const newestLast = parseSessionList('nt-a|0|1753000000|1752900000\nnt-a|0|1753000000|1752999000')
    const newestFirst = parseSessionList('nt-a|0|1753000000|1752999000\nnt-a|0|1753000000|1752900000')
    expect(newestLast).toEqual([{ name: 'nt-a', clients: 0, activitySec: 1_753_000_000, outputSec: 1_752_999_000 }])
    expect(newestFirst).toEqual(newestLast)
  })

  it('a session with a busy second window is NOT reaped for its quiet first one', () => {
    // The behavioural consequence of the reduce, asserted through planReap rather than the parser:
    // window 0 has been silent for 40 h, window 1 wrote a second ago.
    const sessions = parseSessionList(
      `nt-two|0|${NOW - 60}|${NOW - 40 * 3600}\nnt-two|0|${NOW - 60}|${NOW - 1}`
    )
    expect(planReap(sessions, lowMem, NOW, cfg())).toEqual([])
  })
})

describe('hostUnderMemoryPressure', () => {
  const c = cfg({ minAvailableMb: 6416 }) // 10% of a 64 GB host

  // The live production reading, 2026-08-15: 12.6 GB available of 62.7 GB (well above the
  // watermark), swap 73.9% consumed, PSI quiet. Nothing is wrong right now, so nothing may fire —
  // this is the guard against a fix that simply reaps more.
  const healthyToday = { availableMb: 13_481, totalMb: 64_158, swapTotalMb: 8192, swapFreeMb: 2140, psiFullAvg60: 0 }

  // The reading this task was opened on: 10.5 GB available (16.7%), swap 84% consumed.
  const swapSpent = { availableMb: 10_752, totalMb: 64_158, swapTotalMb: 8192, swapFreeMb: 1331, psiFullAvg60: 0 }

  it('a failed read is never pressure', () => {
    expect(hostUnderMemoryPressure(null, c)).toBe(false)
  })

  it('the available-memory watermark still fires on its own', () => {
    expect(hostUnderMemoryPressure({ availableMb: 500, totalMb: 64_158 }, c)).toBe(true)
  })

  it("today's host — above the watermark, swap 74% spent, PSI quiet — is NOT pressure", () => {
    expect(hostUnderMemoryPressure(healthyToday, c)).toBe(false)
  })

  it('swap 84% spent WITH low available memory IS pressure (the state the old reader called healthy)', () => {
    expect(hostUnderMemoryPressure(swapSpent, c)).toBe(true)
    // …and the old instrument, which is exactly `availableMb` against the watermark, says no.
    expect(swapSpent.availableMb < c.minAvailableMb).toBe(false)
  })

  it('either half of the swap term alone is benign', () => {
    // Swap spent, but memory is plentiful: cold pages parked in swap on a healthy host.
    expect(hostUnderMemoryPressure({ ...swapSpent, availableMb: 40_000 }, c)).toBe(false)
    // Memory lowish, but swap untouched: the reserve is still there.
    expect(hostUnderMemoryPressure({ ...swapSpent, swapFreeMb: 8000 }, c)).toBe(false)
  })

  it('a host with NO swap configured never trips the swap term (0/0 is not exhaustion)', () => {
    expect(hostUnderMemoryPressure({ ...swapSpent, swapTotalMb: 0, swapFreeMb: 0 }, c)).toBe(false)
  })

  it('absent swap fields are no signal, not zero', () => {
    const { swapTotalMb: _t, swapFreeMb: _f, ...noSwap } = swapSpent
    expect(hostUnderMemoryPressure(noSwap, c)).toBe(false)
  })

  it('HALF a swap reading is no signal either, in both directions', () => {
    // `MemInfo` is a shared type and its swap pair is optional, so a caller that is not
    // `parseMemInfoText` (the SSH leg, a future reader) can hand over one half. Neither half alone
    // may be completed with a default: filling the missing TOTAL invents a denominator, and filling
    // the missing FREE with 0 states that swap is exhausted. Both would make this term fire on a
    // host nobody measured. Pinned explicitly because the arithmetic happens to yield NaN today —
    // a guard that only works by accident of NaN is not a guard.
    const { swapFreeMb: _f, ...totalOnly } = swapSpent
    const { swapTotalMb: _t, ...freeOnly } = swapSpent
    expect(hostUnderMemoryPressure(totalOnly, c)).toBe(false)
    expect(hostUnderMemoryPressure(freeOnly, c)).toBe(false)
  })

  it('PSI full avg60 past the bar is pressure on its own; absent PSI is not', () => {
    expect(hostUnderMemoryPressure({ availableMb: 40_000, totalMb: 64_158, psiFullAvg60: 25 }, c)).toBe(true)
    expect(hostUnderMemoryPressure({ availableMb: 40_000, totalMb: 64_158, psiFullAvg60: 0 }, c)).toBe(false)
    expect(hostUnderMemoryPressure({ availableMb: 40_000, totalMb: 64_158 }, c)).toBe(false)
  })

  it('a darwin-shaped reading (no swap, no PSI fields) can only ever use the watermark', () => {
    // parseVmStat populates neither, so macOS cannot start firing on a signal never measured there.
    const darwinish = { availableMb: 3000, totalMb: 24_576 }
    expect(hostUnderMemoryPressure(darwinish, cfg({ minAvailableMb: 2458 }))).toBe(false)
    expect(hostUnderMemoryPressure({ ...darwinish, availableMb: 100 }, cfg({ minAvailableMb: 2458 }))).toBe(true)
  })

  it('the new terms can be switched off, and off means off', () => {
    expect(hostUnderMemoryPressure(swapSpent, cfg({ minAvailableMb: 6416, swapFreeRatio: 0 }))).toBe(false)
    const psiOnly = { availableMb: 40_000, totalMb: 64_158, psiFullAvg60: 25 }
    expect(hostUnderMemoryPressure(psiOnly, cfg({ minAvailableMb: 6416, psiFullAvg60: 0 }))).toBe(false)
  })

  it('drives planReap: the same sessions live or die on the swap reading alone', () => {
    const sessions = [idle('nt-silent', 40)]
    expect(planReap(sessions, healthyToday, NOW, cfg({ minAvailableMb: 6416 }))).toEqual([])
    expect(planReap(sessions, swapSpent, NOW, cfg({ minAvailableMb: 6416 }))).toEqual(['nt-silent'])
  })
})

describe('sessionBudgetConfig', () => {
  const memOf = (totalMb: number) => ({ availableMb: Math.round(totalMb / 2), totalMb })

  it('defaults: 10% of RAM watermark (floor 1GB), grace 6h, batch 8', () => {
    const c = sessionBudgetConfig({}, memOf(64_000), 0)
    expect(c).toEqual({
      disabled: false,
      minAvailableMb: 6400,
      maxDetached: 33,
      graceSec: 21_600,
      batchMax: 8,
      swapFreeRatio: 0.2,
      swapAvailRatio: 0.25,
      psiFullAvg60: 10
    })
    expect(sessionBudgetConfig({}, memOf(4000), 0).minAvailableMb).toBe(1024)
  })

  it('the detached cap SCALES WITH THE HOST instead of being the constant 48', () => {
    // A share of host RAM over a nominal session cost, clamped to [8, 48]. The point is that a
    // 16 GB laptop and a 62 GB server stop getting the same number: 48 detached agent sessions is
    // ~23 GB of nominal RSS, i.e. more than a 16 GB machine physically has.
    expect(sessionBudgetConfig({}, memOf(64_158), 0).maxDetached).toBe(33) // the production host
    expect(sessionBudgetConfig({}, memOf(16_384), 0).maxDetached).toBe(8)
    expect(sessionBudgetConfig({}, memOf(8192), 0).maxDetached).toBe(8) // floor holds a small host usable
    // The ceiling is the historical constant, so this can only ever LOWER a cap, never raise one.
    expect(sessionBudgetConfig({}, memOf(1_000_000), 0).maxDetached).toBe(48)
  })

  it('NO host reading (darwin) keeps the historical 48 rather than deriving from os.totalmem()', () => {
    // Deriving here would silently change reaping on macOS — a cap of 12 on a 24 GB Mac — off a
    // host figure whose meaning there this module has been burned by twice. The fallback total is
    // still used for the watermark, which is the number that HAS a defined meaning.
    const c = sessionBudgetConfig({}, null, 24_576)
    expect(c.maxDetached).toBe(48)
    expect(c.minAvailableMb).toBe(2458)
  })

  it('env overrides win; junk values fall back to the DERIVED cap, not to 48', () => {
    const c = sessionBudgetConfig(
      {
        NODETERM_SESSION_MIN_AVAILABLE_MB: '3000',
        NODETERM_SESSION_MAX_DETACHED: 'garbage',
        NODETERM_SESSION_GRACE_HOURS: '12',
        NODETERM_SESSION_REAP_DISABLED: '1'
      },
      memOf(64_000),
      0
    )
    expect(c.minAvailableMb).toBe(3000)
    expect(c.maxDetached).toBe(33)
    expect(c.graceSec).toBe(43_200)
    expect(c.disabled).toBe(true)
    expect(sessionBudgetConfig({ NODETERM_SESSION_MAX_DETACHED: '5' }, memOf(64_000), 0).maxDetached).toBe(5)
  })

  it('the swap and PSI terms are tunable, and junk falls back', () => {
    const c = (env: Record<string, string>) => sessionBudgetConfig(env, memOf(64_000), 0)
    expect(c({ NODETERM_SESSION_SWAP_FREE_PCT: '35' }).swapFreeRatio) .toBeCloseTo(0.35)
    expect(c({ NODETERM_SESSION_PSI_FULL_AVG60: '40' }).psiFullAvg60).toBe(40)
    for (const v of ['abc', '', '0', '-3']) {
      expect(c({ NODETERM_SESSION_SWAP_FREE_PCT: v }).swapFreeRatio).toBeCloseTo(0.2)
      expect(c({ NODETERM_SESSION_PSI_FULL_AVG60: v }).psiFullAvg60).toBe(10)
    }
  })
})

// ---- service over fake exec ------------------------------------------------------------------

type Call = { args: string[] }

function fakeWorld(listings: Record<string, string[]>): {
  calls: Call[]
  exec: (bin: string, args: string[]) => Promise<string>
} {
  const calls: Call[] = []
  return {
    calls,
    exec: async (_bin, args) => {
      calls.push({ args })
      const socket = args[1]
      if (args[2] === 'list-windows') {
        const lines = listings[socket]
        if (!lines) throw new Error('no server running')
        return lines.join('\n')
      }
      return '' // kill-session
    }
  }
}

const OLD = String(NOW - 100 * 3600)

/**
 * One `list-windows -a` row. `session_activity` is pinned FRESH (60 s) for the same reason the
 * `idle` helper pins it: that is the only shape a live host ever presents, so the service tests
 * exercise the honest clock rather than a stamp that would never be stale in production.
 */
const row = (name: string, clients: number, silentSince: number | string): string =>
  `${name}|${clients}|${NOW - 60}|${silentSince}`

describe('createSessionReaper (service)', () => {
  const base = {
    readMem: () => ({ availableMb: 100, totalMb: 64_000 }),
    env: {} as NodeJS.ProcessEnv,
    nowSec: () => NOW,
    log: () => {}
  }

  it('sweeps every socket, kills planned sessions on the right socket with exact-match targets', async () => {
    const w = fakeWorld({
      'node-terminal': [row('nt-local', 0, OLD)],
      'nodeterm-rmt': [row('nt-remote', 0, OLD)]
    })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(2)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([
      { args: ['-L', 'node-terminal', 'kill-session', '-t', '=nt-local'] },
      { args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-remote'] }
    ])
  })

  it('the kill log names BOTH clocks, with the silence leading', async () => {
    // The attach clock's only production consumer is this log line. It rides along BECAUSE it
    // disagrees with the silence: an operator cross-checking `tmux ls` sees `session_activity`
    // minutes old and would read the reap as a bug unless the line itself explains the discrepancy.
    // The numbers are pinned, not just the words — 100.0h of silence against a 0.0h-old attach is
    // exactly the two-clock disagreement the whole change rests on.
    const lines: string[] = []
    const w = fakeWorld({ 'node-terminal': [row('nt-x', 0, OLD)] })
    const reaper = createSessionReaper({ ...base, log: (m) => lines.push(m), tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(1)
    expect(lines).toEqual([
      '[session-budget] reaped detached session nt-x — no pane output for 100.0h; last attach 0.0h ago (socket node-terminal)'
    ])
  })

  it('re-verifies at kill time: a session attached between plan and kill is spared', async () => {
    let first = true
    const w = fakeWorld({})
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'list-windows' && args[1] === 'node-terminal') {
        if (first) {
          first = false
          return row('nt-x', 0, OLD)
        }
        return row('nt-x', 1, OLD) // now attached
      }
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })

  it('a socket whose listing fails contributes no candidates; the other socket still sweeps', async () => {
    const w = fakeWorld({ 'nodeterm-rmt': [row('nt-r', 0, OLD)] }) // node-terminal listing throws
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(1)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([{ args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-r'] }])
  })

  it('kill switch: disabled env runs no tmux commands at all', async () => {
    const w = fakeWorld({ 'node-terminal': [row('nt-x', 0, OLD)] })
    const reaper = createSessionReaper({
      ...base,
      env: { NODETERM_SESSION_REAP_DISABLED: '1' },
      tmuxBin: () => 'tmux',
      exec: w.exec
    })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls).toHaveLength(0)
  })

  it('tmux unavailable (bin=null) → quiet no-op', async () => {
    const w = fakeWorld({ 'node-terminal': [row('nt-x', 0, OLD)] })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, exec: w.exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls).toHaveLength(0)
  })

  it('a failing kill is tolerated and does not abort the rest of the batch', async () => {
    const w = fakeWorld({ 'node-terminal': [row('nt-a', 0, OLD), row('nt-b', 0, NOW - 99 * 3600)] })
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'kill-session' && args[4] === '=nt-a') throw new Error('gone already')
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(1) // nt-b still dies
  })

  it('healthy memory + under cap → lists but never kills', async () => {
    const w = fakeWorld({ 'node-terminal': [row('nt-x', 0, OLD)] })
    const reaper = createSessionReaper({
      ...base,
      readMem: () => ({ availableMb: 30_000, totalMb: 64_000 }),
      tmuxBin: () => 'tmux',
      exec: w.exec
    })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })

  it('…but the same host sweeps under an explicit external pressure reason', async () => {
    const w = fakeWorld({ 'node-terminal': [row('nt-x', 0, OLD)] })
    const reaper = createSessionReaper({
      ...base,
      readMem: () => ({ availableMb: 30_000, totalMb: 64_000 }),
      tmuxBin: () => 'tmux',
      sockets: ['node-terminal'],
      exec: w.exec
    })
    expect(await reaper.sweep({ pressure: 'pty' })).toBe(1)
  })

  it('an external reason never overrides the attached/grace exemptions', async () => {
    const w = fakeWorld({
      'node-terminal': [row('nt-watched', 1, OLD), row('nt-fresh', 0, NOW - 60)]
    })
    const reaper = createSessionReaper({
      ...base,
      readMem: () => ({ availableMb: 30_000, totalMb: 64_000 }),
      tmuxBin: () => 'tmux',
      sockets: ['node-terminal'],
      exec: w.exec
    })
    expect(await reaper.sweep({ pressure: 'pty' })).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })
})

describe('planReap with no memory signal (the darwin shape)', () => {
  const idle = (name: string, hoursAgo: number): SessionInfo => ({
    name,
    clients: 0,
    activitySec: 1_000_000 - 60,
    outputSec: 1_000_000 - hoursAgo * 3600
  })

  it('culls NOTHING on memory grounds when the reader reports null', () => {
    // macOS: available BYTES is not the OS's pressure signal (measured: 82% used, 8.38 GB
    // compressed, macOS's own graph GREEN). hostMemReader returns null there, and null must mean
    // "no pressure signal", never "no memory". Absence of evidence may not cull a session.
    const sessions = Array.from({ length: 20 }, (_, i) => idle(`nt-old-${i}`, 48))
    const cfg = sessionBudgetConfig({}, null, 24576)
    expect(planReap(sessions, null, 1_000_000, cfg)).toEqual([])
  })

  it('still culls past the detached-count cap without any memory signal', () => {
    // The cap is not memory-based, so it survives — that is what keeps the reaper useful on macOS.
    const sessions = Array.from({ length: 60 }, (_, i) => idle(`nt-old-${i}`, 48))
    const cfg = sessionBudgetConfig({}, null, 24576)
    expect(planReap(sessions, null, 1_000_000, cfg).length).toBeGreaterThan(0)
  })

  it('…and that cap is still the historical 48 there, not a figure derived from os.totalmem()', () => {
    // 60 detached sessions against a cap of 48 is 12 over; a derived cap (24 GB → 12) would make it
    // 48 over and reap a full batch on a Mac that has done nothing wrong.
    expect(sessionBudgetConfig({}, null, 24576).maxDetached).toBe(48)
  })
})

describe("the reaper's default memory reader", () => {
  /**
   * A SOURCE-level guard, deliberately, and here is why a behavioural one is not possible ON THIS
   * PLATFORM: `hostMemReader` differs from `readMemInfo` ONLY on darwin, and CI runs on Linux,
   * where the two are the same function. Reverting the default to `readMemInfo` therefore leaves
   * every behavioural test green — measured, not assumed. The darwin-gated suite below IS the
   * behavioural version of this guard; this string check is what stands in for it everywhere else.
   *
   * What it guards is the thing that actually broke: on macOS `readMemInfo` reports honest bytes,
   * but available BYTES are not the OS's pressure signal (82% used with macOS's own graph GREEN,
   * measured 2026-08-12), so a byte watermark culls sessions on a machine macOS says is fine.
   */
  it('defaults to hostMemReader, not readMemInfo', () => {
    const src = readFileSync(join(__dirname, 'session-budget.ts'), 'utf8')
    expect(src).toContain('opts.readMem ?? hostMemReader()')
    expect(src).not.toContain('opts.readMem ?? readMemInfo')
  })
})

describe('darwin default reader: no byte reading may ever reap (behavioural)', () => {
  /**
   * Gated to darwin because only there do `hostMemReader` and `readMemInfo` diverge — on Linux
   * they are the same function, so this test would FAIL there for the wrong reason (the real
   * `/proc/meminfo` reading legitimately trips the impossible watermark below). On a Mac it is
   * the real guard the source-text check above merely approximates.
   */
  const onDarwin = it.skipIf(process.platform !== 'darwin')

  onDarwin('readMemInfo yields an honest reading here — the discriminator is real, not vacuous', () => {
    // If vm_stat parsing ever regressed to null on darwin, the reaping test below would pass for
    // an empty reason (both readers null). This companion assertion is what keeps it meaningful.
    const mem = readMemInfo()
    expect(mem).not.toBeNull()
    expect(mem!.totalMb).toBeGreaterThan(1024)
    expect(mem!.availableMb).toBeGreaterThan(0)
    expect(mem!.availableMb).toBeLessThan(mem!.totalMb)
  })

  onDarwin('without an injected readMem, sessions survive NO MATTER how full memory is', async () => {
    // The watermark is set above any physically possible host (1 TB available), so ANY byte
    // reading — however healthy the machine — counts as pressure. Only a reader that refuses to
    // produce bytes at all (hostMemReader's darwin null) keeps these sessions alive. This encodes
    // "memory fullness must never reap on macOS" without depending on the host's current load.
    const w = fakeWorld({
      'node-terminal': Array.from({ length: 20 }, (_, i) => row(`nt-idle-${i}`, 0, OLD))
    })
    const reaper = createSessionReaper({
      tmuxBin: () => 'tmux',
      sockets: ['node-terminal'],
      exec: w.exec,
      env: { NODETERM_SESSION_MIN_AVAILABLE_MB: '1000000000' },
      nowSec: () => NOW,
      log: () => {}
      // deliberately NO readMem: the default reader is the thing under test
    })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })
})

describe('sessionBudgetConfig with fractional env values', () => {
  // `null` mem, so the cap default is the historical 48 and these assertions keep testing the
  // env-parsing trap they were written for rather than the new derivation.
  const cfg = (env: Record<string, string>) => sessionBudgetConfig(env, null, 24576)

  it('a fractional MAX_DETACHED falls back — it must never become a cap of ZERO', () => {
    // Math.floor(0.5) === 0, and a cap of zero is not a smaller cap: every detached session counts
    // as over-cap, so a full batch dies every sweep. The unsafe direction.
    expect(cfg({ NODETERM_SESSION_MAX_DETACHED: '0.5' }).maxDetached).toBe(48)
    expect(cfg({ NODETERM_SESSION_MAX_DETACHED: '0.9' }).maxDetached).toBe(48)
    // A real value still works, and 1.5 still floors to 1 rather than falling back.
    expect(cfg({ NODETERM_SESSION_MAX_DETACHED: '10' }).maxDetached).toBe(10)
    expect(cfg({ NODETERM_SESSION_MAX_DETACHED: '1.5' }).maxDetached).toBe(1)
  })

  it('a fractional GRACE_HOURS means what it says — half an hour, not NO grace', () => {
    // The plausible-input trap: `abc`/``/`0` all fell back safely, but `0.5` floored to zero grace,
    // making a session reapable the moment it detached.
    expect(cfg({ NODETERM_SESSION_GRACE_HOURS: '0.5' }).graceSec).toBe(1800)
    expect(cfg({ NODETERM_SESSION_GRACE_HOURS: '0.25' }).graceSec).toBe(900)
    expect(cfg({ NODETERM_SESSION_GRACE_HOURS: '2' }).graceSec).toBe(7200)
  })

  it('junk and zero still fall back to the safe defaults on every key', () => {
    for (const v of ['abc', '', '0', '-3']) {
      expect(cfg({ NODETERM_SESSION_GRACE_HOURS: v }).graceSec).toBe(6 * 3600)
      expect(cfg({ NODETERM_SESSION_MAX_DETACHED: v }).maxDetached).toBe(48)
      expect(cfg({ NODETERM_SESSION_REAP_BATCH: v }).batchMax).toBe(8)
    }
  })
})

describe('createSessionReaper — session-host leg (no tmux, Windows)', () => {
  const base = {
    readMem: () => ({ availableMb: 100, totalMb: 64_000 }), // under the watermark: pressure
    env: {} as NodeJS.ProcessEnv,
    nowSec: () => NOW,
    log: () => {}
  }
  const hostRow = (name: string, clients: number, idleH: number): SessionInfo => ({
    name,
    clients,
    activitySec: NOW - idleH * 3600,
    outputSec: NOW - idleH * 3600
  })
  const fakeHost = (listings: Array<SessionInfo[] | null>) => {
    const killed: string[] = []
    let call = 0
    return {
      killed,
      backend: {
        list: async () => listings[Math.min(call++, listings.length - 1)],
        kill: async (name: string) => {
          killed.push(name)
          return true
        }
      }
    }
  }

  it('reaps detached, silent sessions past the grace window and spares attached ones', async () => {
    const rows = [hostRow('nt-idle', 0, 100), hostRow('nt-watched', 1, 100), hostRow('nt-fresh', 0, 1)]
    const h = fakeHost([rows])
    const lines: string[] = []
    const reaper = createSessionReaper({
      ...base,
      log: (m) => lines.push(m),
      tmuxBin: () => null,
      sessionHost: () => h.backend
    })
    expect(await reaper.sweep()).toBe(1)
    expect(h.killed).toEqual(['nt-idle'])
    expect(lines).toEqual([
      '[session-budget] reaped detached session nt-idle — no pane output for 100.0h (session host)'
    ])
  })

  it('a failed (null) listing kills nothing', async () => {
    const h = fakeHost([null])
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, sessionHost: () => h.backend })
    expect(await reaper.sweep()).toBe(0)
    expect(h.killed).toEqual([])
  })

  it('a listing that throws kills nothing and the sweep does not throw', async () => {
    const reaper = createSessionReaper({
      ...base,
      tmuxBin: () => null,
      sessionHost: () => ({
        list: async () => {
          throw new Error('host gone')
        },
        kill: async () => true
      })
    })
    expect(await reaper.sweep()).toBe(0)
  })

  it('re-verifies at kill time: attached, freshly active, vanished or unlistable sessions are spared', async () => {
    const planned = [hostRow('nt-a', 0, 100), hostRow('nt-b', 0, 100), hostRow('nt-c', 0, 100)]
    const fresh = [hostRow('nt-a', 1, 100), hostRow('nt-b', 0, 0)] // nt-c vanished
    const h = fakeHost([planned, fresh])
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, sessionHost: () => h.backend })
    expect(await reaper.sweep()).toBe(0)
    expect(h.killed).toEqual([])

    const unlistable = fakeHost([planned, null])
    const r2 = createSessionReaper({ ...base, tmuxBin: () => null, sessionHost: () => unlistable.backend })
    expect(await r2.sweep()).toBe(0)
    expect(unlistable.killed).toEqual([])
  })

  it('a kill the backend did not confirm is not counted', async () => {
    const reaper = createSessionReaper({
      ...base,
      tmuxBin: () => null,
      sessionHost: () => ({ list: async () => [hostRow('nt-a', 0, 100)], kill: async () => false })
    })
    expect(await reaper.sweep()).toBe(0)
  })

  it('without pressure and under the cap, nothing is planned (same budget rules as tmux)', async () => {
    const h = fakeHost([[hostRow('nt-idle', 0, 100)]])
    const reaper = createSessionReaper({
      ...base,
      readMem: () => ({ availableMb: 60_000, totalMb: 64_000 }),
      tmuxBin: () => null,
      sessionHost: () => h.backend
    })
    expect(await reaper.sweep()).toBe(0)
    expect(await reaper.sweep({ pressure: 'pty' })).toBe(1)
  })

  it('is never consulted while tmux exists, and the kill switch covers it too', async () => {
    let asked = 0
    const backend = () => {
      asked++
      return fakeHost([[hostRow('nt-idle', 0, 100)]]).backend
    }
    const w = fakeWorld({})
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec, sessionHost: backend })
    await reaper.sweep()
    expect(asked).toBe(0)
    const off = createSessionReaper({
      ...base,
      env: { NODETERM_SESSION_REAP_DISABLED: '1' },
      tmuxBin: () => null,
      sessionHost: backend
    })
    expect(await off.sweep()).toBe(0)
    expect(asked).toBe(0)
  })

  it('no backend (session host not in use) is the historical no-op', async () => {
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, sessionHost: () => undefined })
    expect(await reaper.sweep()).toBe(0)
  })
})
