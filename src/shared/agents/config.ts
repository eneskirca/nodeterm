// Single source of truth for agent launch behavior and capabilities.
// Design: an open AgentId string, a declarative config record, and
// capabilities expressed as const membership lists (not a capability object).

export type BuiltinAgentId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'grok' | 'copilot' | 'devin'
// Open type — custom agents are any string ('custom:<uuid>'). Never restrict the set.
export type AgentId = BuiltinAgentId | (string & {})

export type PromptInjectionMode =
  | 'argv'
  | 'flag-prompt'
  | 'flag-interactive'
  | 'stdin-after-start'

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
  /**
   * Milliseconds to wait after writing text into this CLI's composer before sending the Enter that
   * submits it. Omitted (the default) means the historical delivery: text and Enter in ONE tmux
   * invocation, byte-identical for every agent that does not set this.
   *
   * devin is the case that needs it, and it needs it because of its own INPUT DEBOUNCE, not
   * because of how we write. MEASURED on 3000.6.12, idle session, every delivery mechanism tmux
   * offers:
   *
   *   bracketed paste (`paste-buffer -p`, our path) + immediate Enter  → text sits in the composer
   *   UNFRAMED paste                                + immediate Enter  → text sits in the composer
   *   `send-keys -l` literal                        + immediate Enter  → text sits in the composer
   *   any of the three, Enter >= ~80 ms later                          → SUBMITTED
   *
   * So devin absorbs a CR that arrives within roughly 50-80 ms of preceding input (the threshold
   * measured between those two values) — a paste-safety heuristic, applied to the burst rather
   * than to the paste markers. The identical delivery into claude submits immediately, which is
   * why this is a per-agent number and not a change to the delivery itself.
   *
   * This is the exception the `localFramedDelivery` tombstone in core/tmux-naming.ts does not
   * cover: it reasons that an Enter after the paste-close marker "a paste-aware composer cannot
   * re-chunk into the paste". True for claude; devin re-chunks on TIMING, marker or no marker.
   */
  submitEnterDelayMs?: number
  expectedProcess: string
}

export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'copilot',
  'devin'
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
    // opencode's TUI batches input the same way devin's does: measured on 1.18.18-1.18.25 (Linux,
    // tmux, isolated socket), a one-burst `/exit\r` leaves `/exit` in the composer and times out at
    // 6 s, while splitting the CR off by 100 ms exits in ~500 ms. This number used to live as a
    // hardcoded `agentId === 'opencode'` branch in renderer/terminal/agent-restart.ts, which meant
    // only the RESTART path knew about it — devin arriving with the same behaviour is what showed
    // that it is a property of the agent, not of one call site.
    submitEnterDelayMs: 150,
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
  },
  copilot: {
    label: 'GitHub Copilot',
    color: '#8957e5',
    launchCmd: 'copilot',
    // `--prompt` is explicitly non-interactive and exits after one response. The installed
    // 1.0.80 CLI's `--interactive <prompt>` starts the ordinary TUI and submits the prompt there.
    promptInjectionMode: 'flag-interactive',
    expectedProcess: 'copilot'
  },
  devin: {
    label: 'Devin',
    color: '#3969CA',
    launchCmd: 'devin',
    // Measured on devin 3000.4.25: usage is `devin [OPTIONS] [-- <PROMPT>...] [COMMAND]`,
    // so the prompt is a positional after `--`. Without the separator a prompt like `list`,
    // `auth`, `models`, `update` or `setup` is executed as a subcommand and never reaches the model.
    promptInjectionMode: 'argv',
    argvPromptSeparator: '--',
    // 150 ms, comfortably past the measured 50-80 ms swallow window — see `submitEnterDelayMs`.
    // The cost is one extra tmux round trip on writes INTO a devin composer; nothing else pays it.
    submitEnterDelayMs: 150,
    expectedProcess: 'devin'
  }
}

