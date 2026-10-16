// Session budget: reap long-idle DETACHED nt- tmux sessions under memory pressure (or past a
// count cap), so abandoned agent sessions can't accumulate until the host swaps itself to death
// (field report: 95 sessions / 34 GB of idle claude processes on one host).
//
// This is the tmux counterpart of the renderer's WebGL budget (`terminal/webgl-budget.ts`), and it
// deliberately reuses that design's rules rather than inventing an expiry policy:
//   - a bounded budget, enforced only when exceeded — never a calendar-based expiry;
//   - eviction picks the LEAST-RECENTLY-ACTIVE holder — where ACTIVE means the pane last produced
//     OUTPUT. tmux's `#{session_activity}` looks like that number and is not: it is bumped by every
//     client ATTACH, and nodeterm attaches on every reconnect, so on a live host it never ages past
//     a few minutes. Gating on it made this whole module a no-op — measured, and worse than a
//     no-op: with a short grace it reaped the session that was printing and spared the abandoned
//     one. `SessionInfo.outputSec` (`#{window_activity}`) is the honest clock; see its doc.
//   - an ATTACHED session (someone is looking at it) is never evicted, exactly like a visible
//     WebGL holder; a recently-active one is protected by a grace window (the release delay).
//     "Attached" means a WATCHER: this app's own control-mode shadows are tmux clients too, and
//     they are subtracted from tmux's flag via the `shadowed` seam — see SessionReaperOpts;
//   - reaping is gradual (per-sweep batch), so one sweep can never mass-kill its way past the
//     target — the next sweep re-evaluates.
//
// Killing a detached session is safe BECAUSE of the cold-restore contract: to the node, a reap is
// indistinguishable from a machine reboot. On next open `tmux has-session` fails → fresh=true →
// the renderer replays the scrollback snapshot and re-launches a resumable agent
// (`claude --resume …`). For that to hold, the reaper must kill ONLY the tmux session: it must
// never delete scrollback snapshots and never write a pty-manager tombstone (both belong to the
// user-deletes-the-node path, `destroySession`).
//
// Electron-free (src/core): all exec/mem/clock access is behind injectable seams (template:
// ack-sweep.ts), so both shells boot it and tests drive it without touching tmux.
//
// Windows has no tmux: there the same budget runs over the session host's own listing
// (`SessionReaperOpts.sessionHost`) — same plan, same rules, a generation-checked kill.

import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'
import { readMemInfo, type MemInfo } from './session-memory'

const runAsync = promisify(execFile)

// One definition, two consumers (the reaper's watermark and the system-resource pill): a copied
// second reader would let them disagree about how much RAM is free.
export { readMemInfo, type MemInfo } from './session-memory'

/** One tmux session, reduced from `list-windows -a`. All stamps are epoch seconds. */
export interface SessionInfo {
  name: string
  /**
   * How many clients tmux reports attached. A COUNT, not a flag: `#{session_attached}` is the
   * number of clients, and one session can have several — the app's painter, the user's own `tmux
   * -L node-terminal attach`, a second nodeterm process on the same socket, one of our
   * control-mode shadows.
   *
   * Carried numerically rather than collapsed to a boolean at parse time because the `shadowed`
   * seam SUBTRACTS: a session holding our shadow AND a real client must still read as attached,
   * and a boolean can only be forced to false — which would reap the session out from under
   * whoever the other client belongs to.
   */
  clients: number
  /**
   * `#{session_activity}`. **Kept for exactly two consumers — the kill log's second clock (so an
   * operator cross-checking `tmux ls` sees why tmux disagrees) and the test suite's two-clock pin —
   * it is not an idleness signal, and this module must never gate a kill on it again.**
   *
   * MEASURED on this host, 2026-08-15, on a private throwaway socket (a real socket was never
   * swept): tmux bumps `session_activity` to `now` every time a CLIENT ATTACHES, with no pane
   * output involved. A control-mode `-C attach-session` moved it 1786793595 → 1786793620; a pty
   * attach moved it again to 1786793787; `#{window_activity}` did not move for either. Pure reads —
   * `capture-pane`, `list-panes`, `list-sessions`, `display-message`, `has-session` — moved
   * neither, and neither did `resize-window`.
   *
   * nodeterm attaches constantly: every painter is a `tmux new-session -A -s nt-<node>`, which
   * ATTACHES when the session already exists, and a desktop reconnecting over SSH does it to every
   * session at once (measured: one sshd holding 49 pts clients, all `client_created` identical).
   * So on a live host this stamp measures WHEN NODETERM LAST LOOKED, not when the agent last did
   * anything. Across 67 nt- sessions the oldest `session_activity` was 33 MINUTES while the oldest
   * `window_activity` was 37 HOURS, and one session read 469 s on this clock against 133 513 s on
   * the honest one.
   */
  activitySec: number
  /**
   * **The idleness signal: when a pane in this session last actually produced output.**
   *
   * The max `#{window_activity}` across the session's windows (a session can have several, and the
   * most recently active one is what "this session is idle" has to mean). Unlike `activitySec`,
   * nothing nodeterm does to LOOK at a session moves it — verified against attach, detach, resize
   * and every read above — so it answers the question the grace window is actually asking.
   */
  outputSec: number
}

