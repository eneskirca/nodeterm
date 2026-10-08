// Runs the actual Android xterm/Fit/page bundles in jsdom. Only browser layout/canvas facilities
// and the Android bridge are supplied; keyboard, IME, focus, mouse encoding and parser replies
// execute xterm's real implementation. This checks the interactions a stub onData cannot model.
// Usage: node terminal-xterm-interaction-driver.cjs <terminal.js>; stdout is one JSON reply.
'use strict'
const { JSDOM } = require('jsdom')
const fs = require('node:fs')
const path = require('node:path')
const scriptPath = process.argv[2]
const assets = process.argv[3] || path.dirname(scriptPath)
const indexPath = process.argv[4] || path.join(assets, 'index.html')
const pageStyles = fs.readFileSync(indexPath, 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]
const xtermStyles = fs.readFileSync(path.join(assets, 'xterm.css'), 'utf8')
const dom = new JSDOM('<!doctype html><style>' + xtermStyles + pageStyles + '* { padding: 0; }</style><div id="term"></div>', {
  url: 'https://terminal.test/', runScripts: 'outside-only', pretendToBeVisual: true
})
const win = dom.window
win.TextDecoder = TextDecoder
win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} })
win.HTMLCanvasElement.prototype.getContext = () => ({
  measureText: () => ({ width: 10, actualBoundingBoxAscent: 16, actualBoundingBoxDescent: 4 }),
  fillRect() {}, clearRect() {}, getImageData: () => ({ data: new Uint8Array([0, 0, 0, 255]) }),
  createLinearGradient: () => ({ addColorStop() {} })
})
Object.defineProperties(win.HTMLElement.prototype, {
  clientWidth: { get() { return 526 } }, clientHeight: { get() { return 906 } },
  offsetWidth: { get() { return (this.textContent || '').length * 10 } },
  offsetHeight: { get() { return 20 } }
})
win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 4, top: 2, width: 520, height: 900, right: 524, bottom: 902 })
let now = 0
let nextFrame = 1
const frames = new Map()
win.performance.now = () => now
win.requestAnimationFrame = fn => { const id = nextFrame++; frames.set(id, fn); return id }
win.cancelAnimationFrame = id => frames.delete(id)
let terminal
let ready = false
let events = []
let lastDisplayEpoch = 0
let copySnapshot
let openedUrls = []
win.NodetermBridge = {
  copyLimit: () => 400000, onResize() {}, onInput: data => events.push({ input: data }),
  onReport: data => events.push({ report: data }), onScroll: (up, notches) => events.push({ scroll: { up, notches } }),
  onScrollStop: () => events.push({ stop: true }),
  onScrollView: (up, notches, epoch) => { lastDisplayEpoch = epoch; events.push({ scroll: { up, notches } }) },
  onCopy() {}, onCopyTooLarge() {}, onCopySheet(raw) { copySnapshot = JSON.parse(raw) },
  openUrl(url) { openedUrls.push(url) }, onReady() { ready = true }
}
win.eval(fs.readFileSync(path.join(assets, 'xterm.js'), 'utf8'))
const Original = win.Terminal
win.Terminal = class extends Original {
  constructor(options) { super(options); terminal = this }
}
win.eval(fs.readFileSync(path.join(assets, 'addon-fit.js'), 'utf8'))
win.eval(fs.readFileSync(scriptPath, 'utf8'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function drainFrames() {
  let count = 0
  while (frames.size) {
    if (++count > 100) throw new Error('animation frames did not drain')
    now += 16
    const batch = [...frames.values()]
    frames.clear()
    for (const fn of batch) fn(now)
  }
}
const write = data => new Promise(resolve => terminal.write(data, resolve))
async function main() {
  try {
    for (let n = 0; !ready && n < 100; n++) await pause(5)
    if (!ready) throw new Error('actual page never became ready')
    terminal.resize(52, 45)
    await write('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h')
    terminal._core.coreService.onUserInput(() => events.push({ userOrigin: true }))
    const target = terminal.element.querySelector('.xterm-screen')
    function touch(type, y, timestamp = 0, touchTarget = target) {
      const t = { identifier: 1, target: touchTarget, clientX: 30, clientY: y, pageX: 30, pageY: y }
      const event = new win.TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t], changedTouches: [t] })
      Object.defineProperty(event, 'timeStamp', { value: timestamp })
      now = Math.max(now, timestamp)
      touchTarget.dispatchEvent(event)
    }
    const actions = {
      'touch-only': async () => {},
      'focus-report': async () => terminal.blur(),
      'mouse-motion-report': async () => target.dispatchEvent(new win.MouseEvent('mousemove', {
        bubbles: true, clientX: 31, clientY: 301, buttons: 0 })),
      'cursor-query-reply': async () => write('\x1b[6n'),
      'device-attributes-reply': async () => write('\x1b[c'),
      'legacy-mouse-report': async () => {
        await write('\x1b[?1006l')
        target.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 51, clientY: 341, buttons: 0 }))
        await write('\x1b[?1006h')
      },
      'keyboard-escape': async () => terminal.textarea.dispatchEvent(new win.KeyboardEvent('keydown', {
        bubbles: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 })),
      'bracketed-paste': async () => terminal.paste('pasted text'),
      'ime-input': async () => terminal.textarea.dispatchEvent(new win.InputEvent('input', {
        bubbles: true, data: '\u65e5', inputType: 'insertText' })),
      'ime-composition': async () => {
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionstart', { bubbles: true }))
        terminal.textarea.value = '\u672c'
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionupdate', { bubbles: true, data: '\u672c' }))
        await pause(1)
        terminal.textarea.dispatchEvent(new win.CompositionEvent('compositionend', { bubbles: true, data: '\u672c' }))
        await pause(1)
      }
    }
    const results = []
    for (const [name, action] of Object.entries(actions)) {
      win.nt.cancelScroll()
      terminal.focus()
      drainFrames()
      events = []
      touch('touchstart', 500)
      touch('touchmove', 300)
      await action()
      touch('touchmove', 100)
      touch('touchend', 100)
      drainFrames()
      results.push({ name, events: events.slice(), notches: events.reduce((sum, event) => sum + (event.scroll?.notches || 0), 0) })
    }
    win.nt.cancelScroll()
    events = []
    const start = now + 10
    touch('touchstart', 500, start)
    touch('touchmove', 300, start + 50)
    touch('touchend', 300, start + 55)
    terminal.blur()
    await write('\x1b[6n')
    drainFrames()
    const kinetic = { events: events.slice(), notches: events.reduce((sum, event) => sum + (event.scroll?.notches || 0), 0), duration: now - start - 55 }
    async function repaintGesture(usePageHitRules) {
      win.nt.cancelScroll()
      await write('\x1b[H' + Array.from({ length: 45 }, (_, row) => 'initial row ' + row + '\x1b[K').join('\r\n'))
      drainFrames()
      const span = target.querySelector('.xterm-rows > div:nth-child(25) span')
      if (!span) throw new Error('actual DOM renderer did not paint the touch target')
      let touchTarget = span
      // jsdom has no geometric hit testing. Walk the real computed pointer-events styles to
      // select the eligible ancestor, then retain that same target for the entire touch stream.
      // The comparison deliberately bypasses these rules to reproduce the old removed-span bug.
      if (usePageHitRules) {
        while (touchTarget && win.getComputedStyle(touchTarget).pointerEvents === 'none') touchTarget = touchTarget.parentElement
      }
      if (!touchTarget) throw new Error('page CSS removed every possible touch target')
      const host = win.document.getElementById('term')
      const seen = []
      const listener = event => seen.push(event.type)
      for (const type of ['touchstart', 'touchmove', 'touchend']) host.addEventListener(type, listener)
      events = []
      const began = now + 10
      touch('touchstart', 500, began, touchTarget)
      touch('touchmove', 480, began + 20, touchTarget)
      drainFrames()
      await write('\x1b[25;1Hreplacement after remote redraw\x1b[K')
      drainFrames()
      const originalSpanRemoved = !span.isConnected
      touch('touchmove', 400, began + 60, touchTarget)
      touch('touchend', 400, began + 65, touchTarget)
      drainFrames()
      for (const type of ['touchstart', 'touchmove', 'touchend']) host.removeEventListener(type, listener)
      return { originalSpanRemoved, targetWasScreen: touchTarget === target, targetStillConnected: touchTarget.isConnected,
        hostEvents: seen, notches: events.reduce((sum, event) => sum + (event.scroll?.notches || 0), 0) }
    }
    const repaint = { removedSpan: await repaintGesture(false), pageHitTarget: await repaintGesture(true),
      touchAction: win.getComputedStyle(target).getPropertyValue('touch-action') }
    let resets = 0
    const originalReset = terminal.reset.bind(terminal)
    terminal.reset = () => { resets++; originalReset() }
    const captured = { status: 'history', viewId: 'b3b8e879-6449-4c8c-8529-4c02d6885878', offset: 3,
      totalRows: 5, cols: 52, olderTruncated: false, hasOlder: false, hasNewer: true,
      rows: [{ text: '界 https://old.example/x', isWrapped: false, section: 'normal' },
        { text: '<b>inert captured text</b>', isWrapped: false, section: 'alternate' }] }
    win.nt.showScrollView(Buffer.from(JSON.stringify(captured)).toString('base64'), lastDisplayEpoch)
    const layer = win.document.getElementById('history-view')
    const oldRow = win.document.getElementById('history-rows').firstElementChild
    events = []
    const beganHistory = now + 10
    touch('touchstart', 500, beganHistory, layer)
    touch('touchmove', 480, beganHistory + 20, layer)
    drainFrames()
    win.nt.showScrollView(Buffer.from(JSON.stringify(captured)).toString('base64'), lastDisplayEpoch)
    await write('\x1b[?1h\x1b[?2004l\x1b[Hlive output behind retained history\x1b[6n')
    touch('touchmove', 380, beganHistory + 60, layer)
    touch('touchend', 380, beganHistory + 65, layer)
    drainFrames()
    win.nt.copySheet()
    // A cell after the wide CJK prefix must map to the displayed URL, not the live buffer.
    const tap = new win.TouchEvent('touchstart', { bubbles: true, cancelable: true,
      touches: [{ clientX: 84, clientY: 12 }], changedTouches: [{ clientX: 84, clientY: 12 }] })
    layer.dispatchEvent(tap)
    layer.dispatchEvent(new win.TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [],
      changedTouches: [{ clientX: 84, clientY: 12 }] }))
    const history = { visible: !layer.hidden, rowReplaced: !oldRow.isConnected, layerConnected: layer.isConnected,
      noHtml: !layer.querySelector('b'), rows: [...win.document.getElementById('history-rows').children].map(row => row.textContent),
      copySnapshot, openedUrls, resets, applicationCursor: terminal.modes.applicationCursorKeysMode,
      bracketedPaste: terminal.modes.bracketedPasteMode,
      liveText: terminal.buffer.active.getLine(terminal.buffer.active.baseY).translateToString(true),
      events: events.slice() }
    const oldEpoch = lastDisplayEpoch
    terminal.paste('explicit input')
    win.nt.showScrollView(Buffer.from(JSON.stringify(captured)).toString('base64'), oldEpoch)
    history.closedAfterInput = layer.hidden
    process.stdout.write(JSON.stringify({ rows: terminal.rows, cols: terminal.cols,
      mouseMode: terminal.modes.mouseTrackingMode, results, kinetic, repaint, history }) + '\n')
  } finally {
    terminal.dispose()
    dom.window.close()
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
