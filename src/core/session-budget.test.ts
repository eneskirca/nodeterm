import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planReap,
  parseSessionList,
  sessionBudgetConfig,
  createSessionReaper,
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
  ...over
})

/** An nt- session idle for `idleH` hours, with `clients` attached (0 = detached). */
const idle = (name: string, idleH: number, clients = 0): SessionInfo => ({
  name,
  clients,
  activitySec: NOW - idleH * 3600
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

describe('parseSessionList', () => {
  it('parses names, CLIENT COUNTS and activity, skipping malformed lines', () => {
    const out = parseSessionList('nt-a|0|1753000000\nnt-b|2|1753000100\n\njunk\nx|y|z\n')
    expect(out).toEqual([
      { name: 'nt-a', clients: 0, activitySec: 1_753_000_000 },
      { name: 'nt-b', clients: 2, activitySec: 1_753_000_100 }
    ])
  })
})

describe('sessionBudgetConfig', () => {
  it('defaults: 10% of RAM watermark (floor 1GB), cap 48, grace 6h, batch 8', () => {
    const c = sessionBudgetConfig({}, 64_000)
    expect(c).toEqual({ disabled: false, minAvailableMb: 6400, maxDetached: 48, graceSec: 21_600, batchMax: 8 })
    expect(sessionBudgetConfig({}, 4000).minAvailableMb).toBe(1024)
  })

  it('env overrides win; junk values fall back', () => {
    const c = sessionBudgetConfig(
      {
        NODETERM_SESSION_MIN_AVAILABLE_MB: '3000',
        NODETERM_SESSION_MAX_DETACHED: 'garbage',
        NODETERM_SESSION_GRACE_HOURS: '12',
        NODETERM_SESSION_REAP_DISABLED: '1'
      },
      64_000
    )
    expect(c.minAvailableMb).toBe(3000)
    expect(c.maxDetached).toBe(48)
    expect(c.graceSec).toBe(43_200)
    expect(c.disabled).toBe(true)
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
      if (args[2] === 'list-sessions') {
        const lines = listings[socket]
        if (!lines) throw new Error('no server running')
        return lines.join('\n')
      }
      return '' // kill-session
    }
  }
}

const OLD = String(NOW - 100 * 3600)

describe('createSessionReaper (service)', () => {
  const base = {
    readMem: () => ({ availableMb: 100, totalMb: 64_000 }),
    env: {} as NodeJS.ProcessEnv,
    nowSec: () => NOW,
    log: () => {}
  }

  it('sweeps every socket, kills planned sessions on the right socket with exact-match targets', async () => {
    const w = fakeWorld({
      'node-terminal': [`nt-local|0|${OLD}`],
      'nodeterm-rmt': [`nt-remote|0|${OLD}`]
    })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(2)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([
      { args: ['-L', 'node-terminal', 'kill-session', '-t', '=nt-local'] },
      { args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-remote'] }
    ])
  })

  it('re-verifies at kill time: a session attached between plan and kill is spared', async () => {
    let first = true
    const w = fakeWorld({})
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'list-sessions' && args[1] === 'node-terminal') {
        if (first) {
          first = false
          return `nt-x|0|${OLD}`
        }
        return `nt-x|1|${OLD}` // now attached
      }
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })

  it('a socket whose listing fails contributes no candidates; the other socket still sweeps', async () => {
    const w = fakeWorld({ 'nodeterm-rmt': [`nt-r|0|${OLD}`] }) // node-terminal listing throws
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(1)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([{ args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-r'] }])
  })

  it('kill switch: disabled env runs no tmux commands at all', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
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
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, exec: w.exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls).toHaveLength(0)
  })

  it('a failing kill is tolerated and does not abort the rest of the batch', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-a|0|${OLD}`, `nt-b|0|${String(NOW - 99 * 3600)}`] })
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'kill-session' && args[4] === '=nt-a') throw new Error('gone already')
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(1) // nt-b still dies
  })

  it('healthy memory + under cap → lists but never kills', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
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
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
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
      'node-terminal': [`nt-watched|1|${OLD}`, `nt-fresh|0|${NOW - 60}`]
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
    activitySec: 1_000_000 - hoursAgo * 3600
  })

  it('culls NOTHING on memory grounds when the reader reports null', () => {
    // macOS: available BYTES is not the OS's pressure signal (measured: 82% used, 8.38 GB
    // compressed, macOS's own graph GREEN). hostMemReader returns null there, and null must mean
    // "no pressure signal", never "no memory". Absence of evidence may not cull a session.
    const sessions = Array.from({ length: 20 }, (_, i) => idle(`nt-old-${i}`, 48))
    const cfg = sessionBudgetConfig({}, 24576)
    expect(planReap(sessions, null, 1_000_000, cfg)).toEqual([])
  })

  it('still culls past the detached-count cap without any memory signal', () => {
    // The cap is not memory-based, so it survives — that is what keeps the reaper useful on macOS.
    const sessions = Array.from({ length: 60 }, (_, i) => idle(`nt-old-${i}`, 48))
    const cfg = sessionBudgetConfig({}, 24576)
    expect(planReap(sessions, null, 1_000_000, cfg).length).toBeGreaterThan(0)
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
      'node-terminal': Array.from({ length: 20 }, (_, i) => `nt-idle-${i}|0|${OLD}`)
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
  const cfg = (env: Record<string, string>) => sessionBudgetConfig(env, 24576)

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
