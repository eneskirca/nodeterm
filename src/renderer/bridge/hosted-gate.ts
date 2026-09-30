// The RpcClient a hosted team's relay tab talks through: it sends only what the tab's ROLE may send.
//
// A Viewer or Commenter's tab would otherwise send the host everything an editor's does — the
// autosave, every canvas edit, keystrokes, and a handful of editor-only probes components make on
// mount — and the host refuses each one (E_ROLE). Nothing is gained by the round trip, and a tab
// that opens into a wall of refusals is noise on both ends. So a call the role may not make is
// answered HERE, in the host's own words and with its code (`hostedRoleRefusal`), and a cast is
// dropped: every caller behaves exactly as it would have on the host's refusal.
//
// This is a mirror, never the boundary — the host enforces roles on every message whatever this
// sends (src/core/relay/access-policy.ts). Until the role is known it is the LOWEST one: the tab
// learns it before anything mounts (relay-tab `openRelayTab`), and fail-closed is the direction a
// wrong guess must err in. Only a relay tab joined by a hosted team's code is built with this; a
// Team Access relay tab keeps the plain RpcClient. See docs/hosted-team-relay.md.
import { hostedMayCall, hostedRoleRefusal } from '../../shared/hosted-access'
import { E_DISCONNECTED } from '../../shared/rpc'
import type { HostedRole } from '../../shared/types'
import type { FrameTransport } from './frame-transport'
import { RpcClient } from './ws-bridge'

export class RoleGatedRpcClient extends RpcClient {
  /** The connection is gone: nothing can answer a request any more. */
  private closed = false

  constructor(
    transport: FrameTransport,
    private readonly role: () => HostedRole | null
  ) {
    super(transport)
    this.onClose(() => {
      this.closed = true
    })
  }

  override request(method: string, ...args: unknown[]): Promise<unknown> {
    if (this.closed) {
      // A request sent into a closed hosted connection would wait forever (nothing will answer it,
      // and nothing fails it later): fail it now, like the in-flight ones were (R41).
      const gone = Promise.reject(Object.assign(new Error('The connection to the server was lost.'), { code: E_DISCONNECTED }))
      gone.catch(() => {})
      return gone
    }
    const role = this.role()
    if (!hostedMayCall(role, method)) {
      const refused = Promise.reject(hostedRoleRefusal(role))
      // Some callers fire and forget (`void client.request(...)`, e.g. the read-on-view ack): the
      // refusal must not surface as an unhandled rejection. Anyone who awaits it still gets it.
      refused.catch(() => {})
      return refused
    }
    return super.request(method, ...args)
  }

  override cast(method: string, ...args: unknown[]): void {
    if (this.closed || !hostedMayCall(this.role(), method)) return
    super.cast(method, ...args)
  }
}
