// Same-port local forwards for an SSH project's dev servers, over the project's EXISTING
// ControlMaster (`ssh -O forward -L 127.0.0.1:P:<host-side addr>:P`). The point of the SAME number
// is that the URLs the tool prints — `http://localhost:5173` — just work on this machine.
//
// Rules, each a refusal rather than a guess:
//  - Only a port discovery attributed to THIS node, in a scan taken at click time, is forwarded;
//    the renderer names a node and a port, never a host-side address.
//  - The local side binds 127.0.0.1 only.
//  - A local port that is taken — by anything listening on 127.0.0.1 OR ::1, since a browser's
//    `localhost` tries IPv6 first and would silently show the LOCAL app — is refused with the
//    reason, never silently moved. A different local port is only ever the person's explicit
//    choice (`localPort` in the request), with a free one suggested.
//  - A privileged port (< 1024, on either side) is refused until the person confirmed it.
//  - Lifecycle: a forward is cancelled when its node's session ends, when a successful scan no
//    longer lists the host port, or dropped when the project disconnects (the master takes the
//    listener with it). A failed scan cancels nothing — a failed read is never evidence.
//  - A master rebuilt behind our back (`ControlMaster=auto`, issue #735's mechanism) carries no
//    `-L`: every successful scan re-checks that the local listener is still held and forgets a
//    forward whose listener is gone, so the menu offers to forward again instead of lying.

import net from 'net'
import type { SshConnection } from '../../shared/ssh'
import {
  devPortUrl,
  forwardRefusalText,
  isPrivilegedPort,
  isValidPort,
  type DevPortForward,
  type DevPortForwardRequest,
  type DevPortForwardResult,
  type DevPortsReport
} from '../../shared/dev-ports'
import { forwardTarget } from '../dev-ports'
import { localForwardArgs, localForwardCancelArgs } from './control-master'

export interface PortForwardDeps {
  refForProject(projectId: string): { conn: SshConnection; controlPath: string } | undefined
  run(args: string[]): Promise<{ code: number; stdout: string }>
  /** A fresh discovery of the project's host (coalesced by the caller). */
  scan(projectId: string): Promise<DevPortsReport>
  /** What this machine's `localhost:<port>` looks like right now (see `localPortVerdict`). */
  localPortState(port: number): Promise<LocalPortState>
  /** Is the loopback listener still there (i.e. can we NOT bind 127.0.0.1:<port>)? */
  localPortHeld(port: number): Promise<boolean>
}

/** The raw facts about a local port, from two connects and one bind. */
export interface LocalPortState {
  /** Something answers on 127.0.0.1:<port>. */
  v4Answers: boolean
  /** Something answers on [::1]:<port>. */
  v6Answers: boolean
  /** Binding 127.0.0.1:<port> ourselves: fine, EADDRINUSE, or EACCES (privileged, no rights). */
  bind: 'ok' | 'in-use' | 'denied'
}

export type LocalPortVerdict = 'free' | 'busy' | 'denied' | 'maybe-ours'

/**
 * Pure. The order is the rule:
 *  - an answer on `::1` is BUSY whatever else is true: a browser's `localhost` tries IPv6 first, so
 *    a forward on 127.0.0.1 would show the local app under the host's name;
 *  - a bind refused for lack of rights is its own answer (the port is not in use — it cannot be
 *    ours, and "already in use" would be a lie);
 *  - a bind refused as IN USE on exactly 127.0.0.1 might be OUR master's listener from before an
 *    app restart (an adopted ControlPersist orphan keeps its forwards; the registry does not) —
 *    the caller may re-issue the identical forward, which the holding master acknowledges with 0
 *    and any other holder refuses with 255 (both measured);
 *  - something answering on 127.0.0.1 that we could still bind next to (BSD wildcard + SO_REUSEADDR)
 *    is busy, never shadowed.
 */
export function localPortVerdict(s: LocalPortState): LocalPortVerdict {
  if (s.v6Answers) return 'busy'
  if (s.bind === 'denied') return 'denied'
  if (s.bind === 'in-use') return 'maybe-ours'
  if (s.v4Answers) return 'busy'
  return 'free'
}

interface Held extends DevPortForward {
  projectId: string
  target: string
  conn: SshConnection
  controlPath: string
}

/** How far past the requested port the suggestion looks for a free one. */
const SUGGEST_SPAN = 100

/**
 * While ANY forward is held, core re-checks them on its own at this cadence. The renderer scans only
 * the project on screen, so without this a forward of a project the person switched away from (or
 * closed — neither disconnects) stayed bound after its dev server died: the local port stayed taken
 * (a local dev server silently moved to P+1) and whatever later bound the host's P got the traffic.
 * One exec per forwarding project per minute, and nothing at all while no forward is held; a
 * project the renderer scanned within the interval is skipped.
 */
