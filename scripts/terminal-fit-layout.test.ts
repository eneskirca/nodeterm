import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

// Real layout + hit testing, not jsdom's zero rectangles. CI/device runs can supply CHROME_BIN.
const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
it.skipIf(!existsSync(chrome)).each([1, 1.25, 1.5, 2])('at DPR %s fits complete terminal rows inside the padded canvas host at fractional display scales', async (dpr) => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-fit-layout-'))
  try {
    const bundle = await build({
      entryPoints: ['test/fixtures/terminal-fit-layout.tsx'], bundle: true, write: false,
      loader: { '.svg': 'dataurl' }, tsconfig: 'tsconfig.web.json', define: { 'process.env.NODE_ENV': '"production"' }
    })
    const css = readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8') + readFileSync('src/renderer/styles.css', 'utf8')
    writeFileSync(join(dir, 'index.html'), `<style>${css}</style><div id="root"></div><pre id="result">WAIT</pre><script>${bundle.outputFiles[0].text}</script>`)
    const browser = spawn(chrome, [
      '--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${join(dir, 'profile')}`,
      '--window-size=1800,1100', '--remote-debugging-port=0', 'about:blank'
    ])
    const exited = new Promise(resolve => browser.once('exit', resolve))
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = ''
        browser.stderr.on('data', chunk => {
          output += chunk
          const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)
          if (match) resolve(match[1])
        })
        browser.on('error', reject)
        browser.on('exit', code => reject(new Error(`Chrome exited: ${code}`)))
      })
      const ws = new WebSocket(endpoint)
      await new Promise(resolve => ws.once('open', resolve))
      let id = 0
      const call = (method: string, params = {}, sessionId?: string): Promise<any> => {
        const next = ++id
        return new Promise((resolve, reject) => {
          const onMessage = (raw: WebSocket.RawData): void => {
            const message = JSON.parse(raw.toString())
            if (message.id !== next) return
            ws.off('message', onMessage)
            if (message.error) reject(new Error(JSON.stringify(message.error)))
            else resolve(message.result)
          }
          ws.on('message', onMessage)
          ws.send(JSON.stringify({ id: next, method, params, sessionId }))
        })
      }
      try {
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
        await call('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1100, deviceScaleFactor: dpr, mobile: false }, sessionId)
        await call('Page.enable', {}, sessionId)
        const loaded = new Promise<void>(resolve => {
          const listener = (raw: WebSocket.RawData): void => {
            const msg = JSON.parse(raw.toString())
            if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
              ws.off('message', listener)
              resolve()
            }
          }
          ws.on('message', listener)
        })
        await call('Page.navigate', { url: pathToFileURL(join(dir, 'index.html')).href }, sessionId)
        await loaded
        const value = await call('Runtime.evaluate', {
          expression: `new Promise(resolve => { const timer = setInterval(() => {
            const text = document.getElementById('result')?.textContent;
            if (text && text !== 'WAIT') { clearInterval(timer); resolve(text); }
          }, 50); setTimeout(() => { clearInterval(timer); resolve('TIMEOUT'); }, 15000); })`,
          awaitPromise: true, returnByValue: true
        }, sessionId)
        const result = value.result.value
        expect(result).toMatch(/^PASS /)
        console.log('Terminal layout checks passed.')
      } finally {
        await call('Browser.close')
        // The CDP acknowledgement precedes profile flush/child shutdown. Wait for the process
        // to finish normally before the fallback kill, or it can leave writers racing cleanup.
        await exited
        ws.close()
      }
    } finally {
      browser.kill()
      await exited
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 40000)
