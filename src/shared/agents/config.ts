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
export const SUBAGENT_CAPABLE = ['claude'] as const
export const RECURRING_CAPABLE = ['claude'] as const // /loop, /schedule, /cron
export const BRANCH_CAPABLE = ['claude'] as const
export const CONTEXT_LINK_CAPABLE = ['claude', 'codex', 'gemini', 'opencode'] as const
export const USAGE_CAPABLE = ['claude'] as const
// Agents whose structured transcript we can render as a chat panel (Cmd+M chat mode).
export const CHAT_CAPABLE = ['claude'] as const
// Agents whose native transcript we can read + render for cross-agent transfer.
export const TRANSFER_SOURCE_CAPABLE = ['claude', 'codex', 'gemini'] as const
// Agents that support naming the session in two directions: they emit a session title we adopt
// into the node title, and accept `/rename <name>` to push a renamed node title back. Read legs are
// per-agent (claude: the transcript .jsonl; grok: its session summary.json — see
// core/grok-session.ts, routed at the readSessionName IPC handler); the write leg is the same
// literal `/rename <name>` for both, which grok also accepts as `/title`.
export const RENAME_CAPABLE = ['claude', 'grok'] as const
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
// `default`), which is the whole requirement for membership. codex (--ask-for-approval) and gemini
// (--approval-mode) join by being added here with their own flag mapping.
//
// NOTE: the `auto` VERSION GATE is claude's alone — see activePermissionMode in
// renderer/state/permissionMode.ts. grok has accepted every mode we emit since 1.0.0, its first
// release, so it must never inherit a gate fed by a `claude --version` probe.
export const PERMISSION_MODE_CAPABLE = ['claude', 'grok'] as const

const includes = (list: readonly string[], id: AgentId): boolean => list.includes(id)

export const hasHooks = (id: AgentId): boolean => includes(AGENT_HOOK_TARGETS, id)
export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const canSubagent = (id: AgentId): boolean => includes(SUBAGENT_CAPABLE, id)
export const canRecur = (id: AgentId): boolean => includes(RECURRING_CAPABLE, id)
export const canBranch = (id: AgentId): boolean => includes(BRANCH_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const canChat = (id: AgentId): boolean => includes(CHAT_CAPABLE, id)
export const canTransferFrom = (id: AgentId): boolean => includes(TRANSFER_SOURCE_CAPABLE, id)
export const canRename = (id: AgentId): boolean => includes(RENAME_CAPABLE, id)
export const canControlCanvas = (id: AgentId): boolean => includes(CANVAS_CONTROL_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => includes(PERMISSION_MODE_CAPABLE, id)

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
 * The command that resumes a resumable agent's prior conversation by its provider session id.
 * Used on a cold restart (machine reboot) where the tmux session — and the live agent — are
 * gone, so the conversation must be reconstructed via the agent CLI's own `--resume`.
 * Returns null for non-resumable/custom agents or an unsafe/empty session id.
 */
export function resumeCommand(id: AgentId, sessionId: string): string | null {
  if (!canResume(id)) return null
  const sid = sessionId.trim()
  if (!sid || !SAFE_SESSION_ID.test(sid)) return null
  switch (id) {
    case 'codex':
      return `codex resume ${sid}`
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

const isPermissionMode = (v: unknown): v is AgentPermissionMode =>
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

/** Appends the permission-mode flag to a launch command, if the agent supports one. The single
 *  funnel for every CLI launch path (new node, cold-restore resume, branch). */
export function withPermissionMode(cmd: string, id: AgentId, mode: AgentPermissionMode): string {
  if (!hasPermissionMode(id)) return cmd
  const flags = permissionModeFlag(mode)
  return flags.length ? `${cmd} ${flags.join(' ')}` : cmd
}

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
