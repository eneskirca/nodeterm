// The phone's terminal: xterm.js (the desktop's emulator) as a RENDERER for a tmux client that
// lives on the computer. Android talks to it through two narrow channels:
//   Android → page: window.nt.* functions, called with base64 so no byte ever needs JS escaping;
//   page → Android: window.NodetermBridge (addJavascriptInterface), strings only.
// tmux owns scrolling (its mouse is on and the pane is on the alternate screen), so a vertical
// swipe becomes wheel notches the HOST writes into the pane — exactly what the relay's
// `pty.scroll` does — and xterm keeps no scrollback of its own worth scrolling.
// tmux's mouse also means xterm's own selection never runs (it is off while the pane reports the
// mouse), so links and copying are this page's job (audit A32): a tap on a URL offers to open it,
// and the Copy sheet (`nt.copySheet`) hands the buffer's lines and links to the app.
(function () {
  'use strict'
  var bridge = window.NodetermBridge
  var fontSize = 13
  var term = new Terminal({
    fontSize: fontSize,
    fontFamily: 'monospace',
    cursorBlink: true,
    scrollback: 1000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: { background: '#000000', foreground: '#e6e6e6', cursor: '#e6e6e6' }
  })
  var fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  var host = document.getElementById('term')
  term.open(host)
  // Retained host history is inert text in its own stable layer. Live xterm remains mounted and
  // parses every byte behind it, preserving parser state, reports, modes and the live buffer.
  var historyPage = null
  var displayEpoch = 0
  var historyLayer = document.createElement('div')
  historyLayer.id = 'history-view'
  historyLayer.hidden = true
  var historyRows = document.createElement('div')
  historyRows.id = 'history-rows'
  var historyTools = document.createElement('div')
  historyTools.id = 'history-tools'
  var historyNote = document.createElement('span')
  historyNote.id = 'history-note'
  var liveButton = document.createElement('button')
  liveButton.textContent = 'Live'
  historyTools.appendChild(historyNote)
  historyTools.appendChild(liveButton)
  historyLayer.appendChild(historyRows)
  historyLayer.appendChild(historyTools)
  host.appendChild(historyLayer)
  function closeScrollView(invalidate, expectedEpoch) {
    if (expectedEpoch !== undefined && expectedEpoch !== displayEpoch) return
    if (invalidate !== false) displayEpoch++
    historyPage = null
    historyLayer.hidden = true
    historyRows.replaceChildren()
  }
  function cancelInputScroll() { cancelScroll(); closeScrollView() }
  liveButton.addEventListener('touchstart', function (e) { cancelScroll(); e.stopPropagation() })
  liveButton.addEventListener('click', function (e) {
    e.stopPropagation()
    cancelInputScroll()
    if (typeof bridge.onHistoryClose === 'function') bridge.onHistoryClose()
  })
  historyLayer.addEventListener('click', function (e) {
    var cell = cellAt(e.clientX, e.clientY)
    var url = cell ? linkAt(cell.row, cell.col) : null
    if (url) { e.preventDefault(); openUrl(url) }
  })
  function showScrollView(b64, epoch) {
    if (!scrollActive || epoch !== displayEpoch) return
    var page
    try { page = JSON.parse(b64ToText(b64)) } catch (e) { return }
    if (!page || page.status !== 'history' || !Array.isArray(page.rows) || !page.rows.length || page.rows.length > 200) return
    historyPage = page
    var rowHeight = measuredScrollStep()
    historyRows.style.fontFamily = 'monospace'
    historyRows.style.fontSize = fontSize + 'px'
    historyRows.style.lineHeight = rowHeight + 'px'
    historyRows.replaceChildren()
    page.rows.forEach(function (row) {
      var line = document.createElement('div')
      line.textContent = row.text || ' '
      line.style.height = rowHeight + 'px'
      historyRows.appendChild(line)
    })
    historyNote.textContent = page.olderTruncated && !page.hasOlder ? 'Earlier output was dropped' : 'History'
    historyLayer.hidden = false
    // Do not cancel/restart the touch or animation here: a response may arrive mid-drag.
  }


  // A closed SSH tmux painter restores its outer terminal after clearing the alternate screen.
  // Keep the last visible pane separately; never suppress control sequences in the live parser.
  var endViewer = null
  var viewerEpoch = 0
  var closedPage = null
  var closedLayer = document.createElement('div')
  closedLayer.id = 'closed-view'
  closedLayer.hidden = true
  closedLayer.style.cssText = 'position:absolute;inset:0;padding:2px 2px 2px 4px;background:#000;color:#e6e6e6;overflow:hidden;touch-action:none;z-index:3'
  host.appendChild(closedLayer)
  function invalidatePendingClosedCapture() {
    userInput = false
    closedTouch = null
    if (endViewer) {
      endViewer.revision++
      endViewer.candidate = null
      endViewer.leftAlternate = false
      endViewer.ending = false
    }
  }
  function clearClosedCapture() {
    viewerEpoch++
    invalidatePendingClosedCapture()
    closedPage = null
    closedLayer.hidden = true
    closedLayer.replaceChildren()
  }
  function beginViewer(token, sshTmux) {
    clearClosedCapture()
    var viewer = { token: token, sshTmux: sshTmux === true, revision: 0,
      capturing: false, enteredAlternate: false, leftAlternate: false, candidate: null, ending: false }
    endViewer = viewer
    // Previously dispatched writes parse before the new viewer may capture anything.
    term.write('', function () { if (endViewer === viewer) viewer.capturing = true })
  }
  function retireViewer() {
    clearClosedCapture()
    endViewer = null
  }
  function captureAlternate(viewer) {
    // Refuse an oversized frame, including blank frames, rather than keeping an older candidate.
    viewer.candidate = null
    if (term.rows > 200 || term.cols > 1000 || term.rows * term.cols > 20000) return
    var buf = term.buffer.active
    var rows = []
    var uris = Object.create(null), ranges = 0, budget = 0
    var encoder = new TextEncoder()
    for (var r = 0; r < term.rows; r++) {
      var line = buf.getLine(buf.viewportY + r)
      var text = line ? line.translateToString(false) : ''
      budget += encoder.encode(text).length
      if (budget > 256 * 1024) return
      var links = []
      for (var c = 0; line && c < term.cols; c++) {
        var cell = line.getCell(c)
        var id = cell && cell.extended ? cell.extended.urlId : 0
        if (id && !Object.prototype.hasOwnProperty.call(uris, id)) {
          var data = term._core._oscLinkService.getLinkData(id)
          if (Object.keys(uris).length >= 128 || (data && data.uri && data.uri.length > 4096)) return
          uris[id] = oscLinkUri(id)
        }
        var href = id ? uris[id] : null
        var last = links[links.length - 1]
        if (href && last && last.url === href && last.end === c) last.end++
        else if (href) {
          if (++ranges > 512) return
          budget += encoder.encode(href).length + 64
          if (budget > 256 * 1024) return
          links.push({ start: c, end: c + 1, url: href })
        }
      }
      rows.push({ text: text, isWrapped: !!(line && line.isWrapped), section: 'alternate', links: links })
    }
    var candidate = { cols: term.cols, rows: rows, copy: snapshot(true) }
    if (encoder.encode(JSON.stringify(candidate)).length <= 1024 * 1024) viewer.candidate = candidate
  }
  term.parser.registerCsiHandler({ final: 'J' }, function (params) {
    var viewer = endViewer
    if (params[0] === 2 && viewer && viewer.sshTmux && viewer.capturing && viewer.enteredAlternate && term.buffer.active.type === 'alternate') captureAlternate(viewer)
    return false
  })
  ;['h', 'l'].forEach(function (final) {
    term.parser.registerCsiHandler({ prefix: '?', final: final }, function (params) {
      var viewer = endViewer
      if (viewer && viewer.sshTmux && viewer.capturing && params.some(function (p) { return p === 47 || p === 1047 || p === 1049 })) {
        if (final === 'h') { viewer.enteredAlternate = true; viewer.leftAlternate = false; viewer.candidate = null }
        else if (viewer.enteredAlternate && term.buffer.active.type === 'alternate') viewer.leftAlternate = true
      }
      return false
    })
  })
  term.onWriteParsed(function () {
    var viewer = endViewer
    // A real live repaint supersedes the pre-clear frame; ED2 alone leaves it pending for teardown.
    if (viewer && viewer.candidate && term.buffer.active.type === 'alternate') {
      for (var r = 0; r < term.buffer.active.length; r++) {
        if (term.buffer.active.getLine(r).translateToString(true)) { viewer.candidate = null; break }
      }
    }
  })
  function endViewerDisplay(token) {
    var viewer = endViewer
    if (!viewer || viewer.token !== token || !viewer.sshTmux || viewer.ending) return
    viewer.ending = true
    var revision = viewer.revision
    term.write('', function () {
      if (endViewer !== viewer || viewer.revision !== revision || !viewer.ending || !viewer.leftAlternate || term.buffer.active.type !== 'normal' || !viewer.candidate) return
      closedPage = viewer.candidate
      scrollActive = false
      cancelScroll()
      closeScrollView()
      renderClosedPage()
    })
  }
  function renderClosedPage() {
    if (!closedPage) return
    var rect = term.element.querySelector('.xterm-screen').getBoundingClientRect()
    var cellWidth = rect.width / term.cols, cellHeight = rect.height / term.rows
    closedPage.metrics = { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      cellWidth: cellWidth, cellHeight: cellHeight }
    closedLayer.replaceChildren()
    closedPage.rows.forEach(function (row) {
      var line = document.createElement('div')
      line.textContent = row.text || ' '
      line.style.cssText = 'pointer-events:none;white-space:pre;font-family:monospace'
      line.style.fontSize = fontSize + 'px'
      line.style.height = line.style.lineHeight = cellHeight + 'px'
      closedLayer.appendChild(line)
    })
    closedLayer.hidden = false
  }
  function closedGeometryChanged() {
    // Resize invalidates a pending EOF capture, but keeps a settled pane and its Copy snapshot.
    invalidatePendingClosedCapture()
    renderClosedPage()
  }
  var closedTouch = null
  function closedLinkAt(x, y) {
    var cell = cellAt(x, y)
    var url = cell ? linkAt(cell.row, cell.col) : null
    if (url) openUrl(url)
  }
  closedLayer.addEventListener('touchstart', function (e) {
    e.stopPropagation()
    closedTouch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
  }, { passive: true })
  closedLayer.addEventListener('touchmove', function (e) {
    e.stopPropagation(); e.preventDefault()
    if (closedTouch && (e.touches.length !== 1 || Math.abs(e.touches[0].clientX - closedTouch.x) > TAP_SLOP || Math.abs(e.touches[0].clientY - closedTouch.y) > TAP_SLOP)) closedTouch = null
  }, { passive: false })
  closedLayer.addEventListener('touchend', function (e) {
    e.stopPropagation(); e.preventDefault()
    var touch = closedTouch
    closedTouch = null
    var end = e.changedTouches && e.changedTouches[0]
    if (closedPage && touch && end && e.touches.length === 0 && Math.abs(end.clientX - touch.x) <= TAP_SLOP && Math.abs(end.clientY - touch.y) <= TAP_SLOP) closedLinkAt(touch.x, touch.y)
  }, { passive: false })
  closedLayer.addEventListener('touchcancel', function (e) { e.stopPropagation(); closedTouch = null }, { passive: true })
  closedLayer.addEventListener('click', function (e) {
    e.stopPropagation(); e.preventDefault()
    if (closedPage) closedLinkAt(e.clientX, e.clientY)
  })
  window.addEventListener('pagehide', retireViewer)

  var lastCols = 0
  var lastRows = 0
  function doFit(force) {
    try { fit.fit() } catch (e) { /* not laid out yet */ }
    if (force || term.cols !== lastCols || term.rows !== lastRows) {
      closedGeometryChanged()
      lastCols = term.cols
      lastRows = term.rows
      bridge.onResize(term.cols, term.rows)
    }
  }
  window.addEventListener('resize', function () { doFit(false); closedGeometryChanged() })

  function b64ToBytes(b64) {
    var bin = atob(b64)
    var out = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  function b64ToText(b64) {
    return new TextDecoder('utf-8').decode(b64ToBytes(b64))
  }

  // onData also carries terminal replies and focus/mouse reports. Those must not cancel a swipe
  // or discard native queued scrolls. In the pinned xterm 5.5 bundle CoreService fires onUserInput
  // immediately BEFORE onData for keys, paste and IME input, but also for SGR mouse reports.
  // Consume the flag once and exclude that complete mouse-report shape. Never cancel in the flag
  // listener: a mouse report sets it too. Keep a guarded fallback if xterm's internal API changes.
  var userInput = false
  var hasInputOrigin = false
  function mouseReport(data) { return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) }
  function generatedReport(data) {
    return mouseReport(data) || /^\x1b\[[IO]$/.test(data) ||
      /^\x1b\[(?:[?>][\d;]*c|\??\d+;\d+R|0n|\??\d+;\d+\$y|[468];\d+;\d+t)$/.test(data) ||
      /^\x1b(?:\][\d;]+;[^\x1b]*|P[01]\$r[^\x1b]*)\x1b\\$/.test(data)
  }
  try {
    var service = term._core && term._core.coreService
    if (service && typeof service.onUserInput === 'function') {
      service.onUserInput(function () { userInput = true })
      hasInputOrigin = true
    }
  } catch (e) { /* a future bundle can still use the public key/DOM fallback below */ }
  if (!hasInputOrigin) {
    if (typeof term.onKey === 'function') term.onKey(function () { userInput = true })
    if (term.textarea && typeof term.textarea.addEventListener === 'function') {
      ;['input', 'paste', 'compositionend'].forEach(function (type) {
        term.textarea.addEventListener(type, function () { userInput = true }, true)
      })
    }
  }
  term.onData(function (d) {
    var fromUser = userInput
    userInput = false
    if (closedPage) return
    if (mouseReport(d) || (!fromUser && (hasInputOrigin || generatedReport(d)))) bridge.onReport(d)
    else { cancelInputScroll(); bridge.onInput(d) }
  })
  // In this xterm bundle onBinary is used only by the legacy mouse encoding.
  term.onBinary(function (d) { userInput = false; if (!closedPage) bridge.onReport(d) })

  // Copy: tmux's copy-mode emits OSC 52 (set-clipboard on). The whole sequence goes to Kotlin's
  // Osc52.parse, which mirrors the desktop's parseOsc52: the ';' is required, a read query ('?') is
  // refused (write-only), and base64 and UTF-8 are decoded strictly. The one check made here is the
  // size cap (audit A53): xterm accepts OSC payloads up to 10,000,000 characters, and a copy that
  // big must neither cross the bridge nor reach the clipboard's binder call. The cap is Kotlin's
  // own constant, read once over the bridge so there is one definition; Kotlin checks it again.
  var copyLimit = bridge.copyLimit()
  term.parser.registerOscHandler(52, function (data) {
    var idx = data.indexOf(';')
    if (idx < 0) return true
    // The selection field before the ';' is a few letters ('c', 'p', 's0'…); a long one is not a
    // clipboard write we understand, and it must not carry megabytes across the bridge either.
    if (idx > 16) return true // = Osc52.MAX_SELECTION
    if (data.length - idx - 1 > copyLimit) bridge.onCopyTooLarge()
    else bridge.onCopy(data)
    return true
  })

  // Links (audit A32). A URL in the pane's output is matched across the rows it wraps over, the
  // desktop's way: the functions from matchUrlTokens to tokenRange are ported from
  // src/renderer/terminal/file-links.ts and keep its names. tmux repaints, and an agent's fullscreen
  // TUI paints, a long line as separate full-width rows with no wrap flag, so a long OAuth URL matched
  // row by row would open only its first row's fragment. That is why @xterm/addon-web-links is not
  // used: it joins only xterm's own soft wraps. OSC 8 links (a label with the URL hidden in the escape
  // sequence; tmux passes them on because the desktop declares `hyperlinks`) go through
  // term.options.linkHandler. Without one, xterm asks with confirm(), which a WebView without a
  // WebChromeClient never shows, so the link did nothing.
  //
  // Every way in ends at openUrl, which hands the bridge only an http(s) URL, as the URL parser
  // normalizes it. The app asks before it leaves for the browser ("Open <host>?") and checks again.
  var URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/gi
  var TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/
  /** Rows joined in each direction at most; a wrapped OAuth URL is about 7 rows at 80 columns. */
  var MAX_JOIN_ROWS = 32

  /** The URL as the URL parser writes it, when it is http(s); null for anything else. */
  function httpHref(text) {
    try {
      var u = new URL(text)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch (e) {
      return null
    }
  }
  function openUrl(raw) {
    var href = httpHref(raw)
    if (href) bridge.openUrl(href)
  }

  function matchUrlTokens(lineText) {
    var out = []
    var re = new RegExp(URL_RE.source, 'gi')
    var m
    while ((m = re.exec(lineText)) !== null) {
      var text = m[0].replace(TRAILING_PUNCT, '')
      if (text.length < 8) continue // "http://x" is the shortest sane URL
      if (!httpHref(text)) continue
      out.push({ text: text, startIndex: m.index, url: text })
    }
    return out
  }

  function bufferView(liveOnly) {
    var capturedPage = !liveOnly && (closedPage || historyPage)
    if (capturedPage) return {
      cols: capturedPage.cols,
      history: true,
      length: capturedPage.rows.length,
      line: function (row) {
        var line = capturedPage.rows[row]
        return line ? { isWrapped: line.isWrapped, section: line.section,
          text: function (trim) { return trim ? line.text.replace(/\s+$/, '') : line.text } } : undefined
      }
    }
    var buf = term.buffer.active
    return {
      cols: term.cols,
      length: buf.length,
      line: function (row) {
        var l = buf.getLine(row)
        return l ? { isWrapped: l.isWrapped, text: function (trim) { return l.translateToString(trim) } } : undefined
      }
    }
  }

  function historyCellWidth(text) {
    var service = term._core && term._core.unicodeService
    return service && typeof service.getStringCellWidth === 'function' ? service.getStringCellWidth(text) : text.length
  }
  function historyStringIndex(text, col) {
    var service = term._core && term._core.unicodeService
    if (!service || typeof service.wcwidth !== 'function') return col
    var cell = 0
    var index = 0
    while (index < text.length) {
      var code = text.codePointAt(index)
      var width = service.wcwidth(code)
      if (cell + width > col) return index
      cell += width
      index += code > 65535 ? 2 : 1
    }
    return index + Math.max(0, col - cell)
  }

  // Whether `row` runs into `row + 1`: the next row carries xterm's soft-wrap flag, or `row` is full
  // to its last column and the next row starts at column 0 with a non-space (a repainted wrap). A
  // heuristic: the buffer cannot tell a repainted wrap from text that exactly fills the row.
  function continuesOnNextRow(view, row) {
    var next = view.line(row + 1)
    if (!next) return false
    var current = view.line(row)
    if (current && current.section && current.section !== next.section) return false
    if (next.isWrapped) return true
    var cur = view.line(row)
    if (!cur) return false
    var raw = cur.text(false)
    if ((view.history ? historyCellWidth(raw) : raw.length) < view.cols || raw[raw.length - 1] === ' ') return false
    var nextRaw = next.text(false)
    return nextRaw.length > 0 && nextRaw[0] !== ' '
  }

  // The logical paragraph containing `row` (0-based). Every row that continues contributes exactly
  // `cols` characters, so an index into `text` is the cell (startRow + idx / cols, idx % cols); the
  // last row is right-trimmed. One departure from the desktop's: the walk up stops a row earlier, so
  // the MAX_JOIN_ROWS rows joined downward always reach `row`. The desktop's could walk up all 32 and
  // then join only the 32 above `row` (a tap there missed its link), and the Copy sheet's scan below
  // would make no progress through such a wall of full-width rows (a TUI's bordered box draws one).
  function paragraphContaining(view, row) {
    if (!view.line(row)) return null
    var start = row
    while (start > 0 && row - start < MAX_JOIN_ROWS - 1 && continuesOnNextRow(view, start - 1)) start--
    var text = ''
    var rowOffsets = []
    var r = start
    for (;;) {
      var joins = r - start + 1 < MAX_JOIN_ROWS && continuesOnNextRow(view, r)
      var lineText = view.line(r).text(!joins)
      rowOffsets.push(text.length)
      text += joins ? (view.history ? lineText + ' '.repeat(Math.max(0, view.cols - historyCellWidth(lineText))) : lineText.padEnd(view.cols).slice(0, view.cols)) : lineText
      if (!joins) break
      r++
    }
    return { text: text, startRow: start, rows: r - start + 1, rowOffsets: rowOffsets }
  }

  /** An ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
  function tokenRange(startRow, cols, startIndex, len) {
    var endIndex = startIndex + len - 1
    return {
      start: { x: (startIndex % cols) + 1, y: startRow + Math.floor(startIndex / cols) + 1 },
      end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
    }
  }

  /**
   * The http(s) URI of the OSC 8 link at a cell, or null. Read through xterm's private
   * `extended.urlId` and `_core._oscLinkService`, as the desktop's osc8UrlAt does: the public buffer
   * API has no hyperlink data. A fresh cell per read: a reused one keeps the previous cell's `extended`.
   */
  function oscLinkUri(urlId) {
    var core = term._core
    var service = core && core._oscLinkService
    var data = urlId && service ? service.getLinkData(urlId) : null
    return data && data.uri && httpHref(data.uri) ? data.uri : null
  }
  function osc8UrlAt(row, col) {
    var line = term.buffer.active.getLine(row)
    var cell = line && line.getCell(col)
    return oscLinkUri(cell && cell.extended ? cell.extended.urlId : 0)
  }

  /** The URL at a buffer cell: an OSC 8 link's, else a URL in the text's paragraph. */
  function linkAt(row, col) {
    if (closedPage) {
      var capturedRow = closedPage.rows[row]
      var link = capturedRow && capturedRow.links.find(function (link) { return col >= link.start && col < link.end })
      if (link) return link.url
    }
    var capturedPage = closedPage || historyPage
    var osc8 = capturedPage ? null : osc8UrlAt(row, col)
    if (osc8) return osc8
    var p = paragraphContaining(bufferView(), row)
    if (!p) return null
    var idx = capturedPage ? p.rowOffsets[row - p.startRow] + historyStringIndex(capturedPage.rows[row].text, col)
      : (row - p.startRow) * term.cols + col
    var tokens = matchUrlTokens(p.text)
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i]
      if (idx >= t.startIndex && idx < t.startIndex + t.text.length) return t.url
    }
    return null
  }

  /** The cell (0-based column, 0-based buffer row) under a point in the page, or null. */
  function cellAt(x, y) {
    var screen = term.element && term.element.querySelector('.xterm-screen')
    if (!screen || term.cols <= 0 || term.rows <= 0) return null
    var rect = closedPage ? closedPage.metrics : screen.getBoundingClientRect()
    var dx = x - rect.left
    var dy = y - rect.top
    if (dx < 0 || dy < 0 || dx >= rect.width || dy >= rect.height) return null
    var cw = closedPage ? rect.cellWidth : rect.width / term.cols
    var ch = closedPage ? rect.cellHeight : rect.height / term.rows
    if (cw <= 0 || ch <= 0) return null
    var row = Math.floor(dy / ch)
    var capturedPage = closedPage || historyPage
    if (capturedPage && (row >= capturedPage.rows.length || Math.floor(dx / cw) >= capturedPage.cols)) return null
    return { col: Math.floor(dx / cw), row: row + (capturedPage ? 0 : term.buffer.active.viewportY) }
  }

  // A mouse click on a link (a phone with a mouse, while the pane does not report the mouse; xterm's
  // own link handling stands aside when it does). On a touch screen the tap handler below runs first.
  term.registerLinkProvider({
    provideLinks: function (y, callback) {
      if (closedPage || historyPage) { callback(undefined); return }
      var p = paragraphContaining(bufferView(), y - 1)
      if (!p) {
        callback(undefined)
        return
      }
      var links = matchUrlTokens(p.text).map(function (u) {
        return {
          text: u.text,
          range: tokenRange(p.startRow, term.cols, u.startIndex, u.text.length),
          activate: function () { openUrl(u.url) }
        }
      })
      callback(links.length ? links : undefined)
    }
  })
  term.options.linkHandler = {
    activate: function (event, uri) { openUrl(uri) },
    allowNonHttpProtocols: false
  }

  // The Copy sheet (audit A32): the buffer's last SNAPSHOT_ROWS rows (under tmux, the alternate screen
  // has no scrollback, so that is the visible screen), soft wraps joined into one line each, and the
  // http(s) links in them (text URLs joined across wraps as above, and OSC 8 links). The app shows the
  // lines to select, copies or shares them under its clipboard cap, and offers the links.
  var SNAPSHOT_ROWS = 500
  var SNAPSHOT_LINKS = 50
  function snapshot(liveOnly) {
    if (closedPage && !liveOnly) return closedPage.copy
    if (historyPage && !liveOnly) {
      var captured = historyPage.rows
      var lines = []
      captured.forEach(function (row, index) {
        if (row.isWrapped && lines.length && captured[index - 1].section === row.section) {
          var previous = captured[index - 1].text
          lines[lines.length - 1] += ' '.repeat(Math.max(0, historyPage.cols - historyCellWidth(previous))) + row.text
        }
        else lines.push(row.text)
      })
      var links = []
      for (var hr = 0; hr < captured.length;) {
        var paragraph = paragraphContaining(bufferView(), hr)
        if (!paragraph) break
        matchUrlTokens(paragraph.text).forEach(function (token) {
          var href = httpHref(token.url)
          if (href && links.indexOf(href) < 0 && links.length < SNAPSHOT_LINKS) links.push(href)
        })
        hr = Math.max(hr + 1, paragraph.startRow + paragraph.rows)
      }
      return { lines: lines, links: links, firstVisible: 0 }
    }
    var buf = term.buffer.active
    var view = bufferView(true)
    var end = buf.length
    var start = Math.max(0, end - SNAPSHOT_ROWS)
    // A line cut off at the top would start part-way through.
    while (start < end && view.line(start) && view.line(start).isWrapped) start++
    var lines = []
    var firstVisible = 0
    for (var r = start; r < end; r++) {
      var l = view.line(r)
      if (!l) break
      var next = view.line(r + 1)
      var continues = !!(next && next.isWrapped)
      var text = l.text(!continues)
      if (l.isWrapped && lines.length) lines[lines.length - 1] += text
      else lines.push(text)
      if (r === buf.viewportY) firstVisible = lines.length - 1
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    if (firstVisible > lines.length - 1) firstVisible = Math.max(0, lines.length - 1)

    var links = []
    var seen = {}
    for (var row = start; row < end;) {
      var p = paragraphContaining(view, row)
      if (!p) break
      var found = matchUrlTokens(p.text).map(function (t) { return { at: t.startIndex, url: t.url } })
      for (var pr = Math.max(p.startRow, start); pr < p.startRow + p.rows && pr < end; pr++) {
        var line = buf.getLine(pr)
        var last = 0
        for (var x = 0; line && x < term.cols; x++) {
          var cell = line.getCell(x)
          var id = cell && cell.extended ? cell.extended.urlId : 0
          if (id && id !== last) {
            var uri = oscLinkUri(id)
            if (uri) found.push({ at: (pr - p.startRow) * term.cols + x, url: uri })
          }
          last = id
        }
      }
      found.sort(function (a, b) { return a.at - b.at })
      for (var i = 0; i < found.length; i++) {
        var href = httpHref(found[i].url)
        if (href && !Object.prototype.hasOwnProperty.call(seen, href)) {
          seen[href] = true
          links.push(href)
        }
      }
      row = Math.max(row + 1, p.startRow + p.rows)
    }
    if (links.length > SNAPSHOT_LINKS) links = links.slice(links.length - SNAPSHOT_LINKS)
    return { lines: lines, links: links, firstVisible: firstVisible }
  }

  // Vertical swipe → tmux history scroll. A tap (one finger, moved at most TAP_SLOP px) on a link hands
  // it to the app, which offers to open it (audit A32). tmux runs `mouse on`, so the mouse events a tap
  // produces would also reach the pane as a click. On a link the touchend is cancelled, which suppresses them: the click reaches
  // neither tmux nor the app in the pane, and the soft keyboard does not come up. A tap anywhere else
  // is left alone.
  var TAP_SLOP = 10
  var startY = null
  var acc = 0
  var tapX = null
  var tapY = null
  // One rendered text-row of finger movement requests one wheel notch. Stock tmux advances five
  // history rows per notch: this responsive gain lets a short phone swipe reach useful history.
  // A host with custom wheel bindings can have a different history distance.
  var scrollStep = fontSize * 1.4
  var pendingScroll = []
  var scrollFrame = null
  var scrollRequestedAt = 0
  var scrollActive = true
  var motionSamples = []
  var lastMotionDelta = 0
  var gestureNotches = 0
  var fling = null
  var FLING_SAMPLE_MS = 120
  var FLING_RELEASE_MS = 80
  var FLING_MIN_SPEED = 0.45
  var FLING_MAX_SPEED = 3
  var FLING_STOP_SPEED = 0.06
  var FLING_DECAY_MS = 240
  var FLING_MAX_MS = 1000
  var FLING_MAX_PX = 1200
  function cancelScroll() {
    if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame)
    scrollFrame = null
    pendingScroll = []
    acc = 0
    startY = null
    tapX = null
    motionSamples = []
    lastMotionDelta = 0
    gestureNotches = 0
    fling = null
    // A new touch/input/lifecycle barrier must also stop accepted but unsent native movement.
    // The bridge is harmless before a stream is attached; older page-test stubs may omit it.
    if (typeof bridge.onScrollStop === 'function') bridge.onScrollStop()
  }
  function recordMotion(y, time, delta) {
    if (!(time > 0) || !isFinite(time)) { motionSamples = []; return }
    var last = motionSamples[motionSamples.length - 1]
    if (last && time <= last.time) { motionSamples = [{ y: y, time: time }]; return }
    // A reversal starts a new velocity sample at the turn, rather than carrying the old fling's
    // direction into a swipe whose last movement went the other way.
    if (last && delta * lastMotionDelta < 0) motionSamples = [last]
    motionSamples.push({ y: y, time: time })
    while (motionSamples.length > 1 && time - motionSamples[0].time > FLING_SAMPLE_MS) motionSamples.shift()
    if (delta) lastMotionDelta = delta
  }
  function startFling(time) {
    if (!scrollActive || !gestureNotches || motionSamples.length < 2 || !(time > 0)) return
    var first = motionSamples[0]
    var last = motionSamples[motionSamples.length - 1]
    var elapsed = last.time - first.time
    if (elapsed <= 0 || time < last.time || time - last.time > FLING_RELEASE_MS) return
    var speed = (last.y - first.y) / elapsed
    if (!isFinite(speed) || Math.abs(speed) < FLING_MIN_SPEED) return
    speed = Math.max(-FLING_MAX_SPEED, Math.min(FLING_MAX_SPEED, speed))
    var now = performance.now()
    fling = { speed: speed, started: now, last: now, distance: 0 }
    scheduleScroll()
  }
  function advanceFling(time) {
    if (!fling) return
    var dt = Math.min(time - fling.last, FLING_MAX_MS - (fling.last - fling.started))
    // RAF's timestamp can precede the touchend's performance.now within the same frame. Keep
    // the fling for the next frame rather than treating that first nonpositive delta as a stop.
    if (dt <= 0) return
    // Integrate exponential decay over elapsed time so 30/60/120 Hz produce the same distance.
    var decay = Math.exp(-dt / FLING_DECAY_MS)
    var distance = Math.min(Math.abs(fling.speed) * FLING_DECAY_MS * (1 - decay), FLING_MAX_PX - fling.distance)
    acc += (fling.speed > 0 ? 1 : -1) * distance
    fling.distance += distance
    fling.speed *= decay
    fling.last = time
    if (Math.abs(fling.speed) < FLING_STOP_SPEED || time - fling.started >= FLING_MAX_MS || fling.distance >= FLING_MAX_PX) fling = null
    var notches = Math.floor(Math.abs(acc) / scrollStep)
    if (notches) {
      var up = acc > 0
      acc -= (up ? 1 : -1) * notches * scrollStep
      queueScroll(up, notches)
    }
  }
  function scheduleScroll() {
    if (scrollFrame !== null || (!pendingScroll.length && !fling) || !scrollActive) return
    scrollRequestedAt = performance.now()
    scrollFrame = window.requestAnimationFrame(function (time) {
      scrollFrame = null
      // A suspended page must not replay an old swipe after returning or after an input/reset.
      if (time - scrollRequestedAt > 250) { cancelScroll(); return }
      advanceFling(time)
      var next = pendingScroll[0]
      if (!scrollActive) return
      // Both transports clamp to 20. Retain the rest and drain one ordered request per frame,
      // including after touchend, rather than silently losing a fast swipe's distance.
      if (next) {
        var notches = Math.min(20, next.notches)
        next.notches -= notches
        if (!next.notches) pendingScroll.shift()
        if (typeof bridge.onScrollView === 'function') bridge.onScrollView(next.up, notches, displayEpoch)
        else bridge.onScroll(next.up, notches)
      }
      scheduleScroll()
    })
  }
  function queueScroll(up, notches) {
    if (!notches || !scrollActive) return
    var last = pendingScroll[pendingScroll.length - 1]
    if (last && last.up === up) last.notches += notches
    else pendingScroll.push({ up: up, notches: notches })
    scheduleScroll()
  }
  function measuredScrollStep() {
    var screen = term.element && term.element.querySelector('.xterm-screen')
    var rowHeight = screen && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0
    return rowHeight > 0 && isFinite(rowHeight) ? rowHeight : fontSize * 1.4
  }
  window.addEventListener('pagehide', cancelScroll)
  window.addEventListener('blur', cancelScroll)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') cancelScroll()
  })
  host.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      cancelScroll()
      startY = e.touches[0].clientY
      acc = 0
      // Measure once per gesture; querying layout on every touchmove would force repeated work.
      scrollStep = measuredScrollStep()
      tapX = e.touches[0].clientX
      tapY = e.touches[0].clientY
      recordMotion(startY, e.timeStamp, 0)
    } else {
      cancelScroll()
    }
  }, { passive: true })
  host.addEventListener('touchmove', function (e) {
    if (startY === null || e.touches.length !== 1) return
    var y = e.touches[0].clientY
    if (tapX !== null && (Math.abs(e.touches[0].clientX - tapX) > TAP_SLOP || Math.abs(y - tapY) > TAP_SLOP)) tapX = null
    var delta = y - startY
    recordMotion(y, e.timeStamp, delta)
    acc += delta
    startY = y
    var notches = Math.floor(Math.abs(acc) / scrollStep)
    if (notches) {
      gestureNotches += notches
      var up = acc > 0
      acc -= (up ? 1 : -1) * notches * scrollStep
      queueScroll(up, notches)
    }
    e.preventDefault()
  }, { passive: false })
  host.addEventListener('touchend', function (e) {
    startY = null
    var x = tapX
    var y = tapY
    tapX = null
    if (e.touches.length > 0) { cancelScroll(); return }
    if (x === null) { startFling(e.timeStamp); return }
    var cell = cellAt(x, y)
    var url = cell ? linkAt(cell.row, cell.col) : null
    if (!url) return
    e.preventDefault()
    openUrl(url)
  }, { passive: false })
  host.addEventListener('touchcancel', cancelScroll, { passive: true })

  window.nt = {
    beginViewer: beginViewer,
    endViewer: endViewerDisplay,
    retireViewer: retireViewer,
    write: function (b64) { term.write(b64ToBytes(b64)) },
    // The attach snapshot: the current screen, painted before live output.
    paint: function (b64) { clearClosedCapture(); cancelInputScroll(); term.reset(); term.write(b64ToText(b64).replace(/\r?\n/g, '\r\n')) },
    reset: function () { clearClosedCapture(); cancelInputScroll(); term.reset() },
    showScrollView: showScrollView,
    closeScrollView: closeScrollView,
    scrollFailed: function (epoch) { if (epoch === displayEpoch) cancelScroll() },
    cancelScroll: cancelScroll,
    suspendScroll: function () { retireViewer(); scrollActive = false; cancelInputScroll() },
    resumeScroll: function () { if (!closedPage) scrollActive = true },
    // Native raw chips cancel on this JS thread before their input reaches the host.
    raw: function (b64) { if (closedPage) return; cancelInputScroll(); bridge.onInput(b64ToText(b64)) },
    focus: function () { term.focus() },
    blur: function () { term.blur() },
    // The ⌨ chip (audit A46): the Kotlin side has just given the WebView Android's focus and asks
    // the system for the soft keyboard; this puts the page's focus on xterm's textarea for it.
    // Blur first: Blink's focus() on the element that already has focus returns early and does
    // nothing, and that is the normal state once the terminal has been tapped. (With focus
    // reporting on, xterm reports a focus-out and a focus-in to the pane for this.)
    focusForKeyboard: function () { term.blur(); term.focus() },
    // The Copy sheet (audit A32): what the buffer holds, as JSON, for the app to show.
    copySheet: function () { bridge.onCopySheet(JSON.stringify(snapshot())) },
    setFontSize: function (n) { cancelInputScroll(); fontSize = n; term.options.fontSize = n; doFit(true) },
    refit: function () { doFit(true) },
    // A composed line from the native input bar. `term.paste` frames it as a bracketed paste when
    // the client side asked for one, so a multi-line prompt reaches an agent CLI as ONE paste; the
    // Enter is a separate, slightly later write (an Enter inside the paste write is what left
    // Codex holding a rendered-but-unsubmitted envelope — see CLAUDE.md, settled submit).
    // Special keys from the native key row. Arrows follow the pane's DECCKM state, which this
    // emulator tracks because it parses the very stream the pane writes.
    key: function (name) {
      if (closedPage) return
      cancelInputScroll()
      var app = term.modes.applicationCursorKeysMode
      var csi = app ? '\x1bO' : '\x1b['
      var map = {
        up: csi + 'A', down: csi + 'B', right: csi + 'C', left: csi + 'D',
        home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~',
        esc: '\x1b', tab: '\t', stab: '\x1b[Z', enter: '\r', nl: '\x1b\r'
      }
      var seq = map[name]
      if (seq) bridge.onInput(seq)
    },
    submit: function (b64, enter) {
      if (closedPage) return
      cancelInputScroll()
      var text = b64ToText(b64)
      if (text) term.paste(text)
      var epoch = viewerEpoch
      if (enter) setTimeout(function () { if (closedPage || viewerEpoch !== epoch) return; cancelInputScroll(); bridge.onInput('\r') }, text ? 150 : 0)
    }
  }

  setTimeout(function () {
    doFit(true)
    bridge.onReady()
  }, 30)
})()
