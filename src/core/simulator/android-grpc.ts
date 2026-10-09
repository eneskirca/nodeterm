import http2 from 'node:http2'

/**
 * The Android emulator's gRPC control interface (`android.emulation.control.EmulatorController`),
 * spoken over plain HTTP/2 with a hand-written protobuf codec — the few messages the Simulator
 * node needs do not justify a gRPC library. Field numbers come from the
 * `emulator_controller.proto` the SDK ships in `<sdk>/emulator/lib/`.
 *
 * MEASURED (emulator 36.6.11, macOS): every emulator listens on 127.0.0.1 with a per-run bearer
 * token it writes to its discovery file (`grpc.token`); the token grants the controller methods
 * used here. A screenshot stream sends a frame only when the screen changed.
 */

// ── Protobuf: just enough of the wire format ───────────────────────────────────────────────────

export function varint(n: number | bigint): Buffer {
  let v = BigInt.asUintN(64, BigInt(n))
  const out: number[] = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v) byte |= 0x80
    out.push(byte)
  } while (v)
  return Buffer.from(out)
}

/** A varint field (int32/uint32/enum/bool). Zero is the default and is omitted, as protobuf does. */
export function fInt(field: number, n: number): Buffer {
  return n === 0 ? Buffer.alloc(0) : Buffer.concat([varint(field << 3), varint(n)])
}

/** A length-delimited field (bytes, string, nested message). */
export function fBytes(field: number, buf: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf])
}

export function fString(field: number, s: string): Buffer {
  return fBytes(field, Buffer.from(s, 'utf8'))
}

/** A double field (wire type 1). */
export function fDouble(field: number, v: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(v)
  return Buffer.concat([varint((field << 3) | 1), b])
}

/** A packed repeated float field. */
export function fFloats(field: number, values: readonly number[]): Buffer {
  const b = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => b.writeFloatLE(v, i * 4))
  return fBytes(field, b)
}

export type ProtoValue = bigint | Buffer

/** Decode one message's top-level fields: field number → its values (varints as bigint, length-
 *  delimited as Buffer). Fixed 32/64-bit fields are skipped. Throws on a truncated message. */
export function decodeFields(buf: Buffer): Map<number, ProtoValue[]> {
  const out = new Map<number, ProtoValue[]>()
  let i = 0
  const readVarint = (): bigint => {
    let v = 0n
    let shift = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('truncated protobuf')
      const c = buf[i++]
      v |= BigInt(c & 0x7f) << shift
      if (!(c & 0x80)) return v
      shift += 7n
      if (shift > 70n) throw new Error('bad varint')
    }
  }
  while (i < buf.length) {
    const key = readVarint()
    const field = Number(key >> 3n)
    const type = Number(key & 7n)
    let value: ProtoValue | null = null
    if (type === 0) value = readVarint()
    else if (type === 2) {
      const len = Number(readVarint())
      if (i + len > buf.length) throw new Error('truncated protobuf')
      value = buf.subarray(i, i + len)
      i += len
    } else if (type === 1) i += 8
    else if (type === 5) i += 4
    else throw new Error(`unsupported wire type ${type}`)
    if (i > buf.length) throw new Error('truncated protobuf')
    if (value !== null) {
      const list = out.get(field)
      if (list) list.push(value)
      else out.set(field, [value])
    }
  }
  return out
}

export function num(fields: Map<number, ProtoValue[]>, field: number): number {
  const v = fields.get(field)?.[0]
  return typeof v === 'bigint' ? Number(v) : 0
}

