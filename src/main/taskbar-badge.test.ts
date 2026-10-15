import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { badgeLabel, planBadge, rasterizeBadge } from './taskbar-badge'

describe('planBadge', () => {
  it('macOS: only the Dock string, same as before', () => {
    expect(planBadge('darwin', 3, 0, false)).toEqual({ dock: '3' })
    expect(planBadge('darwin', 0, 3, false)).toEqual({ dock: '' })
  })
  it('Windows: count 0 clears the overlay and never flashes', () => {
    expect(planBadge('win32', 0, 2, false)).toEqual({ overlay: null, flash: false })
  })
  it('Windows: a rise while unfocused flashes; while focused it does not', () => {
    expect(planBadge('win32', 2, 1, false)).toEqual({
      overlay: { label: '2', description: '2 unread sessions' },
      flash: true
    })
    expect(planBadge('win32', 2, 1, true).flash).toBe(false)
  })
  it('Windows: a fall or a resend of the same count does not flash', () => {
    expect(planBadge('win32', 1, 2, false).flash).toBe(false)
    expect(planBadge('win32', 2, 2, false).flash).toBe(false)
  })
  it('Windows: the first report (persisted unread restored at boot) is a baseline — draws, never flashes', () => {
    expect(planBadge('win32', 3, null, false)).toEqual({
      overlay: { label: '3', description: '3 unread sessions' },
      flash: false
    })
  })
  it('main seeds the baseline as null, not 0 (source guard)', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8')
    expect(src).toMatch(/let lastBadgeCount: number \| null = null/)
  })
  it('Linux: nothing', () => {
    expect(planBadge('linux', 5, 0, false)).toEqual({})
  })
})

describe('badgeLabel', () => {
  it('caps at 9+', () => {
    expect(badgeLabel(1)).toBe('1')
    expect(badgeLabel(9)).toBe('9')
    expect(badgeLabel(10)).toBe('9+')
    expect(badgeLabel(250)).toBe('9+')
  })
})

describe('rasterizeBadge', () => {
  const px = (buf: Buffer, size: number, x: number, y: number) => {
    const i = (y * size + x) * 4
    return { b: buf[i], g: buf[i + 1], r: buf[i + 2], a: buf[i + 3] }
  }
  it.each([16, 32])('is a size×size BGRA buffer (%i px)', (size) => {
    expect(rasterizeBadge('3', size).length).toBe(size * size * 4)
  })
  it('is transparent at the corners and opaque red at the rim of the disc', () => {
    const buf = rasterizeBadge('1', 16)
    expect(px(buf, 16, 0, 0).a).toBe(0)
    expect(px(buf, 16, 15, 15).a).toBe(0)
    expect(px(buf, 16, 8, 1)).toEqual({ b: 0x30, g: 0x3b, r: 0xff, a: 255 })
  })
  it('premultiplies the anti-aliased edge (no channel exceeds alpha)', () => {
    const buf = rasterizeBadge('1', 16)
    for (let i = 0; i < buf.length; i += 4) {
      expect(Math.max(buf[i], buf[i + 1], buf[i + 2])).toBeLessThanOrEqual(buf[i + 3])
    }
  })
  it('draws white glyph pixels inside the disc, for one digit and for 9+', () => {
    for (const label of ['8', '9+']) {
      for (const size of [16, 32]) {
        const buf = rasterizeBadge(label, size)
        let white = 0
        for (let i = 0; i < buf.length; i += 4) if (buf[i] === 255 && buf[i + 1] === 255 && buf[i + 3] === 255) white++
        expect(white).toBeGreaterThan(0)
        // Glyph pixels never land on the transparent corners.
        expect(px(buf, size, 0, 0).a).toBe(0)
      }
    }
  })
  it('the two-glyph label still fits inside a 16 px disc', () => {
    const buf = rasterizeBadge('9+', 16)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const p = px(buf, 16, x, y)
        if (p.r === 255 && p.g === 255) {
          const dx = x + 0.5 - 8
          const dy = y + 0.5 - 8
          expect(dx * dx + dy * dy).toBeLessThan(64)
        }
      }
  })
})
