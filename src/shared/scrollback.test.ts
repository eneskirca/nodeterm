import { describe, expect, it } from 'vitest'
import { clampEmulatorScrollback, xtermScrollback } from './scrollback'

describe('xtermScrollback', () => {
  it.each([
    [50000, 10000],
    [10000, 10000],
    [5000, 5000],
    [1000, 1000],
    [500, 1000],
    [0, 1000]
  ])('maps tmuxScrollback %i to %i', (input, expected) => {
    expect(xtermScrollback(input)).toBe(expected)
  })
})

describe('clampEmulatorScrollback (host-side bound)', () => {
  it.each([
    [50000, 10000],
    [10000, 10000],
    [2000, 2000],
    // No floor: the protocol-v1 warm-only sentinel sends 1 and must not be reinterpreted.
    [1, 1],
    [0, 0],
    [-5, 0],
    [123.9, 123],
    [Number.NaN, 10000],
    [Number.POSITIVE_INFINITY, 10000]
  ])('clamps %s to %i', (input, expected) => {
    expect(clampEmulatorScrollback(input)).toBe(expected)
  })
})
