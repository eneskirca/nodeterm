/**
 * The CDP execution for the `browser` verb's PR-7 actions — `--nav` and the `--read` family. Every
 * command here goes through the injected `send` (a {@link import('./browser-lease').BrowserSession}'s
 * `send`, which routes through `sendCdp` → the allowlist), so this module cannot reach a CDP method
 * the gate refuses. Main-side only (it reads a real page); never Server Edition.
 *
 * THE EVENT BOUNDARY (design §3.2, Task 7.3). We subscribe to a FIXED set of CDP events —
 * Page.frameNavigated, Page.loadEventFired, Network.responseReceived (main frame),
 * Runtime.executionContextsCleared — and NOTHING is streamed to the agent. S8 forwarded every CDP
 * event to its client as a firehose; here events feed our own state (the {@link CdpEventBus}) only,
 * and the agent sees verb REPLIES. `browser-actions.test.ts` asserts there is no passive channel out
 * of the page: extra events emitted during a nav never appear in the reply.
 *
 * THE READ BOUNDARY (design §3.1, Task 7.4). Page-side logic runs ONLY as a frozen NT_SCRIPTS entry,
 * by identity, through Runtime.callFunctionOn with returnByValue — NO agent-derived character ever
 * reaches an `expression` field, because this module never issues Runtime.evaluate at all. A test
 * spies on every send and fails on any `expression` key.
 *
 * CDP child-session bookkeeping and the wheel/scroll salvage come from PR #112's S8 (@Corvin,
 * proteus-dev); the nav/read shape here is new.
 */
import { NT_SCRIPTS } from './browser-nt-scripts'
import type { RefTable, RefItem } from './browser-refs'
import type { BrowserReadMode, BrowserKey } from '../core/browser-verb'

/** A one-line agent-facing outcome. `ok:false` is a NAMED refusal, never a hang and never a raw
 *  Electron error. */
export interface ActionResult {
  ok: boolean
  message: string
}

/** The one capability the actions need from a lease: send a (gated) CDP command. */
export interface Sendable {
  send(method: string, params: object): Promise<unknown>
}

/** The page geometry `Page.getLayoutMetrics` reports: the visible viewport (what bounds a pointer
 *  coordinate), the current scroll offset, and the full content size (what `--scroll` reads back). */
export interface LayoutMetrics {
  width: number
  height: number
  scrollX: number
  scrollY: number
  contentWidth: number
  contentHeight: number
}

/** The extra capability the POINTER verbs (`--click`, `--type`, `--scroll`) need beyond {@link Sendable}:
 *  measure + cache the viewport so a synthesized coordinate validates against the REAL page, not the
 *  0×0 placeholder. A {@link import('./browser-lease').BrowserSession} implements it. */
export interface Driver extends Sendable {
  isAttached?(): boolean
  refreshViewport(): Promise<LayoutMetrics>
}

/** The `--read text` hard ceiling and default; the parser clamps `--max` to the ceiling too. */
export const READ_TEXT_DEFAULT_MAX = 20_000
export const READ_TEXT_CEILING = 60_000
const LIST_CAP = 200
const LIST_BYTES = 8192

type CdpEvent = { method: string; params: Record<string, unknown> }

/**
 * The fixed-set event sink for one guest. Fed by `debugger.on('message')` in index.ts; read by
 * {@link browserNav}. It records only the main-frame document status and drives ref invalidation on
 * a navigation — it has NO path that hands an event to an agent-facing channel.
 */
export class CdpEventBus {
  private readonly waiters = new Set<{ match: (e: CdpEvent) => boolean; resolve: (e: CdpEvent | null) => void }>()
  private mainFrameStatus: number | undefined

  /** `onNavigation` bumps the node's ref generation (Task 5.5) — the single invalidation path both
   *  Page.frameNavigated and Runtime.executionContextsCleared funnel through. */
  constructor(private readonly onNavigation?: () => void) {}

