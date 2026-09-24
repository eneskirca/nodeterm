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
import {
  confirmLocal,
  confirmRemote,
  emptyMutualApproval,
  isMutuallyApproved,
  recordApproval,
  type MutualApproval
} from './mutual-approval-core'
import { loadApprovedDevices, saveApprovedDevices, updateApprovedDevices } from './approved-devices'
import type { ApprovedDevices } from './approved-devices-core'
import { parseRpcMessage } from '../../shared/rpc'

/**
 * The ONLY remote-confirm signal, carried as an rpc.ts `cast` over the E2EE tunnel
 * (`RelaySocket.sendTunnelText` → TAG_TUNNEL_TEXT inside the box). It is deliberately NOT a method
 * of the peer RPC surface: a trust frame is consumed here and never forwarded to a dispatcher, so no
 * handler table can ever route a confirm.
 */
export const TRUST_CONFIRM = 'trust:confirm'

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
  /** Both humans confirmed → the peer's key is pinned and the session may open. */
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
  load?: () => Promise<ApprovedDevices>
  save?: (s: ApprovedDevices) => Promise<void>
}

export function createTrustGate(opts: TrustGateOptions): TrustGate {
  // Obligation (b): ONE state per pairing attempt, bound to THIS session's ECDH peer key.
  let state: MutualApproval = emptyMutualApproval(opts.peerKeyB64, opts.sessionId)
  let opened = false

  const settle = (): void => {
    if (opened || !isMutuallyApproved(state)) {
      return
    }
    opened = true
    const pinned = state
    void (async () => {
      // Pin FIRST (recordApproval refuses unless BOTH confirmed, and pins only the key carried by
      // the state), then open. A failed write must not strand a session both humans confirmed —
      // it only means the next connect asks for the SAS again, which is the safe direction.
      const load = opts.load ?? loadApprovedDevices
      const save = opts.save ?? saveApprovedDevices
      try {
        if (opts.load || opts.save) await save(recordApproval(await load(), pinned))
        else await updateApprovedDevices((store) => recordApproval(store, pinned))
      } catch {
        // Persisting the pin is best-effort; consent for THIS session is already mutual.
      }
      opts.onOpen()
    })()
  }

  return {
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
    isOpen: () => opened,
    peerKeyB64: () => opts.peerKeyB64
  }
}
