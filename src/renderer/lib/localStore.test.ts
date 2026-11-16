// The bug this file exists for: a `localStorage` global that EXISTS but has no methods. Recent Node
// ships exactly that unless `--localstorage-file` is passed, so `typeof localStorage === 'undefined'`
// — the guard five call sites used — reports 'object' and lets the call through. See #412.
//
// Each case installs a different broken shape on globalThis and asserts the helper survives it. The
// method-less one is the real regression; the others are the browser failures that were already
// handled and must stay handled.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLocal, removeLocal, writeLocal } from './localStore'

const KEY = 'nodeterm.test.key'

function install(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, 'localStorage')
  vi.restoreAllMocks()
})

describe('readLocal', () => {
  it('returns the stored string when storage works', () => {
    install({ getItem: (k: string) => (k === KEY ? 'stored' : null), setItem: () => {} })
    expect(readLocal(KEY)).toBe('stored')
  })

  it('returns null for a key that is not set', () => {
    install({ getItem: () => null, setItem: () => {} })
    expect(readLocal(KEY)).toBeNull()
  })

  // THE regression: the object is there, `typeof` says 'object', and the method is not.
  it('survives a method-less global (Node without --localstorage-file)', () => {
    install({})
    expect(() => readLocal(KEY)).not.toThrow()
    expect(readLocal(KEY)).toBeNull()
  })

  it('survives a global whose getItem is not callable', () => {
    install({ getItem: 'nope' })
    expect(readLocal(KEY)).toBeNull()
  })

  it('survives storage that throws on access (private mode, locked-down embedder)', () => {
    install({
      getItem: () => {
        throw new Error('SecurityError')
      }
    })
    expect(readLocal(KEY)).toBeNull()
  })

  it('survives the global being absent entirely', () => {
    Reflect.deleteProperty(globalThis as object, 'localStorage')
    expect(readLocal(KEY)).toBeNull()
  })
})

describe('writeLocal', () => {
  it('writes through when storage works', () => {
    const setItem = vi.fn()
    install({ getItem: () => null, setItem })
    writeLocal(KEY, 'v')
    expect(setItem).toHaveBeenCalledWith(KEY, 'v')
  })

  it('is silent on a method-less global', () => {
    install({})
    expect(() => writeLocal(KEY, 'v')).not.toThrow()
  })

  it('is silent when the write throws (quota exceeded)', () => {
    install({
      setItem: () => {
        throw new Error('QuotaExceededError')
      }
    })
    expect(() => writeLocal(KEY, 'v')).not.toThrow()
  })

  it('is silent when the global is absent entirely', () => {
    Reflect.deleteProperty(globalThis as object, 'localStorage')
    expect(() => writeLocal(KEY, 'v')).not.toThrow()
  })
})

describe('removeLocal', () => {
  it('removes through when storage works', () => {
    const removeItem = vi.fn()
    install({ removeItem })
    removeLocal(KEY)
    expect(removeItem).toHaveBeenCalledWith(KEY)
  })

  it('is silent on a method-less global', () => {
    install({})
    expect(() => removeLocal(KEY)).not.toThrow()
  })

  it('is silent when the removal throws (a blocked origin)', () => {
    install({
      removeItem: () => {
        throw new Error('SecurityError')
      }
    })
    expect(() => removeLocal(KEY)).not.toThrow()
  })

  it('is silent when the global is absent entirely', () => {
    Reflect.deleteProperty(globalThis as object, 'localStorage')
    expect(() => removeLocal(KEY)).not.toThrow()
  })
})

describe('readLocal fallback — the distinction the copy hint depends on', () => {
  // These four cases ARE `hintSeen()`. It reads `readLocal(KEY, '1') === '1'`, so the fallback is
  // the whole behaviour: unreadable storage must count as seen (or the hint returns on every copy),
  // while a key that is merely unset must not.
  it('an UNSET key returns null, not the fallback — still "not seen"', () => {
    install({ getItem: () => null, setItem: () => {} })
    expect(readLocal(KEY, '1')).toBeNull()
  })

  it('a method-less global returns the fallback — "seen"', () => {
    install({})
    expect(readLocal(KEY, '1')).toBe('1')
  })

  it('storage that THROWS returns the fallback — "seen"', () => {
    // The regression an earlier draft of this change shipped: a callable getItem that throws left
    // the hint showing on every copy, because the throw was collapsed into "no value".
    install({
      getItem: () => {
        throw new Error('SecurityError')
      }
    })
    expect(readLocal(KEY, '1')).toBe('1')
  })

  it('a stored value still wins over the fallback', () => {
    install({ getItem: () => '1', setItem: () => {} })
    expect(readLocal(KEY, '1')).toBe('1')
    install({ getItem: () => 'other', setItem: () => {} })
    expect(readLocal(KEY, '1')).toBe('other')
  })
})

describe('the old guard would NOT have caught this', () => {
  // Mutation-testing the fix from the other side: pin that the pattern being banned is genuinely
  // broken on the shape that broke it, so this suite fails if someone "simplifies" the helper back.
  it('typeof localStorage === undefined passes a method-less global', () => {
    install({})
    expect(typeof localStorage).toBe('object')
    expect(typeof localStorage === 'undefined').toBe(false)
    expect(() => (localStorage as Storage).getItem(KEY)).toThrow(TypeError)
  })
})
