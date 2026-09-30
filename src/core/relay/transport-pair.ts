// src/core/relay/transport-pair.ts
// In-process RelayTransport pair for tests: what one side sends, the other receives, synchronously.
// The same wiring relay-host.test.ts builds by hand; shared here for the core tests.
import type { RelayTransport } from './relay-socket'

export function transportPair(opts: { hostBuffered?: () => number } = {}): {
  hostT: RelayTransport
  peerT: RelayTransport
} {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let peerOnMsg: ((d: unknown) => void) | null = null
  let hostOnClose: (() => void) | null = null
  let peerOnClose: (() => void) | null = null
  const hostT: RelayTransport = {
    get bufferedAmount() { return opts.hostBuffered?.() ?? 0 },
    send: (d) => peerOnMsg?.(d),
    close: () => { peerOnClose?.(); hostOnClose?.() },
    onMessage: (cb) => { hostOnMsg = cb },
    onClose: (cb) => { hostOnClose = cb }
  }
  const peerT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => { hostOnClose?.(); peerOnClose?.() },
    onMessage: (cb) => { peerOnMsg = cb },
    onClose: (cb) => { peerOnClose = cb }
  }
  return { hostT, peerT }
}