  emit(method: string, rawParams: unknown): void {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string } | undefined
      // The MAIN frame only (no parent). A sub-frame navigation is not a page navigation.
      if (frame && frame.parentId === undefined) this.onNavigation?.()
    } else if (method === 'Runtime.executionContextsCleared') {
      this.onNavigation?.()
    } else if (method === 'Network.responseReceived') {
      // Main-frame DOCUMENT response only — the status the agent means by "did it load".
      if (params.type === 'Document') {
        const resp = params.response as { status?: number } | undefined
        if (resp && typeof resp.status === 'number') this.mainFrameStatus = resp.status
      }
    }
    const e: CdpEvent = { method, params }
    for (const w of [...this.waiters]) {
      if (w.match(e)) {
        this.waiters.delete(w)
        w.resolve(e)
      }
    }
  }

  /** Await the next event matching `match`, or null after `timeoutMs`. Never throws, never hangs. */
  once(match: (e: CdpEvent) => boolean, timeoutMs: number): Promise<CdpEvent | null> {
    return new Promise((resolve) => {
      const waiter = {
        match,
        resolve: (e: CdpEvent | null) => {
          clearTimeout(timer)
          resolve(e)
        }
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  /** Forget the last main-frame status — called at the start of a nav so a stale status can't be
   *  reported for the new page. */
  clearStatus(): void {
    this.mainFrameStatus = undefined
  }

  mainStatus(): number | undefined {
    return this.mainFrameStatus
  }
}

/**
 * The read chain, once: DOM.getDocument(depth:0) → DOM.resolveNode → Runtime.callFunctionOn(a FROZEN
 * NT_SCRIPTS reader, returnByValue, scalar args) → Runtime.releaseObject. The nodeId and objectId are
 * OURS (from our own getDocument/resolveNode), never the agent's; the only agent-derived data that
 * ever reaches a reader is a scalar `arguments[].value`, checked by the allowlist.
 */
async function callReader(s: Sendable, fn: string, args: readonly (string | number)[] = []): Promise<unknown> {
  const doc = (await s.send('DOM.getDocument', { depth: 0 })) as { root?: { nodeId?: number } }
  const nodeId = doc?.root?.nodeId
  if (typeof nodeId !== 'number') throw new Error('read: could not read the document root')
  const resolved = (await s.send('DOM.resolveNode', { nodeId })) as { object?: { objectId?: string } }
  const objectId = resolved?.object?.objectId
  if (typeof objectId !== 'string' || !objectId) throw new Error('read: could not resolve the document node')
  try {
    const res = (await s.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true
    })) as { result?: { value?: unknown } }
    return res?.result?.value
  } finally {
    // Best-effort release; a failed release must not turn a good read into an error.
    await s.send('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

/** The final URL after navigation/redirects, from OUR navigation-history read. */
export async function currentUrl(s: Sendable): Promise<string> {
  const h = (await s.send('Page.getNavigationHistory', {})) as {
    currentIndex?: number
    entries?: { url?: string }[]
  }
  const idx = typeof h?.currentIndex === 'number' ? h.currentIndex : -1
  const url = h?.entries?.[idx]?.url
  return typeof url === 'string' ? url : ''
}

async function readTitleValue(s: Sendable): Promise<string> {
  const v = await callReader(s, NT_SCRIPTS.readTitle)
  return typeof v === 'string' ? v : ''
}

/**
 * `--nav`. Navigate, wait for the load (main's own clock, never a hang), and report the final URL,
 * the main-frame status and the title. The timeout message NAMES the URL it is still at, because the
 * worst failure shape is a page that half-loaded and the agent not knowing where it is.
 */
export async function browserNav(
  s: Sendable,
  bus: CdpEventBus,
  nodeId: string,
  url: string,
  timeoutMs: number
): Promise<ActionResult> {
  await s.send('Page.enable', {})
  await s.send('Network.enable', {})
  bus.clearStatus()
  await s.send('Page.navigate', { url })
  const loaded = await bus.once((e) => e.method === 'Page.loadEventFired', timeoutMs)
  const finalUrl = await currentUrl(s)
  if (!loaded) {
    return {
      ok: false,
      message: `browser: ${nodeId} did not finish loading within ${timeoutMs}ms (still at ${finalUrl})`
    }
  }
  const status = bus.mainStatus()
  const title = await readTitleValue(s)
  const statusPart = status !== undefined ? String(status) : '?'
  return { ok: true, message: `navigated ${nodeId} → ${finalUrl} (${statusPart}, ${JSON.stringify(title)})` }
}

/** `--read title`: URL + document.title + HTTP status, one line. */
export async function browserReadTitle(s: Sendable, bus: CdpEventBus): Promise<ActionResult> {
  const title = await readTitleValue(s)
  const url = await currentUrl(s)
  const status = bus.mainStatus()
  const statusPart = status !== undefined ? ` (${status})` : ''
  return { ok: true, message: `${url} ${JSON.stringify(title)}${statusPart}`.trim() }
}

interface LinkItem {
  href?: unknown
  text?: unknown
}

/** `--read links`: `text → absolute url`, deduped, capped at 200 links / 8 KB. */
export async function browserReadLinks(s: Sendable): Promise<ActionResult> {
  const raw = (await callReader(s, NT_SCRIPTS.readLinks)) as LinkItem[] | null
  const seen = new Set<string>()
  const lines: string[] = []
  let bytes = 0
  for (const l of raw ?? []) {
    const href = typeof l?.href === 'string' ? l.href : ''
    if (!href || seen.has(href)) continue
    seen.add(href)
    const text = (typeof l?.text === 'string' ? l.text : '').replace(/\s+/g, ' ').trim()
    const line = `${text || '(no text)'} → ${href}`
    if (lines.length >= LIST_CAP || bytes + line.length + 1 > LIST_BYTES) break
    lines.push(line)
    bytes += line.length + 1
  }
  return { ok: true, message: lines.length ? lines.join('\n') : 'no links on this page' }
}

interface MapItem {
  tag?: unknown
  role?: unknown
  id?: unknown
  type?: unknown
  name?: unknown
  href?: unknown
  filled?: unknown
}

function formatMapItem(label: string, it: MapItem): string {
  const tag = typeof it.tag === 'string' ? it.tag : ''
  const role = (typeof it.role === 'string' && it.role) || tag || 'element'
  const name = (typeof it.name === 'string' ? it.name : '').replace(/\s+/g, ' ').trim()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const id = typeof it.id === 'string' && it.id ? `#${it.id}` : ''
    const type = (typeof it.type === 'string' && it.type) || tag
    // The FILL STATE, never the value (design §2.4 / Task 7.5).
    const state = it.filled ? 'filled' : 'empty'
    return `${label} ${tag}${id} (${type}, ${state})`
  }
  if (tag === 'a') {
    const href = typeof it.href === 'string' && it.href ? ` → ${it.href}` : ''
    return `${label} ${role} ${JSON.stringify(name)}${href}`
  }
  return `${label} ${role} ${JSON.stringify(name)}`
}

/**
 * `--read map`: a numbered inventory of INTERACTABLE elements only, capped 200 / 8 KB. Mints `@1…@n`
 * bound to (nodeId, current navigation generation) so a later click can spend them (Task 5.5). Role,
 * accessible name, and for a field its type and whether it is FILLED — never its value.
 */
export async function browserReadMap(s: Sendable, refs: RefTable, nodeId: string): Promise<ActionResult> {
  const raw = (await callReader(s, NT_SCRIPTS.readMap)) as MapItem[] | null
  const items = (raw ?? []).slice(0, LIST_CAP)
  // Mint at the CURRENT generation — the one this page is on, which a navigation will have bumped.
  refs.mint(nodeId, refs.currentGeneration(nodeId), items as Record<string, unknown>[])
  const lines: string[] = []
  let bytes = 0
  for (let i = 0; i < items.length; i++) {
    const line = formatMapItem(`@${i + 1}`, items[i])
    if (bytes + line.length + 1 > LIST_BYTES) break
    lines.push(line)
    bytes += line.length + 1
  }
  return { ok: true, message: lines.length ? lines.join('\n') : 'no interactable elements found' }
}

/**
 * `--read text`: rendered VISIBLE text (innerText semantics), whitespace as the page has it, scoped
 * by `--selector`. Capped by `--max` (default 20 000, ceiling 60 000); a truncation is announced
 * IN-BAND so the agent learns to narrow it. There is deliberately NO html/full-DOM mode.
 */
export async function browserReadText(
  s: Sendable,
  nodeId: string,
  selector: string | undefined,
  max: number | undefined
): Promise<ActionResult> {
  const res = (await callReader(s, NT_SCRIPTS.readText, selector ? [selector] : [])) as
    | { text?: unknown; total?: unknown }
    | null
  if (res === null) {
    return {
      ok: false,
      message: selector
        ? `browser: ${nodeId} has nothing matching ${selector}`
        : `browser: ${nodeId} has no readable document body`
    }
  }
  const cap = Math.min(max ?? READ_TEXT_DEFAULT_MAX, READ_TEXT_CEILING)
  const full = typeof res.text === 'string' ? res.text : ''
  const total = typeof res.total === 'number' ? res.total : full.length
  const text = full.slice(0, cap)
  if (total > cap) {
    return { ok: true, message: `${text}\n[truncated at ${cap} of ${total} chars — narrow it with --selector]` }
  }
  return { ok: true, message: text }
}

// ── Interaction (PR 8): --click, --type, --press, --scroll, --wait ──────────────────────────────
//
// Every effect below is a real CDP event through the ONE gated `send` — a bounded mouse event, a
// capped insertText, a fixed-table key event — never page-side JS: the NT_SCRIPTS this path calls
// (resolveRef/resolveSelector/activeField/isVisible) are PURE READERS that only report coordinates and
// visibility, and every actual effect goes through Input.* so it is bounded by the allowlist AND
// traceable. Agent-supplied text is DATA (Input.insertText), and a key is one of a fixed table.
//
// The CDP child-session/wheel bookkeeping this leans on is lifted from PR #112's S8 (@Corvin,
// proteus-dev); the verb shapes and the read-back replies here are new.

/** The fixed key table `--press` maps onto (Task 8.3). A key outside {@link BrowserKey} never reaches
 *  here — the verb parser and the allowlist both gate on the same `BROWSER_KEYS` set — so this is a
 *  total map, not a lookup that can miss. */
const KEY_TABLE: Record<BrowserKey, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }
}

/** `--press --times` is capped so a single verb cannot fire an unbounded keystroke storm. */
const PRESS_MAX_TIMES = 50
/** The poll interval `--wait` uses on OUR clock (never a page timer). */
const WAIT_POLL_MS = 150

/** A one-line, value-free description of a minted map item for a reply: `input#email` for a field
 *  (its identity, never its value), `button "Sign in"` for a control (role + accessible name). */
function describeItem(it: RefItem): string {
  const tag = typeof it.tag === 'string' ? it.tag : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const id = typeof it.id === 'string' && it.id ? `#${it.id}` : ''
    return `${tag}${id}`
  }
  const role = (typeof it.role === 'string' && it.role) || tag || 'element'
  const name = (typeof it.name === 'string' ? it.name : '').replace(/\s+/g, ' ').trim()
  return name ? `${role} ${JSON.stringify(name)}` : role
}

