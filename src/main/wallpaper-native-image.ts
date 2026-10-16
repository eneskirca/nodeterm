import { nativeImage } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { WallpaperImageOps } from '../core/wallpaper'

/**
 * The Windows wallpaper converter: Chromium's own decoder via `nativeImage` (PNG/JPEG — no HEIC,
 * no WebP), registered by the Electron shell with `setWallpaperImageOps`. Lives in src/main because
 * core may not import electron. A WebP it cannot read measures as `null`, which this ops says to
 * COPY as-is (`convertUnknownSize: false`) — the page can show a WebP, nativeImage cannot convert it.
 */
export const nativeImageWallpaperOps: WallpaperImageOps = {
  id: 'nimg',
  canHeic: false,
  convertUnknownSize: false,
  async longEdge(src) {
    const img = nativeImage.createFromPath(src)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    return Math.max(width, height)
  },
  async toJpeg(src, maxPx, out) {
    let img = nativeImage.createFromPath(src)
    if (img.isEmpty()) throw new Error('That image could not be read. Choose a smaller JPEG or PNG.')
    const { width, height } = img.getSize()
    // Downscale only — never enlarge (same rule as the sips path).
    if (Math.max(width, height) > maxPx) {
      img = img.resize(width >= height ? { width: maxPx, quality: 'best' } : { height: maxPx, quality: 'best' })
    }
    await writeFile(out, img.toJPEG(90))
  }
}
