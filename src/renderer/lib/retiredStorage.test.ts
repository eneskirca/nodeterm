import { describe, expect, it } from 'vitest'
import { RETIRED_STORAGE_KEYS, removeRetiredStorageKeys } from './retiredStorage'

describe('removeRetiredStorageKeys', () => {
  it('removes exactly the three live-link keys, in order', () => {
    const removed: string[] = []
    removeRetiredStorageKeys({ removeItem: (k: string) => void removed.push(k) })
    expect(removed).toEqual(['nodeterm.liveLinkDefaults', 'nodeterm.liveChatPinned', 'nodeterm.liveChatLink'])
    expect([...RETIRED_STORAGE_KEYS]).toEqual(removed)
  })

  it('a storage that throws costs that key only, never the boot', () => {
    const tried: string[] = []
    const storage = {
      removeItem: (k: string) => {
        tried.push(k)
        if (k === 'nodeterm.liveLinkDefaults') throw new Error('SecurityError')
      }
    }
    expect(() => removeRetiredStorageKeys(storage)).not.toThrow()
    expect(tried).toEqual([...RETIRED_STORAGE_KEYS])
  })

  it('no storage at all is a no-op', () => {
    expect(() => removeRetiredStorageKeys(null)).not.toThrow()
    expect(() => removeRetiredStorageKeys(undefined)).not.toThrow()
  })
})
