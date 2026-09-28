/** Disposable Electron regression fixture; never attaches to a running nodeterm instance.
 * Build: esbuild scripts/probes/browser-539.ts --bundle --platform=node --external:electron --tsconfig=tsconfig.node.json --outfile=/tmp/browser-539.cjs
 * Run from the checkout: xvfb-run -a electron --no-sandbox /tmp/browser-539.cjs
 * Root-only CI containers require --no-sandbox; normal desktop runs should omit it.
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

async function run(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-539-'))
  app.setPath('userData', path.join(dir, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 800, height: 600, show: true })
  try {
    await window.loadURL('data:text/html,' + encodeURIComponent(`<style>
      body{margin:0}header{position:sticky;top:0;background:red;height:60px}
      main{height:2200px;background:white}footer{position:fixed;bottom:0;background:lime;width:100%;height:30px}
      button{position:absolute;top:700px;left:100px}
      </style><header>sticky</header><main><button onclick="this.textContent='clicked'">target</button></main><footer>fixed</footer>`))
    const session = new BrowserSession({ nodeId: 'fixture', debugger: window.webContents.debugger, viewport: () => ({ viewport: { width: 800, height: 600 } }) })
    const before = await settledViewport(session)
    const scroll = await browserScroll(session, 'fixture', '+400')
    assert.match(scroll.message, /down 400px/)
    const click = await browserClick(session, new RefTable(), 'fixture', 'button')
    assert.equal(click.ok, true)
    // Evaluation is a fixture assertion, never part of the production driver or allowlist.
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("button").textContent'), 'clicked')
    const deps = { realpath: fs.realpath, lstat: fs.lstat, writeFile: fs.writeFile }
    await browserScreenshot(session, 'fixture', dir, 'scrolled.png', { full: true }, deps)
    const image = nativeImage.createFromBuffer(await fs.readFile(path.join(dir, 'scrolled.png')))
    const size = image.getSize()
    const bitmap = image.toBitmap()
    const color = (y: number) => [...bitmap.subarray((y * size.width + 10) * 4, (y * size.width + 10) * 4 + 3)]
    assert.deepEqual(color(420), [0, 0, 255], 'remaining bug: sticky header is captured at the stale scroll offset')
    // The proposed screenshot repair is deliberately only a probe: a revoked debugger leaves its
    // metrics override behind, and clearing the override does not restore the original scroll.
    const raw = (method: string, params: object = {}) => window.webContents.debugger.sendCommand(method, params)
    await raw('Emulation.setDeviceMetricsOverride', { width: 800, height: 2260, deviceScaleFactor: 0, mobile: false })
    await settledViewport(session)
    await raw('Emulation.clearDeviceMetricsOverride')
    const restored = await settledViewport(session)
    assert.equal(restored.height, before.height)
    assert.equal(restored.scrollY, 0, 'remaining blocker: original 400px scroll position was lost')
    await raw('Emulation.setDeviceMetricsOverride', { width: 800, height: 2260, deviceScaleFactor: 0, mobile: false })
    await settledViewport(session)
    session.release()
    const detached = await settledViewport(session)
    assert.equal(detached.height, 2260, 'remaining blocker: detach does not clear emulation')
    console.log(JSON.stringify({ electron: process.versions.electron, scroll: scroll.message,
      click: click.ok, screenshotBugReproduced: true, detachHeight: detached.height,
      scrollAfterRestore: restored.scrollY, passed: true }))
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
