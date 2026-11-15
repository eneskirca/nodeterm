// The desktop's PEER sink registry (docs/remote-sessions.md 4b).
//
// A relay peer (a phone, or another desktop — wired in 4c) is a FIRST-CLASS CorePlatform client of
// this desktop's core, addressed by a UiSink instead of a webContents. Everything Stages 1-3 built
// (presence hub, canvas reflector, terminal co-attach) is already written against CorePlatform and
// is multi-client; the ONLY thing that made a peer half-joined — the host saw the phone in its
// facepile, the phone saw nothing — is that `electronPlatform.sendTo` resolved ids through
// `webContents.fromId` and `clientIds()` returned the main window alone, so every `sendTo`/
// `broadcast` aimed at a peer silently no-op'd. This module is that missing seam: it owns the peer
// sinks (and their WS backpressure, via the shared UiSinkRegistry), and platform-electron reads it
// to route sendTo / broadcast / clientIds.
//
// Ids are minted by the CALLER via allocateRelayClientId() (≥ 1_000_000), so a peer id can never
// collide with a webContents id (those start small and count up).
//
// Cost to a solo desktop user: zero. With no peer registered the registry holds an empty Map, arms
// no timer, and every lookup is a miss — the webContents path is bit-identical to before.
import { UiSinkRegistry, type UiSink } from '../core/ui-sink-registry'
import { presenceHub } from '../core/presence/hub'
import type { FlowOwner } from '../core/pty-manager'

export type { UiSink }

/** Module singleton: one sink set for the whole desktop process (like the Server Edition's, which
 *  lives on its ServerPlatform). platform-electron.ts reads it; 4c's relay connection feeds it. */
const registry = new UiSinkRegistry()
let onPeerGone: ((id: number) => void) | null = null

/** A peer sink that keeps THROWING is a dead connection (a half-closed relay socket), and the
 *  registry hands it back here rather than shouting into it forever: a dead peer needs precisely
 *  the teardown a closed socket gets. Registered at module scope so it holds even if `wirePeerRegistry`
 *  never ran — the teardown then still leaves the hub and the sink set clean (only `onPeerGone`
 *  warns). */
registry.setSinkGoneHandler((id) => unregisterPeerSink(id))

export function peerRegistry(): UiSinkRegistry {
  return registry
}

/** A relay peer connected. `id` must come from `allocateRelayClientId()`. The caller joins the
 *  presence hub itself (as ws.ts does), so it can pick the peer `kind`. */
export function registerPeerSink(id: number, sink: UiSink): void {
  registry.register(id, sink)
}

/**
 * A relay peer is GONE (socket closed, revoked, reaped). Mirrors src/server/ws.ts's close handler
 * EXACTLY — same three steps, same order — because a peer leaves the core in precisely the state a
 * closed browser tab does:
 *   1. presenceHub.leave  — else a ghost peer sits in everyone's facepile forever, holding a colour.
 *   2. onPeerGone → PtyManager.dropClient — nothing else tells the pty layer this subscriber is
 *      gone (a vanished peer sends no `pty:kill`): the pty is never released, its detach-time
 *      scrollback snapshot never taken, and a pause it owed could never be returned — with
 *      co-attach that freezes the shared terminal for EVERY viewer.
 *   3. registry.unregister — drops the sink and prunes only this id's paused/desynced entries,
 *      stopping the drain sweep if it was the last one (== ServerPlatform.detach).
 * A missed step is a ghost peer, a leaked pty client, or a timer that outlives its peer.
 */
export function unregisterPeerSink(id: number): void {
  presenceHub.leave(id)
  if (onPeerGone) onPeerGone(id)
  // Never silent: an optional call would turn "the boot wiring regressed" into a no-op, and the
  // damage (step 2 above: the pty layer never hears this subscriber left) is invisible until a
  // shared terminal is frozen for every other viewer, with nothing pointing back at the cause.
  else
    console.warn(
      `[peer-registry] peer ${id} left, but wirePeerRegistry() was never called: PtyManager.dropClient` +
        ' did NOT run, so its pty subscriptions (and any pause it owed) leak — a shared terminal can' +
        ' stay frozen for every other viewer. This is a boot-wiring bug in src/main/index.ts.'
    )
  registry.unregister(id)
}

/** Boot wiring (src/main/index.ts), analogous to src/server/index.ts's platform.setFlowController /
 *  setResyncProvider / onClientGone. Inert until a peer registers, so the solo path never runs any
 *  of it. */
export function wirePeerRegistry(deps: {
  setFlow: (id: number, sid: string, resume: boolean, owner: FlowOwner) => void
  captureForResync: (sid: string) => Promise<string>
  onPeerGone: (id: number) => void
}): void {
  registry.setFlowController(deps.setFlow)
  registry.setResyncProvider(deps.captureForResync)
  onPeerGone = deps.onPeerGone
}
