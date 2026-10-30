/**
 * The free-tier open-project limit, desktop core (docs/superpowers/specs/2026-10-29-free-tier-project-limit-design.md
 * §5–§6). It decides whether the limit is on for this install and what its allowance is, and it
 * makes the claim. The renderer's gate asks for that state (`decideOpen` in shared/project-limit.ts)
 * and claims only when it has to. Desktop only: the Server Edition never calls `initProjectLimit`
 * (its bridge answers `INACTIVE_PROJECT_LIMIT`).
 *
 * ON OR OFF. `active` = a packaged build AND (the latch OR the embedded deadline has passed by the
 * clock anchor, with no server "off" in the last `OFF_TRUST_MS`). Dev builds are never active.
 * - The latch is the server's word. A check answer with `limits` sets it; a successful check
 *   without them, or a claim answering `not_active`, clears it. Nothing else does: a failed check
 *   gives no answer at all (check.ts `onCheckAnswer`), so being unreachable never turns it off.
 * - The deadline is compared against `clockAnchorMs()` (license.ts: the later of the wall clock and
 *   the largest instant this install has observed), so rolling the clock back cannot move an install
 *   from past the deadline to before it.
 * - An "off" (`offAt`) suppresses the deadline for 24 h. A check that keeps saying off refreshes it.
 *
 * THE ALLOWANCE comes from a server-signed token, verified offline on every `state()`: signature
 * (the separate allowance key), `typ`, deviceId, epoch, and the MACHINE hash. The machine is judged
 * only against a hash that came from a SUCCESSFUL OS read (machine-id.ts `fromOs`), which `state()`
 * cannot wait for. So when a token is stored (never on a dormant install) init starts that read in
 * the background; until it lands, or if the OS read fails and only the hostname fallback is known,
 * the token is trusted provisionally on everything but the machine. A slow or failed boot-time read
 * must never drop a legacy user to FREE and push them into a claim (which could rebind their
 * allowance to the wrong hash). Once an OS hash is known the machine check applies. A successful
 * claim also caches the hash it sent, if that one came from the OS.
 *
 * CLAIMS are lazy and never reject: one request shared by concurrent callers, an 8 s timeout over
 * the whole request including the body, and every failure folded into a `ClaimError`. While the
 * limit is off a claim asks nobody (no request, no machine read), whoever calls it.
 *
 * `projectLimit:changed` goes to THIS machine's windows only, through the shell's `notify`. Never
 * `platform().broadcast`: on the desktop that fans out to every relay peer, and this state carries
 * the host's Pro and DO_NOT_TRACK facts (see HOST_ONLY_CHANNEL_PREFIXES for the inbound half).
 * It is pushed whenever the state differs from the last one sent: after a server word, and on the
 * 6 h tick for what time alone changes (the deadline passing, an "off" going stale, Pro's grace
 * lapsing) — otherwise a long-running app would stay dormant past the deadline until a restart.
 *
 * PERSISTENCE: `<userData>/project-limit.json`, written through `writeFileAtomic`, only when
 * something changed. A missing, unparsable or hand-edited file never throws: each wrong-typed
 * field is dropped on its own.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { platform } from './platform'
import { IPC } from '../shared/ipc'
import {
  PROJECT_LIMIT_DEADLINE_MS,
  PROJECT_LIMIT_DEFAULT_FREE,
  type ClaimError,
  type ClaimResult,
  type ProjectLimitState
} from '../shared/project-limit'
import { clockAnchorMs, isDntEnv, licenseNetworkGate, proForProjectLimit } from './license'
import { getDeviceId } from './device-id'
import { fetchCheck, onCheckAnswer, type LimitsAnswer } from './check'
import { verifyAllowanceToken } from './project-allowance-token'
import { writeFileAtomic } from './fs-atomic'
import type { MachineHashResult } from './machine-id'

// The same base license.ts and check.ts use (a local server via NODETERM_API_BASE in development).
const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

/** How long a server "off" keeps the embedded deadline from switching the limit on. */
export const OFF_TRUST_MS = 24 * 60 * 60 * 1000
/** The whole claim request, body included (see license.ts REQUEST_TIMEOUT_MS for why the body). */
const CLAIM_TIMEOUT_MS = 8000
/** The check feed is re-read on this cadence; it is cached, so it adds no traffic of its own. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** The server's own bounds: FREE in 1..1000 (check.ts), a first-launch count in 0..10000 (claim
 *  route — anything larger is a 400, which would fail every claim). */
