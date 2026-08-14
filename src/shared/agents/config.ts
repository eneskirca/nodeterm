// Single source of truth for agent launch behavior and capabilities.
// Design: an open AgentId string, a declarative config record, and
// capabilities expressed as const membership lists (not a capability object).

export type BuiltinAgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'grok'
// Open type — custom agents are any string ('custom:<uuid>'). Never restrict the set.
export type AgentId = BuiltinAgentId | (string & {})

export type PromptInjectionMode = 'argv' | 'flag-prompt' | 'stdin-after-start'

export interface AgentConfig {
  label: string // menu + node title, e.g. 'Claude Code'
  color: string // node color
  launchCmd: string // base launch command
  promptInjectionMode: PromptInjectionMode
  /**
   * Put this between the command and an `argv` prompt — in practice `'--'`, and only for a CLI
   * whose grammar has BOTH a positional prompt and subcommands.
   *
   * grok is the case that needs it: its usage is `grok [OPTIONS] [PROMPT] [COMMAND]`, so a
   * one-word prompt collides with a subcommand name. Measured against the shipped binary, `grok
   * version` PRINTS THE VERSION AND EXITS while `grok -- version` opens a session with "version"
   * as the prompt — so without the separator a prompt of `help`, `version`, `login`, `models` or
   * `export` is silently executed as a command and never reaches the model.
   *
   * Omitted for every other agent: claude takes a positional and has no subcommand that could
   * shadow one, and adding a `--` there would change a command line that works today.
   */
  argvPromptSeparator?: string
  expectedProcess: string
}

export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'grok'
]

export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: {
    label: 'Claude Code',
    color: '#d97757',
    launchCmd: 'claude',
    promptInjectionMode: 'argv',
    expectedProcess: 'claude'
  },
  codex: {
    label: 'Codex',
    color: '#10a37f',
    launchCmd: 'codex',
    promptInjectionMode: 'argv',
    expectedProcess: 'codex'
  },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    launchCmd: 'gemini',
    promptInjectionMode: 'stdin-after-start',
    expectedProcess: 'gemini'
  },
  opencode: {
    label: 'opencode',
    color: '#a78bfa',
    launchCmd: 'opencode',
    // A bare positional is a PROJECT PATH for opencode, so the initial prompt must go
    // through --prompt (see createAgentNode's flag-prompt branch).
    promptInjectionMode: 'flag-prompt',
    expectedProcess: 'opencode'
  },
  grok: {
    label: 'Grok',
    color: '#64748b',
    launchCmd: 'grok',
    // Verified against the SHIPPED 1.0.0 binary: usage is `grok [OPTIONS] [PROMPT] [COMMAND]`, so
    // the prompt is a positional — but one that shares its slot with the subcommand list, which is
    // what the separator is for (see `argvPromptSeparator`). An earlier reading of this file said
    // `stdin-after-start`, taken from grok 0.1.220, which had no positional at all; npm's `latest`
    // tag on the platform package still points at that old build, so the first binary a `npm pack`
    // hands you is NOT the one `@xai-official/grok` installs.
    promptInjectionMode: 'argv',
    argvPromptSeparator: '--',
    expectedProcess: 'grok'
  }
}

