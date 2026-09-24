# Per-node hook identity

Two audiences: someone changing this code in six months, and the owner deciding whether to tighten
the cutoff. Both need the same three things — what the credential is, what it does **not** buy, and
which properties a change must not break. The invariant checklist at the bottom is the short version.

## What this is

Every agent session on a machine shares one hook bearer token. The bearer proves *"a session on this
machine"*; it cannot prove **which** session. Every hook route takes a caller-supplied `nodeId`, so
before per-node identity any session holding the bearer could post events as a sibling node, read a
sibling's linked transcript, or drive canvas control in its name.

Per-node identity adds a second credential: a **capability per node**, derived from one restart-stable
secret, distributed as a 0600 file, and verified three ways.

```
kid   = base64url(HMAC-SHA256(secret, "nt-node-auth-kid-v1"))[0..8]
mac   = base64url(HMAC-SHA256(secret, "nt-node-auth-v1|" + nodeId))
token = kid + "." + mac
```

**Derived, not minted-and-stored.** tmux sessions outlive the app, so a table built at spawn is empty
for every already-running session after a restart and cannot be rebuilt (a node's tmux session can
exist with no record on our side). A derivation lives exactly as long as the secret.

**Domain-separated.** The `nt-node-auth-v1|` prefix means the same secret can later mint other
capability *classes* (per-project, per-relay) without one being a valid other. The `kid` is a
non-secret routing hint: it says *whose* secret minted this, so another instance's token can be told
apart from a forgery.

### Three verdicts, not two

`verifyNodeToken` (`src/core/agents/node-auth-token.ts`) answers:

- **`verified`** — the caller holds the token this instance derived for that node id.
- **`legacy`** — no token, an empty header, another instance's `kid`, or no secret at all. This is
  *"we cannot judge this"*, **not** a failure. Every client older than the token, the phone, and the
  documented cross-instance failover land here.
- **`forged`** — **our** `kid` with a mac that is not this node's. Nothing legitimate produces it:
  only a holder of a token for another node, or a mutation of one. It is a 403 on every route,
  always, with no explanatory prose (advice would be advice to an attacker and a lie to nobody else).

| File | What it owns |
| --- | --- |
| `src/core/agents/node-auth-secret.ts` | The secret. `safeStorage` on the desktop, raw 0600 bytes on the Server Edition. |
| `src/core/agents/node-auth-token.ts` | The derivation, `verifyNodeToken`, `isForeignKidToken`, `isSafeNodeId`. |
| `src/core/agents/node-token-files.ts` | The 0600 token files in their 0700 dir. |
| `src/core/agents/node-token-service.ts` | Materialisation: boot sweep, spawn, delete sweep, collision refusal. |
| `src/core/agents/node-identity-policy.ts` | **What a token buys, per route** — the whole decision table. |
| `src/core/agents/hook-server.ts` | The routes that apply it, and the trust-on-first-proof latch. |
| `src/shared/node-identity.ts` | The cutoff DATE, the one string both the server and Settings read. |

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

## The threat model

### What was actually wrong, measured

On 2026-08-13, on a stock Linux host with no `hidepid`:

- `buildPtyEnv` put `NODETERM_HOOK_TOKEN` and `NODETERM_HOOK_PORT` into the tmux `-e` argv. Those
  ride into a long-lived tmux **client** process whose `/proc/<pid>/cmdline` is **mode 444**. Any
  unprivileged local user — a different uid, no relationship to the victim — could read a live
  app-wide bearer straight out of the process table.