export interface SessionBudgetConfig {
  /** Kill switch (`NODETERM_SESSION_REAP_DISABLED=1`): sweeps become no-ops. */
  disabled: boolean
  /** Watermark: reap only while host available memory is BELOW this (primary trigger). */
  minAvailableMb: number
  /** Backstop: max detached nt- sessions across sockets; excess is reaped even without pressure. */
  maxDetached: number
  /**
   * Swap term: pressure when the free fraction of swap falls to or below this AND available memory
   * is at or below `swapAvailRatio` of total. `0` disables the term.
   */
  swapFreeRatio: number
  /** The available-memory half of the swap term (see `hostUnderMemoryPressure`). */
  swapAvailRatio: number
  /** PSI term: pressure when `/proc/pressure/memory` `full avg60` reaches this. `0` disables it. */
  psiFullAvg60: number
  /** A session whose pane produced OUTPUT more recently than this is never reaped (protects
   *  same-day project switches). Measured against `SessionInfo.outputSec`, never `activitySec`. */
  graceSec: number
  /** Max kills per sweep — convergence is gradual and re-evaluated each sweep. */
  batchMax: number
}

/**
 * A positive INTEGER from the environment, or the fallback.
 *
 * The floor is `>= 1`, not `> 0`, and that is the whole point: `Math.floor(0.5)` is 0, and a zero
 * here is not a smaller setting — it is the REMOVAL of a safety. `MAX_DETACHED=0.5` became a cap of
 * zero, so every detached session counted as over-cap and a full batch died every sweep;
 * `GRACE_HOURS=0.5` became zero grace, so a session was reapable the moment it detached.
 *
 * The asymmetry is what makes it dangerous rather than merely wrong: `abc`, `''` and `0` all fall
 * back to the safe default, while `0.5` — the most PLAUSIBLE thing an operator would type, meaning
 * "half" — silently disarmed the guard. A hand-editable value must degrade to the safe default,
 * never to something more destructive than the default.
 *
 * Sub-hour grace is a legitimate wish, so it is served properly by `envHours` rather than being
 * floored into nothing.
 */
function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key])
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** Hours as a possibly-FRACTIONAL positive number, returned in seconds. `0.5` means 30 minutes —
 *  the reading the operator intended — instead of `Math.floor`-ing to no grace at all. */
function envHours(env: NodeJS.ProcessEnv, key: string, fallbackHours: number): number {
  const n = Number(env[key])
  return Math.round((Number.isFinite(n) && n > 0 ? n : fallbackHours) * 3600)
}

/**
 * A NOMINAL agent session's cost, in MB of process-tree RSS. Not a limit and not a prediction of
 * any one session — purely the divisor that turns "a share of this host's RAM" into "a number of
 * sessions". MEASURED on the 62.7 GB production host, 2026-08-15: 67 live `nt-` sessions on root's
 * `nodeterm-rmt` socket held 32 877 MB of tree RSS, a mean of 491 MB (the module header's older
 * field note — ~335 MB for the CLI plus 30-200 MB of MCP children — brackets the same figure).
 */
export const NOMINAL_SESSION_MB = 491

/**
 * The share of HOST memory one instance may hold in detached sessions before its count backstop
 * starts trimming. See `sessionBudgetConfig` for why this is a per-instance share of a host number
 * and not a host-wide count.
 */
export const HOST_SHARE = 0.25

/** Floor and ceiling for the derived cap. The ceiling is the historical constant, so this change
 *  can only ever LOWER a cap, never raise one; the floor keeps a small host usable. */
