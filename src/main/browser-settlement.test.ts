import { describe, it, expect, vi, afterEach } from 'vitest'
import { browserScroll, browserClick, settledViewport, type Driver, type LayoutMetrics } from './browser-actions'
import { RefTable } from './browser-refs'

const metrics = (scrollY = 0): LayoutMetrics => ({ width: 800, height: 600, scrollX: 0, scrollY, contentWidth: 800, contentHeight: 2000 })
afterEach(() => vi.useRealTimers())

describe('compositor scroll settlement', () => {
  it('waits through stale initial samples and animation, then reports measured movement', async () => {
    vi.useFakeTimers()
    let y = 0
    const s: Driver = {
      refreshViewport: async () => metrics(y),
      send: async () => {
        setTimeout(() => { y = 40 }, 100)
        setTimeout(() => { y = 180 }, 200)
        return {}
      }
    }
    const result = browserScroll(s, 'b1', '+200')
    await vi.runAllTimersAsync()
    expect(await result).toEqual({ ok: true, message: 'scrolled b1 down 180px (at 180/2000)' })
  })

  it('does not mistake an initial still frame for an off-screen target', async () => {
    vi.useFakeTimers()
    let y = 0
    setTimeout(() => { y = 200 }, 100)
    const send = vi.fn(async (method: string) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'doc' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 100, y: 700 - y, tag: 'button', w: 100, h: 20 } } }
      return {}
    })
    const result = browserClick({ send, refreshViewport: async () => metrics(y) }, new RefTable(), 'b1', '#button')
    await vi.runAllTimersAsync()
    expect((await result).ok).toBe(true)
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', y: 500 }))
  })

  it('refuses a continuously moving page within the polling budget', async () => {
    let y = 0
    const s: Driver = { send: async () => ({}), refreshViewport: async () => metrics(y++) }
    const sleep = vi.fn(async () => {})
    await expect(settledViewport(s, sleep)).rejects.toThrow('did not settle')
    expect(sleep).toHaveBeenCalledTimes(30)
  })
})

it('does not reattach a lease revoked during settlement', async () => {
  const refreshViewport = vi.fn(async () => metrics())
  const s: Driver = { send: async () => ({}), refreshViewport, isAttached: () => false }
  await expect(settledViewport(s, async () => {})).rejects.toThrow('lease detached')
  expect(refreshViewport).toHaveBeenCalledTimes(1)
})
