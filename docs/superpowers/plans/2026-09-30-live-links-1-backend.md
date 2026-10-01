# Live links — Plan 1 of 3: Backend (nodeterm-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `watch_links` table and the six `/v1/watch-links` routes that gate live links: Pro-checked creation, owner-only host tokens and status, an anonymous join guarded by a hashed join key, and owner revocation — plus an admin revoke.

**Architecture:** One new route module, `src/routes/watch-links.ts`, registered by `createApp` beside `registerRelay` with the same deps style (entitlement public key, pairing signer, relay endpoint, keygen client). Links are rows keyed by a server-random id; the server never sees the link secret, only `sha256(joinKey)`. Pairing tokens reuse the existing signer with `pairingId = 'wl.' + id`, so the relay broker needs no change.

**Tech Stack:** Hono 4.12, zod, drizzle-orm 0.36 (Postgres; pglite in tests), vitest 2.1, Node `crypto`.

**Spec:** `/root/nodeterm/wtshare/docs/superpowers/specs/2026-09-28-live-share-link-design.md` (section "Backend (nodeterm-server)").

**Plans in this series:** 1 = this (backend), 2 = `2026-09-30-live-links-2-desktop.md` (nodeterm core + shells + UI), 3 = `2026-09-30-live-links-3-web.md` (nodeterm-web viewer). Plan 1 is independent and inert until Plan 2's client calls it, so it can merge and deploy first.

## Global Constraints

- Link id: 16 random bytes, base64url, exactly 22 chars (`/^[A-Za-z0-9_-]{22}$/`).
- Relay pairing id: `wl.<linkId>`. No change to `src/relay/*`.
- TTL choices: `{900, 3600, 28800, 86400}` seconds; max 24 h, lowerable with `WATCH_LINK_MAX_TTL_SECONDS`. No extension.
- Per license: ≤ **15** active links; ≤ **50** creations per 24 h.
- host-token: ≤ **120** per link per hour. join: ≤ **300** per link per hour. Per IP: the existing 30/min.
- Pairing token TTL: 120 s (same as the relay routes).
- Creation requires a **live** license: keygen `validateLicense(licenseId, ent.deviceId)` valid, or a live `apple_entitlements` row by `original_transaction_id`. `free:` → 402. Companion token (`via:'host'`) → 403 `companion_device`. A keygen call that throws → 503 `license_check_unavailable` (fail closed).
- host-token and status check only the signed token + the row (no keygen call).
- join: the **same 404** for an unknown id and a wrong key; 410 only when the key matches.
- CORS only on `POST /v1/watch-links/:id/join`, only for `WATCH_LINK_VIEWER_ORIGIN` (default `https://nodeterm.dev`).
- Never log `joinKey`, request bodies or tokens.
- Branch `feat/watch-links` off `origin/main` in a new worktree. **Never push `main`.**

## Review Focus

1. **A request body that is not JSON, or JSON with extra/wrong-typed fields** → a clean 400 `bad_request`, never a 500 (every route must `safeParse` a `.catch(() => null)` body).
2. **An id in the path that is not 22 base64url chars** (e.g. `revoke-all` reaching `/:id/…`, `../x`, 500 chars) → the route's normal not-found answer without a DB query throwing.
3. **A link that expires between create and join** (clock boundary) → join answers 410 `expired`, host-token 410 `expired`; `expiresAt` exactly equal to now counts as expired.
4. **The same license revoking a link twice, or revoking one it does not own** → 204 twice; someone else's link → 404, row untouched.
5. **An Apple lifetime license (`expiresAt = null`)** → counts as live at creation.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` (modify) | `watchLinks` table; index on `apple_entitlements.original_transaction_id` |
| `src/db/migrations/0014_*.sql` + `meta/*` (generated) | the migration |
| `src/routes/watch-links.ts` (create) | the six routes, their limits and the liveness check |
| `src/app.ts` (modify) | register the routes; request log for `/v1/watch-links/*` |
| `src/routes/admin.tsx` (modify) | "Live links" card + revoke action |
| `test/watch-links.test.ts` (create) | route tests |
| `test/admin.test.ts` (modify) | admin card + revoke test |
| `README.md` (modify) | the two optional env vars |

---

### Task 0: Worktree

- [ ] **Step 1: Create the worktree and install**

```bash
git -C /root/nodeterm-server fetch origin
git -C /root/nodeterm-server worktree add -b feat/watch-links /root/nodeterm-server-watch origin/main
cd /root/nodeterm-server-watch && npm ci
npm test 2>&1 | tail -5
```

Expected: the existing suite passes on a clean `origin/main`. If anything is red before you change a line, stop and report it — do not fix unrelated failures.

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated): `src/db/migrations/0014_<name>.sql`, `src/db/migrations/meta/0014_snapshot.json`, `src/db/migrations/meta/_journal.json`
- Test: `test/watch-links.test.ts`

**Interfaces:**
- Produces: `watchLinks` drizzle table with columns `id`, `licenseId`, `joinKeyHash`, `createdAt`, `expiresAt`, `revokedAt`; `typeof watchLinks.$inferSelect` is the row type used in Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/watch-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { makeTestDb } from './helpers/db'
import { watchLinks } from '../src/db/schema'

describe('watch_links table', () => {
  it('stores a link row with a nullable revokedAt', async () => {
    const { db } = await makeTestDb()
    const expiresAt = new Date(Date.now() + 3600_000)
    await db.insert(watchLinks).values({ id: 'A'.repeat(22), licenseId: 'lic-1', joinKeyHash: 'f'.repeat(64), expiresAt })
    const rows = await db.select().from(watchLinks).where(eq(watchLinks.id, 'A'.repeat(22)))
    expect(rows).toHaveLength(1)
    expect(rows[0].revokedAt).toBeNull()
    expect(rows[0].createdAt).toBeInstanceOf(Date)
    expect(rows[0].expiresAt.getTime()).toBe(expiresAt.getTime())
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/watch-links.test.ts`
Expected: FAIL — `watchLinks` is not exported from `../src/db/schema`.

- [ ] **Step 3: Add the table and the Apple index**

In `src/db/schema.ts`, append after `relayDevices`:

```ts
/**
 * Live links (a read-only browser link to one terminal). The server stores only what gates a
 * join: who created the link, when it ends, whether it was stopped, and the SHA-256 of the join
 * key. The link secret itself never reaches the server (it lives in the URL fragment).
 */