export const MAX_DETACHED_FLOOR = 8
export const MAX_DETACHED_CEILING = 48

/**
 * Defaults, overridable per host via env (systemd `Environment=` lines):
 *   NODETERM_SESSION_MIN_AVAILABLE_MB  (default: 10% of total RAM, floor 1 GB)
 *   NODETERM_SESSION_MAX_DETACHED     (default: derived from host RAM, see below; 48 with no reading)
 *   NODETERM_SESSION_GRACE_HOURS      (default: 6)
 *   NODETERM_SESSION_REAP_BATCH       (default: 8)
 *   NODETERM_SESSION_SWAP_FREE_PCT    (default: 20 — the swap term; 0 disables)
 *   NODETERM_SESSION_PSI_FULL_AVG60   (default: 10 — the PSI term; 0 disables)
 *   NODETERM_SESSION_REAP_DISABLED=1  (kill switch)
 *
 * ── WHY THE DETACHED CAP IS A HOST-SCALED PER-INSTANCE NUMBER, NOT A HOST-WIDE COUNT ────────────
 *
 * The cap used to be the constant 48, and on a shared host that is a cap on nothing: each nodeterm
 * instance runs as its own uid and sees only its own tmux socket, so seven instances each sat one
 * session under their own 48 while the machine drowned. The obvious fix — count the host's sessions
 * instead of ours — was MEASURED and is not available:
 *
 *   - the per-uid socket dirs are 0700 (`/tmp/tmux-1002` is `drwx------ projects`), and a second
 *     uid attempting to list one gets `Permission denied`;
 *   - `/proc` is mounted `hidepid=invisible`, so a non-root uid cannot even SEE another user's
 *     processes — user `projects` counted 62 processes host-wide and 62 of its own.
 *
 * So no instance can enumerate, or even detect, another instance's sessions. A truly host-wide
 * COUNT is unreachable without a shared broker, and inventing one is a much larger change than
 * this. What every uid CAN read — verified as an unprivileged user on the same host — is
 * `/proc/meminfo` and `/proc/pressure/memory`. **The host-wide facts are the MEMORY facts, so the
 * host-aware trigger is the memory one (`hostUnderMemoryPressure`), and that is the load-bearing
 * half of this change.** Every instance sees the same pressure at the same moment and each trims
 * its own sessions, which converges without any of them seeing the others.
 *
 * The count cap is then demoted to what it honestly is: a per-instance sanity backstop. It still
 * stops being a constant, because a constant is wrong in the other direction too — 48 detached
 * agent sessions is ~23 GB of nominal RSS, which is most of a 32 GB laptop and all of a 16 GB one.
 * Derived instead as `HOST_SHARE` of host RAM divided by `NOMINAL_SESSION_MB`, clamped to
 * [8, 48]. On the 62.7 GB host that is 32 (down from 48); on a 24 GB Mac it would be 12, which is
 * exactly why it is NOT derived when there is no host reading — see the `mem === null` case below.
 *
 * Seven instances at 25% each over-subscribe the machine, and that is deliberate rather than
 * overlooked: an instance cannot know how many peers it has, and a share small enough to be safe
 * with seven would cripple the single-user desktop that is the common case. Over-subscription is
 * safe here precisely BECAUSE the memory term is host-wide — the backstop may be loose, because it
 * is not the thing standing between this host and a swap-thrash lockup.
 *
 * `mem === null` (darwin, or an unreadable /proc) keeps the historical 48. The count cap needs no
 * memory reading to work, so deriving it from `os.totalmem()` would quietly change reaping
 * behaviour on macOS — a cap of 12 on a 24 GB Mac — off a host figure whose meaning there this
 * module has already been burned by twice (see `hostMemReader`). A platform gets a new default
 * when it has been measured, not when a number happens to be available.
 */