const FREE_MAX = 1000
const COUNT_MAX = 10_000

/** `<userData>/project-limit.json`. Every field is optional; see `load` for how each is read. */
interface Stored {
  latched?: boolean
  offAt?: number
  free?: number
  epoch?: number
  token?: string
  firstLaunchOpenCount?: number
}

export interface ProjectLimitDeps {
  /** `WorkspaceStore.openProjectCount` — undefined = unknown, never recorded or sent as 0. */
  openProjects: () => number | undefined
  /** `readMachineHashResult` (machine-id.ts). Read lazily: only by a claim, or at init when a
   *  token is already stored. */
  machineHash: () => Promise<MachineHashResult>
  /** The allowance public key; defaults to the shipped one. Tests pass their own. */
  publicKeyPem?: string
  /** Deliver the new state to this machine's own windows — never to relay peers. */
  notify: (s: ProjectLimitState) => void
}

export interface ProjectLimitHandle {
  /** The current state. Synchronous and offline. */
  state(): ProjectLimitState
  /** Ask the server for this device's allowance. Never rejects. */
  claim(): Promise<ClaimResult>
  /** Re-send the state (a license or settings change can alter it with nothing here noticing). */
  refresh(): void
}

const isInt = (v: unknown): v is number => Number.isSafeInteger(v)
const isCount = (v: unknown): v is number => isInt(v) && v >= 0
const isFree = (v: unknown): v is number => isInt(v) && v >= 1 && v <= FREE_MAX
const isEpoch = (v: unknown): v is number => isInt(v) && v >= 1
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

let deps: ProjectLimitDeps
let stored: Stored = {}
/** The machine hash from a successful OS read; null = none yet (provisional trust, see header). */
let osMachine: string | null = null
let claimInFlight: Promise<ClaimResult> | null = null
/** The JSON of the last state sent to the windows (seeded at init: the renderer reads it then). */
let lastSent: string | null = null
let writes: Promise<void> = Promise.resolve()
/** Background reads and writes, so tests can wait for them (`__projectLimitIdleForTests`). */
const pending = new Set<Promise<unknown>>()

function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p)
  const done = (): void => {
    pending.delete(p)
  }
  p.then(done, done)
  return p
}

function file(): string {
  return path.join(platform().userDataDir, 'project-limit.json')
}

function load(): Stored {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file(), 'utf-8'))
  } catch {
    return {}
  }
  if (!isRecord(raw)) return {}
  const s: Stored = {}
  if (typeof raw.latched === 'boolean') s.latched = raw.latched
  if (isCount(raw.offAt)) s.offAt = raw.offAt
  if (isFree(raw.free)) s.free = raw.free
  if (isEpoch(raw.epoch)) s.epoch = raw.epoch
  if (typeof raw.token === 'string' && raw.token) s.token = raw.token
  if (isCount(raw.firstLaunchOpenCount)) s.firstLaunchOpenCount = raw.firstLaunchOpenCount
  return s
}

/** Queue a write of the CURRENT record: the writes run in order and each serializes `stored` when
 *  it runs, so the last one to land always carries the newest state. A failed write is logged and
 *  the in-memory state stands. */
function persist(): Promise<void> {
  writes = writes
    .then(() => writeFileAtomic(file(), JSON.stringify(stored)))
    .catch((err) => console.warn('[project-limit] save failed', err instanceof Error ? err.message : String(err)))
  return track(writes)
}

function isActive(): boolean {
  if (!platform().isPackaged) return false
  if (stored.latched) return true
  const anchor = clockAnchorMs()
  return anchor >= PROJECT_LIMIT_DEADLINE_MS && !(stored.offAt !== undefined && anchor - stored.offAt < OFF_TRUST_MS)
}

