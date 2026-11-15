// Pure icon-container packers, shared by scripts/make-icon.mjs and pinned by
// src/main/icon-pack.test.ts.
//
// The .icns is packed BY HAND (like the .ico below it in make-icon.mjs) since issue #369:
// electron-builder's PNG→icns converter shipped wrong-sized payloads — ic13 (nominally
// 128pt@2x = 256px) held the 512px frame and ic14 (256pt@2x = 512px) held the 1024px one.
// A consumer that trusts the TYPE's nominal size and decodes into a buffer of that stride
// paints rainbow noise, which is exactly how the app icon rendered in macOS's app
// launcher. Packing our own container with a size check makes that class of skew
// unshippable.

/** Sizes of the Linux icon set (`build/icons/<N>x<N>.png`, package.json `linux.icon`).
 *
 *  Every entry must be a directory the freedesktop `hicolor` theme DECLARES in its index.theme
 *  (16/22/24/32/36/48/64/72/96/128/192/256/512 as of hicolor-icon-theme 0.18). An icon installed
 *  under an undeclared size is never found by a theme lookup: issue #1421 — the deb/rpm shipped
 *  one PNG under `hicolor/1024x1024/apps/`, which the index does not list, so `Icon=node-terminal`
 *  resolved to nothing and the taskbar showed a generic icon. electron-builder installs one file
 *  per PNG it finds in the directory and does not check the size against the theme. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/** Apple's iconutil frame table: icns OSType → the pixel size that type MUST carry.
 *  icp4/icp5 are the 1x small sizes; ic11–ic14 are the @2x (retina) variants; PNG payloads
 *  are legal for all of them. */
export const ICNS_FRAMES = [
  { type: 'icp4', px: 16 }, // 16pt @1x
  { type: 'icp5', px: 32 }, // 32pt @1x
  { type: 'ic07', px: 128 }, // 128pt @1x
  { type: 'ic08', px: 256 }, // 256pt @1x
  { type: 'ic09', px: 512 }, // 512pt @1x
  { type: 'ic10', px: 1024 }, // 512pt @2x
  { type: 'ic11', px: 32 }, // 16pt @2x
  { type: 'ic12', px: 64 }, // 32pt @2x
  { type: 'ic13', px: 256 }, // 128pt @2x
  { type: 'ic14', px: 512 } // 256pt @2x
]

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width/height straight out of a PNG's IHDR (bytes 16..24). */
function pngDims(png) {
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('frame is not a PNG')
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) }
}

/**
 * Pack PNG frames (Map of icns type → PNG buffer, one per ICNS_FRAMES entry) into an .icns
 * container: 'icns' + total length, then per frame OSType + length(+8) + payload.
 * Refuses a missing frame and any frame whose PNG dimensions disagree with its type — the
 * skew that shipped as issue #369 must fail the build, not the user's dock.
 */
export function packIcns(frames) {
  const chunks = []
  for (const { type, px } of ICNS_FRAMES) {
    const png = frames.get(type)
    if (!png) throw new Error(`packIcns: missing frame for ${type} (${px}px)`)
    const { w, h } = pngDims(png)
    if (w !== px || h !== px) {
      throw new Error(`packIcns: ${type} must carry ${px}x${px}, got ${w}x${h}`)
    }
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(8 + png.length, 4)
    chunks.push(header, png)
  }
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}
