# Live links — Plan 2 of 3: Desktop + Server Edition (nodeterm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Pro user create, watch over and stop a live, read-only, expiring browser link to one terminal/agent node, hosted from the desktop or the Server Edition through the existing E2E relay, with the viewer as the narrowest possible relay peer.

**Architecture:** A new core service (`src/core/watch-link/`) owns the link registry (persisted through `CorePlatform.sealSecret`), one `hosted-scheduler` per link, and for every connected viewer a `connectRelayHost` session whose peer key must be the one derived from the link secret. The viewer is a *quiet*, *self-paced* core client: it never appears in `broadcast()`/`clientIds()`, it joins the node's pty with `joinOnly` + `sizeVote:false`, every inbound request is refused, and its outbound stream passes a string-sequence filter, a byte budget and a visible-screen keyframe path. An isomorphic client (`src/shared/watch-link/`) is the browser half, tested here against the real host and vendored byte-identically by nodeterm-web (Plan 3).

**Tech Stack:** TypeScript, Electron + the Server Edition (`src/server`), React 19 + zustand, tweetnacl, WebCrypto HKDF (`globalThis.crypto.subtle`, Node ≥ 20 and browsers), vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-live-share-link-design.md` (read it first; this plan argues from it).

**Plans in this series:** 1 = `2026-09-30-live-links-1-backend.md` (nodeterm-server; defines the HTTP contract this plan calls), 2 = this, 3 = `2026-09-30-live-links-3-web.md` (nodeterm-web viewer, consumes `src/shared/watch-link/`).

## Global Constraints

- Work on branch `feat/live-share-link` in `/root/nodeterm/wtshare` (already on `origin/main` + the spec). `/root/nodeterm` is edited live by other sessions: never edit it, never stash/reset there. Before every commit: `git branch --show-current` must print `feat/live-share-link`.
- **Run the full suite only as** `HOME=$(mktemp -d) npx vitest run` (the full suite otherwise rewrites `~/.nodeterm/agent-hooks`). Single files: `npx vitest run <path>`.
- Naming: UI "Live link"; code `watchLink`; relay role `watcher`; owner IPC prefix **`watchLink:`** (host-only); viewer tunnel protocol prefix **`watch:`** (must NOT start with `watchLink:` — `relay-host` refuses host-only methods before any hook).
- Link: `https://nodeterm.dev/s/<linkId>#1.<S>`; `linkId` matches `/^[A-Za-z0-9_-]{22}$/`; `S` = 32 random bytes, base64url (43 chars).
- KDF: `SHA512(utf8("nodeterm-watch-link-v1/" + label) ‖ S)[0..32]`, labels `host`, `viewer`, `join`; key pairs via `nacl.box.keyPair.fromSecretKey`.
- Relay pairing id `wl.<linkId>` (set by the API; the desktop never names it).
- Limits: 5 active links per machine; 10 viewers per link; TTLs `900 | 3600 | 28800 | 86400`; chat 1 per 2 s per viewer, text ≤ 500, name ≤ 32; label ≤ 40; title ≤ 80.
- Viewer backpressure: drop-and-redraw at **512 KB** buffered, keyframe once below **256 KB**; token bucket **256 KB/s, 1 MB burst**; keyframes at most **1/s**.
- Stream filter: strip OSC/DCS/SOS/PM/APC (7- and 8-bit); give up only past **1 MiB** of one unterminated string; reset only on a new pty session.
- Never send history: `captureVisible` returns `''` for session-host and direct-Windows sessions.
- Link state is **never** canvas content: no field on `CanvasNodeState`, `CanvasMutation`, `ProjectKanban`, and no `canvas:mut` op.
- No credential in argv. No canvas-control verb for links. No `electron` import in `src/core` (`src/core/no-electron.test.ts`).
- UI copy in English. Comments state *why*, matching the surrounding density.
- Never push `main`. Push the feature branch and open a PR; enes merges.

## Review Focus

1. **A viewer that connects while the node's terminal is not running** (project closed, released, shell exited) → page gets `watch:waiting`, the host re-tries the join with backoff, and streaming starts by itself when the terminal comes back; no error, no spawn. → Task 11 test "waits, then streams when the session appears".
2. **Output that ends mid-escape-sequence exactly at a chunk boundary** (an OSC 52 split across two pty flushes, an ESC as the last char) → nothing of the OSC reaches the viewer and the following text is intact. → Task 4 test "split at every position".
3. **The owner's pty churns while a viewer's socket is stalled** (`yes`) → the owner's pty is never paused and never slowed; the viewer gets keyframes at ≤ 1/s. → Task 11 test "a stalled viewer never pauses and gets throttled keyframes"; Task 6 test "self-paced never calls the flow controller".
4. **Two links on one node, and a node deleted while viewers watch** → both links end with `node-gone`, both server rows are revoked, chips disappear. → Task 12 test "node gone ends every link of the node".
5. **App restart with a live link whose secret cannot be unsealed** (keychain reset) → the record is dropped at load, never replaced by a plaintext copy; the server row simply expires. → Task 9 test "an unsealable secret is skipped".

---

## File Structure

| File | Responsibility |
|---|---|
| **Isomorphic viewer protocol (vendored by nodeterm-web)** | |
| `src/shared/watch-link/bytes.ts` | base64/base64url/hex/utf8 helpers without `Buffer` |
| `src/shared/watch-link/keys.ts` | secret → host/viewer key pairs, join key; `sha256Hex` |
| `src/shared/watch-link/link.ts` | link format/parse |
| `src/shared/watch-link/hkdf.ts` | WebCrypto HKDF-SHA256 |
| `src/shared/watch-link/wire.ts` | relay box, header, tags, pty frame, tunnel JSON — a copy of the relay's wire rules without Node |
| `src/shared/watch-link/protocol.ts` | `watch:*` event names, payload types, chat sanitizers |
| `src/shared/watch-link/client.ts` | `connectWatchClient`: handshake + trust confirm + event/pty dispatch |
| `src/shared/watch-link/vectors.json` | cross-repo test vectors |
| **Owner-side shared types** | |
| `src/shared/watch-link-types.ts` | IPC request/result/view types + `WatchLinkApi` |
| **Core** | |
| `src/core/watch-link/stream-filter.ts` | string-sequence stripper |
| `src/core/watch-link/token-bucket.ts` | byte budget |
| `src/core/watch-link/watcher-policy.ts` | `access` hook + sink wrapper |
| `src/core/watch-link/store.ts` | persisted records |
| `src/core/watch-link/api.ts` | HTTP client for Plan 1's routes |
| `src/core/watch-link/link-host.ts` | one link's listeners and viewer sessions |
| `src/core/watch-link/service.ts` | registry + lifecycle + IPC |
| modify `src/core/ui-sink-registry.ts`, `src/core/platform.ts`, `src/core/platform-fake.ts`, `src/core/pty-reap.ts`, `src/core/pty-manager.ts`, `src/core/remote-ssh/control-master.ts`, `src/core/relay/hosted-scheduler.ts`, `src/shared/host-control.ts`, `src/shared/ipc.ts`, `src/shared/types.ts` | seams |
| **Shells** | `src/main/peer-registry.ts`, `src/main/platform-electron.ts`, `src/main/index.ts`, `src/server/platform-server.ts`, `src/server/index.ts`, `src/preload/index.ts`, `src/renderer/bridge/{ws-bridge,stubs,relay-api}.ts` |
| **Renderer** | `src/renderer/state/watchLinks.ts`, `src/renderer/lib/liveLink.ts`, `src/renderer/components/{LiveLinkChip,LiveLinkPopover,LiveLinkDialog}.tsx`, `src/renderer/components/settings/sections/LiveLinksSection.tsx`, edits in `Canvas.tsx`, `TerminalNode.tsx`, `kanban/{CardModal,SessionCard,KanbanView}.tsx`, `SessionRow.tsx`, `settings/{nav,SettingsIcons,SettingsPage}`, `ProCompare.tsx`, `lib/ui-visibility.ts`, `styles.css` |
| **Docs** | `docs/live-links.md`, `CLAUDE.md`, `CONTRIBUTING.md` |

---

### Task 1: Isomorphic bytes, keys and link format

**Files:**
- Create: `src/shared/watch-link/bytes.ts`, `src/shared/watch-link/keys.ts`, `src/shared/watch-link/link.ts`
- Test: `src/shared/watch-link/keys.test.ts`

**Interfaces:**
- Produces:
  - `bytesToB64(b: Uint8Array): string`, `b64ToBytes(s: string): Uint8Array | null`, `bytesToB64url(b)`, `b64urlToBytes(s): Uint8Array | null`, `bytesToHex(b)`, `utf8(s): Uint8Array`, `concatBytes(...parts: Uint8Array[]): Uint8Array`
  - `interface KeyPairBytes { publicKey: Uint8Array; secretKey: Uint8Array }`, `interface WatchLinkKeys { host: KeyPairBytes; viewer: KeyPairBytes; joinKey: Uint8Array }`
  - `WATCH_LINK_KDF_PREFIX = 'nodeterm-watch-link-v1/'`, `deriveWatchLinkKeys(secret: Uint8Array): WatchLinkKeys`, `newWatchLinkSecret(): Uint8Array`, `sha256Hex(b: Uint8Array): Promise<string>`
  - `WATCH_LINK_ORIGIN = 'https://nodeterm.dev'`, `LINK_ID_RE`, `formatWatchLink(linkId: string, secret: Uint8Array, origin?: string): string`, `parseWatchLinkLocation(pathname: string, hash: string): { linkId: string; secret: Uint8Array } | null`

- [ ] **Step 1: Write the failing test**

`src/shared/watch-link/keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import nacl from 'tweetnacl'
import { bytesToB64, b64ToBytes, bytesToB64url, b64urlToBytes, bytesToHex, utf8, concatBytes } from './bytes'
import { deriveWatchLinkKeys, newWatchLinkSecret, sha256Hex, WATCH_LINK_KDF_PREFIX } from './keys'
import { formatWatchLink, parseWatchLinkLocation, LINK_ID_RE } from './link'

const secret = Uint8Array.from({ length: 32 }, (_, i) => i)

describe('bytes', () => {
  it('round-trips base64 and base64url like Buffer does', () => {
    const b = nacl.randomBytes(57)
    expect(bytesToB64(b)).toBe(Buffer.from(b).toString('base64'))
    expect(bytesToB64url(b)).toBe(Buffer.from(b).toString('base64url'))
    expect(b64ToBytes(bytesToB64(b))).toEqual(b)
    expect(b64urlToBytes(bytesToB64url(b))).toEqual(b)
    expect(bytesToHex(Uint8Array.of(0, 255, 16))).toBe('00ff10')
    expect(concatBytes(utf8('a'), utf8('bc'))).toEqual(utf8('abc'))
  })
  it('refuses malformed base64 instead of silently truncating', () => {
    expect(b64ToBytes('not base64!!')).toBeNull()
    expect(b64urlToBytes('+/+/')).toBeNull()
  })
})

describe('deriveWatchLinkKeys', () => {
  it('derives each key from a domain-separated SHA-512 of the secret', () => {
    const k = deriveWatchLinkKeys(secret)
    const sub = (label: string) =>
      new Uint8Array(createHash('sha512').update(Buffer.concat([Buffer.from(WATCH_LINK_KDF_PREFIX + label), Buffer.from(secret)])).digest()).slice(0, 32)
    expect(k.host.secretKey).toEqual(sub('host'))
    expect(k.host.publicKey).toEqual(nacl.box.keyPair.fromSecretKey(sub('host')).publicKey)
    expect(k.viewer.secretKey).toEqual(sub('viewer'))
    expect(k.joinKey).toEqual(sub('join'))
    expect(k.host.publicKey).not.toEqual(k.viewer.publicKey)
  })
  it('makes a fresh 32-byte secret each time', () => {
    const a = newWatchLinkSecret()
    expect(a).toHaveLength(32)
    expect(a).not.toEqual(newWatchLinkSecret())
  })
  it('hashes the join key as lowercase hex sha256', async () => {
    const k = deriveWatchLinkKeys(secret)
    expect(await sha256Hex(k.joinKey)).toBe(createHash('sha256').update(k.joinKey).digest('hex'))
  })
})

describe('link format', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv'
  it('formats and parses the viewer URL', () => {
    const url = formatWatchLink(id, secret)
    expect(url).toBe(`https://nodeterm.dev/s/${id}#1.${Buffer.from(secret).toString('base64url')}`)
    const u = new URL(url)
    expect(parseWatchLinkLocation(u.pathname, u.hash)).toEqual({ linkId: id, secret })
  })
  it('refuses a wrong version, id or secret length', () => {
    const s = Buffer.from(secret).toString('base64url')
    expect(parseWatchLinkLocation(`/s/${id}`, `#2.${s}`)).toBeNull()
    expect(parseWatchLinkLocation('/s/short', `#1.${s}`)).toBeNull()
    expect(parseWatchLinkLocation(`/s/${id}`, `#1.${s.slice(1)}`)).toBeNull()
    expect(parseWatchLinkLocation(`/s/${id}/x`, `#1.${s}`)).toBeNull()
    expect(LINK_ID_RE.test(id)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/shared/watch-link/keys.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/shared/watch-link/bytes.ts`:

```ts
// Byte helpers for the live-link protocol. ISOMORPHIC: this directory is vendored byte-for-byte by
// nodeterm-web (the viewer page), so nothing here may touch `Buffer`, `node:*` or the DOM beyond
// `btoa`/`atob`/`TextEncoder`, which Node ≥ 16 and every browser provide.

const B64 = /^[A-Za-z0-9+/]*={0,2}$/
const B64URL = /^[A-Za-z0-9_-]*$/

export function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

/** Strict: a string with characters outside the alphabet is `null`, never a silently shorter key. */
export function b64ToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !B64.test(s)) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export function bytesToB64url(b: Uint8Array): string {
  return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !B64URL.test(s)) return null
  const std = s.replace(/-/g, '+').replace(/_/g, '/')
  return b64ToBytes(std + '='.repeat((4 - (std.length % 4)) % 4))
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
```

`src/shared/watch-link/keys.ts`:

```ts
// Everything a live link needs is derived from ONE 32-byte secret S that lives only in the URL
// fragment. The host key pair lets the viewer pin the host; the viewer key pair is what the host
// accepts in the handshake (so the relay handshake itself is unchanged); the join key is shown to
// the API, which stores only its SHA-256 and so can gate a join without learning S. The three are
// domain-separated, so learning the join key (the API does) reveals nothing about the other two.
import nacl from 'tweetnacl'
import { bytesToHex, concatBytes, utf8 } from './bytes'

export const WATCH_LINK_KDF_PREFIX = 'nodeterm-watch-link-v1/'
export const WATCH_LINK_SECRET_BYTES = 32

export interface KeyPairBytes {
  publicKey: Uint8Array
  secretKey: Uint8Array
}
export interface WatchLinkKeys {
  host: KeyPairBytes
  viewer: KeyPairBytes
  joinKey: Uint8Array
}

function sub(secret: Uint8Array, label: string): Uint8Array {
  return nacl.hash(concatBytes(utf8(WATCH_LINK_KDF_PREFIX + label), secret)).slice(0, 32)
}

export function deriveWatchLinkKeys(secret: Uint8Array): WatchLinkKeys {
  if (secret.length !== WATCH_LINK_SECRET_BYTES) throw new Error('A live link secret is 32 bytes.')
  return {
    host: nacl.box.keyPair.fromSecretKey(sub(secret, 'host')),
    viewer: nacl.box.keyPair.fromSecretKey(sub(secret, 'viewer')),
    joinKey: sub(secret, 'join')
  }
}

export function newWatchLinkSecret(): Uint8Array {
  return nacl.randomBytes(WATCH_LINK_SECRET_BYTES)
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b)))
}
```

`src/shared/watch-link/link.ts`:

```ts
// The viewer URL: https://nodeterm.dev/s/<linkId>#1.<S>. The id names a link and unlocks nothing;
// S is in the FRAGMENT so it never reaches an HTTP request, a server log or a referrer.
import { b64urlToBytes, bytesToB64url } from './bytes'
import { WATCH_LINK_SECRET_BYTES } from './keys'

export const WATCH_LINK_ORIGIN = 'https://nodeterm.dev'
export const WATCH_LINK_FRAGMENT_VERSION = '1'
export const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/

export function formatWatchLink(linkId: string, secret: Uint8Array, origin: string = WATCH_LINK_ORIGIN): string {
  return `${origin}/s/${linkId}#${WATCH_LINK_FRAGMENT_VERSION}.${bytesToB64url(secret)}`
}

export function parseWatchLinkLocation(pathname: string, hash: string): { linkId: string; secret: Uint8Array } | null {
  const m = /^\/s\/([^/]+)\/?$/.exec(pathname)
  if (!m || !LINK_ID_RE.test(m[1])) return null
  const frag = hash.startsWith('#') ? hash.slice(1) : hash
  const dot = frag.indexOf('.')
  if (dot < 0 || frag.slice(0, dot) !== WATCH_LINK_FRAGMENT_VERSION) return null
  const secret = b64urlToBytes(frag.slice(dot + 1))
  if (!secret || secret.length !== WATCH_LINK_SECRET_BYTES) return null
  return { linkId: m[1], secret }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/shared/watch-link/keys.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/watch-link
git commit -m "feat(watch-link): derive a live link's keys from its secret, and its URL format"
```

---

### Task 2: Wire rules, HKDF and the `watch:` protocol

**Files:**
- Create: `src/shared/watch-link/hkdf.ts`, `src/shared/watch-link/wire.ts`, `src/shared/watch-link/protocol.ts`
- Test: `src/shared/watch-link/wire.test.ts`

**Interfaces:**
- Consumes: `bytes.ts`.
- Produces:
  - `hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>`
  - `TAG_RPC = 0x01`, `TAG_TUNNEL_TEXT = 0x03`, `TAG_TUNNEL_BIN = 0x04`, `ROLE_HOST = 1`, `ROLE_CLIENT = 2`, `RELAY_SESSION_INFO = 'nodeterm-relay-session-v2'`, `NONCE_BYTES = 16`
  - `sealBox(plain, key, nonce?): Uint8Array`, `openBox(box, key): Uint8Array | null`, `withHeader(role, seq, body): Uint8Array`, `readHeader(plain): { role: number; seq: number; body: Uint8Array } | null`
  - `encodePtyFrame(sessionId, data): Uint8Array`, `decodePtyFrame(buf): { sessionId: string; data: string } | null`
  - `type TunnelMessage = { t: 'ev'; channel: string; args: unknown[] } | { t: 'cast'; method: string; args: unknown[] }`, `parseTunnelJson(json: string): TunnelMessage | null`
  - protocol: `WATCH_PROTOCOL_VERSION = 1`, `WATCH_EVENT_PREFIX = 'watch:'`, `WATCH_EVENT = { meta, keyframe, waiting, chat, end }`, `WATCH_CHAT_CAST = 'watch:chat'`, `type WatchLinkRole = 'viewer' | 'commenter'`, `type WatchLinkEndReason = 'revoked' | 'expired' | 'node-gone' | 'session-ended' | 'host-stopping' | 'kicked'`, `interface WatchMeta`, `interface WatchKeyframe`, `interface WatchChatMessage`, `CHAT_TEXT_MAX = 500`, `CHAT_NAME_MAX = 32`, `sanitizeChatText(raw: unknown): string | null`, `sanitizeChatName(raw: unknown): string | null`, `isWatchEndReason(x: unknown): x is WatchLinkEndReason`

- [ ] **Step 1: Write the failing test**

`src/shared/watch-link/wire.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hkdfSync } from 'node:crypto'
import nacl from 'tweetnacl'
import { encodePtyData, encodeArgs, parseRpcMessage } from '../rpc'
import { decrypt, encrypt } from '../../core/relay/e2ee'
import { hkdfSha256 } from './hkdf'
import { sealBox, openBox, withHeader, readHeader, encodePtyFrame, decodePtyFrame, parseTunnelJson, RELAY_SESSION_INFO } from './wire'
import { sanitizeChatText, sanitizeChatName, isWatchEndReason, WATCH_CHAT_CAST, WATCH_EVENT_PREFIX } from './protocol'
import { utf8 } from './bytes'

describe('the wire rules match the relay they were copied from', () => {
  it('HKDF equals node:crypto', async () => {
    const ikm = nacl.randomBytes(32), salt = nacl.randomBytes(32)
    const ours = await hkdfSha256(ikm, salt, utf8(RELAY_SESSION_INFO), 32)
    expect(ours).toEqual(new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(RELAY_SESSION_INFO), 32)))
  })
  it('a box sealed here opens with e2ee.decrypt and vice versa', () => {
    const key = nacl.randomBytes(32), plain = utf8('hello')
    expect(decrypt(sealBox(plain, key), key)).toEqual(plain)
    expect(openBox(encrypt(plain, key), key)).toEqual(plain)
    expect(openBox(Uint8Array.of(1, 2, 3), key)).toBeNull()
  })
  it('the header is role, seq high word LE, seq low word LE', () => {
    const h = withHeader(2, 2 ** 32 + 7, utf8('x'))
    expect(Array.from(h.slice(0, 9))).toEqual([2, 1, 0, 0, 0, 7, 0, 0, 0])
    expect(readHeader(h)).toEqual({ role: 2, seq: 2 ** 32 + 7, body: utf8('x') })
    expect(readHeader(Uint8Array.of(1, 2))).toBeNull()
  })
  it('pty frames equal rpc.ts', () => {
    const sid = 'sess-é', data = 'a\u001b[31mbé'
    expect(encodePtyFrame(sid, data)).toEqual(encodePtyData(sid, data))
    expect(decodePtyFrame(encodePtyData(sid, data))).toEqual({ sessionId: sid, data })
    expect(decodePtyFrame(Uint8Array.of(9))).toBeNull()
  })
  it('tunnel JSON parses like parseRpcMessage, undefined slots included', () => {
    const ev = JSON.stringify({ t: 'ev', channel: 'watch:meta', ...encodeArgs([{ a: 1 }, undefined]) })
    expect(parseTunnelJson(ev)).toEqual(parseRpcMessage(ev))
    const cast = JSON.stringify({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson(cast)).toEqual({ t: 'cast', method: 'trust:confirm', args: [] })
    expect(parseTunnelJson('{"t":"res","id":1,"ok":true,"result":1}')).toBeNull()
    expect(parseTunnelJson('nope')).toBeNull()
  })
})

