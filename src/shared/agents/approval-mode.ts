// Per-agent translation of nodeterm's permission mode into the agent's own approval flag.
//
// claude and grok share one spelling and one vocabulary, which is why they needed no mapping at all
// until now. gemini and codex each have their own, and BOTH are narrower than ours — which is the
// interesting case: our five modes fit neither `default|auto_edit|yolo|plan` nor
// `untrusted|on-request|never`, so a mode the CLI cannot express emits NO flag (its own default)
// rather than a nearest match. A silent substitution would show the user "Plan" while codex ran in
// on-request, or "Auto" while gemini auto-approved every file edit.
//
// Measured: `gemini --help` (0.54.4) and `codex --help` (0.146.0 … 0.154.0). `--sandbox` is
// deliberately not touched: it is a separate axis (read-only | workspace-write |
// danger-full-access), and folding `danger-full-access` into `bypassPermissions` would widen
// filesystem access invisibly — `--ask-for-approval never` on its own still sandboxes.
//
// AND ONE AGENT'S VOCABULARY IS NOT A CONSTANT. codex accepted `untrusted|on-request|never`
// through 0.148.0 and accepts `on-request|never` from 0.149.0 on — measured release by release,
// see `CODEX_APPROVAL_BASELINE`. clap does not ignore a value it does not know, it EXITS, so a
// table pinned to one release is not a stale mapping, it is a dead node. Every value this module
// emits is therefore checked against what the CLI that will actually run the session says it
// takes (`ApprovalCaps`), and a value we have not seen it advertise is never emitted.
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_CAPABLE,
  PERMISSION_MODE_LABELS,
  hasPermissionMode,
  isPermissionMode,
  permissionModeFlag,
  type AgentId,
  type AgentPermissionMode,
  type BuiltinAgentId
} from './config'
import { argvHasFlag } from '../shell-quote'

/**
 * What we know about the CLI that will actually RUN this session — the facts that decide whether a
 * value in the tables below may be emitted at all.
 *
 * Optional and empty-by-default ON PURPOSE. A caller that passes nothing gets the baseline
 * vocabulary, which is the safe answer everywhere: the launch keeps working, at worst one mode
 * degrades to the CLI's own default (and the derived UI copy says so). A caller that forgets to
 * pass its probe result therefore costs a mode, never a dead pane — which is the only degrade
 * direction this file accepts.
 */
export interface ApprovalCaps {
  /** The values this machine's (or this host's) `codex` advertises for `--ask-for-approval`, read
   *  from its own `--help` — see `core/codex-cli.ts`. `null`/absent = not probed, not probeable
   *  (a remote host, a relay tab), or the probe failed. */
  codexApprovalValues?: readonly string[] | null
  /** Does the `codex` that will RUN this session accept `--no-daemon`? Read by
   *  `withCodexNoDaemon` (`./codex-daemon`), not by anything in this file: the caps bag is simply
   *  what every launch site already threads to the two command assemblers. Anything but a literal
   *  `true` (a remote host, a relay tab, an unprobed or older CLI) emits nothing. */
  codexNoDaemon?: boolean | null
}

/**
 * The `--ask-for-approval` values EVERY codex we have measured accepts, and therefore the answer
 * when we do not know which codex will run.
 *
 * Measured one release at a time on real binaries (`@openai/codex@<v>-linux-x64`, `--help`):
 * 0.146.0 · 0.147.0 · 0.148.0 advertise `untrusted, on-request, never`; 0.149.0 · 0.150.0 ·
 * 0.151.0 · 0.152.0 · 0.153.0 · 0.154.0 advertise `on-request, never`. So `untrusted` was removed
 * in **0.149.0** — five releases before the one issue #785 reported it from — and `on-request` /
 * `never` are common to every one of them.
 *
 * `untrusted` is deliberately NOT in the baseline. An unknown value does not degrade: clap answers
 *
 *   error: invalid value 'untrusted' for '--ask-for-approval <APPROVAL_POLICY>'
 *
 * and exits, so the pane is left at a bare shell with the launch dead (issue #785). A value we
 * have not SEEN this CLI advertise is never emitted; the two we have seen on every measured
 * release are what an unprobed launch falls back to, because that is the command line nodeterm has
 * always sent for those modes.
 */