type Resolved =
  | { ok: true; x: number; y: number; desc: string }
  | { ok: false; message: string }

/**
 * Resolve a `@ref` OR a raw CSS selector to CURRENT viewport-centre coordinates plus a value-free
 * description. A `@ref` is SPENT through the RefTable (node- and generation-scoped): a stale ref — the
 * page navigated since the map that minted it — is a REFUSAL, never a re-resolution against a newer
 * map (the PR 5 correctness property). A selector is resolved live. Coordinates come from a pure
 * reader (getBoundingClientRect), never from the agent.
 */
async function resolveTarget(s: Sendable, refs: RefTable, nodeId: string, target: string): Promise<Resolved> {
  if (target.startsWith('@')) {
    const res = refs.spend(nodeId, target)
    if (!res.ok) return { ok: false, message: res.message }
    const item = res.item
    const idx = typeof item.ref === 'number' ? item.ref : Number(item.ref)
    const coords = (await callReader(s, NT_SCRIPTS.resolveRef, [idx])) as { x?: unknown; y?: unknown } | null
    if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
      return { ok: false, message: `browser: ${target} (${describeItem(item)}) is no longer on ${nodeId} — re-read the map` }
    }
    return { ok: true, x: coords.x, y: coords.y, desc: `${target} (${describeItem(item)})` }
  }
  const coords = (await callReader(s, NT_SCRIPTS.resolveSelector, [target])) as { x?: unknown; y?: unknown; tag?: unknown } | null
  if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
    return { ok: false, message: `browser: nothing matches ${target} on ${nodeId}` }
  }
  const tag = typeof coords.tag === 'string' ? coords.tag.toLowerCase() : 'element'
  return { ok: true, x: coords.x, y: coords.y, desc: `${target} (${tag})` }
}

