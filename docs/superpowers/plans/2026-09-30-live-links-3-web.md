# Live links — Plan 3 of 3: Viewer page (nodeterm-web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `https://nodeterm.dev/s/<linkId>#1.<S>`: an anonymous, install-free page that joins a live link, decrypts it in the browser and shows the terminal read-only, with a chat panel for Commenter links.

**Architecture:** One SSR route in the Astro site returns a static shell with route-only security headers. A bundled client script mounts xterm (read-only, no links, mouse-tracking swallowed) and drives a pure controller: `POST /v1/watch-links/:id/join` → WebSocket to the relay → the desktop's `connectWatchClient`, vendored byte-identically from the nodeterm repo together with its test vectors.

**Tech Stack:** Astro 5.18 (`output: 'server'`, node adapter), TypeScript, `@xterm/xterm` 5.5, `@xterm/addon-unicode11`, `tweetnacl`, vitest 4.

**Spec:** `/root/nodeterm/wtshare/docs/superpowers/specs/2026-09-28-live-share-link-design.md` (section "Viewer page (nodeterm-web)").

**Plans in this series:** 1 = backend (defines `POST /v1/watch-links/:id/join` and its CORS), 2 = desktop (produces `src/shared/watch-link/`, which this plan vendors; it must be merged, or at least its branch pushed, before Task 1), 3 = this.

## Global Constraints

- Repo `/root/nodeterm-web`; new worktree `/root/nodeterm-web-live`, branch `feat/live-viewer` off `origin/main`. Never push `main`.
- The vendored directory `src/lib/watch-link/` is a byte-identical copy of nodeterm's `src/shared/watch-link/*.ts` (not `*.test.ts`) + `vectors.json`. It is never edited by hand; `vendored.test.ts` fails on any local edit.
- Tests never live under `src/pages/` (a `.test.ts` there becomes a route). Logic lives in `src/lib/`.
- Headers on `/s/*` only (production): CSP `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src <api> <relay>; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- No analytics, no remote fonts, no third-party script. Owner-supplied strings (`label`, `title`, chat) only ever through `textContent`.
- The fragment never leaves the page: not in a request, a log, or storage; the address bar keeps it.
- Only `wss:` relay endpoints are dialed (an API answer naming anything else is treated as a network error).
- Copy (English), exactly as in the spec's "States" table.
- Style: no semicolons, single quotes, `//` prose headers on modules, named exports.

## Review Focus

