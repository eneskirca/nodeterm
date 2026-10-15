import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../shared/ipc'
import {
  normalizeWallpaper,
  wallpapersToKeep,
  type DesktopWallpaper,
  type WallpaperStill
} from '../shared/wallpaper'
import { renameAtomic, tempNameFor } from './fs-atomic'
import { platform } from './platform'

/**
 * Wallpaper files for the canvas background (Liquid Glass appearance). Core, so both shells serve
 * it: on the Server Edition (Linux) the stills list is simply empty and gradients need no files.
 *
 * Image work (measuring, converting to JPEG) goes through `WallpaperImageOps`. macOS defaults to
 * its built-in `sips`; the Electron shell registers a `nativeImage` implementation on Windows
 * (`src/main/wallpaper-native-image.ts` — core may not import electron). With no ops (Linux, the
 * Server Edition) there are no stills, and HEIC / over-cap imports are refused with a reason.
 *
 * Every file the renderer can get bytes for lives in ONE directory, `<userData>/wallpapers/`, under
 * a hash name this module minted. The renderer never names a path to read: a still is named by its
 * `mac:` / `win:` id and re-resolved against a fresh scan, and an imported image's path must be a direct
 * child of the cache dir with a hash-shaped name (`cachedImagePath`). So a hand-edited
 * settings.json cannot aim `load` at anything else, and there is no traversal to reject because
 * no caller-supplied segment is ever joined.
 *
 * `import` is the one exception: it takes a caller-supplied source path (the file picker's answer)
 * and copies any JPEG/PNG/WebP/HEIC-named regular file into the cache, whose bytes `load` then
 * returns. That is no wider than what the same caller already has (`fs:read` on both shells), but
 * it means the jail above governs `load`, not what can ENTER the cache.
 */

const run = promisify(execFile)

export const SYSTEM_WALLPAPER_DIR = '/System/Library/Desktop Pictures'
const SIPS = '/usr/bin/sips'
/** Real stills are several MB; the 356px `.madesktop` placeholders and thumbnails are not. */
const MIN_STILL_BYTES = 1_000_000
/** Windows' stock JPEGs are far smaller than macOS's HEICs (some theme stills are ~300 KB). */
const MIN_WINDOWS_STILL_BYTES = 200_000
const STILL_EXT = /\.(heic|jpe?g|png)$/i
const IMPORT_EXT = /\.(heic|jpe?g|png|webp)$/i
/** Shown first, in this order: the scenic ones. */
const SCENIC_FIRST = ['Sonoma Horizon', 'Sonoma']
const FULL_PX = 3840
const THUMB_PX = 320
/** Refuse to ship anything bigger over IPC as a data: URL. */
const MAX_LOAD_BYTES = 25 * 1024 * 1024
const CACHED_NAME = /^[0-9a-f]{40}(-t)?\.(jpg|jpeg|png|webp)$/

export interface ScannedStill {
  id: string
  label: string
  path: string
}

/**
 * The image converter seam. `id` is part of the cache key, which is why the sips one stays `sips`:
 * every macOS cache file minted before this seam existed keeps its name.
 */
export interface WallpaperImageOps {
  id: string
  /** Can `toJpeg` decode HEIC? (sips: yes; Chromium's nativeImage: no.) */
  canHeic: boolean
  /** An unreadable size counts as "too large" and is converted (sips can read what it cannot
   *  measure); false = copy it as-is (nativeImage cannot measure WebP, and cannot convert it). */
  convertUnknownSize: boolean
  /** Long edge in px, or null when it cannot say. */
  longEdge(src: string): Promise<number | null>
  /** Write a JPEG of `src` to `out`, downscaled to `maxPx` on its long edge only when larger. */
  toJpeg(src: string, maxPx: number, out: string): Promise<void>
}

export interface WallpaperHost {
  platform: string
  env: Record<string, string | undefined>
  /** Tests only: the Windows stills root, bypassing `windowsWallpaperRoot(env)`. */
  windowsStillsRoot?: string
}
let host: () => WallpaperHost = () => ({ platform: process.platform, env: process.env })
let registeredOps: WallpaperImageOps | null = null

/** The shell's converter (Electron on Windows). macOS keeps sips whatever is registered. */
export function setWallpaperImageOps(ops: WallpaperImageOps | null): void {
  registeredOps = ops
  stillScan = null
}

/** Tests only: pretend to be another OS / environment, and forget the memoized scan. */
export function setWallpaperHostForTests(next: Partial<WallpaperHost> | null): void {
  host = next
    ? () => ({
        platform: next.platform ?? process.platform,
        env: next.env ?? process.env,
        windowsStillsRoot: next.windowsStillsRoot
      })
    : () => ({ platform: process.platform, env: process.env })
  registeredOps = null
  stillScan = null
}

