import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  resolveScreenshotPath,
  browserScreenshot,
  SCREENSHOT_OUTSIDE_PROJECT,
  SCREENSHOT_NO_PROJECT_DIR,
  FULL_PAGE_MAX_HEIGHT
} from './browser-screenshot'
import type { Driver, LayoutMetrics } from './browser-actions'

// The jail is proven against a REAL filesystem tree (constraint 8): a real project dir, a real
// escaping symlink, a real sibling `proj-evil` — not a hand-rolled path model.
let root: string
let project: string
let realpath: (p: string) => Promise<string>
let lstat: (p: string) => Promise<{ isSymbolicLink(): boolean }>

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'shot-'))
  project = path.join(root, 'proj')
  await fsp.mkdir(project, { recursive: true })
  realpath = (p) => fsp.realpath(p)
  lstat = (p) => fsp.lstat(p)
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('resolveScreenshotPath — the jail (Task 9.1)', () => {
  it('a relative path resolves against the project cwd', async () => {
    const r = await resolveScreenshotPath(project, 'shot.png', { realpath, lstat })
    expect(r).toEqual({ ok: true, abs: path.join(await fsp.realpath(project), 'shot.png') })
  })

  it('a relative path into a subdir stays inside the project', async () => {
    await fsp.mkdir(path.join(project, 'sub'))
    const r = await resolveScreenshotPath(project, 'sub/shot.png', { realpath, lstat })
    expect(r).toEqual({ ok: true, abs: path.join(await fsp.realpath(project), 'sub', 'shot.png') })
  })

  it('a `..` traversal out of the project is refused', async () => {
    const r = await resolveScreenshotPath(project, '../../etc/x.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
  })

  it('an absolute path outside the project is refused', async () => {
    const r = await resolveScreenshotPath(project, '/tmp/x.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
  })

  it('a symlink whose PARENT resolves outside the project is refused', async () => {
    // proj/escape -> root (outside proj). A path "escape/x.png" has parent proj/escape, which
    // realpath resolves to `root` — outside the jail.
    await fsp.symlink(root, path.join(project, 'escape'), 'dir')
    const r = await resolveScreenshotPath(project, 'escape/x.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
  })

  it('the separator-terminated prefix stops a sibling `proj-evil` passing the `proj` check', async () => {
    // A real sibling dir whose name is a prefix of the project dir must not be treated as inside it.
    const evil = path.join(root, 'proj-evil')
    await fsp.mkdir(evil)
    // Point into it via a symlink parent so the raw resolve lands under proj but realpath escapes.
    await fsp.symlink(evil, path.join(project, 'peer'), 'dir')
    const r = await resolveScreenshotPath(project, 'peer/x.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
  })

  it('a final-component symlink pointing outside is refused (the write would follow it)', async () => {
    // proj/shot.png is itself a symlink to root/loot.png — a plain writeFile would follow it out.
    await fsp.writeFile(path.join(root, 'loot.png'), 'x')
    await fsp.symlink(path.join(root, 'loot.png'), path.join(project, 'shot.png'))
    const r = await resolveScreenshotPath(project, 'shot.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
  })

  it('an inline project with no cwd is a named refusal, not a crash', async () => {
    const r = await resolveScreenshotPath(undefined, 'shot.png', { realpath, lstat })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_NO_PROJECT_DIR })
  })
})

/** A Driver that answers the capture + a fixed viewport, and records every method it is sent. */
function fakeDriver(metrics: Partial<LayoutMetrics> = {}): { s: Driver; sent: string[] } {
  const m: LayoutMetrics = {
    width: 1280,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    contentWidth: 1280,
    contentHeight: 5000,
    ...metrics
  }
  const sent: string[] = []
  const s: Driver = {
    async send(method) {
      sent.push(method)
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('PNGDATA').toString('base64') }
      return {}
    },
    async refreshViewport() {
      return m
    }
  }
  return { s, sent }
}

describe('browserScreenshot — capture + jail + reply (Task 9.1)', () => {
  it('writes inside the project and replies with the show-image line', async () => {
    const { s } = fakeDriver()
    const writeFile = vi.fn(async () => {})
    const r = await browserScreenshot(s, 'browser-3', project, 'shot.png', {}, { realpath, lstat, writeFile })
    const abs = path.join(await fsp.realpath(project), 'shot.png')
    expect(r.ok).toBe(true)
    expect(r.message).toBe(`wrote ${abs} (1280×800, 1 KB) — show it with: show-image ${abs}`)
    expect(writeFile).toHaveBeenCalledWith(abs, expect.any(Buffer))
  })

  it('a traversal path never captures and never writes', async () => {
    const { s, sent } = fakeDriver()
    const writeFile = vi.fn(async () => {})
    const r = await browserScreenshot(s, 'browser-3', project, '../../etc/x.png', {}, { realpath, lstat, writeFile })
    expect(r).toEqual({ ok: false, message: SCREENSHOT_OUTSIDE_PROJECT })
    expect(writeFile).not.toHaveBeenCalled()
    expect(sent).not.toContain('Page.captureScreenshot') // refused BEFORE any CDP work
  })

  it('--full captures the whole content box and reports its dimensions', async () => {
    const { s, sent } = fakeDriver({ contentHeight: 5000 })
    const writeFile = vi.fn(async () => {})
    const r = await browserScreenshot(s, 'browser-3', project, 'full.png', { full: true }, { realpath, lstat, writeFile, sleep: noSleep })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('1280×5000')
    expect(sent).toContain('Page.captureScreenshot')
  })

  it('writes real bytes to a real file end-to-end', async () => {
    const { s } = fakeDriver()
    const writeFile = (p: string, d: Buffer) => fsp.writeFile(p, d)
    const r = await browserScreenshot(s, 'browser-3', project, 'real.png', {}, { realpath, lstat, writeFile })
    expect(r.ok).toBe(true)
    const written = fs.readFileSync(path.join(project, 'real.png'))
    expect(written.toString()).toBe('PNGDATA')
  })
})

const noSleep = async (): Promise<void> => {}

/** A page whose geometry follows the viewport override the way Chromium's does (measured on
 *  Electron 42.9.1): an override as tall as the content clamps scroll to 0, and clearing it leaves
 *  scroll at 0 until something scrolls it back. `grow` models `100vh` content that grows with it. */
function overridePage(opts: { scrollY?: number; contentHeight?: number; wheelWorks?: boolean; grow?: number; failCapture?: boolean } = {}) {
  const base = { width: 1280, height: 800, contentWidth: 1280, contentHeight: opts.contentHeight ?? 3000 }
  let scrollY = opts.scrollY ?? 0
  let override: { width: number; height: number } | null = null
  let attached = true
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const s: Driver = {
    isAttached: () => attached,
    async send(method, params) {
      calls.push({ method, params: params as Record<string, unknown> })
      if (method === 'Emulation.setDeviceMetricsOverride') {
        override = { width: (params as { width: number }).width, height: (params as { height: number }).height }
        scrollY = 0
      }
      if (method === 'Emulation.clearDeviceMetricsOverride') override = null
      if (method === 'Input.dispatchMouseEvent' && opts.wheelWorks !== false) scrollY += (params as { deltaY: number }).deltaY
      if (method === 'Page.captureScreenshot') {
        if (opts.failCapture) throw new Error('capture failed')
        return { data: Buffer.from('PNG').toString('base64') }
      }
      return {}
    },
    async refreshViewport() {
      const height = override ? override.height : base.height
      const contentHeight = override && opts.grow ? Math.max(base.contentHeight, override.height + opts.grow) : base.contentHeight
      return { ...base, height, contentHeight, scrollX: 0, scrollY }
    }
  }
  return { s, calls, methods: () => calls.map((c) => c.method), detach: () => { attached = false }, scrollY: () => scrollY, override: () => override }
}

describe('--full true renders the page as ONE viewport (#539)', () => {
  const deps = () => ({ realpath, lstat, writeFile: vi.fn(async () => {}), sleep: noSleep })

  it('overrides the viewport to the content size, captures, then clears — in that order', async () => {
    const p = overridePage({ contentHeight: 3000 })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    expect(r.ok).toBe(true)
    expect(r.message).toContain('1280×3000')
    const m = p.methods()
    const set = m.indexOf('Emulation.setDeviceMetricsOverride')
    const shot = m.indexOf('Page.captureScreenshot')
    const clear = m.indexOf('Emulation.clearDeviceMetricsOverride')
    expect(set).toBeGreaterThanOrEqual(0)
    expect(set).toBeLessThan(shot)
    expect(shot).toBeLessThan(clear)
    expect(p.calls[set].params).toEqual({ width: 1280, height: 3000, deviceScaleFactor: 0, mobile: false })
    expect(p.calls[shot].params).toMatchObject({ clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 1 } })
    expect(p.override()).toBeNull()
  })

  it('puts a scrolled page back where it was', async () => {
    const p = overridePage({ scrollY: 400 })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    expect(r.ok).toBe(true)
    expect(p.scrollY()).toBe(400)
    expect(r.message).not.toContain('scroll')
  })

  it('says so when the scroll position could not be put back', async () => {
    const p = overridePage({ scrollY: 400, wheelWorks: false })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    expect(r.ok).toBe(true)
    expect(r.message).toContain('the page was at scroll 400 and is now at 0')
  })

  it('clears the override even when the capture fails', async () => {
    const p = overridePage({ failCapture: true })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    expect(r).toEqual({ ok: false, message: 'capture failed' })
    expect(p.methods()).toContain('Emulation.clearDeviceMetricsOverride')
    expect(p.override()).toBeNull()
  })

  it('a lease released mid-capture is never reattached to clear or restore', async () => {
    const p = overridePage({ scrollY: 400, failCapture: true })
    const send = p.s.send.bind(p.s)
    p.s.send = async (method, params) => {
      if (method === 'Page.captureScreenshot') p.detach()
      return send(method, params)
    }
    await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    const after = p.methods().slice(p.methods().indexOf('Page.captureScreenshot') + 1)
    expect(after).toEqual([])
  })

  it('re-measures once when viewport-sized content grows with the override', async () => {
    const p = overridePage({ contentHeight: 3000, grow: 200 })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    const sets = p.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(sets.map((c) => c.params.height)).toEqual([3000, 3200])
    expect(r.message).toContain('1280×3200')
  })

  it('caps a very tall page and says it was cut', async () => {
    const p = overridePage({ contentHeight: FULL_PAGE_MAX_HEIGHT + 5000 })
    const r = await browserScreenshot(p.s, 'browser-3', project, 'full.png', { full: true }, deps())
    expect(r.message).toContain(`1280×${FULL_PAGE_MAX_HEIGHT}`)
    expect(r.message).toContain(`page is ${FULL_PAGE_MAX_HEIGHT + 5000}px tall; captured the first ${FULL_PAGE_MAX_HEIGHT}px`)
  })

  it('the default (viewport) capture never touches emulation', async () => {
    const p = overridePage()
    await browserScreenshot(p.s, 'browser-3', project, 'v.png', {}, deps())
    expect(p.methods().some((m) => m.startsWith('Emulation.'))).toBe(false)
  })
})