export const FORWARD_SWEEP_MS = 60_000

export class PortForwardRegistry {
  private readonly held = new Map<number, Held>() // keyed by LOCAL port — unique on this machine
  private readonly inFlight = new Map<string, Promise<DevPortForwardResult>>()
  private readonly reconciledAt = new Map<string, number>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  constructor(
    private readonly d: PortForwardDeps,
    private readonly clock: { now(): number; sweepMs: number } = { now: () => Date.now(), sweepMs: FORWARD_SWEEP_MS }
  ) {}

  /** Arm the sweep while something is held; disarm it when nothing is. */
  private syncSweep(): void {
    if (this.held.size > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.clock.sweepMs)
      ;(this.sweepTimer as { unref?: () => void }).unref?.()
    } else if (this.held.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /** One pass over every project that holds a forward. Exported for tests via the class. */
  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const projects = new Set([...this.held.values()].map((h) => h.projectId))
      for (const projectId of projects) {
        const last = this.reconciledAt.get(projectId)
        if (last !== undefined && this.clock.now() - last < this.clock.sweepMs) continue
        if (!this.d.refForProject(projectId)) continue // disconnect handling drops these
        await this.reconcile(projectId, await this.d.scan(projectId))
      }
    } finally {
      this.sweeping = false
      this.syncSweep()
    }
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  list(projectId: string): DevPortForward[] {
    return [...this.held.values()]
      .filter((h) => h.projectId === projectId)
      .map(({ nodeId, remotePort, localPort }) => ({ nodeId, remotePort, localPort }))
      .sort((a, b) => a.remotePort - b.remotePort)
  }

