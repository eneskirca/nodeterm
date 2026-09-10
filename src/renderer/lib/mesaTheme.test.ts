import { describe, expect, it } from 'vitest'
import { MESA_BG, MESA_TERM_THEME, MESA_TEXT } from './mesaTheme'

describe('MESA_TERM_THEME', () => {
  it('matches the Mesa chrome background so the emulator is not a leftover #1e1e1e plate', () => {
    expect(MESA_TERM_THEME.background).toBe(MESA_BG)
    expect(MESA_TERM_THEME.foreground).toBe(MESA_TEXT)
    expect(MESA_BG).toBe('#09090b')
  })
})