1. **A link opened on a phone** (narrow viewport, 200-column terminal) → the terminal fits by font size down to 7 px, then scrolls horizontally inside its box; the page itself never scrolls sideways and the top bar stays visible. → Task 4 `fitFontSize` tests.
2. **The relay dropping mid-session** (Wi-Fi switch, laptop sleep on the host) → "Can't reach the sharer…" with backoff 1, 2, 4, 8, 15 s then every 30 s, re-joining with a fresh token each time, and resuming by itself. → Task 3 "retries with backoff and a fresh join".
3. **A link that ended while the tab was open** (`watch:end` or a later 410) → a final message, no more retries, the socket closed. → Task 3 "an end is final".
4. **Terminal output containing a URL or an OSC 8 hyperlink** → nothing is clickable. → Task 4 `createViewerTerminal` options test + the host-side filter (Plan 2).
5. **A viewer that pastes a huge message or control characters into chat** → trimmed to 500, controls stripped client-side before sending (the host re-checks). → Task 3 "chat is sanitized and paced".

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/vendor-watch-link.mjs` | copy the protocol from a nodeterm checkout and record hashes |
| `src/lib/watch-link/*` (vendored) + `VENDORED.json` | the protocol client, keys, wire rules, vectors |
| `src/lib/watch-link/vendored.test.ts` | hash check + vectors |
| `src/lib/viewer-headers.ts` (+ test) | route headers, id check |
| `src/lib/watch-viewer/controller.ts` (+ test) | the pure viewer state machine |
| `src/lib/watch-viewer/terminal.ts` (+ test) | xterm options, font fitting, keyframe text |
| `src/lib/watch-viewer/dom.ts` | DOM glue (no logic) |
| `src/pages/s/[id].astro` | the route |

---

### Task 0: Worktree and dependencies

- [ ] **Step 1**

```bash
git -C /root/nodeterm-web fetch origin
git -C /root/nodeterm-web worktree add -b feat/live-viewer /root/nodeterm-web-live origin/main
cd /root/nodeterm-web-live && npm install
npm install tweetnacl@^1.0.3 @xterm/xterm@^5.5.0 @xterm/addon-unicode11@^0.9.0
npm test && npm run check
```

Expected: existing tests pass, `astro check` clean. Match `@xterm/xterm` to the version the desktop's `package.json` pins (read `/root/nodeterm/wtshare/package.json`); if they differ, use the desktop's.

- [ ] **Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): xterm and tweetnacl for the live-link viewer"
```

---

### Task 1: Vendor the protocol, with a hash check and the vectors

**Files:**
- Create: `scripts/vendor-watch-link.mjs`, `src/lib/watch-link/` (vendored), `src/lib/watch-link/VENDORED.json`, `src/lib/watch-link/vendored.test.ts`

**Interfaces:**
- Produces (from the vendored files): `connectWatchClient`, `WatchSocket`, `WatchClient`, `deriveWatchLinkKeys`, `parseWatchLinkLocation`, `WATCH_EVENT`, `WATCH_PROTOCOL_VERSION`, `sanitizeChatText`, `sanitizeChatName`, `isWatchEndReason`, types `WatchMeta`, `WatchKeyframe`, `WatchChatMessage`, `WatchLinkEndReason`.

- [ ] **Step 1: Write the vendor script**

`scripts/vendor-watch-link.mjs`:

```js
// Copies the live-link protocol from a nodeterm checkout into src/lib/watch-link/, byte for byte,
// and records each file's SHA-256 and the source commit. The copy is never edited here: change the
// protocol in nodeterm (src/shared/watch-link/), then re-run this script.
//   node scripts/vendor-watch-link.mjs /path/to/nodeterm
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.argv[2]
if (!repo) {
  console.error('usage: node scripts/vendor-watch-link.mjs <path-to-nodeterm>')
  process.exit(2)
}
const src = join(repo, 'src/shared/watch-link')
const dst = join(process.cwd(), 'src/lib/watch-link')
const files = readdirSync(src).filter((f) => (f.endsWith('.ts') && !f.endsWith('.test.ts')) || f === 'vectors.json').sort()
mkdirSync(dst, { recursive: true })
for (const f of readdirSync(dst)) if (f !== 'vendored.test.ts') rmSync(join(dst, f))
const hashes = {}
for (const f of files) {
  copyFileSync(join(src, f), join(dst, f))
  hashes[f] = createHash('sha256').update(readFileSync(join(dst, f))).digest('hex')
}
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
writeFileSync(join(dst, 'VENDORED.json'), JSON.stringify({ source: 'nodeterm/src/shared/watch-link', commit, files: hashes }, null, 2) + '\n')
console.log(`vendored ${files.length} files from ${commit}`)
```

- [ ] **Step 2: Vendor and write the test**

Run: `node scripts/vendor-watch-link.mjs /root/nodeterm/wtshare`
Expected: `vendored 8 files from <sha>` (bytes, client, hkdf, keys, link, protocol, wire, vectors.json).

Add `src/lib/watch-link/*.ts linguist-generated` and `* text eol=lf` for that directory to `.gitattributes` (create it if absent), so a Windows checkout does not turn the vendored bytes into CRLF and break the hashes:

```
src/lib/watch-link/** -text
```

`src/lib/watch-link/vendored.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { deriveWatchLinkKeys, sha256Hex } from './keys'
import { bytesToHex } from './bytes'
import { formatWatchLink } from './link'
import { encodePtyFrame } from './wire'

const here = (f: string): URL => new URL(`./${f}`, import.meta.url)
const manifest = JSON.parse(readFileSync(here('VENDORED.json'), 'utf8')) as { files: Record<string, string> }
const vectors = JSON.parse(readFileSync(here('vectors.json'), 'utf8'))

describe('vendored live-link protocol', () => {
  test('no vendored file was edited here', () => {
    for (const [f, sha] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(here(f))).digest('hex'), f).toBe(sha)
    }
  })
  test('the copy reproduces the desktop vectors', async () => {
    for (const v of vectors.keys) {
      const secret = Uint8Array.from(Buffer.from(v.secretHex, 'hex'))
      const k = deriveWatchLinkKeys(secret)
      expect(bytesToHex(k.host.publicKey)).toBe(v.hostPublicHex)
      expect(bytesToHex(k.viewer.publicKey)).toBe(v.viewerPublicHex)
      expect(bytesToHex(k.joinKey)).toBe(v.joinKeyHex)
      expect(await sha256Hex(k.joinKey)).toBe(v.joinKeyHashHex)
      expect(formatWatchLink(v.linkId, secret)).toBe(v.url)
    }
    for (const f of vectors.ptyFrames) expect(bytesToHex(encodePtyFrame(f.sessionId, f.data))).toBe(f.hex)
  })
})
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/lib/watch-link && npm run check`
Expected: PASS; `astro check` clean over the vendored TypeScript.

- [ ] **Step 4: Commit**

```bash
git add scripts/vendor-watch-link.mjs src/lib/watch-link .gitattributes
git commit -m "feat(live-viewer): vendor the live-link protocol from nodeterm, pinned by hash and vectors"
```

---

### Task 2: Route headers and id check

**Files:**
- Create: `src/lib/viewer-headers.ts`, `src/lib/viewer-headers.test.ts`

**Interfaces:**
- Produces: `DEFAULT_API = 'https://api.nodeterm.dev'`, `DEFAULT_RELAY = 'wss://relay.nodeterm.dev'`, `isLinkId(id: string): boolean`, `viewerHeaders(o?: { api?: string; relay?: string }): Record<string, string>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest'
import { isLinkId, viewerHeaders } from './viewer-headers'

describe('viewer headers', () => {
  test('a strict CSP that allows only this page, the API and the relay', () => {
    const h = viewerHeaders()
    const csp = h['Content-Security-Policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toMatch(/script-src[^;]*unsafe/)
    expect(csp).toContain('connect-src https://api.nodeterm.dev wss://relay.nodeterm.dev')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(h['Referrer-Policy']).toBe('no-referrer')
    expect(h['X-Robots-Tag']).toBe('noindex, nofollow')
    expect(h['Cache-Control']).toBe('no-store')
  })
  test('staging origins replace the defaults', () => {
    expect(viewerHeaders({ api: 'https://api.staging', relay: 'wss://relay.staging' })['Content-Security-Policy']).toContain('connect-src https://api.staging wss://relay.staging')
  })
  test('link ids', () => {
    expect(isLinkId('AbCdEfGhIjKlMnOpQrStUv')).toBe(true)
    expect(isLinkId('short')).toBe(false)
    expect(isLinkId('AbCdEfGhIjKlMnOpQrStU/')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/viewer-headers.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// Security headers for the live-link viewer (/s/<id>) ONLY. The page renders terminal output from a
// stranger's machine, so it gets the strictest policy the site has: scripts from this origin only,
// connections to the API and the relay only, no framing, no referrer (the secret is in the fragment,
// which a referrer never carries, but nothing else about the page should travel either).
import { LINK_ID_RE } from './watch-link/link'

export const DEFAULT_API = 'https://api.nodeterm.dev'
export const DEFAULT_RELAY = 'wss://relay.nodeterm.dev'

export const isLinkId = (id: string): boolean => LINK_ID_RE.test(id)

export function viewerHeaders(o: { api?: string; relay?: string } = {}): Record<string, string> {
  const api = o.api ?? DEFAULT_API
  const relay = o.relay ?? DEFAULT_RELAY
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      // xterm injects <style> elements at runtime; styles only, never scripts.
      "style-src 'self' 'unsafe-inline'",
      `connect-src ${api} ${relay}`,
      "img-src 'self' data:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  }
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewer-headers.ts src/lib/viewer-headers.test.ts
git commit -m "feat(live-viewer): strict route-only headers for the viewer page"
```

---

### Task 3: The viewer controller (pure)

**Files:**
- Create: `src/lib/watch-viewer/controller.ts`, `src/lib/watch-viewer/controller.test.ts`

**Interfaces:**
- Consumes: vendored `connectWatchClient`, `WatchSocket`, `deriveWatchLinkKeys`, `WATCH_EVENT`, `WATCH_PROTOCOL_VERSION`, `sanitizeChatText`, `sanitizeChatName`, `isWatchEndReason`, types.
- Produces:
  - `type ViewerPhase = { kind: 'connecting' } | { kind: 'waiting' } | { kind: 'live'; meta: WatchMeta } | { kind: 'retrying'; inMs: number } | { kind: 'ended'; reason: 'invalid' | 'revoked' | 'expired' | 'closed' | 'kicked' | 'outdated' }`
  - `PHASE_TEXT: (p: ViewerPhase) => string`
  - `RETRY_MS = [1000, 2000, 4000, 8000, 15000]`, `RETRY_STEADY_MS = 30000`, `CHAT_CLIENT_MIN_MS = 2000`
  - `interface ViewerDeps { apiBase: string; fetch: typeof fetch; openSocket(url: string): WatchSocket; connect?: typeof connectWatchClient; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; now(): number; onPhase(p: ViewerPhase): void; onKeyframe(k: WatchKeyframe): void; onData(data: string): void; onSize(cols: number, rows: number): void; onChat(m: WatchChatMessage): void }`
  - `startViewer(link: { linkId: string; secret: Uint8Array }, deps: ViewerDeps): { sendChat(name: string, text: string): 'sent' | 'too-soon' | 'empty' | 'closed'; stop(): void }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test, vi } from 'vitest'
import { startViewer, PHASE_TEXT, RETRY_MS, type ViewerDeps, type ViewerPhase } from './controller'
import type { WatchClientEvents, WatchSocket } from '../watch-link/client'

const secret = new Uint8Array(32).fill(3)
const link = { linkId: 'AbCdEfGhIjKlMnOpQrStUv', secret }

function harness(replies: Array<() => Response>) {
  const phases: ViewerPhase[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const sockets: string[] = []
  const clients: { ev: WatchClientEvents; chats: [string, string][]; closed: boolean }[] = []
  const got = { keyframes: [] as unknown[], data: [] as string[], sizes: [] as number[][], chats: [] as unknown[] }
  const deps: ViewerDeps = {
    apiBase: 'https://api.test',
    fetch: (async () => (replies.shift() ?? (() => new Response(null, { status: 500 })))()) as typeof fetch,
    openSocket: (url) => { sockets.push(url); return {} as WatchSocket },
    connect: ((o: { events: WatchClientEvents }) => {
      const c = { ev: o.events, chats: [] as [string, string][], closed: false }
      clients.push(c)
      return { sendChat: (n: string, t: string) => { c.chats.push([n, t]); return true }, close: () => { c.closed = true }, isOpen: () => true }
    }) as never,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    now: () => 0,
    onPhase: (p) => phases.push(p),
    onKeyframe: (k) => got.keyframes.push(k),
    onData: (d) => got.data.push(d),
    onSize: (c, r) => got.sizes.push([c, r]),
    onChat: (m) => got.chats.push(m)
  }
  return { deps, phases, timers, sockets, clients, got }
}
const ok = () => new Response(JSON.stringify({ pairingToken: 'T k', relayEndpoint: 'wss://relay.test', exp: 1 }), { status: 200 })
const meta = { v: 1, role: 'commenter', label: 'Ada', title: 'build', expiresAt: 9, cols: 90, rows: 20 }
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('startViewer', () => {
  test('joins, dials the relay with the token, goes live on meta and paints the keyframe', async () => {
    const h = harness([ok])
    startViewer(link, h.deps)
    await flush()
    expect(h.sockets).toEqual(['wss://relay.test?token=T%20k'])
    const ev = h.clients[0].ev
    ev.onOpen()
    ev.onEvent('watch:meta', [meta])
    ev.onEvent('watch:keyframe', [{ sessionId: 's1', screen: 'S', altScreen: true }])
    ev.onPtyData('s1', 'x')
    ev.onPtyData('s2', 'ignored')
    ev.onEvent('pty:size:s1', [{ cols: 100, rows: 25 }])
    expect(h.phases.at(-1)).toEqual({ kind: 'live', meta })
    expect(h.got.keyframes).toEqual([{ sessionId: 's1', screen: 'S', altScreen: true }])
    expect(h.got.data).toEqual(['x'])
    expect(h.got.sizes).toEqual([[100, 25]])
  })

  test('404 is an invalid link, 410 names the reason; both are final', async () => {
    const a = harness([() => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })])
    startViewer(link, a.deps)
    await flush()
    expect(a.phases.at(-1)).toEqual({ kind: 'ended', reason: 'invalid' })
    expect(a.timers).toEqual([])
    const b = harness([() => new Response(JSON.stringify({ error: 'gone', reason: 'expired' }), { status: 410 })])
    startViewer(link, b.deps)
    await flush()
    expect(b.phases.at(-1)).toEqual({ kind: 'ended', reason: 'expired' })
  })

  test('retries with backoff and a fresh join', async () => {
    const h = harness([() => new Response(null, { status: 502 }), ok, ok])
    startViewer(link, h.deps)
    await flush()
    expect(h.phases.at(-1)).toEqual({ kind: 'retrying', inMs: RETRY_MS[0] })
    h.timers.shift()!.fn()
    await flush()
    expect(h.sockets).toHaveLength(1)
    h.clients[0].ev.onClose()
    expect(h.phases.at(-1)).toEqual({ kind: 'retrying', inMs: RETRY_MS[1] })
    h.timers.shift()!.fn()
    await flush()
    expect(h.sockets).toHaveLength(2)
  })

  test('an end is final and closes the client', async () => {
    const h = harness([ok])
    startViewer(link, h.deps)
    await flush()
    h.clients[0].ev.onOpen()
    h.clients[0].ev.onEvent('watch:end', [{ reason: 'revoked' }])
    h.clients[0].ev.onClose()
    expect(h.phases.at(-1)).toEqual({ kind: 'ended', reason: 'revoked' })
    expect(h.clients[0].closed).toBe(true)
    expect(h.timers).toEqual([])
  })

  test('the sharer restarting is a retry, not an end', async () => {
    const h = harness([ok])
    startViewer(link, h.deps)
    await flush()
    h.clients[0].ev.onOpen()
    h.clients[0].ev.onEvent('watch:end', [{ reason: 'host-stopping' }])
    expect(h.phases.at(-1)?.kind).toBe('retrying')
    expect(h.clients[0].closed).toBe(true)
    expect(h.timers).toHaveLength(1)
  })

  test('waiting, kicked, a denial and a newer protocol', async () => {
    const h = harness([ok])
    startViewer(link, h.deps)
    await flush()
    h.clients[0].ev.onOpen()
    h.clients[0].ev.onEvent('watch:waiting', [{}])
    expect(h.phases.at(-1)).toEqual({ kind: 'waiting' })
    h.clients[0].ev.onEvent('watch:meta', [{ ...meta, v: 2 }])
    expect(h.phases.at(-1)).toEqual({ kind: 'ended', reason: 'outdated' })
    const d = harness([ok])
    startViewer(link, d.deps)
    await flush()
    d.clients[0].ev.onDenied('denied')
    expect(d.phases.at(-1)).toEqual({ kind: 'ended', reason: 'invalid' })
  })

  test('refuses a relay endpoint that is not wss', async () => {
    const h = harness([() => new Response(JSON.stringify({ pairingToken: 't', relayEndpoint: 'ws://evil', exp: 1 }), { status: 200 })])
    startViewer(link, h.deps)
    await flush()
    expect(h.sockets).toEqual([])
    expect(h.phases.at(-1)?.kind).toBe('retrying')
  })

  test('chat is sanitized and paced', async () => {
    let t = 0
    const h = harness([ok])
    h.deps.now = () => t
    const v = startViewer(link, h.deps)
    await flush()
    h.clients[0].ev.onOpen()
    expect(v.sendChat('Ada', '   ')).toBe('empty')
    expect(v.sendChat('Ada\u001b', 'hi\u0007 ' + 'x'.repeat(600))).toBe('sent')
    expect(h.clients[0].chats[0][0]).toBe('Ada')
    expect(h.clients[0].chats[0][1].length).toBe(500)
    expect(v.sendChat('Ada', 'again')).toBe('too-soon')
    t = 2000
    expect(v.sendChat('Ada', 'again')).toBe('sent')
  })

  test('every phase has copy', () => {
    for (const p of [{ kind: 'connecting' }, { kind: 'waiting' }, { kind: 'retrying', inMs: 1 }, ...['invalid', 'revoked', 'expired', 'closed', 'kicked', 'outdated'].map((reason) => ({ kind: 'ended', reason }))] as ViewerPhase[]) {
      expect(PHASE_TEXT(p).length).toBeGreaterThan(5)
    }
    expect(PHASE_TEXT({ kind: 'ended', reason: 'invalid' })).toBe("This link isn't valid.")
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// The viewer's state machine, with no DOM: join over HTTP, dial the relay, run the vendored client,
// and turn what arrives into phases the page renders. Every sentence the viewer reads is here.
import { connectWatchClient, type WatchSocket } from '../watch-link/client'
import { deriveWatchLinkKeys } from '../watch-link/keys'
import {
  WATCH_EVENT, WATCH_PROTOCOL_VERSION, isWatchEndReason, sanitizeChatName, sanitizeChatText,
  type WatchChatMessage, type WatchKeyframe, type WatchMeta
} from '../watch-link/protocol'
import { bytesToB64url } from '../watch-link/bytes'

export type EndReason = 'invalid' | 'revoked' | 'expired' | 'closed' | 'kicked' | 'outdated'
export type ViewerPhase =
  | { kind: 'connecting' }
  | { kind: 'waiting' }
  | { kind: 'live'; meta: WatchMeta }
  | { kind: 'retrying'; inMs: number }
  | { kind: 'ended'; reason: EndReason }

export const RETRY_MS = [1000, 2000, 4000, 8000, 15000]
export const RETRY_STEADY_MS = 30000
export const CHAT_CLIENT_MIN_MS = 2000

export function PHASE_TEXT(p: ViewerPhase): string {
  switch (p.kind) {
    case 'connecting': return 'Connecting…'
    case 'waiting': return "The terminal isn't running right now — this page will pick it up when it starts."
    case 'live': return ''
    case 'retrying': return "Can't reach the sharer right now — their nodeterm may be offline, or this link is at its 10-viewer limit. Retrying…"
    case 'ended':
      switch (p.reason) {
        case 'invalid': return "This link isn't valid."
        case 'revoked': return 'The sharer stopped this live link.'
        case 'expired': return 'This live link has expired.'
        case 'closed': return 'The shared terminal was closed.'
        case 'kicked': return 'The sharer ended your connection.'
        case 'outdated': return 'Reload to update this viewer.'
      }
  }
}

export interface ViewerDeps {
  apiBase: string
  fetch: typeof fetch
  openSocket(url: string): WatchSocket
  connect?: typeof connectWatchClient
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  now(): number
  onPhase(p: ViewerPhase): void
  onKeyframe(k: WatchKeyframe): void
  onData(data: string): void
  onSize(cols: number, rows: number): void
  onChat(m: WatchChatMessage): void
}

export function startViewer(
  link: { linkId: string; secret: Uint8Array },
  deps: ViewerDeps
): { sendChat(name: string, text: string): 'sent' | 'too-soon' | 'empty' | 'closed'; stop(): void } {
  const keys = deriveWatchLinkKeys(link.secret)
  const connect = deps.connect ?? connectWatchClient
  const joinKey = bytesToB64url(keys.joinKey)
  let attempt = 0
  let timer: unknown = null
  let client: ReturnType<typeof connectWatchClient> | null = null
  let sessionId: string | null = null
  let ended = false
  let lastChatAt = -Infinity
  const phase = (p: ViewerPhase): void => deps.onPhase(p)

  function end(reason: EndReason): void {
    if (ended) return
    ended = true
    if (timer !== null) deps.clearTimeout(timer)
    timer = null
    client?.close()
    client = null
    phase({ kind: 'ended', reason })
  }
  function retry(minMs = 0): void {
    if (ended) return
    client = null
    const ms = Math.max(minMs, attempt < RETRY_MS.length ? RETRY_MS[attempt] : RETRY_STEADY_MS)
    attempt++
    phase({ kind: 'retrying', inMs: ms })
    timer = deps.setTimeout(() => {
      timer = null
      void join()
    }, ms)
  }

  async function join(): Promise<void> {
    if (ended) return
    phase({ kind: 'connecting' })
    let r: Response
    try {
      r = await deps.fetch(`${deps.apiBase.replace(/\/+$/, '')}/v1/watch-links/${encodeURIComponent(link.linkId)}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinKey })
      })
    } catch {
      retry()
      return
    }
    if (ended) return
    if (r.status === 404 || r.status === 400) return end('invalid')
    let body: Record<string, unknown> | null = null
    try {
      body = (await r.json()) as Record<string, unknown>
    } catch {
      body = null
    }
    if (r.status === 410) return end(body?.reason === 'expired' ? 'expired' : 'revoked')
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after'))
      return retry(ra > 0 ? ra * 1000 : 60_000)
    }
    const token = body?.pairingToken
    const relay = body?.relayEndpoint
    if (r.status !== 200 || typeof token !== 'string' || typeof relay !== 'string' || !relay.startsWith('wss://')) return retry()
    const url = `${relay}${relay.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
    client = connect({
      socket: deps.openSocket(url),
      keys,
      events: {
        onOpen: () => { attempt = 0 },
        onEvent: (channel, args) => onEvent(channel, args[0]),
        onPtyData: (sid, data) => { if (sid === sessionId) deps.onData(data) },
        // Only a holder of a DIFFERENT secret is denied: this page's link is not the host's.
        onDenied: () => end('invalid'),
        onClose: () => retry()
      }
    })
  }

  function onEvent(channel: string, payload: unknown): void {
    const p = (payload ?? {}) as Record<string, unknown>
    if (channel === WATCH_EVENT.meta) {
      if (typeof p.v !== 'number' || p.v > WATCH_PROTOCOL_VERSION) return end('outdated')
      phase({ kind: 'live', meta: p as unknown as WatchMeta })
    } else if (channel === WATCH_EVENT.keyframe && typeof p.sessionId === 'string' && typeof p.screen === 'string') {
      sessionId = p.sessionId
      deps.onKeyframe({ sessionId: p.sessionId, screen: p.screen, altScreen: p.altScreen === true })
    } else if (channel === WATCH_EVENT.waiting) {
      sessionId = null
      phase({ kind: 'waiting' })
    } else if (channel === WATCH_EVENT.chat && typeof p.text === 'string' && typeof p.name === 'string') {
      deps.onChat(p as unknown as WatchChatMessage)
    } else if (channel === WATCH_EVENT.end) {
      const reason = isWatchEndReason(p.reason) ? p.reason : 'revoked'
      // The sharer quit or restarted nodeterm. Links survive restarts (spec D8): wait for it.
      if (reason === 'host-stopping') {
        client?.close()
        return retry()
      }
      end(reason === 'node-gone' || reason === 'session-ended' ? 'closed' : reason === 'kicked' ? 'kicked' : reason === 'expired' ? 'expired' : 'revoked')
    } else if (sessionId && channel === `pty:size:${sessionId}`) {
      if (typeof p.cols === 'number' && typeof p.rows === 'number') deps.onSize(p.cols, p.rows)
    }
  }

  void join()
  return {
    sendChat(rawName, rawText) {
      if (ended || !client) return 'closed'
      const name = sanitizeChatName(rawName)
      const text = sanitizeChatText(rawText)
      if (!name || !text) return 'empty'
      if (deps.now() - lastChatAt < CHAT_CLIENT_MIN_MS) return 'too-soon'
      if (!client.sendChat(name, text)) return 'closed'
      lastChatAt = deps.now()
      return 'sent'
    },
    stop: () => end('closed')
  }
}
```

(`client.close()` marks the vendored client closed before its socket closes, so its `onClose` does not fire a second retry.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/watch-viewer` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watch-viewer
git commit -m "feat(live-viewer): the viewer state machine — join, dial, phases, retries, chat"
```

---

### Task 4: Terminal options, font fitting and keyframe text

**Files:**
- Create: `src/lib/watch-viewer/terminal.ts`, `src/lib/watch-viewer/terminal.test.ts`

**Interfaces:**
- Produces: `VIEWER_TERMINAL_OPTIONS` (xterm `ITerminalOptions`), `MOUSE_MODES = [1000, 1002, 1003, 1005, 1006, 1015]`, `fitFontSize(availablePx: number, cols: number, cellWidthAt10px: number): number` (7…15), `keyframeText(screen: string, altScreen: boolean): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest'
import { fitFontSize, keyframeText, VIEWER_TERMINAL_OPTIONS } from './terminal'

describe('viewer terminal', () => {
  test('read-only, no link handler, bounded scrollback', () => {
    expect(VIEWER_TERMINAL_OPTIONS.disableStdin).toBe(true)
    expect(VIEWER_TERMINAL_OPTIONS.scrollback).toBe(1000)
    expect(VIEWER_TERMINAL_OPTIONS.linkHandler).toBeNull()
    expect(VIEWER_TERMINAL_OPTIONS.cursorBlink).toBe(false)
    // The Unicode 11 width table is a proposed API in xterm 5 (the desktop sets the same).
    expect(VIEWER_TERMINAL_OPTIONS.allowProposedApi).toBe(true)
  })
  test('fits the font to the width between 7 and 15 px', () => {
    expect(fitFontSize(1200, 100, 6)).toBe(15)
    expect(fitFontSize(390, 100, 6)).toBe(7)
    expect(fitFontSize(800, 100, 6)).toBe(13)
  })
  test('keyframe text resets, enters the alternate screen when asked, and uses CRLF', () => {
    expect(keyframeText('a\nb\n', true)).toBe('\x1bc\x1b[?1049h\x1b[H\x1b[2Ja\r\nb')
    expect(keyframeText('a\nb', false)).toBe('\x1bc\x1b[H\x1b[2Ja\r\nb')
    expect(keyframeText('', true)).toBe('\x1bc\x1b[?1049h\x1b[H\x1b[2J')
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// How the viewer's xterm is configured and fed. Read-only by construction (no stdin, no link
// handler, mouse-tracking requests swallowed so text can always be selected); the host already
// stripped every string-type escape sequence, so no OSC 8 hyperlink can arrive.
import type { ITerminalOptions } from '@xterm/xterm'

export const VIEWER_TERMINAL_OPTIONS: ITerminalOptions = {
  disableStdin: true,
  cursorBlink: false,
  scrollback: 1000,
  linkHandler: null,
  allowProposedApi: true,
  fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, monospace",
  fontSize: 13,
  theme: { background: '#08080a', foreground: '#ececf0' }
}

export const MOUSE_MODES = [1000, 1002, 1003, 1005, 1006, 1015]

export function fitFontSize(availablePx: number, cols: number, cellWidthAt10px: number): number {
  const size = Math.floor((availablePx / cols / cellWidthAt10px) * 10)
  return Math.max(7, Math.min(15, size))
}

export function keyframeText(screen: string, altScreen: boolean): string {
  const body = screen.replace(/\n+$/, '').replace(/\r?\n/g, '\r\n')
  return `\x1bc${altScreen ? '\x1b[?1049h' : ''}\x1b[H\x1b[2J${body}`
}
```

(`fitFontSize(800, 100, 6)`: 800/100 = 8 px per column; at 10 px a cell is 6 px wide → 8/6×10 = 13.3 → 13.)

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watch-viewer/terminal.ts src/lib/watch-viewer/terminal.test.ts
git commit -m "feat(live-viewer): read-only terminal options, font fitting, keyframe text"
```

---

### Task 5: DOM glue and the route

**Files:**
- Create: `src/lib/watch-viewer/dom.ts`, `src/pages/s/[id].astro`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `mountViewer(doc: Document): void`; the page shell's element ids: `wv-title`, `wv-by`, `wv-ends`, `wv-term`, `wv-status`, `wv-chat`, `wv-chat-list`, `wv-chat-form`, `wv-chat-name`, `wv-chat-text`, `wv-chat-note`, `wv-report`.

- [ ] **Step 1: DOM glue**

`src/lib/watch-viewer/dom.ts`:

```ts
// DOM glue for the viewer. No decisions live here (controller.ts and terminal.ts own them), and every
// string that came from the sharer or a viewer is set with textContent, never as HTML.
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { parseWatchLinkLocation } from '../watch-link/link'
import type { WatchSocket } from '../watch-link/client'
import { PHASE_TEXT, startViewer, type ViewerPhase } from './controller'
import { MOUSE_MODES, VIEWER_TERMINAL_OPTIONS, fitFontSize, keyframeText } from './terminal'

const NAME_KEY = 'nodeterm.watch.name'

function browserSocket(url: string): WatchSocket {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const queue: (string | Uint8Array)[] = []
  ws.addEventListener('open', () => {
    for (const d of queue.splice(0)) ws.send(d)
  })
  return {
    send: (d) => (ws.readyState === WebSocket.OPEN ? ws.send(d) : void queue.push(d)),
    close: () => ws.close(),
    onMessage: (cb) => ws.addEventListener('message', (e) => cb(e.data)),
    onClose: (cb) => ws.addEventListener('close', () => cb())
  }
}

function remaining(expiresAt: number): string {
  const min = Math.floor((expiresAt - Date.now()) / 60_000)
  if (min < 1) return 'ends in under a minute'
  return min >= 60 ? `ends in ${Math.floor(min / 60)} h` : `ends in ${min} min`
}

export function mountViewer(doc: Document): void {
  const $ = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement
  const status = $('wv-status')
  const link = parseWatchLinkLocation(location.pathname, location.hash)
  if (!link) {
    status.textContent = PHASE_TEXT({ kind: 'ended', reason: 'invalid' })
    return
  }
  const report = $('wv-report') as HTMLAnchorElement
  report.href = `mailto:support@nodeterm.dev?subject=${encodeURIComponent(`Report live link ${link.linkId}`)}`

  const term = new Terminal(VIEWER_TERMINAL_OPTIONS)
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // Mouse tracking would stop the viewer selecting text, and there is nowhere to send the reports.
  const swallowMouse = (params: (number | number[])[]): boolean => params.some((p) => typeof p === 'number' && MOUSE_MODES.includes(p))
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, swallowMouse)
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, swallowMouse)
  const host = $('wv-term')
  term.open(host)
  const refit = (): void => {
    const cell = 6 // monospace cell width at 10 px, close enough for every stack we list
    term.options.fontSize = fitFontSize(host.clientWidth - 16, term.cols, cell)
  }
  new ResizeObserver(refit).observe(host)

  const chat = $('wv-chat')
  const chatList = $('wv-chat-list')
  const nameInput = $('wv-chat-name') as HTMLInputElement
  const textInput = $('wv-chat-text') as HTMLInputElement
  const note = $('wv-chat-note')
  try {
    nameInput.value = localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    // private window: no stored name
  }

  let endsTimer: ReturnType<typeof setInterval> | null = null
  const onPhase = (p: ViewerPhase): void => {
    status.textContent = PHASE_TEXT(p)
    status.hidden = p.kind === 'live'
    if (p.kind === 'live') {
      $('wv-title').textContent = p.meta.title
      $('wv-by').textContent = `by ${p.meta.label} (set by the sharer)`
      $('wv-ends').textContent = remaining(p.meta.expiresAt)
      if (endsTimer) clearInterval(endsTimer)
      endsTimer = setInterval(() => { $('wv-ends').textContent = remaining(p.meta.expiresAt) }, 30_000)
      term.resize(p.meta.cols, p.meta.rows)
      refit()
      chat.hidden = p.meta.role !== 'commenter'
    }
    if (p.kind === 'ended') {
      if (endsTimer) clearInterval(endsTimer)
      $('wv-ends').textContent = ''
    }
  }

  const viewer = startViewer(link, {
    apiBase: doc.body.dataset.api ?? 'https://api.nodeterm.dev',
    fetch: (u, i) => fetch(u, i),
    openSocket: browserSocket,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    onPhase,
    onKeyframe: (k) => term.write(keyframeText(k.screen, k.altScreen)),
    onData: (d) => term.write(d),
    onSize: (c, r) => {
      term.resize(c, r)
      refit()
    },
    onChat: (m) => {
      const li = doc.createElement('li')
      const who = doc.createElement('strong')
      who.textContent = m.name
      const tag = doc.createElement('span')
      tag.className = 'wv-muted'
      tag.textContent = m.from === 'sharer' ? ' (sharer)' : ' (link viewer)'
      const text = doc.createElement('p')
      text.textContent = m.text
      li.append(who, tag, text)
      chatList.append(li)
      chatList.scrollTop = chatList.scrollHeight
    }
  })

  $('wv-chat-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const r = viewer.sendChat(nameInput.value, textInput.value)
    note.textContent = r === 'too-soon' ? 'One message every 2 seconds.' : r === 'empty' ? 'Type a name and a message.' : r === 'closed' ? 'Not connected.' : ''
    if (r === 'sent') {
      textInput.value = ''
      try {
        localStorage.setItem(NAME_KEY, nameInput.value)
      } catch {
        // ignore
      }
    }
  })
}
```

- [ ] **Step 2: The route**

`src/pages/s/[id].astro`:

```astro
---
// The live-link viewer. The server knows nothing about the link: it checks the id's shape, sets the
// strict headers, and returns the shell. Everything else happens in the browser, with the secret
// from the fragment (which never reaches this server).
import { DEFAULT_API, DEFAULT_RELAY, isLinkId, viewerHeaders } from '../../lib/viewer-headers'

const { id = '' } = Astro.params
const api = process.env.WATCH_API_BASE || DEFAULT_API
const relay = process.env.WATCH_RELAY_ORIGIN || DEFAULT_RELAY
if (!isLinkId(id)) Astro.response.status = 404
// Dev injects inline HMR scripts that a strict CSP would block; production gets the full set.
if (import.meta.env.PROD) {
  for (const [k, v] of Object.entries(viewerHeaders({ api, relay }))) Astro.response.headers.set(k, v)
}
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex,nofollow" />
    <meta name="theme-color" content="#08080a" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <title>Live terminal — nodeterm</title>
  </head>
  <body class="wv" data-api={api}>
    <header class="wv-bar">
      <span class="wv-live"><span class="wv-dot"></span>LIVE</span>
      <span class="wv-what">Read-only terminal · shared with nodeterm</span>
      <span class="wv-title" id="wv-title"></span>
      <span class="wv-by" id="wv-by"></span>
      <span class="wv-ends" id="wv-ends"></span>
    </header>
    <main class="wv-main">
      <div class="wv-stage">
        <div class="wv-term" id="wv-term" aria-label="Shared terminal (read-only)"></div>
        <div class="wv-status" id="wv-status" role="status">Connecting…</div>
      </div>
      <aside class="wv-chat" id="wv-chat" hidden>
        <ol class="wv-chat-list" id="wv-chat-list"></ol>
        <form class="wv-chat-form" id="wv-chat-form">
          <input id="wv-chat-name" maxlength="32" placeholder="Your name" autocomplete="nickname" />
          <input id="wv-chat-text" maxlength="500" placeholder="Message the sharer…" autocomplete="off" />
          <p class="wv-muted" id="wv-chat-note" aria-live="polite"></p>
        </form>
      </aside>
    </main>
    <footer class="wv-foot">
      <a href="https://nodeterm.dev" rel="noopener noreferrer">Get nodeterm</a>
      <span>·</span>
      <a id="wv-report" href="mailto:support@nodeterm.dev" rel="noopener noreferrer">Report</a>
    </footer>
    <script>
      import { mountViewer } from '../../lib/watch-viewer/dom'
      mountViewer(document)
    </script>
    <style is:global>
      html, body { margin: 0; height: 100%; background: #08080a; color: #ececf0;
        font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif; overflow-x: hidden; }
      .wv { display: flex; flex-direction: column; min-height: 100%; }
      .wv-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.09); background: #131316; font-size: 13px; position: sticky; top: 0; z-index: 2; }
      .wv-live { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; letter-spacing: 0.04em; }
      .wv-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff453a; }
      .wv-what, .wv-by, .wv-ends, .wv-muted { color: rgba(236, 236, 240, 0.56); }
      .wv-title { font-weight: 600; }
      .wv-main { flex: 1; display: flex; gap: 12px; padding: 12px 16px; min-height: 0; }
      .wv-stage { flex: 1; min-width: 0; position: relative; overflow-x: auto; }
      .wv-term { min-height: 60vh; }
      .wv-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 24px; background: rgba(8, 8, 10, 0.85); font-size: 14px; }
      .wv-status[hidden] { display: none; }
      .wv-chat { width: 300px; display: flex; flex-direction: column; border-left: 1px solid rgba(255, 255, 255, 0.09); padding-left: 12px; }
      .wv-chat[hidden] { display: none; }
      .wv-chat-list { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0; font-size: 13px; }
      .wv-chat-list p { margin: 2px 0 8px; overflow-wrap: anywhere; }
      .wv-chat-form { display: flex; flex-direction: column; gap: 6px; }
      .wv-chat-form input { background: #16161a; color: inherit; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px; padding: 7px 9px; font: inherit; }
      .wv-foot { display: flex; gap: 8px; justify-content: center; padding: 10px; font-size: 12px; color: rgba(236, 236, 240, 0.56); }
      .wv-foot a { color: #4aa8ff; text-decoration: none; }
      @media (max-width: 720px) {
        .wv-main { flex-direction: column; padding: 8px; }
        .wv-chat { width: auto; border-left: 0; border-top: 1px solid rgba(255, 255, 255, 0.09); padding: 8px 0 0; max-height: 40vh; }
        .wv-what { display: none; }
      }
    </style>
  </body>
</html>
```

- [ ] **Step 3: Build and check**

Run: `npm run check && npm test && npm run build`
Expected: clean. Confirm in `dist/` that the viewer's script is an external `_astro/*.js` file (not inline), otherwise `script-src 'self'` would block it: `grep -l "mountViewer" dist/client/_astro/*.js`.

- [ ] **Step 4: Manual check (record the results in the PR)**

`npm run build && PORT=4321 node dist/server/entry.mjs`, then with `curl -sI http://localhost:4321/s/AbCdEfGhIjKlMnOpQrStUv` confirm every header from Global Constraints is present and `curl -sI http://localhost:4321/` has none of them; `curl -s -o /dev/null -w '%{http_code}' http://localhost:4321/s/bad` answers `404`. Open `http://localhost:4321/s/AbCdEfGhIjKlMnOpQrStUv#1.bad` in a browser: "This link isn't valid." with no network request (DevTools → Network). A full end-to-end run needs Plan 1 deployed and a desktop from Plan 2 — that is device checklist item 1 in `docs/live-links.md`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watch-viewer/dom.ts "src/pages/s/[id].astro"
git commit -m "feat(live-viewer): the /s/<id> page — read-only xterm, LIVE framing, chat for commenter links"
```

---

### Task 6: Push and PR

- [ ] **Step 1: Push the branch (never main)**

```bash
git branch --show-current   # feat/live-viewer
git log --oneline origin/main..HEAD
git push -u origin feat/live-viewer
```

- [ ] **Step 2: Open the PR**

`gh pr create --title "feat: live-link viewer page (/s/<id>)" --body-file /tmp/live-viewer-pr.md` — English, pr-writing style: what (route, headers, vendored client + hash check, controller), why (spec path in nodeterm), how checked (tests, `astro check`, the curl header check, the external-script check), what was not (no end-to-end run until Plans 1 and 2 are deployed; mobile Safari layout owed on a device), deploy order (backend → desktop release → this), and the rule that `src/lib/watch-link/` is only ever changed by `scripts/vendor-watch-link.mjs`. End with the session's attribution line. **Do not merge; enes decides.**