function allowance(): number | null {
  if (!stored.token) return null
  const v = verifyAllowanceToken(
    stored.token,
    { deviceId: getDeviceId(), machine: osMachine, epoch: stored.epoch },
    deps.publicKeyPem
  )
  return v ? v.allowance : null
}

function compute(): ProjectLimitState {
  return {
    active: isActive(),
    pro: proForProjectLimit(),
    free: stored.free ?? PROJECT_LIMIT_DEFAULT_FREE,
    allowance: allowance(),
    dnt: isDntEnv()
  }
}

/** The count at the first launch of a limit-capable build (spec §4's late-updater basis): the first
 *  number `openProjects()` gives, kept for good. */
function recordFirstLaunchOpenCount(): void {
  if (stored.firstLaunchOpenCount !== undefined) return
  let n: number | undefined
  try {
    n = deps.openProjects()
  } catch {
    return
  }
  if (!isCount(n)) return
  stored = { ...stored, firstLaunchOpenCount: n }
  void persist()
}

function state(): ProjectLimitState {
  recordFirstLaunchOpenCount()
  return compute()
}

/** Send the state to this machine's windows, unconditionally (`refresh()`). */
function notify(): void {
  const s = state()
  lastSent = JSON.stringify(s)
  deps.notify(s)
}

/** Send the state only if it differs from the last one sent. Compared against what was SENT, not
 *  against the state a moment ago, so a change that came with time alone — the anchor crossing the
 *  deadline, an `offAt` going stale, Pro's grace lapsing — is pushed by the next call too. */
function pushIfChanged(): void {
  const s = state()
  const json = JSON.stringify(s)
  if (json === lastSent) return
  lastSent = json
  deps.notify(s)
}

/** Install `next`, save it when `save`, and tell this machine's windows if what they see changed. */
function commit(next: Stored, save: boolean): Promise<void> {
  stored = next
  const saved = save ? persist() : Promise.resolve()
  pushIfChanged()
  return saved
}

/** The epoch a token says it was issued under, read WITHOUT verifying it. Used only to decide that
 *  a newer epoch retires it — deleting is the safe direction: the next open past FREE re-claims. */
function tokenEpoch(token: string): number | null {
  const dot = token.indexOf('.')
  if (dot < 1) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf-8'))
    return isRecord(payload) && isInt(payload.epoch) ? payload.epoch : null
  } catch {
    return null
  }
}

/** One check answer. Idempotent: the same answer twice changes nothing the second time. */
function onAnswer(a: LimitsAnswer): void {
  if (a.kind === 'on') {
    const next: Stored = { ...stored, latched: true, free: a.free, epoch: a.epoch }
    if (next.token !== undefined && tokenEpoch(next.token) !== a.epoch) delete next.token
    const changed =
      stored.latched !== true || stored.free !== a.free || stored.epoch !== a.epoch || stored.token !== next.token
    void commit(next, changed)
  } else if (a.kind === 'off') {
    const offAt = clockAnchorMs()
    // offAt only matters while `anchor - offAt < OFF_TRUST_MS` with `anchor >= deadline`, i.e. when
    // it is later than `deadline - OFF_TRUST_MS`. An earlier one can never change `active`, so it is
    // kept in memory but not written: a dormant install does not rewrite the file on every check.
    const save = stored.latched === true || offAt > PROJECT_LIMIT_DEADLINE_MS - OFF_TRUST_MS
    void commit({ ...stored, latched: false, offAt }, save)
  }
  // 'unknown' changes nothing: a reply that did not come from the route must not move the latch.
}

function fail(error: ClaimError, retryAfter?: number): ClaimResult {
  return retryAfter === undefined
    ? { ok: false, error, state: state() }
    : { ok: false, error, retryAfter, state: state() }
}