export function sessionBudgetConfig(
  env: NodeJS.ProcessEnv,
  mem: MemInfo | null,
  fallbackTotalMb: number
): SessionBudgetConfig {
  const totalMb = mem?.totalMb ?? fallbackTotalMb
  const derivedCap =
    mem === null
      ? MAX_DETACHED_CEILING
      : Math.min(
          MAX_DETACHED_CEILING,
          Math.max(MAX_DETACHED_FLOOR, Math.round((totalMb * HOST_SHARE) / NOMINAL_SESSION_MB))
        )
  return {
    disabled: env.NODETERM_SESSION_REAP_DISABLED === '1' || env.NODETERM_SESSION_REAP_DISABLED === 'true',
    minAvailableMb: envInt(env, 'NODETERM_SESSION_MIN_AVAILABLE_MB', Math.max(1024, Math.round(totalMb * 0.1))),
    maxDetached: envInt(env, 'NODETERM_SESSION_MAX_DETACHED', derivedCap),
    graceSec: envHours(env, 'NODETERM_SESSION_GRACE_HOURS', 6),
    batchMax: envInt(env, 'NODETERM_SESSION_REAP_BATCH', 8),
    // Percentages, so `envInt`'s `>= 1` floor is not the trap it is for a cap: 0 and junk both fall
    // back to the default, and an operator who wants the term OFF sets the ratio via a value the
    // clamp below turns into 0 — `NODETERM_SESSION_SWAP_FREE_PCT=100` can never be satisfied.
    swapFreeRatio: envInt(env, 'NODETERM_SESSION_SWAP_FREE_PCT', 20) / 100,
    swapAvailRatio: 0.25,
    psiFullAvg60: envInt(env, 'NODETERM_SESSION_PSI_FULL_AVG60', 10)
  }
}

/**
 * Is the HOST under memory pressure? Three OR'd terms, each of which independently means "there is
 * no headroom left". A term whose inputs are absent contributes NOTHING — absence of evidence is
 * never pressure, which is this module's standing rule and the reason darwin stays quiet.
 *
 *  1. **Available memory below the watermark.** The original term, unchanged.
 *
 *  2. **Swap spent AND available memory low.** `MemAvailable` alone is blind to a host that has
 *     already burned its overflow reserve. MEASURED on the production host: 10.5 GB available
 *     (16.7%) with 84% of swap consumed — comfortably above a 10%-of-RAM watermark, and the same
 *     shape as the 2026-08-03 swap-thrash lockup. BOTH halves are required because either alone is
 *     benign: a host can fill swap with cold pages and be perfectly healthy, and a host can run at
 *     20% available with swap untouched and be perfectly healthy. Together they mean the primary
 *     pool is low and the reserve behind it is gone.
 *
 *  3. **PSI `full avg60`.** The kernel's own answer to "is this machine thrashing", and the only
 *     term that measures a CONSEQUENCE rather than a level. `full` (every task stalled) rather than
 *     `some` (at least one), because `some` is routinely non-zero on a busy, healthy host.
 *
 * Fail-open direction, stated per input: a missing `mem` is not pressure; a missing swap pair is
 * not pressure; a missing or unparsed PSI figure is not pressure; `swapTotalMb === 0` (no swap
 * configured) is not pressure. Every one of those makes the reaper do LESS, which is the safe
 * direction here — a reaper that kills a session someone is using is far worse than one that
 * misses a candidate.
 */
export function hostUnderMemoryPressure(mem: MemInfo | null, cfg: SessionBudgetConfig): boolean {
  if (mem === null) return false
  if (mem.availableMb < cfg.minAvailableMb) return true

  const { swapTotalMb, swapFreeMb, psiFullAvg60 } = mem
  if (
    cfg.swapFreeRatio > 0 &&
    swapTotalMb !== undefined &&
    swapFreeMb !== undefined &&
    swapTotalMb > 0 &&
    swapFreeMb / swapTotalMb <= cfg.swapFreeRatio &&
    mem.totalMb > 0 &&
    mem.availableMb / mem.totalMb <= cfg.swapAvailRatio
  ) {
    return true
  }

  if (cfg.psiFullAvg60 > 0 && psiFullAvg60 !== undefined && psiFullAvg60 >= cfg.psiFullAvg60) {
    return true
  }
  return false
}

