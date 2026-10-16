// One long-lived PowerShell per process for the Windows pane probes.
//
// Before this, every probe was a fresh `powershell.exe`: the console-owner read also ran
// `Add-Type` (csc + a temp assembly in Windows PowerShell 5.1) each time, and the pane-command read
// (Eco / restart exit poll, agent liveness) re-ran a whole-table CIM query in a new process per
// call. That is hundreds of ms to over a second and tens of MB transient per probe, and a cold one
// can outlast the 2 s pane-probe budget agent messaging gives it. The worker pays the startup and
// the compile ONCE, serves probes FIFO over JSON lines, and goes away when idle.
//
// Contract with callers (windows-pane-owner.ts, process-tree.ts):
//   - `ok`          the worker answered; `result` is the probe's JSON.
//   - `failed`      the worker answered that the PROBE failed (no such console…) — a real answer,
//                   the same one a one-shot run would have given. Callers fail closed on it.
//   - `unavailable` the worker could not answer (could not start, timed out, died, spoke garbage).
//                   Callers fall back to the one-shot path, so a worker that does not work on some
//                   machine costs at most one deadline before the old behaviour takes over.
// A worker that fails twice in a row is benched for a cooldown, during which every request is
// `unavailable` immediately — never a respawn loop.
//
// Platform-neutral and injectable: the child comes from `deps.spawn`, so tests drive it with a
// PassThrough fake on any CI host. Only `getWindowsProbeWorker()` touches the real child_process.

import { spawn as spawnChild } from 'child_process'
import type { Readable, Writable } from 'stream'
import { powershellArgs, powershellExe } from '../core/win32-powershell'
import { validProbePid, WINDOWS_PROBE_WORKER_SCRIPT } from './windows-probe-script'
import { PROBE_FIRST_REQUEST_TIMEOUT_MS } from './windows-probe-budget'

export type ProbeRequest = { op: 'owner'; pid: number } | { op: 'table' }

export type ProbeAnswer =
  | { kind: 'ok'; result: unknown }
  | { kind: 'failed' }
  | { kind: 'unavailable' }

/** The slice of a ChildProcess the worker uses. */
export interface ProbeChild {
  stdin: Writable | null
  stdout: Readable | null
  kill(): unknown
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown
  unref?(): void
}

export interface ProbeWorkerDeps {
  spawn: () => ProbeChild
  /** Per-request deadline once the worker is warm. */
  requestTimeoutMs?: number
  /** Deadline for the first request after a spawn: PowerShell startup + the one-time Add-Type. */
  firstRequestTimeoutMs?: number
  /** Idle time after which the child is ended. */
  idleMs?: number
  /** Consecutive transport failures before the worker is benched. */
  maxFailures?: number
  cooldownMs?: number
  now?: () => number
}

export const PROBE_REQUEST_TIMEOUT_MS = 1500
export { PROBE_FIRST_REQUEST_TIMEOUT_MS }
export const PROBE_IDLE_MS = 60_000
export const PROBE_MAX_FAILURES = 2
export const PROBE_COOLDOWN_MS = 5 * 60_000

const UNAVAILABLE: ProbeAnswer = { kind: 'unavailable' }

interface Queued {
  request: ProbeRequest
  resolve: (answer: ProbeAnswer) => void
}

interface InFlight extends Queued {
  id: number
  timer: ReturnType<typeof setTimeout>
}

function unrefTimer(t: ReturnType<typeof setTimeout>): void {
  ;(t as { unref?: () => void }).unref?.()
}

export class WindowsProbeWorker {
  private child: ProbeChild | null = null
  private answeredSinceSpawn = false
  private buffer = ''
  private nextId = 1
  private current: InFlight | null = null
  private readonly queue: Queued[] = []
  /** Coalescing: an identical request already queued or in flight shares its answer. */
  private readonly pending = new Map<string, Promise<ProbeAnswer>>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private benchedUntil = 0
  private spawns = 0

  constructor(private readonly deps: ProbeWorkerDeps) {}

  /** How many children this worker has started — for tests and diagnostics. */
  get spawnCount(): number {
    return this.spawns
  }

  request(request: ProbeRequest): Promise<ProbeAnswer> {
    // Refused before anything is written: a pid that is not a safe positive integer never reaches
    // the worker, the same rule `windowsConsoleProbeScript` applies to the one-shot script.
    if (request.op === 'owner' && !validProbePid(request.pid)) return Promise.resolve({ kind: 'failed' })
    if (this.now() < this.benchedUntil) return Promise.resolve(UNAVAILABLE)
    const key = request.op === 'owner' ? `owner:${request.pid}` : 'table'
    const shared = this.pending.get(key)
    if (shared) return shared
    const answer = new Promise<ProbeAnswer>((resolve) => this.queue.push({ request, resolve }))
    this.pending.set(key, answer)
    void answer.then(() => {
      if (this.pending.get(key) === answer) this.pending.delete(key)
    })
    this.pump()
    return answer
  }

