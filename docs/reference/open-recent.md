# Open recent (resume a past agent conversation from its history) — deep reference

Moved verbatim from `CLAUDE.md` so the always-loaded file stays small. `CLAUDE.md`
keeps a short summary and links here. When a rule here changes, update both.

## Open recent (resume a past agent conversation from its history)

Past conversations live in each CLI's own history, and nodeterm used to resume only what a node
remembered. "Open recent" lists them — the start screen's **Recent conversations** (grouped by the
folder each ran in) and a **Recent conversations** section of ⌘K — and one click resumes one.
Reader: `core/recent-conversations.ts` (`recent-conversations:list`, registered by BOTH shells);
plan: the pure `renderer/lib/recentConversations.ts`; execution: Canvas `resumeRecentConversation`.

- **Which agents, and why only those** (`RECENT_CONVERSATION_AGENTS`, `@shared/recent-conversations`):
  claude (system root + every LOCAL settled managed and linked account — `claudeAccountsSnapshot`),
  codex (system `CODEX_HOME` + the managed homes whose ids the renderer sends; core re-validates
  each through `codexHomeForAccount`, which throws outside the id alphabet), gemini, grok, copilot.
  Each is in `RESUMABLE_AGENTS` AND has a measured on-disk shape. **opencode is out**: its history is
  a SQLite database we never open, and the only reader is `opencode export` (one spawn, ~1.5 s,
  ~320 MB per session). **antigravity is out**: its record shapes were never captured. An agent
  outside the list contributes no rows — nothing guesses at a layout.
- **Measured shapes the reader depends on** (dev host, 2026-09-30): codex `session_meta` carries
  `id`, `cwd` and `thread_source` — a spawned child says `"subagent"` with a `source: {subagent:…}`
  object (4 of 62 rollouts here) and is SKIPPED, a user's own thread says `"user"`; that first line
  also carries the whole base instructions (tens of KB), which is why the head read is 512 KB.
  gemini's project dir holds `.project_root` = the absolute cwd, and its header says `kind: "main"`;
  a session holding only harness `<session_context>` (no prompt, no title) is not a conversation
  and is skipped (all 3 gemini sessions on this host). grok's session group is the URL-encoded cwd;
  a group that does not re-encode to its own name (grok's slug+hash form for a long cwd) keeps a
  null cwd rather than a guessed one. copilot's `session.start` names `context.cwd`, and its
  `sessionId` must equal the directory it sits in.
- **Bounded**: per root only the newest `PER_ROOT` (25) files by mtime are OPENED; every other
  file costs a stat, and stats run in parallel capped at `STAT_CONCURRENCY` (32) — the first version
  awaited them one by one, which review measured at 2.8–4.0 s warm for 10,000 transcripts on every
  ⌘K. Codex walks its dated tree newest-first and stats at most 100. Each open is a 512 KB head plus,
  for a claude/gemini title, a 128 KB tail; the parse is cached by (path, size, mtime), and the whole
  answer is REUSED for `RESULT_REUSE_MS` (10 s, keyed by the exact roots + limit, concurrent callers
  share one read). Measured (fixture trees, this host): 300 files 45 ms cold / 17 ms warm, 3,000 →
  209 / 356 ms, 10,000 → 630 / 617 ms; the real dev-host history (313 claude transcripts, 62 codex
  rollouts) 227 ms cold, 20 ms cached, 46 rows. Read on demand only — once per start-screen
  appearance and per palette open, never a timer. (`core/transcript-index.ts` was not reused: it is
  claude-only and carries no account per entry.)
- **Title = display text, never a command.** The agent's own session name where it has one (claude
  `custom-title`/`ai-title` via `pickSessionName`, gemini `update_topic` via `pickGeminiTitle`, grok
  `summary.json`), else the first thing the user typed (the agent's own chat parser; a `<…>` harness
  wrapper is not a prompt). Every title goes through `untrustedLine` (no control, bidi or zero-width
  characters, one line, capped at 120). Every file the reader opens is `lstat`ed first and must be a
  regular file — transcripts, gemini's `.project_root` and grok's `summary.json` alike — so a symlink
  planted in a history dir is never followed. Only the SESSION ID reaches a pane, re-validated
  three times: `SAFE_SESSION_ID` at read, `canResumeWith` in the plan, and `createAgentNode`, which
  THROWS on an id the resume grammar refuses rather than silently starting a fresh conversation.