async function runClaim(): Promise<ClaimResult> {
  const gate = licenseNetworkGate()
  if (gate !== 'ok') return fail(gate)
  // Dormant: there is no limit to claim an allowance against, so nothing is asked — no request and
  // no machine read, whoever calls. After the gate, so `consent_required` / `disabled` still surface.
  const now = state()
  if (!now.active) return { ok: true, state: now }
  const deviceId = getDeviceId()
  const machine = await deps.machineHash()
  const count = stored.firstLaunchOpenCount
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CLAIM_TIMEOUT_MS)
  let status: number
  let body: unknown
  try {
    const res = await fetch(`${API_BASE}/v1/limits/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        machine: machine.hash,
        firstLaunchOpenCount: count === undefined ? null : Math.min(count, COUNT_MAX)
      }),
      signal: ctrl.signal
    })
    status = res.status
    try {
      body = await res.json()
    } catch (err) {
      // Only a body that arrived and is not JSON is the server's. A body cut off by the timeout, or
      // by the connection dropping mid-read (undici: `TypeError: terminated`), is the network failing.
      if (ctrl.signal.aborted || !(err instanceof SyntaxError)) return fail('offline')
      body = undefined
    }
  } catch {
    return fail('offline')
  } finally {
    // Cleared only once the body has been read: see CLAIM_TIMEOUT_MS.
    clearTimeout(timer)
  }
  const b = isRecord(body) ? body : {}
  if (status >= 200 && status < 300) {
    const { token, free, epoch } = b
    if (typeof token !== 'string' || !isFree(free) || !isEpoch(epoch)) return fail('server')
    // A 2xx is only an allowance if its token is one: signed, for this device, the machine we sent
    // and the epoch the reply states.
    if (!verifyAllowanceToken(token, { deviceId, machine: machine.hash, epoch }, deps.publicKeyPem)) {
      return fail('server')
    }
    if (machine.fromOs) osMachine = machine.hash
    await commit({ ...stored, latched: true, free, epoch, token }, true)
    return { ok: true, state: state() }
  }
  if (status === 409 && b.error === 'not_active') {
    const next: Stored = { ...stored, latched: false, offAt: clockAnchorMs() }
    delete next.token
    await commit(next, true)
    return { ok: true, state: state() }
  }
  if (status === 409 && b.error === 'machine_mismatch') {
    return fail('machine_mismatch', isCount(b.retryAfter) && b.retryAfter > 0 ? b.retryAfter : undefined)
  }
  // 429 (rate limited), 5xx, 400, 404 (claims disabled server-side), an unknown 409: never a final answer.
  return fail('server')
}

function claim(): Promise<ClaimResult> {
  if (!claimInFlight) {
    const run = runClaim().catch((err): ClaimResult => {
      console.warn('[project-limit] claim failed', err instanceof Error ? err.message : String(err))
      return fail('server')
    })
    claimInFlight = run.finally(() => {
      claimInFlight = null
    })
  }
  return claimInFlight
}

export function initProjectLimit(d: ProjectLimitDeps): ProjectLimitHandle {
  deps = d
  stored = load()
  osMachine = null
  claimInFlight = null
  lastSent = JSON.stringify(compute())
  const handle: ProjectLimitHandle = { state, claim, refresh: notify }
  platform().handle(IPC.projectLimitState, () => handle.state())
  platform().handle(IPC.projectLimitClaim, () => handle.claim())
  onCheckAnswer(onAnswer)

  // Only once a token is stored (post-flip): a dormant install never reads the machine id.
  if (stored.token) {
    track(
      deps
        .machineHash()
        .then((m) => {
          if (!m.fromOs) return
          osMachine = m.hash
          notify()
        })
        .catch(() => {})
    )
  }

  const readCheck = (): void => {
    track(fetchCheck().catch(() => {}))
  }
  readCheck()
  setInterval(() => {
    // Time alone can change the state (see pushIfChanged); the check below covers the server's word.
    pushIfChanged()
    readCheck()
  }, CHECK_INTERVAL_MS).unref()
  return handle
}

/** TEST ONLY: resolves once every background read and write started so far has settled. */
export async function __projectLimitIdleForTests(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending])
}

/** TEST ONLY: the machine hash stored tokens are judged against (null = provisional trust). */
export function __projectLimitMachineForTests(): string | null {
  return osMachine
}