/**
 * Pure policy: which sessions to kill this sweep, least-recently-ACTIVE first — where "active"
 * means the session's pane last PRODUCED OUTPUT (`outputSec`), not the moment nodeterm last
 * attached a client to it (`activitySec`). See `SessionInfo.activitySec` for the measurement that
 * forced the distinction; the short version is that on a live host the old clock never reads older
 * than about half an hour, so no grace window could ever elapse and this function returned an
 * empty plan on a host that was 84% into its swap.
 *
 * A deliberate trade-off rides on that clock: PASSIVELY VIEWING a session no longer protects it.
 * Attaching and reading a pane without pressing a key moves neither `window_activity` (measured —
 * attach does not bump it) nor, therefore, `outputSec`, so a long-silent session someone glanced at
 * an hour ago is still eligible. Accepted because the exposure is narrow — an ATTACHED session is
 * never eligible at all, a single keystroke's echo restamps the clock, and the grace window still
 * applies — and because the alternative is the attach clock this module just stopped trusting.
 *
 * Eligible = named `nt-*` AND detached AND silent past the grace window. Then:
 *   - memory below the watermark → up to `batchMax` (a failed memory read — `mem === null` — is
 *     NOT pressure: absence of evidence never triggers the primary path);
 *   - `externalPressure` → the same allowance, for a resource this module cannot measure (today:
 *     pty devices — see core/pty-pressure.ts). It exists because the 2026-08-11 host had HEALTHY
 *     memory and sat well under `maxDetached` while being unable to open a single terminal, so
 *     every term above was zero and the sweep the shell fired was a no-op;
 *   - detached count over `maxDetached` → the excess, even with healthy memory;
 * combined take is bounded by `batchMax`.
 *
 * An allowance is not an exemption: `externalPressure` raises how MANY of the eligible may go, and
 * touches nothing about which sessions are eligible. Attached sessions and sessions inside the
 * grace window stay unkillable under it, exactly as under memory pressure — that is this module's
 * one hard rule and no caller gets to spend it.
 */
export function planReap(
  sessions: SessionInfo[],
  mem: MemInfo | null,
  nowSec: number,
  cfg: SessionBudgetConfig,
  externalPressure = false
): string[] {
  if (cfg.disabled) return []
  const nt = sessions.filter((s) => s.name.startsWith('nt-'))
  const detached = nt.filter((s) => s.clients === 0)
  const eligible = detached
    .filter((s) => nowSec - s.outputSec >= cfg.graceSec)
    .sort((a, b) => a.outputSec - b.outputSec)

  const lowMem = hostUnderMemoryPressure(mem, cfg)
  const pressure = lowMem || externalPressure ? cfg.batchMax : 0
  const overCap = Math.max(0, detached.length - cfg.maxDetached)
  const take = Math.min(cfg.batchMax, Math.max(pressure, overCap))
  return eligible.slice(0, take).map((s) => s.name)
}

/**
 * Parse `list-windows -a -F '<LIST_FMT>'` into one row PER SESSION.
 *
 * The listing is per WINDOW because `#{window_activity}` — the only stamp that tracks real pane
 * output — has no session-scope equivalent; `list-sessions` cannot answer the question this module
 * asks. Session-scope fields (`#{session_name}`, `#{session_attached}`, `#{session_activity}`)
 * resolve fine in window scope, verified against tmux on this host, so one listing still carries
 * everything.
 *
 * A session's windows are reduced with `Math.max` on `window_activity`: a session is silent only
 * when ALL of its windows are, and taking the first or the last would call a session with one busy
 * window and one idle one whatever its window ORDER happened to be. Verified against a two-window
 * session whose windows carried distinct stamps.
 *
 * Tolerant in the same direction as before — a malformed line is skipped, never thrown on — and
 * that tolerance is a safety property here: a session whose rows all fail to parse is absent from
 * the result entirely, so it can never become a kill candidate.
 */
export function parseSessionList(stdout: string): SessionInfo[] {
  const bySession = new Map<string, SessionInfo>()
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length !== 4) continue
    const attached = Number(parts[1])
    const activity = Number(parts[2])
    const output = Number(parts[3])
    if (!parts[0] || !Number.isFinite(attached) || !Number.isFinite(activity) || !Number.isFinite(output)) {
      continue
    }
    const prev = bySession.get(parts[0])
    if (prev) {
      // Most recent output across the session's windows wins; the session-scope fields are
      // identical on every row of the same session, so only this one needs reducing.
      if (output > prev.outputSec) prev.outputSec = output
      continue
    }
    bySession.set(parts[0], {
      name: parts[0],
      clients: Math.max(0, attached),
      activitySec: activity,
      outputSec: output
    })
  }
  return [...bySession.values()]
}