export const watchLinks = pgTable(
  'watch_links',
  {
    id: text('id').primaryKey(),
    licenseId: text('license_id').notNull(),
    joinKeyHash: text('join_key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true })
  },
  (t) => ({
    licenseIdIdx: index('watch_links_license_id_idx').on(t.licenseId),
    expiresAtIdx: index('watch_links_expires_at_idx').on(t.expiresAt)
  })
)
```

Change `appleEntitlements` (currently `pgTable('apple_entitlements', { … })` with no third argument) by adding the index argument after the column object:

```ts
export const appleEntitlements = pgTable(
  'apple_entitlements',
  {
    // … the existing columns, unchanged …
  },
  (t) => ({
    // Live links look an `apple:<txn>` license up by transaction id (routes/watch-links.ts).
    originalTransactionIdIdx: index('apple_entitlements_original_transaction_id_idx').on(t.originalTransactionId)
  })
)
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new `src/db/migrations/0014_<random>.sql` containing `CREATE TABLE IF NOT EXISTS "watch_links"`, the two `watch_links_*_idx` indexes and `apple_entitlements_original_transaction_id_idx`, plus `meta/0014_snapshot.json` and a new `_journal.json` entry with `"idx": 14`. Open the SQL and confirm it touches nothing else (no DROP, no ALTER of existing columns).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/watch-links.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations test/watch-links.test.ts
git commit -m "feat(db): watch_links table and an index on apple original transaction ids"
```

---

### Task 2: `POST /v1/watch-links` (create) and registration

**Files:**
- Create: `src/routes/watch-links.ts`
- Modify: `src/app.ts`
- Test: `test/watch-links.test.ts`

**Interfaces:**
- Consumes: `watchLinks`, `appleEntitlements` (schema), `verifyEntitlement`, `ownsLicense`, `COMPANION_REFUSAL` (`src/lib/entitlement.ts`), `licenseSource` (`src/routes/license.ts`), `rateLimit`, `fixedWindow` (`src/lib/rate-limit.ts`), `createPairingToken` (type), `KeygenClient`.
- Produces: `export function registerWatchLinks(app: Hono, db: AppDb, deps: WatchLinkDeps): void`; `export interface WatchLinkDeps { entitlementPublicKey: string; pairing: ReturnType<typeof createPairingToken>; relayEndpoint: string; keygen: KeygenClient; viewerOrigin?: string; maxTtlSeconds?: number }`; `export const watchLinkPairingId = (id: string) => 'wl.' + id`; constants `WATCH_LINK_TTLS`, `MAX_ACTIVE_PER_LICENSE`, `MAX_CREATES_PER_DAY`.
- Wire contract (consumed by Plan 2): request `{entitlement: string, joinKeyHash: string /* 64 lowercase hex */, ttlSeconds: number}`; 200 `{linkId: string, expiresAt: number /* epoch seconds */}`; errors `400 {error:'bad_request'|'bad_ttl'}`, `402 {error:'not_entitled'}`, `403 {error:'companion_device'}`, `429 {error:'rate_limited', scope:'active_links'|'license'|'ip'}`, `503 {error:'license_check_unavailable'}`.

- [ ] **Step 1: Write the failing tests**

Append to `test/watch-links.test.ts` (merge the imports at the top of the file):

```ts
import crypto from 'node:crypto'
import { Hono } from 'hono'
import { registerWatchLinks } from '../src/routes/watch-links'
import { createEntitlement } from '../src/lib/entitlement'
import { createPairingToken, verifyPairingToken } from '../src/lib/pairing-token'
import { appleEntitlements } from '../src/db/schema'
import { fakeKeygen } from './helpers/keygen'
import type { KeygenClient } from '../src/lib/keygen'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const entitlement = createEntitlement(privateKey)
const ent = (licenseId = 'lic-1', deviceId = 'mac-a', via?: 'host') =>
  entitlement.sign({ deviceId, tier: 'pro', licenseId, ttlSeconds: 3600, ...(via ? { via } : {}) })

const joinKey = crypto.randomBytes(32)
const joinKeyB64 = joinKey.toString('base64url')
const joinKeyHash = crypto.createHash('sha256').update(joinKey).digest('hex')

async function appWith(over: Partial<KeygenClient> = {}, extra: { maxTtlSeconds?: number } = {}) {
  const { db } = await makeTestDb()
  const app = new Hono()
  registerWatchLinks(app, db, {
    entitlementPublicKey: publicKey,
    pairing: createPairingToken(privateKey),
    relayEndpoint: 'wss://relay.test',
    keygen: fakeKeygen(over),
    ...extra
  })
  return { app, db }
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
async function create(app: Hono, over: Record<string, unknown> = {}) {
  return app.request(post('/v1/watch-links', { entitlement: ent(), joinKeyHash, ttlSeconds: 3600, ...over }))
}

describe('POST /v1/watch-links', () => {
  it('creates a link for a live keygen license and answers its id and expiry', async () => {
    const seen: string[] = []
    const { app, db } = await appWith({
      validateLicense: async (id, fp) => {
        seen.push(`${id}/${fp}`)
        return { valid: true }
      }
    })
    const before = Math.floor(Date.now() / 1000)
    const res = await create(app)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { linkId: string; expiresAt: number }
    expect(body.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3600)
    expect(body.expiresAt).toBeLessThanOrEqual(before + 3601)
    expect(seen).toEqual(['lic-1/mac-a'])
    const rows = await db.select().from(watchLinks).where(eq(watchLinks.id, body.linkId))
    expect(rows[0].licenseId).toBe('lic-1')
    expect(rows[0].joinKeyHash).toBe(joinKeyHash)
  })

  it('refuses a license keygen says is not valid', async () => {
    const { app } = await appWith({ validateLicense: async () => ({ valid: false, code: 'SUSPENDED' }) })
    const res = await create(app)
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ error: 'not_entitled' })
  })

  it('fails closed with 503 when keygen cannot be asked', async () => {
    const { app, db } = await appWith({ validateLicense: async () => { throw new Error('ECONNRESET') } })
    const res = await create(app)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'license_check_unavailable' })
    expect(await db.select().from(watchLinks)).toHaveLength(0)
  })

  it('refuses a free license and a companion token', async () => {
    const { app } = await appWith()
    expect((await create(app, { entitlement: ent('free:dev-1') })).status).toBe(402)
    const companion = await create(app, { entitlement: ent('lic-1', 'phone-1', 'host') })
    expect(companion.status).toBe(403)
    expect(await companion.json()).toEqual({ error: 'companion_device' })
  })

  it('refuses a bad signature, an unknown ttl, a malformed hash and a non-JSON body', async () => {
    const { app } = await appWith()
    expect((await create(app, { entitlement: 'nope.nope' })).status).toBe(402)
    const ttl = await create(app, { ttlSeconds: 7200 })
    expect(ttl.status).toBe(400)
    expect(await ttl.json()).toEqual({ error: 'bad_ttl' })
    expect((await create(app, { joinKeyHash: 'XYZ' })).status).toBe(400)
    expect((await app.request(post('/v1/watch-links', 'not json'))).status).toBe(400)
    expect((await create(app, { ttlSeconds: '3600' })).status).toBe(400)
  })

  it('honours a lower configured maximum ttl', async () => {
    const { app } = await appWith({}, { maxTtlSeconds: 3600 })
    expect((await create(app, { ttlSeconds: 3600 })).status).toBe(200)
    expect((await create(app, { ttlSeconds: 86400 })).status).toBe(400)
  })

  it('accepts a live Apple license, lifetime included, and refuses a revoked one', async () => {
    const { app, db } = await appWith()
    await db.insert(appleEntitlements).values([
      { appAccountToken: 'phone-a', productId: 'pro.lifetime', originalTransactionId: 'txn-life', expiresAt: null },
      { appAccountToken: 'phone-b', productId: 'pro.monthly', originalTransactionId: 'txn-gone', expiresAt: new Date(Date.now() + 86400_000), revokedAt: new Date() }
    ])
    expect((await create(app, { entitlement: ent('apple:txn-life') })).status).toBe(200)
    expect((await create(app, { entitlement: ent('apple:txn-gone') })).status).toBe(402)
    expect((await create(app, { entitlement: ent('apple:txn-none') })).status).toBe(402)
  })

  it('caps active links per license at 15', async () => {
    const { app, db } = await appWith()
    const now = Date.now()
    await db.insert(watchLinks).values(
      Array.from({ length: 15 }, (_, i) => ({
        id: `link${String(i).padStart(18, '0')}`,
        licenseId: 'lic-1',
        joinKeyHash,
        expiresAt: new Date(now + 3600_000)
      }))
    )
    const res = await create(app)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited', scope: 'active_links' })
    // An expired and a revoked row do not count.
    await db.update(watchLinks).set({ revokedAt: new Date() }).where(eq(watchLinks.id, `link${'0'.repeat(18)}`))
    expect((await create(app)).status).toBe(200)
  })

  it('caps creations per license at 50 a day', async () => {
    const { app, db } = await appWith()
    for (let i = 0; i < 50; i++) {
      const r = await create(app)
      expect(r.status).toBe(200)
      // Keep the active count under 15 so only the daily cap can refuse.
      await db.update(watchLinks).set({ revokedAt: new Date() })
    }
    const res = await create(app)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited', scope: 'license' })
  })

  it('purges rows more than 7 days past expiry on create', async () => {
    const { app, db } = await appWith()
    await db.insert(watchLinks).values({ id: 'O'.repeat(22), licenseId: 'lic-9', joinKeyHash, expiresAt: new Date(Date.now() - 8 * 86400_000) })
    expect((await create(app)).status).toBe(200)
    expect(await db.select().from(watchLinks).where(eq(watchLinks.id, 'O'.repeat(22)))).toHaveLength(0)
  })
})
```

Note: the 50-a-day test posts 51 times from one IP; the per-IP limiter (30/min) would answer 429 `scope:'ip'` first. The route module therefore takes the per-IP limiter from deps so tests can widen it — see Step 3's `ipLimit` option. Use `appWith({}, { ipLimitPerMinute: 1000 })` in that test and extend `appWith`'s `extra` type to `{ maxTtlSeconds?: number; ipLimitPerMinute?: number }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/watch-links.test.ts`
Expected: FAIL — `../src/routes/watch-links` cannot be resolved.

- [ ] **Step 3: Write the route module (create route only)**

Create `src/routes/watch-links.ts`:

```ts
// Live links: a read-only, expiring browser link to one terminal (Pro).
//
// The server gates a link and never sees what flows through it. A link row holds who created it,
// when it ends, whether it was stopped, and SHA-256(joinKey). The link secret S lives in the URL
// fragment and never reaches us; the desktop derives joinKey from S and sends only its hash at
// creation, and a viewer sends joinKey itself when it asks to join. Pairing tokens are the relay
// routes' tokens with pairingId `wl.<id>`, so the relay broker needs no change.
//
// Who may do what:
//  - create: a LIVE Pro license (keygen validate, or a live Apple row by transaction id). free and
//    companion tokens are refused. Liveness is checked here only (spec D7).
//  - host-token / status / revoke / revoke-all: the owner — a non-companion token whose licenseId
//    is the row's. Token signature and the row only, no keygen call.
//  - join: anyone holding joinKey. An unknown id and a wrong key get the same 404.
import crypto from 'node:crypto'
import type { Hono } from 'hono'
import { cors } from 'hono/cors'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { AppDb } from '../db/types'
import { appleEntitlements, watchLinks } from '../db/schema'
import { rateLimit, fixedWindow } from '../lib/rate-limit'
import { verifyEntitlement, ownsLicense, COMPANION_REFUSAL, type EntitlementPayload } from '../lib/entitlement'
import { licenseSource } from './license'
import type { createPairingToken } from '../lib/pairing-token'
import type { KeygenClient } from '../lib/keygen'

