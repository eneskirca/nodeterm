// Runs the Android app's REAL terminal page script (android/app/src/main/assets/terminal/terminal.js)
// in node, against stubs of xterm.js, the DOM and the WebView bridge, so a JVM test can check what
// the page does. Driven today: the OSC 52 handler (audit A53), the page's focus for the ⌨ chip
// (audit A46), links and the Copy sheet (audit A32), and touch-to-history wheel requests.
//
// Usage: node terminal-js-driver.cjs <path to terminal.js>
// stdin:  {"copyLimit": <number the stub bridge answers>, "osc52": ["<OSC 52 data>", ...],
//          "textareaFocused": <bool, the textarea's focus before the calls>, "nt": ["<window.nt fn>", ...],
//          "screen": {"cols": n, "rows": n, "viewportY": n, "cellHeight": px,
//                     "lines": [{"text": "...", "wrapped": <bool>, "links": [{"from": col, "to": col, "uri": "..."}]}]},
//          "provideLinks": [<1-based buffer line>, ...],
//          "linkHandler": ["<OSC 8 URI>", ...],
//          "fontSize": px, "originUnavailable": <bool, omit xterm's internal input-origin event>,
//          "taps": [{"col": c, "row": <viewport row>, "move": [dx, dy], "moves": [[dx,dy], ...], "fingers": n,
//                    "startTime": ms, "endTime": ms, "before": [action, ...], "after": [action, ...],
//                    "frameDelay": ms, "rafInterval": ms}],
//          "copySheet": <bool>}
//         (every field but copyLimit is optional; with no "screen" the buffer is 80×24 and empty)
// stdout: one JSON object:
//   {"copyLimitCalls": n, "osc52": [{"returned": <handler result>, "calls": [[name, arg?], ...]}],
//    "nt": [{"fn": name, "focusChanges": ["blur" | "focus", ...], "focusedAfter": bool}],
//    "provideLinks": [{"links": null | [{"text", "range", "opened": [url, ...]}]}],
//    "linkHandler": [{"opened": [url, ...]}],
//    "taps": [{"prevented": bool, "movePrevented": bool, "opened": [url, ...], "scrolls": [[up, notches], ...],
//              "scrollsBeforeFrame": [...], "scrollFrames": [{"frame": n, "up": bool, "notches": n}],
//              "inputs": [text, ...], "reports": [text, ...], "scrollStops": [{"frame": n, "time": ms}], "endedAt": ms}],
//    "copySheet": {"raw": "<the JSON string the page handed onCopySheet>", "calls": n},
//    "confirmCalls": n}
// where an onCopy call's argument is reported as {"length": n, "sameAsInput": bool}, so a payload of
// several hundred thousand characters never has to be echoed back. The stub textarea follows Blink's
// rule for focus(): on the element that already has focus it returns early, changing nothing, and so
// does blur() on one that has not. focusChanges lists only the changes that took effect.
//
// The stub buffer answers what terminal.js reads of xterm's: getLine(row).isWrapped,
// translateToString(trim) (a row's text padded to `cols` untrimmed, right-trimmed otherwise), and
// getCell(col).extended.urlId for the cells of an OSC 8 link, whose URI `_core._oscLinkService` holds.
// The screen element sits at (4, 2) with 10×20 px cells; a tap is a touchstart at the cell's centre,
// touchmoves at offsets in `moves` (or one `move`), and a touchend at the end point. `fingers` > 1
// starts with that many touches. A move's optional third entry is its timestamp; untimed events
// default to timestamp0 and never synthesize momentum. `rafInterval` sets following frame intervals.
//
// Actions are {"nt": fn, "args": [...]}, {"event": "touchstart"|"touchmove"|"blur"|"pagehide"|"hidden"|
// "touchcancel"|"multitouch", "move": [dx,dy]}, {"liveTouch": {"type": "touchstart"|"touchmove"|"touchend"|"touchcancel", "x": px, "y": px}},
// {"checkpoint": label}, {"frame": true}, {"frames": n}, {"timers": true}, {"data": text}, {"report": text},
// {"mouse": text} or {"binary": text}. Data/paste fire xterm's user-origin event; SGR mouse fires
// it too, while generated reports and legacy mouse do not.
// They run before touchstart or after touchend, before the queued
// animation frames drain deterministically (16ms per frame, or `frameDelay` for the first frame).
// "scrollsBeforeFrame" catches unbatched calls; "inputs"/"reports" record their separate bridge
// paths. "opened" lists URLs.
'use strict'
const fs = require('fs')
const vm = require('vm')