/**
 * The DEFAULT host-memory reader — still silent on **darwin**, but no longer for the reason this
 * comment used to give.
 *
 * The original reason was that `readMemInfo` fell back to `os.freemem()` off Linux, which on darwin
 * counts only genuinely free pages — excluding inactive, purgeable and compressor pages, all of
 * which macOS hands back on demand. A healthy Mac idles at a few hundred MB "free", under BOTH
 * watermarks, so this monitor would have sat permanently CRITICAL on the primary desktop platform.
 * (The same reading had the session reaper culling idle detached sessions on every sweep — a
 * confirmed field symptom, reported as "my sessions keep disappearing".)
 *
 * That instrument is fixed: `readMemInfo` now reads `vm_stat` on darwin, VERIFIED on a real 24 GB
 * Mac (2026-08-12) — Activity Monitor's App 7.67 + Wired 2.95 + Compressed 8.38 = 19.00 GB against
 * our 19.1 GB, where the same machine read 23.9/24.0 before. So the REAPER's watermark is honest
 * there now, which is what closed the bug.
 *
 * **This leg stays silent anyway, and the verification is what sharpened the reason.** Available
 * BYTES is not macOS's pressure signal. That same capture had the machine at 82% used with 8.38 GB
 * compressed and 1.77 GB of swap in use — and macOS's own Memory Pressure graph was GREEN. A
 * watermark at 10%/5% available therefore fires in states the OS itself calls healthy, and the
 * critical one sweeps the reaper: we would cull sessions on a machine macOS says is fine. That is
 * the same class of mistake as the bug this started with, reached from the other direction.
 *
 * Follow-up (unchanged in shape, sharper in target): give this leg macOS's REAL pressure signal —
 * `kern.memorystatus_vm_pressure_level`, or the `memory_pressure` tool — rather than a byte count.
 */
export function hostMemReader(platform: NodeJS.Platform = process.platform): () => MemInfo | null {
  return platform === 'darwin' ? (): null => null : readMemInfo
}

/**
 * The Windows session host (or any machine with no tmux, where PtyManager runs sessions under it)
 * as a reaper backend — the same two questions the tmux leg asks with `list-windows` and
 * `kill-session`. `PtyManager.sessionHostReaperBackend()` supplies it.
 *
 * `list()` answers with SessionInfo rows whose `clients` is the host's SUBSCRIBER count and whose
 * `outputSec` is the host's last-output stamp (its `window_activity`); `null` is a failed or
 * undescribable listing (an older host that names sessions without describing them), and yields NO
 * candidates — never "everything is detached". `kill(name)` ends exactly the generation the most
 * recent `list()` observed, and resolves true only when the host acknowledged the kill.
 */
export interface SessionHostReaperBackend {
  list(): Promise<SessionInfo[] | null>
  kill(name: string): Promise<boolean>
}

export interface SessionReaperOpts {
  /** Lazy tmux binary resolver (PtyManager resolves after init; null = tmux unavailable → no-op). */
  tmuxBin: () => string | null
  /** tmux sockets to sweep. Default: the local socket + the SSH-remote socket — a host that serves
   *  SSH projects accumulates sessions on `nodeterm-rmt`, and its own nodeterm-server (this
   *  process) is the natural owner of reaping them; the desktops that spawned them may be gone. */
  sockets?: string[]
  /**
   * The tmux sessions THIS process holds a control-mode client on, per socket — a per-session
   * shadow or the shared background-write client (see `PtyManager.shadowedTmuxSessions`). Each name
   * listed has exactly ONE client SUBTRACTED FROM ITS COUNT, in the plan AND in the kill-time
   * re-verify; anything left over is somebody else's client and keeps its exemption.
   *
   * A control client is a real tmux client, so a held `-C attach` puts this process into
   * `#{session_attached}` — and an attached session is never evicted here. Without this hook,
   * attaching one (something no user asked for and nobody is watching) would make a session
   * permanently exempt from the memory-pressure safety valve this whole module exists to be. It is
   * not a watcher: the session may be reaped under it exactly as if nothing were attached, and the
   * client dies with the session it was attached to.
   *
   * SUBTRACT, never force-detach — `#{session_attached}` is a client COUNT, not a flag. A session
   * holding ours PLUS a real one (the user's own `tmux attach`, a second nodeterm process on this
   * socket) must stay exempt, or the budget kills a session out from under a live user. That is
   * this module's one hard rule, and forcing the state inverts it.
   *
   * At most one of ours per name: PtyManager retires the shared client before shadowing the session
   * it is attached to, so nothing here ever owes a subtraction of two.
   *
   * Per SOCKET, not per name: `nt-<node>` is only unique within a socket, and a genuinely attached
   * session of the same name on `nodeterm-rmt` must keep its exemption.
   */
  shadowed?: (socket: string) => Iterable<string>
  /**
   * The session-host leg, consulted ONLY when `tmuxBin()` is null — which is exactly when
   * PtyManager runs persistent sessions under the session host (Windows). Lazy, like `tmuxBin`:
   * PtyManager decides after init whether the host is this machine's backend, and answers
   * `undefined` when it is not. The tmux leg never reads it, so a tmux machine's sweep is unchanged.
   *
   * No `shadowed`-style subtraction is owed here: the session host has no control-mode shadows —
   * background writes (`sendKeys`) need no subscription — so every subscriber is a real viewer.
   */
  sessionHost?: () => SessionHostReaperBackend | undefined
  exec?: (bin: string, args: string[]) => Promise<string>
  readMem?: () => MemInfo | null
  env?: NodeJS.ProcessEnv
  nowSec?: () => number
  intervalMs?: number
  log?: (msg: string) => void
}