// Capabilities = const builtin membership lists. A custom agent resolves through its declared
// base harness (capabilityAgentId); one with no base automatically gets only spawn + terminal-title
// + process status.
export const AGENT_HOOK_TARGETS = ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot', 'devin'] as const
export const RESUMABLE_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot', 'devin'] as const
// Agents whose session id we MINT at launch (`--session-id <uuid>`) instead of learning it only
// from hook events. Each member must have a measured caller-chosen-id grammar below.
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
export const SESSION_ID_CAPABLE = ['claude', 'copilot', 'grok'] as const
// Claude's flag is version-gated and comes from the Claude CLI probe. Copilot's installed 1.0.80
// binary and current official reference accept `--session-id=<uuid>`, so it does not borrow an
// unrelated Claude probe result. Custom agents resolve through their declared base harness.
//
// grok is gated too, but on ITS OWN probe (`core/grok-cli.ts` reads `grok --help`) — never on
// claude's. The two CLIs are installed and upgraded independently, so claude's answer is not even
// correlated with grok's, and a gate fed by the wrong agent's probe is a guess wearing a
// measurement's clothes. Its grammar also differs from claude's in three measured ways (1.0.13):
// the UUID must not already exist under the target session directory, so minting one twice is a
// LAUNCH ERROR and never a resume; `--session-id` combines with `--resume`/`--continue` only
// alongside `--fork-session`; and `--resume` accepts a TITLE as well as an id, failing as ambiguous
// on duplicates — which is why nothing in this codebase resumes grok by title.
export const UNCONDITIONAL_SESSION_ID_CAPABLE = ['copilot'] as const
// claude: Task/Agent tool via hooks (tool_use_id-keyed). codex: spawn_agent collaboration via its
// native SubagentStart/SubagentStop hooks (agent_id-keyed), measured on codex-cli 0.146.0.
export const SUBAGENT_CAPABLE = ['claude', 'codex'] as const
export const RECURRING_CAPABLE = ['claude'] as const // /loop, /schedule, /cron
export const BRANCH_CAPABLE = ['claude'] as const
// grok joins with NO installer of its own: it scans `~/.claude/skills` for Claude Code
// compatibility, which is exactly where `get-linked-context` is already written — the same
// argument `CANVAS_CONTROL_CAPABLE` makes below. That premise used to be marked unverified;
// MEASURED on 1.0.13 (2026-09-01): `grok inspect --json` lists the skill with
// `vendor: 'claude', compatibilityStatus: 'enabled'`, and `externalCompat.cells` reports
// `{surface:'skills', enabled:true, source:'default'}`.
// Two user settings can switch that off — `[compat.claude] skills = false` in
// `~/.grok/config.toml`, and `GROK_CLAUDE_SKILLS_ENABLED=false`. Then the skill is undiscoverable
// however this list reads, and the same `inspect` cell is what says so (`enabled:false`, a
// non-default `source`) rather than leaving support to guess.
export const CONTEXT_LINK_CAPABLE = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'devin'
] as const
// Agents whose per-node context meter we can fill. Each needs BOTH numbers: a used count and a
// TRUSTWORTHY window.
//  - claude: used from its transcript's assistant usage, window INFERRED from the model family
//    (core/model-window.ts).
//  - codex: states its own denominator — `model_context_window`, right beside the usage in its
//    rollout (core/codex-session.ts).
//  - gemini: states none, so the window comes from its model id through `geminiWindowFor`, which
//    mirrors the CLI's OWN `tokenLimit(model)` — a family rule with a 1M catch-all default, so a
//    model we have never heard of still gets the right answer rather than a stale guess.
//  - grok: states BOTH numbers and the answer. `contextTokensUsed` and `contextWindowTokens` sit in
//    `~/.grok/sessions/<cwd>/<id>/signals.json`, alongside `contextWindowUsage` — the percentage
//    grok has already computed. MEASURED on 22 real sessions (1.0.13, 2026-09-02): all three present
//    in all 22, and the stated percentage agrees with used/window in all 22. So the window is read,
//    never inferred from the model id, which puts grok with codex rather than with gemini.
//
// Until 2026-09 this comment explained grok's absence by pointing at a missing parser for the wrong
// file, and concluding there was no used count to divide. Both halves were false, and the first is
// the one worth remembering: the counters never lived in the file it named, so the blocker it
// declared was not the real blocker even on the day it was written. A comment that explains an
// absence with a false cause is worse than no comment — it sends the next reader to build a parser
// nobody needed. What let it survive is that nobody could check it: the integration was written with
// no grok binary on the machine.
//
// signals.json is a METRICS file (66 keys: latencies, GCS queue counters, lines touched, peak RSS).
// `core/grok-signals.ts` reads exactly three of them and nothing else. If a future grok drops
// `contextWindowTokens`, that reader returns null and the meter disappears — no inferred
// denominator, because a percentage over a guessed window is a wrong number presented as a fact.
export const USAGE_CAPABLE = ['claude', 'codex', 'gemini', 'grok'] as const
// Agents whose structured transcript we can render as a chat panel (Cmd+M chat mode).
//
// SPLIT from CLAUDE_TRANSCRIPT_READABLE below on 2026-09-02, when grok joined. Until then this one
// list carried TWO facts that happened to coincide while claude was its only member: "we can render
// this agent's conversation ourselves" and "CLAUDE's transcript resolver can locate and parse this
// agent's file". Grok satisfies the first (`linesFromGrok`, core/context-link-render.ts) and NOT the
// second, and merging them is not a cosmetic error: `resolveTranscript` (core/transcript-ipc.ts:58)
// falls back to `transcriptPathForCwd` when the sessionId leg misses — which it ALWAYS does for a
// non-claude id, since no `<that id>.jsonl` exists under `~/.claude/projects` — and hands back the
// newest CLAUDE transcript for that cwd. A grok node in this list would therefore show a stranger's
// conversation in its find bar and rehydrate its meter from it. That exact bug already happened once
// with codex and gemini; transcriptGates.ts documents it.
export const CHAT_CAPABLE = ['claude', 'grok'] as const
// Agents whose transcript CLAUDE's own resolver can locate and parse — the gate for everything that
// goes through `resolveTranscript` (the find bar's index, the meter's mount-time rehydration).
//
// This is deliberately NOT a superset of CHAT_CAPABLE and must not be "simplified" back into it: the
// question here is not "can we read this agent" but "does this agent's conversation live in a file
// shaped like claude's, under claude's tree". Only claude answers yes, and the failure mode of a
// wrong answer is a read of SOMEONE ELSE'S session (see the comment above), which fails OPEN — it
// shows data rather than hiding it. `config.capabilities.test.ts` pins that grok is absent.
export const CLAUDE_TRANSCRIPT_READABLE = ['claude'] as const
// Agents whose native transcript we can read + render for cross-agent transfer.
export const TRANSFER_SOURCE_CAPABLE = ['claude', 'codex', 'gemini', 'grok'] as const
// Agents whose hooks announce that a session ENDED — i.e. whose orderly `/exit` we will hear about.
//
// Derived by reading `normalize.ts`, not by intent: exactly four normalizers map an event to
// `sessionPhase: 'end'` (claude `SessionEnd`, gemini `SessionEnd`, copilot `SessionEnd`, grok
// `sessionend`). `normalizeCodex` and `normalizeOpencode` map none, which is why they are absent
// here — and their absence is load-bearing, not an oversight to tidy up later.
//
// What it gates today is the DROPPED chip (`terminal/agent-liveness.ts`): "the pane went back to a
// shell but nobody told us the session ended" is only evidence of a CRASH for an agent that WOULD
// have told us. On codex and opencode a deliberate `/quit` and an OOM kill leave byte-identical
// evidence, so a chip there could only be a coin flip shown as a fact.
//
// Before adding an id: find its normalizer's `sessionPhase: 'end'` branch. If there isn't one, the
// branch is the change — this list is a consequence of it, never a substitute for it.
export const SESSION_END_CAPABLE = ['claude', 'gemini', 'copilot', 'grok'] as const
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
export const CANVAS_CONTROL_CAPABLE = ['claude', 'codex', 'gemini', 'opencode', 'grok', 'copilot', 'devin'] as const
// Agents whose session start-up permission mode we can set (see AgentPermissionMode below).
// claude and grok share the flag SPELLING and the value vocabulary
// (`--permission-mode auto|plan|acceptEdits|bypassPermissions`; our `manual` = no flag = grok's own
// `default`). gemini (`--approval-mode default|auto_edit|yolo|plan`) and codex
// (`--ask-for-approval untrusted|on-request|never`) each spell it their own way, so membership here
// is only half the story — the translation lives in ./approval-mode.ts.
//
// Membership does NOT mean every mode applies: BOTH new vocabularies are narrower than ours — codex
// has no plan and no edit-specific mode, and gemini has nothing meaning what claude's `auto` means,
// i.e. no `auto`. Those modes emit NO flag rather than a substituted nearest match.
//
// What claude's `auto` actually promises, from Claude Code's own mode help, is "Claude decides what
// is safe" — a MODEL judging each action, recommended there "for long unattended tasks". An earlier
// version of this comment described it as "approve most things but not edits", which is a different
// (and narrower) claim; the gemini conclusion below is unaffected — `auto_edit` is a blanket
// auto-approval of edits, not a judgement — but the imprecision cost real behaviour once. It is why
// devin was first mapped `auto → auto` on a name match, selecting devin's OWN default (an alias for
// `normal`, which judges nothing) instead of `smart`, the mode that actually delegates the decision
// to a model. Match the SEMANTIC, never the spelling; see DEVIN_MODES in ./approval-mode.
// `modeSupported` is what the UI asks so the user is told, instead of being shown "Plan" while
// codex runs in on-request, or "Auto" while gemini auto-approves every edit. That last one is not
// hypothetical: `auto` is DEFAULT_PERMISSION_MODE, so mapping it to gemini's `auto_edit` would have
// switched auto-approve-edits on for every existing gemini node at upgrade time, silently.
//
// NOTE: the `auto` VERSION GATE is claude's alone — see activePermissionMode in
// renderer/state/permissionMode.ts. grok has accepted every mode we emit since 1.0.0, its first
// release, and gemini/codex accept theirs on the versions we measured, so none of them may inherit
// a gate fed by a `claude --version` probe.
export const PERMISSION_MODE_CAPABLE = ['claude', 'grok', 'gemini', 'codex', 'devin'] as const
// Agents whose permission hook can honour a deterministic wait + decision JSON reply (issue #409).
// This is a SUBSET of PERMISSION_MODE_CAPABLE: devin accepts --permission-mode but its hook is
// NOT known to honour our decision output, so the env var is claude-only until that is measured.
//
// Membership is resolved through `capabilityAgentId` like every other capability, and that is
// DELIBERATE rather than incidental: `pty-manager` previously compared the raw id against
// 'claude', so a custom agent declaring `baseAgent: 'claude'` — which runs claude's binary and
// therefore claude's hook script, and can honour the decision reply — was silently denied
// NODETERM_PERM_WAIT_SECS. A custom agent based on devin (or on nothing) still gets nothing,
// which is the narrowing this list exists for. Pinned in config.capabilities.test.ts.
export const PERM_WAIT_CAPABLE = ['claude'] as const
// Agents whose harness accepts a per-launch model override and whose gateway protocol we know how
// to configure. Custom agents inherit this through `capabilityAgentId`, like every other harness
// capability — the renderer never maintains its own Claude/Codex/Copilot allowlist.
// Devin is NOT here: its --model flag takes Devin-native slugs (swe-1-7, etc.) and the CLI has no
// documented gateway base-url / api-key env. Routing a gateway model id into `devin --model` would
// rewrite the launch line while the backend stayed on Devin's own servers.
export const MODEL_SWITCH_CAPABLE = ['claude', 'codex', 'copilot'] as const
// Agents whose own CLI already tells the user when it copies, so nodeterm must not say it again.
// Claude Code captures the mouse itself and prints its own line — "copied N chars to tmux buffer ·
// paste with prefix + ]" — which makes our copy pill a second message for one gesture. Membership
// switches the WHOLE copy-feedback layer off for that agent's terminals: the receipt and the
// one-time "Hold ⌥ to select text" hint alike, since a drag there is not swallowed at all.
//
// This is a list rather than a `=== 'claude'` for the usual reason: the next CLI to grow its own
// copy notice joins by being added here, and nothing else changes.
export const SELF_REPORTS_COPY = ['claude'] as const