export function bytes(fields: Map<number, ProtoValue[]>, field: number): Buffer | undefined {
  const v = fields.get(field)?.[0]
  return Buffer.isBuffer(v) ? v : undefined
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

export const IMAGE_PNG = 0

/** ImageFormat { format=1, width=3, height=4 }. Width and height must be sent together — MEASURED:
 *  a width alone is ignored and the full-resolution frame comes back. */
export function imageFormat(format: number, width = 0, height = 0): Buffer {
  return Buffer.concat([fInt(1, format), fInt(3, width), fInt(4, height)])
}

export interface EmulatorImage {
  width: number
  height: number
  image: Buffer
}

/** Image { format=1 (ImageFormat { width=3, height=4 }), image=4 }. */
export function decodeImage(msg: Buffer): EmulatorImage | null {
  const f = decodeFields(msg)
  const fmt = bytes(f, 1)
  const image = bytes(f, 4)
  if (!fmt || !image) return null
  const ff = decodeFields(fmt)
  return { width: num(ff, 3), height: num(ff, 4), image }
}

/** TouchEvent { touches=1: Touch { x=1, y=2, identifier=3, pressure=4 } }, in PORTRAIT panel pixels.
 *  MEASURED: touches are not rotated with the device — the same panel point whatever the rotation. */
export function touchEvent(x: number, y: number, pressure: number): Buffer {
  return fBytes(1, Buffer.concat([fInt(1, Math.round(x)), fInt(2, Math.round(y)), fInt(4, pressure)]))
}

export const KEY_DOWN = 0
export const KEY_UP = 1
export const KEY_PRESS = 2

/** KeyboardEvent { codeType=1 (Usb=0), eventType=2, keyCode=3 }. MEASURED: the USB code is the
 *  full usage, page 7 in the high half (0x70004 = "a") — a bare usage types nothing. */
export function usbKeyEvent(usage: number, eventType: number): Buffer {
  return Buffer.concat([fInt(1, 0), fInt(2, eventType), fInt(3, 0x70000 | usage)])
}

/** KeyboardEvent { eventType=2, key=4 } — a W3C key name ("GoHome", "GoBack", "AppSwitch", "Power",
 *  "AudioVolumeUp"…), which the emulator maps to the Android key. */
export function namedKeyEvent(key: string, eventType = KEY_PRESS): Buffer {
  return Buffer.concat([fInt(2, eventType), fString(4, key)])
}

/** PhysicalModelValue { target=1 (ROTATION=1), value=3: ParameterValue { data=1 } }. The emulator
 *  turns the device (and its frames) by `z` degrees: 90 = turned left (counter-clockwise). */
export function rotationModel(z: number): Buffer {
  return Buffer.concat([fInt(1, 1), fBytes(3, fFloats(1, [0, 0, z]))])
}

/** GpsState { passiveUpdate=1, latitude=2, longitude=3, satellites=7 }. */
export function gpsState(lat: number, lon: number): Buffer {
  return Buffer.concat([fDouble(2, lat), fDouble(3, lon), fInt(7, 12)])
}

/** ClipData { text=1 }. */
export function clipData(text: string): Buffer {
  return text ? fString(1, text) : Buffer.alloc(0)
}

export function decodeClipText(msg: Buffer): string {
  const v = bytes(decodeFields(msg), 1)
  return v ? v.toString('utf8') : ''
}

export const BATTERY_CHARGING = 1
export const BATTERY_DISCHARGING = 2
export const BATTERY_FULL = 4
export const CHARGER_NONE = 0
export const CHARGER_AC = 1

/** BatteryState { hasBattery=1, isPresent=2, charger=3, chargeLevel=4, status=6 }. */
export function batteryState(level: number, status: number, charger: number): Buffer {
  return Buffer.concat([fInt(1, 1), fInt(2, 1), fInt(3, charger), fInt(4, level), fInt(6, status)])
}

/** Fingerprint { isTouching=1, touchId=2 }. */
export function fingerprint(touching: boolean, touchId: number): Buffer {
  return Buffer.concat([fInt(1, touching ? 1 : 0), fInt(2, touchId)])
}

export const VM_SHUTDOWN = 5
export const VM_RESET = 9

export function vmRunState(state: number): Buffer {
  return fInt(1, state)
}

// ── Transport ────────────────────────────────────────────────────────────────────────────────────

const SERVICE = '/android.emulation.control.EmulatorController/'
const MAX_MESSAGE = 32 * 1024 * 1024

export class GrpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

function frame(msg: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

/** Splits a gRPC response body into messages. Returns false on a malformed or oversized one. */
export function messageReader(onMessage: (msg: Buffer) => void): (chunk: Buffer) => boolean {
  let buf: Buffer = Buffer.alloc(0)
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 5) {
      if (buf[0] !== 0) return false // compressed messages were never asked for
      const len = buf.readUInt32BE(1)
      if (len > MAX_MESSAGE) return false
      if (buf.length < 5 + len) break
      onMessage(buf.subarray(5, 5 + len))
      buf = buf.subarray(5 + len)
    }
    return true
  }
}

