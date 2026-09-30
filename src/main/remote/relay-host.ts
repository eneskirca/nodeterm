// The JOIN POINT on the host (docs/remote-sessions.md 4c): once two humans have mutually approved
// each other, the bridged peer becomes a FIRST-CLASS CorePlatform client of this desktop's core.
//
// There is very little code here on purpose. 4b already made `electronPlatform` multi-client (a
// client is a webContents OR a UiSink in the peer registry), and Stages 1-3 wrote presence, the
// canvas reflector and terminal co-attach against CorePlatform. So the whole of "a remote desktop
// opens as a project tab" reduces to: mint one ClientId, register one sink, join presence, and route
// the encrypted tunnel into `platform.dispatch` / `platform.cast`. Everything else just works
// (src/main/peer-integration.test.ts proved it against a fake sink; this module supplies the socket).
//
// It is the electron-side twin of `src/server/ws.ts`, and it deliberately mirrors that file's shape:
// attach the sink, join the hub, req → dispatch → respond, cast → cast, and on close run the ONE
// teardown (leave → dropClient → prune). Divergence between the two remote surfaces is a bug.
//
// SECURITY — nothing is served before MUTUAL approval. The peer is registered (and therefore able to
// reach any channel the shell registered on the platform) only from the trust gate's `onOpen`, i.e.
// after BOTH humans compared the same SAS and pressed Confirm. The E2EE handshake completing
// (`onReady`) proves only that SOMEONE holds the pairing token — a pre-approval request is answered
// with E_UNAUTHORIZED and never touches a handler. A pairing grants shell access; the SAS is the
// only thing between a relay MITM and that shell.
//
// SCOPE: this is the DESKTOP-peer vocabulary. An UNSCOPED invite (Team Access) is fully trusted, as
// its copy states ("full access to this Mac as you"). A SCOPED invite (`sharedProjectId`) is judged
// message by message by `scopedGuestHooks` (src/core/relay/scoped-guest-policy.ts): the shared
// project's terminals, files, git and board, and nothing of the host's other projects or secrets. The standing PHONE host keeps its existing legacy vocabulary in `host-service.ts` — with
// its deny-by-default fs jail — and is deliberately NOT routed through this dispatch path.
//
// THE MECHANISM LIVES IN CORE (src/core/relay/relay-host.ts, docs/hosted-team-relay.md): the
// handshake, the trust gate, the tunnel dispatch and every SECURITY obligation above. This file is
// the desktop's side of its seam — the `PeerAttach` that mints a ClientId, registers the peer sink
// and joins presence, the electronPlatform dispatch/cast, and where a mutual approval is pinned
// (the guest pin store). It passes no hooks and no autoApprove, so the desktop takes the unhooked path.
import {
  connectRelayHost as connectCoreRelayHost,
  killRelayHostsByPeerKey,
  killRelayHostsWhere,
  type RelayHostSession as CoreRelayHostSession,
  type ConnectRelayHostOptions as CoreOptions,
  type PeerAttach
} from '../../core/relay/relay-host'
import type { PinStore } from '../../core/relay/relay-trust'
import { recordApproval } from '../../core/relay/mutual-approval-core'
import type { ElectronPlatform } from '../platform-electron'
import { registerPeerSink, unregisterPeerSink } from '../peer-registry'
import { allocateRelayClientId, presenceHub } from '../../core/presence/hub'
import { guestPins } from './approved-devices'
import { registerPeerSessionKiller } from './peer-revoke'
import { scopedGuestHooks, type ScopedGuestDeps } from '../../core/relay/scoped-guest-policy'

export { killRelayHostsByPeerKey }

// Every live Team Access session is reachable by the one revoke primitive (peer-revoke.ts). The
// `live` set is module-level in core, so one registration at import covers every session.
registerPeerSessionKiller('desktop', (match) => killRelayHostsWhere(match))

/** The desktop's view of a hosting session: the core session minus `deny`. Team Access never refuses
 *  a peer with a reason (a revoke closes it), so the desktop surface stays exactly what it was. */
export type RelayHostSession = Omit<CoreRelayHostSession, 'deny'>

export interface ConnectRelayHostOptions extends Omit<CoreOptions, 'attach' | 'pins' | 'hooks'> {
  platform: ElectronPlatform
  /** What the scoped-guest policy reads from this core (project membership, live sessions, the
   *  project folder). REQUIRED whenever `sharedProjectId` is set: a scoped session without it is
   *  refused at connect rather than served as if it were unscoped. */
  scope?: ScopedGuestDeps
}

/** How a mutually-approved peer joins THIS desktop's core. `unregisterPeerSink` IS the ONE teardown
 *  (presenceHub.leave → onPeerGone → PtyManager.dropClient → registry prune); do NOT call
 *  `wirePeerRegistry` here — it is wired once at boot. */
function desktopAttach(platform: ElectronPlatform): PeerAttach {
  return {
    attach(sink) {
      const id = allocateRelayClientId()
      registerPeerSink(id, sink)
      // Join AFTER registering the sink, so the hub's `presence:sync` sendTo lands on a live sink (the
      // order src/server/ws.ts uses). A peer desktop is a 'desktop' peer, not a 'phone'.
      presenceHub.join(id, 'desktop')
      return id
    },
    detach: (id) => unregisterPeerSink(id),
    dispatch: (id, req) => platform.dispatch(id, req),
    cast: (id, method, args) => platform.cast(id, method, args)
  }
}

/** Desktop pins: a guest WE hosted goes to the GUEST store — never the phone store, which the
 *  standing host auto-admits from (approved-devices.ts). recordApproval refuses unless BOTH confirmed
 *  and pins only the key carried by the state; the serialized update queue keeps concurrent
 *  approvals and a racing revoke intact. */
function desktopPins(): PinStore {
  return { record: (pinned) => guestPins.update((store) => recordApproval(store, pinned)) }
}

export function connectRelayHost(opts: ConnectRelayHostOptions): RelayHostSession {
  const { platform, scope, ...rest } = opts
  // A session bound to one project is served through the scoped policy, or not at all. Failing
  // here (before any socket opens) is the point: the alternative is a "scoped" invite that serves
  // everything, which is the bug this policy exists to close.
  if (rest.sharedProjectId && !scope) {
    throw new Error('A project-scoped relay session needs its scope policy.')
  }
  const hooks = rest.sharedProjectId && scope ? scopedGuestHooks(rest.sharedProjectId, scope) : undefined
  return connectCoreRelayHost({
    ...rest,
    attach: desktopAttach(platform),
    pins: desktopPins(),
    ...(hooks ? { hooks } : {})
  })
}
