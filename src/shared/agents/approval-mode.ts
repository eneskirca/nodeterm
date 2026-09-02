// Per-agent translation of nodeterm's permission mode into the agent's own approval flag.
//
// claude and grok share one spelling and one vocabulary, which is why they needed no mapping at all
// until now. gemini and codex each have their own, and BOTH are narrower than ours — which is the
// interesting case: our five modes fit neither `default|auto_edit|yolo|plan` nor
// `untrusted|on-request|never`, so a mode the CLI cannot express emits NO flag (its own default)
// rather than a nearest match. A silent substitution would show the user "Plan" while codex ran in
// on-request, or "Auto" while gemini auto-approved every file edit.
//
// Measured: `gemini --help` (0.54.4) and `codex --help` (0.146.0). `--sandbox` is deliberately not
// touched: it is a separate axis (read-only | workspace-write | danger-full-access), and folding
// `danger-full-access` into `bypassPermissions` would widen filesystem access invisibly —
// `--ask-for-approval never` on its own still sandboxes.
import {
  AGENT_CONFIG,
  ALL_PERMISSION_MODES,
  PERMISSION_MODE_CAPABLE,
  PERMISSION_MODE_LABELS,
  capabilityAgentId,
  hasPermissionMode,
  isPermissionMode,
  permissionModeFlag,
  type AgentId,
  type AgentPermissionMode,
  type BuiltinAgentId
} from './config'
import { argvHasFlag } from '../shell-quote'

/** One agent's approval dialect: the flag it spells, and the values it accepts. ONE fact per agent —
 *  a flag and a table maintained separately is how a third agent added to the table silently emits
 *  the second agent's flag. */
interface ApprovalDialect {
  flag: string
  modes: Partial<Record<AgentPermissionMode, string>>
}

const GEMINI_MODES: Partial<Record<AgentPermissionMode, string>> = {
  plan: 'plan',
  acceptEdits: 'auto_edit',
  bypassPermissions: 'yolo',
  manual: ''
  // A PRESENT key with an EMPTY value is the table's way of saying "this agent supports the mode,
  // and expresses it by emitting NO flag" — `modeSupported` reads presence (`Object.hasOwn`) while
  // `approvalFlags` reads truthiness, so the two answers are `true` + `[]`. An ABSENT key means
  // unsupported (`false` + `[]`, e.g. gemini's `auto`, devin's `manual`) — same emitted command,
  // opposite promise to the user, which is why the distinction is a key and not a value.
  //
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
  // codex is the FIRST agent where `manual` emits a flag, and it has to. For every other agent
  // `manual` = no flag = a default that already prompts (gemini's own `default` is documented as
  // "prompt for approval"), which is exactly what the label "Ask each time" promises. codex's
  // built-in default is NOT that: measured on 0.146.0, `codex doctor` reports `approval policy
  // OnRequest` with no `approval` key in ~/.codex/config.toml — the model decides when to ask. So
  // leaving `manual` unflagged would deliver `on-request` under an "ask each time" label, and
  // collapse two dropdown entries onto one behaviour — the same dishonesty this module exists to
  // remove, just expressed as an unflagged claim instead of a substituted flag. `untrusted` is the
  // real equivalent: "only run trusted commands without asking; escalate anything not in the trusted
  // set". No codex launch has ever carried this flag (codex joined the list in the same change), so
  // there is no historical command line to keep byte-identical here.
  manual: 'untrusted',
  auto: 'on-request',
  bypassPermissions: 'never'
  // No `plan` and no edit-specific mode exist in codex 0.146.0, so `plan` and `acceptEdits` are
  // absent ON PURPOSE — see modeSupported.
}