/** Inside the last-measured viewport? A coordinate off-screen is either a bug or an attempt to reach
 *  chrome the user cannot see; the allowlist enforces this independently, this gives a clear message. */
function inViewport(x: number, y: number, m: LayoutMetrics): boolean {
  return x >= 0 && y >= 0 && x <= m.width && y <= m.height
}

/** Wait for compositor-driven scrolling before measuring a target or reporting movement.
 * Wheel acknowledgement precedes its first frame. Require an initial grace period as well as
 * consecutive quiet samples; continuously moving pages fail explicitly within a bounded budget. */
export async function settledViewport(
  s: Driver,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<LayoutMetrics> {
  let previous = await s.refreshViewport()
  let quiet = 0
  for (let elapsed = 50; elapsed <= 1500; elapsed += 50) {
    await sleep(50)
    if (s.isAttached?.() === false) throw new Error('browser: control lease detached while waiting for the page')
    const current = await s.refreshViewport()
    const unchanged = current.scrollX === previous.scrollX && current.scrollY === previous.scrollY &&
      current.width === previous.width && current.height === previous.height &&
      current.contentWidth === previous.contentWidth && current.contentHeight === previous.contentHeight
    quiet = unchanged ? quiet + 50 : 0
    if (elapsed >= 200 && quiet >= 150) return current
    previous = current
  }
  throw new Error('browser: page scrolling did not settle; wait for the page to stop moving before trying again')
}

/** A synthesized left click: press then release at (x, y). Both events are bounded by the allowlist. */
async function dispatchClick(s: Sendable, x: number, y: number): Promise<void> {
  const at = { x, y, button: 'left', clickCount: 1 }
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...at })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at })
}

