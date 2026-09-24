# S6 acceptance gate — machine-scoped managed Codex accounts

**S6 is not "done" until this gate is green.** The feature closes external PR #112 (@Corvin). Every
mechanism (PRs 1–8.5) is merged and unit-tested against real primitives, and the composition is walked
once end-to-end in `src/main/codex-accounts-e2e.test.ts`. But several legs **cannot run in headless
CI** — a live `codex app-server`, a second logged-in ChatGPT account, a real SSH host with a
curl-managed standalone Codex install, and the renderer's imperative pane-recycle sequencing. Those
are the checklist below. **The code fails CLOSED on each**, so a false assumption is a *refused* op and
a *rolled-back* copy, never a silent corruption — but "fails closed" is not "verified", and nobody may
call S6 verified until a human runs these on a real Mac + real host.

## What CI already proves (no device needed)

`npx vitest run src/main/codex-accounts-e2e.test.ts` — the one long composition test. Against REAL
primitives (real fs, real `/bin/sh`, real HMAC, the real main-side switch handler; only the live
app-server JSON-RPC is faked, and the rollout path it returns is a real on-disk file):

- a managed account home resolves its spawn scope; an explicitly selected **missing** account
  **refuses** to spawn (no system fallback);
- a signed ownership record is recovered under real `/bin/sh` by the resolver prelude;
- the three-phase main-side switch **hardlinks the rollout inode** into the target (same conversation
  id, never a fork) and the local copy remains;
- the local→SSH transfer source leg hands off the containment-validated path and keeps the local copy;
  an absent importer **fails closed**;
- the same thread id in two scopes resolves to **no owner** in the proxy, the sh resolver, and the
  relay catalog;
- a different existing rollout at the target is **never overwritten** (the local twin of remote
  `exit 17`);
- usage stays **per-account** (each row stamped with its own id, `unavailable` included), never mixed;
- the Server Edition arms the record secret **raw** (`node-auth-key.bin`, `0600`), no keychain
  plaintext; with no secret armed a record write throws rather than writing unsigned;
- **no credential rides any argv** (tmux env, the generated launcher, the auth-env strip).

Mutation report (GC 9): 5 source mutations introduced, 5 caught (5/5) — M1 spawn-scope fallback, M2
ambiguity gate, M3 rollout never-overwrite, M4 usage attribution, M5 sh `matches -eq 1` gate.

## Owed device verifications — a human MUST run these before S6 is called done

Everything below needs **a real Mac desktop + a real SSH host** with a curl-managed **standalone**
Codex install + a **logged-in 2nd managed account**. Headless CI cannot run them.

- [ ] **U1 — a running app-server discovers a hardlinked rollout without a reindex.** Load-bearing for
      the copy. Code mitigation: verify-then-recycle ⇒ a false U1 is a refused copy + rollback, never
      silent. VERIFY: expose a thread to a 2nd account and confirm the **live daemon** finds it *before*
      the node recycles.
- [ ] **U2 — the conversation id survives copy + switch under a 2nd login.** Hardlinked inode +
      resume-by-path + the `-32004` guard. VERIFY: switch a **running** node's account and confirm the
      **same** conversation resumes — not a fork.
- [ ] **U4 — live RPC payload shapes.** `account/read` → `{email}`, `thread/read` → `{path, cwd}`,
      confirmed against Codex 0.146.0 via `app-server --listen`; the **curl-standalone `daemon start`**
      path is still owed. VERIFY the shapes against the daemon the app actually starts.
- [ ] **Full desktop → host flow over real WAN.** Add account, remote **device-login**, **import** a
      conversation to an SSH account, then **recycle** the node onto the host. Owed on Mac + real host.
- [ ] **The imperative pane-recycle glue** (commit → rebind → restartShell → finish) + a **live SSH
      remote-account switch.** The pure logic + the main-side switch are unit-tested; the imperative
      renderer sequencing is only exercised against the running app. The SSH switch is wired
      (2026-09: node menu / kanban card → `switchThreadRemote` → relay `expose-thread` on the host →
      recycle). VERIFY on a real host: switch an idle SSH Codex node A→B, the pane resumes the SAME
      thread under B's `CODEX_HOME` (`echo $CODEX_HOME`, then the conversation history), and B's
      usage moves; switch back B→A.
- [ ] **Remote-host account LIFECYCLE** (add / login / remove **on** an SSH host). Wired 2026-09: the
      machine panel's Add creates the home ON the host (`remoteCodexAccountAdd`), opens
      `codex login --device-auth` in the host's tmux under that account's `CODEX_HOME`, and polls the
      host for a real `auth.json`; Remove deletes it there. Unit-tested only. VERIFY on a real host:
      the device flow completes, the row picks up the email (needs the relay runtime — without it the
      login completes with no email), a new Codex node on that host runs under the managed home
      (`echo $CODEX_HOME` in the pane), and Remove leaves no `~/.nodeterm/cx/<digest>` behind.

## Happy-path acceptance walk (the one a human runs end to end)

On a real Mac with a real SSH host and a 2nd ChatGPT login available:

1. **Add account** — Settings → add a managed Codex account, complete the device login; the row shows
   its captured email and stops being `pending`.
2. **New node under it** — stamp a fresh Codex node and pick the managed account in the per-node picker;
   confirm the node runs against that account's isolated home (its own `auth.json`, not the system one).
3. **Switch** — switch the running node to another account; confirm the **same conversation resumes**
   (U2), not a new thread, and that the source account's copy is still usable (the hardlink).
4. **Copy to SSH** — transfer the (idle) conversation to a remote account on the SSH host; confirm the
   id survives, the far side **discovers** it (U1), the **local copy remains**, and a pre-existing
   remote rollout is **never overwritten**.
5. **Recycle** — recycle the node onto the host; confirm it resumes the imported conversation.

Failure expectations to spot-check while walking it: a selected-but-missing account **refuses** (no
fallback); the same thread id claimed by two accounts resolves to **no owner**; removing an account
while a switch holds it is **refused**; the phone can **read** account state but never originate an
add/switch/copy.

---

Credit: @Corvin (external PR #112). S6 = PRs 1–9 (this gate is PR 9 of 9).