function imageOps(): WallpaperImageOps | null {
  if (host().platform === 'darwin') return sipsImageOps
  return registeredOps
}

/** A system still's id, on any platform: the prefix names the OS whose scan resolves it. */
export function isSystemStillId(id: string): boolean {
  return id.startsWith('mac:') || id.startsWith('win:')
}

/** `%WINDIR%\Web\Wallpaper` — the stock Windows stills (Windows, ThemeA…, one folder each). */
export function windowsWallpaperRoot(env: Record<string, string | undefined>): string {
  return path.win32.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Web', 'Wallpaper')
}

export function wallpaperCacheDir(): string {
  return path.join(platform().userDataDir, 'wallpapers')
}

/**
 * The stock macOS stills under `root`, scenic first. Recurses into `.wallpapers/<name>/`, skips
 * `.thumbnails` and anything under 1 MB (which is what drops the `.madesktop` placeholders' tiny
 * siblings). A missing root is an empty list, which is the answer everywhere but macOS.
 */
export async function scanStills(
  root = SYSTEM_WALLPAPER_DIR,
  depth = 3,
  { prefix = 'mac:', minBytes = MIN_STILL_BYTES }: { prefix?: string; minBytes?: number } = {}
): Promise<ScannedStill[]> {
  const found: ScannedStill[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '.thumbnails' && left > 0) await walk(p, left - 1)
      } else if (e.isFile() && STILL_EXT.test(e.name)) {
        try {
          if ((await stat(p)).size < minBytes) continue
        } catch {
          continue
        }
        const rel = path.relative(root, p).split(path.sep).join('/')
        found.push({ id: `${prefix}${rel}`, label: e.name.replace(STILL_EXT, ''), path: p })
      }
    }
  }
  await walk(root, depth)
  const seen = new Set<string>()
  const rank = (label: string): number => {
    const i = SCENIC_FIRST.indexOf(label)
    return i === -1 ? SCENIC_FIRST.length : i
  }
  return found
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
    .filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
}

/** A cached file's name: stable per source file version and output size. */
async function cacheKey(src: string, variant: string): Promise<string> {
  const st = await stat(src)
  return createHash('sha1').update(`${src}\x00${st.mtimeMs}\x00${st.size}\x00${variant}`).digest('hex')
}

/** In-flight conversions, so two callers asking for the same file share one `sips`. */
const inflight = new Map<string, Promise<string>>()

/** Publish `produce(tmp)` at `target` through a unique temp, unless it is already there. */
function publishOnce(target: string, produce: (tmp: string) => Promise<void>): Promise<string> {
  const pending = inflight.get(target)
  if (pending) return pending
  const job = (async () => {
    try {
      await stat(target)
      return target
    } catch {
      // not cached yet
    }
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = tempNameFor(target)
    try {
      await produce(tmp)
      await renameAtomic(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    return target
  })().finally(() => inflight.delete(target))
  inflight.set(target, job)
  return job
}

/** The long edge of an image in px, per `sips`; null when it cannot say. */
async function sipsLongEdge(src: string): Promise<number | null> {
  try {
    const { stdout } = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', src], {
      timeout: 30_000
    })
    const dims = [...stdout.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]))
    return dims.length === 2 ? Math.max(dims[0], dims[1]) : null
  } catch {
    return null
  }
}

/**
 * HEIC/JPEG/PNG/WebP → JPEG no larger than `px` on its long edge, via macOS's built-in `sips`.
 * `-Z` alone would also UPSCALE (measured: a 320px image comes out 3840px wide), so it is passed
 * only when the image is actually larger; an unreadable size is treated as larger.
 */
export const sipsImageOps: WallpaperImageOps = {
  id: 'sips',
  canHeic: true,
  convertUnknownSize: true,
  longEdge: sipsLongEdge,
  async toJpeg(src, px, out) {
    const edge = await sipsLongEdge(src)
    const resize = edge === null || edge > px ? ['-Z', String(px)] : []
    await run(SIPS, ['-s', 'format', 'jpeg', ...resize, src, '--out', out], { timeout: 60_000 })
  }
}

/** The cache file `convert` publishes for `src` at `px` — also what the prune must keep. */
async function convertedName(ops: WallpaperImageOps, src: string, px: number, suffix: string, dir: string) {
  return path.join(dir, `${await cacheKey(src, `${ops.id}${px}`)}${suffix}.jpg`)
}

