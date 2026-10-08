import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposedPty, COMPOSED_TICKET_TTL_MS, waitForComposedEnter } from './composed-pty'

const owner = {}, foreign = {}
const paste = { kind: 'paste', text: 'one\r\ntwo\nΩ\x1b\x9b', enter: true } as const
const panes: ComposedPty[] = []
function fixture(bracketed = true) {
  const write = vi.fn(), mode = vi.fn(async () => bracketed)
  const pane = new ComposedPty({ bracketed: mode, write }); panes.push(pane)
  const prepare = (value: unknown = paste, who = owner) => {
    const result = pane.prepare(who, value, () => true)
    expect(result.status).toBe('prepared')
    if (result.status !== 'prepared') throw new Error('fixture could not prepare')
    return result.ticket
  }
  return { pane, mode, write, prepare }
}
afterEach(() => { panes.splice(0).forEach((p) => p.dispose()); vi.useRealTimers() })

describe('explicit composed input on a captured direct PTY', () => {
  it.each([true, false])('normalizes a full paste and separates Enter by at least 150 ms (mode=%s)', async (bracketed) => {
    const { pane, write, prepare } = fixture(bracketed)
    const ticket = prepare()
    expect(await pane.write(owner, ticket, 'paste', () => true)).toEqual({ status: 'awaiting-enter' })
    expect(write.mock.calls).toEqual([[bracketed ? '\x1b[200~one\rtwo\rΩ\x1b[201~' : 'one\rtwo\rΩ']])
    expect(pane.prepare(foreign, paste, () => true).status).toBe('refused')
    await waitForComposedEnter()
    expect(await pane.write(owner, ticket, 'enter', () => true)).toEqual({ status: 'delivered' })
    expect(write.mock.calls.at(-1)).toEqual(['\r'])
    expect((await pane.write(owner, ticket, 'paste', () => true)).status).toBe('refused')
    expect((await pane.write(owner, ticket, 'enter', () => true)).status).toBe('refused')
    expect(write).toHaveBeenCalledTimes(2)
  })
  it('never frames a raw Ctrl, queries paste mode or appends Enter', async () => {
    const { pane, mode, write, prepare } = fixture()
    const ticket = prepare({ kind: 'control', text: '\x03', enter: false })
    expect(await pane.write(owner, ticket, 'paste', () => true)).toEqual({ status: 'delivered' })
    expect(write.mock.calls).toEqual([['\x03']]); expect(mode).not.toHaveBeenCalled()
  })
  it('refuses foreign tickets and malformed inputs without releasing the rightful action', async () => {
    const { pane, write, prepare } = fixture()
    for (const input of [{ ...paste, text: 'nul\0' }, { kind: 'control', text: '\x03', enter: true },
      { ...paste, text: 'é'.repeat(131_073) }]) expect(pane.prepare(owner, input, () => true).status).toBe('refused')
    const ticket = prepare()
    expect((await pane.write(owner, 'foreign-ticket', 'paste', () => true)).status).toBe('refused')
    expect((await pane.write(foreign, ticket, 'paste', () => true)).status).toBe('refused')
    expect(pane.cancel(foreign, ticket).status).toBe('refused')
    expect(pane.prepare(foreign, paste, () => true).status).toBe('refused')
    expect(write).not.toHaveBeenCalled()
  })
  it('consumes the paste phase before its mode await and keeps it consumed while Enter is pending', async () => {
    const { pane, mode, write, prepare } = fixture()
    let release!: (mode: boolean) => void
    mode.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const ticket = prepare(), first = pane.write(owner, ticket, 'paste', () => true)
    expect((await pane.write(owner, ticket, 'paste', () => true)).status).toBe('refused')
    release(true); expect((await first).status).toBe('awaiting-enter')
    expect((await pane.write(owner, ticket, 'paste', () => true)).status).toBe('refused')
    expect(write).toHaveBeenCalledTimes(1)
    await waitForComposedEnter()
    expect((await pane.write(owner, ticket, 'enter', () => true)).status).toBe('delivered')
    expect(write).toHaveBeenCalledTimes(2)
  })
  it('rechecks mode-barrier lifetime and expires preparation without ever writing', async () => {
    const { pane, mode, write, prepare } = fixture()
    let release!: (mode: boolean) => void, current = true
    mode.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const ticket = prepare(), result = pane.write(owner, ticket, 'paste', () => current)
    current = false; release(true)
    expect((await result).status).toBe('refused'); expect(write).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const expired = prepare(); await vi.advanceTimersByTimeAsync(COMPOSED_TICKET_TTL_MS)
    expect((await pane.write(owner, expired, 'paste', () => true)).status).toBe('refused')
    expect(prepare()).not.toBe(expired)
  })
  it('reports retirement, early Enter and throwing writes as uncertain after possible paste without replay', async () => {
    for (const failure of ['retire', 'early', 'throw'] as const) {
      const { pane, write, prepare } = fixture()
      const ticket = prepare()
      expect((await pane.write(owner, ticket, 'paste', () => true)).status).toBe('awaiting-enter')
      if (failure === 'retire') pane.releaseOwner(owner)
      if (failure === 'throw') { await waitForComposedEnter(); write.mockImplementationOnce(() => { throw new Error('native write lost') }) }
      const result = await pane.write(owner, ticket, 'enter', () => true)
      expect(result.status).toBe(failure === 'retire' ? 'refused' : 'uncertain')
      expect((await pane.write(owner, ticket, 'paste', () => true)).status).toBe('refused')
      expect(write).toHaveBeenCalledTimes(failure === 'throw' ? 2 : 1)
    }
  })
})