const scriptPath = process.argv[2]
const input = JSON.parse(fs.readFileSync(0, 'utf8'))

let current = null
let copyLimitCalls = 0
let opened = []
let scrolls = []
let scrollFrames = []
let inputs = []
let reports = []
let scrollStops = []
let frameNumber = 0
let frameTime = 0
let nextFrameId = 1
const animationFrames = new Map()
const timers = []
function requestAnimationFrame(callback) {
  const id = nextFrameId++
  animationFrames.set(id, callback)
  return id
}
function cancelAnimationFrame(id) { animationFrames.delete(id) }
let copySheetRaw = null
let copySheetCalls = 0
let confirmCalls = 0
let lastScrollEpoch = 0
let historyCloses = 0
const liveWrites = []
let liveResets = 0
const historyResponses = (input.historyResponses || []).slice()
const bridge = {
  copyLimit() {
    copyLimitCalls++
    return input.copyLimit
  },
  onCopy(data) {
    current.calls.push(['onCopy', { length: data.length, sameAsInput: data === current.input }])
  },
  onCopyTooLarge() {
    current.calls.push(['onCopyTooLarge'])
  },
  openUrl(url) {
    if (typeof url !== 'string') throw new Error('openUrl takes a string')
    opened.push(url)
  },
  onCopySheet(json) {
    if (typeof json !== 'string') throw new Error('onCopySheet takes a string')
    copySheetCalls++
    copySheetRaw = json
  },
  onResize() {},
  onReady() {},
  onInput(data) { inputs.push(data) },
  onReport(data) { reports.push(data) },
  onScrollStop() { scrollStops.push({ frame: frameNumber, time: frameTime }) },
  onScroll(up, notches) {
    scrolls.push([up, notches])
    scrollFrames.push({ frame: frameNumber, time: frameTime, up, notches })
  },
  onScrollView(up, notches, epoch) {
    lastScrollEpoch = epoch
    this.onScroll(up, notches)
    const response = historyResponses.shift()
    if (response) sandbox.window.nt.showScrollView(Buffer.from(JSON.stringify(response)).toString('base64'), epoch)
  },
  onHistoryClose() { historyCloses++ }
}

const screenIn = input.screen || { cols: 80, rows: 24, lines: [] }
const COLS = screenIn.cols
const ROWS = screenIn.rows
const CELL_W = 10
const CELL_H = screenIn.cellHeight === undefined ? 20 : screenIn.cellHeight
const SCREEN_LEFT = 4
const SCREEN_TOP = 2
const linkUris = []
const rowsData = (screenIn.lines || []).map((l) => {
  const text = (l.text || '').slice(0, COLS)
  const cellLinks = new Array(COLS).fill(0)
  for (const link of l.links || []) {
    linkUris.push(link.uri)
    const id = linkUris.length
    for (let x = link.from; x <= link.to && x < COLS; x++) cellLinks[x] = id
  }
  return { text, wrapped: !!l.wrapped, cellLinks }
})
// At least a screenful: rows below the given lines are blank, as in a real buffer.
while (rowsData.length < ROWS) rowsData.push({ text: '', wrapped: false, cellLinks: new Array(COLS).fill(0) })
const viewportY = screenIn.viewportY === undefined ? Math.max(0, rowsData.length - ROWS) : screenIn.viewportY

function bufferLine(row) {
  const d = rowsData[row]
  if (!d) return undefined
  return {
    isWrapped: d.wrapped,
    length: COLS,
    translateToString(trim) {
      return trim ? d.text.replace(/\s+$/, '') : d.text.padEnd(COLS)
    },
    getCell(x) {
      if (x < 0 || x >= COLS) return undefined
      // A fresh object per read, as xterm's getCell(x) without a cell to reuse.
      return { extended: { urlId: d.cellLinks[x] } }
    }
  }
}

