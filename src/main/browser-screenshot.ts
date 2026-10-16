/**
 * `--screenshot <path>` (PR 9 Task 9.1). Capture the guest's page and write a PNG to a caller-named
 * path — and that path is the whole risk: UNJAILED, this is an arbitrary-file-write primitive with
 * attacker-chosen PNG content. So the path is DATA, resolved against the project cwd and refused if it
 * escapes: `..`, an absolute path outside the project, or a symlink whose parent resolves outside.
 *
 * The jail is `fs.realpath` on the target's PARENT (the file does not exist yet — we are about to
 * write it) compared to the canonicalized project root with a SEPARATOR-TERMINATED prefix, so
 * `/proj-evil` never passes the `/proj` check. A final-component symlink (planted at the exact target
 * name, pointing outside) is caught by an `lstat` belt. Only the format `png` is issued, and the
 * `clip` comes from OUR OWN box model (the layout metrics), never from agent input.
 *
 * Main-side only (it holds a debugger and writes a real file); never Server Edition.
 */
import path from 'node:path'
import { settledViewport, type Driver, type ActionResult, type LayoutMetrics } from './browser-actions'
import { MAX_VIEWPORT_OVERRIDE } from './browser-cdp-allowlist'
import { METRICS_OVERRIDE, METRICS_OVERRIDE_CLEAR } from './browser-lease'

/** `--full true` captures at most this many CSS px of height; a taller page says it was cut. */
export const FULL_PAGE_MAX_HEIGHT = MAX_VIEWPORT_OVERRIDE

/** Refused: the resolved path (or a symlink on the way to it) is not inside the project directory. */
export const SCREENSHOT_OUTSIDE_PROJECT =
  'browser: --screenshot path must be inside the project directory'

/** Refused: this canvas/project has no working directory to jail a path to (an inline/no-cwd project). */
export const SCREENSHOT_NO_PROJECT_DIR =
  'browser: --screenshot needs a project folder (this canvas has none)'

/** The filesystem the jail consults, injected so the traversal refusals are unit-testable without a
 *  real tree (a fake `realpath` models a symlink whose parent resolves outside). */
export interface ScreenshotPathDeps {
  /** Canonicalize a path, following every symlink. Rejects when the path does not exist. */
  realpath(p: string): Promise<string>
  /** lstat WITHOUT following the final link — used to refuse a final-component symlink. */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>
}

export type ResolvedScreenshotPath = { ok: true; abs: string } | { ok: false; message: string }

/**
 * Resolve a caller-supplied screenshot path into a concrete absolute path INSIDE the project, or a
 * named refusal. Pure of capture/IO beyond the injected `realpath`/`lstat`.
 */
export async function resolveScreenshotPath(
  projectCwd: string | undefined,
  rawPath: string,
  deps: ScreenshotPathDeps
): Promise<ResolvedScreenshotPath> {
  if (!projectCwd) return { ok: false, message: SCREENSHOT_NO_PROJECT_DIR }
  // A relative path resolves against the project cwd; an absolute path stays absolute (and is refused
  // below unless it already lands inside the project).
  const abs = path.resolve(projectCwd, rawPath)
  const parent = path.dirname(abs)
  let realBase: string
  let realParent: string
  try {
    realBase = await deps.realpath(projectCwd)
    // realpath the PARENT — following every link — so a symlink whose parent resolves outside the
    // project is caught. The file itself does not exist yet, so we cannot realpath it directly.
    realParent = await deps.realpath(parent)
  } catch {
    return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  }
  // Separator-terminated prefix: `/proj-evil` must NOT pass the `/proj` check. Equality is the root
  // itself (a file written directly in the project dir).
  const baseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep
  if (realParent !== realBase && !realParent.startsWith(baseWithSep)) {
    return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  }
  const target = path.join(realParent, path.basename(abs))
  // Belt against a final-component symlink planted at the exact target name pointing outside: a
  // plain writeFile would follow it. A missing file (ENOENT) is the normal case and passes.
  try {
    const st = await deps.lstat(target)
    if (st.isSymbolicLink()) return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  } catch {
    /* does not exist yet — the expected case for a new screenshot */
  }
  return { ok: true, abs: target }
}

/** The IO the action needs beyond the jail: capture goes through the gated `Driver.send`; the file
 *  write is injected so the action is testable without touching disk. */
export interface ScreenshotDeps extends ScreenshotPathDeps {
  writeFile(p: string, data: Buffer): Promise<void>
  /** The settle poll's delay, injected so tests do not wait on real time. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * `--screenshot <path>` with the optional `--full true` modifier. Jail the path, measure the page
 * from OUR layout metrics, capture a PNG (viewport by default, the whole content box with `--full`),
 * write it, and reply with the path, dimensions, size, and the exact `show-image` line the agent can
 * echo to put the shot on the canvas.
 */
export async function browserScreenshot(
  s: Driver,
  nodeId: string,
  projectCwd: string | undefined,
  rawPath: string,
  opts: { full?: boolean },
  deps: ScreenshotDeps
): Promise<ActionResult> {
  const resolved = await resolveScreenshotPath(projectCwd, rawPath, deps)
  if (!resolved.ok) return { ok: false, message: resolved.message }
  const full = opts.full === true
  let shot: FullCapture
  try {
    shot = full ? await captureFullPage(s, deps.sleep) : await captureViewport(s)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : `browser: ${nodeId} could not be captured` }
  }
  if (!shot.b64) return { ok: false, message: `browser: ${nodeId} returned no screenshot data` }
  const buf = Buffer.from(shot.b64, 'base64')
  try {
    await deps.writeFile(resolved.abs, buf)
  } catch {
    return { ok: false, message: `browser: could not write the screenshot to ${resolved.abs}` }
  }
  const { w, h } = shot
  const kb = Math.max(1, Math.round(buf.length / 1024))
  return {
    ok: true,
    message:
      `wrote ${resolved.abs} (${w}×${h}, ${kb} KB)${shot.notes.map((n) => `; ${n}`).join('')}` +
      ` — show it with: show-image ${resolved.abs}`
  }
}