/** Fallback color for custom / unknown agents that have no config-provided color. */
export const FALLBACK_AGENT_COLOR = '#888888'

// ---------------------------------------------------------------------------------------------
// Custom-agent harness inheritance.
//
// A custom agent (`CustomAgent`, id `'custom:<uuid>'`) may declare a `baseAgent` — one of the
// builtins — to inherit that harness's CAPABILITIES (hooks, resume, permission modes, canvas
// control, session-id minting) and prompt convention. The use case is a harness-compatible CLI
// (e.g. a claude wrapper pointed at your own inference proxy) where you want to KEEP nodeterm's
// integration while redirecting the calls.
//
// The capability predicates below take only an `AgentId`. `src/shared/agents/config.ts` cannot
// import the settings store (renderer) or `settings-store` (core) without a cycle / platform
// split, so the custom-id → baseAgent lookup is INJECTED: each runtime registers a resolver at
// init that reads its own live settings. This mirrors the existing mutable-accessor idiom
// (`claudeCliCapsNow`, `shellPathNow`): module-level state, set once at boot, read on every call.
//
// Tests register a resolver (or null) via `setCustomAgentBaseResolverForTests`.
type BaseResolver = (id: AgentId) => BuiltinAgentId | undefined
let customBaseResolver: BaseResolver | null = null

