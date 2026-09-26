---
paths:
  - "src/core/agents/**"
  - "src/core/agent-status-mirror.ts"
  - "src/core/codex-identity-proxy.ts"
  - "src/core/context-tail.ts"
  - "src/core/subagent-tail.ts"
  - "src/main/index.ts"
  - "src/main/remote-ssh/remote-hooks.ts"
  - "src/main/remote-ssh/tunnel-repair.ts"
  - "src/main/remote-ssh/remote-shim-neutrality.guard.test.ts"
  - "src/main/codex-identity-record-wiring.test.ts"
  - "src/server/agent-status.ts"
  - "src/server/codex-shared-identity.ts"
  - "docs/node-identity.md"
  - "docs/shared-codex-node-identity.md"
---

## Agent hooks, installers and node identity

- **Hook server (loopback HTTP)** — `src/core/agents/hook-server.ts` is a main-process
  loopback HTTP server (per-session bearer token, fail-open) that the installed hook scripts
  POST to; it replaced the old `fs.watch` signal-log mechanism. `buildPtyEnv` injects the
  node id + endpoint/token into each spawned session's env; because tmux sessions **outlive
  the app**, the server also writes `<userData>/hook-endpoint.env` so a relaunched main
  process re-advertises the same endpoint (restart handoff). A `setRawListener` channel feeds
  the per-node context-window meter (`context-tail.ts` — **one tail per agent**, each with its own
  `parse` dep: claude's usage records, `codexContextParse`, `geminiContextParse`) and the subagent
  live-transcript (`subagent-tail.ts` — claude via meta-dir `track`, codex via `trackFile` with the
  stateful `codex-subagent-format.ts` formatter). The same events feed the **agent-status mirror**
  (`core/agent-status-mirror.ts`) the mobile companion reads; the mirror carries an optional
  `settings` block (`claudePermissionMode`/`autoSupported`/`claudeAccounts`) so the phone can
  launch agents with the desktop's permission mode + managed accounts, and SSH slices get their
  **per-host** settings (remote CLI caps + host-matched accounts) injected via
  `remote-status-push`'s `settingsFor` dep.
- **Hook installers** — `src/core/agents/hooks/` holds per-agent hook services + an installer
  registry `MANAGED_HOOK_INSTALLERS`. `managed-script.ts` builds the POSIX hook script that
  POSTs to the server (env-gated: a no-op in the user's normal terminals, active only in
  sessions nodeterm spawns; the `claude-signals` string is kept as the idempotency marker that
  migrates users off the old hook). claude → `~/.claude/settings.json` and gemini →
  `~/.gemini/settings.json` (shared `install-helper.ts`, merged/idempotent, preserving other
  tools' hooks); codex → `~/.codex/hooks.json` + `~/.codex/config.toml` trust entries
  (`codex-trust.ts` — the hash gates whether codex runs the hook); **grok → our OWN file
  `$GROK_HOME/hooks/nodeterm-status.json`** (its hook config is a directory whose files are all
  merged, so there is nothing of the user's inside ours — which is also why a malformed copy is
  *healed*, not preserved, on both the local and the SSH path). The per-event **`matcher`** the grok
  installer needs is why events are typed `ManagedHookEvent` (`string | {event, matcher}`): grok's
  tool matcher is a REGEX and must be `.*` — a bare `*` is invalid and silently stops tool events
  firing. Plain-string events keep their byte-identical output for every other agent.
  **Codex is the one agent whose hook command is NOT a POSIX one-liner on Windows** (issue #567):
  it builds the command as `cmd.exe /C <string>` (`codex-rs/hooks/src/engine/command_runner.rs`,
  rust-v0.151.0) unless the session has a shell configured, which a default Windows install has
  not — so `if [ -x '…' ]; then …; fi` answered `-x was unexpected at this time.` and **exit 1 on
  every event**, for the life of the node. Claude is fine there only because Claude Code runs its
  hooks through Git Bash. The fix is a batch entry point (`codex-hook.cmd`,
  `codex-windows-wrapper.ts`) written beside `codex.sh` and named by `buildManagedCommand`'s win32
  branch; it **locates a POSIX shell and runs the same script** — deliberately not a second
  implementation of the hook protocol, which would be two copies of the POST/failover/token/
  permission-poll to drift. Three rules it must keep: pass stdin through, DRAIN stdin on every bail
  (codex writes the payload there; #186/#187), and exit 0 when there is no shell or no script.
  Two traps around it: `buildManagedCommand`'s `platform` is the platform of the machine that will
  RUN codex, so `RemoteHooks.installCodexRemote` passes POSIX explicitly (a Windows desktop must not
  put a `.cmd` command on a Linux host); and `isManagedCommand` matches **both** leaves
  (`codex.sh` AND `codex-hook.cmd`) on every platform — matching only the local one would leave a
  pre-fix entry unrecognized, so the fresh one is appended beside it, which is #558 on a second
  file. Matching both is what REPAIRS an existing Windows install at the next launch. **Both
  sides of the managed-entry match go through `normalizeHookCommand`** — the marker used to be
  folded to `/` while the stored command was compared raw, so on Windows nodeterm never recognized
  its OWN entry and appended a fresh set every launch (#558: nine copies of nine events, nine
  `claude.sh` processes per Stop, nine 45 s `PermissionRequest` waits racing one prompt). Because
  `mergeManagedHook` drops every managed entry before pushing one fresh, the corrected match IS the
  repair for a file already ruined — it runs at boot via `installManagedAgentHooks` and, being the
  ONE shared merge, heals claude/gemini/grok, every managed Claude account dir and all three SSH
  remote installers at once; a second repair mechanism would be exactly the duplicated rule this
  file warns about. It strips only OUR handler out of a definition, so a hook a user hand-merged
  beside ours survives.
- **A reused ControlMaster is not evidence of a live hook tunnel** (issue #735 — remote sessions
  stuck on **Unknown**, no completion notifications, no unread dots). `connect()`'s reuse branch
  returned the cached `hookEndpointPath` whenever `ssh -O check` answered, on the written-down
  assumption that *"a master that answered `-O check` never lost its tunnel"*. That is false, and
  the mechanism is **our own self-heal**: `childArgs` uses `ControlMaster=auto` + `ControlPersist`
  precisely so a dead master is rebuilt by the next child command (a status poll, a mirror push, a
  remote git call) on the same ControlPath. The rebuilt master answers `-O check` — and carries no
  `-R`, because `RemoteHooks.setup()` is the only caller of `hookForwardArgs` and it runs only on
  the branch where a master has just come up. The 45 s watchdog then parks on the reuse branch
  forever. Nothing reports it: the project says `connected`, terminals work, the mirror pushes, and
  only the hook POSTs die — into a socket file that still EXISTS with nobody listening.
  **MEASURED on the host that prompted the fix**: 10 per-project hook sockets on disk, exactly ONE
  with a listener (`ss -lxp`); the dead project's socket answered `curl` exit 7 while that same
  project's status mirror was being written the same second; **107 of 128** live `nodeterm-rmt`
  tmux sessions were pinned to that dead endpoint. Sessions are pinned for life
  (`new-session -A -e …` — tmux ignores `-e` on an existing session), so every one of them stayed
  dark until the app restarted. The reuse branch now probes the tunnel (`RemoteHooks.tunnelAlive`,
  one `curl` over the already-multiplexed master) and re-runs the idempotent `setup()` when it does
  not answer, firing `onTunnelVerified` so the working agents resync. **The retry is backed off**
  (`tunnel-repair.ts`, pure + tested): the FIRST failure repairs immediately — that is the common
  case — while a host that can never forward (`AllowStreamLocalForwarding no`, no `curl`, a `$HOME`
  the validator refuses) settles at one attempt per 15 minutes instead of rewriting every agent's
  hook config every 45 s. A missing spec answers "not alive" rather than "unknown": nothing of ours
  is bound, which is a tunnel that cannot deliver.
- **The per-agent hook installs run CONCURRENTLY, and the order that still matters is the one above
  them.** `RemoteHooks.setup()` is the chain `connectOnce` awaits before a project reports
  `connected`, so every terminal of a switched-to project waits through it. Its shape was: resolve
  `$HOME`, open + VERIFY the reverse tunnel, write the endpoint file — and then install five agents'
  hooks strictly one after another, ~16 more remote round trips in a row. MEASURED against a real
  sshd through a 25 ms one-way delay proxy (50 ms RTT), 5 runs each: **3281 ms serial → 1471 ms
  concurrent** over the same 22–24 ssh children. The installers are independent by construction —
  each writes its own script under `<remoteDir>/agent-hooks/` and merges its own agent's config; no
  two touch the same remote path, and the only shared statement is an idempotent `mkdir -p` — and
  the `SshChildGate` (cap 6 per ControlMaster) is what makes the fan-out safe against a stock host's
  `MaxSessions`, which is the whole reason it exists.
  - **The tunnel and the endpoint file stay strictly BEFORE the fan-out**: that file is what every
    hook this installs POSTs through, and it is written only once the tunnel has verified end to
    end. `remote-hooks.test.ts` pins that ordering AND the overlap (a gated fake runner, so
    concurrency is observed rather than inferred from wall-clock; the overlap test fails on the
    serial version, checked by mutation).
  - **`allSettled`, not `all`.** By the fan-out the tunnel is verified and the endpoint written, so
    one installer failing must cost that agent its hooks and nothing else — not discard a working
    setup for every other agent, which is what a rejection propagating to `setup`'s outer catch
    would do (`return null` ⇒ no hooks at all, and post-#735 a repair retried on backoff forever).
    Every installer catches its own errors today; this is the guard for the next one that forgets.
  - The claude/gemini loop body became `installJsonAgentRemote`, with the same fail-open try/catch
    its three siblings already had. Its three steps stay strictly ordered inside: the merge reads
    the file the write then replaces.

**Command-bearing terminal opens (issue #653):** the shared hook-server route requires verified
node identity whenever `open-terminal` carries `cmd`, including an empty value or a dry run.
The strict-policy override and foreign-instance fallback cannot release this gate. Desktop plain
terminal opens keep their existing identity policy; Server Edition still requires verification
for every control verb. Legacy mobile/SSH callers must present this instance’s node token for
command-bearing opens; this does not add a human-confirm dialog or change mobile transport APIs.

- **Per-node hook identity** (`src/core/agents/node-auth-*.ts`, `node-token-*.ts`,
  `node-identity-policy.ts` — full write-up in **`docs/node-identity.md`**) — the shared bearer proves
  "a session on this machine", never *which* session, so every node also gets a capability derived
  from one restart-stable secret (`kid.mac`, domain-separated HMAC over the node id), handed to the
  client as a 0600 file and verified three ways: `verified` / `legacy` / `forged`. `legacy` is "we
  cannot judge this", not a failure. Two invariants come out of this series and both cost real
  incidents to learn:
  - **A credential never rides argv — local or SSH.** Measured 2026-08-13: `buildPtyEnv` put the hook
    bearer in the tmux `-e` argv, which lands in a long-lived tmux client's `/proc/<pid>/cmdline`
    at **mode 444** on a stock Linux with no `hidepid`; combined with `open-terminal --cmd` not being
    in the confirm-gated `DESTRUCTIVE` set, that was arbitrary command execution as the victim from
    any account on the box. A remote command line is argv on **both** ends, so the same rule binds
    every `ssh`/`curl` we generate. Credentials travel by 0600 file or by **stdin**
    (`curl --config -`, already house style in `usage/remote-claude-usage.ts` and
    `codex-identity-proxy.ts`). Never add an argv fallback "for old curl" — that undoes the fix.
  - **Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`.
    A new field on the hook event (the `verified` flag was one) that reaches only the desktop leaves
    the Server Edition silently without the feature; the boundary tests cannot tell you a field is
    *missing*. `hook-verified-parity.test.ts` asserts it at source level because this repo has
    shipped a one-shell hook-server change three times.
  - **Every generated sh client reads the token through ONE resolver** (`nt_read_node_token`,
    `core/agents/node-token-sh.ts`) — the managed hook script, `nodeterm.sh` and `context.sh`. The
    token dir is advertised only by the endpoint FILE, and a session is pinned for life to the
    endpoint PATH it got at tmux creation, so a client that reads only what that file advertises
    presents nothing forever when the file is pre-v2 (SSH hosts' shared `~/.nodeterm/hook-
    endpoint.env`, whose per-project socket path is re-bound on every connect, so it stays LIVE) or
    unreadable (a phone-spawned session). Issue #384: the hook script FAILS OVER and re-reads the
    token from the endpoint it adopts, the two shims did neither — so the same node proved itself
    through one client and was refused through the other by the trust-on-first-proof latch, for the
    life of the session. The resolver falls back to `<dir of the endpoint file>/node-tokens` (the
    layout by construction on all three surfaces) and then the well-known data dirs; it is monotone
    — advertised dir first, keyed by node-id filename in every candidate, and a foreign instance's
    dir yields a foreign `kid` = `legacy` = exactly what presenting nothing already gave.
  - **Every LOCAL generated sh client recovers shared-Codex identity before its env gate.** A tool
    shell forked by the account-scoped app-server carries `CODEX_THREAD_ID`, not the pane's
    `NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` therefore prepend
    `codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before testing
    `NODETERM_NODE_ID`/`NODETERM_CANVAS_CONTROL`. Before this was shared, status hooks recovered the
    node while both user-facing shims declared that same first-class Codex session outside
    nodeterm. The SSH constants remain machine-neutral: the local record root is not valid on a
    remote host and must never be baked into its copy — enforced by
    `main/remote-ssh/remote-shim-neutrality.guard.test.ts`, two legs (the exported neutral bodies
    carry no record root or prelude, and `remote-hooks.ts` cannot even NAME a parameterised
    builder), because the failure is silent and one-sided: a remote shim carrying the prelude keeps
    working, and the only symptom is this machine's userData layout sitting in a file on someone
    else's server. **The prelude is shared; the RECORD it reads is desktop-only.** Those writers are
    the two hook-server handlers `src/main/index.ts` registers — and, since the daemon-reset work,
    the ones `wireServerCodexSharedIdentity` (`src/server/codex-shared-identity.ts`) registers at
    Server Edition boot as well. That shell used to answer a flat `shared: false`
    (`UNKNOWN_CODEX_IDENTITY_CAPS`) as a DELIBERATE degrade: its Codex nodes ran their own
    app-server, so no tool shell needed recovering. It no longer does. The Server Edition has the
    same local app-server, the same signed node tokens and the same persistent canvas store, so it
    wires the shared-thread spine **after** those secrets exist and its panes get the same
    supervisor. The registration is deliberately late for that reason, and `registerCodexIdentityIpc()`
    now answers from the live resolver instead of a constant — an early browser caller waits for the
    refresh rather than being pinned to a false "plain Codex" answer for the whole app run. What
    remains desktop-only is the record's REMOTE leg (SSH shims carry no record root or prelude, the
    paragraph above).
  - **That prelude EXPORTS WHAT THE RECORD SAYS — it never decides.** `NODETERM_AGENT_ID` and
    `NODETERM_CANVAS_CONTROL` were once constants there (`codex`, granted); both are
    `buildPtyEnv`'s answers about the PANE, which labels a node with its OWN agent id
    (`custom:<uuid>` for a custom agent whose `baseAgent` is codex, not `codex`) and gates the grant
    on `canControlCanvas`. The constants therefore mislabelled every custom codex-based node and
    asserted a grant that agrees with the pane only because
    `SHARED_IDENTITY_CAPABLE ⊆ CANVAS_CONTROL_CAPABLE` — a coincidence that list's own comment
    invites the next shared-identity agent to break, and breaking it hands a tool shell a capability
    its pane was denied. So the record carries `agentId` + `canvasControl` INSIDE the 6-tuple HMAC,
    and the prelude reads them; the grant is exported only when the record grants it and is left
    UNSET otherwise (absent, never `0` — the shape both shims' `[ -z … ]` gates expect). The **pane
    echoes its own label** on `/codex-thread/{start,bind}` (a tmux session outlives the app, so
    after a restart nothing server-side still knows what agent a node runs), but the **grant is
    never echoed**: the route derives it with `canControlCanvas`, so there is ONE decider and a
    forged id cannot manufacture a grant the table refuses. The three preimage generations are
    **selected by the record's shape, never tried in turn** — a record naming an agent must not
    verify under a preimage that ignores one — and a pre-agent record's implied `codex` + grant is
    keyed on the LINE being absent, never on the value being empty, so nothing that names an agent
    falls back to the guess. The env vars were never a security boundary in any case (anyone who can
    run the shim can `export` them by hand); the per-node token is, and
    `docs/shared-codex-node-identity.md` states that argument in full.
  - **A shell that forwards this identity cannot be type-checked into correctness.** A handler that
    destructures the request without `agent`, and a record write that omits its optional trailing
    argument, are BOTH well-typed — so the whole dimension can be plumbed through core, the route,
    the launcher and the prelude, pass `npm run typecheck` and every unit test, and ship INERT.
    `main/codex-identity-record-wiring.test.ts` pins it at source level, the same remedy
    `hook-verified-parity.test.ts` uses for the same class of hole.
  - **Every generated sh client walks the SAME endpoint failover** (`nt_candidates`/`nt_adopt`,
    `core/agents/hook-endpoint-failover-sh.ts`) — issue #445, the endpoint-level twin of #384: a
    session is pinned for life to the endpoint PATH it got at tmux creation, so an app
    quit/restart (or a retired project id) leaves it POSTing at a dead port while a live endpoint
    file sits right next to it. The managed hook script had the bounded candidate walk (locals
    before tunnels, `nt_fallback_max` 3, token re-read from the ADOPTED endpoint's dir); the two
    shims did not, so hook events healed themselves while every canvas-control verb died with
    "control endpoint unreachable" — in the field, a reviewer launch silently dropped. Now shared,
    one definition. Two server-side halves in `hook-server.ts`: a FAILED `listen()` un-wedges the
    singleton (it used to leave `this.server` set, making every retry a silent no-op at port 0)
    and `stop()` deletes only the endpoint contents this run published — a failed start cannot
    erase another owner's advertisement. A crash skips cleanup, which is why clients still walk
    the candidates.
    HTTP 421 means the bearer belongs to a different endpoint and is rejected BEFORE dispatch;
    it joins dead transport (curl 000/'') in the bounded discovery walk. A node-identity 403/400
    remains final and is never re-sent to another instance. The walk is skipped under
    `CODEX_SANDBOX_NETWORK_DISABLED` for transport failures (#367); an explicit 421 proves
    transport worked and still permits discovery. The final error distinguishes "no endpoint
    anywhere" from "an
    advertised endpoint that is not listening" (`STALE_ENDPOINT_HINT`). Desktop quit calls
    `hookServer.stop()` on the second before-quit pass, after the flush window.

  - **Hook endpoint ownership (#826):** startup first probes every transport in an existing
    endpoint advertisement and preserves a live or uncertain owner. The local Unix listener probes its socket before
    cleanup. Only `ECONNREFUSED` plus the same device/inode permits removal; a live listener,
    non-socket, symlink or uncertain probe disables hooks without replacing its endpoint.
    Both shells use `startForApp`: Desktop creates its window and then shows an actionable warning;
    Server Edition logs the same warning and continues boot. An authenticated owner must answer
    `/verify` with 204 for the advertised bearer AND reject a random bearer (403/421); unrelated
    HTTP responses are uncertain listeners, not authenticated nodeterm. Probes have a hard deadline.
    Endpoint writes are atomic and stop removes only the run's own advertised contents. SSH setup
    never removes a socket before binding: every forward gets a fresh random path, while discovery
    is stable per project + installation identity hash. Only a verified replacement is advertised;
    then this run cancels its previous forward. A legacy project endpoint is migrated only when its
    bearer matches the current run, the previous installation-qualified advertisement, or a stale
    conventional local advertisement retained at boot. Publication rechecks the snapshot digest,
    refuses symlinks, uses a migration lock and a private temp, and never places credentials in argv.
    Without ownership proof (including a first upgrade after the old local advertisement was deleted),
    it preserves the file and logs instructions to restart affected agent sessions; discovery still
    works but may incur the old dead-tunnel delay until then. No real-host upgrade is claimed by unit tests. A reused tunnel that loses bearer verification
    emits hook-only health updates: the desktop shows a warning and clears it after repair, without
    reconnecting terminals. These changes share the core listener in Desktop and Server Edition;
    the mobile wire protocol and node-identity rules are unchanged.

  Enforcement is dated (`NODE_IDENTITY_STRICT_AFTER`, 2026-10-13, read through `isStrictInstant` so a
  clock years ahead cannot enter strict mode early) with a `settings.hookIdentityStrict` escape hatch
  in Settings → Agents. **Trust on first proof latches a node the moment it authenticates, so it
  refuses TODAY, not on the cutoff** — which is why every token sweep must also call
  `hookServer.forgetProvenNode`. `/hook/*` never 403s a missing token: the phone, the cross-instance
  failover and every pre-token session legitimately have none.
- **Shared Claude/Gemini settings are user data (issue #851).** The local hook install/remove
  and Claude fullscreen writers share `core/agents/hooks/settings-file.ts`; SSH system/account
  hook installs and fullscreen writes share `remote-settings-file.ts`. Only ENOENT / the remote
  explicit missing-file status or a successfully read empty/whitespace file starts from `{}`.
  Malformed/non-object/read-error settings are preserved. Each transaction stages the complete output, takes a `.nodeterm-lock` directory,
  compares its original bytes before rename, and preserves the file mode. Remote snapshots and
  replacements travel on stdin, with a byte-count check against truncated transport; the shell
  needs no Python/Node/jq. Local profiles resolve symlinks and lock/update the shared target,
  rechecking resolution before publication. SSH does the same with plain readlink + cd -P
  (macOS-compatible, no GNU -f), bounding cycles and refusing dangling links/newline paths.
  Grok's owned file heals malformed JSON and hook shapes by rebuilding its managed config.
  A held or crash-left lock skips the update with a diagnostic naming the lock and instructing
  the user to stop writers before inspecting/removing a stale lock; it never gets stolen. External editors need not honor our lock: the final comparison detects edits
  during merge/staging, but cannot eliminate an external write between comparison and rename.
  No claim that the reporter's historical wipe was proven to take this path: the catch-to-empty
  writer and its data loss were reproduced in fixture homes.
- **Fullscreen TUI (Claude)** — through the SAME `settings.json` seam the hook installer uses,
  nodeterm ensures Claude's `"tui": "fullscreen"` so a session takes the alternate screen + mouse
  and behaves natively in tmux (else a drag falls into copy-mode). Two guardrails: **write-if-absent**
  (any existing `tui` value — e.g. a user's `/tui default` — is never touched;
  `core/agents/hooks/claude-tui.ts` `ensureFullscreenTui`) and **version-gated** to CLI ≥ 2.1.89
  (`supportsFullscreenTui` / `claudeCliCaps().fullscreenTui`; unknown ⇒ don't write). Runs
  everywhere the hook seam does: local `~/.claude` + managed account dirs at launch/add-account
  (`ensureClaudeFullscreenTui{,Into}`), and the remote host + account dirs on SSH connect
  (`RemoteHooks.ensureFullscreenTui{,InAccountDir}`, gated on the connection's cached remote probe).
  **Grok has no analogue** — it runs full-screen by default, so there is nothing to write.

## Held attention and child hooks

An unanswered Claude `AskUserQuestion` is correlated by session and tool-use ID in the core
mirror, independently of its short-lived display stash. Ordinary hooks, subagent activity and
unrelated transcript results must not clear attention or archive its inbox card. Both shells
use `recordQuestionResult` for transcript rescue (including Escape/decline), and broadcast the
mirror's effective event. Keep result IDs through local and SSH tails; a boolean “some tool
finished” is insufficient. Explicit new user turns, interrupts and session boundaries reset it.

Claude child `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hooks must not drive parent state.
Child `PermissionRequest` and attention `Notification` hooks still reach needs-you and phone
approvals, including the raw approval summary and deterministic reply ticket. Keep raw summary
recording before the child transcript-association guard in both shells.

A held parent question can overlap child permissions: retain its question card and waiting
state while publishing each approval ticket separately. Approval replies resolve only their
own ticket; the picker stays pending until its correlated answer or explicit reset.
When the parent answers first, retain concurrent approval tickets and blocked attention until
their own replies; ordinary tool activity cannot settle them. Explicit turn/session resets
still cancel both kinds of pending attention.

Held approval attention must not replace subagent, recurring or background-task events, or refresh
state evidence from those lifecycle hooks. A parent may ask several questions while a child ticket
is outstanding: track each new picker and preserve child approval cards independently, including
when their display titles match. Answering either resolves only that question or ticket.
