import { afterEach, describe, expect, it } from 'vitest'
import {
  CANVAS_LOCK_KEY,
  parseCanvasLocked,
  readCanvasLocked,
  writeCanvasLocked
} from './canvasLock'

const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function installStorage(impl: Partial<Storage>): void {
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true })
}

function memoryStorage(seed: Record<string, string> = {}): { store: Record<string, string> } {
  const store = { ...seed }
  installStorage({
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    }
  } as Partial<Storage>)
  return { store }
}

afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'localStorage', real)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('parseCanvasLocked', () => {
  it('is off unless the flag is exactly 1', () => {
    expect(parseCanvasLocked(null)).toBe(false)
    expect(parseCanvasLocked('')).toBe(false)
    expect(parseCanvasLocked('0')).toBe(false)
    expect(parseCanvasLocked('true')).toBe(false)
    expect(parseCanvasLocked('1')).toBe(true)
  })
})

describe('readCanvasLocked / writeCanvasLocked', () => {
  it('round-trips the lock through the namespaced key', () => {
    const { store } = memoryStorage()
    expect(readCanvasLocked()).toBe(false)

    writeCanvasLocked(true)
    expect(store[CANVAS_LOCK_KEY]).toBe('1')
    expect(readCanvasLocked()).toBe(true)

    // Unlocking must persist too, or a lock could never be cleared for the next launch.
    writeCanvasLocked(false)
    expect(store[CANVAS_LOCK_KEY]).toBe('0')
    expect(readCanvasLocked()).toBe(false)
  })

  it('restores a lock written by a previous launch', () => {
    memoryStorage({ [CANVAS_LOCK_KEY]: '1' })
    expect(readCanvasLocked()).toBe(true)
  })

  it('reads unlocked when storage throws, and a failed write never throws', () => {
    installStorage({
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('quota')
      }
    } as Partial<Storage>)

    expect(readCanvasLocked()).toBe(false)
    expect(() => writeCanvasLocked(true)).not.toThrow()
  })

  it('reads unlocked when localStorage exists but has no methods (Node global, #412)', () => {
    installStorage({} as Partial<Storage>)
    expect(readCanvasLocked()).toBe(false)
    expect(() => writeCanvasLocked(true)).not.toThrow()
  })
})