const oscHandlers = {}
const linkProviders = []
let textareaFocused = !!input.textareaFocused
let focusChanges = null
const screenElement = {
  getBoundingClientRect() {
    return { left: SCREEN_LEFT, top: SCREEN_TOP, width: COLS * CELL_W, height: ROWS * CELL_H }
  }
}
let createdTerm = null
const userInputListeners = []
const textareaListeners = {}
class Terminal {
  constructor() {
    createdTerm = this
    this.cols = COLS
    this.rows = ROWS
    this.modes = {}
    this.options = {}
    this.element = undefined
    this.buffer = {
      active: { length: rowsData.length, viewportY, baseY: viewportY, getLine: bufferLine }
    }
    this._core = {
      coreService: input.originUnavailable ? undefined : {
        onUserInput(fn) { userInputListeners.push(fn) }
      },
      _oscLinkService: {
        getLinkData(id) {
          return id > 0 && id <= linkUris.length ? { id: String(id), uri: linkUris[id - 1] } : undefined
        }
      }
    }
    this.textarea = {
      addEventListener(type, fn) { listen(textareaListeners, type, fn) }
    }
    this.parser = {
      registerCsiHandler() { return { dispose() {} } },
      registerOscHandler(ident, fn) {
        oscHandlers[ident] = fn
      }
    }
  }
  loadAddon() {}
  open() {
    this.element = {
      querySelector(sel) {
        return sel === '.xterm-screen' ? screenElement : null
      }
    }
  }
  registerLinkProvider(provider) {
    linkProviders.push(provider)
    return { dispose() {} }
  }
  onWriteParsed() { return { dispose() {} } }
  onData(fn) { this.dataCallback = fn }
  onBinary(fn) { this.binaryCallback = fn }
  onKey(fn) { this.keyCallback = fn }
  write(data) { liveWrites.push(typeof data === 'string' ? data : new TextDecoder().decode(data)) }
  reset() { liveResets++ }
  focus() {
    if (textareaFocused) return
    textareaFocused = true
    if (focusChanges) focusChanges.push('focus')
  }
  blur() {
    if (!textareaFocused) return
    textareaFocused = false
    if (focusChanges) focusChanges.push('blur')
  }
  paste(text) { emitData(text, true) }
}
function emitData(data, fromUser) {
  if (fromUser) {
    for (const fn of userInputListeners) fn()
    if (createdTerm.keyCallback) createdTerm.keyCallback({ key: data })
  }
  createdTerm.dataCallback(data)
}
class FitAddonStub {
  fit() {}
}
const hostListeners = {}
const windowListeners = {}
const documentListeners = {}
function listen(listeners, type, fn) {
  ;(listeners[type] = listeners[type] || []).push(fn)
}
const domElements = []
function domElement() {
  const listeners = {}
  const item = { style: {}, hidden: false, textContent: '', children: [], parentElement: null, _listeners: listeners,
    appendChild(child) { child.parentElement = this; this.children.push(child) },
    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null
      this.children = children
      for (const child of children) child.parentElement = this
    },
    addEventListener(type, fn) { listen(listeners, type, fn) },
    // A child event reaches the terminal host only if its actual handler permits bubbling.
    dispatch(type, fields = {}) {
      let propagationStopped = false
      const event = { ...fields, type, target: this, defaultPrevented: false,
        stopPropagation() { propagationStopped = true },
        preventDefault() { this.defaultPrevented = true }
      }
      for (let node = this; node; node = node.parentElement) {
        event.currentTarget = node
        const registered = node === element ? hostListeners : node._listeners
        for (const fn of registered[type] || []) fn(event)
        if (propagationStopped) break
      }
      return { propagationStopped, defaultPrevented: event.defaultPrevented }
    }
  }
  domElements.push(item)
  return item
}
const element = domElement()
element.addEventListener = (type, fn) => listen(hostListeners, type, fn)

const sandbox = {
  Terminal,
  FitAddon: { FitAddon: FitAddonStub },
  document: { getElementById: () => element, createElement: domElement, visibilityState: 'visible',
    addEventListener(type, fn) { listen(documentListeners, type, fn) } },
  window: { NodetermBridge: bridge, requestAnimationFrame, cancelAnimationFrame,
    addEventListener(type, fn) { listen(windowListeners, type, fn) } },
  performance: { now: () => frameTime },
  setTimeout(callback) { timers.push(callback); return timers.length },
  // xterm's default OSC 8 activation asks with confirm(); the page must never get there.
  confirm() {
    confirmCalls++
    return false
  },
  TextDecoder,
  URL,
  JSON,
  atob
}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox, { filename: scriptPath })

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n')
  process.exit(0)
}