/**
 * `--click <ref|selector>` (Task 8.1). Resolve the handle to a current centre, refresh the viewport,
 * refuse an off-screen target, then dispatch a bounded left click. Reply names WHAT was clicked, never
 * a coordinate: `clicked @7 (button "Sign in") on browser-3`.
 */
export async function browserClick(s: Driver, refs: RefTable, nodeId: string, target: string): Promise<ActionResult> {
  await settledViewport(s)
  const t = await resolveTarget(s, refs, nodeId, target)
  if (!t.ok) return { ok: false, message: t.message }
  const m = await s.refreshViewport()
  if (!inViewport(t.x, t.y, m)) {
    return { ok: false, message: `browser: ${t.desc} is off-screen on ${nodeId} — scroll it into view first` }
  }
  await dispatchClick(s, t.x, t.y)
  return { ok: true, message: `clicked ${t.desc} on ${nodeId}` }
}

/**
 * `--type <text>` with `--into <ref|selector>` and `--clear true` (Task 8.2). The text is DATA: it goes
 * to `Input.insertText` and is NEVER echoed in the reply — the reply says how MANY characters, not
 * which. With `--into`, the field is focused the way a user would (a click); without it, an already
 * focused editable field is typed into, and nothing focused is a NAMED refusal. `--clear` selects the
 * field (a fixed editing command) so the insert replaces it.
 */