interface FullCapture {
  b64: string
  w: number
  h: number
  /** Facts the reply owes the caller (a cut page, a scroll position we could not put back). */
  notes: string[]
}

function dataOf(res: unknown): string {
  const d = (res as { data?: unknown } | null)?.data
  return typeof d === 'string' ? d : ''
}

async function captureViewport(s: Driver): Promise<FullCapture> {
  const m = await s.refreshViewport()
  const res = await s.send('Page.captureScreenshot', { format: 'png' })
  return { b64: dataOf(res), w: Math.round(m.width), h: Math.round(m.height), notes: [] }
}

/**
 * The whole page, rendered as ONE viewport (#539). `captureBeyondViewport` on its own paints layers
 * outside the viewport without re-laying the page out, so a scrolled page's `position: sticky`
 * header lands at the old scroll offset and a `fixed` footer mid-page (measured, Electron 42.9.1).
 * So: size the viewport to the content (width unchanged, so the page keeps its own breakpoints),
 * let layout settle, capture, clear the override in `finally`, then put the scroll position back —
 * an override this tall clamps scroll to 0, and clearing it does not restore it (measured).
 *
 * Side effect, stated in the reply contract: the page sees one resize, so content sized to the
 * viewport (`100vh`) renders taller in the image. Grown content gets ONE re-measure, bounded by
 * {@link FULL_PAGE_MAX_HEIGHT}. If the lease is released mid-capture the session has already sent the
 * clear before detaching; nothing here reattaches it.
 */
async function captureFullPage(s: Driver, sleep?: (ms: number) => Promise<void>): Promise<FullCapture> {
  const before = await settledViewport(s, sleep)
  const width = Math.max(1, Math.min(FULL_PAGE_MAX_HEIGHT, Math.round(before.width)))
  const want = (m: LayoutMetrics) => Math.max(1, Math.min(FULL_PAGE_MAX_HEIGHT, Math.round(m.contentHeight)))
  const notes: string[] = []
  let height = want(before)
  let b64 = ''
  let w = 0
  let h = 0
  let fullHeight = Math.round(before.contentHeight)
  try {
    await s.send(METRICS_OVERRIDE, { width, height, deviceScaleFactor: 0, mobile: false })
    let m = await settledViewport(s, sleep)
    if (want(m) > height) {
      height = want(m)
      await s.send(METRICS_OVERRIDE, { width, height, deviceScaleFactor: 0, mobile: false })
      m = await settledViewport(s, sleep)
    }
    fullHeight = Math.round(m.contentHeight)
    h = Math.min(height, Math.max(1, fullHeight))
    w = Math.max(1, Math.round(m.contentWidth))
    const res = await s.send('Page.captureScreenshot', {
      format: 'png',
      // Belt for anything still outside the (now page-sized) viewport, e.g. horizontal overflow.
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 }
    })
    b64 = dataOf(res)
  } finally {
    if (s.isAttached?.() !== false) await s.send(METRICS_OVERRIDE_CLEAR, {}).catch(() => {})
  }
  if (fullHeight > h) notes.push(`page is ${fullHeight}px tall; captured the first ${h}px`)
  const restored = await restoreScroll(s, before, sleep)
  if (restored) notes.push(restored)
  return { b64, w, h, notes }
}

/** Put the page back where it was scrolled before the capture. Returns a note when it could not. */
async function restoreScroll(
  s: Driver,
  before: LayoutMetrics,
  sleep?: (ms: number) => Promise<void>
): Promise<string | null> {
  if (s.isAttached?.() === false) return null
  const target = { x: Math.round(before.scrollX), y: Math.round(before.scrollY) }
  try {
    let now = await settledViewport(s, sleep)
    const dx = target.x - Math.round(now.scrollX)
    const dy = target.y - Math.round(now.scrollY)
    if (dx !== 0 || dy !== 0) {
      const at = { x: Math.floor(now.width / 2), y: Math.floor(now.height / 2) }
      await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: dx, deltaY: dy })
      now = await settledViewport(s, sleep)
    }
    if (Math.round(now.scrollX) === target.x && Math.round(now.scrollY) === target.y) return null
    return `the page was at scroll ${target.y} and is now at ${Math.round(now.scrollY)} — re-scroll before clicking`
  } catch {
    return 'could not restore the scroll position — re-read the page before clicking'
  }
}
