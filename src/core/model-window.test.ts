import { describe, expect, it } from 'vitest'
import { sessionContextWindow } from './model-window'

describe('sessionContextWindow', () => {
  it('accepts the session override without rounding to a model family window', () => {
    expect(sessionContextWindow('1048576')).toBe(1_048_576)
    expect(sessionContextWindow('32768')).toBe(32_768)
  })
  it.each(['', '0', '-1', '1.5', '1e6', '200000junk', 'Infinity', 'NaN', '9007199254740992', ' 32000', undefined, null, 32000])('rejects invalid value %s', value => {
    expect(sessionContextWindow(value)).toBeNull()
  })
})