const handler = oscHandlers[52]
if (typeof handler !== 'function') fail('terminal.js registered no OSC 52 handler')
const results = []
for (const data of input.osc52 || []) {
  current = { input: data, calls: [] }
  const returned = handler(data)
  results.push({ returned, calls: current.calls })
}

const nt = sandbox.window.nt
const ntResults = []
for (const fn of input.nt || []) {
  if (!nt || typeof nt[fn] !== 'function') fail('terminal.js has no window.nt.' + fn)
  focusChanges = []
  nt[fn]()
  ntResults.push({ fn, focusChanges, focusedAfter: textareaFocused })
  focusChanges = null
}

const provided = []
for (const y of input.provideLinks || []) {
  if (linkProviders.length !== 1) fail('terminal.js registered ' + linkProviders.length + ' link providers, not 1')
  let reply = 'no callback'
  linkProviders[0].provideLinks(y, (links) => {
    reply = links
  })
  if (reply === 'no callback') fail('the link provider did not answer for line ' + y)
  provided.push({
    links: reply
      ? reply.map((l) => {
          opened = []
          l.activate({ type: 'mouseup' }, l.text)
          return { text: l.text, range: l.range, opened }
        })
      : null
  })
}

const handled = []
for (const uri of input.linkHandler || []) {
  opened = []
  const linkHandler = optionsOfTerm().linkHandler
  if (!linkHandler || typeof linkHandler.activate !== 'function') fail('terminal.js set no options.linkHandler')
  if (linkHandler.allowNonHttpProtocols) fail('options.linkHandler.allowNonHttpProtocols is on')
  linkHandler.activate({ type: 'mouseup' }, uri, { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } })
  handled.push({ opened })
}

