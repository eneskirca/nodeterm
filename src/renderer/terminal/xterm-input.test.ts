// @vitest-environment jsdom
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindXtermInput } from './xterm-input'

// Run the installed xterm parser/CoreService, clipboard, mouse encoder and real browser focus
// methods. The small DOM only replaces geometry/rendering; no input-origin algorithm is faked.
type Core = {
  element: HTMLDivElement
  textarea: HTMLTextAreaElement
  coreService: { triggerDataEvent(data: string, user?: boolean): void; onData(cb: (d: string) => void): { dispose(): void } }
  coreMouseService: { activeProtocol: string; activeEncoding: string; triggerMouseEvent(e: object): boolean }
  _handleTextAreaFocus(event: FocusEvent): void
  _handleTextAreaBlur(): void
}
const views: Array<{ term: Terminal; core: Core; dispose(): void }> = []
function view(pty: object, sessionId = 'pty-1', beforeBind?: (core: Core) => void) {
  const term = new Terminal({ allowProposedApi: true })
  const core = (term as unknown as { _core: Core })._core
  core.element = document.createElement('div')
  core.textarea = document.createElement('textarea')
  core.element.append(core.textarea)
  document.body.append(core.element)
  // These are the same property-lookup callbacks xterm installs in open().
  core.textarea.addEventListener('focus', (e) => core._handleTextAreaFocus(e))
  core.textarea.addEventListener('blur', () => core._handleTextAreaBlur())
  beforeBind?.(core)
  const sent: string[] = []
  const dispose = bindXtermInput(term, pty, sessionId, (d) => sent.push(d))
  const result = { term, core, sent, dispose }
  views.push(result)
  return result
}
function paint(v: ReturnType<typeof view>, data: string): Promise<void> {
  return new Promise((done) => v.term.write(data, done))
}
const da = '\x1b[c\x1b[>c'
const daReplies = ['\x1b[?1;2c', '\x1b[>0;276;0c']
afterEach(() => {
  for (const v of views.splice(0)) { v.dispose(); v.term.dispose(); v.core.element.remove() }
  vi.restoreAllMocks()
})

