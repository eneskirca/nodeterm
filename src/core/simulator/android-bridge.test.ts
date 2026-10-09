import { describe, expect, it } from 'vitest'
import { inputCall } from './android-bridge'
import { decodeFields, num } from './android-grpc'

const s = { panel: { w: 1080, h: 2424 } }

describe('Android input', () => {
  it('turns a ratio into panel pixels', () => {
    const [method, body] = inputCall(s, { t: 'down', x: 1, y: 0.5 })!
    expect(method).toBe('sendTouch')
    const t = decodeFields(decodeFields(body).get(1)![0] as Buffer)
    expect([num(t, 1), num(t, 2), num(t, 4)]).toEqual([1079, 1212, 1024])
  })

  it('maps buttons to the emulator key names, and refuses iOS-only ones', () => {
    const [, body] = inputCall(s, { t: 'button', name: 'back' })!
    expect((decodeFields(body).get(4)![0] as Buffer).toString()).toBe('GoBack')
    expect(inputCall(s, { t: 'button', name: 'siri' })).toBeNull()
  })

  it('rotates by the measured angles: portrait 0, turned left 90', () => {
    const z = (value: number) => {
      const [, body] = inputCall(s, { t: 'orientation', value })!
      return (decodeFields(decodeFields(body).get(3)![0] as Buffer).get(1)![0] as Buffer).readFloatLE(8)
    }
    expect(z(1)).toBe(0)
    expect(z(3)).toBe(90)
    expect(z(4)).toBe(-90)
    expect(z(2)).toBe(180)
  })
})