const CODEX_APPROVAL_BASELINE: readonly string[] = ['on-request', 'never']

/** One agent's approval dialect: the flag it spells, and the values it accepts. ONE fact per agent —
 *  a flag and a table maintained separately is how a third agent added to the table silently emits
 *  the second agent's flag. */
interface ApprovalDialect {
  flag: string
  modes: Partial<Record<AgentPermissionMode, string>>
  /**
   * Does this CLI's OWN default already prompt before every action?
   *
   * This is what decides whether `manual` ("Ask each time") is honoured by emitting NOTHING. For
   * gemini it is true — its `default` mode is documented as "prompt for approval" — so the bare
   * command already keeps the promise. For codex it is false: its built-in default is
   * `on-request`, "the model decides when to ask", so an unflagged codex delivers something else
   * entirely under that label. Kept as a per-agent fact rather than a special case in
   * `modeSupported`, because it is a property of the CLI, not of the mode.
   */
  manualIsDefault: boolean
  /** The values this CLI accepts, when that is version-dependent. `undefined` = every value in
   *  `modes` is stable across the releases we have measured, so the table alone decides (gemini).
   *  Only codex has one — see `CODEX_APPROVAL_BASELINE`. */
  vocabulary?: (caps: ApprovalCaps) => readonly string[]
  /** What this CLI actually does when `manual` turns out to be inexpressible, for the UI note.
   *  Lives beside the table so the sentence cannot drift from it. */
  manualGapNote?: string
}

const GEMINI_MODES: Partial<Record<AgentPermissionMode, string>> = {
  plan: 'plan',
  acceptEdits: 'auto_edit',
  bypassPermissions: 'yolo'
  // `manual` → gemini's own `default`, i.e. NO flag, exactly as it is for claude.
  //
  // `auto` is ABSENT ON PURPOSE, and it is the one absence worth explaining, because `auto` is
  // `DEFAULT_PERMISSION_MODE` — so this decides what an untouched install launches gemini with.
  // gemini's vocabulary is exactly `default|auto_edit|yolo|plan`; none of those means "approve most
  // things but NOT edits", which is what our `auto` promises. The nearest value, `auto_edit`, is
  // documented as "auto-approve edit tools" — the opposite end of the one axis the user cares
  // about. Mapping `auto → auto_edit` would therefore have made every existing gemini node start
  // auto-approving file edits on upgrade, silently: before gemini joined PERMISSION_MODE_CAPABLE it
  // always launched bare (= `default` = prompt for approval), and `modeSupported` would have
  // answered `true`, so the derived copy would not have admitted it either. No flag is the honest
  // answer and reproduces the pre-branch launch exactly. See `unsupportedModesNote`.
}

const CODEX_MODES: Partial<Record<AgentPermissionMode, string>> = {
  // codex is the FIRST agent where `manual` emits a flag, and — where the CLI still has the value
  // — it has to. For every other agent `manual` = no flag = a default that already prompts
  // (gemini's own `default` is documented as "prompt for approval"), which is exactly what the
  // label "Ask each time" promises. codex's built-in default is NOT that: measured on 0.146.0 AND
  // re-measured on 0.151.0, `codex doctor` reports `approval policy OnRequest` with no `approval`
  // key in ~/.codex/config.toml — the model decides when to ask. So leaving `manual` unflagged
  // delivers `on-request` under an "ask each time" label, and collapses two dropdown entries onto
  // one behaviour — the same dishonesty this module exists to remove, just expressed as an
  // unflagged claim instead of a substituted flag. `untrusted` is the real equivalent: "only run
  // trusted commands without asking; escalate anything not in the trusted set".
  //
  // THIS ENTRY IS A CANDIDATE, NOT A PROMISE. codex removed `untrusted` in 0.149.0, so on any
  // current CLI it is filtered out by `vocabulary` below and `manual` emits nothing — and
  // `modeSupported` then answers false, so `unsupportedModesNote` admits it instead of the
  // dropdown quietly lying. It stays in the table because a codex <= 0.148.0 is still a codex a
  // user may be running, and on THAT CLI "Ask each time" really is expressible; the probe is what
  // decides, not this file.
  //
  // What was checked before concluding the mode is gone (all on 0.151.0): `-a unless-trusted` —
  // rejected by clap; `-c approval_policy=untrusted` and `-c approval_policy=unless-trusted` —
  // both refused with "config could not be loaded", so the TOML route is not a back door either;
  // `--approve-for-me` — a real flag, but it routes approvals through AUTOMATIC review, which is
  // the opposite of asking the user. 0.149.0+ genuinely cannot express "ask every time".
  manual: 'untrusted',
  auto: 'on-request',
  bypassPermissions: 'never'
  // No `plan` and no edit-specific mode exists in ANY measured codex (0.146.0 … 0.154.0), so
  // `plan` and `acceptEdits` are absent ON PURPOSE — see modeSupported.
}

