import { describe, it, expect } from 'vitest'
import { effectiveSize, latestClaimSize } from './pty-size'
import { IPC } from '../shared/ipc'

describe('effectiveSize', () => {
  it('is the subscriber s own size when there is exactly one (single-user path)', () => {
    expect(effectiveSize([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 })
  })

  it('takes the smallest cols and the smallest rows independently', () => {
    // The narrow client and the short client can be different people.
    expect(
      effectiveSize([
        { cols: 120, rows: 24 },
        { cols: 80, rows: 60 }
      ])
    ).toEqual({ cols: 80, rows: 24 })
  })

  it('floors at 1 (node-pty throws on 0) and ignores non-finite sizes', () => {
    expect(effectiveSize([{ cols: 0, rows: 0 }])).toEqual({ cols: 1, rows: 1 })
    expect(effectiveSize([{ cols: 80, rows: 24 }, { cols: NaN, rows: 10 }])).toEqual({
      cols: 80,
      rows: 10
    })
  })

  it('returns null for an empty subscriber set', () => {
    expect(effectiveSize([])).toBeNull()
  })

  it('floors to integers (node-pty resize() rejects fractional cols/rows)', () => {
    // xterm's fit addon can hand us a fractional measurement on a zoomed/HiDPI canvas.
    expect(effectiveSize([{ cols: 80.7, rows: 24.9 }])).toEqual({ cols: 80, rows: 24 })
    // Flooring must not undercut the >=1 clamp: 0.5 cols is still a 1-col pty, not 0.
    expect(effectiveSize([{ cols: 0.5, rows: 0.5 }])).toEqual({ cols: 1, rows: 1 })
  })
})

describe('per-session channels', () => {
  it('exposes the authoritative-size and closed channels', () => {
    expect(IPC.ptySize('pty-1')).toBe('pty:size:pty-1')
    expect(IPC.ptyClosed('pty-1')).toBe('pty:closed:pty-1')
  })
})

describe('latestClaimSize (issue #914)', () => {
  it('is null with no claims', () => {
    expect(latestClaimSize([])).toBeNull()
  })

  it('gives the session to the most recently active claim, not the smallest', () => {
    // A desktop node (short) and a phone that just dismissed its keyboard (tall).
    const desktop = { cols: 120, rows: 30, recency: 1 }
    const phone = { cols: 120, rows: 40, recency: 2 }
    expect(latestClaimSize([desktop, phone])).toEqual({ cols: 120, rows: 40 })
    expect(latestClaimSize([{ ...desktop, recency: 3 }, phone])).toEqual({ cols: 120, rows: 30 })
  })

  it('never grows the session past a viewer that cannot adapt to it', () => {
    const phone = { cols: 45, rows: 40, recency: 1, bounding: true }
    const desktop = { cols: 120, rows: 30, recency: 2 }
    // Desktop is latest, but the phone would wrap a 120-column pty: cols clamp, rows follow desktop.
    expect(latestClaimSize([phone, desktop])).toEqual({ cols: 45, rows: 30 })
    // Phone latest: its own size, which is within its own ceiling.
    expect(latestClaimSize([{ ...phone, recency: 3 }, desktop])).toEqual({ cols: 45, rows: 40 })
  })

  it('breaks a recency tie toward the later claim', () => {
    expect(
      latestClaimSize([
        { cols: 80, rows: 24, recency: 0 },
        { cols: 100, rows: 50, recency: 0 }
      ])
    ).toEqual({ cols: 100, rows: 50 })
  })

  it('floors and clamps exactly like effectiveSize', () => {
    expect(latestClaimSize([{ cols: 90.9, rows: 0, recency: 1 }])).toEqual({ cols: 90, rows: 1 })
  })
})
