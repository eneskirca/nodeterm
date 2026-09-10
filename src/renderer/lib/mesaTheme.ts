/** Mesa chrome + xterm patch. CSS alone cannot recolor glyphgrid/canvas output. */
export const MESA_BG = '#09090b'
export const MESA_TEXT = '#f4f4f5'

export const MESA_TERM_THEME = {
  background: MESA_BG,
  foreground: MESA_TEXT,
  cursor: MESA_TEXT,
  cursorAccent: MESA_BG
} as const
