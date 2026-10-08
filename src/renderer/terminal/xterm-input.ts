import type { Terminal } from '@xterm/xterm'

type CoreService = { triggerDataEvent(data: string, wasUserInput?: boolean): void }
type BrowserCore = {
  coreService: CoreService
  _handleTextAreaFocus(...args: unknown[]): void
  _handleTextAreaBlur(...args: unknown[]): void
}
type Lease = { focused(): boolean }
type Origin = { user: boolean; focus: boolean }

// Session ids can repeat in another local/relay core. This registry is deliberately limited to
// co-viewers in this renderer, sharing the exact PTY API object and actual session generation.
const responders = new WeakMap<object, Map<string, Lease[]>>()
const bound = new WeakSet<Terminal>()

function acquire(pty: object, sessionId: string, lease: Lease): () => void {
  let sessions = responders.get(pty)
  if (!sessions) responders.set(pty, sessions = new Map())
  let viewers = sessions.get(sessionId)
  if (!viewers) sessions.set(sessionId, viewers = [])
  viewers.push(lease)
  return () => {
    const at = viewers.indexOf(lease)
    if (at === -1) return
    viewers.splice(at, 1)
    if (!viewers.length) sessions.delete(sessionId)
    if (!sessions.size) responders.delete(pty)
  }
}

function ownsReply(pty: object, sessionId: string, lease: Lease, data: string): boolean {
  const viewers = responders.get(pty)?.get(sessionId)
  // DEC1004's initial focus query runs on every emulator, including a hidden Canvas. Its answer
  // must describe the focused co-viewer, rather than let the first hidden viewer send blur.
  const focused = data === '\x1b[I' || data === '\x1b[O'
    ? viewers?.find((viewer) => viewer.focused()) : undefined
  return (focused ?? viewers?.[0]) === lease
}

/** Bind xterm input once per live term/session. Keep this binding across Canvas park/adoption;
 * retire it on session exit or final disposal. All genuine input reaches the writer unchanged.
 * Only one co-viewer answers automatic terminal queries, without timers or byte deduplication.
 *
 * xterm 5.5's public onData erases wasUserInput. This version-bound adapter carries the flag while
 * its actual CoreService dispatches onData synchronously. Focus/blur events are also tagged:
 * their exact ESC[I/O notifications are genuine view changes, unlike _reportFocus queries.
 * An unsupported private shape warns and retains public input, rather than discard user paste.
 */
export function bindXtermInput(
  term: Terminal,
  pty: object,
  sessionId: string,
  write: (data: string) => void
): () => void {
  if (bound.has(term)) throw new Error('xterm input is already bound to a session')
  const core = (term as unknown as { _core?: Partial<BrowserCore> })._core
  const service = core?.coreService
  if (!service || typeof service.triggerDataEvent !== 'function' ||
    typeof core?._handleTextAreaFocus !== 'function' || typeof core?._handleTextAreaBlur !== 'function') {
    console.warn('[terminal] unsupported xterm input origin adapter; preserving public input')
    let disposed = false
    const listener = term.onData((data) => { if (!disposed) write(data) })
    bound.add(term)
    return () => {
      if (disposed) return
      disposed = true
      bound.delete(term)
      listener.dispose()
    }
  }

  const browser = core as BrowserCore
  const originalTrigger = service.triggerDataEvent
  const originalFocus = browser._handleTextAreaFocus
  const originalBlur = browser._handleTextAreaBlur
  let focusData: string | undefined
  let origin: Origin | undefined
  let disposed = false
  const lease: Lease = {
    // A parked/detached terminal can retain its old focus class. Only actual connected DOM focus
    // can override the ordinary responder; a live focused Modal must win over that stale class.
    focused: () => !!term.textarea?.isConnected &&
      term.textarea.ownerDocument.activeElement === term.textarea
  }
  const release = acquire(pty, sessionId, lease)
  bound.add(term)
  const trigger: CoreService['triggerDataEvent'] = function (this: CoreService, ...args) {
    const [data, wasUserInput = false] = args
    const previous = origin
    origin = { user: wasUserInput, focus: !wasUserInput && data === focusData }
    try { originalTrigger.apply(this, args) }
    finally { origin = previous }
  }
  const focus = function (this: BrowserCore, ...args: unknown[]): void {
    const previous = focusData
    focusData = '\x1b[I'
    try { originalFocus.apply(this, args) }
    finally { focusData = previous }
  }
  const blur = function (this: BrowserCore, ...args: unknown[]): void {
    const previous = focusData
    focusData = '\x1b[O'
    try { originalBlur.apply(this, args) }
    finally { focusData = previous }
  }
  service.triggerDataEvent = trigger
  browser._handleTextAreaFocus = focus
  browser._handleTextAreaBlur = blur
  const listener = term.onData((data) => {
    if (disposed) return
    // Public/third-party input not emitted through CoreService has no origin; preserve it too.
    if (!origin || origin.user || origin.focus || ownsReply(pty, sessionId, lease, data)) write(data)
  })
  return () => {
    if (disposed) return
    disposed = true
    listener.dispose()
    release()
    bound.delete(term)
    // A later adapter may have wrapped ours. Never restore over its live method.
    if (service.triggerDataEvent === trigger) service.triggerDataEvent = originalTrigger
    if (browser._handleTextAreaFocus === focus) browser._handleTextAreaFocus = originalFocus
    if (browser._handleTextAreaBlur === blur) browser._handleTextAreaBlur = originalBlur
  }
}
