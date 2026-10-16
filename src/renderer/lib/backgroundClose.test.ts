import { describe, expect, it } from 'vitest'
import { backgroundCloseDescription, backgroundCloseRowVisible } from './backgroundClose'

describe('backgroundCloseRowVisible', () => {
  it('shows only for a desktop window off macOS', () => {
    expect(backgroundCloseRowVisible(false, false)).toBe(true)
    expect(backgroundCloseRowVisible(true, false)).toBe(false)
    expect(backgroundCloseRowVisible(false, true)).toBe(false)
    expect(backgroundCloseRowVisible(true, true)).toBe(false)
  })
})

describe('backgroundCloseDescription', () => {
  it('names the Windows notification area and its automatic default', () => {
    const d = backgroundCloseDescription(true)
    expect(d).toContain('notification area')
    expect(d).toContain('Automatic keeps it running on Windows')
  })
  it('never promises Ctrl+Q on Windows (the quit role has no accelerator there)', () => {
    expect(backgroundCloseDescription(true)).not.toContain('Ctrl+Q')
    expect(backgroundCloseDescription(true)).toContain('File → Exit')
    expect(backgroundCloseDescription(false)).toContain('Ctrl+Q')
  })
  it('says Automatic quits on Linux (matches resolveBackgroundOnClose)', () => {
    const d = backgroundCloseDescription(false)
    expect(d).toContain('system tray')
    expect(d).toContain('Automatic quits on Linux')
  })
})