// Capabilities = const membership lists. A custom agent is in no list, so it
// automatically gets only spawn + terminal-title + process status.
export const AGENT_HOOK_TARGETS = ['claude', 'codex', 'gemini', 'opencode', 'grok'] as const
export const RESUMABLE_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'grok'] as const
// Agents whose session id we MINT at launch (`--session-id <uuid>`) instead of learning it from
// hook events. Claude only: it is the one CLI here that accepts a caller-chosen id.
//
// Why it matters: everything that resumes a conversation — cold restore after a reboot, the
// session reaper's recovery path, the ⌘M transcript view — needs the id, and the id used to
// arrive ONLY over the hook channel (agent fires a hook → POST → renderer stores it in
// localStorage). For an SSH node that POST rides the reverse tunnel, so a node whose tunnel was
// down, or that simply never ran a tool, never had an id at all. Measured on one host after a
// reboot: 18 of 40 agent nodes relaunched as BLANK conversations because there was nothing to
// resume with, while their transcripts sat intact on disk.
//
// Minting fixes the floor, not the whole problem: `/clear`, `--fork-session` and compaction all
// mint a NEW id inside the CLI (claude's SessionStart hook reports these as source
// clear/fork/compact), so hooks remain the only way to TRACK an id after launch. What minting
// guarantees is that a node always has SOME resumable id, so the worst case degrades from "the
// conversation is gone" to "continuity since the last /clear is gone".
export const SESSION_ID_CAPABLE = ['claude'] as const
export const SUBAGENT_CAPABLE = ['claude'] as const
export const RECURRING_CAPABLE = ['claude'] as const // /loop, /schedule, /cron
export const BRANCH_CAPABLE = ['claude'] as const
export const CONTEXT_LINK_CAPABLE = ['claude', 'codex', 'gemini', 'opencode'] as const
// Agents whose per-node context meter we can fill. Each needs BOTH numbers: a used count and a
// TRUSTWORTHY window.
//  - claude: used from its transcript's assistant usage, window INFERRED from the model family
//    (core/model-window.ts).
//  - codex: states its own denominator — `model_context_window`, right beside the usage in its
//    rollout (core/codex-session.ts).
//  - gemini: states none, so the window comes from its model id through `geminiWindowFor`, which
//    mirrors the CLI's OWN `tokenLimit(model)` — a family rule with a 1M catch-all default, so a
//    model we have never heard of still gets the right answer rather than a stale guess.
// grok is absent: its `updates.jsonl` parser is unbuilt (see docs/grok-agent.md), so there is no
// used count to divide.
export const USAGE_CAPABLE = ['claude', 'codex', 'gemini'] as const
// Agents whose structured transcript we can render as a chat panel (Cmd+M chat mode).
export const CHAT_CAPABLE = ['claude'] as const
// Agents whose native transcript we can read + render for cross-agent transfer.
export const TRANSFER_SOURCE_CAPABLE = ['claude', 'codex', 'gemini'] as const
// Agents that accept a node title being PUSHED back into the session — the write leg only. The
// write is the same literal `/rename <name>` for both, which grok also accepts as `/title`.
// The READ leg is TITLE_READ_CAPABLE below, which is a superset: an agent can name its own session
// without offering any way to rename it (gemini). Read legs are per-agent (claude: the transcript
// .jsonl; grok: its session summary.json; gemini: its update_topic tool call), routed once in
// core/agent-session-name.ts.
export const RENAME_CAPABLE = ['claude', 'grok'] as const
// Agents whose OWN session name we can READ and adopt into the node title.
//
// Separate from RENAME_CAPABLE because the two directions are separate facts, and gemini has only
// this one: it writes a model-generated name into its transcript (the `update_topic` tool's
// `args.title` — core/gemini-session.ts) but has no command to SET one. Its session commands are
// `/chat list|save|resume|delete|share` (measured on 0.54.4), where `save <tag>` is a tagged
// checkpoint, not a title — so one list for both legs would light the rename UI on a node where
// the write silently does nothing.
//
// INVARIANT (pinned in config.capabilities.test.ts): every RENAME_CAPABLE agent is also here. The
// write leg pushes a name and the read leg is what confirms it settled.
//
// codex joined the READ leg only, and for the same reason gemini did: with the shared app-server
// (SHARED_IDENTITY_CAPABLE below) a node owns a THREAD, and that thread carries a `Thread.name` we
// can read over the server's own socket (core/codex-session-name.ts). There is still no measured
// rename command, so it stays out of RENAME_CAPABLE — the read⊇write invariant holds either way.
export const TITLE_READ_CAPABLE = ['claude', 'codex', 'grok', 'gemini'] as const
// Agents whose canvas nodes share ONE managed CLI server per machine and keep a stable per-node
// identity inside it, instead of each node owning a whole process tree.
//
// Membership is what makes `buildPtyEnv` mint the per-node capability token, what makes
// `pty-manager` install + PATH-expose the generated launcher, and what lets a launch line address
// that launcher at all. Everything downstream asks `hasSharedIdentity(agentId)`; nothing may ask
// `agentId === 'codex'`, which is how this started and is what CLAUDE.md forbids.
//
// Only codex today: it is the only builtin with an app-server mode NodeTerm can attach many
// clients to. A second agent joins by being added here and writing its own launcher body.
export const SHARED_IDENTITY_CAPABLE = ['codex'] as const
// Agents allowed to drive the canvas via the `nodeterm` CLI (open/show/write/close).
// Discovery differs per agent: claude gets the manage-nodeterm-canvas skill; codex/gemini/
// opencode a marker block in ~/.codex/AGENTS.md / ~/.gemini/GEMINI.md /
// ~/.config/opencode/AGENTS.md (see canvas-control.ts).
//
// grok needs NO new installer: it scans `~/.claude/skills` by default for Claude Code
// compatibility (its shipped docs, user-guide/08-skills.md; switched off only by
// `[compat.claude] skills = false` or GROK_CLAUDE_SKILLS_ENABLED=false), and that is exactly
// where the manage-nodeterm-canvas skill is already written — locally, and on an SSH host via
// RemoteHooks.installCanvasControl. Membership here is what sets NODETERM_CANVAS_CONTROL in the
// session env (hook-server's buildPtyEnv, remoteHookEnvArgs), i.e. what makes the shim anything
// other than a no-op.
export const CANVAS_CONTROL_CAPABLE = ['claude', 'codex', 'gemini', 'opencode', 'grok'] as const
// Agents whose session start-up permission mode we can set (see AgentPermissionMode below).
// claude and grok share the flag SPELLING and the value vocabulary
// (`--permission-mode auto|plan|acceptEdits|bypassPermissions`; our `manual` = no flag = grok's own
// `default`). gemini (`--approval-mode default|auto_edit|yolo|plan`) and codex
// (`--ask-for-approval untrusted|on-request|never`) each spell it their own way, so membership here
// is only half the story — the translation lives in ./approval-mode.ts.
//
// Membership does NOT mean every mode applies: BOTH new vocabularies are narrower than ours — codex
// has no plan and no edit-specific mode, and gemini has nothing meaning "approve most things but not
// edits", i.e. no `auto`. Those modes emit NO flag rather than a substituted nearest match.
// `modeSupported` is what the UI asks so the user is told, instead of being shown "Plan" while
// codex runs in on-request, or "Auto" while gemini auto-approves every edit. That last one is not
// hypothetical: `auto` is DEFAULT_PERMISSION_MODE, so mapping it to gemini's `auto_edit` would have
// switched auto-approve-edits on for every existing gemini node at upgrade time, silently.
//
// NOTE: the `auto` VERSION GATE is claude's alone — see activePermissionMode in
// renderer/state/permissionMode.ts. grok has accepted every mode we emit since 1.0.0, its first
// release, and gemini/codex accept theirs on the versions we measured, so none of them may inherit
// a gate fed by a `claude --version` probe.
export const PERMISSION_MODE_CAPABLE = ['claude', 'grok', 'gemini', 'codex'] as const
// Agents whose own CLI already tells the user when it copies, so nodeterm must not say it again.
// Claude Code captures the mouse itself and prints its own line — "copied N chars to tmux buffer ·
// paste with prefix + ]" — which makes our copy pill a second message for one gesture. Membership
// switches the WHOLE copy-feedback layer off for that agent's terminals: the receipt and the
// one-time "Hold ⌥ to select text" hint alike, since a drag there is not swallowed at all.
//
// This is a list rather than a `=== 'claude'` for the usual reason: the next CLI to grow its own
// copy notice joins by being added here, and nothing else changes.
export const SELF_REPORTS_COPY = ['claude'] as const

