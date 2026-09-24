// The IPty-shim: makes a session-host-backed session look, to `pty-manager.ts`, exactly like the
// small subset of node-pty's `IPty` it actually touches (`onData`/`onExit`/`write`/`resize`/
// `pause`/`resume`/`kill`/`destroy` — see `Session.proc` and `ReleasablePty` in pty-manager.ts /
// pty-release.ts). This is what lets the session-host backend slot into the EXISTING
// subscriber/flow-control/co-attach machinery in `PtyManager` with no changes to any of that: as
// far as that code is concerned, `session.proc` is just a pty, however it is actually implemented.

import type { SessionHostClient, SessionSubscriber } from './session-host-client'
import type { SessionHostSpawnOptions, AttachResult } from '../session-host/protocol'

export class SessionHostPty {
  readonly name: string
  private readonly client: SessionHostClient
  private readonly sub: SessionSubscriber
  private readonly dataCbs: Array<(data: string) => void> = []
  private readonly exitCbs: Array<(e: { exitCode: number }) => void> = []
  private readonly attachErrorCbs: Array<(error: Error) => void> = []
  private readonly sizeCbs: Array<(size: { cols: number; rows: number }) => void> = []
  private attachError: Error | null = null
  private detached = false

  /**
   * Resolves once the initial attach-or-create round trip completes, carrying exactly what the
   * tmux backend gets for free from a warm reattach's own redraw: whether this was a cold start,
   * and — when it wasn't — the screen to seed. `spawnNew()` awaits this to build the outer
   * `PtyCreateResult` (`fresh`, `screen`) the same way `join()` already does for a same-process
   * co-attach. See docs/windows-session-host.md, "The seeding trap".
   */
  readonly ready: Promise<AttachResult>

  constructor(
    client: SessionHostClient,
    name: string,
    spawn: SessionHostSpawnOptions | null,
    scrollback: number
  ) {
    this.client = client
    this.name = name
    this.sub = {
      onData: (data) => {
        for (const cb of this.dataCbs) cb(data)
      },
      onExit: (exitCode) => {
        for (const cb of this.exitCbs) cb({ exitCode })
      },
      onSize: (size) => {
        for (const cb of this.sizeCbs) cb(size)
      },
      onAttachError: (error) => {
        this.attachError = error
        for (const cb of this.attachErrorCbs) cb(error)
      }
    }
    this.ready = spawn
      ? client.attach(name, spawn, scrollback, this.sub)
      : client.attachExisting(name, this.sub)
    // node-pty's real spawn never rejects asynchronously (a spawn failure throws synchronously,
    // before a Session is even constructed) — an attach failure here is the closest analogue, and
    // it must not become an unhandled rejection just because some callers (write/resize/pause/
    // resume) never look at `ready` at all. `spawnNew()` DOES await it and will see the failure.
    this.ready.catch(() => {})
  }

  onData(cb: (data: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCbs.push(cb)
  }

  /** The size the shared pty actually runs at (issue #914). Not part of node-pty's `IPty`: a real
   *  pty is exactly the size it was last given, while this one follows whichever viewer of the
   *  session was most recently active, which may be a different process entirely. */
  onSize(cb: (size: { cols: number; rows: number }) => void): void {
    this.sizeCbs.push(cb)
  }

  /** Reconnect replay failed for a previously-confirmed generation. Late registration receives
   * the stored error immediately so manager wiring cannot miss a fast rejection. */
  onAttachError(cb: (error: Error) => void): void {
    this.attachErrorCbs.push(cb)
    if (this.attachError) cb(this.attachError)
  }

  write(data: string): void {
    this.client.write(this.name, this.sub, data)
  }

  /** `bounding`: this pty's viewers cannot adapt to a grid other than their own, so the shared
   *  session must never grow past this claim (see `latestClaimSize`). */
  resize(cols: number, rows: number, bounding = false): void {
    this.client.resize(this.name, this.sub, cols, rows, bounding)
  }

  pause(): void {
    this.client.pause(this.name, this.sub)
  }

  resume(): void {
    this.client.resume(this.name, this.sub)
  }

  /**
   * DETACH only — never ends the remote session. Mirrors the tmux backend exactly: there,
   * `proc.kill()` kills the LOCAL tmux CLIENT process, not the tmux session it was attached to.
   * The real "end this session for good" lives in `pty-manager.ts`'s `destroySession`, via
   * `sessionHostBackend.killSession(name)` — the one path that maps to a real `tmux kill-session`.
   */
  kill(): void {
    this.detach()
  }

  /** `releasePty` prefers `destroy()` over `kill()` when both exist (deterministic fd close for a
   *  real pty) — here they are the same detach, so either is safe to call, including both. */
  destroy(): void {
    this.detach()
  }

  private detach(): void {
    if (this.detached) return
    this.detached = true
    this.client.unsubscribe(this.name, this.sub)
  }
}