describe('protocol', () => {
  it('the viewer cast is not in the host-only owner namespace', () => {
    expect(WATCH_CHAT_CAST.startsWith('watchLink:')).toBe(false)
    expect(WATCH_EVENT_PREFIX).toBe('watch:')
  })
  it('sanitizes chat text and names', () => {
    expect(sanitizeChatText('  hi\u0007 there\nfriend \u009b ')).toBe('hi there friend')
    expect(sanitizeChatText('x'.repeat(600))).toHaveLength(500)
    expect(sanitizeChatText('   ')).toBeNull()
    expect(sanitizeChatText(42)).toBeNull()
    expect(sanitizeChatName('\u001b[31mAda')).toBe('[31mAda')
    expect(sanitizeChatName('n'.repeat(40))).toHaveLength(32)
    expect(isWatchEndReason('kicked')).toBe(true)
    expect(isWatchEndReason('nope')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/shared/watch-link/wire.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/shared/watch-link/hkdf.ts`:

```ts
// HKDF-SHA256 over WebCrypto, the browser's equivalent of the relay's `hkdfSync` (e2ee.ts).
export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}
```

`src/shared/watch-link/wire.ts`:

```ts
// The relay's wire rules, restated without Node so the browser can speak them. The SOURCE of truth
// is src/core/relay/relay-socket.ts + e2ee.ts + src/shared/rpc.ts; wire.test.ts pins this copy to
// them byte for byte, so a change there fails here before it can strand the viewer page.
//
// Sealed box: nonce(24) ‖ nacl.box.after(plain). Plain: [role:1][seqHi u32 LE][seqLo u32 LE][tag:1][body].
import nacl from 'tweetnacl'
import { concatBytes } from './bytes'

export const TAG_RPC = 0x01
export const TAG_TUNNEL_TEXT = 0x03
export const TAG_TUNNEL_BIN = 0x04
export const ROLE_HOST = 1
export const ROLE_CLIENT = 2
export const NONCE_BYTES = 16
export const RELAY_SESSION_INFO = 'nodeterm-relay-session-v2'
const HEADER_BYTES = 9

export function sealBox(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array = nacl.randomBytes(nacl.box.nonceLength)): Uint8Array {
  return concatBytes(nonce, nacl.box.after(plain, nonce, key))
}

export function openBox(box: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (box.length < nacl.box.nonceLength + nacl.box.overheadLength) return null
  return nacl.box.open.after(box.subarray(nacl.box.nonceLength), box.subarray(0, nacl.box.nonceLength), key) ?? null
}

export function withHeader(role: number, seq: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + body.length)
  const view = new DataView(out.buffer)
  out[0] = role
  view.setUint32(1, Math.floor(seq / 0x100000000), true)
  view.setUint32(5, seq >>> 0, true)
  out.set(body, HEADER_BYTES)
  return out
}

export function readHeader(plain: Uint8Array): { role: number; seq: number; body: Uint8Array } | null {
  if (plain.length < HEADER_BYTES) return null
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  return { role: plain[0], seq: view.getUint32(1, true) * 0x100000000 + view.getUint32(5, true), body: plain.subarray(HEADER_BYTES) }
}

export function encodePtyFrame(sessionId: string, data: string): Uint8Array {
  const enc = new TextEncoder()
  const sid = enc.encode(sessionId)
  const out = new Uint8Array(3 + sid.length)
  out[0] = 0x01
  out[1] = (sid.length >> 8) & 0xff
  out[2] = sid.length & 0xff
  out.set(sid, 3)
  return concatBytes(out, enc.encode(data))
}

export function decodePtyFrame(buf: Uint8Array): { sessionId: string; data: string } | null {
  if (buf.length < 3 || buf[0] !== 0x01) return null
  const len = (buf[1] << 8) | buf[2]
  if (buf.length < 3 + len) return null
  const dec = new TextDecoder()
  return { sessionId: dec.decode(buf.subarray(3, 3 + len)), data: dec.decode(buf.subarray(3 + len)) }
}

export type TunnelMessage =
  | { t: 'ev'; channel: string; args: unknown[] }
  | { t: 'cast'; method: string; args: unknown[] }

/** The two message kinds a viewer ever receives. `undef` restores `undefined` slots (rpc.ts). */
export function parseTunnelJson(json: string): TunnelMessage | null {
  let m: { t?: unknown; channel?: unknown; method?: unknown; args?: unknown; undef?: unknown }
  try {
    m = JSON.parse(json)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || !Array.isArray(m.args)) return null
  const args = [...m.args]
  if (Array.isArray(m.undef)) for (const i of m.undef) if (Number.isInteger(i) && i >= 0 && i < args.length) args[i] = undefined
  if (m.t === 'ev' && typeof m.channel === 'string') return { t: 'ev', channel: m.channel, args }
  if (m.t === 'cast' && typeof m.method === 'string') return { t: 'cast', method: m.method, args }
  return null
}
```

`src/shared/watch-link/protocol.ts`:

```ts
// What travels inside a live link's E2E tunnel, besides raw pty frames and pty:* events.
// The viewer's namespace is `watch:` on purpose: the OWNER's IPC is `watchLink:`, which the relay
// host refuses from every peer as host-only BEFORE any policy runs (src/shared/host-control.ts).

export const WATCH_PROTOCOL_VERSION = 1
export const WATCH_EVENT_PREFIX = 'watch:'
export const WATCH_EVENT = {
  meta: 'watch:meta',
  keyframe: 'watch:keyframe',
  waiting: 'watch:waiting',
  chat: 'watch:chat',
  end: 'watch:end'
} as const
/** The one message a viewer may send (Commenter links only). */
export const WATCH_CHAT_CAST = 'watch:chat'

export type WatchLinkRole = 'viewer' | 'commenter'
export const WATCH_END_REASONS = ['revoked', 'expired', 'node-gone', 'session-ended', 'host-stopping', 'kicked'] as const
export type WatchLinkEndReason = (typeof WATCH_END_REASONS)[number]
export function isWatchEndReason(x: unknown): x is WatchLinkEndReason {
  return typeof x === 'string' && (WATCH_END_REASONS as readonly string[]).includes(x)
}

export interface WatchMeta {
  v: number
  role: WatchLinkRole
  /** Sharer-supplied; render as text, marked as set by the sharer. */
  label: string
  title: string
  /** Epoch ms on the host's clock, corrected to the server's. */
  expiresAt: number
  cols: number
  rows: number
}
export interface WatchKeyframe {
  sessionId: string
  /** The visible screen with SGR, or '' when the backend has no visible-only capture. */
  screen: string
  /** tmux paints its client on the alternate screen; the viewer must switch to it BEFORE painting,
   *  or every tmux redraw scrolls into the viewer's history (CLAUDE.md, co-attach seeding). */
  altScreen: boolean
}
export interface WatchChatMessage {
  id: string
  name: string
  text: string
  at: number
  from: 'viewer' | 'sharer'
}

export const CHAT_TEXT_MAX = 500
export const CHAT_NAME_MAX = 32
// C0 and C1 controls, DEL, and the ESC that starts every sequence. A newline becomes a space: chat
// is one line, and a pasted multi-line block must not reflow the owner's popover.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\r\n\t]+/g, ' ').replace(CONTROLS, '').replace(/\s+/g, ' ').trim().slice(0, max).trim()
  return s ? s : null
}
export const sanitizeChatText = (raw: unknown): string | null => clean(raw, CHAT_TEXT_MAX)
export const sanitizeChatName = (raw: unknown): string | null => clean(raw, CHAT_NAME_MAX)
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/shared/watch-link && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/watch-link
git commit -m "feat(watch-link): the relay wire rules and the watch: protocol, without Node"
```

---

### Task 3: The viewer client (`connectWatchClient`) and test vectors

**Files:**
- Create: `src/shared/watch-link/client.ts`, `src/shared/watch-link/vectors.json`
- Test: `src/shared/watch-link/client.test.ts`, `src/shared/watch-link/vectors.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; for the test only: `connectRelay` (`src/core/relay/relay-socket.ts`), `transportPair` (`src/core/relay/transport-pair.ts`).
- Produces:
  - `interface WatchSocket { send(data: string | Uint8Array): void; close(): void; onMessage(cb: (data: unknown) => void): void; onClose(cb: () => void): void }` (a `RelayTransport` satisfies it)
  - `interface WatchClientEvents { onOpen(): void; onEvent(channel: string, args: unknown[]): void; onPtyData(sessionId: string, data: string): void; onDenied(reason: string): void; onClose(): void }`
  - `interface WatchClient { sendChat(name: string, text: string): boolean; close(): void; isOpen(): boolean }`
  - `connectWatchClient(opts: { socket: WatchSocket; keys: WatchLinkKeys; events: WatchClientEvents; setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (h: unknown) => void }): WatchClient`
  - `TRUST_CONFIRM_JSON`

- [ ] **Step 1: Write the failing test**

`src/shared/watch-link/client.test.ts` — the client against the REAL host-role relay socket:

```ts
import { describe, it, expect, vi } from 'vitest'
import nacl from 'tweetnacl'
import { connectRelay } from '../../core/relay/relay-socket'
import { transportPair } from '../../core/relay/transport-pair'
import { publicKeyToB64 } from '../../core/relay/e2ee'
import { encodePtyData } from '../rpc'
import { connectWatchClient, TRUST_CONFIRM_JSON } from './client'
import { deriveWatchLinkKeys } from './keys'

function hostWith(keys = deriveWatchLinkKeys(nacl.randomBytes(32))) {
  const { hostT, peerT } = transportPair()
  const tunnel: string[] = []
  let ready = false
  const host = connectRelay({
    url: 'wss://x', token: 't', role: 'host',
    ourKeys: { publicKey: keys.host.publicKey, secretKey: keys.host.secretKey },
    transport: hostT,
    onReady: () => { ready = true },
    onRpc: () => {}, onFrame: () => {}, onClose: () => {},
    onTunnel: (kind, payload) => { if (kind === 'text') tunnel.push(new TextDecoder().decode(payload)) }
  })
  return { keys, host, peerT, tunnel, isReady: () => ready }
}

function events() {
  const log = { open: 0, events: [] as [string, unknown[]][], pty: [] as [string, string][], denied: [] as string[], closed: 0 }
  return {
    log,
    ev: {
      onOpen: () => { log.open++ },
      onEvent: (c: string, a: unknown[]) => { log.events.push([c, a]) },
      onPtyData: (s: string, d: string) => { log.pty.push([s, d]) },
      onDenied: (r: string) => { log.denied.push(r) },
      onClose: () => { log.closed++ }
    }
  }
}

describe('connectWatchClient against the real relay socket', () => {
  it('completes the handshake, confirms trust, and opens once the host confirms', async () => {
    const h = hostWith()
    const { log, ev } = events()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.isReady()).toBe(true))
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    expect(h.host.peerPublicKeyB64()).toBe(publicKeyToB64(h.keys.viewer.publicKey))
    expect(c.isOpen()).toBe(false)
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    expect(log.open).toBe(1)
    expect(c.isOpen()).toBe(true)
  })

  it('delivers ev frames and pty data only after it is open', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'early'))
    expect(log.events).toEqual([])
    expect(log.pty).toEqual([])
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    h.host.sendTunnelText(JSON.stringify({ t: 'ev', channel: 'watch:meta', args: [{ v: 1 }] }))
    h.host.sendTunnelBinary(encodePtyData('s1', 'late'))
    expect(log.events).toEqual([['watch:meta', [{ v: 1 }]]])
    expect(log.pty).toEqual([['s1', 'late']])
  })

  it('reports a denial and never opens', async () => {
    const h = hostWith()
    const { log, ev } = events()
    connectWatchClient({ socket: h.peerT, keys: h.keys, events: ev })
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(JSON.stringify({ t: 'cast', method: 'trust:denied', args: ['denied'] }))
    expect(log.denied).toEqual(['denied'])
    expect(log.open).toBe(0)
  })

  it('cannot talk to a host whose key is not the link one', async () => {
    const real = deriveWatchLinkKeys(nacl.randomBytes(32))
    const impostor = hostWith(deriveWatchLinkKeys(nacl.randomBytes(32)))
    connectWatchClient({ socket: impostor.peerT, keys: real, events: events().ev })
    await new Promise((r) => setTimeout(r, 20))
    expect(impostor.isReady()).toBe(false)
  })

  it('sends a chat cast only while open', async () => {
    const h = hostWith()
    const c = connectWatchClient({ socket: h.peerT, keys: h.keys, events: events().ev })
    expect(c.sendChat('Ada', 'hi')).toBe(false)
    await vi.waitFor(() => expect(h.tunnel).toContain(TRUST_CONFIRM_JSON))
    h.host.sendTunnelText(TRUST_CONFIRM_JSON)
    expect(c.sendChat('Ada', 'hi')).toBe(true)
    expect(h.tunnel.at(-1)).toBe(JSON.stringify({ t: 'cast', method: 'watch:chat', args: [{ name: 'Ada', text: 'hi' }] }))
  })
})
```

`src/shared/watch-link/vectors.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveWatchLinkKeys, sha256Hex } from './keys'
import { bytesToHex } from './bytes'
import { formatWatchLink } from './link'
import { encodePtyFrame } from './wire'

// vectors.json is what nodeterm-web's copy is tested against. It is the fixture; this test proves
// the code still produces it. Regenerate ONLY for a deliberate protocol change (bump the version).
const vectors = JSON.parse(readFileSync(join(__dirname, 'vectors.json'), 'utf8').replace(/\r\n/g, '\n'))

describe('watch-link vectors', () => {
  it('the code reproduces every vector', async () => {
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

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/shared/watch-link/client.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement the client**

`src/shared/watch-link/client.ts`:

```ts
// The browser half of a live link: the CLIENT role of src/core/relay/relay-socket.ts (handshake,
// sealed frames, keepalive) plus the trust gate's client obligation (send our own trust:confirm,
// open only once the host's arrives). Nothing here can write to the terminal: the only message it
// can send after the handshake is a chat cast, which the host accepts for Commenter links only.
import nacl from 'tweetnacl'
import { b64ToBytes, bytesToB64, concatBytes, utf8 } from './bytes'
import { hkdfSha256 } from './hkdf'
import type { WatchLinkKeys } from './keys'
import { WATCH_CHAT_CAST } from './protocol'
import {
  NONCE_BYTES, RELAY_SESSION_INFO, ROLE_CLIENT, ROLE_HOST, TAG_RPC, TAG_TUNNEL_BIN, TAG_TUNNEL_TEXT,
  decodePtyFrame, openBox, parseTunnelJson, readHeader, sealBox, withHeader
} from './wire'

export interface WatchSocket {
  send(data: string | Uint8Array): void
  close(): void
  onMessage(cb: (data: unknown) => void): void
  onClose(cb: () => void): void
}
export interface WatchClientEvents {
  onOpen(): void
  onEvent(channel: string, args: unknown[]): void
  onPtyData(sessionId: string, data: string): void
  onDenied(reason: string): void
  onClose(): void
}
export interface WatchClient {
  sendChat(name: string, text: string): boolean
  close(): void
  isOpen(): boolean
}

export const TRUST_CONFIRM_JSON = '{"t":"cast","method":"trust:confirm","args":[]}'
const KEEPALIVE_MS = 25_000
const KEEPALIVE_JSON = '{"kind":"keepalive"}'

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}
function json(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function connectWatchClient(opts: {
  socket: WatchSocket
  keys: WatchLinkKeys
  events: WatchClientEvents
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}): WatchClient {
  const { socket, keys, events } = opts
  const every = opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const stopEvery = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  const ourNonce = nacl.randomBytes(NONCE_BYTES)
  const baseKey = nacl.box.before(keys.host.publicKey, keys.viewer.secretKey)
  let state: 'hello' | 'deriving' | 'auth' | 'ready' | 'closed' = 'hello'
  let sessionKey: Uint8Array | null = null
  let sendSeq = 0
  let recvSeq = -1
  let hostConfirmed = false
  let opened = false
  let keepalive: unknown = null

  function sendSealed(tag: number, body: Uint8Array): boolean {
    if (!sessionKey || state === 'closed') return false
    socket.send(sealBox(withHeader(ROLE_CLIENT, sendSeq++, concatBytes(Uint8Array.of(tag), body)), sessionKey))
    return true
  }
  function maybeOpen(): void {
    if (opened || !hostConfirmed || state !== 'ready') return
    opened = true
    events.onOpen()
  }
  function shutdown(): void {
    if (state === 'closed') return
    state = 'closed'
    if (keepalive !== null) stopEvery(keepalive)
    keepalive = null
  }

  async function onControl(raw: string): Promise<void> {
    const m = json(raw)
    if (state !== 'hello' || m?.type !== 'e2ee_ready' || typeof m.nonceB64 !== 'string') return
    const hostNonce = b64ToBytes(m.nonceB64)
    if (!hostNonce || hostNonce.length !== NONCE_BYTES) return
    state = 'deriving'
    const key = await hkdfSha256(baseKey, concatBytes(hostNonce, ourNonce), utf8(RELAY_SESSION_INFO), 32)
    if (state !== 'deriving') return
    sessionKey = key
    state = 'auth'
    sendSealed(TAG_RPC, utf8('{"type":"e2ee_auth"}'))
  }

  socket.onMessage((data) => {
    if (state === 'closed') return
    if (typeof data === 'string') {
      void onControl(data)
      return
    }
    const bytes = toBytes(data)
    if (!bytes || !sessionKey) return
    const plain = openBox(bytes, sessionKey)
    const h = plain && readHeader(plain)
    if (!h || h.role !== ROLE_HOST || h.seq <= recvSeq || h.body.length < 1) return
    recvSeq = h.seq
    const tag = h.body[0]
    const body = h.body.subarray(1)
    if (state === 'auth') {
      if (tag !== TAG_RPC || json(new TextDecoder().decode(body))?.type !== 'e2ee_authenticated') return
      state = 'ready'
      keepalive = every(() => void sendSealed(TAG_RPC, utf8(KEEPALIVE_JSON)), KEEPALIVE_MS)
      // After this handler returns: over an in-process transport the host is still inside its own
      // send and has not created its trust gate yet, and a confirm it cannot see is lost for good.
      queueMicrotask(() => {
        sendSealed(TAG_TUNNEL_TEXT, utf8(TRUST_CONFIRM_JSON))
        maybeOpen()
      })
      return
    }
    if (state !== 'ready') return
    if (tag === TAG_TUNNEL_TEXT) {
      const m = parseTunnelJson(new TextDecoder().decode(body))
      if (!m) return
      if (m.t === 'cast' && m.method === 'trust:confirm') {
        hostConfirmed = true
        maybeOpen()
      } else if (m.t === 'cast' && m.method === 'trust:denied') {
        events.onDenied(typeof m.args[0] === 'string' ? m.args[0] : 'denied')
      } else if (m.t === 'ev' && opened) {
        events.onEvent(m.channel, m.args)
      }
      return
    }
    if (tag === TAG_TUNNEL_BIN && opened) {
      const f = decodePtyFrame(body)
      if (f) events.onPtyData(f.sessionId, f.data)
    }
  })
  socket.onClose(() => {
    const wasOpen = state !== 'closed'
    shutdown()
    if (wasOpen) events.onClose()
  })
  socket.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: bytesToB64(keys.viewer.publicKey), nonceB64: bytesToB64(ourNonce) }))

  return {
    sendChat(name, text) {
      if (!opened || state !== 'ready') return false
      return sendSealed(TAG_TUNNEL_TEXT, utf8(JSON.stringify({ t: 'cast', method: WATCH_CHAT_CAST, args: [{ name, text }] })))
    },
    close() {
      shutdown()
      socket.close()
    },
    isOpen: () => opened && state === 'ready'
  }
}
```

- [ ] **Step 4: Generate `vectors.json` once, then pin it**

Create a throwaway `gen-watch-link-vectors.tmp.ts` in the worktree root:

```ts
import { deriveWatchLinkKeys, sha256Hex } from './src/shared/watch-link/keys'
import { bytesToHex } from './src/shared/watch-link/bytes'
import { formatWatchLink } from './src/shared/watch-link/link'
import { encodePtyFrame } from './src/shared/watch-link/wire'

const secrets = ['00'.repeat(32), '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'ff'.repeat(32)]
const ids = ['AAAAAAAAAAAAAAAAAAAAAA', 'AbCdEfGhIjKlMnOpQrStUv', '-_-_-_-_-_-_-_-_-_-_-_']
const keys = []
for (let i = 0; i < 3; i++) {
  const s = Uint8Array.from(Buffer.from(secrets[i], 'hex'))
  const k = deriveWatchLinkKeys(s)
  keys.push({
    secretHex: secrets[i], linkId: ids[i],
    hostPublicHex: bytesToHex(k.host.publicKey), viewerPublicHex: bytesToHex(k.viewer.publicKey),
    joinKeyHex: bytesToHex(k.joinKey), joinKeyHashHex: await sha256Hex(k.joinKey), url: formatWatchLink(ids[i], s)
  })
}
const ptyFrames = [['s1', 'hello'], ['sess-é', 'a\u001b[31mb']].map(([sessionId, data]) => ({ sessionId, data, hex: bytesToHex(encodePtyFrame(sessionId, data)) }))
console.log(JSON.stringify({ version: 1, keys, ptyFrames }, null, 2))
```

Run and remove it:

```bash
npx -y tsx gen-watch-link-vectors.tmp.ts > src/shared/watch-link/vectors.json
rm gen-watch-link-vectors.tmp.ts
head -12 src/shared/watch-link/vectors.json
```

Expected: 3 `keys` entries and 2 `ptyFrames`. `tsx` is fetched on demand; do not add it to package.json.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/shared/watch-link && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/watch-link
git commit -m "feat(watch-link): the viewer's relay client, tested against the real host socket, plus vectors"
```

---

### Task 4: Stream filter and token bucket

**Files:**
- Create: `src/core/watch-link/stream-filter.ts`, `src/core/watch-link/token-bucket.ts`
- Test: `src/core/watch-link/stream-filter.test.ts`, `src/core/watch-link/token-bucket.test.ts`

**Interfaces:**
- Produces: `interface StreamFilter { push(chunk: string): string; reset(): void }`, `createStreamFilter(maxStringChars?: number): StreamFilter` (default `1_048_576`); `interface TokenBucket { take(n: number): boolean }`, `createTokenBucket(o: { ratePerSec: number; burst: number; now: () => number }): TokenBucket`.

- [ ] **Step 1: Write the failing tests**

`src/core/watch-link/stream-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createStreamFilter } from './stream-filter'

const ESC = '\x1b'
const run = (chunks: string[], max?: number): string => {
  const f = createStreamFilter(max)
  return chunks.map((c) => f.push(c)).join('')
}

describe('createStreamFilter', () => {
  it('passes text, CSI and SGR untouched', () => {
    const s = `plain ${ESC}[31mred${ESC}[0m ${ESC}[2J${ESC}[H\r\n${ESC}7${ESC}8 é🙂`
    expect(run([s])).toBe(s)
  })

  it('removes OSC 52 terminated by BEL and by ST, and every string-type sequence', () => {
    expect(run([`a${ESC}]52;c;c2VjcmV0\x07b`])).toBe('ab')
    expect(run([`a${ESC}]0;title${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}Pq#0;2;0;0;0${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}_Gf=100;AAAA${ESC}\\b`])).toBe('ab')
    expect(run([`a${ESC}^pm${ESC}\\b${ESC}Xsos${ESC}\\c`])).toBe('abc')
    expect(run([`a\x9d52;c;x\x9cb\x90dcs\x9cc`])).toBe('abc')
  })

  it('handles a split at every position of an OSC 52', () => {
    const s = `before${ESC}]52;c;c2VjcmV0${ESC}\\after${ESC}[1m!`
    for (let i = 0; i <= s.length; i++) {
      expect(run([s.slice(0, i), s.slice(i)])).toBe(`beforeafter${ESC}[1m!`)
    }
  })

  it('an ESC inside a string aborts it and starts a new sequence', () => {
    expect(run([`a${ESC}]52;c;xx${ESC}[31mred`])).toBe(`a${ESC}[31mred`)
  })

  it('keeps swallowing an unterminated string until the cap, then resumes text', () => {
    const f = createStreamFilter(10)
    expect(f.push(`a${ESC}]52;c;`)).toBe('a')
    expect(f.push('12345')).toBe('')
    // The 11th swallowed char ('6') trips the cap and is dropped with the rest; text resumes after it.
    expect(f.push('67890XYZ')).toBe('7890XYZ')
  })

  it('reset forgets a half-read sequence', () => {
    const f = createStreamFilter()
    expect(f.push(`a${ESC}]52;c;`)).toBe('a')
    f.reset()
    expect(f.push('visible')).toBe('visible')
  })
})
```

`src/core/watch-link/token-bucket.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createTokenBucket } from './token-bucket'

