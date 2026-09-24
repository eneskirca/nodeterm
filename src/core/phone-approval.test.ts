import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPhoneApprovals, PHONE_APPROVAL_TTL_MS } from './phone-approval'

afterEach(() => vi.useRealTimers())
describe('bounded handshake consent', () => {
  function setup() {
    vi.useFakeTimers()
    const persist = vi.fn(async (_pub: string) => {})
    const cleared = vi.fn()
    return { approvals: createPhoneApprovals({ persist, cleared }), persist, cleared }
  }
  it('requires both the issued id and displayed key, and consumes consent once', async () => {
    const { approvals, persist } = setup()
    const id = approvals.add('phone')
    for (const msg of [null, {}, { id }, { pub: 'phone' }, { id, pub: 'other' }, { id: 'stale', pub: 'phone' }]) {
      expect(await approvals.approve(msg)).toEqual({ status: 'stale' })
    }
    expect(persist).not.toHaveBeenCalled()
    expect(await approvals.approve({ id, pub: 'phone' })).toEqual({ status: 'persisted' })
    expect(persist).toHaveBeenCalledExactlyOnceWith('phone')
    expect(await approvals.approve({ id, pub: 'phone' })).toEqual({ status: 'stale' })
  })
  it('expires even if the timer callback has not run, and tells the UI which id died', async () => {
    const { approvals, persist, cleared } = setup()
    const id = approvals.add('phone')
    vi.setSystemTime(Date.now() + PHONE_APPROVAL_TTL_MS)
    expect(await approvals.approve({ id, pub: 'phone' })).toEqual({ status: 'stale' })
    expect(cleared).toHaveBeenCalledWith(id)
    expect(persist).not.toHaveBeenCalled()
  })
  it('expires, replaces, rejects and stops pending dialogs without pinning', async () => {
    const { approvals, persist, cleared } = setup()
    const old = approvals.add('phone')
    const fresh = approvals.add('phone')
    expect(cleared).toHaveBeenCalledWith(old)
    expect(await approvals.approve({ id: old, pub: 'phone' })).toEqual({ status: 'stale' })
    expect(approvals.reject({ id: fresh, pub: 'other' })).toBe(false)
    expect(approvals.reject({ id: fresh, pub: 'phone' })).toBe(true)
    const expired = approvals.add('phone')
    await vi.advanceTimersByTimeAsync(PHONE_APPROVAL_TTL_MS)
    expect(cleared).toHaveBeenCalledWith(expired)
    const stopped = approvals.add('phone')
    approvals.stop()
    expect(await approvals.approve({ id: stopped, pub: 'phone' })).toEqual({ status: 'stale' })
    expect(persist).not.toHaveBeenCalled()
  })
  it('bounds pending records from many distinct devices', async () => {
    const { approvals, cleared } = setup()
    const first = approvals.add('first')
    for (let i = 0; i < 64; i++) approvals.add(String(i))
    expect(cleared).toHaveBeenCalledWith(first)
    expect(await approvals.approve({ id: first, pub: 'first' })).toEqual({ status: 'stale' })
    approvals.stop()
  })
})