/** Register the custom-id → baseAgent resolver. Called once at app init by the renderer
 *  (`state/agent-resolver.ts`) and by main/core (`pty-manager`) and the server shell, each
 *  reading its own settings store. Pass `null` to clear (tests). */
export function setCustomAgentBaseResolver(fn: BaseResolver | null): void {
  customBaseResolver = fn
}

/** The builtin harness a custom agent inherits from, or `undefined` for builtins and vanilla
 *  (no-`baseAgent`) custom agents. Builtins never resolve through the registry — they ARE the
 *  harness — so a custom agent whose id accidentally collides with a builtin name still resolves
 *  as the builtin, never as itself. */
export function baseAgentOf(id: AgentId): BuiltinAgentId | undefined {
  if (!customBaseResolver) return undefined
  if ((AGENT_CONFIG as Record<string, AgentConfig>)[id]) return undefined
  return customBaseResolver(id)
}

/** The id whose capabilities apply to `id`: the base harness for an inheriting custom agent, else
 *  `id` itself. This is what every capability predicate resolves through, so inheritance is
 *  automatic everywhere a predicate is called — no per-call-site plumbing. */
export function capabilityAgentId(id: AgentId): AgentId {
  return baseAgentOf(id) ?? id
}

const includes = (list: readonly string[], id: AgentId): boolean =>
  list.includes(capabilityAgentId(id))

