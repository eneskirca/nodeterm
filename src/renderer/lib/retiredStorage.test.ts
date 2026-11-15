import fs from 'fs'
import path from 'path'
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

// A dropped call compiles; this is the only thing that notices one.
describe('renderer boot', () => {
  it('removes the retired keys before the React root renders, through lib/localStore', () => {
    const boot = fs.readFileSync(path.join(__dirname, '..', 'boot.tsx'), 'utf8').replace(/\r\n/g, '\n')
    const call = boot.indexOf('removeRetiredStorageKeys({ removeItem: removeLocal })')
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(boot.indexOf('ReactDOM.createRoot('))
  })
})
