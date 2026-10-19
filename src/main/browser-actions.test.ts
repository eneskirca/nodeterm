import { describe, it, expect } from 'vitest'
import { BrowserSession } from './browser-lease'
import type { DebuggerLike } from './browser-cdp-send'
import type { CdpContext } from './browser-cdp-allowlist'
import { NT_SCRIPTS } from './browser-nt-scripts'
import { RefTable } from './browser-refs'
import {
  CdpEventBus,
  browserNav,
  browserRead,
  browserReadTitle,
  browserReadLinks,
  browserReadMap,
  browserReadText
} from './browser-actions'

/**
 * These drive the REAL production code — a real {@link BrowserSession}, real `sendCdp`, the real CDP
 * allowlist and the real frozen NT_SCRIPTS readers — against a fake `webContents.debugger` whose
 * `sendCommand` returns canned page data. So every command an action issues actually passes the
 * allowlist gate (a disallowed method or bad params would reject and fail the test), and the readers
 * used are the byte-for-byte frozen strings. The only thing faked is the guest's response.
 *
 * A real Electron `<webview>` end-to-end (Global Constraint 8) additionally proves the readers'
 * in-page behaviour (the hidden-input / aria-hidden exclusion). That harness needs Electron + a
 * display and is not run in this headless suite; see the PR body's deferral note.
 */

interface PageModel {
  url: string
  title: string
  status: number
  links: { href: string; text: string }[]
  mapItems: Record<string, unknown>[]
  bodyText: string
  selectorText: Record<string, string | null>
}

class FakeDebugger implements DebuggerLike {
  attached = false
  attachCount = 0
  sends: { method: string; params: Record<string, unknown> }[] = []
  private msg: ((e: unknown, method: string, params: unknown) => void)[] = []
  private det: ((e: unknown, reason: string) => void)[] = []
  autoLoad = true

  constructor(public page: PageModel) {}

  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
    this.attachCount++
  }
  detach(): void {
    this.attached = false
    for (const f of this.det) f({}, 'user')
  }
  on(event: 'detach' | 'message', listener: never): void {
    if (event === 'detach') this.det.push(listener)
    else this.msg.push(listener)
  }
  emit(method: string, params: unknown): void {
    for (const f of this.msg) f({}, method, params)
  }
  async sendCommand(method: string, params: object = {}): Promise<unknown> {
    const p = params as Record<string, unknown>
    this.sends.push({ method, params: p })
    switch (method) {
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } }
      case 'DOM.resolveNode':
        return { object: { objectId: 'doc-obj' } }
      case 'Runtime.callFunctionOn':
        return { result: { value: this.evalReader(p) } }
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ url: this.page.url }] }
      case 'Page.navigate':
        if (this.autoLoad) {
          // A macrotask, so it fires AFTER browserNav has reached `bus.once` — a real debugger's
          // events arrive over IPC (a macrotask) too, never synchronously inside sendCommand.
          setTimeout(() => {
            this.emit('Network.responseReceived', { type: 'Document', response: { status: this.page.status } })
            this.emit('Page.frameNavigated', { frame: { id: 'main' } })
            this.emit('Page.loadEventFired', {})
          }, 0)
        }
        return { frameId: 'main' }
      default:
        return {}
    }
  }

  private evalReader(p: Record<string, unknown>): unknown {
    const fn = p.functionDeclaration
    const args = (p.arguments as { value: unknown }[] | undefined) ?? []
    if (fn === NT_SCRIPTS.readTitle) return this.page.title
    if (fn === NT_SCRIPTS.readLinks) return this.page.links
    if (fn === NT_SCRIPTS.readMap) return this.page.mapItems
    if (fn === NT_SCRIPTS.readText) {
      const sel = args[0]?.value as string | undefined
      const t = sel ? this.page.selectorText[sel] ?? null : this.page.bodyText
      return t === null ? null : { text: t.slice(0, 60000), total: t.length }
    }
    return null
  }
}

const viewport = (): CdpContext => ({ viewport: { width: 1280, height: 800 } })

function makeSession(page: PageModel): { session: BrowserSession; dbg: FakeDebugger; bus: CdpEventBus; refs: RefTable } {
  const dbg = new FakeDebugger(page)
  const session = new BrowserSession({ nodeId: 'browser-3', debugger: dbg, viewport })
  const refs = new RefTable()
  const bus = new CdpEventBus(() => refs.bumpGeneration('browser-3'))
  dbg.on('message', ((_e: unknown, m: string, prm: unknown) => bus.emit(m, prm)) as never)
  return { session, dbg, bus, refs }
}

function basePage(over: Partial<PageModel> = {}): PageModel {
  return {
    url: 'https://example.com/login',
    title: 'Sign in',
    status: 200,
    links: [],
    mapItems: [],
    bodyText: '',
    selectorText: {},
    ...over
  }
}

