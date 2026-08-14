# Codex shared identity

How many Codex canvas nodes share one `codex app-server`, how each node keeps a stable identity
inside it, and — the part that matters most in practice — what happens when none of that is
available.

Companion to `docs/grok-agent.md` and `docs/gemini-agent.md`; §9 is the device checklist those
files' §9 sets the format for. Sliced from external PR #112 by **Corvin**
(`corvin@streamlain.com`).

---

## 1. What it buys

A Codex terminal node used to spawn a full `codex` process tree — an app-server each. A canvas with
a dozen Codex nodes paid for a dozen servers against one account. Now every node on a machine talks
to **one** `codex app-server` and owns one **thread** inside it.

The node ↔ thread mapping is what makes that survivable. It has to outlive the app, because tmux
sessions do: a running Codex client can outlive the Electron process that started it, and after a
restart nothing in memory knows whose conversation is whose.

### What it requires: an install channel, not a version

`codex app-server daemon start` — the whole feature's foundation — runs the app-server out of a
**standalone runtime the Codex installer manages**, at the fixed path
`<CODEX_HOME>/packages/standalone/current/codex`. An install that does not put a runtime there
cannot host a shared app-server **at any version**:

```
$ codex --version
codex-cli 0.146.0
$ codex app-server daemon start
Error: managed standalone Codex install not found at /root/.codex/packages/standalone/current/codex

This command requires the standalone install managed by the Codex installer, because the daemon
starts and updates app-server from that fixed path.

Install it with:
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

That is codex **0.146.0 installed via npm** — the mainstream channel, and the one
`docs/troubleshooting-codex-snap.md` steers users toward. It is not an old CLI: its `--help` lists
`--remote` and `--remote-auth-token-env`, `codex app-server daemon --help` lists every subcommand,
and `codex app-server daemon stop` reports the requirement itself as JSON
(`"managedCodexPath":"/root/.codex/packages/standalone/current/codex","managedCodexVersion":null`).

So the population that gets a shared identity is **the standalone-installer channel**, and every
other install runs plain `codex`. §3 is what makes that a quiet degrade instead of a noisy one.

## 2. The pieces

| File | Job |
| --- | --- |
| `src/core/codex-identity-proxy.ts` | The thread → node record store (signed), and the generated launcher. |
| `src/core/codex-thread-identity-sh.ts` | The POSIX-sh prelude prepended to every managed hook script. |
| `src/core/codex-session-name.ts` | The app-server protocol client: mint a thread, check one exists, read its name. |
| `src/core/codex-identity-caps.ts` | "Can a node on this machine get a managed identity?" — the construction-time gate. |
| `src/core/agents/hook-server.ts` | The `/codex-thread/{start,bind,fallback}` routes and the per-node capability. |
| `src/core/agents/node-auth-secret.ts` | The one restart-stable secret both of the above are keyed on (sealed via `safeStorage` on the desktop, raw 0600 bytes on the Server Edition). |
| `src/core/agents/node-auth-token.ts` | The one derivation — `kid.mac` — and the three-way verifier every route judges a presented token with. |
| `src/core/agents/node-token-files.ts` | How a token reaches the client: one 0600 file per node under `node-tokens/`, never the tmux argv. |
| `src/renderer/state/codexIdentity.ts` | The renderer's gate + the transient per-node mode the UI shows. |

### The records

One file per thread under `<userDataDir>/codex-thread-nodes/<threadId>`:

```
nodeId=term-17
endpoint=/Users/x/Library/Application Support/nodeterm/hook-endpoint.env
signature=<base64url HMAC-SHA256>
```

Through `CorePlatform.userDataDir`, **not** `homedir()` — that was the original shape and it is why
the Server Edition had no story at all. The generated sh gets the same path baked in, POSIX-quoted
(the real one contains a space on macOS), so the two cannot disagree.

Account scoping is deliberately absent: managed Codex accounts are a later slice, and scoping adds
a directory level above this without changing anything the format promises.

### Why the records are signed

The hook prelude reads a record and **re-exports both fields into an agent's environment**. An
attacker who could write one would be choosing a session's node id and hook endpoint. So each
record carries an HMAC over `(threadId, nodeId, endpoint)`; a record that does not verify is
ignored, never repaired, and never deleted by the pruner either.

The sh side cannot verify that HMAC — there is no key in an agent's shell — so the prelude
re-validates the *shape* of both fields (`L1` in the review: the signature is a desktop-side
guarantee, and the prelude's charset checks are the second layer, not a redundancy).

### The per-node capability — the security fix

The hook server's bearer token proves only *"this request came from some nodeterm-spawned
session"*. It cannot prove **which**. Every identity route takes a caller-supplied `nodeId`, so with
the shared bearer alone any agent session could bind **its own** thread to a **sibling** node —
reparenting that node's status, and (via the prelude) aiming its hook traffic.

Each `/codex-thread/*` route therefore also requires `X-NodeTerm-Node-Token` =
`HMAC(secret, nodeId)`: restart-stable, scoped to one node, injected only into that node's session
env by `buildPtyEnv`, and never written to the shared endpoint file every session can read. The
same secret signs the records.

`/codex-thread/fallback` is the one exemption, and it is as narrow as it can be made: the commonest
thing it reports is *"there was no capability to present"*, so requiring one would silence it in
exactly the case it exists for. A report that **does** carry a token must carry the right one, so
only a tokenless caller is trusted on the node id it names.

A cold app-server is handled on both routes: `codex app-server daemon start` exiting 0 does not
mean the control socket is accepting connections yet, so `waitForCodexAppServer` (3 × 200 ms)
precedes the mint, and the bind check retries only when it could not REACH the server — a server
that answered "I do not have that thread" is never retried, because that is an answer.

If secure storage is unavailable the whole feature stays off — `codexIdentityCaps()` answers
`shared: false`, every launch line stays the bare `codex`, and nothing is half-armed.

### The routes

| Route | Token | Handler |
| --- | --- | --- |
| `POST /codex-thread/start` | required | mint a thread on the app-server, write its record, return the id |
| `POST /codex-thread/bind` | required | verify the thread exists, then record that this node owns it |
| `POST /codex-thread/fallback` | tokenless, or matching | mark the node as running plain codex |

`start` mints through a five-step conversation (`initialize`, `thread/start`, an empty
`turn/start`, `turn/interrupt`, `thread/fork` before that turn, `thread/delete` of the seed).
`thread/start` alone creates only app-server metadata and does **not** materialize the rollout file
— a second client's `thread/resume` then fails with "no rollout found", which is precisely what the
launcher does one line later. The fork-and-delete dance produces a thread with zero user turns and
a valid rollout without the deprecated rollback API.

That conversation runs against a server that is typically **cold** (the first Codex node after
boot). Three budgets have to stay ordered, and the ordering is the whole point:

```
launcher curl (30 s)  >  server handler (CODEX_THREAD_START_TIMEOUT_MS, 20 s)  <  socket guard (CONTROL_CEILING_MS, 130 s)
```

Get the first comparison backwards and curl quits while the server carries on to create a thread
and write a record nothing will ever resume — an orphan pair per attempt. Get the second wrong and
the route inherits the 2 s **slowloris** guard, which is a RECEIVE-phase guard: it destroys the
socket while the handler is still working, on the most common launch there is. `handleCodexThread`
hands off to `CONTROL_CEILING_MS` after `readBody`, exactly as `/control/` and `/context-link/` do,
and `codex-launcher-sh.test.ts` pins it with a start handler that sleeps.

---

## 3. The fallback

**Every failure path ends in `exec codex "$@"`, arguments intact.** Upstream exited 69 "identity
unavailable", which turns a missing app-server, an older `codex`, a stale tmux session or a
locked-down data dir into a **dead node**. The repo's own precedent is `gatePermissionMode`: an
unknown or failed probe degrades to the bare command, never to a blocked launch.

The decision lives in two places at different granularity, and **the script is the authority**.

**1. Construction time** — `codexIdentityCaps()`. `AGENT_CONFIG.codex.launchCmd` stays `'codex'`,
byte-identical; `agentLaunchProgram(id, base, sharedIdentity = false)` names the launcher only when
the caller opts in, and `codexSharedIdentity(remote)` says yes only when the probe reports an
installed + armed launcher **and** the session is local. (An SSH host has no launcher installed —
that is a later slice — so a launcher-named line there would be `command not found`, i.e. the exact
dead node this exists to prevent.) The default `false` means every call site that has not opted in
emits today's command.

`shared` is the AND of **four** things, and the last two are the interesting ones.

**Can this install run an app-server at all?** (`appServer`, `codexManagedRuntimeInstalled`.) The
question §1 poses, answered by a **stat** of `<CODEX_HOME>/packages/standalone/current/codex`. The
first cut of this file asked a different question — does `--help` mention `--remote` — which an
npm-installed codex 0.146.0 answers *yes* while `daemon start` refuses, so on the mainstream
channel we wrote `nodeterm-codex` into every launch line and only found out at runtime: a wasted
curl round trip, a `plain codex` chip, and the first-fallback banner, per node, forever, for a
feature that cannot function there. The feature is meant to be **inert** off the standalone
channel, not noisily inert.

Why a stat, and not the authoritative command:

| Candidate | Why not |
| --- | --- |
| `codex app-server daemon start` | It **starts a daemon**. The probe runs at boot on every machine with codex installed, including the runs where no Codex node is ever opened; a capability probe must not create the very process the feature exists to create lazily. |
| `codex app-server daemon version` | Read-only, but it connects to the control socket, so it fails on a perfectly capable install whose daemon merely is not up yet — i.e. after every boot. The probe runs ONCE, so that pins the feature off for the session on exactly the machines it is for. |
| `codex app-server daemon stop` | Prints the authoritative JSON (`managedCodexPath`, `managedCodexVersion`) and exits 0 even when nothing is running — but it **stops a running daemon**, which is the shared app-server every other node is attached to. |

The path is not inferred: the CLI names it verbatim in its refusal and reports it as
`managedCodexPath`. It is resolved through `codexHome()`, so `$CODEX_HOME` is honored (with §8.5's
caveat that the pane may resolve it differently). Anything unestablished — a missing path, a
non-executable file, a permission error, a layout we do not recognise — is **false**.

**Does the installed `codex` accept `--remote`?** (`remoteFlag`, `codexCliSupportsRemote`.) The
only precondition with no runtime recovery — the launcher's preflight proves `daemon start` exits 0
and then **execs**, and a CLI with an app-server but no `--remote` dies on a clap usage error where
no fallback is left. Feature-detected from the CLI's own `--help` (and `codex resume --help` if the
first does not say), never version-compared, for the same reason claude's `--session-id` is: an
unrecognised flag does not degrade, it makes the CLI exit.

The install check runs **first** and short-circuits the help spawns: with no app-server to reach
there is nothing to learn about a flag we will never use, so `remoteFlag` reads false there as
"not probed" — unknown, like every other unknown in this file.

Unknown anywhere in the chain — no CLI on the login PATH, a failed or timed-out spawn, no standalone
runtime, help text that never mentions the flag — means **false**, i.e. plain codex. A wrong "yes"
costs the node (or at minimum a banner on every one of them); a wrong "no" costs only the shared
app-server. Both probes run **once per app run, inside `refreshCodexIdentityCaps()`, entirely off
the launch path**: a per-launch probe would be visible latency in the pane every time, to answer a
question whose answer cannot change while the app runs.

Unlike claude's, this probe cannot compute anything until the shell hands the hook server its
secret, so the shell **pushes** the answer in and an early caller **waits**. A sync getter would
answer "no" to anything that asked first, and a "no" pins the feature off for the whole run with no
chip, no toast and no log line — one boot-chain reordering away, invisibly.

**2. Runtime** — the launcher. Only the script can see the pane's env, whether the endpoint file is
readable, whether the broker answers, or whether the installed `codex` even has an app-server. It
preflights all of that and, on any miss, execs plain codex.

### Where it surfaces

Not silent, and **never in the pane** — text pushed into an agent's terminal is prompt injection,
which this repo forbids.

- the launcher POSTs `/codex-thread/fallback` with a machine-readable reason before exec'ing;
- the node header shows a muted **`plain codex`** chip whose tooltip says why;
- the **first** fallback per node also raises the warning banner, because a chip on a node you are
  not looking at teaches nothing.

The mode is **transient**, never persisted: it describes one launch of one process, and a stale
"plain" badge on a reloaded node would be a lie.

### The reasons

| Reason | Means |
| --- | --- |
| `node-id-unavailable` | not a nodeterm-spawned session (the launcher was run by hand) |
| `hook-endpoint-unavailable` | the endpoint file is missing or unreadable |
| `broker-unreachable` | the hook server's coordinates are unusable |
| `node-token-unavailable` | no per-node capability — usually no secure storage |
| `thread-id-unavailable` | the session id to resume is not shaped like one |
| `app-server-unavailable` | `daemon start` failed with a standalone runtime present — an older CLI, or a daemon that would not come up |
| `codex-standalone-missing` | `daemon start` failed and there is no standalone runtime — an npm or snap install (§1), not a version problem |
| `thread-bind-refused` | the thread is unknown to the server, or a live node already owns it |
| `thread-start-failed` | the server would not mint a thread |

The last two used to be one reason whose copy said *"an older CLI"*, which sent anyone reading it on
a codex 0.146.0 node hunting for a version problem that did not exist — the
misleading-error-message class this repo has lost diagnosis time to before. The launcher runs
`daemon start` first, unchanged and authoritative, and only then stats
`${CODEX_HOME:-$HOME/.codex}/packages/standalone/current/codex` to decide **which** of the two it
hit. That ordering matters: a stat that ran first would let a future codex that no longer needs the
standalone runtime fall back on evidence we have no business trusting over the command itself.

Caps normally keeps `codex-standalone-missing` away from the launcher entirely, so seeing it means
something the boot probe could not: the standalone install was removed while the app was running,
or the pane's `CODEX_HOME` differs from the desktop's (§8.5).

### What the fallback does NOT cover

**Everything after `exec` is unrecoverable.** Once the launcher runs
`codex --remote unix:// resume "$thread" "$@"`, a clap usage error or a "no rollout found" is a dead
node — the outcome this whole design exists to prevent, arrived at by a different door.

One class of that is closed defensively: **bind verifies the thread exists** on the app-server
before writing a record. The id reaching us is whatever the node persisted, and it can be stale or
left over from a session that ran under plain codex; binding it anyway wrote a record and then
exec'd a resume that died where nothing could catch it. Refusing here *is* the fallback. A server we
cannot reach answers "does not exist", which is the safe direction: refusing costs a plain codex
session, accepting costs the node.

The rest needs a real machine — §9.1-9.3.

### One deliberate non-use

**"Restart agent (resume)" keeps emitting the bare `codex resume <id>`.** It types into a pane that
already exists, and a tmux session created before the launcher was installed does not carry its
directory on PATH. A restarted node rejoins as a plain client until its next cold start.

---

## 4. The hook prelude

A shared app-server spawns a Codex **tool**'s shell itself, so that shell inherits `CODEX_THREAD_ID`
but none of the `NODETERM_*` env we set on the pane — the hook it runs would have no idea which
canvas node it belongs to, and the node's badge would simply never move. The prelude recovers the
binding from the thread id.

It is prepended to **every** agent's managed hook script, not just codex's. That is intentional: it
is inert without `CODEX_THREAD_ID` (which no other agent's tool shell sets), and one builder beats a
codex-only fork of it. It does change every agent's generated script, which is why
`managed-script.test.ts` asserts both its presence for all five builtins and that a missing identity
root yields the legacy script unchanged. **Remote (SSH) hosts get `null`** — the default root is
this machine's data dir, and baking it into a script on someone else's host leaks the desktop's
layout for no benefit.

---

## 5. Session names

`TITLE_READ_CAPABLE` gained `codex`; `RENAME_CAPABLE` did not. With the shared server a node owns a
thread, and that thread carries a `Thread.name` readable over the server's own socket — but there is
no measured rename command, so the read and write legs split exactly as they did for gemini. One
list for both would light the rename UI on a node where the write silently does nothing.

`readAgentSessionName` routes codex to its own reader **before** claude's: claude's resolver SCANS
`~/.claude/projects` on a cache miss, and its cwd fallback can hand back a stranger's session name.
Both shells' session-name sweeps take core's `supportsTitleRead` default, so codex is enrolled in
both without either shell being edited (the two drifted once before — see CLAUDE.md rule 10).

---

## 6. Three surfaces

- **Desktop** — full support.
- **Server Edition** — a deliberate, documented degrade to plain `codex`. The blocker is the
  *secret*, not the plumbing: the per-node capability is keychain-backed on desktop (Electron
  `safeStorage`) and there is no equivalent on a headless Linux host, so arming it means a secret at
  rest in the data dir — a security decision this slice is not entitled to make quietly. Everything
  it would need already lives in `src/core` and boots from `CorePlatform`; the wiring is three calls
  plus the two handler registrations, at the marked spot in `src/server/handlers/index.ts`. The
  renderer bridge already has a **real** `codex` namespace, so that side needs no change.
- **Mobile companion** (`~/projects/nodeterm-ios`) — N/A. It attaches to tmux sessions over the
  transport protocol; which app-server a Codex session talks to is invisible to it, and the
  `plain codex` chip is a canvas-node affordance the phone has no slot for. No protocol change owed.
- **Kanban** — the mode lives in a store the card modal could read; the chip is on the canvas node
  header only. Adding it to the card's expanded detail row is a small follow-up.

---

## 7. Not in this slice

The relay daemon, managed Codex accounts (including account-scoped record directories, which the
flat layout extends into cleanly), SSH hosts, browser control, and the mailbox/loop work — all from
PR #112, all still to be sliced.

---

## 8. Known gaps

1. **Post-`exec` failures are unrecoverable** (§3). The `--remote` case is closed at caps time;
   what remains is §9.2 (the composed `resume <id> <prompt> --ask-for-approval never` line) and
   §9.3 (the persisted session id being the app-server's thread id).
   - **The install-channel gate is a stat, not the command it stands for.**
     `codexManagedRuntimeInstalled` asserts the standalone runtime exists at the path today's CLI
     requires; it does not prove `daemon start` will succeed (a corrupt runtime, a wedged socket, a
     sandbox that blocks the spawn all still fail at the launcher, correctly, as
     `app-server-unavailable`). And should a future codex drop the standalone requirement, this
     answers a wrong **no** — plain codex, the direction everything here degrades in, but it would
     need re-measuring rather than assuming. The alternatives, and why none of them is cheaper
     *and* conclusive, are the table in §3.
2. **The launcher requires a hook PORT**, not a unix socket — it POSTs to
   `http://localhost:$NODETERM_HOOK_PORT`. Fine today (the desktop's hook server is a loopback TCP
   listener), but the Server Edition wiring will have to revisit it alongside `NODETERM_HOOK_SOCK`,
   which the launcher already reads for curl but not for the URL.
3. **The node token rides tmux `-e` on the local path**, i.e. it is in the tmux session env like
   every other `NODETERM_*` value. Same exposure as the hook bearer already has; noted rather than
   changed, because changing it means changing how all of them are delivered.
4. **Two residual orphan classes**, both inherent rather than bugs, neither covered by the budget
   ordering in §2. (a) A client that dies for a non-timeout reason — the pane killed, `tmux
   kill-session`, Ctrl-C mid-mint — still leaves the handler to finish and write its record. That is
   bounded now: §2's pruning removes it with the node, and the next launch mints a fresh thread
   anyway. (b) An app-server that aborts mid-conversation can leave the seed and/or the forked
   thread alive on ITS side, because the closing `thread/delete` may never be sent. Orphan
   *threads* have no reaper anywhere — not here and not in codex.
5. **`CODEX_HOME` is resolved twice**: the desktop resolves the app-server socket from the Electron
   process's environment, the pane resolves `--remote unix://` from its own. Identical unless a user
   sets `CODEX_HOME` in a shell rc only, in which case start succeeds and resume misses. Managed
   accounts make this explicit; until then it is a narrow, real mismatch.

---

## 9. Device checklist

Everything below needs a machine with a logged-in `codex`. Items 1-3 are the assumptions the
implementation could not verify; a failure in any of them is a **dead node**, not a degrade, so they
come first. Items 1, 2 and 5 fall out of a single capture run on one fresh node.

1. **`codex --remote unix://` works — the part the probe cannot answer by itself.**
   What no longer needs a device: whether this machine gets a shared identity at all. Both halves
   of that gate are answered per machine and pinned by tests — `codexManagedRuntimeInstalled`
   (§1's install-channel requirement, **measured false** on codex-cli 0.146.0 installed via npm,
   where `daemon start` refuses with "managed standalone Codex install not found") and
   `codexCliSupportsRemote` (the flag's presence). An install that fails either runs plain codex,
   silently, with no launcher ever named — so the negative case is closed on paper.
   What still needs a machine on the **standalone-installer** channel: that the flag we detect is
   the flag we then use. Check `--remote`'s argument form in `codex --help` against the two `exec`
   lines in the launcher, open a fresh Codex node, and confirm the pane shows a working session
   rather than a clap usage error. And confirm the whole gate one level up: on that machine the
   node comes up **shared**, while on an npm install the same build opens a plain codex node with
   **no chip and no banner at all** (not a `plain codex` chip — the launcher must never have run).
2. **`codex resume <id> <prompt> --ask-for-approval never` accepts a positional prompt AND a global
   flag after the subcommand.** This is the composed line `createAgentNode` builds, and it is
   CLAUDE.md rule 5's grok-`--` lesson exactly: a `withPermissionMode` unit test passes while the
   composed line is wrong. Create a Codex node with an initial prompt while the permission mode is
   anything but `manual`, and confirm the prompt reaches the model and the flag is honored (not
   swallowed into the prompt text, not a usage error).
3. **The session id nodeterm persists from hooks is the id the app-server accepts as a thread.**
   Let a Codex node run a turn, note `agentStatus.sessionId`, restart the app, and confirm the cold
   restore resumes the same conversation rather than falling back. If they are different
   namespaces, `bind` will refuse every resume and every restored node quietly runs plain codex.
4. **RAM, the thing this is for.** Open six Codex nodes; confirm `ps` shows ONE `codex app-server`
   and six thin clients, and compare RSS against six independent `codex` processes.
5. **The chip and the toast.** Force a fallback (rename `~/.nodeterm`… no — simplest: launch a node
   with `CODEX_HOME` pointed at a directory with no app-server, or use a CLI without
   `app-server`), and confirm the node shows `plain codex`, the tooltip names the reason, the
   banner appears once, and **nothing is written into the pane**.
6. **The session name.** Let codex name a thread, confirm the node title adopts it within a poll
   cycle, and confirm a hand-renamed node (`titleAuto` false) is left alone.
7. **Restart and reboot.** Restart the app with Codex nodes running: the tmux clients survive, the
   records are still trusted, and hooks from a Codex TOOL shell (which has only `CODEX_THREAD_ID`)
   still move the right node's badge — that last one is the prelude, and it is only exercised by a
   tool call, not by a plain turn.
8. **Deletion prunes.** Delete a Codex node permanently and confirm its records are gone from
   `<userDataDir>/codex-thread-nodes/` while other nodes' remain.
9. **Two nodes, one thread.** Point a second node at a thread the first still owns (a `resume` with
   a copied id) and confirm it falls back to plain codex instead of both clients attaching.
10. **A cold app-server, on the START path.** Kill the app-server, then open a fresh Codex node.
    Confirm it waits for the mint (which can take seconds) and comes up shared, rather than falling
    back with `thread-start-failed` while an orphan thread is created behind it.
11. **A cold app-server, on the RESUME/BIND path.** Kill the app-server, then cold-start an
    EXISTING Codex node (restart the app, or reboot). Bind now makes a mandatory app-server round
    trip, so a daemon whose socket binds a beat late would turn a legitimate resume into
    `thread-bind-refused` → plain codex. `waitForCodexAppServer` is meant to absorb that; confirm
    the node comes up shared and that a genuinely absent server still falls back promptly rather
    than hanging.
12. **`CODEX_HOME` set in a shell rc only** (§8.5). Put `export CODEX_HOME=…` in `~/.zshrc` (not in
    the app's environment) and open a Codex node. The desktop resolves the app-server socket from
    Electron's environment while the pane resolves `--remote unix://` from its own, so this is where
    they diverge: confirm what actually happens — shared against the wrong home, or a start that
    succeeds followed by a resume that misses.