export const hasHooks = (id: AgentId): boolean => includes(AGENT_HOOK_TARGETS, id)
export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const mintsSessionId = (id: AgentId): boolean => includes(SESSION_ID_CAPABLE, id)
/** Is the caller-chosen session-id flag available for this effective base harness? */
export const supportsSessionIdFlag = (
  id: AgentId,
  claudeFlagSupported: boolean,
  // REQUIRED, not defaulted. A default here would let a caller forget grok's probe and silently get
  // "grok never mints" — a feature quietly missing, with a green typecheck and no test to notice.
  // That is the same shape as the optional prop that let the chat panel's agent id be dropped; the
  // lesson taken from it is that the fix for this family is a type that cannot express the broken
  // state, not another test somebody has to remember to write.
  grokFlagSupported: boolean
): boolean => {
  if (includes(UNCONDITIONAL_SESSION_ID_CAPABLE, id)) return true
  if (!mintsSessionId(id)) return false
  const base = capabilityAgentId(id)
  // Each probed agent answers with ITS OWN probe. A missing third argument reads as "grok was not
  // probed", which yields a bare command — the safe direction, and the same one an unprobed claude
  // gets.
  if (base === 'grok') return grokFlagSupported
  return base === 'claude' && claudeFlagSupported
}
export const canSubagent = (id: AgentId): boolean => includes(SUBAGENT_CAPABLE, id)
export const canRecur = (id: AgentId): boolean => includes(RECURRING_CAPABLE, id)
export const canBranch = (id: AgentId): boolean => includes(BRANCH_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const canChat = (id: AgentId): boolean => includes(CHAT_CAPABLE, id)
/** Can CLAUDE's transcript resolver locate and parse this agent's conversation? Never widen this
 *  to mean "can we read this agent" — see CLAUDE_TRANSCRIPT_READABLE. */
export const readsClaudeShapedTranscript = (id: AgentId): boolean =>
  includes(CLAUDE_TRANSCRIPT_READABLE, id)
export const canTransferFrom = (id: AgentId): boolean => includes(TRANSFER_SOURCE_CAPABLE, id)
/** Will this agent's hooks tell us when its session ends? See SESSION_END_CAPABLE — the honest
 *  answer for codex and opencode is no, and callers must degrade rather than assume a crash. */
export const reportsSessionEnd = (id: AgentId): boolean => includes(SESSION_END_CAPABLE, id)
export const canRename = (id: AgentId): boolean => includes(RENAME_CAPABLE, id)
export const canReadTitle = (id: AgentId): boolean => includes(TITLE_READ_CAPABLE, id)
export const canControlCanvas = (id: AgentId): boolean => includes(CANVAS_CONTROL_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => includes(PERMISSION_MODE_CAPABLE, id)
/** True only for agents whose permission hook is known to honour our deterministic wait + decision. */
export const hasPermWait = (id: AgentId): boolean => includes(PERM_WAIT_CAPABLE, id)
export const canSwitchModel = (id: AgentId): boolean => includes(MODEL_SWITCH_CAPABLE, id)

/**
 * How long to wait between writing text into this agent's composer and sending the Enter that
 * submits it. `0` = the historical single-invocation delivery, which is what every agent but devin
 * answers.
 *
 * Resolved through `capabilityAgentId` like every other per-agent fact, so a custom agent
 * declaring `baseAgent: 'devin'` runs the devin CLI and inherits its debounce. A plain terminal
 * (no agent id) and a baseless custom agent answer 0 — a shell has no composer to debounce.
 */
export function submitEnterDelayMs(id: AgentId | undefined): number {
  if (!id) return 0
  const cfg = (AGENT_CONFIG as Record<string, AgentConfig>)[capabilityAgentId(id)]
  return cfg?.submitEnterDelayMs ?? 0
}
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
  return capabilityAgentId(id) === 'copilot'
    ? `${cmd} --session-id=${sid}`
    : `${cmd} --session-id ${sid}`
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
 *
 * `base` is the user's launch-command override for this agent (`settings.agentLaunchCommands`,
 * e.g. an account-switching wrapper), PASSED IN rather than read here: this module is imported by
 * main/core/server and cannot reach the renderer's settings store, so the renderer resolves the
 * override and threads it through — the same shape as `performRestartResume`'s `command` param.
 * When set (non-blank) it replaces the program part outright, INCLUDING codex's shared-identity
 * launcher: an explicit override is the user saying "launch it exactly like this", and silently
 * substituting the managed launcher would un-say it. Blank/absent = unchanged behavior.
 */
export function resumeCommand(
  id: AgentId,
  sessionId: string,
  sharedIdentity = false,
  base?: string
): string | null {
  const builtin = agentConfig(id)
  // A builtin resumes with its own command; a custom agent has no resume grammar here (its
  // baseAgent-aware path is `resumeCommandWith`, called by the shared launcher).
  if (!builtin) return null
  // A per-builtin launch-command override (Settings → Agents → Launch commands, threaded here as
  // `base`) replaces the program outright, INCLUDING codex's shared-identity launcher: an explicit
  // override is the user saying "launch it exactly like this". Blank/absent → route a
  // SHARED_IDENTITY_CAPABLE builtin (codex) through its managed launcher when present, else the
  // bare command this has always emitted.
  const custom = base?.trim() || undefined
  const program = custom ?? agentLaunchProgram(id, builtin.launchCmd, sharedIdentity)
  return resumeCommandWith(program, id, sessionId)
}

/**
 * Is `sessionId` one this app would put on a `--resume` command line for `id`? The eligibility GATE
 * the restart/hibernation choreography uses — WITHOUT building the command (which for a custom agent
 * needs its `launchCmd` from settings, unavailable here). Inheritance-aware via `canResume`, so a
 * claude-base custom agent is resumable; the SAFE_SESSION_ID check is the same one `resumeCommand`
 * applies. Pure companion to `resumeCommand` for the gate-only call sites.
 */
export function canResumeWith(id: AgentId, sessionId: string): boolean {
  if (!canResume(id)) return false
  const sid = sessionId.trim()
  return !!sid && SAFE_SESSION_ID.test(sid)
}

/**
 * Resume by provider session id, using `launchCmd` as the binary and `grammarId` to pick the
 * resume flag grammar (`--resume` vs `resume` vs `--session`). `grammarId` is the BASE harness
 * for an inheriting custom agent (`capabilityAgentId(agentId)`), so a claude-base custom agent
 * resumes as `<customLaunchCmd> --resume <sid>` — its own binary, claude's flag. Returns null for
 * a non-resumable base or an unsafe/empty session id.
 */
export function resumeCommandWith(
  launchCmd: string,
  grammarId: AgentId,
  sessionId: string
): string | null {
  if (!canResume(grammarId)) return null
  const sid = sessionId.trim()
  if (!sid || !SAFE_SESSION_ID.test(sid)) return null
  switch (grammarId) {
    case 'codex':
      return `${launchCmd} resume ${sid}`
    case 'opencode':
      return `${launchCmd} --session ${sid}`
    case 'copilot':
      return `${launchCmd} --resume=${sid}`
    case 'claude':
    case 'gemini':
    case 'grok':
    case 'devin':
      return `${launchCmd} --resume ${sid}`
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
