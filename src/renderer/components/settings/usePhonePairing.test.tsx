// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '@renderer/state/settings'
import { usePhonePairing } from './usePhonePairing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,QR' }))
let root: Root
let host: HTMLElement
let api!: ReturnType<typeof usePhonePairing>
let save: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let callbacks: Array<(result: { ok: boolean }) => void>
function Harness(): React.JSX.Element { api = usePhonePairing(); return <p>{api.phase}:{api.busy ? 'busy' : 'idle'}:{api.error}</p> }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { resolve, promise }
}
const response = { payload: '{"v":1,"host":"192.168.1.42"}', sshOpen: true, relayPlan: 'off' }
beforeEach(async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } })
  save = vi.fn(async () => undefined)
  start = vi.fn(async () => response)
  stop = vi.fn(async () => undefined)
  callbacks = []
  window.nodeTerminal = { settings: { save }, pairing: { start, stop, probeSsh: async () => true,
    onDone: (callback: typeof callbacks[number]) => { callbacks.push(callback); return () => {} } } } as unknown as typeof window.nodeTerminal
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('shared pairing listener lifecycle', () => {
  it('waits for settings persistence before starting Settings or quick-pair', async () => {
    const held = deferred<void>()
    save.mockReturnValueOnce(held.promise)
    let pending!: Promise<void>
    await act(async () => { pending = api.start() })
    expect(start).not.toHaveBeenCalled()
    await act(async () => held.resolve())
    await pending
    expect(start).toHaveBeenCalledTimes(1)
    expect(api.phase).toBe('waiting')
  })

  it('never starts a listener after the view closes during settings persistence', async () => {
    const held = deferred<void>()
    save.mockReturnValueOnce(held.promise)
    let pending!: Promise<void>
    await act(async () => { pending = api.start() })
    await act(async () => root.render(null))
    await act(async () => held.resolve())
    await pending
    expect(start).not.toHaveBeenCalled()
  })

  it('retires a late native start reply after unmount rather than leaving a headless pairing listener', async () => {
    const held = deferred<typeof response>()
    start.mockReturnValueOnce(held.promise)
    let pending!: Promise<void>
    await act(async () => { pending = api.start() })
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => root.render(null))
    await act(async () => held.resolve(response))
    await pending
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('orders overlapping starts and discards the retired reply before its replacement is invoked', async () => {
    const held = deferred<typeof response>()
    start.mockReturnValueOnce(held.promise)
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => { first = api.start() })
    await act(async () => { second = api.start() })
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => held.resolve(response))
    await Promise.all([first, second])
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(2)
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[1])
    expect(api.phase).toBe('waiting')
  })

  it('does not publish a retired first reply while its replacement waits for a second save', async () => {
    const native = deferred<typeof response>()
    start.mockReturnValueOnce(native.promise)
    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => { first = api.start() })
    const saved = deferred<void>()
    save.mockReturnValueOnce(saved.promise)
    await act(async () => { second = api.start() })
    await act(async () => native.resolve(response))
    await first
    expect(save).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledTimes(1)
    expect(api.phase).toBe('idle')
    expect(api.qr).toBe('')
    expect(api.busy).toBe(true)
    await act(async () => saved.resolve())
    await second
    expect(start).toHaveBeenCalledTimes(2)
    expect(api.phase).toBe('waiting')
  })

  it('an old view cannot close a newer view’s listener or consume its completion event', async () => {
    let old!: ReturnType<typeof usePhonePairing>
    function Both({ newer }: { newer: boolean }): React.JSX.Element {
      old = usePhonePairing()
      return newer ? <Harness /> : <p>old</p>
    }
    await act(async () => root.render(<Both newer={false} />))
    await act(async () => old.start())
    await act(async () => root.render(<Both newer />))
    await act(async () => api.start())
    const stops = stop.mock.calls.length
    await act(async () => old.stop())
    expect(stop).toHaveBeenCalledTimes(stops)
    await act(async () => callbacks.forEach((callback) => callback({ ok: true })))
    expect(api.phase).toBe('paired')
    expect(old.phase).toBe('idle')
  })

  it('keeps a settings failure visible and never starts a code without the saved choice', async () => {
    save.mockRejectedValueOnce(new Error('cannot save settings'))
    await act(async () => api.start())
    expect(start).not.toHaveBeenCalled()
    expect(api.error).toBe('cannot save settings')
    expect(api.busy).toBe(false)
  })
})