const includes = (list: readonly string[], id: AgentId): boolean => list.includes(id)

export const hasHooks = (id: AgentId): boolean => includes(AGENT_HOOK_TARGETS, id)
export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const mintsSessionId = (id: AgentId): boolean => includes(SESSION_ID_CAPABLE, id)
export const canSubagent = (id: AgentId): boolean => includes(SUBAGENT_CAPABLE, id)
export const canRecur = (id: AgentId): boolean => includes(RECURRING_CAPABLE, id)
export const canBranch = (id: AgentId): boolean => includes(BRANCH_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const canChat = (id: AgentId): boolean => includes(CHAT_CAPABLE, id)
export const canTransferFrom = (id: AgentId): boolean => includes(TRANSFER_SOURCE_CAPABLE, id)
export const canRename = (id: AgentId): boolean => includes(RENAME_CAPABLE, id)
export const canReadTitle = (id: AgentId): boolean => includes(TITLE_READ_CAPABLE, id)
export const canControlCanvas = (id: AgentId): boolean => includes(CANVAS_CONTROL_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => includes(PERMISSION_MODE_CAPABLE, id)
export const hasSharedIdentity = (id: AgentId): boolean => includes(SHARED_IDENTITY_CAPABLE, id)

/**
 * The program a launch line should name for `id`.
 *
 * `sharedIdentity` is the caller's answer to "will the managed launcher actually be there?", and
 * it is FALSE by default on purpose: every call site that has not opted in emits the bare CLI
 * command it always did, byte for byte. This is the same shape as `gatePermissionMode` — an
 * unknown or failed probe degrades to the bare command, never to a launch that cannot run.
 *
 * The launcher is addressed by NAME, not by path: `pty-manager` puts its directory first on the
 * session's PATH for exactly the agents in SHARED_IDENTITY_CAPABLE, so the pane shows a readable
 * command and a plain terminal's PATH is untouched.
 */
export const SHARED_IDENTITY_LAUNCHERS: Partial<Record<AgentId, string>> = { codex: 'nodeterm-codex' }

export function agentLaunchProgram(id: AgentId, base: string, sharedIdentity = false): string {
  if (!sharedIdentity || !hasSharedIdentity(id)) return base
  return SHARED_IDENTITY_LAUNCHERS[id] ?? base
}
/** Does this agent's CLI report its own copies? Undefined (a plain terminal, a custom agent) is
 *  `false` — nobody speaks for those, so nodeterm's own feedback is the only feedback there is. */
export const reportsOwnCopy = (id: AgentId | undefined): boolean =>
  !!id && includes(SELF_REPORTS_COPY, id)

// Returns the builtin config for an id, or undefined for custom/unknown agents.
export const agentConfig = (id: AgentId): AgentConfig | undefined =>
  (AGENT_CONFIG as Record<string, AgentConfig>)[id]

/**
 * The agent a terminal node was CREATED as: `data.agentId`, with the legacy `tags` fallback for
 * nodes serialized before `agentId` existed. Node data is deserialized (hand-editable) JSON, so
 * the shapes are checked at runtime rather than trusted from the type.
 *
 * Deliberately NOT a hook-status fallback (Canvas's wider `agentIdOf`), which also reports a plain
 * terminal someone typed `claude` into by hand.
 *
 * ONE definition on purpose: the canvas menu decides from it whether to OFFER an in-place restart,
 * and the node's restart closure captures it to decide whether to RUN one. Two copies that drift
 * apart silently produce a menu row whose closure refuses every click.
 */
export function createdAgentId(
  data: { agentId?: unknown; tags?: unknown } | undefined
): AgentId | undefined {
  if (!data) return undefined
  if (typeof data.agentId === 'string' && data.agentId) return data.agentId as AgentId
  const tags = Array.isArray(data.tags) ? data.tags : []
  return tags.includes('claude') ? 'claude' : undefined
}

// Session ids are interpolated into a shell command line (written into the live shell on a
// cold restart), so accept only the safe charset agents actually use (UUIDs etc.) — never a
// flag-like or metacharacter-bearing value.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Appends the minted-session-id flag to a FIRST-LAUNCH command, for agents in
 * `SESSION_ID_CAPABLE`. Anything else — another agent, an empty or unsafe id — returns `cmd`
 * unchanged, so a command line that had no business carrying the flag stays byte-identical.
 *
 * First launch ONLY. `claude --session-id <uuid>` refuses an id that already exists ("Session ID
 * … is already in use.", measured against claude 2.1.226), so a relaunch of the same node must
 * resume instead — that is `resumeCommand`'s job, and the two shapes can never be collapsed into
 * one idempotent command.
 *
 * Re-validated against SAFE_SESSION_ID at this interpolation site for the same reason
 * `resumeCommand` is: the value ends up on a tmux `send-keys` line, and the caller's type is a
 * compile-time promise, not a runtime one.
 */
export function withSessionId(cmd: string, id: AgentId, sessionId: string): string {
  if (!mintsSessionId(id)) return cmd
  const sid = sessionId.trim()
  if (!sid || !SAFE_SESSION_ID.test(sid)) return cmd
  return `${cmd} --session-id ${sid}`
}

/**
 * The command that resumes a resumable agent's prior conversation by its provider session id.
 * Used on a cold restart (machine reboot) where the tmux session — and the live agent — are
 * gone, so the conversation must be reconstructed via the agent CLI's own `--resume`.
 * Returns null for non-resumable/custom agents or an unsafe/empty session id.
 *
 * `sharedIdentity` routes a SHARED_IDENTITY_CAPABLE agent's resume through the managed launcher,
 * so the resumed session re-claims the node's own thread instead of opening it as an anonymous
 * client. Default false = the bare command this has always emitted (see `agentLaunchProgram`).
 */
export function resumeCommand(id: AgentId, sessionId: string, sharedIdentity = false): string | null {
  if (!canResume(id)) return null
  const sid = sessionId.trim()
  if (!sid || !SAFE_SESSION_ID.test(sid)) return null
  switch (id) {
    case 'codex':
      return `${agentLaunchProgram('codex', 'codex', sharedIdentity)} resume ${sid}`
    case 'opencode':
      return `opencode --session ${sid}`
    case 'claude':
    case 'gemini':
    case 'grok':
      return `${id} --resume ${sid}`
    default:
      return null
  }
}

/**
 * The permission mode an agent session STARTS in. The user can still cycle modes at runtime
 * with Shift+Tab — this only decides the starting state, which is exactly what the CLI's
 * `--permission-mode` flag does.
 *
 * `dontAsk` is deliberately not exposed: from the user's point of view it overlaps `auto`.
 *
 * VERSION GATE: `auto` is the one value here that older Claude CLIs do NOT accept — see
 * AUTO_PERMISSION_MODE_MIN_VERSION / gatePermissionMode below. Never hand a raw `auto` to a
 * launch command without running it through `gatePermissionMode` first.
 */
export type AgentPermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/**
 * First Claude Code version whose `--permission-mode` accepts `auto`. Earlier CLIs validate the
 * value against their own choices list and EXIT 1:
 *   error: option '--permission-mode <mode>' argument 'auto' is invalid.
 *          Allowed choices are acceptEdits, bypassPermissions, default, dontAsk, plan.
 * Since `auto` is our default, an ungated flag would break every Claude launch on an older CLI.
 * The other four modes are accepted by every CLI we support, so ONLY `auto` is gated.
 *
 * MEASURED, not guessed: 2.1.0 through 2.1.70 reject `auto`; 2.1.71 is the first published
 * version that accepts it (verified by running each published tarball's CLI directly).
 */
export const AUTO_PERMISSION_MODE_MIN_VERSION = '2.1.71'

const MIN_AUTO_VERSION: readonly number[] = AUTO_PERMISSION_MODE_MIN_VERSION.split('.').map(Number)

/**
 * Pure numeric-version gate shared by the Claude CLI capability checks: parse the first
 * `major.minor.patch` out of a `claude --version` line and answer whether it is >= `min`.
 * FAILS OPEN to `false` on anything unreadable — an unknown version is treated as "too old", so
 * every caller degrades to the conservative, pre-feature behavior rather than a failed launch.
 */
function versionAtLeast(versionOutput: string | null | undefined, min: readonly number[]): boolean {
  const m = (versionOutput ?? '').match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true
    if (v[i] < min[i]) return false
  }
  return true // exactly the minimum
}

/**
 * Does this `claude --version` output know `--permission-mode auto`? Pure (the probe that feeds it
 * lives in core/claude-cli.ts). FAILS OPEN to `false` on anything unreadable — an unknown version
 * means we omit the flag and launch the bare command (today's behavior), never a failed launch.
 */
export function supportsAutoPermissionMode(versionOutput: string | null | undefined): boolean {
  return versionAtLeast(versionOutput, MIN_AUTO_VERSION)
}

/**
 * First Claude Code version whose `settings.json` understands `"tui": "fullscreen"` (the setting
 * that makes a session take the alternate screen + mouse, so it behaves natively inside nodeterm's
 * tmux instead of dropping drags into tmux copy-mode). Earlier CLIs don't know the key; writing it
 * for them risks an unknown-setting warning, so the setting is only written when the CLI is known
 * to be at least this version. MEASURED, not guessed.
 */
export const FULLSCREEN_TUI_MIN_VERSION = '2.1.89'

const MIN_FULLSCREEN_TUI_VERSION: readonly number[] = FULLSCREEN_TUI_MIN_VERSION.split('.').map(Number)

/**
 * Does this `claude --version` output understand `"tui": "fullscreen"` in settings.json (>= 2.1.89)?
 * Pure. FAILS OPEN to `false` — an unknown/older version means nodeterm does NOT write the key.
 */
export function supportsFullscreenTui(versionOutput: string | null | undefined): boolean {
  return versionAtLeast(versionOutput, MIN_FULLSCREEN_TUI_VERSION)
}

/**
 * The mode a session can ACTUALLY start in on the CLI that will run it. `auto` degrades to
 * `manual` — which emits no flag at all, i.e. the bare `claude` command nodeterm shipped before
 * this setting existed — when that CLI is too old to know the value (or the probe never
 * answered). Every other mode passes through untouched, so a failed probe can never strip
 * `plan` / `acceptEdits` / `bypassPermissions`.
 *
 * The user's SETTING stays `auto`: only the emitted command line changes, and it changes back
 * the moment they upgrade the CLI.
 */
export function gatePermissionMode(
  mode: AgentPermissionMode,
  autoSupported: boolean
): AgentPermissionMode {
  return mode === 'auto' && !autoSupported ? 'manual' : mode
}

// Declared first: its `Record<AgentPermissionMode, string>` type forces every member of the
// union to be present, which is what makes ALL_PERMISSION_MODES below impossible to desync.
export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  manual: 'Ask each time',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass all'
}

// Derived, never hand-maintained: add a mode to the union and the compiler makes you label it,
// which lands it here (and so in the settings dropdown + isPermissionMode) automatically.
export const ALL_PERMISSION_MODES: readonly AgentPermissionMode[] = Object.keys(
  PERMISSION_MODE_LABELS
) as AgentPermissionMode[]

/** Fallback whenever a persisted mode is missing or unrecognized. */
export const DEFAULT_PERMISSION_MODE: AgentPermissionMode = 'auto'

/** The ONE validator for a persisted mode. Exported so every interpolation site can re-validate
 *  through it (see `permissionModeFlag` below and `approvalFlags` in ./approval-mode) rather than
 *  growing a second copy that drifts from `ALL_PERMISSION_MODES`. */
export const isPermissionMode = (v: unknown): v is AgentPermissionMode =>
  typeof v === 'string' && (ALL_PERMISSION_MODES as readonly string[]).includes(v)

/** CLI flags for a mode. `manual` yields NO flags, so the command stays bare — the exact
 *  command nodeterm shipped before this setting existed.
 *
 *  The mode is re-validated HERE even though the parameter is typed: AgentPermissionMode is
 *  compile-time only, and the value comes from hand-editable, git-shared JSON (settings.json /
 *  project.json) before being interpolated into a shell command line. Same rule as
 *  SAFE_SESSION_ID above — validate at the interpolation site. An unrecognized mode yields the
 *  safe bare command rather than a flag carrying an unvalidated value. */
export function permissionModeFlag(mode: AgentPermissionMode): string[] {
  if (!isPermissionMode(mode) || mode === 'manual') return []
  return ['--permission-mode', mode]
}

// `withPermissionMode` — the single funnel every CLI launch path goes through — lives in
// ./approval-mode.ts, one layer UP: since gemini and codex joined, appending the flag needs the
// per-agent mapping, and that table has to import this file. Re-exporting it from here would close
// the cycle, so the funnel moved to the layer that owns the translation instead.

/**
 * The mode a new session starts in: the project override, else the global setting.
 * Mirrors resolveNewNodeAccount's shape, including its stale-value guard — an unrecognized
 * persisted mode must never reach the CLI as a flag value.
 *
 * Structurally typed (not `Project`/`Settings`) because src/shared/types.ts imports THIS file;
 * importing it back would be a cycle.
 */
export function resolvePermissionMode(
  project: { defaultPermissionMode?: AgentPermissionMode } | undefined,
  settings: { claudePermissionMode: AgentPermissionMode }
): AgentPermissionMode {
  if (isPermissionMode(project?.defaultPermissionMode)) return project.defaultPermissionMode
  if (isPermissionMode(settings.claudePermissionMode)) return settings.claudePermissionMode
  return DEFAULT_PERMISSION_MODE
}
