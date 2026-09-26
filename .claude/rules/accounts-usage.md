---
paths:
  - "src/core/claude-accounts*.ts"
  - "src/core/claude-config-dir.ts"
  - "src/core/claude-session-copy.ts"
  - "src/core/claude-skill-share*.ts"
  - "src/core/remote-account-env.ts"
  - "src/core/remote-claude-session-copy.ts"
  - "src/core/usage/**"
  - "src/core/pty-manager.ts"
  - "src/main/claude-accounts.ts"
  - "src/main/claude-usage.ts"
  - "src/main/codex-accounts.ts"
  - "src/main/remote-ssh/ssh-project.ts"
  - "src/shared/agents/account-*.ts"
  - "src/shared/agents/model-gateway.ts"
  - "src/renderer/components/AccountChip.tsx"
  - "src/renderer/components/UsageIndicator.tsx"
  - "src/renderer/components/CanvasPills.tsx"
  - "src/renderer/components/settings/**"
  - "src/renderer/lib/accountChip.ts"
  - "src/renderer/lib/skillSharing.ts"
  - "src/renderer/lib/usageScope.ts"
  - "src/renderer/terminal/agent-restart.ts"
  - "docs/codex-ssh-metrics.md"
---

## Managed accounts and usage

- **Managed Claude accounts** (Claude-only) — run several logged-in Claude identities side by
  side by giving each its own config dir. `settings.claudeAccounts` is a list of `ClaudeAccount
  {id, label, email?, host?, pending?, createdAt}` (in `settings.json`; the account **list** is
  config, not credentials). Isolation is **config-dir**, not token storage: a local account's dir
  is `{userData}/claude-accounts/<id>` (`claudeConfigDirFor` / pure `accountConfigDir`),
  a **remote** account's is `~/.nodeterm/claude-accounts/<id>` on its `host` (keyed by
  `sshHostKey` = `user@host`; `remoteAccountConfigDir` is `~`-relative for ssh expansion,
  `remoteAccountConfigDirAbs` resolves it against the connection's `remoteHome`). The **claude
  CLI owns login, credential storage, and token refresh** inside that dir — the app NEVER writes
  credentials. On macOS this works because Claude Code **≥ 2.1** scopes its Keychain service per
  config dir (`Claude Code-credentials-<sha256(configDir)[:8]>`, `claudeKeychainService`); on
  < 2.1 one unscoped service is shared → accounts collide, so add-account **warns** (`claude
  --version`, `isSupportedClaudeVersion`).
  - **`data.accountId` (terminal nodes)** — resolved **once at node creation**
    (`resolveNewNodeAccount`: explicit submenu pick → `project.defaultAccountId` → system default
    `~/.claude`), then **persisted** (serializers) and changed ONLY by an explicit **account switch**
    (below). `undefined` = system default
    = **bit-for-bit legacy behavior** (no env touched). Inherited by **Branch** (the
    terminal→chat fork it also fed is gone — the SDK chat node was removed 2026-07). Two #419
    rules inside the resolver: the submenu's **System row passes `null`** (an EXPLICIT system
    pick that skips the project default — before that, the row wearing the system email launched
    the project-default account), and validation runs against `accountsForProject`, not the raw
    list, so a **pending** account or one **pinned to another machine's host** is never stamped
    onto a node it cannot run on (both used to reach the missing-dir fallback at spawn).
  - **Switch Claude account (running node)** — node right-click → *Switch Claude
    account ▸* moves the conversation onto another account **already logged in** on this machine,
    with no `/login` in the pane. It works because a transcript carries **no account identity**
    (measured on 2.1.280: under a config dir lacking the file `--resume` says "No conversation found";
    with the file copied into `<configDir>/projects/<encoded cwd>/<id>.jsonl` only the login is
    missing). Choreography = "Restart agent and shell" with a `beforeRecycle` step
    (`agent-restart.ts`): exit the CLI (refused while working/blocked) → core
    `claudeAccounts.copySession` (`core/claude-session-copy.ts`) → rebind `accountId` → recycle, whose
    respawn gets the new `CLAUDE_CONFIG_DIR` and whose cold restore resumes the same id. Two rules:
    the copy runs **after** the exit, so the source is final and a target that is a byte-**prefix**
    of it is just an older copy (A→B→A) and may be replaced, while a **diverged** target is never
    overwritten; and the rebind is **returned** by `beforeRecycle` and merged into the closure's own
    `updateNodeData`, never set by a separate Canvas `setNodes` in the same tick (React Flow's update
    queue rebuilds the node from the store's copy and can drop it). Builtin `claude` only (the
    `boundAccountId` rule below). **SSH nodes** switch between the accounts pinned to THEIR host (and
    the host's own `~/.claude`): the copy runs ON the host as one generated `sh` script over the
    project's master (`core/remote-claude-session-copy.ts`, tested under a real `/bin/sh`; same
    prefix/diverged rule, via `head -c | cmp`), and `SshProjectManager.remoteClaudeSessionCopy`
    refuses an account pinned to another host. An SSH ctx with no remote leg (Server Edition) is
    refused, never answered from the local disk. Relay tabs: shown disabled.
    **Two more surfaces, one choreography** (`runClaudeAccountSwitch` returns a
    `ClaudeSwitchOutcome` instead of announcing it): the **kanban card** right-click menu gets the
    node's rows from the SAME builder the canvas node menu uses (`accountSwitchRows` → KanbanView's
    `accountMenuItems`), and the **usage popover** puts "⇄ Move N sessions" on each account row —
    every Claude session on this canvas running on that account, on the popover's machine
    (`bulkSwitchCandidates`), is moved to the picked account ONE AT A TIME (N parallel copies +
    recycles on one host is a load spike), busy ones skipped and counted, one summary line
    (`summarizeBulkSwitch`). The cross-project board (GlobalKanbanView) does not offer it:
    its cards belong to other projects' canvases, whose nodes have no restart closure mounted.
  - **`boundAccountId(accountId, agentId)` (`shared/agents/account-binding.ts`) is the ONE rule for
    whether a node is account-bound at all**, and it feeds `data.accountId` *and* the account color
    from a single decision — split them and a node carries an account it is not painted for, or is
    painted for one it does not carry. Two surfaces mint nodes and both ask it: `createAgentNode`
    (canvas) and `appendProjectNode` (the phone's `projects.registerNode`, which used to write
    whatever the wire sent, so a gemini node could come back bound to a Claude account). Managed
    accounts belong to the builtin **claude and codex** (S6); a **known** other agent — builtin or
    custom, since a custom agent inheriting one of those harnesses is still its own agent — never
    binds. **An UNSTATED agent keeps its binding** — the asymmetry is deliberate: the phone chooses
    `agentId` and `accountId` independently and is not known to always send the first
    (docs/ios-protocol-migration.md §6), dropping a real binding is the wrong-identity bug the
    field exists to prevent, while a stray one on an agent-less node only sets a config-home
    variable nothing reads. On the canvas `agentId` is always stated, so that path is bit-for-bit
    what it was. `main` resolves the color off the RAW id and lets the registrar refuse it, rather
    than re-deriving the gate at the call site.
  - **Account default node color (`ClaudeAccount.color` / `CodexAccount.color`, optional)** — a
    per-account default node color (Settings → Accounts) that beats the agent's own brand color in
    `createAgentNode`, so a second login is recognizable on the canvas. Read off the SAME
    `boundAccountId` that stamps `data.accountId`, so the color and the binding cannot drift.
    Applied **at creation** and baked into `data.color` like any other node color: a hand-picked
    node color is never overwritten and editing the account later repaints nothing. Unset / stale
    id / an agent that takes no managed account ⇒ the agent's color, unchanged.
    **Which list answers is `agentAccountColor`'s alone** (`shared/agents/account-color.ts`, one
    definition shared by `createAgentNode` and the phone-registered node path in `src/main`):
    claude reads `claudeAccounts`, codex reads `codexAccounts`, everything else reads nothing. The
    two lists are keyed **independently** — nothing stops the same id appearing in both — so a node
    colored from the other list would be repainted from a stranger's row; the swatch UI is one
    component (`AccountColorSwatches`) rendered by both row kinds for the same reason.
    The value is **re-validated as a string** at the read: the account lists come out of a
    hand-editable settings.json that nothing checks field-by-field on load, and a `"color": 123`
    would throw on `.trim()` INSIDE `createAgentNode` — stopping every new node under that account
    from opening, with nothing pointing back at the edited file.
  - **Env injection** — `pty-manager` sets `CLAUDE_CONFIG_DIR` in the spawn env AND as a tmux `-e`
    (local); for a remote node it emits an **absolute-path** remote tmux `-e` built from the
    connection-cached `remoteHome` (skipped **fail-open** if home is unresolved). `AUTH_ENV_STRIP`
    (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`) is deleted from the
    child env so a stray env key can't shadow the account. A **missing** account dir → warn +
    silent system fallback. **The account-scope names ride the LOCAL conf's `update-environment`
    (`ACCOUNT_SCOPE_UPDATE_ENV`, issue #419)** — the shared tmux server inherits the env of the
    client that STARTS it, so a server started by a managed-account node used to leak that
    account's `CLAUDE_CONFIG_DIR` (and any un-stripped auth key) into every session created
    without a `-e` override: system nodes, plain terminals and the missing-dir fallback silently
    ran as that account ("the system account is entangled with the next account in the list").
    Listing the names makes tmux copy each from the creating client's env and **strip it when the
    client lacks it** (proven against a real tmux in `account-env.realtmux.test.ts`, seeded-server
    case included; `ensureUpdateEnvKeys` retrofits a long-lived pre-fix server). The same listing
    is what makes codex's explicit system-scope overwrite (`CODEX_HOME` /
    `NODETERM_CODEX_ACCOUNT_ID`) actually reach sessions on a shared server. **LOCAL conf only**
    — the remote conf must NOT get these names: a remote attach client's env is the login
    shell's, and the copy/strip would run against that wrong environment (pinned in
    `ssh.test.ts`).
  - **Login flow** — Settings → Accounts → **Add** creates a `pending` account and drops a canvas
    **login node** that runs `claude /login` under the account dir. Core polls the dir's
    `.claude.json` (`LOGIN_POLL_MS` 2 s, up to `LOGIN_TIMEOUT_MS` 5 min) for `oauthAccount.email`;
    on capture the account flips out of `pending` with its email as the default label. Account
    removal cancels any pending wait + `markDirty`. **Codex accounts have the same two halves** —
    `createCodexAccountLoginNode` (`codex login`, title "Codex login") behind the
    `nodeterm:add-codex-account-login` listener, with `codexAccounts.waitLogin` polling the managed
    home's `auth.json`. Both flows mint an **agent-less terminal** carrying only `accountId`, and
    that shape is why `needsCodexAccountScope` takes an `isCodexAccount` resolver rather than
    reading `!!accountId`: the two account lists share an id alphabet, so the id alone cannot say
    which provider it belongs to. Guessing "codex" refused every managed **Claude** node (#345);
    guessing "not codex" would let `codex login` write into the system `~/.codex`. A dispatch with
    no listener is a silent no-op, which is how the Codex half shipped inert (#346) — pinned now by
    `renderer/lib/nodeterm-events.test.ts`, which fails on any `nodeterm:*` event that is sent but
    never heard. **All THREE login factories take a `cwd`** (`createAccountLoginNode`,
    `createCodexAccountLoginNode`, `createSystemLoginNode`), and every call site passes the active
    project's — a login node with none starts in `$HOME`, and an agent CLI whose trust check is
    keyed on the cwd (Claude Code's is) then asks the user to trust their entire home directory,
    SSH keys and cloud credentials included, before an OAuth round trip that touches no files
    (issue #553; a persisted "yes" there grants that workspace for good). It is not a promise the
    prompt disappears — an untrusted project still prompts — it makes it the exception rather than
    the rule, without nodeterm writing another tool's trust config on the user's behalf. A
    **remote** login ignores the local path: `createTerminalNode` prefers `ssh.remoteCwd`, which is
    the only cwd that means anything for a session running on the host. An SSH project has no local
    `cwd`, so a LOCAL account added from one still opens in `$HOME` — the honest answer, since that
    project owns no local directory.
  - **The lifecycle is CORE, and both shells register it** (issue #313) —
    `core/claude-accounts-service.ts` owns the five `claude-accounts:*` channels (add / wait-login
    / cancel-wait / remove / link) behind `platform().handle`; `main/claude-accounts.ts` is a thin desktop
    wrapper and `registerCoreHandlers` calls the same `registerClaudeAccountsIpc()`. Two optional
    deps carry everything core cannot reach: `installSkill` (desktop passes `installCanvasSkillInto`;
    an enabled Server canvas-control runtime installs its Server-specific skill separately) and
    `remote`, a **thunk** resolving the SSH legs
    (desktop's manager is created after the registration, and the server has none — in both cases
    an `AccountCtx` carrying a `projectId` degrades to the LOCAL path, which is the pre-existing
    behavior this preserves). **Three surfaces:** Desktop unchanged (same channels, same shapes,
    same remote fallbacks); **Server Edition** now full — real `buildClaudeAccountsApi` over the
    ws-bridge (the 5-min `waitLogin` is a straight passthrough because RpcClient has no request
    timeout), minus SSH accounts and the canvas skill; **Mobile: N/A** — the phone launches with
    the accounts the agent-status mirror advertises and never mints one. **Managed CODEX accounts
    stay desktop-only** and their bridge namespace stays an `E_UNSUPPORTED` stub: the switch verbs
    authorize the owning window by Electron WebContents id, which has no meaning over a WS
    connection. The Settings section now *names* that refusal instead of leaving an unhandled
    promise rejection — a spinner that stops and says nothing reads as a dead button.
  - **Hook install** — the managed hook is merged into **each account dir's** `settings.json` at
    add-account **and** at app launch (local, shared `install-helper.ts`) / via
    `RemoteHooks.installIntoAccountDir` (remote), so every identity reports agent status. The
    launch-time loop is ONE function (`installHooksIntoLocalAccounts`, beside the service) that
    both shells call — the desktop passing the canvas skill as its `extra`. A second copy is the
    drift these docs warn about elsewhere: the Server Edition shipped without the per-account leg
    entirely, so a managed account there reported no agent status at all.
  - **Shared system skills (`shareSystemSkills`, issue #643, OFF by default)** — Claude Code resolves
    user skills as `join(CLAUDE_CONFIG_DIR ?? ~/.claude, 'skills')` (MEASURED, 2.1.266), so an
    account dir **replaces** `~/.claude/skills` rather than adding to it and a fresh managed account
    shows only the skills nodeterm installed (that was #438). The isolation is correct and often the
    point; this per-account switch (Settings → Accounts) is the way back in.
    **Each system skill is linked INDIVIDUALLY** (`<accountDir>/skills/<name>` →
    `~/.claude/skills/<name>`), never the whole `skills` directory, and that choice is what makes
    everything else safe: `installCanvasSkillInto` writes *into* `<configDir>/skills/`, so a
    directory-level link would put nodeterm's canvas skill in the user's SYSTEM skills folder, and
    "turn it off" would have to restore a directory it had first moved aside. Per-skill links keep
    the account's `skills/` a real directory and make the off-switch a link removal.
    MEASURED with strace: Claude Code opens a symlinked entry inside `skills/` as a directory and
    reads its `SKILL.md` exactly like a real sibling — per-skill links are equivalent to the
    whole-directory link for discovery, not a compromise.
    - **Ownership is name-anchored**: an entry is ours iff it is a symlink whose target normalizes
      to exactly `join(systemSkillsDir, <that entry's own name>)`. What ON creates is precisely what
      OFF removes; a real directory is never ours, whatever its name — so "never delete through the
      link" is a property of the plan (`core/claude-skill-share-core.ts`, pure + mutation-tested),
      not a promise about the applier. Removal is `unlink` then `rmdir` (a Windows junction refuses
      `unlink`); both fail on a real non-empty directory, which is the second line of defence.
    - **`NODETERM_OWNED_SKILLS` (`manage-nodeterm-canvas`, `get-linked-context`) is never linked and
      never pruned.** Their presence in an account dir is decided by nodeterm's own installers; if
      sharing linked them, the off-switch would delete a skill the canvas-control installer had put
      there and the two owners would fight over the name at every launch.
    - **The realpath refusal is load-bearing.** The issue's manual workaround
      (`mv skills skills.bak && ln -s ~/.claude/skills skills`) makes the account's `skills/`
      RESOLVE to the system one; linking into it would plant links in the user's own folder and let
      the off-switch delete them from there. The planner compares REAL paths and refuses
      (`same-directory`), which also covers a linked account whose `configDir` was hand-edited to
      `~/.claude`.
    - **Windows uses a directory JUNCTION** (`fs.symlink(target, path, 'junction')`), not the `'dir'`
      symlink `worktree-shared-paths.ts` must use: a junction needs neither Developer Mode nor
      elevation, and every target here is an absolute directory — the two conditions it has. On
      POSIX Node ignores the type. So the feature is available on every desktop platform rather than
      gated off one.
    - **The launch sweep re-links but NEVER removes** (`installHooksIntoLocalAccounts`). ON has real
      work at boot (a skill added to `~/.claude/skills` since the last run; a stale link to prune);
      OFF is a removal, and ownership here is inferred from a link's SHAPE, which cannot tell our
      link from an identical hand-made one — and a LINKED account's dir is the user's own
      `~/.claude-2`, where exactly that is a normal thing to find. Removal therefore happens only
      through `claude-accounts:set-skill-sharing`, where the intent is explicit. The cost: a
      settings.json hand-edited to `false` while the app was closed keeps its links until the switch
      is flipped.
    - **The switch flips the filesystem FIRST and persists the flag only if that returned** — the
      flag is what the sweep replays, so a stored `true` whose links were never made would make the
      switch lie until the next boot. A refusal stores nothing.
    - **The copy says the edits flow both ways**, because a link is not a copy: editing a shared
      skill from inside the account edits the machine's own file. A user who reads "share" as "copy"
      finds that out by losing work. Result sentences are the pure `renderer/lib/skillSharing.ts`.
    - **Surfaces.** Desktop: full. **Server Edition: full** — the whole implementation is core, so
      the ws-bridge leg is a real passthrough and the machine the browser is served from is exactly
      the machine whose `~/.claude/skills` is shared (the canvas skill is not installed there, but
      its name stays reserved: a reserved name that is never created is inert). **SSH accounts:
      explicitly out of scope for v1** — their config dir is on the host, so the option would have to
      link that host's skills over the ControlMaster, with its own generated-shell proof obligation.
      The switch is DISABLED with that reason (never hidden), and core refuses (`remote-account`) as
      the backstop for a hand-edited settings.json. **Mobile: N/A** — the phone never mints an
      account and carries no skills concept.
  - **Account-aware readers** — transcript resolution is scoped per account (`transcriptRootFor`
    picks the account dir's `projects/`, composite cache key includes `accountId`); the same
    threading runs through the session-name poll, restart handoff, and `ChatPanel` (the ⌘M
    transcript view, `chat.readTranscript`). The **usage indicator** is per account (`claude-usage.ts`: scoped Keychain
    service only for managed accounts, then their credentials file; popover lists a row per account with **System**
    first). **Remote (SSH host) accounts are included** — see **Remote usage** below.
  - **Pickers** — New Claude exposes an account **submenu** (pane menu; flat entries in
    the dock; palette commands; TabBar sets the **per-project default**). A **local** project
    lists local accounts, an **SSH** project lists only accounts whose `host` matches its
    connection; both offer a **System account** option. An SSH project whose host has **no**
    matching accounts gets a disabled hint row instead of a bare System-only list
    (`sshAccountsHint` — pane submenu, dock, TabBar; the palette deliberately omits it: a
    disabled row would surface as a search result) saying accounts for this host are added in
    Settings → Accounts while the project is connected — local accounts being invisible there is
    correct (their credentials aren't on the host) but read as "multi-account is broken on SSH".
  - **Remote accounts** — selection + login + env injection, plus **usage** (below); no
    per-account transcript readers beyond env.
  - **Settings → Accounts is ONE machine-grouped surface for BOTH providers** (2026-09): a panel
    per machine (this one, then each saved SSH server ∪ the active project's server — a saved server
    with no accounts and no connection is folded into a footnote count), each holding a Claude and a
    Codex block with the SAME row, system row and Add button (`groupAccountsByMachine`). A remote
    machine's Add / Retry / Remove act ON that host over a **connected** project only — a
    disconnected host's Add is disabled and its Remove only forgets the record (the dialog says so);
    a remote id never reaches a LOCAL remove. Codex gained the remote lifecycle this needed:
    `codexAccounts.add/waitLogin/identity/remove` take an SSH `ctx` (desktop `src/main/codex-accounts.ts`
    → the `SshProjectManager.remoteCodex*` legs; the credential is written on the host by
    `codex login --device-auth` — the default browser flow calls back to the HOST's localhost), and
    `systemIdentity({projectId})` now asks the host instead of answering `null`.
  - **The remote spawn scopes the account BY PROVIDER** (`core/remote-account-env.ts`). It used to
    hand every `accountId` to Claude's `CLAUDE_CONFIG_DIR`, so a node bound to a managed Codex account
    on an SSH host got a Claude dir that does not exist and NO `CODEX_HOME` — its codex silently ran
    as the host's system login (`remoteCodexTmuxEnvArgs` existed with no caller). The system Codex
    account is left to the host's own env (a remote `CODEX_HOME` of the user's — a snap remap — must
    win).
  - **Switch Codex account on an SSH node** (2026-09) does NOT use the local three-phase reservation
    (it plans rollouts in LOCAL homes). It is one host-side exposure —
    `codexAccounts.switchThreadRemote` → `SshProjectManager.remoteCodexSwitchThread` →
    `remoteCodexExposeThread` (relay `expose-thread`): resolve the thread across every account
    catalog on the host, hardlink the one authoritative rollout into the target home, verify the
    target's app-server discovers it, roll the link back if not; an ambiguous thread is refused.
    Then the usual still-eligible check and a restart-shell recycle, with the rebind riding
    `beforeRecycle` (never a separate setNodes). A hardlink, not a copy: both accounts see ONE file,
    so there is no diverged-copy case. Needs the relay runtime on the host (node + codex + curl);
    without it the switch fails with a notice and nothing changes. `planCodexAccountSwitch` now
    refuses a target on another machine than the node (`hostKey`) — the switch never crosses
    machines (moving a local conversation to a host is `transferThreadToSsh`, a separate flow).
  - **Linked accounts** (`ClaudeAccount.configDir`) — a PRE-EXISTING local config
    dir the user already drives themselves (`export CLAUDE_CONFIG_DIR=~/.claude-2; claude …` in a
    plain terminal) adopted as a first-class account without a login node. Settings → Accounts →
    **Link existing config dir…** (or one click on a **Detected** dir) calls `claude-accounts:link`
    (core service): `~` expansion → `normalizeLinkedConfigDir` → string-only refusals (the system
    `~/.claude`, anything under `{userData}/claude-accounts`, an already-linked path) → `stat` →
    email from `<dir>/.claude.json` (missing = `email: null`, not an error) → managed hook install.
    `claudeConfigDirFor(id)` consults a **registered accounts source**
    (`registerClaudeAccountsSource`, both shells right after `settingsStore.init()` — BEFORE the
    mirror settings provider can flush, or the phone would be advertised a non-existent managed
    dir), so env injection, `transcriptRootFor`, the transcript index, usage rows and the pickers
    all resolve a linked id to the user's own dir with no per-caller branch. The transcript jails
    (`isSafeLocalTranscriptPath`, both raw listeners) accept `<linkedDir>/projects/**` for dirs
    **from settings only** — never a dir named by the POST. **Removing a linked account only
    forgets the record**: the `rm -rf` names `accountConfigDir(userData, id)` directly, so it is
    structurally incapable of reaching outside the managed root even if the settings row is gone
    before the IPC lands. The hook installer resolves `settings.json` symlinks and atomically updates their target
    (without replacing the link) — a profile whose `settings.json` symlinks to `~/.claude/settings.json` (the
    two-profile layout) stays a symlink; pinned by `claude-accounts-link-symlink.test.ts`, and
    switching that write to `renameAtomic` would be the regression (it replaces the link).
  - **Observed account** (`ObservedClaudeAccount`, `NormalizedAgentEvent.account`) — which account
    a session is ACTUALLY on, derived by the hook server from the payload's `transcript_path`
    (`<configDir>/projects/<slug>/<session>.jsonl`; `configDirFromTranscriptPath` walks up to the
    LAST `projects` segment, so `~/projects/.claude/projects/…` names `~/projects/.claude`, not
    `~`). `classifyClaudeConfigDir` is pure string matching, host-agnostic: managed local root →
    managed remote pattern (`…/.nodeterm/claude-accounts/<id>`) → linked (settings) → any
    `…/.claude` ⇒ system (`accountId: null`) → else `known: false`. It is a **LABEL** exactly like
    `verified`/`clientRevision`: attached to the normalized event in ONE place (the hook server),
    so both shells inherit it and neither raw listener changes; claude events only; never throws;
    **never reads the filesystem** (a forged POST naming `~/.ssh/projects/x` gets `known: false`
    and nothing is opened). Recorded by the mirror (`MirrorEntry.account`) and the renderer store
    (`agentStatus.account`, persisted like `agentId` — a hand-launched claude's identity exists
    nowhere else). **Effective account for READERS** = `data.accountId ?? observed.accountId`
    (`renderer/lib/accountChip.ts` `effectiveAccountId`): `readSessionName`, `context.ensure`, the
    transcript search and the ⌘M view use it; **spawn/env never does** (launch identity stays
    creation-time). The **account chip** (`components/AccountChip.tsx`, ONE component on the node
    header, kanban card, card modal and sidebar row) shows for any non-system account, and for
    system panes only when ≥ 2 distinct account keys (`sys` / `<id>` / `ext:<dir>`) are live on the
    core (`hasMultipleAccountKeys`, a primitive selector so headers don't re-render on every hook
    event). An unlinked dir is named by its last path segment (`.claude-2`, dashed chip) with a
    tooltip pointing at Settings → Accounts, where **Detected config dirs** lists it for one-click
    linking. Mobile: N/A (additive mirror fields).

- **Active Claude organization** (#552) — local Desktop and Server usage snapshots carry optional
  `organization` metadata from the SAME account's `.claude.json` (system, managed or linked).
  Read it even if Keychain/file credentials already have an email; unreadable/missing metadata
  preserves the email and usage. A known email mismatch drops metadata. Managed usage cannot use
  an unscoped Keychain token: a matching email alone does not prove it belongs to the same org.
  The popover names the org beneath the email; internal type/tier/id remain tooltip details.
  Refresh re-reads metadata together with usage; normal cache/poll intervals still apply.
  SSH's existing shell reader does not supply organization metadata and keeps its email-only
  fallback. Mobile's usage mirror currently omits it; displaying orgs there needs a follow-up
  mirror/iOS protocol change. No organization picker, credential writes or switching are added.

- **Bottom chrome shares a measured width budget** (issue #853). `CanvasPills` observes the canvas
  wrapper and actual dock, bounds the left row with an 8px gap, and uses a row above the dock when
  fewer than 200 CSS pixels remain. Rects are converted back through UI scale. Usage summary text
  ellipsizes; refresh never shrinks. Do not clip the whole row or give it a stacking context:
  usage/RAM popovers must escape independently above the sidebar and board. Desktop and Server
  share this renderer. The real-browser regression is `scripts/usage-layout.test.ts` (`CHROME_BIN`).

- **The usage indicator is scoped to the ACTIVE project** (`renderer/lib/usageScope.ts`, pure +
  unit-tested) — it describes **the machine that project runs on**, and nothing else. A local
  project shows this machine (system + managed local accounts + the billing providers, whose
  credentials are all local); an **SSH project shows that host's Claude and Codex accounts** — no local
  Claude, no local providers, no other host. Without this the panel showed every source at once:
  each addition was individually reasonable and the sum was unreadable, numbers from three
  machines sharing one line with nothing saying which was which. Deliberately NOT narrowed to the
  project's `defaultAccountId`: the local side lists every local identity, so the machine is the
  scope and the account is a row within it. The pill spells out the scoped machine's **system**
  account (falling back to the first identity with data, so a host used only through a managed
  login isn't blank), managed accounts stay popover-only — the rule the local side always had.
  `usageScopeKey`/`scopeFromKey` exist because the active project object is rebuilt on every node
  serialization: the zustand selector returns ONE primitive so the indicator doesn't re-render on
  every canvas edit. ⟳ refreshes only what is on screen, and `usage.remote({hostKey})` reads only
  that host (cache eviction still runs against the FULL target list, so switching between two SSH
  projects doesn't throw each host's cache away).

- **Grok billing failures** retain per-view HTTP status or a safe timeout/network/invalid-response category in `ProviderUsage.diagnostics`. The default view still runs after a credits failure; recovered limits keep their diagnostic. Only two successful empty views imply no quota. Never include raw exceptions, URLs or response bodies, or refresh/write credentials. Desktop and Server share the core reader and popover; provider-only errors must keep the pill visible.

- **Usage failure readouts** — an empty Claude snapshot with `status: error` says "Could not
  read usage." in both the single-account and multi-account popovers, including beside healthy
  provider rows. Nonempty snapshots retain their last-known bars on error; no error-specific
  authentication advice is inferred from the status.

- **Remote usage** (SSH hosts, `src/core/usage/remote-claude-usage.ts`) — the source behind the
  SSH scope above. v1 excluded remote accounts, which left a user whose Claude only ever runs on a
  server staring at an empty indicator while the host had perfectly good numbers.
  **The token never leaves the host.** The desktop could `cat` the remote `.credentials.json` and
  call the API itself — it already reads remote transcripts over the same master — but a bearer
  token pulled off a (possibly shared) server into another machine's memory buys nothing: the host
  can make the request itself. So core generates a POSIX **sh+curl** command, the shell runs it
  over the project's ControlMaster, and only the JSON answer comes back. Three details are
  load-bearing:
  1. **The token is piped into `curl --config -`, never `-H` on the command line** — argv is
     world-readable via `ps` on a shared host.
  2. **`.credentials.json` holds more than one `accessToken`** — every MCP server the CLI has
     authorized keeps its own under `mcpOAuth`. The extraction narrows to the `claudeAiOauth`
     object first (exactly as the local `parseCreds` does), because grabbing the file's first match
     sends an MCP token to the endpoint, earns a 401, and reports a signed-in host as signed out.
     Caught only by running the command against a REAL credentials file — which is why
     `remote-claude-usage.test.ts` runs the generated script under a real `/bin/sh` against a fake
     `$HOME` + fake `curl`, the same discipline as the canvas-control shim.
  3. **A read that could not run is `error`, never `unavailable`** — a dead master says nothing
     about whether the account has a subscription, and 'unavailable' silently drops the row.
  Shape: `remoteUsageTargets` (pure) elects ONE connected project per host (several projects share
  a host's `$HOME`) and offers its system `~/.claude` plus every managed account pinned to that
  host. The service (`usage:remote`) caches per target under the usual debounce, evicts targets
  whose host disconnected, and coalesces concurrent reads. **On demand, never polled** — each row
  is an ssh exec plus an HTTPS request on someone else's machine; the renderer asks on mount, on
  popover open, on ⟳, and when the active project's connection comes up (an SSH project is opened
  before its master is ready). Deps are injected exactly like
  Context Link's (`src/main` supplies the ControlMaster; **Server Edition passes none** ⇒ `[]`, so
  the UI needs no capability check). Own Settings switch (`claude-remote`), because hiding local
  Claude usage must not silently take the hosts down with it. **Mobile: N/A** — the
  slice pushed to a host still drops `usage` (a host reading its own numbers back off us is
  pointless), and no keychain leg exists remotely (a headless macOS host would hang on the prompt,
  so a mac host reports nothing).

- **Codex SSH usage** (`core/usage/remote-codex-usage.ts`) uses host-side Node JSON parsing
  and curl, reusing the local Codex quota mapper. Read only `tokens.access_token` and
  `tokens.account_id`; pass headers through stdin, disable curl config/redirects, and return
  only sanitized quota fields. Never download credentials, refresh tokens, or launch a remote
  app-server just to refresh usage. The host needs Node and curl; missing tools/transport or
  malformed responses are errors, not proof of a logged-out account. System reads use the
  host login environment's `CODEX_HOME`; managed reads use the validated account's remote
  home. Cache identity includes provider, host, account and connection/home identity.
  Remote Codex rows obey the Codex visibility setting and carry no Claude default-account
  or bulk-move actions. Desktop supports SSH reads; Server Edition keeps its local core
  readers and absent SSH dependency. The private mobile reader is separate. Device checks:
  `docs/codex-ssh-metrics.md`.

## Remote Codex account safety

Remote Codex safety (#736): `spawnNew` requires managed SSH Codex accounts (including custom
Codex harnesses and known agent-less login terminals) to have a safe id in the saved Codex account
list and a safe resolved `remoteHome`. `remoteAccountScopeEnvArgs` then supplies the private
`CODEX_HOME` and account marker. An unresolved or unsafe home must refuse before env staging/spawn,
not fall back to the host's system login. System Codex retains the host environment even before
home discovery during early attach. Never guess HOME/CODEX_HOME. Desktop and Server share this
core gate; Desktop supports the remote lifecycle, while Server account management remains unavailable.
