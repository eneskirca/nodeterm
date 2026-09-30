// src/shared/relay-join-errors.test.ts
import { describe, it, expect } from 'vitest'
import { JOIN_ERROR_CODES, joinErrorCode, joinErrorRetries, joinRetryAfterMs } from './relay-join-errors'

describe('hosted join error codes', () => {
  it('reads each code off the message main threw, and off the one Electron hands the renderer', () => {
    for (const code of JOIN_ERROR_CODES) {
      expect(joinErrorCode(`[${code}] something happened`)).toBe(code)
      // ipcRenderer.invoke rejects with main's message wrapped in its own prefix.
      expect(joinErrorCode(`Error invoking remote method 'relay:client:connect': Error: [${code}] something happened`)).toBe(code)
    }
  })

  it('answers null for anything that is not one of ours', () => {
    expect(joinErrorCode('That pairing code is invalid or incomplete.')).toBeNull()
    expect(joinErrorCode('[E_JOIN_SOMETHING_NEW] x')).toBeNull()
    expect(joinErrorCode('[e_join_network] x')).toBeNull()
    expect(joinErrorCode('')).toBeNull()
    expect(joinErrorCode(undefined as unknown as string)).toBeNull()
  })

  it('only a network failure and the per-network throttle are worth retrying', () => {
    expect(JOIN_ERROR_CODES.filter(joinErrorRetries)).toEqual(['E_JOIN_NETWORK', 'E_JOIN_THROTTLED'])
    expect(joinErrorRetries(null)).toBe(false)
  })

  it('R41: E_JOIN_THROTTLED (the per-IP limiter, clears within a minute) retries; E_JOIN_RATE (the daily damper) does not', () => {
    expect(joinErrorCode('[E_JOIN_THROTTLED] limiting')).toBe('E_JOIN_THROTTLED')
    expect(joinErrorRetries('E_JOIN_THROTTLED')).toBe(true)
    expect(joinErrorRetries('E_JOIN_RATE')).toBe(false)
  })

  it('R41: reads a Retry-After main attached, and nothing else', () => {
    expect(joinRetryAfterMs("Error invoking remote method 'x': Error: [E_JOIN_THROTTLED] limiting [retry-after:120]")).toBe(120_000)
    expect(joinRetryAfterMs('[E_JOIN_THROTTLED] limiting')).toBeNull()
    expect(joinRetryAfterMs('[retry-after:abc]')).toBeNull()
    expect(joinRetryAfterMs(undefined as unknown as string)).toBeNull()
  })

  it('E_JOIN_BUSY is a code of its own (another attempt of ours is running), and it never retries', () => {
    expect(JOIN_ERROR_CODES).toContain('E_JOIN_BUSY')
    expect(joinErrorCode('[E_JOIN_BUSY] Already joining this team; wait for that attempt to finish.')).toBe('E_JOIN_BUSY')
    expect(joinErrorRetries('E_JOIN_BUSY')).toBe(false)
  })
})