describe('xterm co-view input origins and response ownership', () => {
  it('uses the actual pinned private CoreService and sends automatic DA replies once in order', async () => {
    const pty = {}, first = view(pty), second = view(pty)
    expect(typeof first.core.coreService.triggerDataEvent).toBe('function')
    expect(typeof first.core._handleTextAreaFocus).toBe('function')
    expect(typeof first.core._handleTextAreaBlur).toBe('function')
    // The parser calls triggerDataEvent with its default false flag, erased by public onData.
    await Promise.all([paint(second, da), paint(first, da)])
    expect(first.sent).toEqual(daReplies)
    expect(second.sent).toEqual([])
    // A later, identical request is intentional and still receives a response.
    await Promise.all([paint(first, da), paint(second, da)])
    expect(first.sent).toEqual([...daReplies, ...daReplies])
  })

  it('preserves every view keyboard, reply-shaped paste and actual SGR mouse input', async () => {
    const pty = {}, first = view(pty), second = view(pty)
    for (const v of [first, second]) {
      v.term.input('key')
      v.term.input(daReplies.join(''), true)
      v.term.paste('\x1b[I\x1b[O' + daReplies.join(''))
      v.core.coreMouseService.activeProtocol = 'ANY'
      v.core.coreMouseService.activeEncoding = 'SGR'
      expect(v.core.coreMouseService.triggerMouseEvent({ col: 2, row: 3, button: 0, action: 1,
        ctrl: false, alt: false, shift: false })).toBe(true)
      expect(v.sent).toEqual(['key', daReplies.join(''), '\x1b[I\x1b[O' + daReplies.join(''), '\x1b[<0;3;4M'])
    }
    await Promise.all([paint(first, da), paint(second, da)])
    expect(first.sent.slice(4)).toEqual(daReplies)
    expect(second.sent).toHaveLength(4)
  })

  it('promotes the next live responder immediately and disposal cannot release another viewer', async () => {
    const pty = {}, first = view(pty), second = view(pty), third = view(pty)
    first.dispose(); first.dispose()
    await Promise.all([paint(first, da), paint(third, da), paint(second, da)])
    expect(first.sent).toEqual([])
    expect(second.sent).toEqual(daReplies)
    expect(third.sent).toEqual([])
    second.dispose(); first.dispose()
    await paint(third, da)
    expect(third.sent).toEqual(daReplies)
  })

  it('scopes replies by actual API identity and session generation', async () => {
    const pty = {}, first = view(pty), follower = view(pty)
    const anotherSession = view(pty, 'pty-2'), anotherApi = view({}, 'pty-1')
    await Promise.all([first, follower, anotherSession, anotherApi].map((v) => paint(v, da)))
    expect(first.sent).toEqual(daReplies)
    expect(follower.sent).toEqual([])
    expect(anotherSession.sent).toEqual(daReplies)
    expect(anotherApi.sent).toEqual(daReplies)
  })

  it('keeps the responder while parked, adopts without rebinding, and promotes only on final disposal', async () => {
    const pty = {}, canvas = view(pty), modal = view(pty)
    canvas.core.element.remove() // park retains the term, listener and actual session
    await Promise.all([paint(canvas, da), paint(modal, da)])
    expect(canvas.sent).toEqual(daReplies)
    expect(modal.sent).toEqual([])
    document.body.append(canvas.core.element) // adopt the same binding
    await Promise.all([paint(modal, da), paint(canvas, da)])
    expect(canvas.sent).toEqual([...daReplies, ...daReplies])
    expect(() => bindXtermInput(canvas.term, pty, 'pty-1', () => {})).toThrow('already bound')
    canvas.dispose()
    await paint(modal, da)
    expect(modal.sent).toEqual(daReplies)
  })

  it('lets the live focused secondary answer automatic focus queries in either parse order', async () => {
    const pty = {}, hidden = view(pty), focused = view(pty)
    focused.term.focus()
    for (const order of [[hidden, focused], [focused, hidden]]) {
      await Promise.all(order.map((v) => paint(v, '\x1b[?1004h')))
    }
    expect(hidden.sent).toEqual([])
    expect(focused.sent).toEqual(['\x1b[I', '\x1b[I'])
    // Actual blur/focus DOM transitions have false origin and must pass from a non-owner too.
    focused.term.blur(); focused.term.focus()
    expect(focused.sent.slice(2)).toEqual(['\x1b[O', '\x1b[I'])
    focused.term.blur()
    hidden.sent.length = 0; focused.sent.length = 0
    await Promise.all([paint(focused, '\x1b[?1004h'), paint(hidden, '\x1b[?1004h')])
    expect(hidden.sent).toEqual(['\x1b[O'])
    expect(focused.sent).toEqual([])
  })

  it('ignores a detached formerly focused primary when a live secondary is focused', async () => {
    const pty = {}, parked = view(pty), modal = view(pty)
    parked.term.focus()
    parked.core.element.remove()
    expect(parked.core.element.classList.contains('focus')).toBe(true)
    modal.term.focus()
    await Promise.all([paint(parked, '\x1b[?1004h'), paint(modal, '\x1b[?1004h')])
    expect(parked.sent).toEqual([])
    expect(modal.sent).toEqual(['\x1b[I'])
    parked.dispose()
    await paint(modal, da)
    expect(modal.sent.slice(1)).toEqual(daReplies)
  })

  it('restores the outer origin after a nested dispatch and preserves the original this/args', () => {
    const pty = {}, owner = view(pty)
    const nested = view(pty, 'pty-1', (core) => {
      core.coreService.onData((data) => {
        if (data === 'outer-user') core.coreService.triggerDataEvent(daReplies[0])
      })
    })
    nested.term.input('outer-user', true)
    expect(nested.sent).toEqual(['outer-user'])
    expect(owner.sent).toEqual([])
    // Actual CoreService scroll-on-user-input and onData dispatch also require its real `this`.
    nested.term.input('after-user')
    expect(nested.sent).toEqual(['outer-user', 'after-user'])
  })

  it('does not overwrite a newer wrapper and a retired listener cannot write', () => {
    const v = view({})
    const installed = v.core.coreService.triggerDataEvent
    const later = vi.fn(function (this: Core['coreService'], ...args: [string, boolean?]) {
      installed.apply(this, args)
    })
    v.core.coreService.triggerDataEvent = later
    v.dispose()
    expect(v.core.coreService.triggerDataEvent).toBe(later)
    v.term.input('retired')
    expect(v.sent).toEqual([])
    expect(later).toHaveBeenCalledWith('retired', true)
  })

  it('warns on unsupported private shapes while retaining all public input and exact disposal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let listener: ((s: string) => void) | undefined
    const off = vi.fn(() => { listener = undefined })
    const term = { onData: (cb: (s: string) => void) => { listener = cb; return { dispose: off } } } as unknown as Terminal
    const sent: string[] = []
    const dispose = bindXtermInput(term, {}, 'pty-1', (s) => sent.push(s))
    listener?.(daReplies.join(''))
    expect(sent).toEqual([daReplies.join('')])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preserving public input'))
    const queued = listener
    dispose(); dispose()
    queued?.('late public dispatch')
    expect(off).toHaveBeenCalledTimes(1)
    expect(listener).toBeUndefined()
    expect(sent).toEqual([daReplies.join('')])
  })
})