export interface WatchLinkDeps {
  entitlementPublicKey: string
  pairing: ReturnType<typeof createPairingToken>
  relayEndpoint: string
  keygen: KeygenClient
  /** The viewer page's origin, the only one CORS admits on the join route. */
  viewerOrigin?: string
  /** Lower the 24 h ceiling (WATCH_LINK_MAX_TTL_SECONDS). */
  maxTtlSeconds?: number
  /** Per-IP requests per minute. Production keeps the relay routes' 30; tests widen it. */
  ipLimitPerMinute?: number
}

export const WATCH_LINK_TTLS = [900, 3600, 28800, 86400] as const
export const WATCH_LINK_PAIR_TTL_SECONDS = 120
export const MAX_ACTIVE_PER_LICENSE = 15
export const MAX_CREATES_PER_DAY = 50
export const HOST_TOKENS_PER_LINK_PER_HOUR = 120
export const JOINS_PER_LINK_PER_HOUR = 300
const PURGE_AFTER_MS = 7 * 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export const watchLinkPairingId = (id: string): string => `wl.${id}`

const LINK_ID = /^[A-Za-z0-9_-]{22}$/
const HEX_64 = /^[0-9a-f]{64}$/
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/

const CreateBody = z.object({
  entitlement: z.string().min(1).max(4000),
  joinKeyHash: z.string().regex(HEX_64),
  ttlSeconds: z.number().int()
})

