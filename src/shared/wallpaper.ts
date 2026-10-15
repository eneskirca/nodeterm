/**
 * Desktop wallpaper behind the canvas (the "Liquid Glass" appearance).
 *
 * Opt-in: the default is `{ kind: 'none' }`, which draws the canvas exactly as before. The value is
 * hand-editable settings.json, so every reader goes through `normalizeWallpaper` and an
 * unrecognised shape degrades to `none`, never to something else.
 *
 * Three kinds of source:
 *  - `gradient:<name>` presets are pure CSS (below), so they work on every platform and in the
 *    Server Edition with no image file at all.
 *  - `mac:<path under /System/Library/Desktop Pictures>` presets are the stock macOS stills, read
 *    from disk at runtime and NEVER bundled (they are Apple's). Converted to JPEG by `sips` in
 *    core, since Chromium cannot decode HEIC.
 *  - `win:<path under %WINDIR%\\Web\\Wallpaper>` presets are the stock Windows stills, read and
 *    converted the same way through Electron's `nativeImage` (desktop only).
 *  - `image` is a picture the user chose, COPIED into `<userData>/wallpapers/` on import so moving
 *    the original does not break it. `path` names that copy; core refuses to read anything else.
 */
export type DesktopWallpaper =
  | { kind: 'none' }
  | { kind: 'preset'; id: string }
  | { kind: 'image'; path: string }

export const NO_WALLPAPER: DesktopWallpaper = { kind: 'none' }

export interface GradientWallpaper {
  id: string
  label: string
  css: string
}

/** Built-in gradient presets — the cross-platform set (Linux, Windows, Server Edition). */
export const GRADIENT_WALLPAPERS: readonly GradientWallpaper[] = [
  {
    id: 'gradient:dusk',
    label: 'Dusk',
    css: 'linear-gradient(165deg, #1d2b64 0%, #6a3d8f 52%, #f4a6b8 100%)'
  },
  {
    id: 'gradient:aurora',
    label: 'Aurora',
    css:
      'radial-gradient(ellipse at 22% 18%, rgba(61, 220, 151, 0.75) 0%, transparent 48%), ' +
      'radial-gradient(ellipse at 78% 30%, rgba(90, 120, 255, 0.7) 0%, transparent 52%), ' +
      'linear-gradient(180deg, #0b1026 0%, #172a4f 100%)'
  },
  {
    id: 'gradient:ocean',
    label: 'Ocean',
    css: 'linear-gradient(160deg, #00c6ff 0%, #0072ff 55%, #002a5c 100%)'
  },
  {
    id: 'gradient:sunrise',
    label: 'Sunrise',
    css: 'linear-gradient(180deg, #ffe29f 0%, #ffa99f 48%, #ff719a 100%)'
  },
  {
    id: 'gradient:meadow',
    label: 'Meadow',
    css: 'linear-gradient(170deg, #f1fbd8 0%, #a8e063 50%, #3f8f2a 100%)'
  },
  {
    id: 'gradient:graphite',
    label: 'Graphite',
    css: 'linear-gradient(160deg, #4b4b52 0%, #1c1c20 100%)'
  }
]

export function gradientCss(id: string): string | undefined {
  return GRADIENT_WALLPAPERS.find((g) => g.id === id)?.css
}

/** A macOS still as the picker shows it. `thumb` is a data: URL, or null when it could not be made. */
export interface WallpaperStill {
  id: string
  label: string
  thumb: string | null
}

export interface WallpaperApi {
  /** The macOS stills found on the machine that owns the files (empty off macOS). */
  listStills(): Promise<WallpaperStill[]>
  /** A data: URL for a still or an imported image; null when it cannot be read (degrade to none). */
  load(wallpaper: DesktopWallpaper): Promise<string | null>
  /** Copy (converting HEIC) a picked image into the wallpaper cache; resolves the value to store. */
  importImage(sourcePath: string): Promise<DesktopWallpaper>
}

const MAX_FIELD = 4096

/** Re-validate a hand-editable value. Anything unrecognised is `none`. */
export function normalizeWallpaper(v: unknown): DesktopWallpaper {
  if (!v || typeof v !== 'object') return NO_WALLPAPER
  const o = v as Record<string, unknown>
  if (o.kind === 'preset' && typeof o.id === 'string' && o.id.length > 0 && o.id.length < MAX_FIELD) {
    if (o.id.startsWith('gradient:') && !gradientCss(o.id)) return NO_WALLPAPER
    // `mac:` / `win:` name a system still; core re-resolves it against its OWN fresh scan, so an id
    // from the other OS (a settings.json synced across machines) simply loads nothing there.
    if (!o.id.startsWith('gradient:') && !o.id.startsWith('mac:') && !o.id.startsWith('win:')) {
      return NO_WALLPAPER
    }
    return { kind: 'preset', id: o.id }
  }
  if (o.kind === 'image' && typeof o.path === 'string' && o.path.length > 0 && o.path.length < MAX_FIELD) {
    return { kind: 'image', path: o.path }
  }
  return NO_WALLPAPER
}

/**
 * What Liquid Glass picks when it is chosen with no wallpaper, so glass never sits over plain
 * black: the first system still (the macOS scan already orders Sonoma Horizon first; Windows lists
 * its stock stills when the desktop shell can convert them), else the first gradient — the answer
 * on Linux and the Server Edition, where the list is empty.
 */
export function defaultWallpaper(stills: readonly { id: string }[]): DesktopWallpaper {
  return stills[0] ? { kind: 'preset', id: stills[0].id } : { kind: 'preset', id: GRADIENT_WALLPAPERS[0].id }
}

export function sameWallpaper(a: DesktopWallpaper, b: DesktopWallpaper): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'preset') return a.id === (b as { id: string }).id
  if (a.kind === 'image') return a.path === (b as { path: string }).path
  return true
}

/**
 * The user's most recent imported image (`settings.recentWallpaperImage`), kept across a switch to
 * a preset so browsing presets never destroys it: the "Your image" tile stays and the cache prune
 * keeps its file. Hand-editable, so it is re-validated like the wallpaper itself.
 */
export function recentWallpaperImage(v: unknown): DesktopWallpaper | null {
  const w = normalizeWallpaper({ kind: 'image', path: v })
  return w.kind === 'image' ? w : null
}

/** The settings patch for choosing `next` while `current` is on screen: an image being chosen, or
 *  one being left, becomes the recent image. */
export function wallpaperChoice(
  current: DesktopWallpaper,
  next: DesktopWallpaper
): { desktopWallpaper: DesktopWallpaper; recentWallpaperImage?: string } {
  const image = next.kind === 'image' ? next : current.kind === 'image' ? current : null
  return image ? { desktopWallpaper: next, recentWallpaperImage: image.path } : { desktopWallpaper: next }
}

/** What a saved settings change must keep in the wallpaper cache: the choice and the recent image. */
export function wallpapersToKeep(s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }): unknown[] {
  return [s.desktopWallpaper, recentWallpaperImage(s.recentWallpaperImage)]
}
