import http2 from 'node:http2'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EmulatorClient,
  decodeFields,
  decodeImage,
  fBytes,
  fInt,
  gpsState,
  imageFormat,
  messageReader,
  num,
  rotationModel,
  touchEvent,
  usbKeyEvent,
  varint
} from './android-grpc'

describe('protobuf codec', () => {
  it('encodes varints the way protobuf does', () => {
    expect([...varint(1)]).toEqual([1])
    expect([...varint(300)]).toEqual([0xac, 0x02])
    // A negative int32 is ten bytes of two's complement.
    expect(varint(-1).length).toBe(10)
  })

  it('round-trips nested messages', () => {
    const img = Buffer.concat([fBytes(1, imageFormat(0, 540, 1212)), fBytes(4, Buffer.from('PNGDATA'))])
    expect(decodeImage(img)).toEqual({ width: 540, height: 1212, image: Buffer.from('PNGDATA') })
  })

  it('sends a touch in panel pixels with pressure, and a lift as pressure 0', () => {
    const down = decodeFields(decodeFields(touchEvent(540.4, 1200, 1024)).get(1)![0] as Buffer)
    expect([num(down, 1), num(down, 2), num(down, 4)]).toEqual([540, 1200, 1024])
    const up = decodeFields(decodeFields(touchEvent(0, 0, 0)).get(1)![0] as Buffer)
    expect(num(up, 4)).toBe(0)
  })

  it('sends a key as the full USB usage (page 7), as the emulator needs', () => {
    const f = decodeFields(usbKeyEvent(0x04, 1))
    expect(num(f, 3)).toBe(0x70004)
    expect(num(f, 2)).toBe(1)
  })

  it('encodes a rotation as three packed floats', () => {
    const f = decodeFields(rotationModel(90))
    expect(num(f, 1)).toBe(1)
    const data = decodeFields(f.get(3)![0] as Buffer).get(1)![0] as Buffer
    expect([data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8)]).toEqual([0, 0, 90])
  })

  it('encodes GPS coordinates as doubles', () => {
    const b = gpsState(37.5, -122.25)
    // field 2, wire type 1 → key 0x11; field 3 → 0x19
    expect(b[0]).toBe(0x11)
    expect(b.readDoubleLE(1)).toBe(37.5)
    expect(b[9]).toBe(0x19)
    expect(b.readDoubleLE(10)).toBe(-122.25)
  })

  it('refuses a truncated message instead of reading past it', () => {
    expect(() => decodeFields(Buffer.from([0x22, 0x05, 0x01]))).toThrow()
  })

  it('splits a body into gRPC messages across chunk boundaries', () => {
    const got: string[] = []
    const read = messageReader((m) => got.push(m.toString()))
    const frame = (s: string) => {
      const h = Buffer.alloc(5)
      h.writeUInt32BE(s.length, 1)
      return Buffer.concat([h, Buffer.from(s)])
    }
    const body = Buffer.concat([frame('one'), frame('two')])
    expect(read(body.subarray(0, 6))).toBe(true)
    expect(read(body.subarray(6))).toBe(true)
    expect(got).toEqual(['one', 'two'])
    expect(messageReader(() => undefined)(Buffer.from([1, 0, 0, 0, 0]))).toBe(false)
  })

  it('omits zero fields, as protobuf defaults', () => {
    expect(fInt(3, 0).length).toBe(0)
  })
})

describe('EmulatorClient', () => {
  let server: http2.Http2Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  function start(handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, body: Buffer) => void): Promise<number> {
    server = http2.createServer()
    server.on('stream', (stream, headers) => {
      const parts: Buffer[] = []
      stream.on('data', (d: Buffer) => parts.push(d))
      stream.on('end', () => handler(stream as http2.ServerHttp2Stream, headers, Buffer.concat(parts)))
    })
    return new Promise((r) => server!.listen(0, '127.0.0.1', () => r((server!.address() as AddressInfo).port)))
  }

  const frame = (msg: Buffer) => {
    const h = Buffer.alloc(5)
    h.writeUInt32BE(msg.length, 1)
    return Buffer.concat([h, msg])
  }

  it('sends the bearer token and method, and resolves the reply', async () => {
    let seen: http2.IncomingHttpHeaders = {}
    const port = await start((stream, headers, body) => {
      seen = headers
      expect(body.subarray(5).toString()).toBe('ping')
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      stream.end(frame(Buffer.from('pong')))
    })
    const c = new EmulatorClient({ port, token: 'secret-token' })
    const reply = await c.unary('getStatus', Buffer.from('ping'))
    c.close()
    expect(reply.toString()).toBe('pong')
    expect(seen.authorization).toBe('Bearer secret-token')
    expect(seen[':path']).toBe('/android.emulation.control.EmulatorController/getStatus')
  })

  it('rejects with the gRPC status the emulator answers', async () => {
    const port = await start((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16', 'grpc-message': 'bad%20token' }, { endStream: true })
    })
    const c = new EmulatorClient({ port, token: 'wrong-token' })
    await expect(c.unary('getStatus', Buffer.alloc(0))).rejects.toMatchObject({ code: 16, message: 'bad token' })
    c.close()
  })

  it('streams messages until the server ends, then calls onEnd once', async () => {
    const port = await start((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      stream.write(frame(Buffer.from('a')))
      stream.end(frame(Buffer.from('b')))
    })
    const c = new EmulatorClient({ port, token: 'secret-token' })
    const got: string[] = []
    let ends = 0
    await new Promise<void>((resolve) =>
      c.stream('streamScreenshot', Buffer.alloc(0), (m) => got.push(m.toString()), () => {
        ends++
        resolve()
      })
    )
    c.close()
    expect(got).toEqual(['a', 'b'])
    expect(ends).toBe(1)
  })
})
