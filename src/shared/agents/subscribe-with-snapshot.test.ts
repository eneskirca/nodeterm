import { expect, it, vi } from 'vitest'
import { subscribeWithSnapshot } from './subscribe-with-snapshot'

it('falls back to buffered live events when the snapshot is unsupported', async () => {
  let live!: (e: string) => void
  const delivered: string[] = []
  const stop = subscribeWithSnapshot<string>(fn => { live = fn; return () => {} },
    () => Promise.reject(new Error('unsupported')), event => delivered.push(event))
  live('waiting')
  await Promise.resolve()
  live('done')
  expect(delivered).toEqual(['waiting', 'done'])
  stop()
})

it('discards a snapshot that settles after unsubscribe', async () => {
  let finish!: (events: string[]) => void
  const listener = vi.fn()
  const stop = subscribeWithSnapshot<string>(() => () => {},
    () => new Promise(resolve => { finish = resolve }), listener)
  stop()
  finish(['old-start'])
  await Promise.resolve()
  expect(listener).not.toHaveBeenCalled()
})

it('applies the snapshot before racing live events, and stops after unsubscribe', async () => {
  let live!: (e: string) => void
  let resolve!: (e: string[]) => void
  const delivered: string[] = []
  const off = vi.fn()
  const unsubscribe = subscribeWithSnapshot<string>((fn) => { live = fn; return off },
    () => new Promise((r) => { resolve = r }), (e) => delivered.push(e))
  live('end')
  resolve(['start'])
  await Promise.resolve()
  expect(delivered).toEqual(['start', 'end'])
  unsubscribe()
  live('ignored')
  expect(delivered).toEqual(['start', 'end'])
  expect(off).toHaveBeenCalledOnce()
})