  /** Coalesces a double click on the same row into one attempt. */
  forward(req: DevPortForwardRequest): Promise<DevPortForwardResult> {
    const key = `${req.projectId}\u0000${req.nodeId}\u0000${req.port}\u0000${req.localPort ?? ''}`
    const pending = this.inFlight.get(key)
    if (pending) return pending
    const p = this.forwardOnce(req).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, p)
    return p
  }

  private refuse(
    reason: Parameters<typeof forwardRefusalText>[0],
    port: number,
    localPort?: number,
    suggestedLocalPort?: number
  ): DevPortForwardResult {
    return {
      ok: false,
      reason,
      message: forwardRefusalText(reason, port, localPort),
      ...(suggestedLocalPort !== undefined ? { suggestedLocalPort } : {})
    }
  }

  private async forwardOnce(req: DevPortForwardRequest): Promise<DevPortForwardResult> {
    const remotePort = req.port
    const localPort = req.localPort ?? remotePort
    if (!isValidPort(remotePort) || !isValidPort(localPort) || typeof req.nodeId !== 'string' || !req.nodeId) {
      return this.refuse('invalid-port', Number(remotePort))
    }
    if (!this.d.refForProject(req.projectId)) return this.refuse('not-connected', remotePort)

    // The host side is decided HERE, from a scan taken now — never from the renderer.
    const report = await this.d.scan(req.projectId)
    if (!report.ok) return this.refuse('not-connected', remotePort)
    const found = report.nodes[req.nodeId]?.find((p) => p.port === remotePort)
    if (!found) return this.refuse('not-listening', remotePort)
    const target = forwardTarget(found.addresses)
    if (!target) return this.refuse('unreachable-address', remotePort)

    // Already forwarded for this project's port: hand back the live one, forget a dead one.
    for (const h of this.held.values()) {
      if (h.projectId !== req.projectId || h.remotePort !== remotePort) continue
      if (req.localPort !== undefined && h.localPort !== req.localPort) continue
      if (await this.d.localPortHeld(h.localPort)) {
        return { ok: true, localPort: h.localPort, url: devPortUrl(h.localPort), reused: true }
      }
      this.held.delete(h.localPort)
      this.syncSweep()
    }

    if ((isPrivilegedPort(remotePort) || isPrivilegedPort(localPort)) && req.allowPrivileged !== true) {
      return this.refuse('privileged', remotePort, localPort)
    }

    if (this.held.has(localPort)) {
      return this.refuse('local-port-busy', remotePort, localPort, await this.suggest(localPort))
    }
    const verdict = localPortVerdict(await this.d.localPortState(localPort))
    if (verdict === 'busy') return this.refuse('local-port-busy', remotePort, localPort, await this.suggest(localPort))
    if (verdict === 'denied') return this.refuse('local-port-denied', remotePort, localPort, await this.suggest(localPort))

    // Re-read the ref: the scan was a round trip, and the master may have gone meanwhile.
    const ref = this.d.refForProject(req.projectId)
    if (!ref) return this.refuse('not-connected', remotePort)
    let code: number
    try {
      ;({ code } = await this.d.run(localForwardArgs(ref.conn, ref.controlPath, localPort, target, remotePort)))
    } catch {
      code = -1
    }
    if (code !== 0) {
      // 'maybe-ours' that the master did not acknowledge: someone else holds the port.
      if (verdict === 'maybe-ours') {
        return this.refuse('local-port-busy', remotePort, localPort, await this.suggest(localPort))
      }
      return this.refuse('forward-failed', remotePort, localPort)
    }
    this.held.set(localPort, {
      projectId: req.projectId,
      nodeId: req.nodeId,
      remotePort,
      localPort,
      target,
      conn: ref.conn,
      controlPath: ref.controlPath
    })
    this.syncSweep()
    // An acknowledged 'maybe-ours' is a forward this master already held (adopted after a restart).
    return { ok: true, localPort, url: devPortUrl(localPort), reused: verdict === 'maybe-ours' }
  }

  /** The first free, non-privileged, not-ours local port after `from` — a suggestion only. */
  private async suggest(from: number): Promise<number | undefined> {
    const start = Math.max(from + 1, 1024)
    for (let p = start; p <= Math.min(start + SUGGEST_SPAN, 65535); p++) {
      if (this.held.has(p)) continue
      if (localPortVerdict(await this.d.localPortState(p)) === 'free') return p
    }
    return undefined
  }

  private async cancel(h: Held): Promise<void> {
    this.held.delete(h.localPort)
    this.syncSweep()
    try {
      await this.d.run(localForwardCancelArgs(h.conn, h.controlPath, h.localPort, h.target, h.remotePort))
    } catch {
      // Best effort: the master may already be gone, taking the listener with it.
    }
  }

  async unforward(projectId: string, localPort: number): Promise<boolean> {
    const h = this.held.get(localPort)
    if (!h || h.projectId !== projectId) return false
    await this.cancel(h)
    return true
  }

  /** After a SUCCESSFUL scan of the project: cancel forwards whose host port its OWNING node no
   *  longer listens on (another node now on that number is not the server the person opened),
   *  forget forwards whose local listener vanished (a rebuilt master). A failed scan changes nothing. */
  async reconcile(projectId: string, report: DevPortsReport): Promise<void> {
    if (!report.ok) return
    this.reconciledAt.set(projectId, this.clock.now())
    for (const h of [...this.held.values()]) {
      if (h.projectId !== projectId) continue
      const stillOwned = report.nodes[h.nodeId]?.some((p) => p.port === h.remotePort) === true
      if (!stillOwned) await this.cancel(h)
      else if (!(await this.d.localPortHeld(h.localPort))) this.held.delete(h.localPort)
    }
    this.syncSweep()
  }

  /** The node's session ended (delete, recycle): its dev server went with it. */
  async nodeEnded(nodeId: string): Promise<void> {
    for (const h of [...this.held.values()]) if (h.nodeId === nodeId) await this.cancel(h)
  }

  /** The project's master is gone; its listeners died with it — nothing to cancel over ssh. */
  projectDisconnected(projectId: string): void {
    for (const h of [...this.held.values()]) if (h.projectId === projectId) this.held.delete(h.localPort)
    this.reconciledAt.delete(projectId)
    this.syncSweep()
  }
}

/** Can a TCP connection to `host:port` on this machine be opened within `timeoutMs`? */
export function canConnect(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (v: boolean): void => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Try to bind `host:port` (released immediately): ok, in use, or denied (EACCES/EPERM). */
export function tryBind(host: string, port: number): Promise<LocalPortState['bind']> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'EACCES' || err.code === 'EPERM' ? 'denied' : 'in-use')
    )
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve('ok')))
  })
}

/** Could this process bind `host:port` right now? */
export async function canBind(host: string, port: number): Promise<boolean> {
  return (await tryBind(host, port)) === 'ok'
}

export async function defaultLocalPortState(port: number): Promise<LocalPortState> {
  const [v4Answers, v6Answers, bind] = await Promise.all([
    canConnect('127.0.0.1', port),
    canConnect('::1', port),
    tryBind('127.0.0.1', port)
  ])
  return { v4Answers, v6Answers, bind }
}

/** Busy for any reason — the old yes/no view of `defaultLocalPortState`. */
export async function defaultLocalPortBusy(port: number): Promise<boolean> {
  return localPortVerdict(await defaultLocalPortState(port)) !== 'free'
}

/** The forward's own listener is still there when WE cannot bind its port — only in-use counts. */
export async function defaultLocalPortHeld(port: number): Promise<boolean> {
  return (await tryBind('127.0.0.1', port)) === 'in-use'
}
