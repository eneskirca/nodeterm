// The connection-level trust gate: the ONE place a peer's confirmation is accepted.
//
// Stage 4 makes two desktops equal peers, which means a pairing GRANTS THE PEER SHELL ACCESS on this
// machine. The only thing standing between a relay man-in-the-middle and that shell is mutual
// approval: BOTH humans compare the same 6-digit SAS out of band and BOTH press Confirm. The pure
// latch is `mutual-approval-core.ts`; this file is the wiring it says it cannot enforce, and the
// wiring is where the property can be silently destroyed.
//
// SECURITY — obligation (a) of mutual-approval-core.ts: `onTunnelText` is called ONLY from
// `connectRelay`'s `onTunnel` callback (relay-socket.ts), which fires only for a payload that
//   (1) DECRYPTED under THIS session's key (deriveSessionKey — fresh nonces both ways),
//   (2) carried the PEER's role byte (so a relay cannot reflect our own confirm back at us), and
//   (3) beat the per-direction monotonic replay counter.
// A plaintext frame from the relay reaches `handleControl` (which understands only `e2ee_hello` /
// `e2ee_ready`) and dies there; it can never reach this module. That is what makes `confirmRemote`
// proof that the REAL peer's human confirmed — and it is exactly what relay-trust.test.ts forges
// against. NEVER add a second call site for `confirmRemote`: not `onRpc`, not `onFrame`, not an IPC
// message from the renderer, not a plaintext handshake control. If a confirm can arrive any other
// way, mutual approval degrades back to ONE-WAY and the local human alone unlocks shell access while
// believing the remote human agreed. The SAS-mismatch backstop does NOT catch that (it catches key
// substitution, not a same-key relay forging the confirm DIRECTION).
//
// SECURITY — obligation (b): EXACTLY ONE `MutualApproval` per pairing attempt, seeded from THIS
// session's ECDH peer key (the key whose shared secret produced the SAS the humans compared). The
// state lives in this closure, is created once per gate, and each connection hangs its own gate off
// its own `onTunnel` — so a confirm arriving on session A's tunnel is physically unable to reach
// session B's state, and `recordApproval` can only ever pin the key bound into the state it is given.
//
// LOCAL confirms have exactly five call sites, three on the HOST side and two on the CLIENT side.
// Host side: `confirmHere()` from the desktop's Team Access dialog (`relay:host:confirm`), the host's
// `autoApprove` for a key its pin store holds (the hosted team's `team.json`), and a hosted owner's
// `relay:hosted:approve`. Client side: the joining human's `relay:client:confirm`, and the client's
// `autoApprove` for a hosted team's approved bookmark (src/main/remote/hosted-join.ts). A sixth is a
// design change.
import {
  confirmLocal,
  confirmRemote,
  emptyMutualApproval,
  isMutuallyApproved,
  type MutualApproval
} from './mutual-approval-core'
import { parseRpcMessage } from '../../shared/rpc'

/**
 * The ONLY remote-confirm signal, carried as an rpc.ts `cast` over the E2EE tunnel
 * (`RelaySocket.sendTunnelText` → TAG_TUNNEL_TEXT inside the box). It is deliberately NOT a method
 * of the peer RPC surface: a trust frame is consumed here and never forwarded to a dispatcher, so no
 * handler table can ever route a confirm.
 */
export const TRUST_CONFIRM = 'trust:confirm'

/**
 * A host's refusal, sent over the ENCRYPTED tunnel right before it closes a peer it will not serve.
 * It is NOT a trust frame: the gate never consumes it (`onTunnelText` returns false for it) and it
 * can never advance approval — it only tells the peer WHY the connection is about to end.
 */
export const TRUST_DENIED = 'trust:denied'

export type TrustDeniedReason = 'denied' | 'removed' | 'expired'
const DENIED_REASONS: readonly TrustDeniedReason[] = ['denied', 'removed', 'expired']

export interface PinStore {
  /** Persist the approval. Called once, only after BOTH ends confirmed; failures are swallowed. */
  record(state: MutualApproval): Promise<void>
}

export interface TrustGate {
  /** SAS both humans compare ("NNN NNN"), or null before the key is derived. */
  sas(): string | null
  /** This human pressed Confirm. Latches localConfirmed and tells the peer over the tunnel. */
  confirmHere(): void
  /**
   * A TEXT frame arrived on the ENCRYPTED tunnel. Returns true when it was a trust frame (and was
   * therefore consumed — never forward it on to the RPC dispatcher). Anything that is not
   * `{t:'cast', method:'trust:confirm'}` is ignored and returns false.
   *
   * Call this ONLY from `connectRelay`'s `onTunnel`. See the SECURITY block above.
   */
  onTunnelText(json: string): boolean
  /**
   * Both humans confirmed. Latched the moment the second confirm arrives, BEFORE the pin write and
   * `onOpen`: true while the pin is still in flight, and it never goes back to false. A host uses it
   * to tell "approved, opening" (hold the peer's frames) from "not approved" (refuse them).
   */
  isApproved(): boolean
  /**
   * Both humans confirmed → the pin attempt has settled and `onOpen` has fired. True exactly when
   * `onOpen` has run: never while the pin write is still in flight.
   */
  isOpen(): boolean
  /** The peer's stable box public key (base64) this gate is bound to. */
  peerKeyB64(): string | null
}

