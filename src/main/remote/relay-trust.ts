// The desktop trust gate: a thin wrapper over the core gate (src/core/relay/relay-trust.ts), which
// holds the whole mechanism and its SECURITY obligations (a) and (b) — read them there before
// touching any call site. The only thing this layer adds is WHERE a mutual approval is pinned: the
// store for the ROLE the peer plays (approved-devices.ts). Never the phone store — that one is read
// by the standing host to auto-admit, and a desktop peer must never land in it.
import {
  createTrustGate as createCoreTrustGate,
  TRUST_CONFIRM,
  TRUST_DENIED,
  deniedFrame,
  parseDenied,
  type TrustGate,
  type TrustGateOptions as CoreTrustGateOptions,
  type TrustDeniedReason
} from '../../core/relay/relay-trust'
import { recordApproval } from '../../core/relay/mutual-approval-core'
import { pinStore } from './approved-devices'
import type { ApprovedDevices } from './approved-devices-core'

export { TRUST_CONFIRM, TRUST_DENIED, deniedFrame, parseDenied, type TrustGate, type TrustDeniedReason }

export interface TrustGateOptions extends Omit<CoreTrustGateOptions, 'pins'> {
  /** Which desktop store a mutual approval lands in: a guest WE host, or a host WE joined. There is
   *  deliberately no 'phone' here — phones are pinned only by the standing host's SAS approval. */
  role: 'guest' | 'joinedHost'
  load?: () => Promise<ApprovedDevices>
  save?: (s: ApprovedDevices) => Promise<void>
}

/** Desktop trust gate: pins go to the role's own store (see `TrustGateOptions.role`). */
export function createTrustGate(opts: TrustGateOptions): TrustGate {
  const { load, save, role, ...rest } = opts
  const store = pinStore(role)
  return createCoreTrustGate({
    ...rest,
    pins: {
      // recordApproval refuses unless BOTH confirmed, and pins only the key carried by the state.
      // Injected load/save keep their read-then-write path; the default goes through the role
      // store's serialized update queue, so concurrent approvals never lose pins and a racing revoke is
      // never undone from a stale snapshot.
      async record(pinned) {
        if (load || save) {
          await (save ?? store.save)(recordApproval(await (load ?? store.load)(), pinned))
        } else {
          await store.update((s) => recordApproval(s, pinned))
        }
      }
    }
  })
}
