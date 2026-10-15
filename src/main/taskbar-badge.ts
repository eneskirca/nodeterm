// The unread-sessions badge, per platform: the macOS Dock badge (unchanged), and on Windows a
// taskbar OVERLAY icon plus a taskbar flash when the count rises while the window is in the
// background. Linux gets nothing (its only API, `app.setBadgeCount`, is Unity-launcher-only).
//
// Pure + Electron-free: the plan and the overlay bitmap are computed here and applied by the
// `appSetBadge` handler in main/index.ts, so every branch is testable on a Linux CI box.

export interface BadgePlan {
  /** macOS: the Dock badge text ('' clears). Absent = do not touch the Dock. */
  dock?: string
  /** Windows: the overlay to draw (`null` clears it). Absent = do not touch the overlay. */
  overlay?: { label: string; description: string } | null
  /** Windows: flash the taskbar button (it stops on its own once the window is focused). */
  flash?: boolean
}

/** The overlay text: the count up to 9, then "9+" (two glyphs is all a 16px circle holds). */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(count)
}

export function planBadge(
  platform: NodeJS.Platform | string,
  count: number,
  /** The previous report's count, or `null` for the FIRST report of this process. The renderer
   *  restores persisted unread flags at boot and reports them at once — before the window has
   *  focus — so a first report is a baseline, not "something new finished while you were away". */
  prevCount: number | null,
  focused: boolean
): BadgePlan {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (platform === 'darwin') return { dock: n > 0 ? String(n) : '' }
  if (platform === 'win32') {
    return {
      overlay: n > 0 ? { label: badgeLabel(n), description: n === 1 ? '1 unread session' : `${n} unread sessions` } : null,
      // Only a RISE means "something new finished while you were away" — a falling count is the
      // user catching up, and re-flashing on every badge sync would be noise.
      flash: prevCount !== null && n > prevCount && !focused
    }
  }
  return {}
}

// 3×5 bitmap glyphs (rows top→bottom, bit 2 = left column). Only what `badgeLabel` can produce.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '+': [0, 2, 7, 2, 0]
}

/** Badge red (macOS system red, the color users already read as "unread"). */
const RED = { r: 0xff, g: 0x3b, b: 0x30 }

/**
 * Rasterize the overlay: an anti-aliased red disc with the label in white, as a size×size
 * PREMULTIPLIED BGRA buffer — the layout `nativeImage.createFromBitmap` expects on Windows
 * (Skia's N32 on little-endian). One char draws at scale size/8, two chars at size/14, so "9+"
 * still fits inside the disc at 16 px.
 */
export function rasterizeBadge(label: string, size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const radius = size / 2
  const SS = 4 // supersamples per axis for the disc edge
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - c
          const dy = y + (sy + 0.5) / SS - c
          if (dx * dx + dy * dy <= radius * radius) hits++
        }
      }
      const a = hits / (SS * SS)
      const i = (y * size + x) * 4
      buf[i] = Math.round(RED.b * a)
      buf[i + 1] = Math.round(RED.g * a)
      buf[i + 2] = Math.round(RED.r * a)
      buf[i + 3] = Math.round(255 * a)
    }
  }
  const chars = [...label].filter((ch) => GLYPHS[ch])
  if (chars.length === 0) return buf
  const scale = Math.max(1, Math.floor(size / (chars.length === 1 ? 8 : 14)))
  const gw = 3 * scale
  const gh = 5 * scale
  const totalW = chars.length * gw + (chars.length - 1) * scale
  const x0 = Math.floor((size - totalW) / 2)
  const y0 = Math.floor((size - gh) / 2)
  chars.forEach((ch, k) => {
    const rows = GLYPHS[ch]
    const gx = x0 + k * (gw + scale)
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (!(rows[row] & (4 >> col))) continue
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const x = gx + col * scale + px
            const y = y0 + row * scale + py
            if (x < 0 || y < 0 || x >= size || y >= size) continue
            const i = (y * size + x) * 4
            buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 255
          }
        }
      }
    }
  })
  return buf
}
