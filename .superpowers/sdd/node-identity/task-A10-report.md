# Task A10 report — every client presents its per-node token

**Status:** COMPLETE

## What shipped

All four clients now read `<$NODETERM_NODE_TOKEN_DIR>/<$NODETERM_NODE_ID>` — a lookup by name,
never a scan — and put its first line on `X-Nodeterm-Node-Token` for every request. Missing file,
missing dir, pre-v2 endpoint ⇒ empty ⇒ the server's `legacy` path, unchanged.

- `src/core/agents/hooks/managed-script.ts` (claude/gemini/codex/grok, local + remote)
  - new `nt_read_node_token()` helper + a call right after the endpoint file is sourced;
  - the header on ALL FOUR curls (request POST socket + port, "answered" POST socket + port);
  - `nt_pick_fallback` now also clears `NODETERM_NODE_TOKEN_DIR` before sourcing;
  - `nt_send_request` calls `nt_read_node_token` AFTER a successful fallback, before the re-POST.
- `src/main/canvas-control-core.ts` — `CONTROL_SHIM_SCRIPT`, both curl branches.
- `src/core/context-link-core.ts` — `CONTEXT_SHIM_SCRIPT`, both curl branches.
- `src/core/agents/hooks/opencode.ts` — `live()` seeds `tokenDir` from
  `NODETERM_NODE_TOKEN_DIR` and a second regex picks the v2 line out of the endpoint file
  (its prefix differs from `NODETERM_HOOK_*`, so widening the existing group was not an option);
  a `nodeToken(dir)` reader feeds the `x-nodeterm-node-token` header in the shared `headers`
  object, which all three transports (Bun unix `fetch`, TCP `fetch`, `node:http` socketPath) use.

`codex-identity-proxy.ts` untouched (task A12).

## Tests — real execution, written RED first

17 new assertions failed before the change, all pass after.

- `managed-script.test.ts` (+1 file-local suite, +7 tests → 38 in the file):
  a REAL hook server with a REAL secret, the REAL generated script under `/bin/sh` with the REAL
  curl, asserting the SERVER's own verdict (`meta.verified`):
  - token file present ⇒ `verified: true`;
  - dir advertised only by the ENDPOINT FILE ⇒ `verified: true` (pins "after the source");
  - no token file / no dir at all ⇒ one event, `verified: false`, exit 0;
  - dir holding only ANOTHER node's token ⇒ one event, `verified: false` (presenting it would be
    `forged` ⇒ 403 ⇒ NO listener call, so "exactly one unverified event" is the assertion);
  - **failover, real server:** dead unix-socket primary whose dir holds a FOREIGN-secret token,
    live fallback endpoint advertising its own dir with the real token ⇒ `verified: true`.
  - plus two fake-curl fixtures for the header text itself: the retry carries the FALLBACK dir's
    token and never the primary's, and a pre-v2 fallback (no dir line) leaves the header empty.
- `canvas-control-shim.test.ts` (+5): the real shim, real curl, against header-capturing servers
  on BOTH transports — present / from the endpoint file / absent / another node's id.
- `context-link.cli.test.ts` (+5): same shape for `context.sh`.
- `opencode.test.ts` (+8): the generated plugin body imported and executed — TCP `fetch`, Bun
  unix `fetch`, and `node:http` against a real unix server; present / absent / no dir / other
  node / dir learned from the endpoint file.

**Mutation-checked** (both failover subtleties are proven by tests, not by inspection):
- delete `nt_read_node_token` from the fallback branch ⇒ 3 tests fail (incl. the real-server one);
- delete `NODETERM_NODE_TOKEN_DIR=""` from `nt_pick_fallback` ⇒ 1 test fails.

## Gates

- `npx vitest run src/core/agents src/main/canvas-control-shim.test.ts src/core/context-link.cli.test.ts src/core/no-electron.test.ts src/server/no-electron.test.ts`
  → **21 files, 240 tests, all passing.**
- `npm run typecheck` → clean.
- Wider regression run (`src/core src/main src/server src/shared test/server`): 247 files,
  3153 tests — only `src/main/node-pty-patch.test.ts` (3) fails, and it fails identically at HEAD
  with all my changes stashed: the clone's `node_modules` is a symlink to an unpatched tree.

## Concerns

1. **curl drops an empty header.** `-H "X: ${empty}"` sends NOTHING — curl removes a header with
   no content after the colon (measured). So the sh clients send "absent", not "present but
   empty". The server reads both as `legacy`, so the contract holds exactly, but any later task
   that wants to DISTINGUISH "client is A10-aware but has no token" from "client predates A10"
   cannot do it from this header. The opencode plugin does send a literal empty value.
2. **`/control/*` and `/context-link/*` do not verify the header yet** (A7 only armed `/hook/*`).
   Those two shims are therefore proven only up to "the header is on the wire with the right
   value" — asserted against real capturing servers, but not against a real verdict. The managed
   hook script IS proven against a real verdict.
3. **Every client path is covered by a real-execution test.** No path was left to string matching
   alone. The one thing not exercised end-to-end is the token file being written by the REMOTE
   host writer (control-master's `remoteEndpointFileContents` advertises the remote dir) — that is
   the remote-materialisation task's ground, not A10's.
4. **`spawnSync` cannot be used for these tests.** It blocks node's event loop, so an in-process
   hook server never accepts the connection and every POST silently "fails" into the failover
   path. The new suites spawn asynchronously; the pre-existing fake-curl fixtures still use
   `spawnSync` because nothing in-process has to answer them.
5. **This clone is shared with a parallel session.** Three commits (`f502f413`, `bce88091`,
   `94e835ac`) landed on `feat/node-identity` while A10 was in progress, and that session has
   uncommitted work in `node-token-service.ts` / `pty-manager.ts`. The A10 commit lists its eight
   paths explicitly and touches nothing of theirs.