function touchAt(x, y) {
  return { clientX: x, clientY: y, identifier: 0 }
}
function dispatch(type, event) {
  for (const fn of hostListeners[type] || []) fn(event)
}
const tapped = []
let checkpoints = []
let domEvents = []
function actions(items) {
  for (const action of items || []) {
    if (action.nt) {
      if (typeof nt[action.nt] !== 'function') fail('unknown nt action ' + action.nt)
      nt[action.nt](...(action.args || []))
    } else if (action.checkpoint) {
      checkpoints.push({ label: action.checkpoint, frame: frameNumber, time: frameTime,
        requests: scrolls.length, notches: scrolls.reduce((sum, request) => sum + request[1], 0),
        stops: scrollStops.length, framesQueued: animationFrames.size, historyCloses,
        historyVisible: !domElements.find(e => e.id === 'history-view').hidden })
    } else if (action.liveTouch) {
      const button = domElements.find(e => e.textContent === 'Live')
      if (!button || domElements.find(e => e.id === 'history-view').hidden) fail('Live button is not displayed')
      const { type, x = 40, y = 20 } = action.liveTouch
      if (!['touchstart', 'touchmove', 'touchend', 'touchcancel'].includes(type)) fail('unknown Live touch ' + type)
      const touch = touchAt(x, y)
      const ended = type === 'touchend' || type === 'touchcancel'
      const result = button.dispatch(type, { touches: ended ? [] : [touch], changedTouches: [touch], timeStamp: frameTime })
      domEvents.push({ target: 'Live', type, frame: frameNumber, ...result })
    } else if (action.event) {
      if (action.event === 'touchstart') dispatch('touchstart', { touches: [touchAt(10, 10)], timeStamp: frameTime })
      else if (action.event === 'touchmove') dispatch('touchmove', {
        touches: [touchAt(10 + action.move[0], 10 + action.move[1])], timeStamp: frameTime,
        preventDefault() {}
      })
      else if (action.event === 'touchcancel') dispatch('touchcancel', { touches: [], changedTouches: [] })
      else if (action.event === 'multitouch') dispatch('touchstart', { touches: [touchAt(10, 10), touchAt(60, 10)] })
      else if (action.event === 'hidden') {
        sandbox.document.visibilityState = 'hidden'
        for (const fn of documentListeners.visibilitychange || []) fn()
      } else {
        for (const fn of windowListeners[action.event] || []) fn()
      }
    } else if (action.frame) runFrame(action.delay)
    else if (action.frames) for (let i = 0; i < action.frames; i++) runFrame(action.delay)
    else if (action.timers) {
      const callbacks = timers.splice(0)
      for (const callback of callbacks) callback()
    }
    else if (action.data !== undefined) emitData(action.data, true)
    else if (action.report !== undefined) emitData(action.report, false)
    else if (action.mouse !== undefined) emitData(action.mouse, true)
    else if (action.binary !== undefined) createdTerm.binaryCallback(action.binary)
    else if (action.history) nt.showScrollView(Buffer.from(JSON.stringify(action.history)).toString('base64'), action.epoch === undefined ? lastScrollEpoch : action.epoch)
    else if (action.live) domElements.find(e => e.textContent === 'Live').dispatch('click')
  }
}
actions(input.actions)
function runFrame(delay) {
  if (!animationFrames.size) return
  if (++frameNumber > 300) fail('scroll animation did not drain within 300 frames')
  frameTime += delay === undefined ? 16 : delay
  const callbacks = Array.from(animationFrames.values())
  animationFrames.clear()
  for (const callback of callbacks) callback(frameTime)
}
function drainFrames(firstDelay, frameDelay) {
  let first = true
  while (animationFrames.size) {
    runFrame(first ? firstDelay : frameDelay)
    first = false
  }
}
if (input.fontSize !== undefined) nt.setFontSize(input.fontSize)
for (const tap of input.taps || []) {
  opened = []
  scrolls = []
  scrollFrames = []
  inputs = []
  reports = []
  scrollStops = []
  checkpoints = []
  domEvents = []
  frameNumber = 0
  let prevented = false
  let movePrevented = false
  const x = SCREEN_LEFT + tap.col * CELL_W + CELL_W / 2
  const y = SCREEN_TOP + tap.row * CELL_H + CELL_H / 2
  const fingers = tap.fingers || 1
  const start = []
  actions(tap.before)
  if (tap.startTime !== undefined) frameTime = Math.max(frameTime, tap.startTime)
  for (let i = 0; i < fingers; i++) start.push(touchAt(x + i * 50, y))
  dispatch('touchstart', { touches: start, changedTouches: start, timeStamp: tap.startTime || 0, preventDefault() {} })
  let ex = x
  let ey = y
  for (const [moveIndex, move] of (tap.moves || (tap.move ? [tap.move] : [])).entries()) {
    ex = x + move[0]
    ey = y + move[1]
    const moved = []
    if (move[2] !== undefined) frameTime = Math.max(frameTime, move[2])
    for (let i = 0; i < fingers; i++) moved.push(touchAt(ex + i * 50, ey))
    dispatch('touchmove', { touches: moved, changedTouches: moved, timeStamp: move[2] || 0,
      preventDefault() { movePrevented = true } })
    actions((tap.moveActions || [])[moveIndex])
  }
  if (tap.endTime !== undefined) frameTime = Math.max(frameTime, tap.endTime)
  dispatch('touchend', {
    touches: [],
    changedTouches: [touchAt(ex, ey)],
    timeStamp: tap.endTime || 0,
    preventDefault() {
      prevented = true
    }
  })
  actions(tap.after)
  const scrollsBeforeFrame = scrolls.slice()
  drainFrames(tap.frameDelay, tap.rafInterval)
  tapped.push({ prevented, movePrevented, opened, scrolls, scrollsBeforeFrame, scrollFrames, inputs, reports, scrollStops, endedAt: frameTime, checkpoints, domEvents })
}

let copySheet = null
if (input.copySheet) {
  if (!nt || typeof nt.copySheet !== 'function') fail('terminal.js has no window.nt.copySheet')
  nt.copySheet()
  copySheet = { raw: copySheetRaw, calls: copySheetCalls }
}

function optionsOfTerm() {
  if (!createdTerm) fail('terminal.js created no Terminal')
  return createdTerm.options
}

process.stdout.write(
  JSON.stringify({
    copyLimitCalls,
    osc52: results,
    nt: ntResults,
    provideLinks: provided,
    linkHandler: handled,
    taps: tapped,
    copySheet,
    confirmCalls,
    history: { hidden: domElements.find(e => e.id === 'history-view').hidden,
      rows: domElements.find(e => e.id === 'history-rows').children.map(e => e.textContent) }, liveWrites, liveResets, historyCloses
  }) + '\n'
)