export async function browserType(
  s: Driver,
  refs: RefTable,
  nodeId: string,
  opts: { text: string; into?: string; clear: boolean }
): Promise<ActionResult> {
  const { text, into, clear } = opts
  let desc: string
  if (into) {
    await settledViewport(s)
    const t = await resolveTarget(s, refs, nodeId, into)
    if (!t.ok) return { ok: false, message: t.message }
    const m = await s.refreshViewport()
    if (!inViewport(t.x, t.y, m)) {
      return { ok: false, message: `browser: ${t.desc} is off-screen on ${nodeId} — scroll it into view first` }
    }
    await dispatchClick(s, t.x, t.y) // focus the field the way a user does
    desc = t.desc
  } else {
    const active = (await callReader(s, NT_SCRIPTS.activeField)) as { tag?: unknown; id?: unknown } | null
    if (!active || typeof active.tag !== 'string') {
      return { ok: false, message: 'browser: --type needs --into, or a focused field (nothing is focused)' }
    }
    const id = typeof active.id === 'string' && active.id ? `#${active.id}` : ''
    desc = `the focused ${active.tag}${id}`
  }
  if (clear) {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] })
    if (text === '') await s.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['deleteBackward'] })
  }
  if (text !== '') await s.send('Input.insertText', { text })
  if (text === '' && clear) return { ok: true, message: `cleared ${desc} on ${nodeId}` }
  // The character COUNT only — never the characters themselves.
  return { ok: true, message: `typed ${text.length} chars into ${desc} on ${nodeId}` }
}

/**
 * `--press <key>` with `--times <n>` (Task 8.3). The key is one of the fixed {@link KEY_TABLE} entries
 * (`--enter true` is not expressible under the old shim loop, and no real form is fillable without
 * Enter/Tab); each press is a keyDown+keyUp, repeated up to a capped count.
 */
export async function browserPress(s: Sendable, nodeId: string, key: BrowserKey, times: number): Promise<ActionResult> {
  const n = Math.min(Math.max(Math.floor(times) || 1, 1), PRESS_MAX_TIMES)
  const spec = KEY_TABLE[key]
  for (let i = 0; i < n; i++) {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec })
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec })
  }
  return { ok: true, message: `pressed ${key}${n > 1 ? ` x${n}` : ''} on ${nodeId}` }
}

/**
 * The wheel delta for a `--scroll` target. `down`/`up` move ~90% of a viewport; `top`/`bottom` move to
 * the edge from the current offset; a signed pixel count is taken literally (positive = down).
 *
 * [UNVERIFIED] 1 — the wheel-translation salvage (Task 8.4). S8 could not scroll a `<webview>` with
 * `Input.synthesizeScrollGesture` (Electron acknowledged the synthetic gesture without scrolling) and
 * translated it into an `Input.dispatchMouseEvent { type:'mouseWheel', deltaY }`. We author the wheel
 * delta directly in the DOM wheel convention (positive deltaY scrolls the page DOWN — scrollY grows),
 * so the sign is NOT the gesture-distance inversion S8 warned about. This was NOT re-measured against a
 * real Electron 42.8.1 `<webview>` in the implementation environment (headless, no display — the same
 * reason the reader end-to-end harness is deferred, see the file header); the mitigation is that the
 * reply ALWAYS reads the scroll position back from `Page.getLayoutMetrics`, so a wrong sign or a
 * command that silently does nothing shows up as a 0px / opposite-direction delta the agent can see.
 * See docs/superpowers/probes/2026-08-browser-scroll.md.
 */