export interface TrustGateOptions {
  /** The peer's stable box public key from THIS session's ECDH (`RelaySocket.peerPublicKeyB64()`). */
  peerKeyB64: string
  /** Identity of this pairing attempt. */
  sessionId: string
  /**
   * THIS session's SAS. Pass `socket.sas()` (`sasFromSharedKey(baseKey)`, the function `mutualSas`
   * aliases), NOT a value derived anywhere else: the digits the two humans compare must come from
   * the same ECDH shared secret that keys this connection.
   */
  sas: () => string | null
  /** Send our own confirm to the peer — MUST be `socket.sendTunnelText` (encrypted). */
  sendConfirm: (json: string) => void
  /** Fires exactly once, when both sides have confirmed: the session may open. */
  onOpen: () => void
  /** Where a mutual approval is pinned. Absent = pin nothing (the session still opens). */
  pins?: PinStore
  /**
   * Latch the LOCAL confirm at construction (and send it to the peer) — for a key this end already
   * trusts. It never touches the REMOTE half: the peer's human (or the peer's own pin) must still
   * confirm over the encrypted tunnel before anything opens. Absent/false = byte-identical legacy
   * behavior (nothing is sent until `confirmHere()`).
   *
   * (a) The confirm is sent SYNCHRONOUSLY, inside `createTrustGate` itself — before the caller has
   * even stored the returned gate. `sendConfirm` must therefore already be able to deliver: over an
   * in-process transport the relay socket may not exist yet during `onReady`, and a confirm sent
   * into nothing is lost silently (a pinned reconnect then never opens). A caller that cannot promise
   * that passes `false` and calls `confirmHere()` itself once the socket and the gate exist, as the
   * core relay host and client do.
   *
   * (b) Derive it from the caller's OWN pin store, for exactly `peerKeyB64` (this session's ECDH
   * peer key) — never from anything the peer sent. A value the peer can influence turns this into a
   * remote-controlled local confirm, i.e. one-way approval.
   */
  autoApprove?: boolean
}

export function createTrustGate(opts: TrustGateOptions): TrustGate {
  // Obligation (b): ONE state per pairing attempt, bound to THIS session's ECDH peer key.
  let state: MutualApproval = emptyMutualApproval(opts.peerKeyB64, opts.sessionId)
  // Two flags, deliberately: `approved` latches synchronously the moment BOTH confirms are in (so the
  // pin-then-open sequence runs exactly once), while `opened` flips only when that sequence ends and
  // `onOpen` fires. `isOpen()` reads `opened`, so it can never report an open session whose pin
  // write is still in flight or whose `onOpen` has not run — it and `onOpen` agree by construction,
  // whatever the pin store's microtask depth.
  let approved = false
  let opened = false

  const settle = (): void => {
    if (approved || !isMutuallyApproved(state)) {
      return
    }
    approved = true
    const pinned = state
    void (async () => {
      // Pin FIRST (the store is handed only a state in which BOTH confirmed, carrying only the key
      // bound into it), then open. A failed write must not strand a session both humans confirmed —
      // it only means the next connect asks for the SAS again, which is the safe direction.
      try {
        await opts.pins?.record(pinned)
      } catch {
        // Persisting the pin is best-effort; consent for THIS session is already mutual.
      }
      opened = true
      opts.onOpen()
    })()
  }

  const gate: TrustGate = {
    sas: () => opts.sas(),
    confirmHere() {
      state = confirmLocal(state)
      // Tell the peer over the ENCRYPTED tunnel. This is the only confirm we ever send.
      opts.sendConfirm(JSON.stringify({ t: 'cast', method: TRUST_CONFIRM, args: [] }))
      settle()
    },
    onTunnelText(json) {
      const m = parseRpcMessage(json)
      if (!m || m.t !== 'cast' || m.method !== TRUST_CONFIRM) {
        return false
      }
      state = confirmRemote(state)
      settle()
      return true // consumed: a trust frame is NEVER forwarded to the RPC dispatcher
    },
    isApproved: () => approved,
    isOpen: () => opened,
    peerKeyB64: () => opts.peerKeyB64
  }
  // A fresh state has no remote confirm, so this can never open the gate by itself.
  if (opts.autoApprove) gate.confirmHere()
  return gate
}

/** The cast a host sends over the ENCRYPTED tunnel right before closing a refused peer. */
export function deniedFrame(reason: TrustDeniedReason): string {
  return JSON.stringify({ t: 'cast', method: TRUST_DENIED, args: [reason] })
}

/** A denial reason, or null for anything that is not a well-formed denial. */
export function parseDenied(json: string): TrustDeniedReason | null {
  const m = parseRpcMessage(json)
  if (!m || m.t !== 'cast' || m.method !== TRUST_DENIED) return null
  const r = m.args[0]
  return (DENIED_REASONS as readonly unknown[]).includes(r) ? (r as TrustDeniedReason) : null
}