/**
 * The agents that need a translation, flag and vocabulary together.
 *
 * These two used to be separate lookups — a `tableFor` ternary and a `flagFor` ternary whose `else`
 * branch was codex's flag. A third agent added to the table and forgotten in the flag would then
 * have emitted `--ask-for-approval <its own value>`: a wrong flag carrying a right value, i.e. a
 * failed launch, from an edit that looks complete. One record makes that impossible to express.
 *
 * Looked up through `Object.hasOwn`, not `[agentId]`: `AgentId` is OPEN (custom agents carry
 * user-typed ids), so a plain-object index answers `'constructor'` with a Function.
 */
const APPROVAL_DIALECTS: Partial<Record<AgentId, ApprovalDialect>> = {
  gemini: { flag: '--approval-mode', modes: GEMINI_MODES, manualIsDefault: true },
  codex: {
    flag: '--ask-for-approval',
    modes: CODEX_MODES,
    manualIsDefault: false,
    vocabulary: (caps) =>
      caps.codexApprovalValues?.length ? caps.codexApprovalValues : CODEX_APPROVAL_BASELINE,
    manualGapNote:
      'That default asks only when the model chooses to: `untrusted`, the policy that meant ' +
      'ask-every-time, was removed in codex-cli 0.149.0 and has no replacement.'
  }
}

/**
 * The value this dialect may actually EMIT for this mode — the table entry, filtered through what
 * the target CLI says it accepts. `undefined` = emit nothing.
 *
 * `Object.hasOwn`, not `[mode]`, for the same reason `dialectFor` uses it: the callers below
 * validate `mode` with `isPermissionMode` first, and this keeps the lookup honest even so — a
 * plain-object index answers `'constructor'` with a Function, and this value is headed for a shell
 * command line.
 */
function emittableValue(
  dialect: ApprovalDialect,
  mode: AgentPermissionMode,
  caps: ApprovalCaps
): string | undefined {
  const value = Object.hasOwn(dialect.modes, mode) ? dialect.modes[mode] : undefined
  if (!value) return undefined
  if (!dialect.vocabulary) return value
  return dialect.vocabulary(caps).includes(value) ? value : undefined
}

const dialectFor = (agentId: AgentId): ApprovalDialect | null =>
  Object.hasOwn(APPROVAL_DIALECTS, agentId) ? APPROVAL_DIALECTS[agentId] ?? null : null

/** Can this agent actually start in this mode? `false` means the launch omits the flag and the
 *  agent uses its own default — surfaced in the UI so the user is not misled. */
export function modeSupported(
  agentId: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): boolean {
  if (!isPermissionMode(mode)) return false
  const dialect = dialectFor(agentId)
  // claude and grok speak our own vocabulary and their defaults prompt: every mode is reachable.
  if (!dialect) return hasPermissionMode(agentId)
  // `manual` — "ask each time" — is reached two different ways, which is why the table alone is
  // not its authority: by emitting NO flag on a CLI whose own default already prompts
  // (`manualIsDefault`: claude, grok, gemini), or by emitting a value that means it (codex's
  // `untrusted`). An agent that can do NEITHER cannot keep the promise, and this is where that is
  // admitted — codex >= 0.149.0 is exactly that case, and it is why this early return stopped
  // being an unconditional `true`.
  if (mode === 'manual')
    return dialect.manualIsDefault || emittableValue(dialect, 'manual', caps) !== undefined
  return emittableValue(dialect, mode, caps) !== undefined
}