describe('--nav', () => {
  it('navigates, reads the main-frame status + final URL + title, and replies one line', async () => {
    const { session, bus } = makeSession(basePage())
    const r = await browserNav(session, bus, 'browser-3', 'https://example.com/login', 15_000)
    expect(r).toEqual({ ok: true, message: 'navigated browser-3 → https://example.com/login (200, "Sign in")' })
  })

  it('a load that never fires is a NAMED timeout that names the URL it is still at — not a hang', async () => {
    const { session, dbg, bus } = makeSession(basePage({ url: 'https://slow.test/' }))
    dbg.autoLoad = false // never emit loadEventFired
    const r = await browserNav(session, bus, 'browser-3', 'https://slow.test/', 20)
    expect(r.ok).toBe(false)
    expect(r.message).toBe('browser: browser-3 did not finish loading within 20ms (still at https://slow.test/)')
  })

  it('bumps the ref generation on the main-frame navigation (Task 5.5)', async () => {
    const { session, bus, refs } = makeSession(basePage())
    expect(refs.currentGeneration('browser-3')).toBe(0)
    await browserNav(session, bus, 'browser-3', 'https://example.com/login', 15_000)
    expect(refs.currentGeneration('browser-3')).toBe(1)
  })

  it('there is no passive channel out of the page — extra CDP events never reach the reply', async () => {
    const { session, dbg, bus } = makeSession(basePage())
    dbg.autoLoad = false
    const navP = browserNav(session, bus, 'browser-3', 'https://example.com/login', 15_000)
    await new Promise((r) => setTimeout(r, 0)) // let browserNav reach `bus.once`
    // A firehose of events an S8-style forwarder would have streamed to the agent:
    dbg.emit('Network.responseReceived', { type: 'Image', response: { status: 404, url: 'https://tracker.test/x.gif' } })
    dbg.emit('Network.dataReceived', { dataLength: 999, secret: 'PAGE-DATA-LEAK' })
    dbg.emit('Runtime.consoleAPICalled', { args: [{ value: 'CONSOLE-LEAK' }] })
    dbg.emit('Network.responseReceived', { type: 'Document', response: { status: 200 } })
    dbg.emit('Page.loadEventFired', {})
    const r = await navP
    expect(r.message).not.toContain('LEAK')
    expect(r.message).not.toContain('404')
    expect(r.message).toBe('navigated browser-3 → https://example.com/login (200, "Sign in")')
  })
})

describe('--read family', () => {
  it('NO agent-derived character reaches an `expression` field — ever (Task 7.4)', async () => {
    const page = basePage({
      links: [{ href: 'https://example.com/pricing', text: 'Pricing' }],
      mapItems: [{ ref: 0, tag: 'button', role: 'button', name: 'Sign in', filled: null }],
      bodyText: 'hello world'
    })
    const { session, dbg, bus, refs } = makeSession(page)
    for (const mode of ['title', 'links', 'map', 'text'] as const) {
      await browserRead(session, bus, refs, 'browser-3', mode, { selector: 'main.injection"attempt' })
    }
    // The read chain uses ONLY functionDeclaration (identity-pinned) + our objectId + scalar args.
    for (const s of dbg.sends) {
      expect(s.params).not.toHaveProperty('expression')
    }
    // Runtime.evaluate is never issued at all.
    expect(dbg.sends.some((s) => s.method === 'Runtime.evaluate')).toBe(false)
  })

  it('--read title: URL + title + status, one line', async () => {
    const { session, bus } = makeSession(basePage())
    // seed a status the way a prior nav would
    bus.emit('Network.responseReceived', { type: 'Document', response: { status: 200 } })
    const r = await browserReadTitle(session, bus)
    expect(r).toEqual({ ok: true, message: 'https://example.com/login "Sign in" (200)' })
  })

  it('--read links: text → absolute url, one per line, deduped', async () => {
    const page = basePage({
      links: [
        { href: 'https://example.com/a', text: 'A' },
        { href: 'https://example.com/a', text: 'A again (dupe href)' },
        { href: 'https://example.com/b', text: 'B' }
      ]
    })
    const { session } = makeSession(page)
    const r = await browserReadLinks(session)
    expect(r.message).toBe('A → https://example.com/a\nB → https://example.com/b')
  })

  it('--read map: numbered, mints refs, reports FILL STATE never the value (Task 7.5)', async () => {
    const page = basePage({
      mapItems: [
        { ref: 0, tag: 'a', role: 'link', name: 'Pricing', href: 'https://example.com/pricing', filled: null },
        // A password field that IS filled — the reader returns `filled:true` and NEVER a value.
        { ref: 1, tag: 'input', role: 'input', id: 'password', type: 'password', name: '', filled: true },
        { ref: 2, tag: 'button', role: 'button', name: 'Sign in', filled: null }
      ]
    })
    const { session, refs } = makeSession(page)
    const r = await browserReadMap(session, refs, 'browser-3')
    expect(r.message).toBe(
      '@1 link "Pricing" → https://example.com/pricing\n@2 input#password (password, filled)\n@3 button "Sign in"'
    )
    // The value 'hunter2' is nowhere in the reply because the reader never returned it.
    expect(r.message).not.toContain('hunter2')
    // Refs were minted for this node at the current generation.
    expect(refs.resolve('browser-3', refs.currentGeneration('browser-3'), '@2').ok).toBe(true)
  })

  it('--read text: capped by --max with an IN-BAND truncation announcement', async () => {
    const big = 'x'.repeat(84213)
    const { session } = makeSession(basePage({ bodyText: big }))
    const r = await browserReadText(session, 'browser-3', undefined, 20_000)
    expect(r.ok).toBe(true)
    expect(r.message.endsWith('[truncated at 20000 of 84213 chars — narrow it with --selector]')).toBe(true)
    expect(r.message.length).toBeLessThan(big.length)
  })

  it('--read text: --max is clamped to the 60000 ceiling', async () => {
    const big = 'y'.repeat(70000)
    const { session } = makeSession(basePage({ bodyText: big }))
    const r = await browserReadText(session, 'browser-3', undefined, 999999)
    expect(r.message).toContain('[truncated at 60000 of 70000 chars')
  })

  it('--read text: a selector matching nothing is a named refusal, not empty text', async () => {
    const { session } = makeSession(basePage({ selectorText: { '#missing': null } }))
    const r = await browserReadText(session, 'browser-3', '#missing', undefined)
    expect(r).toEqual({ ok: false, message: 'browser: browser-3 has nothing matching #missing' })
  })
})