describe('createTokenBucket', () => {
  it('spends a burst, then refills at the rate, never above the burst', () => {
    let t = 0
    const b = createTokenBucket({ ratePerSec: 100, burst: 300, now: () => t })
    expect(b.take(300)).toBe(true)
    expect(b.take(1)).toBe(false)
    t = 500
    expect(b.take(50)).toBe(true)
    expect(b.take(1)).toBe(false)
    t = 100_000
    expect(b.take(301)).toBe(false)
    expect(b.take(300)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/watch-link` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/watch-link/stream-filter.ts`:

```ts
// Removes every STRING-type escape sequence (OSC, DCS, SOS, PM, APC; 7- and 8-bit introducers)
// from a live link's pty stream. They carry what is not text on the screen: the clipboard (OSC 52,
// which tmux emits on every copy with `set-clipboard on`), window titles, hyperlink targets, file
// transfers, palette changes. Everything else (CSI, other ESC sequences, text) passes unchanged.
//
// Stateful across chunks, and it must see EVERY byte of the stream even while nothing is being
// forwarded: a frame that skipped the parser would leave it mid-sequence and print the tail of an
// OSC 52 (the clipboard) as text. That is also why it is reset only for a new pty session.
// An unterminated string is swallowed until its terminator; only past `maxStringChars` does the
// parser give up and return to text.

const ESC = '\x1b'
const BEL = '\x07'
const ST8 = '\x9c'
const INTRO_7 = new Set([']', 'P', 'X', '^', '_'])
const INTRO_8 = new Set(['\x9d', '\x90', '\x98', '\x9e', '\x9f'])
// Fast path: a chunk with none of these, read in text mode, is returned as it is.
const SPECIAL = /[\x1b\x90\x98\x9c-\x9f]/

export interface StreamFilter {
  push(chunk: string): string
  reset(): void
}

export function createStreamFilter(maxStringChars = 1_048_576): StreamFilter {
  let mode: 'text' | 'esc' | 'string' | 'stringEsc' = 'text'
  let len = 0
  const enterString = (): void => {
    mode = 'string'
    len = 0
  }
  return {
    reset() {
      mode = 'text'
      len = 0
    },
    push(chunk) {
      if (mode === 'text' && !SPECIAL.test(chunk)) return chunk
      let out = ''
      for (const ch of chunk) {
        if (mode === 'text') {
          if (ch === ESC) mode = 'esc'
          else if (INTRO_8.has(ch)) enterString()
          else out += ch
        } else if (mode === 'esc') {
          if (INTRO_7.has(ch)) enterString()
          else if (ch === ESC) out += ESC
          else {
            out += ESC + ch
            mode = 'text'
          }
        } else if (mode === 'string') {
          if (ch === BEL || ch === ST8) mode = 'text'
          else if (ch === ESC) mode = 'stringEsc'
          else if (++len > maxStringChars) {
            mode = 'text'
            len = 0
          }
        } else {
          // ESC inside a string: `ESC \` ends it; anything else aborts it and starts a new sequence.
          if (ch === '\\') mode = 'text'
          else if (INTRO_7.has(ch)) enterString()
          else if (ch === ESC) mode = 'esc'
          else {
            out += ESC + ch
            mode = 'text'
          }
        }
      }
      return out
    }
  }
}
```

`src/core/watch-link/token-bucket.ts`:

```ts
// A per-viewer byte budget: a live link must not turn a flooding terminal into unbounded relay
// traffic. Past it, the viewer gets at most one keyframe per second instead of the stream.
export interface TokenBucket {
  take(n: number): boolean
}

export function createTokenBucket(o: { ratePerSec: number; burst: number; now: () => number }): TokenBucket {
  let tokens = o.burst
  let last = o.now()
  return {
    take(n) {
      const t = o.now()
      tokens = Math.min(o.burst, tokens + ((t - last) / 1000) * o.ratePerSec)
      last = t
      if (n > tokens) return false
      tokens -= n
      return true
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/watch-link && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-link
git commit -m "feat(watch-link): strip string-type escape sequences from a viewer's stream; byte budget"
```

---

### Task 5: Watcher policy (access hook + sink wrapper)

**Files:**
- Create: `src/core/watch-link/watcher-policy.ts`
- Test: `src/core/watch-link/watcher-policy.test.ts`

**Interfaces:**
- Consumes: `AccessDecision` (`src/core/relay/relay-host.ts`), `UiSink` (`src/core/ui-sink-registry.ts`), `IPC` factories `ptySize/ptyExit/ptyClosed/ptyRecycled/ptyResync`, `decodePtyData`/`encodePtyData` (`src/shared/rpc.ts`), Task 2 protocol, Task 4.
- Produces:
  - `WATCHER_REFUSAL = 'A live link can only watch this terminal.'`
  - `watcherAccess(kind: 'req' | 'cast', method: string, role: WatchLinkRole): AccessDecision`
  - `watcherEventAllowed(channel: string, sessionId: string | null): boolean`
  - `type PtyLifecycle = 'exit' | 'closed' | 'recycled'`
  - `WATCHER_BUFFER_LIMIT = 512 * 1024`, `WATCHER_RESUME_BELOW = 256 * 1024`
  - `interface WatcherSinkDeps { sessionId(): string | null; streaming(): boolean; filter: StreamFilter; bucket: TokenBucket; onOverBudget(): void; onLifecycle(kind: PtyLifecycle): void }`
  - `wrapWatcherSink(base: UiSink, d: WatcherSinkDeps): UiSink`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { IPC } from '../../shared/ipc'
import { encodePtyData, decodePtyData } from '../../shared/rpc'
import { WATCH_CHAT_CAST, WATCH_EVENT } from '../../shared/watch-link/protocol'
import { watcherAccess, watcherEventAllowed, wrapWatcherSink, WATCHER_BUFFER_LIMIT } from './watcher-policy'
import { createStreamFilter } from './stream-filter'
import { createTokenBucket } from './token-bucket'
import type { UiSink } from '../ui-sink-registry'

const channelValues = (): string[] =>
  Object.values(IPC).filter((v): v is string => typeof v === 'string')

describe('watcherAccess', () => {
  it('refuses every IPC channel as a request and as a cast, for both roles', () => {
    for (const ch of channelValues()) {
      for (const role of ['viewer', 'commenter'] as const) {
        expect(watcherAccess('req', ch, role).allow).toBe(false)
        expect(watcherAccess('cast', ch, role).allow).toBe(false)
      }
    }
  })
  it('allows the chat cast only for a commenter link, and never as a request', () => {
    expect(watcherAccess('cast', WATCH_CHAT_CAST, 'commenter')).toEqual({ allow: true })
    expect(watcherAccess('cast', WATCH_CHAT_CAST, 'viewer').allow).toBe(false)
    expect(watcherAccess('req', WATCH_CHAT_CAST, 'commenter').allow).toBe(false)
  })
})

describe('watcherEventAllowed', () => {
  it('passes watch:* and this session\'s pty lifecycle events only', () => {
    expect(watcherEventAllowed(WATCH_EVENT.meta, null)).toBe(true)
    expect(watcherEventAllowed(IPC.ptySize('s1'), 's1')).toBe(true)
    expect(watcherEventAllowed(IPC.ptyResync('s1'), 's1')).toBe(true)
    expect(watcherEventAllowed(IPC.ptySize('s2'), 's1')).toBe(false)
    expect(watcherEventAllowed(IPC.ptySize('s1'), null)).toBe(false)
  })
  it('refuses every broadcast channel in IPC', () => {
    for (const ch of channelValues()) expect(watcherEventAllowed(ch, 's1')).toBe(false)
  })
})

function harness(o: { streaming?: boolean; buffered?: number; rate?: number } = {}) {
  const text: string[] = []
  const bin: string[] = []
  const base: UiSink = {
    sendText: (j) => text.push(j),
    sendBinary: (b) => bin.push(decodePtyData(b)!.data),
    bufferedAmount: () => o.buffered ?? 0
  }
  const calls = { over: 0, life: [] as string[] }
  let streaming = o.streaming ?? true
  const sink = wrapWatcherSink(base, {
    sessionId: () => 's1',
    streaming: () => streaming,
    filter: createStreamFilter(),
    bucket: createTokenBucket({ ratePerSec: o.rate ?? 1e9, burst: o.rate ?? 1e9, now: () => 0 }),
    onOverBudget: () => { calls.over++ },
    onLifecycle: (k) => { calls.life.push(k) }
  })
  return { sink, text, bin, calls, setStreaming: (v: boolean) => { streaming = v } }
}
const ev = (channel: string, ...args: unknown[]) => JSON.stringify({ t: 'ev', channel, args })

describe('wrapWatcherSink', () => {
  it('drops broadcast events and another session\'s data', () => {
    const h = harness()
    h.sink.sendText(ev('canvas:mut', 'p1', {}))
    h.sink.sendText(ev('presence:sync', []))
    h.sink.sendBinary(encodePtyData('s2', 'other'))
    expect(h.text).toEqual([])
    expect(h.bin).toEqual([])
  })
  it('filters the stream and keeps the parser fed while not streaming', () => {
    const h = harness({ streaming: false })
    h.sink.sendBinary(encodePtyData('s1', 'x\x1b]52;c;c2Vj'))
    h.setStreaming(true)
    h.sink.sendBinary(encodePtyData('s1', 'cmV0\x07visible'))
    expect(h.bin).toEqual(['visible'])
  })
  it('reports lifecycle events for its session', () => {
    const h = harness()
    h.sink.sendText(ev(IPC.ptyExit('s1'), 0))
    h.sink.sendText(ev(IPC.ptyRecycled('s1'), { ready: true }))
    expect(h.calls.life).toEqual(['exit', 'recycled'])
  })
  it('goes over budget when the socket backs up or the bucket is empty', () => {
    const backed = harness({ buffered: WATCHER_BUFFER_LIMIT + 1 })
    backed.sink.sendBinary(encodePtyData('s1', 'a'))
    expect(backed.bin).toEqual([])
    expect(backed.calls.over).toBe(1)
    const poor = harness({ rate: 5 })
    poor.sink.sendBinary(encodePtyData('s1', 'this is more than five bytes'))
    expect(poor.calls.over).toBe(1)
  })
  it('keeps bufferedAmount pointing at the base sink', () => {
    expect(harness({ buffered: 42 }).sink.bufferedAmount?.()).toBe(42)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/watch-link/watcher-policy.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// The `watcher` relay role, as two RelayHostHooks pieces. It deliberately does NOT go through
// access-policy.ts's `decideAccess`: that function evaluates any non-editor role against the whole
// VIEW table (files, git, presence, board log), and a live link may reach none of it.
//  - Inbound: every request and cast is refused, except a Commenter link's chat cast.
//  - Outbound: only `watch:*` events and this viewer's own pty session; every broadcast is dropped
//    (a second layer: the watcher is also a QUIET client, absent from broadcast() and clientIds()).
import { IPC } from '../../shared/ipc'
import { decodePtyData, encodePtyData } from '../../shared/rpc'
import { WATCH_CHAT_CAST, WATCH_EVENT_PREFIX, type WatchLinkRole } from '../../shared/watch-link/protocol'
import type { AccessDecision } from '../relay/relay-host'
import type { UiSink } from '../ui-sink-registry'
import type { StreamFilter } from './stream-filter'
import type { TokenBucket } from './token-bucket'

export const WATCHER_REFUSAL = 'A live link can only watch this terminal.'
export const WATCHER_BUFFER_LIMIT = 512 * 1024
export const WATCHER_RESUME_BELOW = 256 * 1024

export function watcherAccess(kind: 'req' | 'cast', method: string, role: WatchLinkRole): AccessDecision {
  if (kind === 'cast' && method === WATCH_CHAT_CAST && role === 'commenter') return { allow: true }
  return { allow: false, message: WATCHER_REFUSAL }
}

export function watcherEventAllowed(channel: string, sessionId: string | null): boolean {
  if (channel.startsWith(WATCH_EVENT_PREFIX)) return true
  if (!sessionId) return false
  return (
    channel === IPC.ptySize(sessionId) ||
    channel === IPC.ptyExit(sessionId) ||
    channel === IPC.ptyClosed(sessionId) ||
    channel === IPC.ptyRecycled(sessionId) ||
    channel === IPC.ptyResync(sessionId)
  )
}

export type PtyLifecycle = 'exit' | 'closed' | 'recycled'

export interface WatcherSinkDeps {
  sessionId(): string | null
  /** False until the keyframe for the current session was sent, and while throttled. */
  streaming(): boolean
  filter: StreamFilter
  bucket: TokenBucket
  onOverBudget(): void
  onLifecycle(kind: PtyLifecycle): void
}

function channelOf(json: string): string | null {
  try {
    const m = JSON.parse(json) as { t?: unknown; channel?: unknown }
    return m && m.t === 'ev' && typeof m.channel === 'string' ? m.channel : null
  } catch {
    return null
  }
}

export function wrapWatcherSink(base: UiSink, d: WatcherSinkDeps): UiSink {
  return {
    sendText: (json) => {
      const channel = channelOf(json)
      const sid = d.sessionId()
      if (channel === null || !watcherEventAllowed(channel, sid)) return
      if (sid && channel === IPC.ptyExit(sid)) d.onLifecycle('exit')
      else if (sid && channel === IPC.ptyClosed(sid)) d.onLifecycle('closed')
      else if (sid && channel === IPC.ptyRecycled(sid)) d.onLifecycle('recycled')
      base.sendText(json)
    },
    sendBinary: (buf) => {
      const frame = decodePtyData(buf)
      const sid = d.sessionId()
      if (!frame || !sid || frame.sessionId !== sid) return
      // Always parse, even when nothing is forwarded (see stream-filter.ts).
      const text = d.filter.push(frame.data)
      if (!d.streaming() || !text) return
      if ((base.bufferedAmount?.() ?? 0) > WATCHER_BUFFER_LIMIT) {
        d.onOverBudget()
        return
      }
      const out = encodePtyData(sid, text)
      if (!d.bucket.take(out.length)) {
        d.onOverBudget()
        return
      }
      base.sendBinary(out)
    },
    bufferedAmount: () => base.bufferedAmount?.() ?? 0
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/watch-link && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-link
git commit -m "feat(watch-link): the watcher role refuses everything but chat and sees only its session"
```

---

### Task 6: Quiet, self-paced clients in the sink registry and both platforms

**Files:**
- Modify: `src/core/ui-sink-registry.ts`, `src/core/platform.ts`, `src/core/platform-fake.ts`, `src/core/pty-reap.ts`, `src/core/pty-manager.ts` (`reapTick`), `src/main/peer-registry.ts`, `src/main/platform-electron.ts`, `src/server/platform-server.ts`
- Test: `src/core/ui-sink-registry.watcher.test.ts`, `src/core/pty-reap.test.ts`, `src/server/platform-server.test.ts`, `src/main/peer-registry.test.ts`

**Interfaces:**
- Produces:
  - `interface SinkOptions { quiet?: boolean; selfPaced?: boolean }`; `UiSinkRegistry.register(id: number, sink: UiSink, opts?: SinkOptions): void`, `broadcastIds(): number[]`, `quietIds(): number[]` (`ids()` keeps returning every id).
  - `CorePlatform.quietClientIds?(): number[]` — ids that must count as live watchers but receive no broadcast.
  - `liveClientIds(p: Pick<CorePlatform, 'clientIds' | 'quietClientIds'>): Set<number>` in `pty-reap.ts`.
  - `registerPeerSink(id: number, sink: UiSink, opts?: SinkOptions)`; `ServerPlatform.attach(sink, opts?: { owner?: boolean } & SinkOptions)`.

- [ ] **Step 1: Write the failing tests**

`src/core/ui-sink-registry.watcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { UiSinkRegistry, type UiSink } from './ui-sink-registry'
import { IPC } from '../shared/ipc'

const sink = (buffered = 0): UiSink & { bin: number; text: number } => {
  const s = { bin: 0, text: 0, sendText: () => { s.text++ }, sendBinary: () => { s.bin++ }, bufferedAmount: () => buffered }
  return s
}

describe('quiet and self-paced clients', () => {
  it('a quiet client is in ids() and quietIds() but not broadcastIds()', () => {
    const r = new UiSinkRegistry()
    r.register(1, sink())
    r.register(2, sink(), { quiet: true })
    expect(r.ids()).toEqual([1, 2])
    expect(r.broadcastIds()).toEqual([1])
    expect(r.quietIds()).toEqual([2])
    r.unregister(2)
    expect(r.quietIds()).toEqual([])
  })

  it('a self-paced client is never paused, dropped or resynced by the registry', () => {
    const r = new UiSinkRegistry()
    const flow = vi.fn()
    const resync = vi.fn(async () => 'SCREEN')
    r.setFlowController(flow)
    r.setResyncProvider(resync)
    const s = sink(50_000_000)
    r.register(7, s, { selfPaced: true })
    for (let i = 0; i < 5; i++) r.sendTo(7, IPC.ptyData('s1'), 'x')
    expect(s.bin).toBe(5)
    expect(flow).not.toHaveBeenCalled()
    expect(resync).not.toHaveBeenCalled()
  })

  it('an ordinary client past the high water still takes a pause ticket', () => {
    const r = new UiSinkRegistry()
    const flow = vi.fn()
    r.setFlowController(flow)
    r.register(8, sink(2_000_000))
    r.sendTo(8, IPC.ptyData('s1'), 'x')
    expect(flow).toHaveBeenCalledWith(8, 's1', false, 'socket')
  })
})
```

Append to `src/core/pty-reap.test.ts`:

```ts
import { liveClientIds } from './pty-reap'

describe('liveClientIds', () => {
  it('counts quiet clients as watchers', () => {
    expect(liveClientIds({ clientIds: () => [1], quietClientIds: () => [9] })).toEqual(new Set([1, 9]))
    expect(liveClientIds({ clientIds: () => [1] })).toEqual(new Set([1]))
  })
})
```

Append to `src/server/platform-server.test.ts` (use that file's existing `ServerPlatform` construction):

```ts
it('a quiet attach gets addressed sends only, and counts as a quiet client', () => {
  const p = makePlatform() // construct it exactly as this file's other tests do (copy their `new ServerPlatform(...)` line into a local `makePlatform`)
  const got: string[] = []
  const loud = p.attach({ sendText: (j) => got.push('loud ' + j), sendBinary: () => {} }, { owner: true })
  const quiet = p.attach({ sendText: (j) => got.push('quiet ' + j), sendBinary: () => {} }, { quiet: true, selfPaced: true })
  p.broadcast('presence:sync', [])
  expect(got.filter((g) => g.startsWith('quiet'))).toEqual([])
  expect(p.clientIds()).toEqual([loud])
  expect(p.quietClientIds()).toEqual([quiet])
  p.sendTo(quiet, 'watch:meta', {})
  expect(got.some((g) => g.startsWith('quiet'))).toBe(true)
})
```

Append to `src/main/peer-registry.test.ts`:

```ts
it('passes sink options through to the registry', () => {
  registerPeerSink(4242, { sendText: () => {}, sendBinary: () => {} }, { quiet: true })
  expect(peerRegistry().quietIds()).toContain(4242)
  expect(peerRegistry().broadcastIds()).not.toContain(4242)
  peerRegistry().unregister(4242)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/ui-sink-registry.watcher.test.ts src/core/pty-reap.test.ts src/server/platform-server.test.ts src/main/peer-registry.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement the registry options**

In `src/core/ui-sink-registry.ts`:

```ts
/** How the registry treats one client. Both default to the historical behaviour.
 *  - `quiet`: never enumerated for a broadcast (`broadcastIds`) — reachable by an addressed
 *    `sendTo` only. A live link's viewer is one: canvas ops, presence and agent status are not
 *    its business. `ids()` still lists it, and `quietIds()` names it, because the pty reaper must
 *    count it as watching (pty-reap.ts `liveClientIds`).
 *  - `selfPaced`: the sink paces itself. The registry takes no pause ticket for it (a stranger's
 *    slow socket must never freeze the owner's terminal) and never drops or resyncs its output
 *    (the watcher's stream filter must see every frame — src/core/watch-link/watcher-policy.ts). */
export interface SinkOptions {
  quiet?: boolean
  selfPaced?: boolean
}
```

Add a field `private options = new Map<number, SinkOptions>()`. Change `register`:

```ts
register(id: number, sink: UiSink, opts: SinkOptions = {}): void {
  this.sinks.set(id, sink)
  if (opts.quiet || opts.selfPaced) this.options.set(id, opts)
  else this.options.delete(id)
}
broadcastIds(): number[] {
  if (this.options.size === 0) return this.ids()
  return [...this.sinks.keys()].filter((id) => !this.options.get(id)?.quiet)
}
quietIds(): number[] {
  return [...this.options.entries()].filter(([id, o]) => o.quiet && this.sinks.has(id)).map(([id]) => id)
}
```

In `unregister` add `this.options.delete(id)` next to `this.failures.delete(id)`; do the same wherever `noteSinkFailure` removes a sink. In `sendTo`'s `PTY_DATA_PREFIX` branch, right after `const sessionId = …`:

```ts
if (this.options.get(uiId)?.selfPaced) {
  this.deliver(uiId, () => sink.sendBinary(encodePtyData(sessionId, String(args[0] ?? ''))))
  return
}
```

- [ ] **Step 4: Implement the platforms and the reaper**

`src/core/platform.ts` — add to `CorePlatform` after `clientIds()`:

```ts
  /** Clients that receive NO broadcast and are absent from `clientIds()` (a live link's viewer),
   *  but still count as watching a session they subscribe to. Only the pty reaper reads it. */
  quietClientIds?(): number[]
```

`src/core/platform-fake.ts` — add `quietClients: number[]` to `FakePlatform`, initialise `quietClients: []`, and `quietClientIds: () => f.quietClients`.

`src/core/pty-reap.ts`:

```ts
import type { CorePlatform } from './platform'

/** Every client that counts as watching: the ordinary ones and the quiet ones (a live link's
 *  viewer). Without the quiet ones a session only a viewer holds is released after the idle
 *  window, and `releaseClient` sends that viewer no event at all. */
export function liveClientIds(p: Pick<CorePlatform, 'clientIds' | 'quietClientIds'>): Set<number> {
  return new Set([...p.clientIds(), ...(p.quietClientIds?.() ?? [])])
}
```

In `src/core/pty-manager.ts` `reapTick`, replace `const live = new Set(platform().clientIds())` with `const live = liveClientIds(platform())` (import it from `./pty-reap`).

`src/main/peer-registry.ts`:

```ts
export function registerPeerSink(id: number, sink: UiSink, opts?: SinkOptions): void {
  registry.register(id, sink, opts)
}
```

(`import type { SinkOptions } from '../core/ui-sink-registry'`.)

`src/main/platform-electron.ts`: in `broadcast`, iterate `peers.broadcastIds()` instead of `peers.ids()`; `clientIds: () => [...mainWindowClientIds(), ...peerRegistry().broadcastIds()]`; add `quietClientIds: () => peerRegistry().quietIds()`.

`src/server/platform-server.ts`: `broadcast` iterates `this.registry.broadcastIds()`; `clientIds()` returns `this.registry.broadcastIds()`; add `quietClientIds(): number[] { return this.registry.quietIds() }`; change `attach`:

```ts
attach(sink: UiSink, opts: { owner?: boolean } & SinkOptions = {}): number {
  const id = this.nextUiId++
  this.registry.register(id, sink, { quiet: opts.quiet, selfPaced: opts.selfPaced })
  if (opts.owner === true) this.owners.add(id)
  return id
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/core/ui-sink-registry src/core/pty-reap.test.ts src/server/platform-server.test.ts src/main/peer-registry.test.ts src/core/canvas-sync.test.ts && npm run typecheck`
Expected: PASS (canvas-sync's own tests still pass: it now skips quiet clients by construction).

- [ ] **Step 6: Commit**

```bash
git add src/core src/main/peer-registry.ts src/main/platform-electron.ts src/server/platform-server.ts src/main/peer-registry.test.ts src/server/platform-server.test.ts
git commit -m "feat(core): quiet and self-paced clients — no broadcast, no pause ticket, still watching"
```

---

### Task 7: pty seams — visible-only capture and a watcher join

**Files:**
- Modify: `src/core/remote-ssh/control-master.ts`, `src/core/pty-manager.ts`
- Create: `src/core/watch-link/capture-route.ts`
- Test: `src/core/remote-ssh/control-master.test.ts` (append), `src/core/watch-link/capture-route.test.ts`

**Interfaces:**
- Produces:
  - `remoteCaptureVisibleArgs(conn: SshConnection, controlPath: string, sessionId: string): string[]` (like `remoteCapturePaneArgs` without `-S`)
  - `visibleCaptureRoute(s: { sessionHost?: unknown; nativeWindowsPane?: unknown; sshRemote?: unknown; tmuxBacked?: boolean }, tmuxAvailable: boolean): 'none' | 'ssh' | 'tmux'`
  - `PtyManager.captureVisible(sessionId: string): Promise<string>` (never history; `''` when unavailable)
  - `PtyManager.joinAsWatcher(clientId: number, opts: { persistKey: string; viewerId: string; cols: number; rows: number; sshRemote?: PtyCreateOptions['sshRemote']; requireRemote?: boolean }): Promise<PtyCreateResult>` (forces `joinOnly: true`, `sizeVote: false`)
  - `PtyManager.watchSizeFor(persistKey: string): { cols: number; rows: number } | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `src/core/remote-ssh/control-master.test.ts`:

```ts
import { remoteCaptureVisibleArgs } from './control-master'

it('the visible capture never asks for history', () => {
  const args = remoteCaptureVisibleArgs({ host: 'h', user: 'u' } as never, '/tmp/cp', 'nt-abc')
  const cmd = args.join(' ')
  expect(cmd).toContain('capture-pane -p -e -t nt-abc')
  expect(cmd).not.toMatch(/-S\b/)
})
```

`src/core/watch-link/capture-route.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { visibleCaptureRoute } from './capture-route'

describe('visibleCaptureRoute', () => {
  it('never routes to a capture that returns history', () => {
    expect(visibleCaptureRoute({ sessionHost: {} }, true)).toBe('none')
    expect(visibleCaptureRoute({ nativeWindowsPane: {} }, true)).toBe('none')
    expect(visibleCaptureRoute({ sshRemote: {} }, true)).toBe('ssh')
    expect(visibleCaptureRoute({ tmuxBacked: true }, true)).toBe('tmux')
    expect(visibleCaptureRoute({ tmuxBacked: true }, false)).toBe('none')
    expect(visibleCaptureRoute({ tmuxBacked: false }, true)).toBe('none')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/remote-ssh/control-master.test.ts src/core/watch-link/capture-route.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/remote-ssh/control-master.ts`, beside `remoteCapturePaneArgs`:

```ts
/** The VISIBLE screen of a remote session, with SGR, and nothing above it. A live link's keyframe
 *  must never carry history; `remoteCapturePaneArgs` always adds `-S`. */
export function remoteCaptureVisibleArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(conn, controlPath, tmuxCmd(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t ${sessionId}`))
}
```

`src/core/watch-link/capture-route.ts`:

```ts
// Which capture gives a live link's keyframe the VISIBLE screen and nothing more. The session host's
// capture(false) is ~200 lines of scrollback and a direct Windows pane has no visible-only read, so
// both get no keyframe (the viewer starts from the live stream) rather than history.
export function visibleCaptureRoute(
  s: { sessionHost?: unknown; nativeWindowsPane?: unknown; sshRemote?: unknown; tmuxBacked?: boolean },
  tmuxAvailable: boolean
): 'none' | 'ssh' | 'tmux' {
  if (s.sessionHost || s.nativeWindowsPane) return 'none'
  if (s.sshRemote) return 'ssh'
  return tmuxAvailable && s.tmuxBacked ? 'tmux' : 'none'
}
```

`src/core/pty-manager.ts` — add public methods (near `captureForResync`):

```ts
  /** A live link's keyframe: the visible screen only, never history (capture-route.ts). */
  async captureVisible(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    const key = session ? session.persistKey ?? session.indexKey : undefined
    if (!session || !key) return ''
    const route = visibleCaptureRoute(session, !!this.tmuxPath)
    try {
      if (route === 'ssh' && session.sshRemote) {
        const ssh = findSsh()
        if (!ssh) return ''
        const { stdout } = await runAsync(
          ssh,
          remoteCaptureVisibleArgs(session.sshRemote.conn, session.sshRemote.controlPath, sessionName(key)),
          { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }
        )
        return stdout
      }
      if (route === 'tmux' && this.tmuxPath) {
        const { stdout } = await runAsync(
          this.tmuxPath,
          ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-t', sessionName(key)],
          { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 }
        )
        return stdout
      }
    } catch {
      return ''
    }
    return ''
  }

  /** Join a node's RUNNING session as a live link's viewer: never spawns, never votes on size. */
  joinAsWatcher(
    clientId: ClientId,
    opts: { persistKey: string; viewerId: string; cols: number; rows: number; sshRemote?: PtyCreateOptions['sshRemote']; requireRemote?: boolean }
  ): Promise<PtyCreateResult> {
    return this.create(clientId, { ...opts, joinOnly: true, sizeVote: false })
  }

  /** The size a live link should report for a node: what the pty is, or was when released. */
  watchSizeFor(persistKey: string): { cols: number; rows: number } | undefined {
    const live = this.liveSessionForPersistKey(persistKey)
    const size = live?.backendSize ?? live?.appliedSize ?? this.released.get(persistKey)?.size
    return size ? { cols: size.cols, rows: size.rows } : undefined
  }
```

Imports: `visibleCaptureRoute` from `./watch-link/capture-route`, `remoteCaptureVisibleArgs` from `./remote-ssh/control-master` (next to the existing `remoteCapturePaneArgs` import). If `backendSize`/`released` have different names or shapes in this file, use what `applySize`/`applySessionHostSize` read — the typecheck in Step 4 is the gate.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/remote-ssh/control-master.test.ts src/core/watch-link && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(pty): a visible-only capture and a join-only, non-voting watcher join"
```

---

### Task 8: `hosted-scheduler` gains `maxBridged`

**Files:**
- Modify: `src/core/relay/hosted-scheduler.ts`
- Test: `src/core/relay/hosted-scheduler.test.ts` (append)

**Interfaces:**
- Produces: `SchedulerDeps.maxBridged?: number` — no idle listener is opened while `bridged >= maxBridged`; when a bridged session ends, the usual `top()` reopens one.

- [ ] **Step 1: Write the failing test**

Append (build deps the way that file's other tests do; this is self-contained):

```ts
it('opens no idle listener while maxBridged sessions are bridged, and reopens when one ends', async () => {
  const opened: { ev: { onBridged(): void; onClose(): void }; closed: boolean }[] = []
  const s = createHostedScheduler(
    {
      mint: async () => ({ ok: true, pairingToken: 't', hostId: 'h', ttlMs: 120_000 }),
      open: (_t, ev) => {
        const l = { ev, closed: false }
        opened.push(l)
        return { bridged: false, close: () => { l.closed = true } }
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      maxBridged: 2
    },
    () => Date.now()
  )
  s.start()
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  opened[0].ev.onBridged()
  await vi.waitFor(() => expect(opened).toHaveLength(2))
  opened[1].ev.onBridged()
  await new Promise((r) => setTimeout(r, 30))
  expect(opened).toHaveLength(2)
  opened[0].ev.onClose()
  await vi.waitFor(() => expect(opened).toHaveLength(3))
  s.stop()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/core/relay/hosted-scheduler.test.ts -t maxBridged` — Expected: FAIL (a third listener opens after the second bridge).

- [ ] **Step 3: Implement**

In `SchedulerDeps` add:

```ts
  /** Open no idle listener while this many sessions are bridged (a live link's viewer cap). The
   *  broker closes a client that finds no idle host listener, so the cap needs no other code. */
  maxBridged?: number
```

Next to `idleCount()` add `const bridgedCount = (): number => { let n = 0; for (const e of live) if (e.bridged) n++; return n }` (use the same collection `idleCount` iterates). In `top()`'s guard:

```ts
if (state !== 'running' || opening || retry !== null || idleCount() >= 1) return
if (deps.maxBridged !== undefined && bridgedCount() >= deps.maxBridged) return
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/relay/hosted-scheduler.test.ts && npm run typecheck` — Expected: PASS (all old tests too).

- [ ] **Step 5: Commit**

```bash
git add src/core/relay/hosted-scheduler.ts src/core/relay/hosted-scheduler.test.ts
git commit -m "feat(relay): hosted-scheduler can cap bridged sessions"
```

---

### Task 9: Persisted records (`WatchLinkStore`)

**Files:**
- Create: `src/core/watch-link/store.ts`
- Test: `src/core/watch-link/store.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` (`src/core/fs-atomic.ts`), `LINK_ID_RE`, `WatchLinkRole`.
- Produces:
  - `interface WatchLinkRecord { linkId: string; nodeId: string; role: WatchLinkRole; label: string; title: string; createdAt: number; expiresAt: number; secret: Uint8Array }`
  - `type SaveOutcome = 'saved' | 'memory-only' | 'failed'`
  - `class WatchLinkStore { constructor(o: { file: string; seal?: (b: Buffer) => Buffer; unseal?: (b: Buffer) => Buffer }); load(): Promise<WatchLinkRecord[]>; save(records: readonly WatchLinkRecord[]): Promise<SaveOutcome> }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchLinkStore, type WatchLinkRecord } from './store'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const file = () => { const d = mkdtempSync(join(tmpdir(), 'wl-')); dirs.push(d); return join(d, 'watch-links.json') }
const rec = (over: Partial<WatchLinkRecord> = {}): WatchLinkRecord => ({
  linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'n1', role: 'viewer', label: 'Ada', title: 'build',
  createdAt: 1, expiresAt: Date.now() + 3600_000, secret: new Uint8Array(32).fill(7), ...over
})
const seal = (b: Buffer) => Buffer.from(b.toString('hex'))
const unseal = (b: Buffer) => Buffer.from(b.toString(), 'hex')

describe('WatchLinkStore', () => {
  it('round-trips sealed records and writes 0600', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal, unseal })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
    expect(readFileSync(f, 'utf8')).not.toContain(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'))
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it('stores raw secrets where the platform has no seal (Server Edition)', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f })
    expect(await s.save([rec()])).toBe('saved')
    expect(await s.load()).toEqual([rec()])
  })

  it('writes an empty file and reports memory-only when sealing throws', async () => {
    const f = file()
    const s = new WatchLinkStore({ file: f, seal: () => { throw new Error('locked') }, unseal })
    expect(await s.save([rec()])).toBe('memory-only')
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ v: 1, links: [] })
  })

  it('an unsealable secret is skipped, and a desktop never accepts a raw one', async () => {
    const f = file()
    await new WatchLinkStore({ file: f }).save([rec()]) // raw on disk
    const desktop = new WatchLinkStore({ file: f, seal, unseal: () => { throw new Error('keychain reset') } })
    expect(await desktop.load()).toEqual([])
    const f2 = file()
    await new WatchLinkStore({ file: f2, seal, unseal }).save([rec()])
    expect(await new WatchLinkStore({ file: f2, seal, unseal: () => { throw new Error('reset') } }).load()).toEqual([])
  })

  it('tolerates a missing or corrupt file and drops malformed entries', async () => {
    const f = file()
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, '{nope')
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
    writeFileSync(f, JSON.stringify({ v: 1, links: [{ linkId: 'bad', nodeId: 'n', role: 'viewer', secret: 'AA==', sealed: false }] }))
    expect(await new WatchLinkStore({ file: f }).load()).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/core/watch-link/store.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// Active live links survive an app restart (spec D8). The secret is sealed through the platform's
// secret seam: Electron safeStorage on the desktop, and ABSENT on the Server Edition by design
// (headless, no keychain: raw bytes in a 0600 file, the same rule as its node secrets). On the
// desktop there is no plaintext fallback: if sealing throws, the file is written EMPTY and links
// live in memory for this run; a raw secret found on a desktop is refused, never adopted.
import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../fs-atomic'
import { LINK_ID_RE } from '../../shared/watch-link/link'
import type { WatchLinkRole } from '../../shared/watch-link/protocol'

export interface WatchLinkRecord {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: Uint8Array
}
export type SaveOutcome = 'saved' | 'memory-only' | 'failed'

interface FileEntry {
  linkId: string
  nodeId: string
  role: WatchLinkRole
  label: string
  title: string
  createdAt: number
  expiresAt: number
  secret: string
  sealed: boolean
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export class WatchLinkStore {
  constructor(private readonly o: { file: string; seal?: (b: Buffer) => Buffer; unseal?: (b: Buffer) => Buffer }) {}

  async load(): Promise<WatchLinkRecord[]> {
    let body: { links?: unknown }
    try {
      body = JSON.parse((await fs.readFile(this.o.file, 'utf8')).replace(/\r\n/g, '\n'))
    } catch {
      return []
    }
    const out: WatchLinkRecord[] = []
    for (const e of Array.isArray(body?.links) ? (body.links as Partial<FileEntry>[]) : []) {
      if (!e || !str(e.linkId, 22) || !LINK_ID_RE.test(e.linkId) || !str(e.nodeId, 200) || !e.nodeId) continue
      if (e.role !== 'viewer' && e.role !== 'commenter') continue
      if (!str(e.label, 40) || !str(e.title, 80) || !num(e.createdAt) || !num(e.expiresAt) || typeof e.secret !== 'string') continue
      const secret = this.readSecret(e.secret, e.sealed === true)
      if (!secret || secret.length !== 32) continue
      out.push({ linkId: e.linkId, nodeId: e.nodeId, role: e.role, label: e.label, title: e.title, createdAt: e.createdAt, expiresAt: e.expiresAt, secret })
    }
    return out
  }

  private readSecret(b64: string, sealed: boolean): Uint8Array | null {
    try {
      const raw = Buffer.from(b64, 'base64')
      if (sealed) return this.o.unseal ? new Uint8Array(this.o.unseal(raw)) : null
      // A desktop (it can seal) never adopts a raw secret it finds on disk.
      return this.o.seal ? null : new Uint8Array(raw)
    } catch {
      return null
    }
  }

  async save(records: readonly WatchLinkRecord[]): Promise<SaveOutcome> {
    let links: FileEntry[]
    let outcome: SaveOutcome = 'saved'
    try {
      links = records.map((r) => ({
        linkId: r.linkId, nodeId: r.nodeId, role: r.role, label: r.label, title: r.title,
        createdAt: r.createdAt, expiresAt: r.expiresAt,
        secret: (this.o.seal ? this.o.seal(Buffer.from(r.secret)) : Buffer.from(r.secret)).toString('base64'),
        sealed: !!this.o.seal
      }))
    } catch {
      links = []
      outcome = 'memory-only'
    }
    try {
      await writeFileAtomic(this.o.file, JSON.stringify({ v: 1, links }), { mode: 0o600 })
      return outcome
    } catch {
      return 'failed'
    }
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/core/watch-link/store.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-link/store.ts src/core/watch-link/store.test.ts
git commit -m "feat(watch-link): persist active links, sealed, never adopting a raw secret on the desktop"
```

---

### Task 10: The API client

**Files:**
- Create: `src/core/watch-link/api.ts`
- Test: `src/core/watch-link/api.test.ts`

**Interfaces:**
- Consumes: Plan 1's HTTP contract; `tokenTtlMs` and `MintResult` (`src/core/relay/host-token.ts`).
- Produces:
  - `type CreateError = 'not-entitled' | 'limit-active' | 'limit-daily' | 'rate-limited' | 'license-check' | 'bad-request' | 'network'`
  - `type HostTokenResult = MintResult | { ok: false; kind: 'gone'; reason: 'revoked' | 'expired' }`
  - `interface WatchLinkApi { create(entitlement: string, joinKeyHash: string, ttlSeconds: number): Promise<{ ok: true; linkId: string; expiresAt: number } | { ok: false; error: CreateError }>; hostToken(linkId: string, entitlement: string): Promise<HostTokenResult>; status(linkId: string, entitlement: string): Promise<'live' | 'revoked' | 'expired' | 'unknown'>; revoke(linkId: string, entitlement: string): Promise<boolean>; revokeAll(entitlement: string): Promise<boolean> }` — `expiresAt` in LOCAL epoch ms, clock-corrected with the `Date` header.
  - `createWatchLinkApi(o: { apiBase: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WatchLinkApi`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { createWatchLinkApi } from './api'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function api(reply: (url: string, init: RequestInit) => Response | Promise<Response>, now = 1_000_000) {
  const calls: { url: string; body: unknown }[] = []
  const a = createWatchLinkApi({
    apiBase: 'https://api.test/',
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return reply(url, init) }) as typeof fetch
  })
  return { a, calls }
}

describe('createWatchLinkApi', () => {
  it('create posts the hash and corrects expiry to the local clock', async () => {
    const serverNow = Date.parse('Tue, 29 Sep 2026 10:00:00 GMT')
    const { a, calls } = api(() => res(200, { linkId: 'L', expiresAt: serverNow / 1000 + 3600 }, { date: new Date(serverNow).toUTCString() }), 5_000)
    const r = await a.create('ent', 'ab'.repeat(32), 3600)
    expect(calls[0]).toEqual({ url: 'https://api.test/v1/watch-links', body: { entitlement: 'ent', joinKeyHash: 'ab'.repeat(32), ttlSeconds: 3600 } })
    expect(r).toEqual({ ok: true, linkId: 'L', expiresAt: 5_000 + 3_600_000 })
  })

  it('maps create errors', async () => {
    const cases: [Response, string][] = [
      [res(402, { error: 'not_entitled' }), 'not-entitled'],
      [res(403, { error: 'companion_device' }), 'not-entitled'],
      [res(429, { error: 'rate_limited', scope: 'active_links' }), 'limit-active'],
      [res(429, { error: 'rate_limited', scope: 'license' }), 'limit-daily'],
      [res(429, { error: 'rate_limited', scope: 'ip' }), 'rate-limited'],
      [res(503, { error: 'license_check_unavailable' }), 'license-check'],
      [res(400, { error: 'bad_ttl' }), 'bad-request'],
      [res(500, null), 'network']
    ]
    for (const [r, want] of cases) expect(await api(() => r.clone()).a.create('e', 'h', 3600)).toEqual({ ok: false, error: want })
    expect(await api(() => { throw new Error('offline') }).a.create('e', 'h', 3600)).toEqual({ ok: false, error: 'network' })
  })

  it('hostToken maps 410 to gone and other refusals to the scheduler kinds', async () => {
    expect(await api(() => res(410, { error: 'gone', reason: 'revoked' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'gone', reason: 'revoked' })
    expect(await api(() => res(404, { error: 'not_found' })).a.hostToken('L', 'e')).toMatchObject({ ok: false, kind: 'refused' })
    expect(await api(() => res(429, {}, { 'retry-after': '60' })).a.hostToken('L', 'e')).toEqual({ ok: false, kind: 'rate-limited', status: 429, retryAfterMs: 60_000 })
    const ok = await api(() => res(200, { pairingToken: 'P', exp: 1_000 + 120 }, { date: new Date(1_000_000).toUTCString() })).a.hostToken('L', 'e')
    expect(ok).toMatchObject({ ok: true, pairingToken: 'P' })
  })

  it('status, revoke and revokeAll', async () => {
    expect(await api(() => res(200, { state: 'revoked' })).a.status('L', 'e')).toBe('revoked')
    expect(await api(() => res(500, null)).a.status('L', 'e')).toBe('unknown')
    const r = api(() => res(204, null))
    expect(await r.a.revoke('L', 'e')).toBe(true)
    expect(r.calls[0].url).toBe('https://api.test/v1/watch-links/L/revoke')
    expect(await api(() => res(204, null)).a.revokeAll('e')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
// HTTP client for the live-link routes (nodeterm-server, Plan 1). Credentials ride the JSON body
// over TLS, never argv. Every call is bounded by a timeout that also covers the body read.
import { tokenTtlMs, type MintResult } from '../relay/host-token'

export type CreateError = 'not-entitled' | 'limit-active' | 'limit-daily' | 'rate-limited' | 'license-check' | 'bad-request' | 'network'
export type HostTokenResult = MintResult | { ok: false; kind: 'gone'; reason: 'revoked' | 'expired' }
export interface WatchLinkApi {
  create(entitlement: string, joinKeyHash: string, ttlSeconds: number): Promise<{ ok: true; linkId: string; expiresAt: number } | { ok: false; error: CreateError }>
  hostToken(linkId: string, entitlement: string): Promise<HostTokenResult>
  status(linkId: string, entitlement: string): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  revoke(linkId: string, entitlement: string): Promise<boolean>
  revokeAll(entitlement: string): Promise<boolean>
}

export function createWatchLinkApi(o: { apiBase: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): WatchLinkApi {
  const base = o.apiBase.replace(/\/+$/, '')
  const now = o.now ?? Date.now
  const f = o.fetch ?? fetch

  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null; date: string | null; retryAfter: string | null } | null> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 8000)
    try {
      const r = await f(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      let json: Record<string, unknown> | null = null
      if (r.status !== 204) {
        try {
          json = (await r.json()) as Record<string, unknown>
        } catch {
          json = null
        }
      }
      return { status: r.status, json, date: r.headers.get('date'), retryAfter: r.headers.get('retry-after') }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
  const path = (id: string, verb: string) => `/v1/watch-links/${encodeURIComponent(id)}/${verb}`

  return {
    async create(entitlement, joinKeyHash, ttlSeconds) {
      const r = await post('/v1/watch-links', { entitlement, joinKeyHash, ttlSeconds })
      if (!r) return { ok: false, error: 'network' }
      if (r.status === 200 && typeof r.json?.linkId === 'string' && typeof r.json.expiresAt === 'number') {
        return { ok: true, linkId: r.json.linkId, expiresAt: now() + tokenTtlMs(r.json.expiresAt, r.date, now()) }
      }
      if (r.status === 402 || r.status === 403) return { ok: false, error: 'not-entitled' }
      if (r.status === 429) {
        const scope = r.json?.scope
        return { ok: false, error: scope === 'active_links' ? 'limit-active' : scope === 'license' ? 'limit-daily' : 'rate-limited' }
      }
      if (r.status === 503) return { ok: false, error: 'license-check' }
      if (r.status === 400) return { ok: false, error: 'bad-request' }
      return { ok: false, error: 'network' }
    },
    async hostToken(linkId, entitlement) {
      const r = await post(path(linkId, 'host-token'), { entitlement })
      if (!r) return { ok: false, kind: 'network' }
      if (r.status === 200 && typeof r.json?.pairingToken === 'string') {
        const exp = typeof r.json.exp === 'number' ? r.json.exp : 0
        return { ok: true, pairingToken: r.json.pairingToken, hostId: '', ttlMs: tokenTtlMs(exp, r.date, now()) }
      }
      if (r.status === 410) return { ok: false, kind: 'gone', reason: r.json?.reason === 'expired' ? 'expired' : 'revoked' }
      if (r.status === 429) {
        const ra = Number(r.retryAfter)
        return { ok: false, kind: 'rate-limited', status: 429, ...(ra > 0 ? { retryAfterMs: ra * 1000 } : {}) }
      }
      if (r.status === 402 || r.status === 403 || r.status === 404) return { ok: false, kind: 'refused', status: r.status }
      return { ok: false, kind: 'network', status: r.status }
    },
    async status(linkId, entitlement) {
      const r = await post(path(linkId, 'status'), { entitlement })
      const s = r?.status === 200 ? r.json?.state : null
      return s === 'live' || s === 'revoked' || s === 'expired' ? s : 'unknown'
    },
    async revoke(linkId, entitlement) {
      return (await post(path(linkId, 'revoke'), { entitlement }))?.status === 204
    },
    async revokeAll(entitlement) {
      return (await post('/v1/watch-links/revoke-all', { entitlement }))?.status === 204
    }
  }
}
```

- [ ] **Step 4: Run to verify pass** — PASS + typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-link/api.ts src/core/watch-link/api.test.ts
git commit -m "feat(watch-link): the API client for create, host tokens, status and revoke"
```

---

### Task 11: The link host (listeners, viewer sessions, keyframes, chat, kick)

**Files:**
- Create: `src/core/watch-link/link-host.ts`
- Test: `src/core/watch-link/link-host.test.ts`

**Interfaces:**
- Consumes: `connectRelayHost`, `PeerAttach`, `RelayHostSession` (`src/core/relay/relay-host.ts`), `createHostedScheduler`, `SchedulerStatus`, `Listener` (`hosted-scheduler.ts`), `RelayTransport`, Tasks 1–10.
- Produces:
  - `interface WatchPty { join(clientId: number, nodeId: string, viewerId: string): Promise<{ sessionId: string; cols: number; rows: number; altScreen: boolean } | null>; leave(clientId: number, sessionId: string, viewerId: string): void; captureVisible(sessionId: string): Promise<string> }`
  - `interface QuietClients { attach(sink: UiSink): number; detach(id: number): void }`
  - `interface LinkHostDeps { relayUrl: string; mint(): Promise<HostTokenResult>; status(): Promise<'live' | 'revoked' | 'expired' | 'unknown'>; clients: QuietClients; pty: WatchPty; transport?: () => RelayTransport; now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; onChange(): void; onChat(msg: WatchChatMessage): void; onViewerJoined(count: number): void; onGone(reason: 'revoked' | 'expired'): void }`
  - `type LinkRuntimeStatus = 'live' | 'reconnecting' | 'refused'`; `interface LinkViewer { viewerId: string; name: string | null; joinedAt: number }`
  - `interface LinkHost { start(): void; stop(reason: WatchLinkEndReason): void; kick(viewerId: string): boolean; postSharerChat(text: string): WatchChatMessage | null; chatHistory(): WatchChatMessage[]; status(): LinkRuntimeStatus; viewers(): LinkViewer[] }`
  - `createLinkHost(record: WatchLinkRecord, deps: LinkHostDeps): LinkHost`
  - constants `MAX_VIEWERS_PER_LINK = 10`, `FULL_STATUS_POLL_MS = 300_000`, `CHAT_MIN_INTERVAL_MS = 2_000`, `CHAT_HISTORY_MAX = 200`, `KEYFRAME_MIN_INTERVAL_MS = 1_000`, `REJOIN_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000]`

- [ ] **Step 1: Write the failing integration test**

`src/core/watch-link/link-host.test.ts` — the REAL relay host and scheduler, the REAL browser client:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import nacl from 'tweetnacl'
import { transportPair } from '../relay/transport-pair'
import { connectRelay } from '../relay/relay-socket'
import { publicKeyToB64 } from '../relay/e2ee'
import { encodePtyData, parseRpcMessage } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import { connectWatchClient } from '../../shared/watch-link/client'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'
import { WATCH_EVENT } from '../../shared/watch-link/protocol'
import { createLinkHost, type WatchPty } from './link-host'
import type { WatchLinkRecord } from './store'
import type { UiSink } from '../ui-sink-registry'
import type { RelayTransport } from '../relay/relay-socket'

const hosts: { stop(r: 'revoked'): void }[] = []
afterEach(() => { for (const h of hosts.splice(0)) h.stop('revoked') })

function setup(o: { role?: 'viewer' | 'commenter'; join?: WatchPty['join']; buffered?: () => number } = {}) {
  const secret = nacl.randomBytes(32)
  const record: WatchLinkRecord = { linkId: 'AbCdEfGhIjKlMnOpQrStUv', nodeId: 'node-1', role: o.role ?? 'viewer', label: 'Ada', title: 'build', createdAt: 0, expiresAt: Date.now() + 3600_000, secret }
  const peers: RelayTransport[] = []
  const sinks = new Map<number, UiSink>()
  let nextId = 1_000_000
  const left: string[] = []
  const pty: WatchPty = {
    join: o.join ?? (async () => ({ sessionId: 's1', cols: 100, rows: 30, altScreen: true })),
    leave: (_c, sid, vid) => { left.push(`${sid}/${vid}`) },
    captureVisible: async () => 'SCREEN'
  }
  const chats: unknown[] = []
  const joined: number[] = []
  const gone: string[] = []
  const host = createLinkHost(record, {
    relayUrl: 'wss://relay.test',
    mint: async () => ({ ok: true, pairingToken: 'tok', hostId: '', ttlMs: 120_000 }),
    status: async () => 'live',
    clients: { attach: (s) => { const id = nextId++; sinks.set(id, s); return id }, detach: (id) => { sinks.delete(id) } },
    pty,
    transport: () => { const { hostT, peerT } = transportPair({ hostBuffered: o.buffered }); peers.push(peerT); return hostT },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onChange: () => {},
    onChat: (m) => chats.push(m),
    onViewerJoined: (n) => joined.push(n),
    onGone: (r) => gone.push(r)
  })
  hosts.push(host)
  return { record, host, peers, sinks, left, chats, joined, gone, keys: deriveWatchLinkKeys(secret) }
}

function viewer(peer: RelayTransport, keys: ReturnType<typeof deriveWatchLinkKeys>) {
  const log = { open: 0, events: [] as [string, unknown[]][], pty: [] as string[], denied: [] as string[], closed: 0 }
  const c = connectWatchClient({
    socket: peer, keys,
    events: {
      onOpen: () => { log.open++ },
      onEvent: (ch, a) => { log.events.push([ch, a]) },
      onPtyData: (_s, d) => { log.pty.push(d) },
      onDenied: (r) => { log.denied.push(r) },
      onClose: () => { log.closed++ }
    }
  })
  return { c, log }
}

describe('createLinkHost', () => {
  it('opens a viewer, sends meta then the visible keyframe, then the filtered stream', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toEqual([WATCH_EVENT.meta, WATCH_EVENT.keyframe]))
    expect(v.log.events[0][1][0]).toMatchObject({ v: 1, role: 'viewer', label: 'Ada', title: 'build', cols: 100, rows: 30 })
    expect(v.log.events[1][1][0]).toEqual({ sessionId: 's1', screen: 'SCREEN', altScreen: true })
    const [id, sink] = [...t.sinks.entries()][0]
    expect(id).toBeGreaterThanOrEqual(1_000_000)
    sink.sendBinary(encodePtyData('s1', 'a\x1b]52;c;c2VjcmV0\x07b'))
    expect(v.log.pty).toEqual(['ab'])
    expect(t.joined).toEqual([1])
    expect(t.host.viewers()).toHaveLength(1)
    // A replacement listener opened for the next viewer.
    await vi.waitFor(() => expect(t.peers).toHaveLength(2))
  })

  it('refuses every request a peer sends, and drops every cast but chat', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const replies: Record<number, unknown> = {}
    const raw = connectRelay({
      url: 'x', token: 'x', role: 'client', theirPubB64: publicKeyToB64(t.keys.host.publicKey),
      ourKeys: { publicKey: t.keys.viewer.publicKey, secretKey: t.keys.viewer.secretKey },
      transport: t.peers[0], onReady: () => {}, onRpc: () => {}, onFrame: () => {}, onClose: () => {},
      onTunnel: (kind, p) => { if (kind !== 'text') return; const m = parseRpcMessage(new TextDecoder().decode(p)); if (m?.t === 'res') replies[m.id] = m }
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(t.sinks.size).toBe(0) // not open until this peer confirms too
    raw.sendTunnelText('{"t":"cast","method":"trust:confirm","args":[]}')
    await vi.waitFor(() => expect(t.sinks.size).toBe(1))
    const channels = Object.values(IPC).filter((v): v is string => typeof v === 'string')
    channels.forEach((ch, i) => raw.sendTunnelText(JSON.stringify({ t: 'req', id: i + 1, method: ch, args: [] })))
    await vi.waitFor(() => expect(Object.keys(replies)).toHaveLength(channels.length))
    for (const r of Object.values(replies)) expect((r as { ok: boolean }).ok).toBe(false)
  })

  it('denies a peer whose key is not the link\'s viewer key and reopens a listener', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const stranger = deriveWatchLinkKeys(nacl.randomBytes(32))
    const v = viewer(t.peers[0], { ...t.keys, viewer: stranger.viewer })
    await vi.waitFor(() => expect(v.log.denied).toEqual(['denied']))
    expect(v.log.open).toBe(0)
    expect(t.sinks.size).toBe(0)
    await vi.waitFor(() => expect(t.peers.length).toBeGreaterThanOrEqual(2))
  })

  it('waits, then streams when the session appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let running = false
      const t = setup({ join: async () => (running ? { sessionId: 's9', cols: 80, rows: 24, altScreen: false } : null) })
      t.host.start()
      await vi.waitFor(() => expect(t.peers).toHaveLength(1))
      const v = viewer(t.peers[0], t.keys)
      await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toContain(WATCH_EVENT.waiting))
      running = true
      await vi.advanceTimersByTimeAsync(2_100)
      await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toContain(WATCH_EVENT.keyframe))
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stalled viewer never pauses and gets throttled keyframes', async () => {
    let buffered = 0
    const t = setup({ buffered: () => buffered })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.log.events.map((e) => e[0])).toContain(WATCH_EVENT.keyframe))
    const sink = [...t.sinks.values()][0]
    buffered = 10_000_000
    for (let i = 0; i < 50; i++) sink.sendBinary(encodePtyData('s1', 'y\r\n'))
    expect(v.log.pty).toEqual([])
    buffered = 0
    await vi.waitFor(() => expect(v.log.events.filter((e) => e[0] === WATCH_EVENT.keyframe)).toHaveLength(2), { timeout: 3000 })
    sink.sendBinary(encodePtyData('s1', 'after'))
    expect(v.log.pty).toEqual(['after'])
  })

  it('relays commenter chat, rate-limited, to viewers and the owner', async () => {
    const t = setup({ role: 'commenter' })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.c.isOpen()).toBe(true))
    expect(v.c.sendChat('Ada', 'hello\u0007')).toBe(true)
    expect(v.c.sendChat('Ada', 'again')).toBe(true) // inside 2 s: dropped by the host
    await vi.waitFor(() => expect(t.chats).toHaveLength(1))
    expect(t.chats[0]).toMatchObject({ name: 'Ada', text: 'hello', from: 'viewer' })
    await vi.waitFor(() => expect(v.log.events.some((e) => e[0] === WATCH_EVENT.chat)).toBe(true))
    expect(t.host.postSharerChat('hi back')).toMatchObject({ from: 'sharer', name: 'Ada', text: 'hi back' })
    expect(t.host.chatHistory()).toHaveLength(2)
  })

  it('a viewer link drops chat casts', async () => {
    const t = setup({ role: 'viewer' })
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const v = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(v.c.isOpen()).toBe(true))
    v.c.sendChat('Ada', 'hello')
    await new Promise((r) => setTimeout(r, 20))
    expect(t.chats).toEqual([])
  })

  it('kick ends one viewer with a reason; stop ends everyone and leaves the pty', async () => {
    const t = setup()
    t.host.start()
    await vi.waitFor(() => expect(t.peers).toHaveLength(1))
    const a = viewer(t.peers[0], t.keys)
    await vi.waitFor(() => expect(t.peers).toHaveLength(2))
    const b = viewer(t.peers[1], t.keys)
    await vi.waitFor(() => expect(t.host.viewers()).toHaveLength(2))
    expect(t.host.kick(t.host.viewers()[0].viewerId)).toBe(true)
    await vi.waitFor(() => expect(a.log.events.some((e) => e[0] === WATCH_EVENT.end && (e[1][0] as { reason: string }).reason === 'kicked')).toBe(true))
    t.host.stop('revoked')
    await vi.waitFor(() => expect(b.log.events.some((e) => e[0] === WATCH_EVENT.end && (e[1][0] as { reason: string }).reason === 'revoked')).toBe(true))
    expect(t.left).toHaveLength(2)
    expect(t.sinks.size).toBe(0)
  })

  it('a 410 from the host-token route ends the link as gone', async () => {
    const t = setup()
    const host = createLinkHost(t.record, {
      relayUrl: 'x', mint: async () => ({ ok: false, kind: 'gone', reason: 'expired' }), status: async () => 'expired',
      clients: { attach: () => 1, detach: () => {} }, pty: { join: async () => null, leave: () => {}, captureVisible: async () => '' },
      now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never),
      onChange: () => {}, onChat: () => {}, onViewerJoined: () => {}, onGone: (r) => t.gone.push(r)
    })
    host.start()
    await vi.waitFor(() => expect(t.gone).toEqual(['expired']))
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/core/watch-link/link-host.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/core/watch-link/link-host.ts`:

```ts
// One live link at runtime: its standing listeners (one hosted-scheduler, capped at 10 bridged),
// and for every connected viewer a relay-host session whose peer key must be the one derived from
// the link secret. The viewer is attached as a QUIET, SELF-PACED core client; the host joins the
// node's RUNNING session on its behalf (join-only, no size vote; nothing comes from the viewer),
// sends meta and a visible-screen keyframe, then streams through the watcher sink.
//
// relay-host never tells us about ends it caused itself (`deny`, `close`): every such path goes
// through `ended()`, which reports to the scheduler exactly once (the hosted-service pattern).
import nacl from 'tweetnacl'
import { connectRelayHost, type PeerAttach, type RelayHostSession } from '../relay/relay-host'
import type { RelayTransport } from '../relay/relay-socket'
import { createHostedScheduler, type Listener, type SchedulerStatus } from '../relay/hosted-scheduler'
import type { UiSink } from '../ui-sink-registry'
import { bytesToB64, bytesToHex } from '../../shared/watch-link/bytes'
import { deriveWatchLinkKeys } from '../../shared/watch-link/keys'
import {
  WATCH_CHAT_CAST, WATCH_EVENT, WATCH_PROTOCOL_VERSION, sanitizeChatName, sanitizeChatText,
  type WatchChatMessage, type WatchLinkEndReason, type WatchMeta
} from '../../shared/watch-link/protocol'
import type { HostTokenResult } from './api'
import { createStreamFilter, type StreamFilter } from './stream-filter'
import { createTokenBucket, type TokenBucket } from './token-bucket'
import { WATCHER_REFUSAL, WATCHER_RESUME_BELOW, watcherAccess, wrapWatcherSink, type PtyLifecycle } from './watcher-policy'
import type { WatchLinkRecord } from './store'

export const MAX_VIEWERS_PER_LINK = 10
export const FULL_STATUS_POLL_MS = 5 * 60_000
export const CHAT_MIN_INTERVAL_MS = 2_000
export const CHAT_HISTORY_MAX = 200
export const KEYFRAME_MIN_INTERVAL_MS = 1_000
export const REJOIN_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000]
const RATE = 256 * 1024
const BURST = 1024 * 1024

export interface WatchPty {
  join(clientId: number, nodeId: string, viewerId: string): Promise<{ sessionId: string; cols: number; rows: number; altScreen: boolean } | null>
  leave(clientId: number, sessionId: string, viewerId: string): void
  captureVisible(sessionId: string): Promise<string>
}
export interface QuietClients {
  attach(sink: UiSink): number
  detach(id: number): void
}
export interface LinkHostDeps {
  relayUrl: string
  mint(): Promise<HostTokenResult>
  status(): Promise<'live' | 'revoked' | 'expired' | 'unknown'>
  clients: QuietClients
  pty: WatchPty
  transport?: () => RelayTransport
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  onChange(): void
  onChat(msg: WatchChatMessage): void
  onViewerJoined(count: number): void
  onGone(reason: 'revoked' | 'expired'): void
}
export type LinkRuntimeStatus = 'live' | 'reconnecting' | 'refused'
export interface LinkViewer {
  viewerId: string
  name: string | null
  joinedAt: number
}
export interface LinkHost {
  start(): void
  stop(reason: WatchLinkEndReason): void
  kick(viewerId: string): boolean
  postSharerChat(text: string): WatchChatMessage | null
  chatHistory(): WatchChatMessage[]
  status(): LinkRuntimeStatus
  viewers(): LinkViewer[]
}

interface Conn {
  viewerId: string
  ev: { onBridged(): void; onClose(): void }
  session: RelayHostSession | null
  clientId: number | null
  sink: UiSink | null
  sessionId: string | null
  altScreen: boolean
  streaming: boolean
  name: string | null
  joinedAt: number | null
  lastChatAt: number
  lastKeyframeAt: number
  bridged: boolean
  ended: boolean
  rejoinAttempt: number
  rejoinTimer: unknown
  keyframeTimer: unknown
  filter: StreamFilter
  bucket: TokenBucket
}

export function createLinkHost(record: WatchLinkRecord, deps: LinkHostDeps): LinkHost {
  const keys = deriveWatchLinkKeys(record.secret)
  const hostKeys = { publicKey: keys.host.publicKey, secretKey: keys.host.secretKey }
  const expectedViewerKey = bytesToB64(keys.viewer.publicKey)
  const conns = new Set<Conn>()
  const chat: WatchChatMessage[] = []
  let sched: SchedulerStatus | null = null
  let pollTimer: unknown = null
  let stopped = false

  const send = (c: Conn, channel: string, payload: unknown): void => {
    try {
      c.sink?.sendText(JSON.stringify({ t: 'ev', channel, args: [payload] }))
    } catch {
      // A dead socket is the registry's to notice (it evicts a sink that keeps throwing).
    }
  }
  const clearTimer = (h: unknown): void => {
    if (h !== null) deps.clearTimeout(h)
  }

  function ended(c: Conn): void {
    if (c.ended) return
    c.ended = true
    conns.delete(c)
    clearTimer(c.rejoinTimer)
    clearTimer(c.keyframeTimer)
    if (c.clientId !== null && c.sessionId) deps.pty.leave(c.clientId, c.sessionId, c.viewerId)
    try {
      c.ev.onClose()
    } catch {
      // the scheduler owns its own errors
    }
    deps.onChange()
  }
  function endConn(c: Conn, reason: WatchLinkEndReason): void {
    send(c, WATCH_EVENT.end, { reason })
    c.session?.close()
    ended(c)
  }

  async function keyframe(c: Conn): Promise<void> {
    const sid = c.sessionId
    if (!sid || c.ended) return
    c.streaming = false
    const screen = await deps.pty.captureVisible(sid)
    if (c.ended || c.sessionId !== sid) return
    c.lastKeyframeAt = deps.now()
    send(c, WATCH_EVENT.keyframe, { sessionId: sid, screen, altScreen: c.altScreen })
    c.streaming = true
  }
  function throttle(c: Conn): void {
    if (c.keyframeTimer !== null || c.ended) return
    c.streaming = false
    const wait = Math.max(0, KEYFRAME_MIN_INTERVAL_MS - (deps.now() - c.lastKeyframeAt))
    c.keyframeTimer = deps.setTimeout(function tick() {
      c.keyframeTimer = null
      if (c.ended) return
      // Wait for the socket to drain before painting over it.
      if ((c.sink?.bufferedAmount?.() ?? 0) > WATCHER_RESUME_BELOW) {
        c.keyframeTimer = deps.setTimeout(tick, KEYFRAME_MIN_INTERVAL_MS)
        return
      }
      void keyframe(c)
    }, wait)
  }
  function scheduleRejoin(c: Conn): void {
    if (c.ended || c.rejoinTimer !== null) return
    const delay = REJOIN_BACKOFF_MS[Math.min(c.rejoinAttempt, REJOIN_BACKOFF_MS.length - 1)]
    c.rejoinAttempt++
    c.rejoinTimer = deps.setTimeout(() => {
      c.rejoinTimer = null
      void join(c)
    }, delay)
  }
  async function join(c: Conn): Promise<void> {
    if (c.ended || c.clientId === null) return
    const res = await deps.pty.join(c.clientId, record.nodeId, c.viewerId)
    if (c.ended) {
      if (res && c.clientId !== null) deps.pty.leave(c.clientId, res.sessionId, c.viewerId)
      return
    }
    if (!res) {
      send(c, WATCH_EVENT.waiting, {})
      scheduleRejoin(c)
      return
    }
    c.rejoinAttempt = 0
    if (c.sessionId !== res.sessionId) c.filter.reset()
    c.sessionId = res.sessionId
    c.altScreen = res.altScreen
    const meta: WatchMeta = { v: WATCH_PROTOCOL_VERSION, role: record.role, label: record.label, title: record.title, expiresAt: record.expiresAt, cols: res.cols, rows: res.rows }
    send(c, WATCH_EVENT.meta, meta)
    await keyframe(c)
  }
  function onLifecycle(c: Conn, _kind: PtyLifecycle): void {
    // The session this viewer watched is over (exited, closed by someone, or recycled). Leave it,
    // say so, and look for the next one; a recycle usually has one ready within seconds.
    if (c.clientId !== null && c.sessionId) deps.pty.leave(c.clientId, c.sessionId, c.viewerId)
    c.sessionId = null
    c.streaming = false
    send(c, WATCH_EVENT.waiting, {})
    c.rejoinAttempt = 0
    scheduleRejoin(c)
  }
  function publish(msg: WatchChatMessage): void {
    chat.push(msg)
    if (chat.length > CHAT_HISTORY_MAX) chat.shift()
    for (const c of conns) if (c.joinedAt !== null) send(c, WATCH_EVENT.chat, msg)
    deps.onChat(msg)
    deps.onChange()
  }
  function onViewerCast(c: Conn, method: string, args: unknown[]): void {
    if (method !== WATCH_CHAT_CAST || record.role !== 'commenter') return
    const now = deps.now()
    if (now - c.lastChatAt < CHAT_MIN_INTERVAL_MS) return
    const p = (args[0] ?? {}) as { name?: unknown; text?: unknown }
    const name = sanitizeChatName(p.name)
    const text = sanitizeChatText(p.text)
    if (!name || !text) return
    c.lastChatAt = now
    c.name = name
    publish({ id: bytesToHex(nacl.randomBytes(8)), name, text, at: now, from: 'viewer' })
  }
  const bridged = (c: Conn): void => {
    if (c.bridged) return
    c.bridged = true
    try {
      c.ev.onBridged()
    } catch {
      // the scheduler owns its own errors
    }
  }

  function openListener(token: string, ev: { onBridged(): void; onClose(): void }): Listener {
    const c: Conn = {
      viewerId: `v-${bytesToHex(nacl.randomBytes(4))}`, ev, session: null, clientId: null, sink: null,
      sessionId: null, altScreen: false, streaming: false, name: null, joinedAt: null, lastChatAt: -Infinity, lastKeyframeAt: -Infinity,
      bridged: false, ended: false, rejoinAttempt: 0, rejoinTimer: null, keyframeTimer: null,
      filter: createStreamFilter(), bucket: createTokenBucket({ ratePerSec: RATE, burst: BURST, now: deps.now })
    }
    conns.add(c)
    const attach: PeerAttach = {
      attach: (sink) => {
        c.sink = sink
        c.clientId = deps.clients.attach(sink)
        return c.clientId
      },
      detach: (id) => deps.clients.detach(id),
      // Never reached (the access hook refuses every request first); answered anyway.
      dispatch: async (_id, req) => ({ t: 'res', id: req.id, ok: false, error: { code: 'E_ROLE', message: WATCHER_REFUSAL } }),
      cast: (_id, method, args) => {
        try {
          onViewerCast(c, method, args)
        } catch (err) {
          console.warn(`[watch-link] a viewer cast failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    try {
      c.session = connectRelayHost({
        url: deps.relayUrl,
        token,
        ourKeys: hostKeys,
        attach,
        transport: deps.transport?.(),
        // Answered from our OWN record, never from anything the peer sent: the handshake key must be
        // the one only a holder of the link secret can have.
        autoApprove: (peerKeyB64) => {
          bridged(c)
          return peerKeyB64 === expectedViewerKey
        },
        hooks: {
          access: (_s, kind, method) => watcherAccess(kind, method, record.role),
          wrapSink: (_s, base) =>
            wrapWatcherSink(base, {
              sessionId: () => c.sessionId,
              streaming: () => c.streaming,
              filter: c.filter,
              bucket: c.bucket,
              onOverBudget: () => throttle(c),
              onLifecycle: (kind) => onLifecycle(c, kind)
            })
        },
        onPeerPending: (s) => {
          c.session ??= s
          s.deny('denied')
          ended(c)
        },
        onOpen: (s) => {
          c.session ??= s
          c.joinedAt = deps.now()
          deps.onViewerJoined(viewers().length)
          deps.onChange()
          void join(c)
        },
        onClose: () => ended(c)
      })
    } catch (err) {
      conns.delete(c)
      throw err
    }
    return {
      bridged: false,
      close: () => {
        c.session?.close()
        ended(c)
      }
    }
  }

  function viewers(): LinkViewer[] {
    const out: LinkViewer[] = []
    for (const c of conns) if (c.joinedAt !== null && !c.ended) out.push({ viewerId: c.viewerId, name: c.name, joinedAt: c.joinedAt })
    return out
  }
  function gone(reason: 'revoked' | 'expired'): void {
    if (stopped) return
    stop(reason)
    deps.onGone(reason)
  }
  function armFullPoll(s: SchedulerStatus): void {
    const full = s.state === 'running' && s.idle === 0 && s.bridged >= MAX_VIEWERS_PER_LINK
    if (!full) {
      clearTimer(pollTimer)
      pollTimer = null
      return
    }
    if (pollTimer !== null) return
    pollTimer = deps.setTimeout(async () => {
      pollTimer = null
      const st = await deps.status()
      if (st === 'revoked' || st === 'expired') gone(st)
      else if (sched) armFullPoll(sched)
    }, FULL_STATUS_POLL_MS)
  }

  const scheduler = createHostedScheduler(
    {
      mint: async () => {
        const r = await deps.mint()
        if (!r.ok && r.kind === 'gone') {
          const reason = r.reason
          queueMicrotask(() => gone(reason))
          return { ok: false, kind: 'refused', status: 410 }
        }
        return r
      },
      open: openListener,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout,
      onStatus: (s) => {
        sched = s
        armFullPoll(s)
        deps.onChange()
      },
      maxBridged: MAX_VIEWERS_PER_LINK
    },
    deps.now
  )

  function stop(reason: WatchLinkEndReason): void {
    if (stopped) return
    stopped = true
    scheduler.stop()
    clearTimer(pollTimer)
    pollTimer = null
    for (const c of [...conns]) endConn(c, reason)
    deps.onChange()
  }

  return {
    start: () => scheduler.start(),
    stop,
    kick(viewerId) {
      for (const c of conns) {
        if (c.viewerId === viewerId && c.joinedAt !== null) {
          endConn(c, 'kicked')
          return true
        }
      }
      return false
    },
    postSharerChat(text) {
      const clean = sanitizeChatText(text)
      if (!clean || record.role !== 'commenter' || stopped) return null
      const msg: WatchChatMessage = { id: bytesToHex(nacl.randomBytes(8)), name: record.label, text: clean, at: deps.now(), from: 'sharer' }
      publish(msg)
      return msg
    },
    chatHistory: () => [...chat],
    status() {
      if (!sched) return 'reconnecting'
      if (sched.state === 'backend-refused') return 'refused'
      if (sched.idle > 0 || sched.bridged >= MAX_VIEWERS_PER_LINK) return 'live'
      return sched.lastError ? 'reconnecting' : 'live'
    },
    viewers
  }
}
```

Notes for the implementer: (a) `Listener`/`SchedulerStatus` are exported by `hosted-scheduler.ts` already; if `Listener` is not exported, export it there. (b) If `RelayHostSession.deny` sends nothing because the socket is not `ready`, the stranger test still passes on `open === 0` + `sinks.size === 0`; adjust only the `denied` assertion, never the host code, and write down why in the test.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/watch-link src/core/relay && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/watch-link src/core/relay/hosted-scheduler.ts
git commit -m "feat(watch-link): the link host — viewer sessions, keyframes, throttling, chat and kick"
```

---

### Task 12: The service, owner IPC and host-only channels

**Files:**
- Create: `src/shared/watch-link-types.ts`, `src/core/watch-link/service.ts`
- Modify: `src/shared/ipc.ts`, `src/shared/host-control.ts`, `src/shared/types.ts` (`NodeTerminalApi`)
- Test: `src/core/watch-link/service.test.ts`, `src/shared/host-control.test.ts` (append)

**Interfaces:**
- Produces (`src/shared/watch-link-types.ts` — owner side, NOT vendored):

```ts
import type { WatchChatMessage, WatchLinkRole } from './watch-link/protocol'
export type { WatchChatMessage, WatchLinkRole }
export const WATCH_LINK_TTLS = [900, 3600, 28800, 86400] as const
export type WatchLinkTtl = (typeof WATCH_LINK_TTLS)[number]
export const MAX_LINKS_PER_MACHINE = 5
export const LABEL_MAX = 40
export const TITLE_MAX = 80
export interface CreateWatchLinkRequest { nodeId: string; role: WatchLinkRole; ttlSeconds: WatchLinkTtl; label: string; title: string }
export type CreateWatchLinkError =
  | 'not-entitled' | 'limit-machine' | 'limit-active' | 'limit-daily' | 'rate-limited' | 'network'
  | 'license-check' | 'relay-unavailable' | 'node-missing' | 'bad-request' | 'persist-failed' | 'unsupported'
export type CreateWatchLinkResult = { ok: true; link: WatchLinkView } | { ok: false; error: CreateWatchLinkError }
export interface WatchLinkViewerView { viewerId: string; name: string | null; joinedAt: number }
export interface WatchLinkView {
  linkId: string; nodeId: string; role: WatchLinkRole; label: string; title: string
  createdAt: number; expiresAt: number; url: string
  status: 'live' | 'reconnecting' | 'refused'
  viewers: WatchLinkViewerView[]
}
export type WatchLinkNotice =
  | { kind: 'joined'; linkId: string; nodeId: string; title: string; viewers: number }
  | { kind: 'ended'; linkId: string; nodeId: string; title: string; reason: 'expired' | 'revoked' | 'node-gone' }
  | { kind: 'not-persistent' }
export interface WatchLinkApi {
  create(req: CreateWatchLinkRequest): Promise<CreateWatchLinkResult>
  list(): Promise<WatchLinkView[]>
  revoke(linkId: string): Promise<void>
  revokeAll(): Promise<void>
  kick(linkId: string, viewerId: string): Promise<boolean>
  sendChat(linkId: string, text: string): Promise<WatchChatMessage | null>
  chatHistory(linkId: string): Promise<WatchChatMessage[]>
  onState(cb: (links: WatchLinkView[]) => void): () => void
  onChat(cb: (linkId: string, msg: WatchChatMessage) => void): () => void
  onNotice(cb: (n: WatchLinkNotice) => void): () => void
}
```

- IPC (`src/shared/ipc.ts`, one block with JSDoc): `watchLinkCreate: 'watchLink:create'`, `watchLinkList: 'watchLink:list'`, `watchLinkRevoke: 'watchLink:revoke'`, `watchLinkRevokeAll: 'watchLink:revoke-all'`, `watchLinkKick: 'watchLink:kick'`, `watchLinkChatSend: 'watchLink:chat-send'`, `watchLinkChatHistory: 'watchLink:chat-history'`, `watchLinkState: 'watchLink:state'`, `watchLinkChat: 'watchLink:chat'`, `watchLinkNotice: 'watchLink:notice'`.
- `src/core/watch-link/service.ts`: `interface WatchLinkServiceDeps`, `createWatchLinkService(deps): WatchLinkService`, `registerWatchLinkIpc(p: Pick<CorePlatform, 'handleWithSender' | 'isOwnerClient'>, s: WatchLinkService): void`, `sendToOwners(p: Pick<CorePlatform, 'clientIds' | 'isOwnerClient' | 'sendTo'>, channel: string, ...args: unknown[]): void`.

```ts
export interface WatchLinkServiceDeps {
  api: WatchLinkApiClient          // src/core/watch-link/api.ts's WatchLinkApi, imported as that alias
  relayUrl: string
  store: WatchLinkStore
  entitlement(): string | null
  relayAllowed(): boolean
  nodeExists(nodeId: string): boolean
  clients: QuietClients
  pty: WatchPty
  emit(channel: string, ...args: unknown[]): void
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(h: unknown): void
  /** TEST ONLY. */
  createHost?: typeof createLinkHost
  transport?: () => RelayTransport
}
export interface WatchLinkService {
  init(): Promise<void>
  create(req: unknown): Promise<CreateWatchLinkResult>
  list(): WatchLinkView[]
  revoke(linkId: string): Promise<void>
  revokeAll(): Promise<void>
  kick(linkId: string, viewerId: string): boolean
  sendChat(linkId: string, text: string): WatchChatMessage | null
  chatHistory(linkId: string): WatchChatMessage[]
  onWorkspaceChanged(): void
  shutdown(): void
}
```

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/host-control.test.ts`:

```ts
it('every owner live-link channel is host-only, and the viewer protocol is not in that namespace', () => {
  const owner = Object.values(IPC).filter((v): v is string => typeof v === 'string' && v.startsWith('watchLink:'))
  expect(owner.length).toBeGreaterThanOrEqual(10)
  for (const ch of owner) expect(isHostOnlyChannel(ch)).toBe(true)
  expect(isHostOnlyChannel('watch:chat')).toBe(false)
})
```

`src/core/watch-link/service.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWatchLinkService, registerWatchLinkIpc } from './service'
import { WatchLinkStore } from './store'
import type { WatchLinkApi as ApiClient } from './api'
import type { LinkHost, LinkHostDeps } from './link-host'
import type { WatchLinkRecord } from './store'
import { IPC } from '../../shared/ipc'
import { fakePlatform } from '../platform-fake'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fakeApi(over: Partial<ApiClient> = {}) {
  const calls: string[] = []
  let n = 0
  const api: ApiClient = {
    create: async () => { calls.push('create'); n++; return { ok: true, linkId: `Link${String(n).padStart(18, '0')}`, expiresAt: Date.now() + 3600_000 } },
    hostToken: async () => ({ ok: true, pairingToken: 't', hostId: '', ttlMs: 120_000 }),
    status: async () => 'live',
    revoke: async (id) => { calls.push(`revoke ${id}`); return true },
    revokeAll: async () => { calls.push('revokeAll'); return true },
    ...over
  }
  return { api, calls }
}
function fakeHosts() {
  const made: { record: WatchLinkRecord; deps: LinkHostDeps; stopped: string[] }[] = []
  const createHost = (record: WatchLinkRecord, deps: LinkHostDeps): LinkHost => {
    const h = { record, deps, stopped: [] as string[] }
    made.push(h)
    return {
      start: () => {}, stop: (r) => { h.stopped.push(r) }, kick: () => true,
      postSharerChat: () => null, chatHistory: () => [], status: () => 'live', viewers: () => []
    }
  }
  return { made, createHost }
}
function service(o: { api?: Partial<ApiClient>; nodes?: Set<string>; entitlement?: string | null; relayAllowed?: boolean; seal?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wls-'))
  dirs.push(dir)
  const { api, calls } = fakeApi(o.api)
  const hosts = fakeHosts()
  const nodes = o.nodes ?? new Set(['n1', 'n2'])
  const emitted: [string, unknown[]][] = []
  const store = new WatchLinkStore({ file: join(dir, 'watch-links.json') })
  const s = createWatchLinkService({
    api, relayUrl: 'wss://r', store,
    entitlement: () => (o.entitlement === undefined ? 'ent' : o.entitlement),
    relayAllowed: () => o.relayAllowed ?? true,
    nodeExists: (id) => nodes.has(id),
    clients: { attach: () => 1, detach: () => {} },
    pty: { join: async () => null, leave: () => {}, captureVisible: async () => '' },
    emit: (ch, ...a) => emitted.push([ch, a]),
    createHost: hosts.createHost
  })
  return { s, calls, hosts, nodes, emitted, store }
}
const req = (over: Record<string, unknown> = {}) => ({ nodeId: 'n1', role: 'viewer', ttlSeconds: 3600, label: 'Ada', title: 'build', ...over })

describe('createWatchLinkService', () => {
  it('creates a link, persists it, starts a host and answers the URL', async () => {
    const t = service()
    const r = await t.s.create(req())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.link.url).toMatch(/^https:\/\/nodeterm\.dev\/s\/Link0+1#1\.[A-Za-z0-9_-]{43}$/)
    expect(t.hosts.made).toHaveLength(1)
    expect(await t.store.load()).toHaveLength(1)
    expect(t.emitted.some(([ch]) => ch === IPC.watchLinkState)).toBe(true)
  })

  it('refuses bad input, a missing node, no relay, no entitlement and a sixth link', async () => {
    const t = service()
    expect(await t.s.create(req({ ttlSeconds: 7200 }))).toEqual({ ok: false, error: 'bad-request' })
    expect(await t.s.create(req({ role: 'editor' }))).toEqual({ ok: false, error: 'bad-request' })
    expect(await t.s.create(req({ nodeId: 'gone' }))).toEqual({ ok: false, error: 'node-missing' })
    expect(await service({ relayAllowed: false }).s.create(req())).toEqual({ ok: false, error: 'relay-unavailable' })
    expect(await service({ entitlement: null }).s.create(req())).toEqual({ ok: false, error: 'not-entitled' })
    for (let i = 0; i < 5; i++) expect((await t.s.create(req())).ok).toBe(true)
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-machine' })
    expect(t.calls.filter((c) => c === 'create')).toHaveLength(5)
  })

  it('passes API refusals through without starting anything', async () => {
    const t = service({ api: { create: async () => ({ ok: false, error: 'limit-daily' }) } })
    expect(await t.s.create(req())).toEqual({ ok: false, error: 'limit-daily' })
    expect(t.hosts.made).toHaveLength(0)
  })

  it('revoke stops the host, forgets the record and revokes server-side', async () => {
    const t = service()
    const r = await t.s.create(req())
    if (!r.ok) throw new Error('create failed')
    await t.s.revoke(r.link.linkId)
    expect(t.hosts.made[0].stopped).toEqual(['revoked'])
    expect(t.s.list()).toEqual([])
    expect(await t.store.load()).toEqual([])
    expect(t.calls).toContain(`revoke ${r.link.linkId}`)
  })

  it('node gone ends every link of the node and revokes each', async () => {
    const t = service()
    await t.s.create(req())
    await t.s.create(req({ role: 'commenter' }))
    await t.s.create(req({ nodeId: 'n2' }))
    t.nodes.delete('n1')
    t.s.onWorkspaceChanged()
    await vi.waitFor(() => expect(t.s.list().map((l) => l.nodeId)).toEqual(['n2']))
    expect(t.hosts.made.filter((h) => h.stopped.includes('node-gone'))).toHaveLength(2)
    await vi.waitFor(() => expect(t.calls.filter((c) => c.startsWith('revoke '))).toHaveLength(2))
    expect(t.emitted.some(([ch, a]) => ch === IPC.watchLinkNotice && (a[0] as { reason?: string }).reason === 'node-gone')).toBe(true)
  })

  it('init resumes live records, drops expired and orphaned ones', async () => {
    const t = service()
    const good = { linkId: 'Good000000000000000000', nodeId: 'n1', role: 'viewer' as const, label: 'A', title: 't', createdAt: 0, expiresAt: Date.now() + 60_000, secret: new Uint8Array(32) }
    await t.store.save([good, { ...good, linkId: 'Old0000000000000000000', expiresAt: Date.now() - 1 }, { ...good, linkId: 'Orph000000000000000000', nodeId: 'gone' }])
    await t.s.init()
    expect(t.s.list().map((l) => l.linkId)).toEqual(['Good000000000000000000'])
    expect(t.calls).toContain('revoke Orph000000000000000000')
  })

  it('shutdown stops hosts as host-stopping and keeps the records', async () => {
    const t = service()
    await t.s.create(req())
    t.s.shutdown()
    expect(t.hosts.made[0].stopped).toEqual(['host-stopping'])
    expect(await t.store.load()).toHaveLength(1)
  })

  it('the IPC answers owners only', async () => {
    const t = service()
    const p = fakePlatform({ isOwnerClient: (id) => id === 1 })
    registerWatchLinkIpc(p, t.s)
    expect(await p.handlers[IPC.watchLinkCreate](2, req())).toEqual({ ok: false, error: 'unsupported' })
    expect(await p.handlers[IPC.watchLinkList](2)).toEqual([])
    expect((await p.handlers[IPC.watchLinkCreate](1, req()) as { ok: boolean }).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

Add the IPC block to `src/shared/ipc.ts`:

```ts
  /** Live links (docs/live-links.md). OWNER-ONLY: every `watchLink:` channel is host-only
   *  (host-control.ts), so no relay peer — hosted owners and editors included — can create a link,
   *  which would publish a host terminal with the host's Pro. The viewer's own tunnel protocol is
   *  `watch:*` (src/shared/watch-link/protocol.ts), deliberately NOT this namespace. */
  watchLinkCreate: 'watchLink:create',
  watchLinkList: 'watchLink:list',
  watchLinkRevoke: 'watchLink:revoke',
  watchLinkRevokeAll: 'watchLink:revoke-all',
  watchLinkKick: 'watchLink:kick',
  watchLinkChatSend: 'watchLink:chat-send',
  watchLinkChatHistory: 'watchLink:chat-history',
  /** core → owner clients only: the full list on every change. */
  watchLinkState: 'watchLink:state',
  /** core → owner clients only: `(linkId, WatchChatMessage)`. */
  watchLinkChat: 'watchLink:chat',
  /** core → owner clients only: a `WatchLinkNotice`. */
  watchLinkNotice: 'watchLink:notice',
```

`src/shared/host-control.ts`: append `'watchLink:'` to `HOST_ONLY_CHANNEL_PREFIXES` with a comment: `// Live links: publishing a host terminal to anyone with a URL, with the host's Pro.`

`src/shared/types.ts`: in `NodeTerminalApi` add `watchLink: import('./watch-link-types').WatchLinkApi`.

Create `src/shared/watch-link-types.ts` with the block from **Interfaces** above.

`src/core/watch-link/service.ts`:

```ts
// The live-link registry: at most 5 active links per machine, each with its link host. Records are
// persisted (spec D8) and resumed at boot. A link ends on owner revoke, expiry, the node leaving
// every project (`onWorkspaceChanged`, which the canvas authority's writes also reach), or the
// server saying it is gone. Owner state goes to OWNER clients only (`sendToOwners`).
import type { CorePlatform } from '../platform'
import { IPC } from '../../shared/ipc'
import { isSafeNodeId } from '../../shared/safe-id'
import { formatWatchLink } from '../../shared/watch-link/link'
import { deriveWatchLinkKeys, newWatchLinkSecret, sha256Hex } from '../../shared/watch-link/keys'
import type { WatchChatMessage, WatchLinkEndReason } from '../../shared/watch-link/protocol'
import {
  LABEL_MAX, MAX_LINKS_PER_MACHINE, TITLE_MAX, WATCH_LINK_TTLS,
  type CreateWatchLinkRequest, type CreateWatchLinkResult, type WatchLinkView
} from '../../shared/watch-link-types'
import type { WatchLinkApi as WatchLinkApiClient } from './api'
import { createLinkHost, type LinkHost, type QuietClients, type WatchPty } from './link-host'
import type { WatchLinkRecord, WatchLinkStore } from './store'
import type { RelayTransport } from '../relay/relay-socket'

const MAX_DELAY_MS = 2_147_483_647

export interface WatchLinkServiceDeps {
  api: WatchLinkApiClient
  relayUrl: string
  store: WatchLinkStore
  entitlement(): string | null
  relayAllowed(): boolean
  nodeExists(nodeId: string): boolean
  clients: QuietClients
  pty: WatchPty
  emit(channel: string, ...args: unknown[]): void
  now?(): number
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(h: unknown): void
  createHost?: typeof createLinkHost
  transport?: () => RelayTransport
}
export interface WatchLinkService {
  init(): Promise<void>
  create(req: unknown): Promise<CreateWatchLinkResult>
  list(): WatchLinkView[]
  revoke(linkId: string): Promise<void>
  revokeAll(): Promise<void>
  kick(linkId: string, viewerId: string): boolean
  sendChat(linkId: string, text: string): WatchChatMessage | null
  chatHistory(linkId: string): WatchChatMessage[]
  onWorkspaceChanged(): void
  shutdown(): void
}

function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max)
  return s || null
}
function parseRequest(raw: unknown): CreateWatchLinkRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.nodeId !== 'string' || !isSafeNodeId(r.nodeId)) return null
  if (r.role !== 'viewer' && r.role !== 'commenter') return null
  if (!(WATCH_LINK_TTLS as readonly unknown[]).includes(r.ttlSeconds)) return null
  const label = cleanText(r.label, LABEL_MAX)
  const title = cleanText(r.title, TITLE_MAX) ?? 'Terminal'
  if (!label) return null
  return { nodeId: r.nodeId, role: r.role, ttlSeconds: r.ttlSeconds as CreateWatchLinkRequest['ttlSeconds'], label, title }
}

export function sendToOwners(p: Pick<CorePlatform, 'clientIds' | 'isOwnerClient' | 'sendTo'>, channel: string, ...args: unknown[]): void {
  for (const id of p.clientIds()) if (p.isOwnerClient?.(id) === true) p.sendTo(id, channel, ...args)
}

export function createWatchLinkService(deps: WatchLinkServiceDeps): WatchLinkService {
  const now = deps.now ?? Date.now
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const createHost = deps.createHost ?? createLinkHost
  const records = new Map<string, WatchLinkRecord>()
  const hosts = new Map<string, LinkHost>()
  const expiry = new Map<string, unknown>()
  let toldNotPersistent = false

  const viewOf = (r: WatchLinkRecord): WatchLinkView => {
    const h = hosts.get(r.linkId)
    return {
      linkId: r.linkId, nodeId: r.nodeId, role: r.role, label: r.label, title: r.title,
      createdAt: r.createdAt, expiresAt: r.expiresAt, url: formatWatchLink(r.linkId, r.secret),
      status: h?.status() ?? 'reconnecting', viewers: h?.viewers() ?? []
    }
  }
  const list = (): WatchLinkView[] => [...records.values()].map(viewOf)
  const emitState = (): void => deps.emit(IPC.watchLinkState, list())

  async function persist(): Promise<boolean> {
    const outcome = await deps.store.save([...records.values()])
    if (outcome === 'memory-only' && !toldNotPersistent) {
      toldNotPersistent = true
      deps.emit(IPC.watchLinkNotice, { kind: 'not-persistent' })
    }
    return outcome !== 'failed'
  }

  function start(r: WatchLinkRecord): void {
    const ent = (): string => deps.entitlement() ?? ''
    const host = createHost(r, {
      relayUrl: deps.relayUrl,
      mint: () => deps.api.hostToken(r.linkId, ent()),
      status: () => deps.api.status(r.linkId, ent()),
      clients: deps.clients,
      pty: deps.pty,
      transport: deps.transport,
      now,
      setTimeout: setT,
      clearTimeout: clearT,
      onChange: emitState,
      onChat: (msg) => deps.emit(IPC.watchLinkChat, r.linkId, msg),
      onViewerJoined: (count) => deps.emit(IPC.watchLinkNotice, { kind: 'joined', linkId: r.linkId, nodeId: r.nodeId, title: r.title, viewers: count }),
      onGone: (reason) => void end(r.linkId, reason, false)
    })
    hosts.set(r.linkId, host)
    expiry.set(r.linkId, setT(() => void end(r.linkId, 'expired', false), Math.min(MAX_DELAY_MS, Math.max(0, r.expiresAt - now()))))
    host.start()
  }

  async function end(linkId: string, reason: WatchLinkEndReason, revokeServer: boolean): Promise<void> {
    const r = records.get(linkId)
    if (!r) return
    records.delete(linkId)
    const t = expiry.get(linkId)
    if (t !== undefined) clearT(t)
    expiry.delete(linkId)
    hosts.get(linkId)?.stop(reason)
    hosts.delete(linkId)
    await persist()
    emitState()
    if (reason === 'expired' || reason === 'node-gone' || (reason === 'revoked' && !revokeServer)) {
      deps.emit(IPC.watchLinkNotice, { kind: 'ended', linkId, nodeId: r.nodeId, title: r.title, reason })
    }
    const ent = deps.entitlement()
    if (revokeServer && ent) void deps.api.revoke(linkId, ent)
  }

  return {
    async init() {
      for (const r of await deps.store.load()) {
        if (r.expiresAt <= now()) continue
        if (!deps.nodeExists(r.nodeId)) {
          const ent = deps.entitlement()
          if (ent) void deps.api.revoke(r.linkId, ent)
          continue
        }
        records.set(r.linkId, r)
      }
      await persist()
      for (const r of records.values()) start(r)
      emitState()
    },
    async create(raw) {
      const req = parseRequest(raw)
      if (!req) return { ok: false, error: 'bad-request' }
      if (!deps.relayAllowed()) return { ok: false, error: 'relay-unavailable' }
      if (!deps.nodeExists(req.nodeId)) return { ok: false, error: 'node-missing' }
      if (records.size >= MAX_LINKS_PER_MACHINE) return { ok: false, error: 'limit-machine' }
      const ent = deps.entitlement()
      if (!ent) return { ok: false, error: 'not-entitled' }
      const secret = newWatchLinkSecret()
      const joinKeyHash = await sha256Hex(deriveWatchLinkKeys(secret).joinKey)
      const created = await deps.api.create(ent, joinKeyHash, req.ttlSeconds)
      if (!created.ok) return { ok: false, error: created.error }
      const record: WatchLinkRecord = { linkId: created.linkId, nodeId: req.nodeId, role: req.role, label: req.label, title: req.title, createdAt: now(), expiresAt: created.expiresAt, secret }
      records.set(record.linkId, record)
      if (!(await persist())) {
        records.delete(record.linkId)
        void deps.api.revoke(record.linkId, ent)
        return { ok: false, error: 'persist-failed' }
      }
      start(record)
      emitState()
      return { ok: true, link: viewOf(record) }
    },
    list,
    revoke: (linkId) => end(linkId, 'revoked', true),
    async revokeAll() {
      for (const id of [...records.keys()]) await end(id, 'revoked', false)
      const ent = deps.entitlement()
      if (ent) await deps.api.revokeAll(ent)
    },
    kick: (linkId, viewerId) => hosts.get(linkId)?.kick(viewerId) ?? false,
    sendChat: (linkId, text) => hosts.get(linkId)?.postSharerChat(text) ?? null,
    chatHistory: (linkId) => hosts.get(linkId)?.chatHistory() ?? [],
    onWorkspaceChanged() {
      for (const r of [...records.values()]) if (!deps.nodeExists(r.nodeId)) void end(r.linkId, 'node-gone', true)
    },
    shutdown() {
      for (const h of hosts.values()) h.stop('host-stopping')
      hosts.clear()
      for (const t of expiry.values()) clearT(t)
      expiry.clear()
    }
  }
}

export function registerWatchLinkIpc(p: Pick<CorePlatform, 'handleWithSender' | 'isOwnerClient'>, s: WatchLinkService): void {
  // Belt and braces: relay peers are already refused by the host-only prefix before any handler.
  const owner = (id: number): boolean => p.isOwnerClient?.(id) === true
  p.handleWithSender(IPC.watchLinkCreate, (sender: number, req: unknown) => (owner(sender) ? s.create(req) : { ok: false, error: 'unsupported' }))
  p.handleWithSender(IPC.watchLinkList, (sender: number) => (owner(sender) ? s.list() : []))
  p.handleWithSender(IPC.watchLinkRevoke, (sender: number, id: unknown) => (owner(sender) && typeof id === 'string' ? s.revoke(id) : undefined))
  p.handleWithSender(IPC.watchLinkRevokeAll, (sender: number) => (owner(sender) ? s.revokeAll() : undefined))
  p.handleWithSender(IPC.watchLinkKick, (sender: number, id: unknown, viewer: unknown) =>
    owner(sender) && typeof id === 'string' && typeof viewer === 'string' ? s.kick(id, viewer) : false)
  p.handleWithSender(IPC.watchLinkChatSend, (sender: number, id: unknown, text: unknown) =>
    owner(sender) && typeof id === 'string' && typeof text === 'string' ? s.sendChat(id, text) : null)
  p.handleWithSender(IPC.watchLinkChatHistory, (sender: number, id: unknown) => (owner(sender) && typeof id === 'string' ? s.chatHistory(id) : []))
}
```

(Note the `revoked` notice rule: an owner-initiated `revoke` is the user's own action and raises no notice; a server-side `gone('revoked')` — e.g. an admin revoke — does.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/core/watch-link src/shared/host-control.test.ts src/shared/ipc.test.ts` — Expected: PASS. Do NOT run the typecheck here: `NodeTerminalApi` gained `watchLink`, which the preload and the bridges only implement in Task 13.

- [ ] **Step 5: No commit here.** Continue with Task 13; its commit includes this task's files once the typecheck is green.

---

### Task 13: Shell wiring (desktop + Server Edition) and the renderer bridges

**Files:**
- Modify: `src/main/index.ts`, `src/server/index.ts`, `src/preload/index.ts`, `src/renderer/bridge/ws-bridge.ts`, `src/renderer/bridge/stubs.ts`, `src/renderer/bridge/relay-api.ts`
- Test: `src/main/watch-link-wiring.test.ts` (source-level), `src/renderer/bridge/relay-api.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 6, 7, 11, 12.
- Produces: `window.nodeTerminal.watchLink` on all three renderer surfaces (desktop preload, Server Edition ws-bridge, relay-tab stub).

- [ ] **Step 1: Write the failing wiring test**

`src/main/watch-link-wiring.test.ts`:

```ts
// Source-level: the wiring closes over shell objects no unit test can build, and an unwired service
// compiles fine while doing nothing (the hook-verified-parity.test.ts remedy for the same hole).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8').replace(/\r\n/g, '\n')

describe('live-link wiring', () => {
  for (const shell of ['src/main/index.ts', 'src/server/index.ts']) {
    it(`${shell} creates, registers, inits, chains onPersist and shuts down the service`, () => {
      const s = read(shell)
      expect(s).toMatch(/createWatchLinkService\(/)
      expect(s).toMatch(/registerWatchLinkIpc\(/)
      expect(s).toMatch(/watchLinks\.init\(\)/)
      expect(s).toMatch(/watchLinks\??\.onWorkspaceChanged\(\)/)
      expect(s).toMatch(/watchLinks\??\.shutdown\(\)/)
      expect(s).toMatch(/quiet: true, selfPaced: true/)
    })
  }
  it('the relay tab takes the inert stub and never names the channels', () => {
    const r = read('src/renderer/bridge/relay-api.ts')
    expect(r).toMatch(/watchLink: stub\.watchLink/)
    expect(r).not.toMatch(/IPC\.watchLink/)
  })
})
```

Append to `src/renderer/bridge/relay-api.test.ts` a behavioural check using that file's existing relay-api builder: `await api.watchLink.create({...})` resolves `{ ok: false, error: 'unsupported' }` and `await api.watchLink.list()` resolves `[]`.

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement the bridges**

`src/preload/index.ts`, inside `const api: NodeTerminalApi = {`:

```ts
    watchLink: {
      create: (req) => ipcRenderer.invoke(IPC.watchLinkCreate, req),
      list: () => ipcRenderer.invoke(IPC.watchLinkList),
      revoke: (linkId) => ipcRenderer.invoke(IPC.watchLinkRevoke, linkId),
      revokeAll: () => ipcRenderer.invoke(IPC.watchLinkRevokeAll),
      kick: (linkId, viewerId) => ipcRenderer.invoke(IPC.watchLinkKick, linkId, viewerId),
      sendChat: (linkId, text) => ipcRenderer.invoke(IPC.watchLinkChatSend, linkId, text),
      chatHistory: (linkId) => ipcRenderer.invoke(IPC.watchLinkChatHistory, linkId),
      onState: subscribeWatchLinkState,
      onChat: (cb) => {
        const handler = (_e: unknown, linkId: string, msg: Parameters<typeof cb>[1]) => cb(linkId, msg)
        ipcRenderer.on(IPC.watchLinkChat, handler)
        return () => ipcRenderer.removeListener(IPC.watchLinkChat, handler)
      },
      onNotice: subscribeWatchLinkNotice
    },
```

with, next to the other `subscribe<…>(…)` constants: `const subscribeWatchLinkState = subscribe<[WatchLinkView[]]>(IPC.watchLinkState)` and `const subscribeWatchLinkNotice = subscribe<[WatchLinkNotice]>(IPC.watchLinkNotice)` (types from `@shared/watch-link-types`).

`src/renderer/bridge/ws-bridge.ts` — a separate builder, NOT in the scoped-guest guard list and not spread into relay tabs:

```ts
export function buildWatchLinkApi(client: RpcClient): Pick<NodeTerminalApi, 'watchLink'> {
  return {
    watchLink: {
      create: (req) => client.request(IPC.watchLinkCreate, req) as Promise<CreateWatchLinkResult>,
      list: () => (client.request(IPC.watchLinkList) as Promise<WatchLinkView[]>).catch(() => []),
      revoke: async (linkId) => { await client.request(IPC.watchLinkRevoke, linkId) },
      revokeAll: async () => { await client.request(IPC.watchLinkRevokeAll) },
      kick: (linkId, viewerId) => (client.request(IPC.watchLinkKick, linkId, viewerId) as Promise<boolean>).catch(() => false),
      sendChat: (linkId, text) => (client.request(IPC.watchLinkChatSend, linkId, text) as Promise<WatchChatMessage | null>).catch(() => null),
      chatHistory: (linkId) => (client.request(IPC.watchLinkChatHistory, linkId) as Promise<WatchChatMessage[]>).catch(() => []),
      onState: (cb) => client.subscribe(IPC.watchLinkState, ((links: WatchLinkView[]) => cb(links)) as Listener),
      onChat: (cb) => client.subscribe(IPC.watchLinkChat, ((id: string, m: WatchChatMessage) => cb(id, m)) as Listener),
      onNotice: (cb) => client.subscribe(IPC.watchLinkNotice, ((n: WatchLinkNotice) => cb(n)) as Listener)
    }
  }
}
```

and spread `...buildWatchLinkApi(client)` into `installWsBridge`'s `api` object next to `buildSessionMemoryApi(client)`.

`src/renderer/bridge/stubs.ts`, inside `buildStubApi()`:

```ts
    // Live links are created on the machine that runs the terminal. The Server Edition overrides
    // this with the real bridge (buildWatchLinkApi); a relay tab keeps it — the peer's terminals
    // are not this machine's to publish.
    watchLink: {
      create: async () => ({ ok: false, error: 'unsupported' }),
      list: async () => [],
      revoke: async () => {},
      revokeAll: async () => {},
      kick: async () => false,
      sendChat: async () => null,
      chatHistory: async () => [],
      onState: noopUnsub,
      onChat: noopUnsub,
      onNotice: noopUnsub
    },
```

`src/renderer/bridge/relay-api.ts`, beside `stationNotice: stub.stationNotice`:

```ts
      // Live links publish THIS machine's terminals; a relay tab shows another machine's.
      watchLink: stub.watchLink,
```

- [ ] **Step 4: Wire the desktop (`src/main/index.ts`)**

Near the other core services (after `workspaceStore` has loaded and `ptyManager`/`sshProjectManager` exist — place it beside `startSessionMemoryService`):

```ts
  // Live links (docs/live-links.md): a Pro, read-only, expiring browser link to one terminal.
  watchLinks = createWatchLinkService({
    api: createWatchLinkApi({ apiBase: API_BASE }),
    relayUrl: RELAY_URL,
    store: new WatchLinkStore({
      file: join(app.getPath('userData'), 'watch-links.json'),
      seal: corePlatform.sealSecret?.bind(corePlatform),
      unseal: corePlatform.unsealSecret?.bind(corePlatform)
    }),
    entitlement: getStoredEntitlement,
    relayAllowed,
    nodeExists: (nodeId) => workspaceStore.projectIdsForNode(nodeId).length > 0,
    clients: {
      attach: (sink) => {
        const id = allocateRelayClientId()
        registerPeerSink(id, sink, { quiet: true, selfPaced: true })
        return id
      },
      detach: (id) => unregisterPeerSink(id)
    },
    pty: {
      join: async (clientId, nodeId, viewerId) => {
        const size = ptyManager.watchSizeFor(nodeId) ?? { cols: 80, rows: 24 }
        const projectId = workspaceStore.sshProjectIdForNode(nodeId)
        const ref = projectId ? sshProjectManager?.refForProject(projectId) : undefined
        const res = await ptyManager.joinAsWatcher(clientId, {
          persistKey: nodeId, viewerId, ...size,
          ...(projectId ? { requireRemote: true } : {}),
          ...(ref ? { sshRemote: { conn: ref.conn, controlPath: ref.controlPath, remoteCwd: ref.remoteCwd ?? '~' } } : {})
        })
        if (!res.sessionId) return null
        const now = ptyManager.watchSizeFor(nodeId) ?? size
        return { sessionId: res.sessionId, cols: now.cols, rows: now.rows, altScreen: res.tmuxClient === true }
      },
      leave: (clientId, sessionId, viewerId) => ptyManager.kill(clientId, sessionId, viewerId),
      captureVisible: (sessionId) => ptyManager.captureVisible(sessionId)
    },
    emit: (channel, ...args) => sendToOwners(corePlatform, channel, ...args)
  })
  registerWatchLinkIpc(corePlatform, watchLinks)
  void watchLinks.init()
```

Imports: `createWatchLinkService`, `registerWatchLinkIpc`, `sendToOwners` from `../core/watch-link/service`; `createWatchLinkApi` from `../core/watch-link/api`; `WatchLinkStore` from `../core/watch-link/store`; `getStoredEntitlement` from `../core/license`; `API_BASE`, `RELAY_URL`, `relayAllowed` from `./remote/host-service`; `allocateRelayClientId` from `../core/presence/hub`; `registerPeerSink`, `unregisterPeerSink` from `./peer-registry`. `corePlatform` is the `CorePlatform` instance `index.ts` already passes to `registerStationNoticeIpc(corePlatform, …)`.

Chain the workspace hook — edit the existing assignment `workspaceStore.onPersist = () => { workspaceWatcher.sync(); refreshNodeTokens() }` to:

```ts
workspaceStore.onPersist = () => { workspaceWatcher.sync(); refreshNodeTokens(); watchLinks?.onWorkspaceChanged() }
```

(Declare `let watchLinks: WatchLinkService | null = null` at module level, near the other late-bound services, and ASSIGN it in the block above — the `onPersist` closure and the quit handler then read it at call time, the same TDZ-avoidance `geminiPathFor` uses. After the assignment `watchLinks` is narrowed to non-null, so `registerWatchLinkIpc(corePlatform, watchLinks)` and `void watchLinks.init()` typecheck.) In the main `app.on('before-quit', …)` handler, add `watchLinks?.shutdown()` beside the other teardown calls.

`unregisterPeerSink` calls `presenceHub.leave(id)` for an id that never joined presence; that must be a no-op — confirm by reading `presenceHub.leave` (it deletes from a map). `onPeerGone` then runs `ptyManager.dropClient(id)`, which is exactly the teardown a viewer needs.

- [ ] **Step 5: Wire the Server Edition (`src/server/index.ts`)**

After the hosted-team block (the platform, `ptyManager` and `workspaceStore` are loaded there):

```ts
  // Live links. The Server Edition has no SSH-project manager, so a remote node is joinable only
  // while this core holds it live (join-only never spawns); no keychain, so secrets are 0600 raw.
  const watchLinks = createWatchLinkService({
    api: createWatchLinkApi({ apiBase: process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev' }),
    relayUrl: process.env.NODETERM_RELAY_URL || 'wss://relay.nodeterm.dev',
    store: new WatchLinkStore({ file: join(dataDir, 'watch-links.json') }),
    entitlement: getStoredEntitlement,
    relayAllowed: () => true,
    nodeExists: (nodeId) => workspaceStore.projectIdsForNode(nodeId).length > 0,
    clients: {
      attach: (sink) => platform.attach(sink, { quiet: true, selfPaced: true }),
      detach: (id) => { ptyManager.dropClient(id); platform.detach(id) }
    },
    pty: {
      join: async (clientId, nodeId, viewerId) => {
        const size = ptyManager.watchSizeFor(nodeId) ?? { cols: 80, rows: 24 }
        const res = await ptyManager.joinAsWatcher(clientId, { persistKey: nodeId, viewerId, ...size })
        if (!res.sessionId) return null
        const now = ptyManager.watchSizeFor(nodeId) ?? size
        return { sessionId: res.sessionId, cols: now.cols, rows: now.rows, altScreen: res.tmuxClient === true }
      },
      leave: (clientId, sessionId, viewerId) => ptyManager.kill(clientId, sessionId, viewerId),
      captureVisible: (sessionId) => ptyManager.captureVisible(sessionId)
    },
    emit: (channel, ...args) => sendToOwners(platform, channel, ...args)
  })
  registerWatchLinkIpc(platform, watchLinks)
  void watchLinks.init()
```

Use the name this file already gives the data directory (it is the one passed to `WorkspaceStore`/`hosted` as `dataDir`). Add `watchLinks.onWorkspaceChanged()` to the existing `workspaceStore.onPersist = () => { … }` closure, and `watchLinks.shutdown()` to both shutdown paths beside `speechService.shutdown()`. If another server already owns this data dir and the hosted relay decided not to host (the "NOT started — another nodeterm server" branch), skip `watchLinks.init()` and log `Live links: NOT started — another nodeterm server owns this data directory.` — reuse that branch's condition variable.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/main/watch-link-wiring.test.ts src/renderer/bridge src/core/relay/scoped-guest-policy.guard.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit (includes Task 12's files if not yet committed)**

```bash
git add src/main src/server src/preload src/renderer/bridge src/shared src/core/watch-link
git commit -m "feat(watch-link): wire the service into both shells and the renderer bridges"
```

---

### Task 14: Guard tests — link state is never canvas content, the chip cannot be hidden, no agent verb

**Files:**
- Create: `src/renderer/lib/live-link.guard.test.ts` (renderer-side, so importing `ui-visibility` does not reach across the core boundary)

- [ ] **Step 1: Write the guard**

```ts
// Rules no single unit can see. Each is a way a live link turns into a leak.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HIDEABLE_HEADER_BUTTONS, HIDEABLE_MENU_ITEMS } from './ui-visibility'

const root = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')
function block(src: string, header: RegExp): string {
  const m = header.exec(src)
  if (!m) throw new Error(`not found: ${header}`)
  const start = m.index
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end)
}

describe('live-link guards', () => {
  it('no canvas content type carries link state (canvas sync + the authority would publish it)', () => {
    const types = read('src/shared/types.ts')
    for (const h of [/export interface CanvasNodeState\b/, /export interface ProjectKanban\b/]) {
      expect(block(types, h)).not.toMatch(/watchLink|liveLink|watch_link/i)
    }
    expect(read('src/shared/canvas-mutations.ts')).not.toMatch(/watchLink|liveLink/i)
  })
  it('the LIVE chip is not user-hideable', () => {
    const ids = [...HIDEABLE_HEADER_BUTTONS, ...HIDEABLE_MENU_ITEMS].map((r) => r.id)
    expect(ids).not.toContain('live-chip')
    const node = read('src/renderer/nodes/TerminalNode.tsx')
    const line = node.split('\n').find((l) => l.includes('<LiveLinkChip'))
    expect(line).toBeDefined()
    expect(line).not.toMatch(/isHidden/)
  })
  it('no canvas-control verb can publish a terminal', () => {
    expect(read('src/main/canvas-control-core.ts')).not.toMatch(/watchLink|live link/i)
  })
})
```

- [ ] **Step 2: Run** — `npx vitest run src/renderer/lib/live-link.guard.test.ts`. Expected: the chip assertion FAILS until Task 16 adds `<LiveLinkChip` to TerminalNode; the other two PASS. Mark the chip test `it.todo`-free: keep it, and commit this file together with Task 16.

---

### Task 15: Renderer state and pure helpers

**Files:**
- Create: `src/renderer/state/watchLinks.ts`, `src/renderer/lib/liveLink.ts`
- Test: `src/renderer/state/watchLinks.test.ts`, `src/renderer/lib/liveLink.test.ts`

**Interfaces:**
- Produces:
  - `useWatchLinks` zustand store: `{ links: WatchLinkView[]; byNode: Record<string, WatchLinkView[]>; chats: Record<string, WatchChatMessage[]>; unread: Record<string, number>; setLinks(l): void; addChat(linkId, msg): void; setChat(linkId, msgs): void; markRead(linkId): void }`; `EMPTY_LINKS`; `startWatchLinkSync(api: Pick<NodeTerminalApi, 'watchLink'>, onNotice: (n: WatchLinkNotice) => void): () => void`.
  - `lib/liveLink.ts`: `chipView(links: WatchLinkView[]): { label: string; tone: 'live' | 'offline' | 'refused'; title: string }`, `formatRemaining(expiresAt: number, now: number): string`, `ROLE_LABEL: Record<WatchLinkRole, string>`, `TTL_OPTIONS: { value: WatchLinkTtl; label: string }[]`, `createErrorMessage(e: CreateWatchLinkError): string`, `noticeText(n: WatchLinkNotice): string | null`, `shareDisabledReason(o: { relayTab: boolean; activeLinks: number }): string | null`, `LIVE_LINK_WARNING`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/lib/liveLink.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { chipView, formatRemaining, createErrorMessage, noticeText, shareDisabledReason, TTL_OPTIONS, ROLE_LABEL } from './liveLink'
import type { WatchLinkView } from '@shared/watch-link-types'

const link = (over: Partial<WatchLinkView> = {}): WatchLinkView => ({
  linkId: 'L', nodeId: 'n', role: 'viewer', label: 'Ada', title: 't', createdAt: 0, expiresAt: 0, url: 'u', status: 'live', viewers: [], ...over
})

describe('liveLink helpers', () => {
  it('chip label and tone', () => {
    expect(chipView([link()])).toMatchObject({ label: 'LIVE', tone: 'live' })
    expect(chipView([link({ viewers: [{ viewerId: 'a', name: null, joinedAt: 0 }] }), link({ viewers: [{ viewerId: 'b', name: null, joinedAt: 0 }] })])).toMatchObject({ label: 'LIVE · 2', tone: 'live' })
    expect(chipView([link({ status: 'reconnecting' })])).toMatchObject({ label: 'LIVE · offline', tone: 'offline' })
    expect(chipView([link({ status: 'refused' }), link({ status: 'reconnecting' })])).toMatchObject({ label: 'LIVE · refused', tone: 'refused' })
  })
  it('remaining time', () => {
    expect(formatRemaining(60 * 60_000 + 1, 0)).toBe('ends in 1 h')
    expect(formatRemaining(42 * 60_000, 0)).toBe('ends in 42 min')
    expect(formatRemaining(30_000, 0)).toBe('ends in under a minute')
    expect(formatRemaining(0, 5)).toBe('ended')
  })
  it('copy for every create error, and the fixed option lists', () => {
    for (const e of ['not-entitled', 'limit-machine', 'limit-active', 'limit-daily', 'rate-limited', 'network', 'license-check', 'relay-unavailable', 'node-missing', 'bad-request', 'persist-failed', 'unsupported'] as const) {
      expect(createErrorMessage(e).length).toBeGreaterThan(10)
    }
    expect(createErrorMessage('network')).toBe("Couldn't reach nodeterm's service. Nothing was shared.")
    expect(TTL_OPTIONS.map((o) => o.value)).toEqual([900, 3600, 28800, 86400])
    expect(ROLE_LABEL).toEqual({ viewer: 'Can watch', commenter: 'Can watch and chat' })
  })
  it('notices and disabled reasons', () => {
    expect(noticeText({ kind: 'joined', linkId: 'L', nodeId: 'n', title: 'build', viewers: 2 })).toBe('Someone started watching build (2 watching).')
    expect(noticeText({ kind: 'ended', linkId: 'L', nodeId: 'n', title: 'build', reason: 'expired' })).toBe('The live link to build expired.')
    expect(shareDisabledReason({ relayTab: true, activeLinks: 0 })).toBe('Live links are created on the machine that runs this terminal.')
    expect(shareDisabledReason({ relayTab: false, activeLinks: 5 })).toBe('Stop a live link first — 5 can be active at once.')
    expect(shareDisabledReason({ relayTab: false, activeLinks: 4 })).toBeNull()
  })
})
```

`src/renderer/state/watchLinks.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useWatchLinks, startWatchLinkSync } from './watchLinks'
import type { WatchLinkView } from '@shared/watch-link-types'

const link = (id: string, nodeId: string): WatchLinkView => ({ linkId: id, nodeId, role: 'commenter', label: 'A', title: 't', createdAt: 0, expiresAt: 0, url: 'u', status: 'live', viewers: [] })
beforeEach(() => useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {} }))

describe('watchLinks store', () => {
  it('indexes by node and keeps stable references between updates', () => {
    useWatchLinks.getState().setLinks([link('a', 'n1'), link('b', 'n1'), link('c', 'n2')])
    const s = useWatchLinks.getState()
    expect(s.byNode.n1.map((l) => l.linkId)).toEqual(['a', 'b'])
    expect(s.byNode.n2.map((l) => l.linkId)).toEqual(['c'])
  })
  it('counts unread viewer messages, not the sharer\'s own', () => {
    const s = useWatchLinks.getState()
    s.addChat('a', { id: '1', name: 'V', text: 'hi', at: 0, from: 'viewer' })
    s.addChat('a', { id: '2', name: 'A', text: 'yo', at: 1, from: 'sharer' })
    expect(useWatchLinks.getState().unread.a).toBe(1)
    useWatchLinks.getState().markRead('a')
    expect(useWatchLinks.getState().unread.a).toBe(0)
  })
  it('sync hydrates from list() and follows state and chat events', async () => {
    let state: ((l: WatchLinkView[]) => void) | null = null
    let chat: ((id: string, m: never) => void) | null = null
    const stop = startWatchLinkSync({
      watchLink: {
        list: async () => [link('a', 'n1')],
        onState: (cb) => { state = cb; return () => {} },
        onChat: (cb) => { chat = cb as never; return () => {} },
        onNotice: () => () => {}
      } as never
    }, () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(useWatchLinks.getState().links).toHaveLength(1)
    state!([])
    expect(useWatchLinks.getState().links).toHaveLength(0)
    chat!('a', { id: '1', name: 'V', text: 'x', at: 0, from: 'viewer' } as never)
    expect(useWatchLinks.getState().chats.a).toHaveLength(1)
    stop()
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

`src/renderer/lib/liveLink.ts`:

```ts
// Pure copy and decisions for live links (renderer). One place for every sentence the owner reads.
import type { CreateWatchLinkError, WatchLinkNotice, WatchLinkRole, WatchLinkTtl, WatchLinkView } from '@shared/watch-link-types'
import { MAX_LINKS_PER_MACHINE } from '@shared/watch-link-types'

export const ROLE_LABEL: Record<WatchLinkRole, string> = { viewer: 'Can watch', commenter: 'Can watch and chat' }
export const TTL_OPTIONS: { value: WatchLinkTtl; label: string }[] = [
  { value: 900, label: '15 min' },
  { value: 3600, label: '1 hour' },
  { value: 28800, label: '8 hours' },
  { value: 86400, label: '24 hours' }
]
export const DEFAULT_TTL: WatchLinkTtl = 3600
export const LIVE_LINK_WARNING =
  "Anyone with the link sees everything this terminal shows: what's on screen now, anything printed later (tokens, env dumps), and anything you scroll back to. They can't type or resize it."
export const KICK_NOTE = 'Kick ends this connection; anyone with the link can rejoin. Stop sharing to end it for everyone.'

export function chipView(links: WatchLinkView[]): { label: string; tone: 'live' | 'offline' | 'refused'; title: string } {
  const viewers = links.reduce((n, l) => n + l.viewers.length, 0)
  if (links.some((l) => l.status === 'refused')) {
    return { label: 'LIVE · refused', tone: 'refused', title: "nodeterm's service refused this live link. Open it to see why." }
  }
  if (links.some((l) => l.status === 'reconnecting')) {
    return { label: 'LIVE · offline', tone: 'offline', title: 'This terminal is shared by a live link that is reconnecting.' }
  }
  return {
    label: viewers > 0 ? `LIVE · ${viewers}` : 'LIVE',
    tone: 'live',
    title: viewers > 0 ? `This terminal is shared by a live link — ${viewers} watching.` : 'This terminal is shared by a live link.'
  }
}

export function formatRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'ended'
  if (ms < 60_000) return 'ends in under a minute'
  const min = Math.floor(ms / 60_000)
  return min >= 60 ? `ends in ${Math.floor(min / 60)} h` : `ends in ${min} min`
}

export function createErrorMessage(e: CreateWatchLinkError): string {
  switch (e) {
    case 'not-entitled': return 'Live links need an active Pro plan.'
    case 'limit-machine': return `Stop a live link first — ${MAX_LINKS_PER_MACHINE} can be active at once.`
    case 'limit-active': return 'Your license already has 15 active live links. Stop one first.'
    case 'limit-daily': return 'Your license created 50 live links in the last day. Try again later.'
    case 'rate-limited': return "nodeterm's service is limiting requests from this network. Try again in a minute."
    case 'network': return "Couldn't reach nodeterm's service. Nothing was shared."
    case 'license-check': return "nodeterm's service couldn't confirm your license right now. Nothing was shared; try again shortly."
    case 'relay-unavailable': return 'Live links need the installed app.'
    case 'node-missing': return 'That terminal is no longer on any canvas.'
    case 'bad-request': return 'That live link request was not valid.'
    case 'persist-failed': return "The link could not be saved on this machine, so it was stopped. Nothing was shared."
    case 'unsupported': return 'Live links are created on the machine that runs this terminal.'
  }
}

export function noticeText(n: WatchLinkNotice): string | null {
  if (n.kind === 'joined') return `Someone started watching ${n.title} (${n.viewers} watching).`
  if (n.kind === 'not-persistent') return "Live links can't be saved on this machine (secure storage is unavailable). They work until you quit."
  if (n.reason === 'expired') return `The live link to ${n.title} expired.`
  if (n.reason === 'node-gone') return `The live link to ${n.title} ended — the terminal was closed.`
  return `The live link to ${n.title} was stopped by nodeterm's service.`
}

export function shareDisabledReason(o: { relayTab: boolean; activeLinks: number }): string | null {
  if (o.relayTab) return 'Live links are created on the machine that runs this terminal.'
  if (o.activeLinks >= MAX_LINKS_PER_MACHINE) return `Stop a live link first — ${MAX_LINKS_PER_MACHINE} can be active at once.`
  return null
}
```

`src/renderer/state/watchLinks.ts`:

```ts
// Transient renderer mirror of the core's live links, fed by `watchLink:state`/`watchLink:chat`.
// Machine-local by construction: nothing here is ever serialized into a project (link state is not
// canvas content — see lib/live-link.guard.test.ts).
import { create } from 'zustand'
import type { NodeTerminalApi } from '@shared/types'
import type { WatchChatMessage, WatchLinkNotice, WatchLinkView } from '@shared/watch-link-types'

export const EMPTY_LINKS: WatchLinkView[] = []
const CHAT_KEEP = 200

interface WatchLinksState {
  links: WatchLinkView[]
  byNode: Record<string, WatchLinkView[]>
  chats: Record<string, WatchChatMessage[]>
  unread: Record<string, number>
  setLinks(links: WatchLinkView[]): void
  addChat(linkId: string, msg: WatchChatMessage): void
  setChat(linkId: string, msgs: WatchChatMessage[]): void
  markRead(linkId: string): void
}

export const useWatchLinks = create<WatchLinksState>((set) => ({
  links: [],
  byNode: {},
  chats: {},
  unread: {},
  setLinks: (links) => {
    const byNode: Record<string, WatchLinkView[]> = {}
    for (const l of links) (byNode[l.nodeId] ??= []).push(l)
    set({ links, byNode })
  },
  addChat: (linkId, msg) =>
    set((s) => ({
      chats: { ...s.chats, [linkId]: [...(s.chats[linkId] ?? []), msg].slice(-CHAT_KEEP) },
      unread: msg.from === 'viewer' ? { ...s.unread, [linkId]: (s.unread[linkId] ?? 0) + 1 } : s.unread
    })),
  setChat: (linkId, msgs) => set((s) => ({ chats: { ...s.chats, [linkId]: msgs.slice(-CHAT_KEEP) } })),
  markRead: (linkId) => set((s) => ({ unread: { ...s.unread, [linkId]: 0 } }))
}))

export function startWatchLinkSync(api: Pick<NodeTerminalApi, 'watchLink'>, onNotice: (n: WatchLinkNotice) => void): () => void {
  const s = useWatchLinks.getState()
  const offState = api.watchLink.onState((links) => useWatchLinks.getState().setLinks(links))
  const offChat = api.watchLink.onChat((id, msg) => useWatchLinks.getState().addChat(id, msg))
  const offNotice = api.watchLink.onNotice(onNotice)
  void api.watchLink.list().then((links) => s.setLinks(links), () => {})
  return () => {
    offState()
    offChat()
    offNotice()
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/renderer/lib/liveLink.test.ts src/renderer/state/watchLinks.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/watchLinks.ts src/renderer/lib/liveLink.ts src/renderer/state/watchLinks.test.ts src/renderer/lib/liveLink.test.ts
git commit -m "feat(live-link): renderer store and the copy the owner reads"
```

---

### Task 16: `LiveLinkChip` + popover on the four surfaces

**Files:**
- Create: `src/renderer/components/LiveLinkChip.tsx`, `src/renderer/components/LiveLinkPopover.tsx`
- Modify: `src/renderer/nodes/TerminalNode.tsx` (beside `<PresenceChips nodeId={id} />`), `src/renderer/components/kanban/SessionCard.tsx` (detail row + `hasDetail`), `src/renderer/components/kanban/CardModal.tsx` (chips block), `src/renderer/components/SessionRow.tsx` (after `AccountChip`), `src/renderer/styles.css`
- Test: `src/renderer/components/LiveLinkChip.test.tsx`; commit Task 14's guard with this task.

**Interfaces:**
- Produces: `LiveLinkChip({ nodeId, className }: { nodeId: string; className?: string })` — renders nothing without a link; `LiveLinkPopover({ nodeId, anchor, onClose })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveLinkChip } from './LiveLinkChip'
import { useWatchLinks } from '../state/watchLinks'

beforeEach(() => useWatchLinks.setState({ links: [], byNode: {}, chats: {}, unread: {} }))

describe('LiveLinkChip', () => {
  it('renders nothing for a node with no link', () => {
    expect(renderToStaticMarkup(<LiveLinkChip nodeId="n1" />)).toBe('')
  })
  it('shows LIVE with the viewer count, as a no-drag button', () => {
    useWatchLinks.getState().setLinks([{ linkId: 'L', nodeId: 'n1', role: 'viewer', label: 'A', title: 't', createdAt: 0, expiresAt: 0, url: 'u', status: 'live', viewers: [{ viewerId: 'v', name: null, joinedAt: 0 }] }])
    const html = renderToStaticMarkup(<LiveLinkChip nodeId="n1" />)
    expect(html).toContain('LIVE · 1')
    expect(html).toContain('nodrag')
    expect(html).toContain('live-chip--live')
  })
})
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement the chip and popover**

`src/renderer/components/LiveLinkChip.tsx`:

```tsx
// "This terminal is being broadcast." One component for the node header, the kanban card, the card
// modal and the sessions sidebar row, so one session seen four times speaks with one voice. It is
// deliberately NOT user-hideable (live-link.guard.test.ts): it is the owner's signal.
import { useState } from 'react'
import { chipView } from '../lib/liveLink'
import { EMPTY_LINKS, useWatchLinks } from '../state/watchLinks'
import { LiveLinkPopover } from './LiveLinkPopover'

export function LiveLinkChip({ nodeId, className }: { nodeId: string; className?: string }): React.JSX.Element | null {
  const links = useWatchLinks((s) => s.byNode[nodeId] ?? EMPTY_LINKS)
  const unread = useWatchLinks((s) => (s.byNode[nodeId] ?? EMPTY_LINKS).reduce((n, l) => n + (s.unread[l.linkId] ?? 0), 0))
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  if (links.length === 0) return null
  const view = chipView(links)
  return (
    <>
      <button
        type="button"
        className={`live-chip live-chip--${view.tone} nodrag ${className ?? ''}`}
        title={view.title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          setAnchor(e.currentTarget.getBoundingClientRect())
        }}
      >
        <span className="live-chip__dot" aria-hidden="true" />
        {view.label}
        {unread > 0 && <span className="live-chip__unread" aria-label={`${unread} unread`} />}
      </button>
      {anchor && <LiveLinkPopover nodeId={nodeId} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  )
}
```

`src/renderer/components/LiveLinkPopover.tsx`:

```tsx
// Per-link controls for one node: copy, stop, the viewer list with Kick, and — for chat links — the
// thread with a reply box and "Copy to card comments" (the owner's explicit act; nothing a viewer
// writes is ever stored automatically, spec D2).
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { formatRemaining, KICK_NOTE, ROLE_LABEL } from '../lib/liveLink'
import { EMPTY_LINKS, useWatchLinks } from '../state/watchLinks'
import { useBoardLog } from '../state/boardLog'
import { useProjects } from '../state/projects'
import type { WatchChatMessage } from '@shared/watch-link-types'

const EMPTY_CHAT: WatchChatMessage[] = []

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function LiveLinkPopover({ nodeId, anchor, onClose }: { nodeId: string; anchor: DOMRect; onClose: () => void }): React.JSX.Element {
  const links = useWatchLinks((s) => s.byNode[nodeId] ?? EMPTY_LINKS)
  const isTop = useDialogStack()
  const now = useNow(30_000)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onClose])
  useEffect(() => {
    if (links.length === 0) onClose()
  }, [links.length, onClose])
  const top = Math.min(anchor.bottom + 6, window.innerHeight - 40)
  const left = Math.min(anchor.left, window.innerWidth - 360)
  return createPortal(
    <div className="live-pop__scrim" onPointerDown={onClose}>
      <div className="live-pop nodrag" style={{ top, left }} onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Live links">
        {links.map((l) => (
          <LinkBlock key={l.linkId} linkId={l.linkId} now={now} nodeId={nodeId} />
        ))}
      </div>
    </div>,
    document.body
  )
}

function LinkBlock({ linkId, now, nodeId }: { linkId: string; now: number; nodeId: string }): React.JSX.Element | null {
  const link = useWatchLinks((s) => s.links.find((l) => l.linkId === linkId))
  const chat = useWatchLinks((s) => s.chats[linkId] ?? EMPTY_CHAT)
  const [draft, setDraft] = useState('')
  const api = window.nodeTerminal.watchLink
  useEffect(() => {
    if (link?.role !== 'commenter') return
    useWatchLinks.getState().markRead(linkId)
    void api.chatHistory(linkId).then((m) => useWatchLinks.getState().setChat(linkId, m), () => {})
  }, [api, linkId, link?.role])
  if (!link) return null
  const projectId = useProjects.getState().projects.find((p) => p.nodes.some((n) => n.id === nodeId))?.id
  return (
    <section className="live-pop__link">
      <header className="live-pop__head">
        <span className="live-pop__role">{ROLE_LABEL[link.role]}</span>
        <span className="live-pop__time">{formatRemaining(link.expiresAt, now)}</span>
      </header>
      <div className="live-pop__actions">
        <button type="button" onClick={() => window.nodeTerminal.clipboard.writeText(link.url)}>Copy link</button>
        <button type="button" className="danger" onClick={() => void api.revoke(link.linkId)}>Stop sharing</button>
      </div>
      <div className="live-pop__viewers">
        {link.viewers.length === 0 ? (
          <p className="live-pop__muted">Nobody is watching right now.</p>
        ) : (
          <>
            <ul>
              {link.viewers.map((v, i) => (
                <li key={v.viewerId}>
                  <span>{v.name ?? `Viewer ${i + 1}`}</span>
                  <span className="live-pop__muted">since {new Date(v.joinedAt).toLocaleTimeString()}</span>
                  <button type="button" title={KICK_NOTE} onClick={() => void api.kick(link.linkId, v.viewerId)}>Kick</button>
                </li>
              ))}
            </ul>
            <p className="live-pop__muted live-pop__note">{KICK_NOTE}</p>
          </>
        )}
      </div>
      {link.role === 'commenter' && (
        <div className="live-pop__chat">
          <ol>
            {chat.map((m) => (
              <li key={m.id} className={m.from === 'sharer' ? 'live-pop__mine' : undefined}>
                <strong>{m.name}</strong> <span className="live-pop__muted">({m.from === 'sharer' ? 'sharer' : 'link viewer'})</span>
                <span className="live-pop__text">{m.text}</span>
                {projectId && m.from === 'viewer' && (
                  <button
                    type="button"
                    className="live-pop__copy"
                    onClick={() => useBoardLog.getState().append(window.nodeTerminal, projectId, { kind: 'comment', nodeId, text: `${m.name} (via live link): ${m.text}` })}
                  >
                    Copy to card comments
                  </button>
                )}
              </li>
            ))}
          </ol>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const text = draft.trim()
              if (!text) return
              void api.sendChat(link.linkId, text)
              setDraft('')
            }}
          >
            <input value={draft} maxLength={500} placeholder="Reply to viewers…" onChange={(e) => setDraft(e.target.value)} />
          </form>
        </div>
      )}
    </section>
  )
}
```

(If `BoardLogAppendInput` requires `event`, pass `event: undefined`; the typecheck decides.)

- [ ] **Step 4: Place the chip on the four surfaces**

- `TerminalNode.tsx`: directly after `<PresenceChips nodeId={id} />` add `<LiveLinkChip nodeId={id} />` (import from `../components/LiveLinkChip`). One line, no `isHidden` around it.
- `SessionCard.tsx`: add `const hasLiveLink = useWatchLinks((s) => (s.byNode[session.id]?.length ?? 0) > 0)`; extend `hasDetail` with `|| hasLiveLink`; inside the non-sticky detail fragment, after `<AccountChip chip={accountChip} />`, add `<LiveLinkChip nodeId={session.id} className="kanban-card__live" />`.
- `CardModal.tsx`: in the chips block, after `{isTerminal && <AccountChip chip={accountChip} />}`, add `{isTerminal && <LiveLinkChip nodeId={session.id} className="kanban-modal__live" />}`.
- `SessionRow.tsx`: after `<AccountChip chip={accountChip} className="ss-account" />` add `<LiveLinkChip nodeId={row.id} className="ss-live" />`.

- [ ] **Step 5: Styles**

Append to `src/renderer/styles.css` (tokens only — CLAUDE.md "Semantic colours"; the dot uses `--state-error`, the text stays ink):

```css
/* Live link chip — a broadcast indicator: red dot, ink label, never animated beyond the dot. */
.live-chip { display: inline-flex; align-items: center; gap: 5px; height: 18px; padding: 0 7px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--state-error) 45%, transparent);
  background: color-mix(in srgb, var(--state-error) 12%, transparent); color: var(--text); font-size: 10.5px;
  font-weight: 600; letter-spacing: 0.02em; cursor: pointer; white-space: nowrap; }
.live-chip__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--state-error); }
.live-chip--offline { border-color: color-mix(in srgb, var(--state-warning) 45%, transparent); background: color-mix(in srgb, var(--state-warning) 12%, transparent); }
.live-chip--offline .live-chip__dot { background: var(--state-warning); }
.live-chip--refused { opacity: 0.75; }
.live-chip__unread { width: 6px; height: 6px; border-radius: 50%; background: var(--state-unread); }
.live-pop__scrim { position: fixed; inset: 0; z-index: 61; }
.live-pop { position: fixed; width: 340px; max-height: 70vh; overflow: auto; padding: 10px; border-radius: 10px;
  background: var(--panel); border: 1px solid var(--line); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35); color: var(--text); font-size: 12px; }
.live-pop__link + .live-pop__link { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 8px; }
.live-pop__head, .live-pop__actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.live-pop__actions { justify-content: flex-start; margin: 6px 0; }
.live-pop__muted { color: var(--muted); }
.live-pop__viewers ul, .live-pop__chat ol { list-style: none; margin: 4px 0; padding: 0; }
.live-pop__viewers li { display: flex; gap: 6px; align-items: center; }
.live-pop__viewers li button { margin-left: auto; }
.live-pop__chat li { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
.live-pop__text { flex-basis: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
.live-pop__chat input { width: 100%; }
```

Use the token names that exist in `styles.css` (`--state-error`, `--state-warning`, `--state-unread`, `--panel`, `--line`, `--muted`, `--text`); if one is named differently, use the existing semantic token for the same meaning — `styles.palette.test.ts` must stay green.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/renderer/components/LiveLinkChip.test.tsx src/renderer/lib/live-link.guard.test.ts src/renderer/components/kanban src/renderer/components/SessionRow.test.tsx && npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer
git commit -m "feat(live-link): the LIVE chip and its popover on the node, card, card modal and sidebar"
```

---

### Task 17: Entry points — dialog, menus, card modal action, palette, Pro gate, ProCompare, Settings

**Files:**
- Create: `src/renderer/components/LiveLinkDialog.tsx`, `src/renderer/components/settings/sections/LiveLinksSection.tsx`
- Modify: `src/renderer/canvas/Canvas.tsx`, `src/renderer/components/kanban/KanbanView.tsx` (`liveLinkMenuItems` prop), `src/renderer/components/kanban/CardModal.tsx` (action button), `src/renderer/lib/ui-visibility.ts` (+ its test), `src/renderer/components/settings/{nav.ts,nav.test.ts,SettingsIcons.tsx,SettingsPage.tsx}`, `src/renderer/components/settings/sections/ProCompare.tsx`
- Test: `src/renderer/components/LiveLinkDialog.test.tsx`, `src/renderer/lib/ui-visibility.test.ts`, `src/renderer/components/settings/nav.test.ts`, `src/renderer/lib/nodeterm-events.test.ts` (must stay green: the new `nodeterm:live-link` event has a listener)

**Interfaces:**
- Produces: `LiveLinkDialog({ nodeId, title, onClose })`; window event `nodeterm:live-link` with `detail: { nodeId: string; title: string }`; settings section id `'live-links'`; hideable menu id `'live-link'`.

- [ ] **Step 1: Write the failing tests**

`src/renderer/components/LiveLinkDialog.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LiveLinkDialogBody } from './LiveLinkDialog'
import { LIVE_LINK_WARNING } from '../lib/liveLink'

describe('LiveLinkDialogBody', () => {
  it('shows the role and expiry choices with the defaults, and the warning always', () => {
    const html = renderToStaticMarkup(
      <LiveLinkDialogBody title="build" state={{ phase: 'form', role: 'viewer', ttl: 3600, label: 'Ada', busy: false, error: null }} onChange={() => {}} onSubmit={() => {}} onClose={() => {}} onStop={() => {}} />
    )
    expect(html).toContain('Share a live link to build')
    expect(html).toContain('Can watch')
    expect(html).toContain('Can watch and chat')
    for (const t of ['15 min', '1 hour', '8 hours', '24 hours']) expect(html).toContain(t)
    expect(html).toContain(LIVE_LINK_WARNING.replace(/'/g, '&#x27;'))
    expect(html).toContain('Create live link')
  })
  it('shows the URL with Copy and Stop once created', () => {
    const html = renderToStaticMarkup(
      <LiveLinkDialogBody title="build" state={{ phase: 'done', url: 'https://nodeterm.dev/s/x#1.y', linkId: 'x', expiresAt: 0 }} onChange={() => {}} onSubmit={() => {}} onClose={() => {}} onStop={() => {}} />
    )
    expect(html).toContain('https://nodeterm.dev/s/x#1.y')
    expect(html).toContain('Copy')
    expect(html).toContain('Stop sharing')
  })
})
```

Update `src/renderer/lib/ui-visibility.test.ts`'s expected menu id array to include `'live-link'` at the end, and `nav.test.ts`'s `toHaveLength(25)` → `26`, `toHaveLength(24)` → `25`.

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement the dialog**

`src/renderer/components/LiveLinkDialog.tsx`:

```tsx
// Create a live link. The warning is always visible (not a checkbox): the owner must read what a
// link exposes every time, because "the screen" includes whatever is printed next.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import { createErrorMessage, DEFAULT_TTL, LIVE_LINK_WARNING, ROLE_LABEL, TTL_OPTIONS } from '../lib/liveLink'
import { loadIdentity } from '../state/presence'
import type { WatchLinkRole, WatchLinkTtl } from '@shared/watch-link-types'

export type DialogState =
  | { phase: 'form'; role: WatchLinkRole; ttl: WatchLinkTtl; label: string; busy: boolean; error: string | null }
  | { phase: 'done'; url: string; linkId: string; expiresAt: number }

export function LiveLinkDialogBody(p: {
  title: string
  state: DialogState
  onChange: (s: DialogState) => void
  onSubmit: () => void
  onClose: () => void
  onStop: (linkId: string) => void
}): React.JSX.Element {
  const s = p.state
  if (s.phase === 'done') {
    return (
      <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm__msg">Live link to {p.title}</p>
        <div className="live-dialog__url">
          <input className="confirm__input" readOnly value={s.url} onFocus={(e) => e.currentTarget.select()} />
          <button className="confirm__btn primary" onClick={() => window.nodeTerminal.clipboard.writeText(s.url)}>Copy</button>
        </div>
        <p className="live-dialog__note">Anyone with this link can watch until {new Date(s.expiresAt).toLocaleTimeString()}.</p>
        <div className="confirm__actions">
          <button className="confirm__btn danger" onClick={() => p.onStop(s.linkId)}>Stop sharing</button>
          <button className="confirm__btn" onClick={p.onClose}>Done</button>
        </div>
      </div>
    )
  }
  return (
    <div className="confirm live-dialog" onClick={(e) => e.stopPropagation()}>
      <p className="confirm__msg">Share a live link to {p.title}</p>
      <fieldset className="live-dialog__group">
        <legend>Viewers</legend>
        {(['viewer', 'commenter'] as const).map((r) => (
          <label key={r}>
            <input type="radio" name="live-role" checked={s.role === r} onChange={() => p.onChange({ ...s, role: r })} /> {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <fieldset className="live-dialog__group">
        <legend>Ends after</legend>
        {TTL_OPTIONS.map((o) => (
          <label key={o.value}>
            <input type="radio" name="live-ttl" checked={s.ttl === o.value} onChange={() => p.onChange({ ...s, ttl: o.value })} /> {o.label}
          </label>
        ))}
      </fieldset>
      <label className="live-dialog__label">
        Shown to viewers as
        <input className="confirm__input" maxLength={40} value={s.label} onChange={(e) => p.onChange({ ...s, label: e.target.value })} />
      </label>
      <p className="live-dialog__warning">{LIVE_LINK_WARNING}</p>
      {s.error && <p className="live-dialog__error" role="alert">{s.error}</p>}
      <div className="confirm__actions">
        <button className="confirm__btn" onClick={p.onClose}>Cancel</button>
        <button className="confirm__btn primary" disabled={s.busy || !s.label.trim()} onClick={p.onSubmit}>
          {s.busy ? 'Creating…' : 'Create live link'}
        </button>
      </div>
    </div>
  )
}

export function LiveLinkDialog({ nodeId, title, onClose }: { nodeId: string; title: string; onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<DialogState>({ phase: 'form', role: 'viewer', ttl: DEFAULT_TTL, label: loadIdentity()?.name ?? '', busy: false, error: null })
  const isTop = useDialogStack()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isTop()) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isTop, onClose])
  const submit = async (): Promise<void> => {
    if (state.phase !== 'form') return
    setState({ ...state, busy: true, error: null })
    const r = await window.nodeTerminal.watchLink.create({ nodeId, role: state.role, ttlSeconds: state.ttl, label: state.label, title })
    if (r.ok) setState({ phase: 'done', url: r.link.url, linkId: r.link.linkId, expiresAt: r.link.expiresAt })
    else setState({ ...state, busy: false, error: createErrorMessage(r.error) })
  }
  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <LiveLinkDialogBody
        title={title}
        state={state}
        onChange={setState}
        onSubmit={() => void submit()}
        onClose={onClose}
        onStop={(id) => {
          void window.nodeTerminal.watchLink.revoke(id)
          onClose()
        }}
      />
    </div>,
    document.body
  )
}
```

Styles (append to `styles.css`): `.live-dialog { width: 420px }`, `.live-dialog__group { border: 0; margin: 8px 0; padding: 0; display: flex; gap: 12px; flex-wrap: wrap }`, `.live-dialog__warning { background: color-mix(in srgb, var(--state-warning) 12%, transparent); border-radius: 6px; padding: 8px; font-size: 12px }`, `.live-dialog__error { color: var(--danger) }`, `.live-dialog__url { display: flex; gap: 6px }`.

- [ ] **Step 4: Wire the entry points in `Canvas.tsx`**

1. State: `const [liveLinkDialog, setLiveLinkDialog] = useState<{ nodeId: string; title: string } | null>(null)`.
2. An opener that goes through the Pro gate (the first caller of `requireProOr`):

```ts
const openLiveLink = useCallback((nodeId: string, title: string) => {
  requireProOr('Live links', () => setLiveLinkDialog({ nodeId, title }))
}, [])
```

3. Sync + notices, once:

```ts
useEffect(
  () => startWatchLinkSync(window.nodeTerminal, (n) => {
    const text = noticeText(n)
    if (text) setNotice({ kind: 'info', text, sticky: n.kind === 'not-persistent' })
  }),
  []
)
```

4. The card-modal event listener:

```ts
useEffect(() => {
  const on = (e: Event): void => {
    const d = (e as CustomEvent<{ nodeId?: unknown; title?: unknown }>).detail
    if (typeof d?.nodeId === 'string') openLiveLink(d.nodeId, typeof d.title === 'string' ? d.title : 'Terminal')
  }
  window.addEventListener('nodeterm:live-link', on)
  return () => window.removeEventListener('nodeterm:live-link', on)
}, [openLiveLink])
```

5. A row builder shared by the node menu and the kanban card menu:

```ts
const liveLinkMenuItems = useCallback((nodeId: string): MenuItem[] => {
  const hidden = useSettings.getState().settings.hiddenNodeMenuItems
  if (isHidden('live-link', hidden)) return []
  const n = nodesRef.current.find((x) => x.id === nodeId)
  if (!n || n.type !== 'terminal') return []
  const why = shareDisabledReason({ relayTab: session.source === 'relay', activeLinks: useWatchLinks.getState().links.length })
  return [{
    label: 'Share live link…',
    icon: <IconEye />,
    disabled: !!why,
    hint: why ?? undefined,
    onClick: () => openLiveLink(nodeId, String(n.data?.title ?? 'Terminal'))
  }]
}, [openLiveLink, session.source])
```

   In `selectionItems`' terminal-only block, for a single selection append `...(ids.length === 1 ? liveLinkMenuItems(ids[0]) : [])` after the "Refresh terminal" row. Pass `liveLinkMenuItems={liveLinkMenuItems}` to `<KanbanView …>` beside `accountMenuItems={accountSwitchRows}`.
6. Palette (in `buildCommands`):

```ts
{ id: 'live-links-manage', label: 'Manage live links', hint: 'share watch broadcast stream link public', icon: <IconEye />,
  run: () => { setSettingsSection('live-links'); setSettingsNonce((n) => n + 1); setSettingsOpen(true) } },
...(useWatchLinks.getState().links.length > 0
  ? [{ id: 'live-links-stop-all', label: 'Stop all live links', hint: 'share revoke broadcast', icon: <IconEye />,
      run: () => { void window.nodeTerminal.watchLink.revokeAll() } }]
  : []),
```

7. Render: `{liveLinkDialog && <LiveLinkDialog nodeId={liveLinkDialog.nodeId} title={liveLinkDialog.title} onClose={() => setLiveLinkDialog(null)} />}` next to `<UpgradeDialog />`.

Imports: `requireProOr` (`../state/upgradeGate`), `startWatchLinkSync`, `useWatchLinks` (`../state/watchLinks`), `noticeText`, `shareDisabledReason` (`../lib/liveLink`), `LiveLinkDialog` (`../components/LiveLinkDialog`).

- [ ] **Step 5: Kanban, card modal, visibility, ProCompare, Settings**

- `KanbanView.tsx`: add prop `liveLinkMenuItems?: (nodeId: string) => MenuItem[]` (documented like `accountMenuItems`: "a board with no canvas behind it offers none"), and in `cardMenuItems` add `...(liveLinkMenuItems?.(nodeId) ?? [])` after the account rows.
- `CardModal.tsx`: in the terminal action buttons, before "Comments":

```tsx
{isTerminal && (
  <button className="kanban-modal__action" title="Share live link"
    onClick={() => window.dispatchEvent(new CustomEvent('nodeterm:live-link', { detail: { nodeId: session.id, title: session.title } }))}>
    <IconEye />
  </button>
)}
```

- `ui-visibility.ts`: append `{ id: 'live-link', label: 'Share live link' }` to `HIDEABLE_MENU_ITEMS`.
- `ProCompare.tsx`: append `'Live read-only links to a terminal — viewers need nothing installed'` to `PRO`. Do not touch `CORE`.
- Settings: `nav.ts` — add `| 'live-links'` to `SettingsSectionId` and `{ id: 'live-links', title: 'Live links' }` after `team-access` in the `connectivity` group; `SettingsIcons.tsx` — add a `'live-links'` path (a dot inside two arcs):

```tsx
  'live-links': (
    <>
      <circle cx="8" cy="8" r="1.6" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.3 3.3a6.6 6.6 0 0 0 0 9.4M12.7 3.3a6.6 6.6 0 0 1 0 9.4" />
    </>
  ),
```

  `SettingsPage.tsx` — mount `<LiveLinksSection isActive={active === 'live-links'} />` after `TeamAccessSection`.

`src/renderer/components/settings/sections/LiveLinksSection.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'
import { useEntitlement } from '../../../state/entitlement'
import { useWatchLinks } from '../../../state/watchLinks'
import { formatRemaining, ROLE_LABEL } from '../../../lib/liveLink'

const ROWS = { links: { title: 'Active live links', keywords: ['live', 'link', 'share', 'watch', 'broadcast', 'viewer'] } }
const ENTRIES = Object.values(ROWS)

export function LiveLinksSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const premium = useEntitlement((s) => s.isPremium)
  const links = useWatchLinks((s) => s.links)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isActive) return
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [isActive])
  return (
    <SettingsSection id="live-links" title="Live links"
      description="A read-only browser link to one terminal. Viewers need nothing installed; links end on their own."
      isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.links}>
        {!premium ? (
          <div className="settings-pitch">
            <p>Share a terminal live with anyone — a teammate, a customer, a reviewer — as a link that ends by itself.</p>
            <Button onClick={() => useEntitlement.getState().upgrade('pro')}>Upgrade to Pro</Button>
          </div>
        ) : links.length === 0 ? (
          <p className="settings-muted">No active live links. Right-click a terminal and choose "Share live link…".</p>
        ) : (
          <>
            <ul className="live-settings">
              {links.map((l) => (
                <li key={l.linkId}>
                  <strong>{l.title}</strong> · {ROLE_LABEL[l.role]} · {l.viewers.length} watching · {formatRemaining(l.expiresAt, now)}
                  <Button onClick={() => window.nodeTerminal.clipboard.writeText(l.url)}>Copy</Button>
                  <Button onClick={() => void window.nodeTerminal.watchLink.revoke(l.linkId)}>Stop</Button>
                </li>
              ))}
            </ul>
            <Button onClick={() => void window.nodeTerminal.watchLink.revokeAll()}>Stop all</Button>
          </>
        )}
      </SearchableRow>
    </SettingsSection>
  )
}
```

(Match `SearchableRow`'s real import path and the pitch/muted class names used by `TeamAccessSection.tsx`; copy them from there.)

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/renderer && npm run typecheck` — Expected: PASS (including `nodeterm-events.test.ts`, `ui-visibility.test.ts`, `nav.test.ts`, `ShortcutsPanel.test.tsx`).

- [ ] **Step 7: Commit**

```bash
git add src/renderer
git commit -m "feat(live-link): create dialog, node/card/sidebar menus, card-modal action, palette, Settings, Pro gate"
```

---

### Task 18: Docs, full suite, mutation checks, push, PR

**Files:**
- Create: `docs/live-links.md`
- Modify: `CLAUDE.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Write `docs/live-links.md`**

Sections (prose, derived from the spec; keep it the reference a contributor opens before touching this code): What it is; The link and its keys (with the KDF and why the handshake is unchanged); The watcher role (inbound refusal, outbound filter, quiet + self-paced, why not `decideAccess`); Backpressure and the stream filter (why the parser must see every byte; why 1 MiB); Keyframes (why session-host has none); Lifecycle (create, persist, resume, node-gone, expiry, server 410, status poll when full); Surfaces (Desktop, Server Edition, relay tab, kanban, mobile N/A + the iOS follow-up); Threat notes (the spec's residuals, verbatim); Device checklist (the spec's 15 items).

- [ ] **Step 2: Add the invariants to `CLAUDE.md` and `CONTRIBUTING.md`**

`CLAUDE.md` — a new `## Live links (Pro, read-only browser link to one terminal)` section after "Session memory", 10–15 lines: the naming (`watchLink:` host-only owner IPC vs `watch:` viewer protocol, and why the viewer's must not start with `watchLink:`); the watcher never goes through `decideAccess`; quiet + self-paced clients and why the reaper reads `quietClientIds()`; the stream filter sees every byte and is reset only per session; `captureVisible` never returns history (session-host gets none); link state is never canvas content; no canvas-control verb; the guard files that pin each (`renderer/lib/live-link.guard.test.ts`, `watcher-policy.test.ts`, `ui-sink-registry.watcher.test.ts`, `host-control.test.ts`, `main/watch-link-wiring.test.ts`); pointer to `docs/live-links.md`.

`CONTRIBUTING.md` — 4 lines under the house rules: "A new broadcast channel needs nothing for live links — watchers are quiet clients — but a new *per-session pty* channel must be added to `watcherEventAllowed` deliberately, or viewers will not get it; and never add link state to a node, a board or a canvas op."

- [ ] **Step 3: Full suite and typecheck**

Run: `npm run typecheck && HOME=$(mktemp -d) npx vitest run`
Expected: green. A pre-existing red on `origin/main` too goes into the PR text, untouched.

- [ ] **Step 4: Mutation checks (mandatory; record each result in the PR)**

Break each rule, run the named test, confirm RED, restore:
1. `host-control.ts`: remove `'watchLink:'` → `host-control.test.ts` red.
2. `ui-sink-registry.ts`: make `broadcastIds()` return `this.ids()` → `ui-sink-registry.watcher.test.ts` + `platform-server.test.ts` red.
3. `ui-sink-registry.ts`: delete the `selfPaced` early return → "never paused" test red.
4. `pty-reap.ts`: drop `quietClientIds` from `liveClientIds` → `pty-reap.test.ts` red.
5. `watcher-policy.ts`: allow `kind === 'req'` for the chat method → `watcher-policy.test.ts` red.
6. `watcher-policy.ts`: move `d.filter.push` below the `streaming()` check → "keeps the parser fed" red.
7. `stream-filter.ts`: set the default cap to `65_536` → none should go red (the cap test passes its own); instead set `++len > maxStringChars` to `++len >= 0` → "split at every position" red.
8. `capture-route.ts`: return `'tmux'` for `sessionHost` → `capture-route.test.ts` red.
9. `link-host.ts`: `autoApprove` returns `true` → "denies a peer whose key is not…" red.
10. `service.ts`: `onWorkspaceChanged` does nothing → "node gone ends every link" red.

- [ ] **Step 5: Push the branch and open the PR**

```bash
git branch --show-current   # must print feat/live-share-link
git log --oneline origin/main..HEAD
git push -u origin feat/live-share-link
gh pr create --title "feat: live links — a Pro, read-only, expiring browser link to one terminal" --body-file /tmp/live-links-pr.md
```

PR body (English, pr-writing skill): what changed (the watcher role on the core relay host, the service, both shells, the four UI surfaces, the isomorphic client); why (spec path; Pro value that goes through the server); how it was checked (full suite, the 10 mutation results, the integration test that runs the real browser client against the real relay host); what was not (no Electron run — this server cannot; the 15-item device checklist from `docs/live-links.md` is owed on a Mac; no deploy; the backend PR (Plan 1) must be deployed before links can be created; the viewer page (Plan 3) must be deployed before links can be opened); risks (no forward secrecy; the fragment in browser history; relay bridge lifetime unverified — checklist item 15). End with the attribution line from the session's system reminder. **Do not merge; enes decides.**