  /** End the child and answer everything outstanding `unavailable`. */
  dispose(): void {
    this.clearIdle()
    const current = this.current
    this.current = null
    if (current) {
      clearTimeout(current.timer)
      current.resolve(UNAVAILABLE)
    }
    for (const q of this.queue.splice(0)) q.resolve(UNAVAILABLE)
    this.stopChild()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return
    if (this.now() < this.benchedUntil) {
      for (const q of this.queue.splice(0)) q.resolve(UNAVAILABLE)
      return
    }
    this.clearIdle()
    const child = this.ensureChild()
    if (!child) {
      for (const q of this.queue.splice(0)) q.resolve(UNAVAILABLE)
      return
    }
    const next = this.queue.shift() as Queued
    const id = this.nextId++
    const timeoutMs = this.answeredSinceSpawn
      ? (this.deps.requestTimeoutMs ?? PROBE_REQUEST_TIMEOUT_MS)
      : (this.deps.firstRequestTimeoutMs ?? PROBE_FIRST_REQUEST_TIMEOUT_MS)
    const timer = setTimeout(() => this.transportFailed(), timeoutMs)
    unrefTimer(timer)
    this.current = { ...next, id, timer }
    const line =
      next.request.op === 'owner'
        ? JSON.stringify({ id, op: 'owner', pid: next.request.pid })
        : JSON.stringify({ id, op: 'table' })
    try {
      child.stdin?.write(line + '\n')
    } catch {
      this.transportFailed()
    }
  }

  private ensureChild(): ProbeChild | null {
    if (this.child) return this.child
    let child: ProbeChild
    try {
      child = this.deps.spawn()
    } catch {
      this.recordFailure()
      return null
    }
    this.spawns++
    this.child = child
    this.answeredSinceSpawn = false
    this.buffer = ''
    // Never what keeps a process alive: the host and main have their own handles, and anything else
    // (a test runner) must be able to exit with an idle worker still around.
    child.unref?.()
    ;(child.stdin as { unref?: () => void } | null)?.unref?.()
    ;(child.stdout as { unref?: () => void } | null)?.unref?.()
    // A write into a pipe whose reader died raises EPIPE on the stream; unhandled, that would take
    // the whole host down with it.
    child.stdin?.on('error', () => this.childGone(child))
    // Same rule for the read side: an ECONNRESET on the pipe is an 'error' on the stream itself.
    child.stdout?.on('error', () => this.childGone(child))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => this.onData(child, String(chunk)))
    child.on('error', () => this.childGone(child))
    child.on('exit', () => this.childGone(child))
    return child
  }

  private onData(child: ProbeChild, chunk: string): void {
    if (child !== this.child) return
    this.buffer += chunk
    // Guard against a runaway line (a reply is a few hundred kB at most for the owner snapshot).
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.transportFailed()
      return
    }
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.onLine(line)
      if (child !== this.child) return
    }
  }

  private onLine(line: string): void {
    const current = this.current
    if (!current) return
    let reply: unknown
    try {
      reply = JSON.parse(line)
    } catch {
      this.transportFailed()
      return
    }
    if (!reply || typeof reply !== 'object') {
      this.transportFailed()
      return
    }
    const r = reply as { id?: unknown; ok?: unknown; result?: unknown }
    // A line for an earlier, already-abandoned request: not ours, keep waiting for ours.
    if (r.id !== current.id) return
    this.answeredSinceSpawn = true
    this.failures = 0
    this.settle(r.ok === true ? { kind: 'ok', result: r.result } : { kind: 'failed' })
  }

  private settle(answer: ProbeAnswer): void {
    const current = this.current
    if (!current) return
    clearTimeout(current.timer)
    this.current = null
    current.resolve(answer)
    if (this.queue.length > 0) this.pump()
    else this.armIdle()
  }

  /** The worker could not answer the request in flight: end it, answer `unavailable`, move on. */
  private transportFailed(): void {
    this.stopChild()
    this.recordFailure()
    this.settle(UNAVAILABLE) // a benched worker's queue is drained by the pump this triggers
  }

  private childGone(child: ProbeChild): void {
    if (child !== this.child) return
    this.child = null
    if (this.current) this.transportFailed()
  }

  private recordFailure(): void {
    this.failures++
    if (this.failures >= (this.deps.maxFailures ?? PROBE_MAX_FAILURES)) {
      this.benchedUntil = this.now() + (this.deps.cooldownMs ?? PROBE_COOLDOWN_MS)
      this.failures = 0
    }
  }

  private stopChild(): void {
    const child = this.child
    this.child = null
    this.clearIdle()
    if (!child) return
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }

  private armIdle(): void {
    this.clearIdle()
    if (!this.child) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.current && this.queue.length === 0) this.stopChild()
    }, this.deps.idleMs ?? PROBE_IDLE_MS)
    unrefTimer(this.idleTimer)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

let singleton: WindowsProbeWorker | null = null

/**
 * This process's worker (the session host's, or main's for a direct Windows PTY). Null off
 * Windows: there is nothing to probe there, and no caller may spawn PowerShell on another OS.
 */
export function getWindowsProbeWorker(platformName: NodeJS.Platform = process.platform): WindowsProbeWorker | null {
  if (platformName !== 'win32') return null
  singleton ??= new WindowsProbeWorker({
    spawn: () =>
      spawnChild(powershellExe(), powershellArgs(WINDOWS_PROBE_WORKER_SCRIPT), {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
  })
  return singleton
}