function convert(ops: WallpaperImageOps, src: string, px: number, suffix: string): Promise<string> {
  return convertedName(ops, src, px, suffix, wallpaperCacheDir()).then((target) =>
    publishOnce(target, (tmp) => ops.toJpeg(src, px, tmp))
  )
}

let stillScan: Promise<ScannedStill[]> | null = null
function stills(): Promise<ScannedStill[]> {
  const { platform: os, env, windowsStillsRoot } = host()
  // One scan per app run: the system stills only change with an OS update.
  if (os === 'darwin') {
    stillScan ??= scanStills().catch(() => [])
    return stillScan
  }
  // Windows lists its stills only when the shell gave us something to thumbnail them with.
  if (os === 'win32' && registeredOps) {
    stillScan ??= scanStills(windowsStillsRoot ?? windowsWallpaperRoot(env), 2, {
      prefix: 'win:',
      minBytes: MIN_WINDOWS_STILL_BYTES
    }).catch(() => [])
    return stillScan
  }
  return Promise.resolve([])
}

/**
 * The size check and the read go through ONE open descriptor, so the file measured is the file
 * read: a stat-then-readFile pair could be handed a different (larger) file between the two.
 */
async function toDataUrl(file: string): Promise<string | null> {
  let fh
  try {
    fh = await open(file, 'r')
    const st = await fh.stat()
    if (!st.isFile() || st.size > MAX_LOAD_BYTES) return null
    const ext = path.extname(file).slice(1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${(await fh.readFile()).toString('base64')}`
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * The cache file an `image` wallpaper names, or null when the value names anything else. Only a
 * DIRECT child of the cache dir with a hash-shaped name qualifies — that is the whole jail.
 */
export function cachedImagePath(p: string, cacheDir = wallpaperCacheDir()): string | null {
  if (typeof p !== 'string' || p.length === 0) return null
  const resolved = path.resolve(p)
  if (path.dirname(resolved) !== path.resolve(cacheDir)) return null
  if (!CACHED_NAME.test(path.basename(resolved))) return null
  return resolved
}

export async function listStills(): Promise<WallpaperStill[]> {
  const list = await stills()
  const out: WallpaperStill[] = []
  // Sequential on purpose: a fresh cache runs one `sips` per still, and a dozen at once is a burst
  // of CPU for a grid of 320px thumbnails. Cached, each is a stat plus a small read.
  const ops = imageOps()
  for (const s of list) {
    if (!ops) break
    const thumb = await convert(ops, s.path, THUMB_PX, '-t')
      .then(toDataUrl)
      .catch(() => null)
    out.push({ id: s.id, label: s.label, thumb })
  }
  return out
}

export async function loadWallpaper(value: unknown): Promise<string | null> {
  const w = normalizeWallpaper(value)
  if (w.kind === 'image') {
    const file = cachedImagePath(w.path)
    return file ? toDataUrl(file) : null
  }
  if (w.kind === 'preset' && isSystemStillId(w.id)) {
    const ops = imageOps()
    const still = ops && (await stills()).find((s) => s.id === w.id)
    if (!ops || !still) return null
    return convert(ops, still.path, FULL_PX, '')
      .then(toDataUrl)
      .catch(() => null)
  }
  return null
}

/**
 * Put a picked image into the cache and return the value to store. The cached copy is what keeps
 * the wallpaper when the original moves.
 *
 * The file is copied untouched when the page can show it as-is. The image ops (`sips` on macOS,
 * `nativeImage` on Windows) convert to a JPEG ≤ 3840px only when they must: HEIC (Chromium cannot
 * decode it — and only an ops that `canHeic`), or an image over 3840px or over `load`'s 25 MB cap —
 * a 60 MB camera PNG copied as-is would otherwise be refused at load, which reads as a wallpaper
 * that silently never appears. Re-encoding everything would flatten a PNG/WebP's alpha and
 * recompress a JPEG for nothing. Where no ops can do it, HEIC and an over-cap image are refused
 * HERE, where the picker can show the reason.
 */
export async function importWallpaper(sourcePath: unknown): Promise<DesktopWallpaper> {
  if (typeof sourcePath !== 'string' || !IMPORT_EXT.test(sourcePath)) {
    throw new Error('Choose a JPEG, PNG, WebP or HEIC image.')
  }
  const src = path.resolve(sourcePath)
  const keepNow = currentKeep()
  const ops = imageOps()
  const heic = /\.heic$/i.test(src)
  const srcStat = await stat(src)
  // A FIFO or device named `x.png` would hang copyFile/sips and wedge publishOnce for the run.
  if (!srcStat.isFile()) throw new Error('Choose a JPEG, PNG, WebP or HEIC image.')
  const tooBig = srcStat.size > MAX_LOAD_BYTES
  let result: DesktopWallpaper
  if (ops && (heic ? ops.canHeic : tooBig || (await oversize(ops, src)))) {
    result = { kind: 'image', path: await convert(ops, src, FULL_PX, '') }
  } else {
    if (heic) throw new Error("HEIC images can't be converted on this system. Choose a JPEG, PNG or WebP.")
    if (tooBig) {
      throw new Error(`That image is larger than ${MAX_LOAD_BYTES / 1024 / 1024} MB. Choose a smaller one.`)
    }
    const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
    const target = path.join(wallpaperCacheDir(), `${await cacheKey(src, 'copy')}${ext}`)
    await publishOnce(target, (tmp) => copyFile(src, tmp))
    result = { kind: 'image', path: target }
  }
  // The setting is written by the renderer after this returns, so keep the new file AND everything
  // the saved settings still name (the wallpaper on screen and the "Your image" tile's recent import):
  // if that save never lands, nothing the settings point at may be gone. The settings hook prunes
  // the old ones once the choice is saved.
  void pruneWallpaperCache([...keepNow, result])
  return result
}

/** Is this image larger than the full-size cap? An unreadable size asks the ops what that means. */
async function oversize(ops: WallpaperImageOps, src: string): Promise<boolean> {
  const edge = await ops.longEdge(src)
  return edge === null ? ops.convertUnknownSize : edge > FULL_PX
}

/** The cache file a wallpaper value is drawn from, or null for none/gradients/unknown stills. */
async function fileFor(value: unknown, dir: string): Promise<string | null> {
  const w = normalizeWallpaper(value)
  if (w.kind === 'image') return cachedImagePath(w.path, dir)
  if (w.kind === 'preset' && isSystemStillId(w.id)) {
    const ops = imageOps()
    const still = ops && (await stills()).find((s) => s.id === w.id)
    if (!ops || !still) return null
    return convertedName(ops, still.path, FULL_PX, '', dir).catch(() => null)
  }
  return null
}

/**
 * Delete cached wallpapers nothing refers to any more. Only full-size files this module minted
 * (hash-named, no `-t`) are candidates: foreign files and temps are never touched, and still
 * thumbnails are kept (ponytail: ~20 KB each, one per system still; a stale one after an OS update
 * lingers until the cache dir is cleared). A conversion still in flight is never removed.
 *
 * Temps are deliberately left alone: `sweepStaleTempFiles` refuses any pid-bearing temp
 * (fs-atomic.ts — a pid cannot prove its writer is dead across instances), which is every temp
 * this module writes, and each writer already removes its own temp on failure.
 */
export async function pruneWallpaperCache(keep: unknown[], dir = wallpaperCacheDir()): Promise<void> {
  try {
    const keepFiles = new Set(
      (await Promise.all(keep.map((v) => fileFor(v, dir)))).filter((f): f is string => !!f)
    )
    for (const name of await readdir(dir)) {
      if (!CACHED_NAME.test(name) || name.includes('-t.')) continue
      const file = path.join(dir, name)
      if (keepFiles.has(file) || inflight.has(file)) continue
      await unlink(file).catch(() => {})
    }
  } catch {
    // best effort: a missing cache dir or an unreadable entry is nothing to clean
  }
}

let currentKeep: () => unknown[] = () => []

/**
 * Wire onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). The settings
 * accessors let the cache follow the choice: a changed `desktopWallpaper` prunes what the old one
 * left behind. There is deliberately no prune at boot: `SettingsStore.init` answers an unreadable
 * settings.json with the defaults, and pruning against that would delete the wallpaper the user
 * actually chose — a failed read is not evidence the choice went away. Only a SAVED change prunes.
 */
export function registerWallpaperIpc(settings: {
  get: () => { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }
  onChange: (cb: (s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }) => void) => unknown
}): void {
  currentKeep = () => wallpapersToKeep(settings.get())
  // The user's most recent import is kept too (`wallpapersToKeep`): choosing a preset must not
  // delete the image the "Your image" tile still offers.
  const key = (s: { desktopWallpaper?: unknown; recentWallpaperImage?: unknown }): string =>
    JSON.stringify(wallpapersToKeep(s))
  let last = key(settings.get())
  settings.onChange((s) => {
    const next = key(s)
    if (next === last) return
    last = next
    void pruneWallpaperCache(wallpapersToKeep(s))
  })
  platform().handle(IPC.wallpaperListStills, () => listStills())
  platform().handle(IPC.wallpaperLoad, (value: unknown) => loadWallpaper(value))
  platform().handle(IPC.wallpaperImport, (sourcePath: unknown) => importWallpaper(sourcePath))
}