- The bearer is all `/control/*` required. `open-terminal --cmd C` opens a terminal running an
  arbitrary command and is **not** in the confirm-gated `DESTRUCTIVE_VERBS` set (only `write` and
  `close` are, `src/shared/control-verbs.ts`). So this was **arbitrary command execution as the
  victim user**, from any account on the machine, with no prompt. (Note what that set is and is
  not: the dialogs are hand-written per case in `Canvas.tsx`'s dispatch, and `close-worktree
  --mode remove` is confirmed by a human without being in the set. The set is what the two `case`
  blocks read for their `confirmBusy()` refusal, and a drift alarm over that agreement.)
- The same shape existed on SSH hosts: `RemoteHooks.verifyTunnel` passed the bearer as `-H` on a
  curl command line, i.e. argv on the host, readable by every other account there.

`hidepid=2` was applied to the affected host and mitigates it **operationally, on that host only**.
It is not the fix. The fix is that no credential rides argv any more (`buildPtyEnv` carries none;
every remote curl reads its header from stdin via `curl --config -`) and that the routes now ask
*which node* is calling, not merely *whether someone on this machine* is.

### What the design is trying to buy

Turning **"any session on this machine can act as any node, by default"** into **"a session that
wants to act as another node has to do something deliberate about it."** That is a real change in
default posture and a real reduction in blast radius. It is not isolation, and the qualifier is doing
work — *deliberate* means different things per route:

- On the routes that demand `verified` — `/codex-thread/{start,bind}`, and every `/control/*`
  mutation once the cutoff passes — it means **harvesting that node's token file** off the disk.
- On `/hook/*` it means nothing at all: a tokenless POST naming any node is accepted forever, by
  contract (invariant 2).
- On `/control/list` and `/context-link/*` it means **inventing a `kid`**. A made-up kid is a
  *foreign* kid, therefore `legacy`, therefore never caught by the latch (invariant 3) — see the
  latch warning below, which is pinned by a test.

What actually went away is the *accident*: the credential no longer falls out of the process table
into every account on the machine.

## What this does NOT fix

Reproduced deliberately, because a security doc that only lists wins is how the next person
over-trusts it.

- **A same-uid attacker can still read another node's token.** The token file is 0600 in a 0700 dir
  under the user's data dir; any process running as that user can `cat` it. Nothing makes a token
  secret from a determined sibling *within one uid* — that is a property of the uid boundary, not of
  this scheme. What changed is that it now takes a deliberate act (find the dir, read the right
  file) instead of being handed over by the process table.
- **A compromised agent acting as ITSELF is entirely unaffected, by design.** The capability proves
  *which node* is calling. A Claude session that has been talked into doing something destructive
  presents its own perfectly valid token and is `verified`. Identity is not authorization, and it is
  certainly not judgment. `write` and `close` keep their **human confirmation** for exactly this
  reason, whatever the token says.
- **Prompt injection is unchanged.** Nothing here inspects intent, and nothing here makes a hostile
  instruction in a transcript less effective.
- **A stolen token has no expiry.** There is no TTL, no nonce and no replay window: `verifyNodeToken`
  is a pure function of (secret, nodeId). A token copied off the disk stays valid for as long as the
  secret does. There is **no revocation mechanism** — see below for what rotating the secret actually
  costs.
- **The remote token dir is per host account, not per instance.** Two instances driving one
  host+user (two desktops on a shared deploy account) mint with different secrets and overwrite each
  other's files. The loser's sessions then present a foreign `kid`, which reads as `legacy` — never
  as another node, never as `forged`. The cost is a silent drop to the fail-open state, not a
  mis-verification — **but only until the cutoff.** From 2026-10-13 `legacy` is a refusal for every
  `/control/*` mutation, so the loser does not degrade gracefully any more: it loses remote canvas
  control outright, silently, on a date nobody will connect to the symptom.
  `node-tokens/<kid>/<id>` would close it and needs no client change; see the `writeNodeTokens` doc
  comment. It is also the only hardening that would give the trust-on-first-proof latch any teeth —
  see the latch warning below.

### Rotation, honestly

There is no rotate command. Rotation means deleting `node-auth-key.json` / `node-auth-key.bin` from
the data dir and restarting. What that does:

- Every token minted under the old secret carries the old `kid`, so it verifies as **`legacy`** — not
  `forged`. It stops proving anything; it does not become an attack signal.
- The boot sweep re-materialises every node's file under the new secret, so **local live sessions
  recover on their own** (the clients read the file per request; they do not cache). SSH hosts get
  their new files on the next connect and are `legacy` until then.
- It **orphans every codex thread→node record** signed with the old secret (`#167`'s shared-identity
  spine — this is why the sealed path *adopts* a pre-existing `codex-node-auth-key.json` rather than
  minting fresh).

## At rest, per surface

| Surface | Holds | How |
| --- | --- | --- |
| Desktop (Electron) | The **secret** | `node-auth-key.json`, sealed with `safeStorage`, 0600, tmp+rename. |
| Server Edition | The **secret** | `node-auth-key.bin`, **raw 32 bytes**, 0600, tmp+rename. |
| SSH host | Per-node **tokens** only | `$HOME/.nodeterm/node-tokens/<nodeId>`, 0600 under a 0700 dir, written over the ControlMaster with the token on **stdin**. |
| Phone | Nothing | No secret, no token, no change. |

**The desktop's honest caveat.** `safeStorage` is the right call on macOS (Keychain) and Windows
(DPAPI). On Linux it may resolve to the **`basic` backend, which encrypts with a hard-coded key** —
in that configuration the sealing is obfuscation, and the protection that actually holds is the
**0600 file mode**. That is worth knowing before anyone reasons "it's encrypted at rest, therefore…".
Two distinct file names (`.json` vs `.bin`) exist so a data dir moved between shells can never have
one format misread as the other.

**The Server Edition stores it raw, deliberately.** A headless Linux host has no keychain; there is
no `safeStorage` to reach. Inventing a passphrase prompt would make the app un-bootable
unattended, which is the entire point of that edition. The in-repo precedents are the same
decision made before: `src/server/auth.ts` keeps the login hash and live session tokens at 0600, and
`src/server/github-control.ts` keeps a live GitHub PAT at 0600. A secret at 0600 on a host where an
attacker already has your uid is not the weakest link on that host.

**An SSH host holds tokens but never the secret**, and that is a property worth protecting: a host
can present the tokens it was given, but it **cannot mint one for a node it was not given** —
including nodes on other projects, or on other people's canvases. Minting happens only where the
secret is. The case-fold collision refusal is applied on the *minting* side for the same reason: an
APFS host must not be a way around the local guard.

**The phone needs nothing, and holds nothing — but the sessions it spawns are `verified`.** The
phone *device* posts no hook events at all: it drives canvas control over the relay → IPC, not over
`/control/*` at all. The sessions it SPAWNS run **on the host**, source the host's 0600 endpoint
file, and therefore read and present the host's per-node token exactly as a desktop-spawned session
does — a phone-spawned session is `verified`.

The chain is worth stating, because it has been mis-derived twice: the phone injects only
`NODETERM_HOOK_ENDPOINT` and `NODETERM_NODE_ID` (it types `tmux new-session -A` over its own SSH
transport, so no `ptyManager` and no `ensureNodeToken` is involved anywhere); the endpoint file
advertises `NODETERM_NODE_TOKEN_DIR`; the managed script reads `$DIR/$NODETERM_NODE_ID` and sends it
on stdin. The token file is there because `refreshNodeTokens` runs on **every canvas persist**, not
because the spawn path minted it. Narrowing that materialisation to the spawn path would silently
drop every phone-spawned session to `legacy` — `src/core/agents/phone-spawned-identity.test.ts`
exists to make that a red build.

## Per-route policy

The bearer is required everywhere; this table is about the *node* token on top of it.

| Route | Missing / `legacy` token | `forged` | Notes |
| --- | --- | --- | --- |
| `/hook/*` | **Always accepted** — 204, listeners fired, event labelled `verified: false`. | 403 | The label is a label. This route never 403s a missing token. |
| `/verify`, `/hook/verify` | Accepted — no identity of any kind, ever | n/a | The tunnel probe. It proves one thing: the socket reaches this server. |
| `/context-link/*` | Accepted unless the node is latched; a refusal is **prose with a 200** | 403 | Every verb is a read, so the whole route sits in the tolerant bucket. |
| `/control/list` | Accepted unless the node is latched | 403 | Tolerant: leaks canvas shape, changes nothing. |
| `/control/<mutation>` | Warned during the window, refused after the cutoff, refused immediately if latched | 403 | Refusal happens **before** the handler. `write`/`close` still ask the human. |
| `/control/browser` | **Refused** immediately — no window, no cutoff to wait for | 403 | Strict from the day it existed via `STRICT_CONTROL_VERBS`, checked **before** both the `override` escape and the dated window, so `hookIdentityStrict: false` does not soften it. Identity is only the first gate: the per-project switch (off by default) and in-memory ledger ownership still apply after it. |
| `/codex-thread/{start,bind}` | **Refused** (403) | 403 | Strict from the day they existed — no upgrade population to protect. |
| `/codex-thread/fallback` | **Always accepted** | 403 | It reports a DEGRADE and grants nothing; refusing it would silence it in exactly the tokenless case it exists for. |

**Why `/hook/*` never 403s a missing token.** It is the fail-open contract, and it is load-bearing
rather than timid. The legitimate tokenless callers are real and permanent: a **phone-spawned session
whose host had no endpoint file yet** (its `NODETERM_HOOK_ENDPOINT` resolved empty, so there was no
token dir to read — note that a phone-spawned session on a host that *does* have one is `verified`,
see above), the **cross-instance failover** (a second instance's token is
unjudgeable, not hostile), every session that predates the feature, and any future spawner. A 403
there does not degrade a feature — it silently stops an agent's status, context meter and approvals,
and the managed script's `curl -sS` has no `--fail`, so a 403 exits 0 and the node goes dark with no
error anywhere. `forged` is the single exception because nothing legitimate can produce it.

**Why the invented-`kid` escape does not reach `/control/browser`.** The "deliberate means inventing
a `kid`" hole above is real for `/control/list` and every `/context-link/*` verb: a made-up kid is a
*foreign* kid, therefore `legacy`, therefore it walks past the latch and the cutoff into those
tolerant routes. It does **not** walk into `browser`. `browser` is in `STRICT_CONTROL_VERBS`, where
`controlPolicy` demands `verified` and returns `refuse` for anything else — and `legacy` is anything
else. A foreign or invented kid is `legacy`, `legacy` is a refusal on this route, so the escape that
buys `/control/list` buys nothing here. This is the whole reason the strict bucket is checked before
the `override === false` branch: that branch returns `allow-with-warning` for a non-tolerant verb,
which would have handed browser control to any holder of the app-wide bearer forever.

**A pre-upgrade codex session degrades to plain codex until it is relaunched.** Its launcher reads
the per-node capability from an env var this build no longer sets, and the value the previous build
put there is the OLD derivation (`base64url(HMAC(secret, nodeId))`, no dot), which the current
verifier reads as `legacy` — a 403 on `/codex-thread/{start,bind}`. There is no compat path and no
useful one to write: relaunching the node is the fix, and it takes one restart.

**Why `/context-link/*` refuses with prose and a 200.** The shim turns any non-200 into "Could not
read linked context (nodeterm unreachable)". That would be a lie, and it tells the agent nothing it
can act on. A sentence it can read is the better failure.

**Why no gate at all when there is no secret.** An instance that cannot mint can never verify anyone,
so warning or refusing `legacy` there would hit **every** caller on the machine with advice that
cannot work ("restart this node to pick up an identity" — there is none to pick up). That is the
desktop's `safeStorage`-unavailable path and the Server Edition's uncreatable-key-file path; both
keep working exactly as before.

## Migration

### Trust on first proof

`hookServer` remembers, **in memory only**, every node that has presented a valid token for itself
(`provenNodes`). Once a node is in that set, an unverified request naming it is refused: the session
demonstrably *can* authenticate, so one that suddenly cannot is either a different process wearing
its node id or a forgery. The latch costs the legacy population nothing — they never prove anything,
so they never latch.

Three properties keep it from breaking people:

- **A foreign `kid` never proves a node and is never caught by the latch.** Otherwise the first day a
  second instance exists is the day failover stops working.
- **The latch is never written to disk.** A restart re-earns it within one hook event, and a
  persisted latch is a node one filesystem accident could brick forever.
- **Sweeping a node's token also drops it from the latch** (`sweepToken` →
  `hookServer.forgetProvenNode`). A latch outliving the token it was earned with is a permanent 403
  — see the warning below.

### The dated window

Until **2026-10-13** (`NODE_IDENTITY_STRICT_AFTER`, built from `NODE_IDENTITY_STRICT_DATE` in
`@shared/node-identity`), an unverified *mutation* on `/control/*` still **executes**, and the reply
carries a sentence naming the fix and the date. On and after it, the same situation is a refusal and
the handler never runs. The date is the owner's rule — *the second minor release or 60 days after the
shipping release, whichever is later* — resolved to a concrete instant. A tightening with no date is
a tightening that never happens.

**Two sentences, because two populations.** The ordinary unverified node is told to restart to pick
one up (`IDENTITY_RESTART_NOTE`) — that is the common case and the restart works. A node that can
**never** mint (a case-fold collision member, or an id outside `isSafeNodeId` arriving from a shared
`project.json`) is told the cause instead and is never advised to restart, in the window
(`IDENTITY_UNMINTABLE_WARN_NOTE`) as well as after it (`IDENTITY_UNMINTABLE_NOTE`). The window is
where that matters most: it is the *whole period* those nodes still work, so a restart loop there
costs them the only time they had to fix the id.

The cutoff is read through **`isStrictInstant`**, not a bare `>=`. A machine clock more than
`NODE_IDENTITY_CLOCK_HORIZON_MS` (2 years) past the cutoff is not believed and the window stays open:
a VM restored from a snapshot or a board with a bad RTC would otherwise enter strict mode on day one,
with no window at all and a refusal naming a date "already past" — and the symptom reads as "the
token is broken", so nobody looks at the clock. The clamp relaxes only the **date**; the latch and
`forged` are untouched, which is what makes it cheap. (Compare `license.ts`, which anchors expiry to
the largest observed timestamp so a clock rolled *back* cannot revive a token. Same reasoning, other
direction: here the clock direction a user benefits from buys them nothing the escape hatch does not
already grant.)

### ⚠ The latch refuses a PROVEN node immediately, not at the cutoff

**This is the single most misread thing about this feature.** The warning window only ever covered
nodes that have **never** proven themselves. A node proves itself automatically and fast — the
managed hook script presents the header, and the boot sweep materialises a token file for every
persisted node — so a live Claude node is typically latched **within seconds of app start**. From
that moment, a tokenless caller naming it gets a hard 403, today, with no grace and no date.

**What makes a node `verified` is the SCRIPT, not the file.** Measured: a valid token file read by a
managed hook script from a build that predates the header is still `legacy` — the file only counts
once something sends it. Locally that is covered without a restart, because the boot-time hook
install rewrites the script in the same start-up that runs the boot sweep. **An SSH host's script is
rewritten only by `RemoteHooks.setup`, which runs on CONNECT**, so the remote nodes of a project that
is already connected stay `legacy` until that project reconnects — for a long-lived SSH project, that
can be a long time. Before the cutoff it costs them nothing but the note; on 2026-10-13 it becomes a
refusal, so "reconnect the SSH project" is part of this upgrade even though "restart the node" is not.

### ⚠ …and the latch is not a defence against an attacker

**It catches a MISTAKE — a session that silently stopped presenting its token — and nothing else.**
Do not re-derive a stronger claim from the code; this one is measured against the real hook server
and pinned by a named test (`hook-identity-enforcement.test.ts`, *"an invented kid is admitted — the
latch is not an adversary boundary"*).

The probe: send `X-Nodeterm-Node-Token: AAAAAAAA.BBBB…` — eight arbitrary characters, a dot, an
arbitrary tail. Nothing about it is ours, which is exactly the point: the `kid` does not match this
instance's, so `verifyNodeToken` calls it **foreign**, therefore `legacy`, and invariant 3 says a
foreign kid never proves and is never caught by the latch. The latch simply does not apply. That
caller reaches `/control/list` and **every** `/context-link/*` verb as a latched victim node, on both
sides of the cutoff, and is handed the victim's rendered transcript.

**This is unavoidable and it is correct.** Invariant 3 requires a foreign kid to be admitted, or
cross-instance failover dies the day a second instance appears — and the attacker is the one who
chooses the kid, so there is no version of "judge the foreign kid" that an attacker cannot step
around. Anyone who can set the header can present an unjudgeable one, and the app-wide bearer is all
it takes to set the header. So: the latch is a good bug-catcher and worth keeping; it is not a
boundary, and neither is the dated cutoff (the same probe walks past both).

**The one place the probe will stop — once there is anything in it.** A verb in
`STRICT_CONTROL_VERBS` admits `verified` and nothing else, so a foreign kid — `legacy` by invariant
3 — is refused there with a flat sentence and no diagnosis. That will be the only route in this
document where the invented-kid escape does not apply, and it is affordable exactly because the
verbs it is for are new: no legacy population to strand, so nothing has to fail open. **Today the
set names a verb that does not exist yet** (see [The escape hatch](#the-escape-hatch)), so this
changes nothing for any route currently reachable — every claim above still holds in full, and the
probe still reaches `/control/list` and every `/context-link/*` verb.

**The real hardening, if it is ever wanted.** Scope the remote token dir as
`node-tokens/<kid>/<nodeId>` (already sketched in `writeNodeTokens`' own doc comment). The *only*
scenario the foreign-kid escape exists for is two instances sharing one host account overwriting
each other's flat token dir. Remove that overwrite and a foreign kid stops being a legitimate state,
at which point it can be judged and the latch acquires the teeth this section says it does not have.

### Stranding is the cost the latch actually charges

Refusing a proven node the instant it stops presenting a token is intentional, but it is also the one
way this feature can kill a live session outright. These are what pay that down — they are what make
the latch shippable, not the window:

- every token sweep releases the latch (collision refusal, delete/re-create, remote refusal);
- the clock clamp;
- the shared token resolver (below), so a client cannot fail to FIND a token that exists;
- and the escape hatch, which must be reachable **in the UI**, because a stranded user's symptom
  never says "clock" or "collision".

### ⚠ A client that cannot FIND the token is indistinguishable from one that has none — issue #384

The token dir is advertised by ONE thing, the endpoint file, and a session is pinned for life to the
endpoint **path** it was handed at tmux creation (`buildPtyEnv` / `remoteHookEnvArgs`). So a session
whose endpoint file does not carry a `NODETERM_NODE_TOKEN_DIR` line presents nothing, forever, while
its token file sits in the standard place. Three populations, all measured on a real host:

- **A pre-v2 endpoint file that is still LIVE.** SSH hosts used to share one
  `~/.nodeterm/hook-endpoint.env`; the current build writes per-project
  `hook-endpoint-<projectId>.env` and never touches the old path again. The old file names
  `~/.nodeterm/hook-<projectId>.sock` — a path **re-bound on every connect of that project** — so it
  keeps reaching a current server while advertising no dir. Observed: a `VERSION=1` file a month old
  pointing at a socket created minutes earlier.
- **A session whose transport rides the env with no readable endpoint file** — what the phone hands
  a session it spawns.
- **A partial read** of an endpoint file being rewritten under the reader.

What made it a *refusal* rather than an unverified call is that the CLIENTS DISAGREED. The managed
hook script has an endpoint failover: on a failed POST it adopts a live sibling endpoint and re-reads
the token from **that** endpoint's dir — so the node proves itself and latches. The two sh shims had
no failover and no fallback, so every canvas-control and context-link call from that session was
refused with `IDENTITY_REFUSED_NOTE` for the rest of its life. **Proven by one client, refused
through another.**

The fix is one resolver, `nt_read_node_token`, emitted by `core/agents/node-token-sh.ts` and used by
all three clients (the codex launcher is deliberately excluded — it refuses outright on an unreadable
endpoint and reports a named degrade, a different contract). It tries the advertised dir, then
`<dir of the endpoint file>/node-tokens` — the layout **by construction** on all three surfaces — then
the same well-known data dirs the hook script already walks for endpoint files.

It is **monotone**, and that is the whole safety argument: the advertised dir is always first, so
nothing that verifies today changes; the lookup is by node-id FILENAME in every candidate, so a
session can still only present its own token; and a dir belonging to another instance mints under a
different secret, so its token carries a foreign `kid` — `legacy`, bit-for-bit what presenting
nothing already gave, and never `forged`. Each candidate can turn `legacy` into `verified` and
nothing else.

**The advice was wrong too.** Both notes said "Restart this node (right-click it, *Restart agent*)".
That action re-launches the CLI **inside the same pane** and deliberately leaves the pty, the tmux
session and therefore the whole environment untouched (`terminal/agent-restart.ts`) — so it could
never change what a session presents. They now say *close and reopen the node* (a new tmux session is
what picks up the current `-e` env), *reconnect the SSH project* (the only thing that rewrites the
host's endpoint file, shim, hook script and token files), and name the escape hatch.

Known and **not** fixed: two processes on one node id after a re-attach. A shell from an older app
run, whose shim never learned to send the header, posts nothing while the re-attached session proves
the node — and is then refused for as long as it lives. It is genuinely indistinguishable from an
impostor; the only code answer would be giving up the latch. The escape hatch is what that case has.

### ⚠ The same asymmetry one layer down: a stale ENDPOINT — issue #445

#384's shape repeated at the transport level. A session is pinned for life to the endpoint *path*
it was handed, and that path's FILE can advertise a port nothing listens on: the app quit or
crashed and has not rewritten it yet, the hook server's `start()` failed and left a previous run's
file standing, or the path carries a retired project id that is never rewritten again. The managed
hook script survived all of these — its bounded candidate walk (`nt_candidates`/`nt_adopt`) adopts
a live sibling endpoint and re-reads the token from the adopted dir — while the two sh shims posted
once at the dead port and died with "control endpoint unreachable": hook events healed themselves,
canvas control did not, and the field report was a reviewer launch silently dropped from a live
worktree session.

Three fixes, all in the same change:

- **The walk is shared** (`core/agents/hook-endpoint-failover-sh.ts`), the same extraction
  `node-token-sh.ts` performed for the token read: one definition, three clients. Both shims fail
  over on a dead transport only — an HTTP answer of any code is authoritative and is never re-sent
  to another instance — and re-read the token from each adopted endpoint (`nt_read_node_token
  "$candidate"`). The walk is skipped under `CODEX_SANDBOX_NETWORK_DISABLED` (#367: the sandbox
  denies every connect, so each candidate would burn a doomed curl and the sandbox hint is already
  the right diagnosis).
- **Publication reflects listener liveness**: `hookServer.stop()` and a FAILED `start()` now delete
  `hook-endpoint.env` (the desktop calls `stop()` on quit), and a failed `listen()` no longer
  wedges the singleton — it used to leave `this.server` assigned, so every later `start()` was a
  silent no-op at port 0 under a stale advertisement. A crash skips the delete, which is exactly
  what the client walk exists for.
- **The refusals name the state**: "no endpoint anywhere" and "an advertised endpoint that is not
  listening" are different facts with opposite advice, so the shims append `STALE_ENDPOINT_HINT`
  in the second case instead of leaving one generic sentence covering both.

The safety argument is the walk's own: the node id in the body identifies the session, a foreign
instance that does not know it answers with its ordinary refusal, and a foreign token dir yields a
foreign `kid` = `legacy`. Real /bin/sh coverage: `canvas-control-shim.failover.test.ts`,
`context-link-shim.failover.test.ts`, `hook-server.recovery.test.ts`.

### The escape hatch

`settings.hookIdentityStrict` — Settings → Agents → *Require verified node identity for canvas
control*. It is the **only optional key** in `Settings` and deliberately not in `DEFAULT_SETTINGS`,
because it is a tri-state:

| Value | UI | Effect |
| --- | --- | --- |
| absent | Automatic | Follow `NODE_IDENTITY_STRICT_AFTER`. |
| `true` | Always required | Enforce now, before the date. |
| `false` | Not required | Keep the warning window open past the date **and** release the latch. |

`false` is for a user whose upgrade strands a live session: it gets the canvas back without
downgrading the app. Neither value ever admits a `forged` token.

Neither releases a verb in **`STRICT_CONTROL_VERBS`**, and as of S8 that is now a live restriction,
not a pre-positioned one. The set contains one name, `browser`, and `browser` **is a real verb**
(shipped over S8 PRs 7–9): it drives a real logged-in page — navigating, typing, clicking, reading
text and cookies. So the hatch releasing it would mean handing that to any holder of the app-wide
bearer, forever, which is exactly what must never happen. The ORDERING makes it impossible: the
strict bucket is decided one line below the `forged` check, above every branch the hatch or the dated
window can reach, and it admits `verified` only — so `browser` can never arrive through the
`override === false` branch, which returns `allow-with-warning` for every non-tolerant verb. Setting
*Require verified node identity for canvas control* to **Not required** keeps the warning window open
and releases the latch for the ordinary verbs; it does **not** release browser control.

`open-browser` stays out on purpose, and the distinction is worth stating because the sentence above
says "browser": **opening a node is not driving one.** The threat is an agent acting inside a page
the user is logged into (cookies, typing, script); `open-browser` only creates the surface and
navigates it, like `show-web`. It is also a shipped verb with a live legacy population, and a strict
gate would leave a pre-token session — or an SSH host whose project has not reconnected — unable to
open a browser node with no way back, since the hatch by design cannot reach into this bucket. The
residual is named rather than hidden: an unverified caller can open a node onto a logged-in page and
the page's title then shows up in `list`. That is `list`'s tolerance, unchanged by this bucket.

The cost, now that the verb has landed: cross-instance failover cannot drive a browser node, because
another instance's token is a foreign kid and therefore `legacy`, and `legacy` is a refusal on this
route. Both shells wire the override as a **live getter** (`setIdentityStrictOverride`), so a change
takes effect on the next request, not the next launch — a stranded user must not have to restart the
thing that is already broken — but no setting reaches into the strict bucket to release `browser`.

## Ids are path segments

`isSafeNodeId` (node ids) and `isSafeThreadId` (codex thread ids) refuse `.`, `..`, empty and
over-length **on top of** the `[A-Za-z0-9._-]` charset, because both ids are used as path segments —
`<tokenDir>/<nodeId>`, `<codexThreadIdentityRoot>/<threadId>` — and `.` and `..` match that charset.
Both ids are attacker-shaped: they arrive from `project.json`, which travels in cloned and shared
repos. One predicate each, applied before the id reaches a path join **or a hash**. Do not add a
second copy of either rule; a rule with two copies is a rule where one copy is wrong.

The same file provenance is why **case-folding collisions** are refused. On APFS (the primary desktop
target) `<tokenDir>/Term-1` and `<tokenDir>/term-1` are one inode while `isSafeNodeId` calls them two
nodes, so a `project.json` carrying both picks by array order whose token lands in the shared file —
and the other node reads it. The materialiser refuses tokens for the **whole colliding set** and
sweeps anything an earlier pass wrote for them; those nodes fall back to `legacy`, the designed
fail-open state.

## Account scoping (S6): the same secret signs Codex account-scoped records

The restart-stable node-auth secret above does a second job: it signs the Codex thread→node→**account**
ownership records (`src/core/codex-identity-proxy.ts`). S6 gives a machine the system Codex login
(`~/.codex`) alongside managed logins, and a record now binds the full 4-tuple
`(threadId, accountScope, nodeId, hookEndpoint)` so one account can never be made to speak for
another's threads. The full model is [Shared Codex node identity](shared-codex-node-identity.md); the
parts that touch this secret and the invariants here:

- **The codex identity secret is armed on both shells.** Desktop and Server Edition both call
  `setCodexThreadIdentityAuthSecret(loadOrCreateNodeAuthSecret())` at boot — the desktop in
  `src/main/index.ts`, the Server Edition in `src/server/node-identity-arm.ts` — so **managed records
  sign on a headless host too** (raw `0600` `node-auth-key.bin`, no keychain). This is the both-shells
  half of Decision 1; a keychain-only secret would regress Server Edition. With **no** secret armed, a
  record write **throws** rather than writing an unsigned record (fail-closed) — nothing is minted.
- **The switch is owner-authorized, main-side.** Moving a running node's conversation to another
  account is a three-phase, TTL-bounded protocol keyed off `event.sender.id` — only the WebContents
  that reserved the switch may commit or finish it. It resumes the **same conversation id** (an atomic
  hardlink of the rollout inode), never a fork. The phone **never originates** an add/switch/copy.
- **Ambiguity fails closed, like the latch.** The same thread id owned by two account scopes resolves
  to **no owner** unless `owners.size === 1` — the same house rule as the pane-ownership and
  invented-`kid` refusals: an owner that cannot be *proven* is denied, never picked by order.
- **Ids are path segments, still.** A managed account id is a directory scope
  (`<codexThreadIdentityRoot>/<accountId>/<threadId>`), so it passes `isSafeAccountId` (must start
  alphanumeric — blocks `.`/`..`/leading-separator) before it becomes a path, exactly as `isSafeNodeId`
  / `isSafeThreadId` do. The account id travels in the launcher's POST **body**, never on an argv
  (invariant 1 — no credential *or* scope-shaping input on a command line).

Two S6 surfaces remain **owed device verifications** rather than shipped-and-verified: the imperative
pane-recycle glue behind a live switch, and the remote-host account **lifecycle** (add/login/remove
*on* an SSH host — wired 2026-09 from the machine panels in Settings → Accounts, unit-tested only). Both, plus the live-daemon and real-WAN legs, are in
[the acceptance gate](codex-accounts-acceptance.md).

## Invariants a future change must not break

1. **No credential on any argv or command line — local or SSH.** Not tmux `-e`, not `curl -H`, not a
   remote `ssh` command string. `/proc/<pid>/cmdline` is mode 444 on a stock Linux (measured), and a
   remote command line is argv on both ends. Credentials travel by 0600 file or by **stdin**
   (`curl --config -`). Guarded by `hook-server.env.test.ts` and the remote suites; if you need a
   header on a remote curl, copy the `--config -` pattern, never add an argv fallback.
2. **`/hook/*` never 403s for a missing token.** The phone, the cross-instance failover and every
   pre-token session legitimately have none, and a 403 there is a silently dark node, not an error.
   Only `forged` is refused.
3. **A foreign `kid` is `legacy`, never `forged`, and never proves or latches a node.** It is the
   documented cross-instance failover. Getting this wrong breaks failover on the day a second
   instance appears.
4. **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
   Any new field on the hook event (the `verified` flag was one) must reach both, or the Server
   Edition silently loses the feature. Pinned by a source-level parity assertion in
   `hook-verified-parity.test.ts`; this repo has shipped a one-shell hook-server change three times.
5. **Node ids and thread ids are validated before any path join or hash.** `isSafeNodeId` /
   `isSafeThreadId`, once each, at the boundary.
6. **`write` and `close` keep the human confirmation, token or no token.** Identity may refuse
   *before* the handler; it may never stand in for the dialog. Tolerance is the one way this feature
   could weaken it, so neither verb is ever in `TOLERANT_CONTROL_VERBS`.
7. **A sweep releases the latch.** Any new code path that removes a token file must also call
   `hookServer.forgetProvenNode`, or it strands the node it was protecting.
8. **Fail-open directions, per failure mode.** Every one of these is a deliberate choice, not an
   oversight:

   | Failure | Direction |
   | --- | --- |
   | No secret (no keychain, unwritable key file) | No gate at all — every route behaves pre-feature |
   | Token file unwritable / unreadable | `legacy` — never a blocked terminal, never a throw into a pty spawn |
   | Remote write fails for one node | That node is `legacy`; the others keep their tokens |
   | Case-folding collision | The whole set is `legacy`, and their files are swept |
   | Unsafe node id | No token, no file, no hash — and no path join |
   | Clock implausibly far ahead | Window stays open (`isStrictInstant`) |
   | Hook handler throws | Still 204 |
   | `forged` | **The one fail-closed case.** 403, every route, no prose |

   **Every row that lands on `legacy` is only fail-OPEN until 2026-10-13.** On and after the cutoff
   `legacy` is a refusal for every `/control/*` mutation, so a degradation nobody notices today
   becomes a node that cannot drive the canvas at all — e.g. two instances sharing one remote host
   account overwrite each other's token dir (§What this does NOT fix) and the loser loses remote
   canvas control outright, on a date nobody will connect to the symptom. Each `legacy` row is a
   thing to fix *before* the date, not a permanently safe landing.
