import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { emitLocalRelayClose, onLocalRelayClose } from './relay-local-close'

describe('local relay close', () => {
  it('tells the listeners of THAT connection, once each emit, and unsubscribes', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unA = onLocalRelayClose('c1', a)
    onLocalRelayClose('c2', b)
    emitLocalRelayClose('c1')
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    unA()
    emitLocalRelayClose('c1')
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('a listener that throws does not stop the others', () => {
    const ok = vi.fn()
    onLocalRelayClose('c3', () => { throw new Error('boom') })
    onLocalRelayClose('c3', ok)
    expect(() => emitLocalRelayClose('c3')).not.toThrow()
    expect(ok).toHaveBeenCalled()
  })
})

// Every relay transport now also hears a LOCAL close (frame-transport.ts), so a Team Access relay
// tab stays byte-identical only because nothing ever announces one for it. That is a claim about
// every call site, so it is checked here rather than trusted: each emit sits on a hosted-only path.

describe('local relay close: announced only on hosted paths (the Team Access guarantee)', () => {
  const root = join(__dirname, '..')
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n)
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : []
    })
  const callers = files(root)
    .map((p) => ({ p: p.slice(root.length + 1).replace(/\\/g, '/'), src: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }))
    .filter((f) => f.p !== 'bridge/relay-local-close.ts' && f.src.includes('emitLocalRelayClose('))

  it('is emitted from exactly the hosted relay api close and two hosted-only Canvas paths', () => {
    expect(callers.map((c) => c.p).sort()).toEqual(['bridge/relay-api.ts', 'canvas/Canvas.tsx'])
    const relayApi = callers.find((c) => c.p === 'bridge/relay-api.ts')!.src
    expect(relayApi.match(/emitLocalRelayClose\(/g)).toHaveLength(1)
    expect(relayApi).toContain('if (hosted) emitLocalRelayClose(connectionId)')
    const canvas = callers.find((c) => c.p === 'canvas/Canvas.tsx')!.src
    expect(canvas.match(/emitLocalRelayClose\(/g)).toHaveLength(2)
    expect(canvas).toContain('if (hosted) emitLocalRelayClose(connectionId)')
    // The other one is the hosted joiner's own `disconnect` (it only ever holds hosted connections).
    const joiner = canvas.slice(canvas.indexOf('const joiner = createHostedJoiner({'), canvas.indexOf('}, [confirmAndMount])'))
    expect(joiner).toContain('emitLocalRelayClose(id)')
  })
})
