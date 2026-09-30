// Terminal-stream binary framing for the relay transport.
//
// The 16-byte header layout and opcode numbers are stable wire constants so an
// interoperable peer can be implemented against them. Pure functions: no sockets,
// no Electron.
//
// Header (16 bytes, little-endian where multi-byte):
//   [0]      kind    = 0x74
//   [1]      version = 1
//   [2]      opcode
//   [3]      reserved (0)
//   [4..8)   streamId  (uint32 LE)
//   [8..12)  seq high  (uint32 LE)
//   [12..16) seq low   (uint32 LE)
// followed by the raw payload.

const STREAM_KIND = 0x74
const STREAM_VERSION = 1
const HEADER_BYTES = 16

// Opcode numbers are part of the stable wire contract — do not renumber.
export const OP = {
  Output: 1,
  SnapshotStart: 2,
  SnapshotChunk: 3,
  SnapshotEnd: 4,
  Resized: 5,
  Error: 6,
  Input: 7,
  Resize: 8,
  Subscribe: 9,
  Unsubscribe: 10,
  SnapshotRequest: 11
} as const

export type Opcode = (typeof OP)[keyof typeof OP]

export type Frame = {
  op: number
  streamId: number
  seq: number
  payload: Uint8Array
}

// Max bytes we let buffer on a binary channel before applying backpressure.
// Kept here so the host/client transports share one threshold.
export const MAX_BINARY_BUFFERED_AMOUNT = 8 * 1024 * 1024

const KNOWN_OPCODES = new Set<number>(Object.values(OP))

export function encodeFrame(op: number, streamId: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, STREAM_KIND)
  view.setUint8(1, STREAM_VERSION)
  view.setUint8(2, op)
  view.setUint8(3, 0)
  view.setUint32(4, streamId, true)
  const s = Math.max(0, Math.floor(seq))
  view.setUint32(8, Math.floor(s / 0x100000000), true)
  view.setUint32(12, s >>> 0, true)
  out.set(payload, HEADER_BYTES)
  return out
}

// Decode a frame. Returns null for short buffers, a bad kind/version, or an
// unknown opcode — never throws.
export function decodeFrame(buf: Uint8Array): Frame | null {
  if (buf.length < HEADER_BYTES) {
    return null
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint8(0) !== STREAM_KIND || view.getUint8(1) !== STREAM_VERSION) {
    return null
  }
  const op = view.getUint8(2)
  if (!KNOWN_OPCODES.has(op)) {
    return null
  }
  const high = view.getUint32(8, true)
  const low = view.getUint32(12, true)
  return {
    op,
    streamId: view.getUint32(4, true),
    seq: high * 0x100000000 + low,
    payload: buf.slice(HEADER_BYTES)
  }
}