const DEVIN_MODES: Partial<Record<AgentPermissionMode, string>> = {
  // Devin CLI 3000.4.25 accepts `auto | accept-edits | smart | dangerous` for `--permission-mode`
  // (`/normal`, `/accept-edits`, `/smart`, `/bypass` in-session). `plan` is not a Devin mode,
  // and `smart` is intentionally omitted from our vocabulary: it is a limited-rollout Devin mode and
  // `auto` is the closest stable equivalent. `bypassPermissions` maps to `dangerous` (the `--help`
  // value; `/bypass` and `/yolo` are in-session aliases, not CLI flag values).
  //
  // `manual` is ABSENT on purpose: Devin's own default is `auto`, which auto-approves read-only
  // tools and only asks for higher-permission actions. Emitting NO flag would therefore run `auto`,
  // not "ask each time". There is no Devin mode that asks for every action, so `manual` is
  // unsupported and `modeSupported('devin', 'manual')` is false.
  auto: 'auto',
  acceptEdits: 'accept-edits',
  bypassPermissions: 'dangerous'
  // `manual` and `plan` are absent ON PURPOSE — see modeSupported.
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
  gemini: { flag: '--approval-mode', modes: GEMINI_MODES },
  codex: { flag: '--ask-for-approval', modes: CODEX_MODES },
  devin: { flag: '--permission-mode', modes: DEVIN_MODES }
}

// Resolve dialect through the base harness, so a custom agent with `baseAgent:'devin'`
// inherits devin's flag and value table instead of falling back to claude's `--permission-mode`.
const dialectFor = (agentId: AgentId): ApprovalDialect | null => {
  const base = capabilityAgentId(agentId)
  return Object.hasOwn(APPROVAL_DIALECTS, base) ? APPROVAL_DIALECTS[base] ?? null : null
}

/** Can this agent actually start in this mode? `false` means the launch omits the flag and the
 *  agent uses its own default — surfaced in the UI so the user is not misled. */
export function modeSupported(agentId: AgentId, mode: AgentPermissionMode): boolean {
  if (!isPermissionMode(mode)) return false
  const dialect = dialectFor(agentId)
  if (dialect) return Object.hasOwn(dialect.modes, mode)
  // No dialect = claude and grok: every mode they support is spelled identically, and `manual`
  // means "no flag" because their own default already prompts per action. An agent that HAS a
  // dialect answered above — there `manual` is supported only when the table maps it explicitly.
  return hasPermissionMode(agentId)
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
export function approvalFlags(agentId: AgentId, mode: AgentPermissionMode): string[] {
  if (!isPermissionMode(mode)) return []
  const dialect = dialectFor(agentId)
  if (dialect) {
    const value = dialect.modes[mode]
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
 * (grok's and devin's `--`) it must go BEFORE the separator, because `--` is end-of-options — a
 * flag placed after it is a positional, silently swallowed into the prompt or a usage error.
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
export function withPermissionMode(cmd: string, id: AgentId, mode: AgentPermissionMode): string {
  const flags = approvalFlags(id, mode)
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
      !opts?.exclude?.includes(id) && (opts?.mode === undefined || modeSupported(id, opts.mode))
  )
}

/**
 * One sentence per capable agent that cannot express every mode, naming the modes and saying what
 * happens instead. Empty string when there is nothing to admit — so the caller appends it blindly
 * and the sentence disappears by itself the day a CLI grows the missing mode.
 */
export function unsupportedModesNote(): string {
  return PERMISSION_MODE_CAPABLE.map((id) => ({
    label: agentLabel(id),
    gaps: ALL_PERMISSION_MODES.filter((m) => !modeSupported(id, m))
  }))
    .filter((a) => a.gaps.length > 0)
    .map(({ label, gaps }) => {
      const modes = joinAnd(gaps.map((m) => PERMISSION_MODE_LABELS[m]))
      const verb = gaps.length > 1 ? 'have' : 'has'
      return `${modes} ${verb} no ${label} equivalent, so ${label} sessions start in ${label}'s own default.`
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
export function bypassSandboxCaveat(): string {
  const ids = permissionModeAgentIds({ mode: 'bypassPermissions' }).filter((id) =>
    SANDBOX_RETAINED.includes(id)
  )
  if (!ids.length) return ''
  const label = joinAnd(ids.map(agentLabel))
  return `${label} still ${ids.length > 1 ? 'run' : 'runs'} in its own sandbox — only the approval prompts are skipped.`
}