function scrollDeltaY(where: string, m: LayoutMetrics): number {
  const page = Math.round(m.height * 0.9)
  switch (where) {
    case 'down':
      return page
    case 'up':
      return -page
    case 'top':
      return -Math.round(m.scrollY)
    case 'bottom':
      return Math.round(m.contentHeight - m.height - m.scrollY)
    default: {
      const n = Number.parseInt(where, 10)
      return Number.isFinite(n) ? n : 0
    }
  }
}

/**
 * `--scroll <where>` (Task 8.4). Measure, dispatch one bounded `mouseWheel` at the viewport centre,
 * then RE-READ `Page.getLayoutMetrics` and report the ACTUAL delta and position:
 * `scrolled browser-3 down 600px (at 1200/4400)`. The reply is built from the measured movement, never
 * the requested delta, because the worst failure shape here is a command that succeeds and does
 * nothing — and a requested-delta reply would hide exactly that (it shows as `0px`).
 */
export async function browserScroll(s: Driver, nodeId: string, where: string): Promise<ActionResult> {
  const before = await settledViewport(s)
  const deltaY = scrollDeltaY(where, before)
  const cx = Math.floor(before.width / 2)
  const cy = Math.floor(before.height / 2)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY })
  const after = await settledViewport(s)
  const moved = Math.round(after.scrollY - before.scrollY)
  const posPart = `(at ${Math.round(after.scrollY)}/${Math.round(after.contentHeight)})`
  const movePart = moved === 0 ? '0px' : `${moved > 0 ? 'down' : 'up'} ${Math.abs(moved)}px`
  return { ok: true, message: `scrolled ${nodeId} ${movePart} ${posPart}` }
}

/**
 * `--wait <ref|selector>` with `--timeout` (Task 8.5). Polls on OUR OWN clock — a `@ref`'s element
 * re-resolving, or a selector reporting visible — so the trace shows a verb that says what it is
 * waiting for, instead of every agent hand-rolling a poll loop out of `--read`. Reply names the wait
 * and how long it took; a timeout is a NAMED refusal. Clock/sleep are injected for deterministic tests.
 */
export async function browserWait(
  s: Sendable,
  refs: RefTable,
  nodeId: string,
  target: string,
  timeoutMs: number,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<ActionResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  const probe = async (): Promise<boolean> => {
    try {
      if (target.startsWith('@')) {
        const res = refs.spend(nodeId, target)
        if (!res.ok) return false
        const idx = typeof res.item.ref === 'number' ? res.item.ref : Number(res.item.ref)
        const c = (await callReader(s, NT_SCRIPTS.resolveRef, [idx])) as { x?: unknown } | null
        return !!c && typeof c.x === 'number'
      }
      return (await callReader(s, NT_SCRIPTS.isVisible, [target])) === true
    } catch {
      // A transient read failure (e.g. mid-navigation) is "not yet", never an abort of the wait.
      return false
    }
  }
  for (;;) {
    if (await probe()) {
      return { ok: true, message: `${target} appeared on ${nodeId} after ${now() - start}ms` }
    }
    if (now() - start >= timeoutMs) {
      return { ok: false, message: `browser: ${target} did not appear on ${nodeId} within ${timeoutMs}ms` }
    }
    await sleep(Math.min(WAIT_POLL_MS, Math.max(1, timeoutMs - (now() - start))))
  }
}

/** Dispatch the `--read <mode>` family. */
export async function browserRead(
  s: Sendable,
  bus: CdpEventBus,
  refs: RefTable,
  nodeId: string,
  mode: BrowserReadMode,
  opts: { selector?: string; max?: number }
): Promise<ActionResult> {
  switch (mode) {
    case 'title':
      return browserReadTitle(s, bus)
    case 'links':
      return browserReadLinks(s)
    case 'map':
      return browserReadMap(s, refs, nodeId)
    case 'text':
      return browserReadText(s, nodeId, opts.selector, opts.max)
  }
}
