/** Disposable Electron regression fixture for #539; never attaches to a running nodeterm instance.
 * Build: esbuild scripts/probes/browser-539.ts --bundle --platform=node --external:electron --tsconfig=tsconfig.node.json --outfile=/tmp/browser-539.cjs
 * Run from the checkout: xvfb-run -a electron --no-sandbox /tmp/browser-539.cjs
 * Root-only CI containers require --no-sandbox; normal desktop runs should omit it.
 *
 * It drives the REAL BrowserSession + allowlist + actions against a page with a sticky header and a
 * fixed footer, scrolled 400px, and asserts: scroll reports measured movement, a click lands, the
 * full-page screenshot paints the header once at the top and the footer once at the bottom, the
 * scroll position comes back, and no viewport override survives the capture or a release.
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserSession } from '../../src/main/browser-lease'
import { browserScroll, browserClick, settledViewport } from '../../src/main/browser-actions'
import { browserScreenshot } from '../../src/main/browser-screenshot'
import { RefTable } from '../../src/main/browser-refs'

/** Classify every 10th row of column 10: R(ed header) G(reen footer) or . (anything else). */
function rows(png: Buffer): string {
  const image = nativeImage.createFromBuffer(png)
  const { width, height } = image.getSize()
  const bm = image.toBitmap() // BGRA
  let line = ''
  for (let y = 0; y < height; y += 10) {
    const i = (y * width + 10) * 4
    const [b, g, r] = [bm[i], bm[i + 1], bm[i + 2]]
    line += r > 240 && g < 20 && b < 20 ? 'R' : g > 240 && r < 20 && b < 20 ? 'G' : '.'
  }
  return line
}

async function run(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-539-'))
  app.setPath('userData', path.join(dir, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 800, height: 600, show: true })
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent(`<style>
      body{margin:0}header{position:sticky;top:0;background:rgb(255,0,0);height:60px}
      main{height:2200px;background:white}footer{position:fixed;bottom:0;background:rgb(0,255,0);width:100%;height:30px}
      button{position:absolute;top:700px;left:100px}
      </style><header>sticky</header><main><button onclick="this.textContent='clicked'">target</button></main><footer>fixed</footer>`))
    const session = new BrowserSession({ nodeId: 'fixture', debugger: window.webContents.debugger, viewport: () => ({ viewport: { width: 800, height: 600 } }) })
    const top = await settledViewport(session)
    const scroll = await browserScroll(session, 'fixture', '+400')
    assert.match(scroll.message, /down 400px/)
    const click = await browserClick(session, new RefTable(), 'fixture', 'button')
    assert.equal(click.ok, true)
    // Evaluation is a fixture assertion, never part of the production driver or allowlist.
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("button").textContent'), 'clicked')
    const deps = { realpath: fs.realpath, lstat: fs.lstat, writeFile: fs.writeFile }
    const shot = await browserScreenshot(session, 'fixture', dir, 'full.png', { full: true }, deps)
    assert.equal(shot.ok, true, shot.message)
    const line = rows(await fs.readFile(path.join(dir, 'full.png')))
    // 2260px tall: header rows 0-50 only, footer rows 2230-2250 only.
    assert.equal(line.indexOf('R'), 0, `sticky header must be at the top once: ${line}`)
    assert.equal(line.lastIndexOf('R'), 5, `sticky header painted elsewhere: ${line}`)
    assert.equal(line.indexOf('G'), line.length - 3, `fixed footer must be at the bottom only: ${line}`)
    const after = await settledViewport(session)
    assert.equal(after.scrollY, 400, 'scroll position restored after the capture')
    assert.equal(after.height, top.height, 'override cleared after the capture')
    // A release while an override is outstanding must clear it before detaching.
    await session.send('Emulation.setDeviceMetricsOverride', { width: Math.round(top.width), height: 2260, deviceScaleFactor: 0, mobile: false })
    session.release()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const released = await settledViewport(session)
    assert.equal(released.height, top.height, 'release() cleared the override')
    console.log(JSON.stringify({ electron: process.versions.electron, scroll: scroll.message, shot: shot.message, rows: line, passed: true }))
    session.release()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    window.destroy()
    await fs.rm(dir, { recursive: true, force: true })
    app.exit(process.exitCode ? 1 : 0)
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; app.quit() })