/**
 * The flags to append for this agent + mode. Empty = the bare command.
 *
 * The mode is re-validated at the top for the same reason `permissionModeFlag` does it: the value
 * comes from hand-editable, git-shared JSON (settings.json / project.json) and is interpolated into
 * a shell command line, so its TYPE proves nothing. Without the guard, a forged `constructor`
 * indexes a plain-object table and hands back a Function — one that would have been stringified
 * onto a tmux `send-keys` line. (`dialectFor` closes the same hole on the agent id.)
 */
export function approvalFlags(
  agentId: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): string[] {
  if (!isPermissionMode(mode)) return []
  const dialect = dialectFor(agentId)
  if (dialect) {
    const value = emittableValue(dialect, mode, caps)
    return value ? [dialect.flag, value] : []
  }
  // claude + grok keep their exact historical spelling, validated at the interpolation site.
  return hasPermissionMode(agentId) ? permissionModeFlag(mode) : []
}

/**
 * Appends the agent's approval flag to a launch command, if it has one. The single funnel for every
 * CLI launch path (new node, cold-restore resume, branch, handoff, canvas control).
 *
 * WHERE the flag lands is decided one layer up, by `createAgentNode`: with no `argvPromptSeparator`
 * (claude, gemini, codex) it goes LAST, keeping those command lines byte-identical; with one
 * (grok's `--`) it must go BEFORE the separator, because `--` is end-of-options.
 *
 * **A flag the command already carries is left alone (issue #601).** `cmd` is not always ours:
 * `settings.agentLaunchCommands` lets the user replace the program part with a wrapper, and a
 * wrapper may spell the approval flag itself. Appending regardless produced
 * `claude --permission-mode bypassPermissions --permission-mode auto` — a duplicate the settings
 * field still displayed as exactly what the user typed, so whichever occurrence the CLI honoured,
 * they had no way to tell which one was in force.
 *
 * The contract this settles is "program only, minus what you spelled yourself", not "the override
 * owns the whole command". The whole-command reading cannot work: the settings copy already
 * promises that `--resume` and friends are appended, and a wrapper has no way to know the session id
 * a cold restore is resuming — so nodeterm has to keep appending. What it must not do is append a
 * SECOND opinion about a flag the user has already stated one about; theirs is the more specific and
 * the more explicit, and it wins.
 *
 * Deliberately not extended to `withAgentModel`: a model switch is a per-node action the user just
 * took, and letting a global launch-command override veto it would silently strand that node on the
 * wrapper's model. Different specificity, opposite answer.
 *
 * A command with no override cannot reach the suppression — nodeterm builds it and never puts the
 * flag in twice — so every existing launch line is byte-identical.
 */
export function withPermissionMode(
  cmd: string,
  id: AgentId,
  mode: AgentPermissionMode,
  caps: ApprovalCaps = {}
): string {
  const flags = approvalFlags(id, mode, caps)
  if (!flags.length) return cmd
  if (argvHasFlag(cmd, flags[0])) return cmd
  return `${cmd} ${flags.join(' ')}`
}

// ---------------------------------------------------------------------------------------------
// UI copy, DERIVED from the mapping above.
//
// The settings description has to name the agents the mode applies to and admit where it does not
// apply, and both facts live in the mapping. Spelling them out in a string literal is how a sentence
// starts telling users that Plan works on an agent that has silently stopped supporting it — a
// sentence that drifts from the mapping is worse than none. So they are computed.
// ---------------------------------------------------------------------------------------------

const agentLabel = (id: AgentId): string =>
  AGENT_CONFIG[id as BuiltinAgentId]?.label ?? id