/**
 * A resource OUTSIDE this module's instruments that is exhausted right now, named by the shell
 * that measured it. Today only pty devices (`kern.tty.ptmx_max`, core/pty-pressure.ts).
 */
export type SweepPressure = 'pty'

export interface SweepOptions {
  /** Grant this sweep the same allowance low memory would. Omitted ⇒ ordinary budget semantics. */
  pressure?: SweepPressure
}

export interface SessionReaper {
  /** One sweep; resolves to the number of sessions killed. Never throws. */
  sweep(opts?: SweepOptions): Promise<number>
  start(): void
  stop(): void
}

export const SESSION_SWEEP_INTERVAL_MS = 10 * 60_000

/**
 * Periodic reaper over the injectable seams. Failure rules (CLAUDE.md: a failed read is never
 * evidence of absence): a socket whose `list-sessions` fails contributes NO candidates — only a
 * successful listing can put a session on the kill list, and the kill is re-verified against a
 * FRESH listing at kill time (a session that got attached between plan and kill is spared).
 */
export function createSessionReaper(opts: SessionReaperOpts): SessionReaper {
  const sockets = opts.sockets ?? [TMUX_SOCKET, RMT_TMUX_SOCKET]
  const exec =
    opts.exec ??
    (async (bin: string, args: string[]): Promise<string> => {
      const { stdout } = await runAsync(bin, args, { timeout: 15_000 })
      return stdout
    })
  // Platform-aware BY DEFAULT — not injected by the shells. A wiring line can be deleted with
  // the suite green (measured); a default cannot. See hostMemReader for why darwin is silent.
  const readMem = opts.readMem ?? hostMemReader()
  const env = opts.env ?? process.env
  const nowSec = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000))
  const log = opts.log ?? ((m: string): void => console.log(m))
  // `mem`, not `mem.totalMb`: the detached cap is derived only where there is a real host reading,
  // so the null case (darwin) has to reach sessionBudgetConfig as null rather than as a number.
  const cfg = sessionBudgetConfig(env, readMem(), Math.round(os.totalmem() / 1048576))

  // `list-windows -a`, not `list-sessions`: `#{window_activity}` is the only stamp that tracks
  // real pane output, and it has no session-scope form. See parseSessionList.
  const LIST_FMT = '#{session_name}|#{session_attached}|#{session_activity}|#{window_activity}'

  const listSocket = async (bin: string, socket: string): Promise<SessionInfo[] | null> => {
    try {
      const listed = parseSessionList(await exec(bin, ['-L', socket, 'list-windows', '-a', '-F', LIST_FMT]))
      // Our own shadows are subtracted from tmux's client COUNT here, at the one place every
      // listing comes through, so the plan and the kill-time re-verify can never disagree about it
      // (a shadow attached between the two would otherwise resurrect the exemption). Re-read each
      // time: the set changes as sessions are shadowed and swapped back to painters.
      //
      // Minus ONE client, never "detached": this app holds at most one shadow per session, and
      // anything left over is somebody else's client — the user's own `tmux attach`, another
      // nodeterm process on this socket — whose session must keep the exemption. Forcing the flag
      // false here would reap a session out from under a live user.
      const shadowed = new Set(opts.shadowed?.(socket) ?? [])
      if (shadowed.size === 0) return listed
      return listed.map((s) =>
        s.clients > 0 && shadowed.has(s.name) ? { ...s, clients: s.clients - 1 } : s
      )
    } catch {
      // "no server running" and a real failure both land here; neither yields candidates.
      return null
    }
  }

  const listHost = async (backend: SessionHostReaperBackend): Promise<SessionInfo[] | null> => {
    try {
      return await backend.list()
    } catch {
      return null
    }
  }

  /**
   * The session-host leg: the SAME `planReap` and the same kill-time re-verify as tmux, over the
   * host's own listing. The re-verify is one notch stricter than the tmux leg's — a session that
   * produced output between plan and kill is spared too, not only one that got a viewer — because
   * the host's clock is cheap to re-read and a reaper that kills a session someone is using is far
   * worse than one that waits a sweep.
   */
  const sweepSessionHost = async (sweepOpts?: SweepOptions): Promise<number> => {
    const backend = opts.sessionHost?.()
    if (!backend) return 0
    const listed = await listHost(backend)
    if (!listed) return 0
    const now = nowSec()
    const plan = planReap(listed, readMem(), now, cfg, sweepOpts?.pressure !== undefined)
    if (plan.length === 0) return 0
    const fresh = await listHost(backend)
    if (!fresh) return 0
    const reapable = new Map(
      fresh
        .filter((s) => s.clients === 0 && now - s.outputSec >= cfg.graceSec)
        .map((s) => [s.name, s])
    )
    let killed = 0
    for (const name of plan) {
      const row = reapable.get(name)
      if (!row) continue
      try {
        if (!(await backend.kill(name))) continue
        killed++
        log(
          `[session-budget] reaped detached session ${name} — no pane output for ${((now - row.outputSec) / 3600).toFixed(1)}h (session host)`
        )
      } catch {
        // A vanished-in-between session or a kill failure changes nothing; next sweep re-plans.
      }
    }
    return killed
  }

  const sweep = async (sweepOpts?: SweepOptions): Promise<number> => {
    if (cfg.disabled) return 0
    const bin = opts.tmuxBin()
    if (!bin) return sweepSessionHost(sweepOpts)

    const bySocket = new Map<string, SessionInfo[]>()
    for (const s of sockets) {
      const listed = await listSocket(bin, s)
      if (listed) bySocket.set(s, listed)
    }
    if (bySocket.size === 0) return 0

    const all = [...bySocket.entries()].flatMap(([, list]) => list)
    const now = nowSec()
    const plan = new Set(planReap(all, readMem(), now, cfg, sweepOpts?.pressure !== undefined))
    if (plan.size === 0) return 0
    const h = (sec: number): string => ((now - sec) / 3600).toFixed(1)
    const clocks = new Map(all.map((s) => [s.name, `no pane output for ${h(s.outputSec)}h; last attach ${h(s.activitySec)}h ago`]))

    let killed = 0
    for (const [socket, listed] of bySocket) {
      const names = listed.filter((s) => plan.has(s.name)).map((s) => s.name)
      if (names.length === 0) continue
      // Kill-time re-verify on a FRESH list: only sessions still present and still detached die.
      const fresh = await listSocket(bin, socket)
      if (!fresh) continue
      const stillDetached = new Set(fresh.filter((s) => s.clients === 0).map((s) => s.name))
      for (const name of names) {
        if (!stillDetached.has(name)) continue
        try {
          // `=` forces an exact target match — never tmux's prefix matching.
          await exec(bin, ['-L', socket, 'kill-session', '-t', `=${name}`])
          killed++
          // The silence is what justified the kill, so it leads — and the attach clock rides along
          // BECAUSE it disagrees: an operator cross-checking `tmux ls` sees `session_activity`
          // minutes old and would otherwise read this reap as a bug. Naming both clocks puts the
          // discrepancy, and the reason for it, in the line they will actually be looking at.
          log(
            `[session-budget] reaped detached session ${name} — ${clocks.get(name) ?? 'clocks unknown'} (socket ${socket})`
          )
        } catch {
          // A vanished-in-between session or a kill failure changes nothing; next sweep re-plans.
        }
      }
    }
    return killed
  }

  let timer: ReturnType<typeof setInterval> | null = null
  return {
    sweep,
    start(): void {
      if (timer) return
      timer = setInterval(() => void sweep(), opts.intervalMs ?? SESSION_SWEEP_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