export interface EmulatorEndpoint {
  port: number
  token: string
}

/** One HTTP/2 connection to an emulator, shared by every call. */
export class EmulatorClient {
  private session: http2.ClientHttp2Session
  private closed = false

  constructor(
    private readonly endpoint: EmulatorEndpoint,
    onClose?: () => void
  ) {
    this.session = http2.connect(`http://127.0.0.1:${endpoint.port}`)
    this.session.on('error', () => undefined) // surfaced per call; 'close' follows
    this.session.on('close', () => {
      this.closed = true
      onClose?.()
    })
  }

  get isClosed(): boolean {
    return this.closed || this.session.destroyed
  }

  private request(method: string): http2.ClientHttp2Stream {
    return this.session.request({
      ':method': 'POST',
      ':path': SERVICE + method,
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization: `Bearer ${this.endpoint.token}`
    })
  }

  /** A unary call. Resolves with the response message (empty for google.protobuf.Empty). */
  unary(method: string, body: Buffer, timeoutMs = 15_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.isClosed) return reject(new GrpcError(14, 'The emulator connection is closed.'))
      const s = this.request(method)
      let reply: Buffer = Buffer.alloc(0)
      let failed = false
      const read = messageReader((m) => (reply = Buffer.from(m)))
      const timer = setTimeout(() => {
        failed = true
        s.close(http2.constants.NGHTTP2_CANCEL)
        reject(new GrpcError(4, `${method} timed out.`))
      }, timeoutMs)
      s.on('data', (chunk: Buffer) => {
        if (!read(chunk) && !failed) {
          failed = true
          s.close(http2.constants.NGHTTP2_CANCEL)
          reject(new GrpcError(13, `${method}: unreadable reply.`))
        }
      })
      const finish = (headers: http2.IncomingHttpHeaders) => {
        if (failed) return
        const status = Number(headers['grpc-status'] ?? 0)
        if (status !== 0) {
          failed = true
          const msg = headers['grpc-message']
          reject(new GrpcError(status, typeof msg === 'string' ? decodeURIComponent(msg) : `${method} failed (${status}).`))
        }
      }
      s.on('response', (h) => {
        if (h['grpc-status'] !== undefined) finish(h) // trailers-only reply
      })
      s.on('trailers', finish)
      s.on('error', (e) => {
        if (failed) return
        failed = true
        clearTimeout(timer)
        reject(new GrpcError(14, e.message))
      })
      s.on('close', () => {
        clearTimeout(timer)
        if (!failed) resolve(reply)
      })
      s.end(frame(body))
    })
  }

  /** A server-streaming call. `onEnd` runs once, with the error if it ended badly. */
  stream(method: string, body: Buffer, onMessage: (msg: Buffer) => void, onEnd: (err?: Error) => void): () => void {
    if (this.isClosed) {
      queueMicrotask(() => onEnd(new GrpcError(14, 'The emulator connection is closed.')))
      return () => undefined
    }
    const s = this.request(method)
    let ended = false
    let cancelled = false
    const end = (err?: Error) => {
      if (ended) return
      ended = true
      onEnd(cancelled ? undefined : err)
    }
    const read = messageReader(onMessage)
    s.on('data', (chunk: Buffer) => {
      if (!read(chunk)) {
        end(new GrpcError(13, `${method}: unreadable message.`))
        s.close(http2.constants.NGHTTP2_CANCEL)
      }
    })
    const status = (h: http2.IncomingHttpHeaders) => {
      const code = Number(h['grpc-status'] ?? 0)
      if (code !== 0) {
        const msg = h['grpc-message']
        end(new GrpcError(code, typeof msg === 'string' ? decodeURIComponent(msg) : `${method} failed (${code}).`))
      }
    }
    s.on('response', (h) => {
      if (h['grpc-status'] !== undefined) status(h)
    })
    s.on('trailers', status)
    s.on('error', (e) => end(new GrpcError(14, e.message)))
    s.on('close', () => end())
    s.end(frame(body))
    return () => {
      cancelled = true
      if (!s.closed) s.close(http2.constants.NGHTTP2_CANCEL)
    }
  }

  close(): void {
    if (!this.session.destroyed) this.session.close()
  }
}