const joinAnd = (parts: string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/**
 * The agents whose start-up mode we can set, labelled for prose: "Claude Code, Grok, …".
 *
 * `mode` narrows to the agents that can actually express THAT mode (a warning about "Bypass all"
 * must not name an agent the mode never reaches); `exclude` drops one the sentence is already about
 * (claude's version-gate note, whose subject is claude).
 */
export function permissionModeAgentsLabel(opts?: PermissionModeAgentFilter): string {
  return joinAnd(permissionModeAgentIds(opts).map(agentLabel))
}

interface PermissionModeAgentFilter {
  mode?: AgentPermissionMode
  exclude?: readonly AgentId[]
  /** What the target CLIs accept, so a "which agents support this mode?" answer is about the CLIs
   *  the user actually has. Omitted = the baseline, exactly as everywhere else in this file. */
  caps?: ApprovalCaps
}

/**
 * The ids `permissionModeAgentsLabel` will name, under the same filter.
 *
 * Exported so a caller can AGREE with the label grammatically — one agent takes "is", several take
 * "are" — instead of hardcoding a plural that reads as "Grok are unaffected" the day the capable list
 * narrows. Same drift `permissionModeAgentsLabel` exists to prevent, one level down.
 */
export function permissionModeAgentIds(opts?: PermissionModeAgentFilter): AgentId[] {
  return PERMISSION_MODE_CAPABLE.filter(
    (id) =>
      !opts?.exclude?.includes(id) &&
      (opts?.mode === undefined || modeSupported(id, opts.mode, opts.caps ?? {}))
  )
}

/**
 * One sentence per capable agent that cannot express every mode, naming the modes and saying what
 * happens instead. Empty string when there is nothing to admit — so the caller appends it blindly
 * and the sentence disappears by itself the day a CLI grows the missing mode.
 */
export function unsupportedModesNote(caps: ApprovalCaps = {}): string {
  return PERMISSION_MODE_CAPABLE.map((id) => ({
    label: agentLabel(id),
    gaps: ALL_PERMISSION_MODES.filter((m) => !modeSupported(id, m, caps)),
    // Only rendered when `manual` is among the gaps — see below. A generic "starts in its own
    // default" is honest for Plan and Accept edits (nothing was promised about what the default
    // does), but it is NOT enough for "Ask each time": the user picked a promise about every
    // single action, and codex's default keeps none of it. The sentence lives on the dialect so
    // it can only be written where the behaviour it describes is.
    manualGap: dialectFor(id)?.manualGapNote
  }))
    .filter((a) => a.gaps.length > 0)
    .map(({ label, gaps, manualGap }) => {
      const modes = joinAnd(gaps.map((m) => PERMISSION_MODE_LABELS[m]))
      const verb = gaps.length > 1 ? 'have' : 'has'
      const head = `${modes} ${verb} no ${label} equivalent, so ${label} sessions start in ${label}'s own default.`
      return gaps.includes('manual') && manualGap ? `${head} ${manualGap}` : head
    })
    .join(' ')
}

/**
 * Agents where `bypassPermissions` bypasses APPROVALS only, because their sandbox is a separate axis
 * this module deliberately does not touch — codex's `--sandbox`, where `--ask-for-approval never`
 * still sandboxes. Kept beside the mapping that causes it rather than in the component, so the
 * warning copy cannot drift from which agents it is true of.
 */
const SANDBOX_RETAINED: readonly AgentId[] = ['codex']

/** The clause a "Bypass all" warning owes, so "no permission checks" is not read as "no sandbox
 *  either". Empty string when it applies to nobody. */
export function bypassSandboxCaveat(caps: ApprovalCaps = {}): string {
  const ids = permissionModeAgentIds({ mode: 'bypassPermissions', caps }).filter((id) =>
    SANDBOX_RETAINED.includes(id)
  )
  if (!ids.length) return ''
  const label = joinAnd(ids.map(agentLabel))
  return `${label} still ${ids.length > 1 ? 'run' : 'runs'} in its own sandbox — only the approval prompts are skipped.`
}