- **The resume funnel is the factory's own**: `createAgentNode`'s trailing `resumeSessionId` builds
  the line with `assembleResumeCommand` — the assembler cold restore uses, so a launch override,
  custom args, codex's launcher, `withPermissionMode` and the gateway model all apply — mints no id,
  and persists the RESUMED id as `agentSessionId`. The ⌘K transcript-search hit now uses the same
  path; before, it replaced the command by hand and kept a freshly minted id the node never ran, so
  its cold restore after a reboot resumed nothing — and it passed no account, so a hit from a
  managed/linked root resumed under the system login. `TranscriptHit.accountId` (from the index root
  that holds the file) now travels with it, refused if that account is gone or not local.
- **The account is the one that holds the history**, never the project default: a conversation in a
  managed account's config dir resumed under the system login answers "No conversation found".
  `boundAccountId` still decides binding; the plan REFUSES when that account is gone, pending or
  host-pinned (`RESUME_REFUSALS.accountGone`). A codex rollout HARDLINKED into a second home by
  "Switch Codex account" is one inode seen twice with the same mtime: `mergeRecent` credits the tie
  to the MANAGED account's copy. That is usually the account it was switched TO; a switch back to
  the system login is credited wrongly, which costs nothing — both homes hold the same file, so the
  resume finds it under either.
- **Where it resumes** (`planResume`):
  - A node already holding the session is FOCUSED — two CLIs on one transcript interleave it. A node
    holds exactly ONE session: its live hook id, ELSE its persisted `agentSessionId` — never both.
    `agentSessionId` is the launch-minted id and nothing rewrites it from hooks, so after `/clear`
    (live B) the node no longer holds A, and A must stay resumable (`closedHistory` uses the same
    `live || persisted`).
  - A folder that no longer exists (`cwdState: 'absent'`, a definite ENOENT/ENOTDIR from core — a
    failed stat is `unknown` and proceeds) is REFUSED: opening it would RECREATE it (the store
    mkdirs `<cwd>/.nodeterm`), and a removed worktree is the common case; a later
    `git worktree add` at that path would then fail.
  - Else the MOST SPECIFIC local owner of the folder: a worktree-bound group frame whose
    `worktree.path` is the folder or an ancestor (the node opens inside that frame), or the local
    project whose cwd is the folder or an ANCESTOR — segment-wise (`containsDir`), longest wins,
    then active > open > closed (reopened). A conversation in `/repo/packages/app` resumes in the
    `/repo` project; it does not mint a second project with a `project.json` inside the repository.
    The node's cwd is always the conversation's own folder (the CLI keys the transcript by it).
  - **Never an SSH project or a relay tab**: this is this machine's history, and those cwds are on
    another machine. `openFolderProject`/`openOrAdoptFolder` now skip relay tabs too — a relay tab
    carries the HOST's cwd, and the same path on two machines used to switch to it and do nothing.
  - No owner → "Open folder & resume" through `openOrAdoptFolder` (the same probe/adopt rules as
    "Open folder…"); the ⌘K row says "Open folder & resume: …", never a bare "Resume". A resume into
  another project lands via `pendingResumeRef`, consumed by the project-load effect beside
  `pendingFocusRef`, and RE-PLANS at creation (a node may have taken the session meanwhile).
  Refused rows stay on the start screen, disabled with the reason; the palette omits them (no
  disabled state there).
- **Surfaces.** Desktop: this machine's history. **Server Edition**: its own host's history — the
  machine the browser's sessions run on (real ws-bridge leg). **SSH projects: local history only in
  v1** — a remote host's transcripts would need a remote leg over the ControlMaster, and a local
  conversation is never resumed into an SSH project. **Relay tabs**: the list stays LOCAL (relay-api
  spreads `...local`), and `recent-conversations:list` is `HOST_ONLY` so a peer can never list the
  host's history (titles are prompts the host's user typed, in every project). **Mobile**: follow-up
  in nodeterm-ios — "open recent" on the phone needs this list over the relay dialect.