type LinkRow = typeof watchLinks.$inferSelect
type LinkState = 'live' | 'revoked' | 'expired'

export function linkState(row: LinkRow, nowMs: number = Date.now()): LinkState {
  if (row.revokedAt) return 'revoked'
  // Expiry is inclusive: a link whose instant has come is over.
  if (row.expiresAt.getTime() <= nowMs) return 'expired'
  return 'live'
}

async function readBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null)
}

export function registerWatchLinks(app: Hono, db: AppDb, deps: WatchLinkDeps): void {
  const limit = rateLimit({ windowMs: 60_000, max: deps.ipLimitPerMinute ?? 30 })
  const creates = fixedWindow({ windowMs: DAY_MS, max: MAX_CREATES_PER_DAY })
  const maxTtl = deps.maxTtlSeconds && deps.maxTtlSeconds > 0 ? deps.maxTtlSeconds : 86400
  const allowedTtls: readonly number[] = WATCH_LINK_TTLS.filter((t) => t <= maxTtl)

  /** Is this entitlement's license live right now? 'unknown' = keygen could not be asked. */
  async function licenseLiveness(ent: EntitlementPayload): Promise<'live' | 'dead' | 'unknown'> {
    const source = licenseSource(ent.licenseId)
    if (source === 'free') return 'dead'
    if (source === 'apple') {
      const txn = ent.licenseId.slice('apple:'.length)
      const rows = await db.select().from(appleEntitlements).where(eq(appleEntitlements.originalTransactionId, txn))
      const now = Date.now()
      return rows.some((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now)) ? 'live' : 'dead'
    }
    try {
      const v = await deps.keygen.validateLicense(ent.licenseId, ent.deviceId)
      return v.valid ? 'live' : 'dead'
    } catch {
      return 'unknown'
    }
  }

  app.post('/v1/watch-links', limit, async (c) => {
    const parsed = CreateBody.safeParse(await readBody(c))
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
    const { entitlement, joinKeyHash, ttlSeconds } = parsed.data
    if (!allowedTtls.includes(ttlSeconds)) return c.json({ error: 'bad_ttl' }, 400)
    const ent = verifyEntitlement(entitlement, deps.entitlementPublicKey)
    if (!ent || typeof ent.licenseId !== 'string' || typeof ent.deviceId !== 'string') {
      return c.json({ error: 'not_entitled' }, 402)
    }
    if (!ownsLicense(ent)) return c.json({ error: COMPANION_REFUSAL }, 403)
    const live = await licenseLiveness(ent)
    if (live === 'unknown') return c.json({ error: 'license_check_unavailable' }, 503)
    if (live === 'dead') return c.json({ error: 'not_entitled' }, 402)

    const nowMs = Date.now()
    await db.delete(watchLinks).where(lt(watchLinks.expiresAt, new Date(nowMs - PURGE_AFTER_MS)))
    const active = await db
      .select({ id: watchLinks.id })
      .from(watchLinks)
      .where(and(eq(watchLinks.licenseId, ent.licenseId), isNull(watchLinks.revokedAt), gt(watchLinks.expiresAt, new Date(nowMs))))
    if (active.length >= MAX_ACTIVE_PER_LICENSE) return c.json({ error: 'rate_limited', scope: 'active_links' }, 429)
    if (!creates.take(ent.licenseId)) return c.json({ error: 'rate_limited', scope: 'license' }, 429)

    const id = crypto.randomBytes(16).toString('base64url')
    const expiresAt = new Date(nowMs + ttlSeconds * 1000)
    await db.insert(watchLinks).values({ id, licenseId: ent.licenseId, joinKeyHash, expiresAt })
    return c.json({ linkId: id, expiresAt: Math.floor(expiresAt.getTime() / 1000) })
  })
}
```

(`cors`, `LINK_ID`, `B64URL_32`, `HOUR_MS`, `watchLinkPairingId` and the other constants are used by Tasks 3–5; keep them.)

- [ ] **Step 4: Register in `createApp`**

In `src/app.ts`: add `import { registerWatchLinks } from './routes/watch-links'`. Replace the inline `/v1/relay/*` log middleware with a shared helper and apply it to both prefixes:

```ts
const logApi = async (c: Context, next: Next): Promise<void> => {
  await next()
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '?'
  console.log(`[api] ${c.req.method} ${c.req.path} ip=${ip} status=${c.res.status}`)
}
app.use('/v1/relay/*', logApi)
app.use('/v1/watch-links/*', logApi)
app.use('/v1/watch-links', logApi)
```

(`import type { Context, Next } from 'hono'`.) Inside `if (licensing) { … }`, right after `registerRelay(...)`:

```ts
registerWatchLinks(app, db, {
  entitlementPublicKey,
  pairing: createPairingToken(licensing.entitlementPrivateKey),
  relayEndpoint: process.env.RELAY_PUBLIC_URL ?? 'wss://relay.nodeterm.dev',
  keygen: licensing.keygen,
  viewerOrigin: process.env.WATCH_LINK_VIEWER_ORIGIN ?? 'https://nodeterm.dev',
  maxTtlSeconds: Number(process.env.WATCH_LINK_MAX_TTL_SECONDS) || 86400
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/watch-links.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/watch-links.ts src/app.ts test/watch-links.test.ts
git commit -m "feat(watch-links): create a live link for a live Pro license"
```

---

### Task 3: Owner routes — host-token and status

**Files:**
- Modify: `src/routes/watch-links.ts`
- Test: `test/watch-links.test.ts`

**Interfaces:**
- Wire contract (consumed by Plan 2):
  - `POST /v1/watch-links/:id/host-token {entitlement}` → 200 `{pairingToken, exp}` (pairing token: `pairingId 'wl.'+id`, `role 'host'`, `licenseId` = the row's, 120 s); 404 `{error:'not_found'}` (unknown id, bad id, or not the owner); 410 `{error:'gone', reason:'revoked'|'expired'}`; 402 `{error:'not_entitled'}` (bad token); 403 `companion_device`; 429 `{error:'rate_limited', scope:'link'}` with `Retry-After: 60`.
  - `POST /v1/watch-links/:id/status {entitlement}` → 200 `{state:'live'|'revoked'|'expired'}`; 404 / 402 / 403 as above.

- [ ] **Step 1: Write the failing tests**

```ts
describe('owner routes', () => {
  async function created(app: Hono): Promise<string> {
    const r = await create(app)
    return ((await r.json()) as { linkId: string }).linkId
  }

  it('host-token mints a host pairing token in the wl.<id> room', async () => {
    const { app } = await appWith()
    const id = await created(app)
    const res = await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pairingToken: string; exp: number }
    const p = verifyPairingToken(body.pairingToken, publicKey)
    expect(p?.pairingId).toBe(`wl.${id}`)
    expect(p?.role).toBe('host')
    expect(p?.licenseId).toBe('lic-1')
    expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('host-token never calls keygen', async () => {
    let calls = 0
    const { app } = await appWith({ validateLicense: async () => { calls++; return { valid: true } } })
    const id = await created(app)
    calls = 0
    await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))
    expect(calls).toBe(0)
  })

  it('answers 404 to another license, a companion 403, and an unknown or malformed id 404', async () => {
    const { app } = await appWith()
    const id = await created(app)
    expect((await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent('lic-2') }))).status).toBe(404)
    expect((await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent('lic-1', 'ph', 'host') }))).status).toBe(403)
    expect((await app.request(post(`/v1/watch-links/${'Z'.repeat(22)}/host-token`, { entitlement: ent() }))).status).toBe(404)
    expect((await app.request(post(`/v1/watch-links/..%2Fx/host-token`, { entitlement: ent() }))).status).toBe(404)
    expect((await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: 'bad' }))).status).toBe(402)
  })

  it('answers 410 with the reason once a link is revoked or expired, expiry inclusive', async () => {
    const { app, db } = await appWith()
    const id = await created(app)
    await db.update(watchLinks).set({ expiresAt: new Date(Date.now()) }).where(eq(watchLinks.id, id))
    const exp = await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))
    expect(exp.status).toBe(410)
    expect(await exp.json()).toEqual({ error: 'gone', reason: 'expired' })
    await db.update(watchLinks).set({ expiresAt: new Date(Date.now() + 3600_000), revokedAt: new Date() }).where(eq(watchLinks.id, id))
    const rev = await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))
    expect(await rev.json()).toEqual({ error: 'gone', reason: 'revoked' })
  })

  it('limits host tokens per link per hour', async () => {
    const { app } = await appWith({}, { ipLimitPerMinute: 1000 })
    const id = await created(app)
    for (let i = 0; i < 120; i++) {
      expect((await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))).status).toBe(200)
    }
    const res = await app.request(post(`/v1/watch-links/${id}/host-token`, { entitlement: ent() }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
  })

  it('status reports live, revoked and expired to the owner only', async () => {
    const { app, db } = await appWith()
    const id = await created(app)
    const st = async (e = ent()) => app.request(post(`/v1/watch-links/${id}/status`, { entitlement: e }))
    expect(await (await st()).json()).toEqual({ state: 'live' })
    expect((await st(ent('lic-2'))).status).toBe(404)
    await db.update(watchLinks).set({ revokedAt: new Date() }).where(eq(watchLinks.id, id))
    expect(await (await st()).json()).toEqual({ state: 'revoked' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/watch-links.test.ts -t "owner routes"`
Expected: FAIL — 404 from Hono for the unregistered routes (the first test gets 404, not 200).

- [ ] **Step 3: Implement**

In `registerWatchLinks`, after the create route:

```ts
  const hostTokens = fixedWindow({ windowMs: HOUR_MS, max: HOST_TOKENS_PER_LINK_PER_HOUR })
  const OwnerBody = z.object({ entitlement: z.string().min(1).max(4000) })

  async function loadRow(id: string): Promise<LinkRow | null> {
    if (!LINK_ID.test(id)) return null
    const rows = await db.select().from(watchLinks).where(eq(watchLinks.id, id))
    return rows[0] ?? null
  }

  type OwnerCheck =
    | { ok: true; row: LinkRow }
    | { ok: false; status: 400 | 402 | 403 | 404; body: Record<string, string> }

  /** The caller must hold a non-companion token for the row's own license. A row that exists but
   *  belongs to someone else answers exactly like a missing one. */
  async function asOwner(id: string, body: unknown): Promise<OwnerCheck> {
    const parsed = OwnerBody.safeParse(body)
    if (!parsed.success) return { ok: false, status: 400, body: { error: 'bad_request' } }
    const ent = verifyEntitlement(parsed.data.entitlement, deps.entitlementPublicKey)
    if (!ent || typeof ent.licenseId !== 'string') return { ok: false, status: 402, body: { error: 'not_entitled' } }
    if (!ownsLicense(ent)) return { ok: false, status: 403, body: { error: COMPANION_REFUSAL } }
    const row = await loadRow(id)
    if (!row || row.licenseId !== ent.licenseId) return { ok: false, status: 404, body: { error: 'not_found' } }
    return { ok: true, row }
  }

  app.post('/v1/watch-links/:id/host-token', limit, async (c) => {
    const who = await asOwner(c.req.param('id'), await readBody(c))
    if (!who.ok) return c.json(who.body, who.status)
    const state = linkState(who.row)
    if (state !== 'live') return c.json({ error: 'gone', reason: state }, 410)
    if (!hostTokens.take(who.row.id)) {
      c.header('Retry-After', '60')
      return c.json({ error: 'rate_limited', scope: 'link' }, 429)
    }
    const pairingToken = deps.pairing.sign({
      pairingId: watchLinkPairingId(who.row.id),
      licenseId: who.row.licenseId,
      role: 'host',
      ttlSeconds: WATCH_LINK_PAIR_TTL_SECONDS
    })
    return c.json({ pairingToken, exp: Math.floor(Date.now() / 1000) + WATCH_LINK_PAIR_TTL_SECONDS })
  })

  app.post('/v1/watch-links/:id/status', limit, async (c) => {
    const who = await asOwner(c.req.param('id'), await readBody(c))
    if (!who.ok) return c.json(who.body, who.status)
    return c.json({ state: linkState(who.row) })
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/watch-links.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/watch-links.ts test/watch-links.test.ts
git commit -m "feat(watch-links): owner-only host tokens and status"
```

---

### Task 4: Anonymous join with CORS

**Files:**
- Modify: `src/routes/watch-links.ts`
- Test: `test/watch-links.test.ts`

**Interfaces:**
- Wire contract (consumed by Plans 2 and 3): `POST /v1/watch-links/:id/join {joinKey: string /* base64url of 32 bytes, 43 chars */}` → 200 `{pairingToken, relayEndpoint, exp}` (role `client`, `pairingId 'wl.'+id`, 120 s); 404 `{error:'not_found'}` for an unknown/malformed id **or** a wrong key; 410 `{error:'gone', reason}` only for the right key; 400 `bad_request`; 429 `{error:'rate_limited', scope:'link'}` + `Retry-After: 60`. CORS: `Access-Control-Allow-Origin: <viewerOrigin>` on this path only.

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /v1/watch-links/:id/join', () => {
  async function created(app: Hono): Promise<string> {
    return ((await (await create(app)).json()) as { linkId: string }).linkId
  }

  it('mints a client token for the right join key', async () => {
    const { app } = await appWith()
    const id = await created(app)
    const res = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pairingToken: string; relayEndpoint: string; exp: number }
    expect(body.relayEndpoint).toBe('wss://relay.test')
    const p = verifyPairingToken(body.pairingToken, publicKey)
    expect(p?.role).toBe('client')
    expect(p?.pairingId).toBe(`wl.${id}`)
  })

  it('answers a wrong key exactly like an unknown id', async () => {
    const { app } = await appWith()
    const id = await created(app)
    const wrong = crypto.randomBytes(32).toString('base64url')
    const a = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: wrong }))
    const b = await app.request(post(`/v1/watch-links/${'Q'.repeat(22)}/join`, { joinKey: joinKeyB64 }))
    expect(a.status).toBe(404)
    expect(b.status).toBe(404)
    expect(await a.json()).toEqual(await b.json())
  })

  it('tells 410 only to a holder of the key', async () => {
    const { app, db } = await appWith()
    const id = await created(app)
    await db.update(watchLinks).set({ revokedAt: new Date() }).where(eq(watchLinks.id, id))
    const right = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }))
    expect(right.status).toBe(410)
    expect(await right.json()).toEqual({ error: 'gone', reason: 'revoked' })
    const wrong = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: crypto.randomBytes(32).toString('base64url') }))
    expect(wrong.status).toBe(404)
  })

  it('refuses a malformed join key with 400', async () => {
    const { app } = await appWith()
    const id = await created(app)
    expect((await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: 'short' }))).status).toBe(400)
    expect((await app.request(post(`/v1/watch-links/${id}/join`, {}))).status).toBe(400)
  })

  it('answers CORS for the viewer origin on join only', async () => {
    const { app } = await appWith()
    const id = await created(app)
    const pre = await app.request(
      new Request(`http://x/v1/watch-links/${id}/join`, {
        method: 'OPTIONS',
        headers: { origin: 'https://nodeterm.dev', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
      })
    )
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://nodeterm.dev')
    const join = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }, { origin: 'https://nodeterm.dev' }))
    expect(join.headers.get('access-control-allow-origin')).toBe('https://nodeterm.dev')
    const evil = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }, { origin: 'https://evil.example' }))
    expect(evil.headers.get('access-control-allow-origin')).not.toBe('https://evil.example')
    const created2 = await app.request(post('/v1/watch-links', { entitlement: ent(), joinKeyHash, ttlSeconds: 3600 }, { origin: 'https://nodeterm.dev' }))
    expect(created2.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('limits joins per link per hour', async () => {
    const { app } = await appWith({}, { ipLimitPerMinute: 1000 })
    const id = await created(app)
    for (let i = 0; i < 300; i++) {
      expect((await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }))).status).toBe(200)
    }
    const res = await app.request(post(`/v1/watch-links/${id}/join`, { joinKey: joinKeyB64 }))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/watch-links.test.ts -t "join"`
Expected: FAIL (route not registered → 404 where 200 is expected).

- [ ] **Step 3: Implement**

In `registerWatchLinks`, after the owner routes:

```ts
  const joins = fixedWindow({ windowMs: HOUR_MS, max: JOINS_PER_LINK_PER_HOUR })
  const JoinBody = z.object({ joinKey: z.string().regex(B64URL_32) })
  // Compared against when there is no row, so an unknown id costs the same as a wrong key.
  const NO_ROW_HASH = Buffer.alloc(32)

  app.use(
    '/v1/watch-links/:id/join',
    cors({ origin: deps.viewerOrigin ?? 'https://nodeterm.dev', allowMethods: ['POST'], allowHeaders: ['content-type'], maxAge: 600 })
  )

  app.post('/v1/watch-links/:id/join', limit, async (c) => {
    const parsed = JoinBody.safeParse(await readBody(c))
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
    const row = await loadRow(c.req.param('id'))
    const given = crypto.createHash('sha256').update(Buffer.from(parsed.data.joinKey, 'base64url')).digest()
    const stored = row ? Buffer.from(row.joinKeyHash, 'hex') : NO_ROW_HASH
    const match = stored.length === 32 && crypto.timingSafeEqual(given, stored) && row !== null
    if (!match || !row) return c.json({ error: 'not_found' }, 404)
    const state = linkState(row)
    if (state !== 'live') return c.json({ error: 'gone', reason: state }, 410)
    if (!joins.take(row.id)) {
      c.header('Retry-After', '60')
      return c.json({ error: 'rate_limited', scope: 'link' }, 429)
    }
    const pairingToken = deps.pairing.sign({
      pairingId: watchLinkPairingId(row.id),
      licenseId: row.licenseId,
      role: 'client',
      ttlSeconds: WATCH_LINK_PAIR_TTL_SECONDS
    })
    return c.json({ pairingToken, relayEndpoint: deps.relayEndpoint, exp: Math.floor(Date.now() / 1000) + WATCH_LINK_PAIR_TTL_SECONDS })
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/watch-links.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/watch-links.ts test/watch-links.test.ts
git commit -m "feat(watch-links): anonymous join behind a hashed join key, CORS for the viewer only"
```

---

### Task 5: Revoke and revoke-all

**Files:**
- Modify: `src/routes/watch-links.ts`
- Test: `test/watch-links.test.ts`

**Interfaces:**
- Wire contract: `POST /v1/watch-links/:id/revoke {entitlement}` → 204 (idempotent; owner only; another license's link → 404, untouched). `POST /v1/watch-links/revoke-all {entitlement}` → 204 (all of the license's un-revoked rows); 402 / 403 as the owner routes.

- [ ] **Step 1: Write the failing tests**

```ts
describe('revoke', () => {
  it('revokes an own link idempotently and refuses someone else', async () => {
    const { app, db } = await appWith()
    const id = ((await (await create(app)).json()) as { linkId: string }).linkId
    expect((await app.request(post(`/v1/watch-links/${id}/revoke`, { entitlement: ent('lic-2') }))).status).toBe(404)
    expect((await db.select().from(watchLinks).where(eq(watchLinks.id, id)))[0].revokedAt).toBeNull()
    expect((await app.request(post(`/v1/watch-links/${id}/revoke`, { entitlement: ent() }))).status).toBe(204)
    const first = (await db.select().from(watchLinks).where(eq(watchLinks.id, id)))[0].revokedAt
    expect(first).toBeInstanceOf(Date)
    expect((await app.request(post(`/v1/watch-links/${id}/revoke`, { entitlement: ent() }))).status).toBe(204)
    // The first stop's instant stands.
    expect((await db.select().from(watchLinks).where(eq(watchLinks.id, id)))[0].revokedAt?.getTime()).toBe(first?.getTime())
  })

  it('revoke-all stops every live link of the license and nobody else\'s', async () => {
    const { app, db } = await appWith()
    await create(app)
    await create(app)
    await db.insert(watchLinks).values({ id: 'M'.repeat(22), licenseId: 'lic-2', joinKeyHash, expiresAt: new Date(Date.now() + 3600_000) })
    expect((await app.request(post('/v1/watch-links/revoke-all', { entitlement: ent() }))).status).toBe(204)
    const rows = await db.select().from(watchLinks)
    expect(rows.filter((r) => r.licenseId === 'lic-1').every((r) => r.revokedAt)).toBe(true)
    expect(rows.find((r) => r.licenseId === 'lic-2')?.revokedAt).toBeNull()
    expect((await app.request(post('/v1/watch-links/revoke-all', { entitlement: ent('lic-1', 'p', 'host') }))).status).toBe(403)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/watch-links.test.ts -t "revoke"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Register `revoke-all` **before** the `/:id/…` routes is not required (different segment counts), but keep it next to them:

```ts
  app.post('/v1/watch-links/revoke-all', limit, async (c) => {
    const parsed = OwnerBody.safeParse(await readBody(c))
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
    const ent = verifyEntitlement(parsed.data.entitlement, deps.entitlementPublicKey)
    if (!ent || typeof ent.licenseId !== 'string') return c.json({ error: 'not_entitled' }, 402)
    if (!ownsLicense(ent)) return c.json({ error: COMPANION_REFUSAL }, 403)
    await db
      .update(watchLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(watchLinks.licenseId, ent.licenseId), isNull(watchLinks.revokedAt)))
    return c.body(null, 204)
  })

  app.post('/v1/watch-links/:id/revoke', limit, async (c) => {
    const who = await asOwner(c.req.param('id'), await readBody(c))
    if (!who.ok) return c.json(who.body, who.status)
    await db
      .update(watchLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(watchLinks.id, who.row.id), isNull(watchLinks.revokedAt)))
    return c.body(null, 204)
  })
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/watch-links.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/watch-links.ts test/watch-links.test.ts
git commit -m "feat(watch-links): owner revoke and revoke-all"
```

---

### Task 6: Admin — list and revoke live links

**Files:**
- Modify: `src/routes/admin.tsx`
- Test: `test/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/admin.test.ts` (reuse that file's existing `createApp`/auth helpers; the header is `authorization: 'Basic ' + Buffer.from('admin:' + TOKEN).toString('base64')`):

```ts
it('lists live links and revokes one', async () => {
  const { db } = await makeTestDb()
  const app = createApp(db, TOKEN)
  const auth = { authorization: 'Basic ' + Buffer.from('admin:' + TOKEN).toString('base64') }
  await db.insert(watchLinks).values({ id: 'L'.repeat(22), licenseId: 'lic-1', joinKeyHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600_000) })
  const page = await app.request('/admin', { headers: auth })
  const html = await page.text()
  expect(html).toContain('Live links')
  expect(html).toContain('L'.repeat(22))
  expect(html).not.toContain('a'.repeat(64)) // the join key hash is never shown
  const res = await app.request(`/admin/watch-links/${'L'.repeat(22)}/revoke`, { method: 'POST', headers: auth })
  expect(res.status).toBe(302)
  const row = (await db.select().from(watchLinks).where(eq(watchLinks.id, 'L'.repeat(22))))[0]
  expect(row.revokedAt).toBeInstanceOf(Date)
})
```

(Add `watchLinks` to that file's schema import and `eq` from `drizzle-orm` if absent.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/admin.test.ts -t "live links"`
Expected: FAIL — the page lacks "Live links".

- [ ] **Step 3: Implement**

In `src/routes/admin.tsx`: add `watchLinks` to the schema import and `desc` to the drizzle import. In the `/admin` handler's `Promise.all`, add `db.select().from(watchLinks).orderBy(desc(watchLinks.createdAt)).limit(50)` and bind it as `links`. After the "App Store" card, render:

```tsx
<div class="card">
  <div class="card__h">
    <span class="tick" />
    <h2>Live links</h2>
    <span class="note">latest {links.length} · content is end-to-end encrypted; revoke is the only tool</span>
  </div>
  <table>
    <tr><th>Link id</th><th>License</th><th>State</th><th>Created</th><th>Ends</th><th /></tr>
    {links.length ? (
      links.map((l) => {
        const state = l.revokedAt ? 'revoked' : l.expiresAt.getTime() <= Date.now() ? 'expired' : 'live'
        return (
          <tr key={l.id}>
            <td style="font-family:var(--mono);font-size:12px">{l.id}</td>
            <td style="font-family:var(--mono);font-size:12px">{l.licenseId}</td>
            <td><span class={`pill ${state === 'live' ? 'pill--on' : 'pill--off'}`}>{state}</span></td>
            <td class="muted">{new Date(l.createdAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td class="muted">{new Date(l.expiresAt).toISOString().slice(0, 16).replace('T', ' ')}</td>
            <td style="text-align:right">
              {state === 'live' ? (
                <form class="inline" method="post" action={`/admin/watch-links/${l.id}/revoke`}>
                  <button class="btn btn--ghost" type="submit">Revoke</button>
                </form>
              ) : null}
            </td>
          </tr>
        )
      })
    ) : (
      <tr><td colspan={6} class="muted">No live links yet.</td></tr>
    )}
  </table>
</div>
```

Add the action next to the other admin POST handlers:

```ts
app.post('/admin/watch-links/:id/revoke', async (c) => {
  await db
    .update(watchLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(watchLinks.id, c.req.param('id')), isNull(watchLinks.revokedAt)))
  return c.redirect('/admin')
})
```

(`and`, `isNull` from `drizzle-orm`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/admin.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tsx test/admin.test.ts
git commit -m "feat(admin): list live links and revoke one"
```

---

### Task 7: Docs, full suite, branch push, PR

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the env vars**

Under README's "## Licensing (B3)" section add:

```markdown
### Live links

`/v1/watch-links/*` (registered with the licensing routes) gates the desktop's live links. Two
optional env vars:

- `WATCH_LINK_VIEWER_ORIGIN` — the only origin CORS admits on the join route. Default
  `https://nodeterm.dev`.
- `WATCH_LINK_MAX_TTL_SECONDS` — lowers the 24 h link ceiling. Default `86400`.

The server stores `sha256(joinKey)` only; the link secret stays in the URL fragment. The relay is
unchanged: links use pairing ids `wl.<linkId>`.
```

- [ ] **Step 2: Run everything**

Run: `npm run typecheck && npm test`
Expected: all green. If a pre-existing test is red on `origin/main` too, record it in the PR text rather than touching it.

- [ ] **Step 3: Mutation check (mandatory)**

Break each rule on purpose, run `npx vitest run test/watch-links.test.ts`, confirm red, then restore:
1. In the join route, replace the key comparison with `const match = row !== null` → the "wrong key like unknown id" test must fail.
2. In `asOwner`, drop `row.licenseId !== ent.licenseId` → the 404-to-another-license test must fail.
3. In `licenseLiveness`, return `'live'` for `source === 'free'` → the free-license test must fail.
4. In `linkState`, change `<=` to `<` → the "expiry inclusive" test must fail.
5. Remove the `app.use('/v1/watch-links/:id/join', cors(...))` → the CORS test must fail.

Record the five results in the PR description.

- [ ] **Step 4: Commit and push the branch (never main)**

```bash
git add README.md
git commit -m "docs(readme): live links env vars"
git log --oneline origin/main..HEAD
git push -u origin feat/watch-links
```

- [ ] **Step 5: Open a PR (English, pr-writing style)**

```bash
gh pr create --title "feat: live links API (watch_links + /v1/watch-links)" --body-file /tmp/watch-links-pr.md
```

The body says: what changed (table, six routes, admin card), why (desktop Pro live links; spec path in the nodeterm repo), how it was checked (suite + the five mutation results), what was not (no desktop client yet — the routes are inert until Plan 2 ships; no deploy performed), and the deploy note (a migration `0014_*` runs at container start). End with the attribution line from the session's system reminder. **Do not merge; enes decides.**
