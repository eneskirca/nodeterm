# Mobile parity: push eventId — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Every push event the desktop sends to `POST /v1/push/notify` carries the mirror inbox event id (`eventId: e.id`), so a phone can claim the exact Inbox card instead of matching by node+kind+ts.

**Architecture:** One optional field on `PushNotifyEvent` (`src/core/push-notify.ts`), set in `onEvent` from `InboxEvent.id`. Core-only; both senders of this payload go through `onEvent`, including the presence hold queue (the held copy is the same payload object).

**Tech Stack:** TypeScript, vitest.

**Spec:** /root/.android-desks/briefs/wave5-upstream-fixes.md, section E.

## Findings triage (done before planning)

- **E1 (push eventId)** — valid. Server (nodeterm-server origin/main `src/routes/push.ts`) already accepts
  `eventId: z.string().max(400).optional().catch(undefined)` and forwards it to FCM only
  (`lib/fcm-payload.ts`, gated on `^[A-Za-z0-9_-]{1,256}$`); the APNs payload never carries it, so iOS
  payloads stay byte-identical. The mirror id is `${ts}-${seq}`, inside that grammar. An older backend's
  zod object strips unknown keys, so the field is safe against any deployed server.
- **E2 (license `google` source)** — already on origin/main (ced59afe7, "feat(license): accept the google
  source and explain a Play-bridged Pro"): `LICENSE_SOURCES` includes `'google'`, `LicenseSource` type,
  the Google Play sentence in `licenseCopy.ts` + tests, `canUseKeyElsewhere` excludes google, and an
  unknown source degrades to `null` (`license.test.ts` "still degrades an unknown source word to null",
  `licenseCopy.test.ts` "an unknown source HIDES the action"). Dropped: nothing left to do.

## Global Constraints

- `src/core` must not import electron (enforced by `no-electron.test.ts`).
- `ts` stays Unix milliseconds, forwarded verbatim (TS_UNIT).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A held (presence-deferred) event flushed on away must still carry its `eventId`.
- Batched events: each event carries its OWN id, not the first one's.
- Grant-mode POSTs (Bearer) carry the same per-event body as host-mode.

---

### Task 1: forward `eventId` in the push payload

**Files:**
- Modify: `src/core/push-notify.ts` (`PushNotifyEvent` interface; `onEvent` payload builder)
- Test: `src/core/push-notify.test.ts`

- [ ] **Step 1: Write the failing tests** in `push-notify.test.ts`, using the file's existing harness
  helpers: (a) an immediate send's body has `events[0].eventId === <the InboxEvent id>`;
  (b) two events for two nodes in one batch carry their own ids in order; (c) an event held while the
  user is present and flushed on the away edge carries its id; (d) a grant-mode POST carries it too.
- [ ] **Step 2: Run** `npx vitest run src/core/push-notify.test.ts` — expect the new tests to FAIL
  (`eventId` undefined).
- [ ] **Step 3: Implement**: add to `PushNotifyEvent`
  ```ts
  /** The mirror inbox event id (`InboxEvent.id`, `${ts}-${seq}`), so a phone can claim the exact
   *  Inbox card. The backend forwards it to FCM only; the APNs payload never carries it. */
  eventId?: string
  ```
  and in `onEvent`'s payload literal add `eventId: e.id,` right after `kind`.
- [ ] **Step 4: Run** the file again — PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(push): forward the mirror inbox event id in push payloads`.
