// The carrier seam under `RpcClient` (ws-bridge.ts). `RpcClient` speaks the rpc.ts frame protocol
// (`req`/`res`/`cast`/`ev` + binary pty-data) and needs to send/receive frames — but it does not
// care WHAT moves them. `FrameTransport` is that "what": a WebSocket to the Server Edition server,
// or the E2EE relay tunnel to a remote desktop. Extracting it lets the SAME ws-bridge builders
// (buildRealApi/buildFilesApi/…) power both a browser tab and a remote-desktop tab.
//
// A transport carries TWO frame shapes: JSON text frames (requests/responses/events) and binary
// pty-data frames (rpc.ts `encodePtyData`). `onMessage` therefore hands back `string | Uint8Array`;
// the RpcClient routes a string through `parseRpcMessage` and a `Uint8Array` through `decodePtyData`.

import type { RelayClientApi } from '../../shared/types'
import { onLocalRelayClose } from './relay-local-close'

export interface FrameTransport {
  /** Send one outbound frame (always a JSON string — pty-data is inbound only). */
  send(json: string): void
  /** Register the inbound-frame sink. A string is a JSON frame; a Uint8Array is a binary pty frame. */
  onMessage(cb: (data: string | Uint8Array) => void): void
  /** Register the carrier-closed hook (in-flight requests are failed, the reconnect overlay shows). */
  onClose(cb: () => void): void
  /** Resolves once the carrier is open and ready to exchange frames; rejects if it fails to open. */
  ready(): Promise<void>
}

/**
 * The Server Edition carrier: ONE WebSocket to `/ws`. This is the pre-refactor `RpcClient` socket
 * logic moved verbatim — `binaryType='arraybuffer'`, open→ready / error-before-open→reject, and the
 * message/close events forwarded to the sinks. Binary frames arrive as `ArrayBuffer` in the browser
 * and as a `Buffer` (a `Uint8Array`) under the `ws` package in tests; both are normalized to a
 * `Uint8Array` here so the RpcClient only ever sees `string | Uint8Array`.
 */
export class WebSocketFrameTransport implements FrameTransport {
  private ws: WebSocket
  private readyPromise: Promise<void>

  constructor(url: string) {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.readyPromise = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('WebSocket error')))
    })
  }

  send(json: string): void {
    this.ws.send(json)
  }

  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data
      if (typeof d === 'string') cb(d)
      else if (d instanceof ArrayBuffer) cb(new Uint8Array(d))
      else if (d instanceof Uint8Array) cb(d)
      // Anything else is undecodable — drop it (matches the pre-refactor binary guard).
    })
  }

  onClose(cb: () => void): void {
    this.ws.addEventListener('close', () => cb())
  }

  ready(): Promise<void> {
    return this.readyPromise
  }
}

/**
 * The remote-desktop carrier: the E2EE relay tunnel, addressed by `connectionId`, over the preload's
 * `relayClient` surface (main-process trust machinery lives behind it — see relay-client.ts). Only
 * JSON frames ride `onMessage` here: pty-data is decoded in the main process and re-emitted on the
 * per-session `pty:data` channel (relay-client.ts / index.ts), which the remote-tab `pty.onData`
 * subscribes to — the same shape a local pty uses. `ready` is the mutual-approval gate: it resolves
 * only once BOTH humans have confirmed the SAS (`onApproved`), which is when the frame pipe is live.
 */
export class RelayFrameTransport implements FrameTransport {
  private readyPromise: Promise<void>

  constructor(
    private readonly connectionId: string,
    private readonly relay: RelayClientApi = window.nodeTerminal.relayClient
  ) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.relay.onApproved(connectionId, () => resolve())
    })
  }

  send(json: string): void {
    this.relay.send(this.connectionId, json)
  }

  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.relay.onFrame(this.connectionId, (frame) => cb(frame))
  }

  onClose(cb: () => void): void {
    // Main's close (the socket dropped) or this renderer's own (relay-local-close.ts: main never
    // reports a close it was asked for). Only hosted paths announce a local close, so a Team Access
    // connection hears exactly what it always did. Once, whichever comes first.
    let fired = false
    let unLocal: () => void = () => {}
    const fire = (): void => {
      if (fired) return
      fired = true
      unLocal()
      cb()
    }
    unLocal = onLocalRelayClose(this.connectionId, fire)
    this.relay.onClosed(this.connectionId, () => fire())
  }

  ready(): Promise<void> {
    return this.readyPromise
  }
}
