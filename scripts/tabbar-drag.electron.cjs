// Launched only by tabbar-drag.test.ts, on its own Xvfb display and disposable profile.
// Native XTest clicks matter: CDP / sendInputEvent bypass Electron's window hit test.
const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')

const [profile, stylesheet] = process.argv.slice(-2)
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-gpu')
const pause = () => new Promise(resolve => setTimeout(resolve, 60))
const nativeClick = (x, y) => execFileSync('python3', ['-c', `
import ctypes
x = ctypes.CDLL('libX11.so.6'); t = ctypes.CDLL('libXtst.so.6')
x.XOpenDisplay.restype = ctypes.c_void_p
d = x.XOpenDisplay(None)
assert d, 'Xvfb display unavailable'
t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
t.XTestFakeMotionEvent(d, -1, ${x}, ${y}, 0)
t.XTestFakeButtonEvent(d, 1, 1, 0)
t.XTestFakeButtonEvent(d, 1, 0, 0)
x.XSync(d, 0)
x.XCloseDisplay(d)
`])

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 600, frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } })
  const js = code => win.webContents.executeJavaScript(code)
  // Isolated titlebar fixture using the full production stylesheet. No bridge, PTY or user data.
  const tabs = Array.from({ length: 41 }, (_,i) => `<div class="tab${i === 0 ? ' active' : ''}" draggable="true"><span class="tab__name">Project ${i}</span><input class="tab__edit" value="Rename ${i}" style="width:60px"><button class="tab__caret">⋮</button></div>`).join('')
  await win.loadURL('data:text/html,' + encodeURIComponent(`<style>${readFileSync(stylesheet, 'utf8')}</style><div class="tabbar"><div class="brand"><span class="brand__name">nodeterm</span></div><div class="tabbar__projects"><div class="tabbar__tabs">${tabs}</div><button class="tab-add">+</button></div></div>`))
  await js(`window.hits=[]; document.addEventListener('mousedown', e => hits.push(e.target.className));`)
  const click = async (selector, expected) => {
    const point = await js(`(() => {
      const viewport = document.querySelector('.tabbar__tabs').getBoundingClientRect();
      const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => {
        const r = el.getBoundingClientRect();
        return !el.closest('.tabbar__tabs') || (r.left >= viewport.left && r.right <= viewport.right);
      });
      if (!el) throw new Error('No fully visible target: ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2};
    })()`)
    const bounds = win.getContentBounds()
    nativeClick(Math.round(bounds.x + point.x), Math.round(bounds.y + point.y))
    await pause()
    const hits = await js('hits.splice(0)')
    assert.deepEqual(hits, expected, `${selector}: native hit test`)
  }
  let cases = 0
  for (const inset of [false, true]) {
    for (const height of [28, 40, 64]) {
      await js(`document.documentElement.dataset.windowChrome=${JSON.stringify(inset ? 'inset' : '')}; document.documentElement.style.setProperty('--tabbar-h','${height}px')`)
      for (const scroll of [0, 1, 100, 1800, 99999, 0]) {
        await js(`document.querySelector('.tabbar__tabs').scrollLeft=${scroll}`)
        await pause()
        await click('.brand__name', []) // Native drag areas must NOT deliver a renderer mousedown.
        await click('.tab__name', ['tab__name'])
        await click('.tab__caret', ['tab__caret'])
        await click('.tab__edit', ['tab__edit'])
        assert.equal(await js(`document.activeElement.className`), 'tab__edit')
        await click('.tab-add', ['tab-add'])
        cases++
      }
    }
  }
  // With few tabs, the unused project area remains a drag handle too.
  await js(`Array.from(document.querySelectorAll('.tab')).slice(1).forEach(el=>el.remove()); document.querySelector('.tabbar__tabs').scrollLeft=0`)
  await pause()
  const gap = await js(`(() => {const r=document.querySelector('.tab-add').getBoundingClientRect();return {x:r.right+30,y:r.y+r.height/2}})()`)
  const bounds = win.getContentBounds()
  nativeClick(Math.round(bounds.x+gap.x), Math.round(bounds.y+gap.y))
  await pause()
  assert.deepEqual(await js('hits.splice(0)'), [])
  console.log('TABBAR_RESULT ' + JSON.stringify({ electron: process.versions.electron, cases, nativeHitTests: cases * 5 + 1 }))
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
