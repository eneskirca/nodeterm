// The shape of "who owns this pane", and the predicate that reads it.
//
// The TYPE lives here, in `src/shared`, because both directions need it: `src/core` PRODUCES it
// (`core/agents/pane-owner.ts` parses it out of tmux + ps, `PtyManager.paneOwner` assembles it) and
// the predicate below CONSUMES it. `src/shared` is the leaf every shell already imports, so this is
// the one placement that does not make `src/shared` depend on `src/core`.

/**
 * Kernel truth about a tmux pane at one instant.
 *
 *  - `panePid`  — `#{pane_pid}`, the process tmux forked for the pane (usually the login shell).
 *  - `tty`      — `#{pane_tty}`, the pane's pty. This is the handle the foreground process GROUP is
 *                 read through, because the kernel tracks that per terminal, not per process.
 *  - `command`  — `#{pane_current_command}`, tmux's own shallow answer. Kept because it is free and
 *                 because it is what the old gate used; it is NOT what the predicate decides on.
 *                 Measured on this host: a pane running `node …/claude --resume x` reports
 *                 `command: 'node'`. A name-based gate cannot see the difference between that and
 *                 any other node process.
 *  - `argv`     — every member of the pane's FOREGROUND process group, full command line, in the
 *                 order `ps` listed them (pid order, so the group leader is first).
 */
export interface PaneOwner {
  panePid: number
  tty: string
  command: string
  argv: readonly string[]
  /**
   * `#{pane_id}` — tmux's own handle for the pane (`%17`). Unique for the life of the server and
   * NEVER reused, which is what `panePid` and `tty` are not: a tty number is recycled aggressively,
   * and `panePid` is the pane's ROOT process (the login shell), which survives the agent it
   * launched. Absent only when the read predates this field or the format expanded to nothing.
   */
  paneId?: string
  /**
   * The pid of each foreground-group member, in the same order as `argv`.
   *
   * `ps` already prints it — `foregroundArgvArgs` asks for `pid=` as its first column — so this
   * costs nothing extra, and it is the only thing that can distinguish "the same agent process is
   * still there" from "an agent process is there again". A wrapper loop (`while :; do claude; done`)
   * makes the second case ordinary rather than exotic.
   */
  pids?: readonly number[]
}

/**
 * Three-valued on purpose — `unknown` is NOT a shade of `not-agent`.
 *
 *  - `agent`     — the kernel answered and the expected agent binary owns the foreground group.
 *  - `not-agent` — the kernel answered and the answer was no. Terminal; do not retry.
 *  - `unknown`   — the probe failed (no tmux, dead pane, `ps` unavailable, deadline lapsed). The
 *                  caller may retry. It must never be upgraded to `agent`.
 */
export type AgentPaneVerdict = 'agent' | 'not-agent' | 'unknown'

/**
 * The binary names each built-in agent's CLI actually runs as. Mirrors `AGENT_CONFIG[x].launchCmd`
 * / `.expectedProcess`, kept as its own list so a launch-command change (a wrapper, a flag) cannot
 * silently widen or narrow a SECURITY predicate. A custom agent (`custom:<uuid>`) has no entry —
 * see `isAgentPane`'s `unknown` for what that means.
 */
export const AGENT_BINARIES: Record<string, readonly string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  copilot: ['copilot'],
  gemini: ['gemini'],
  opencode: ['opencode'],
  grok: ['grok'],
  agy: ['agy'],
  pi: ['pi'],
  goose: ['goose']
}

/**
 * Names that must NEVER become an agent's binary, however a launch command was written.
 *
 * Every one of them is a program the user's own plain terminals run. Admitting `bash` as "the
 * codex-custom binary" would make every idle shell on the canvas a valid delivery target — the
 * exact hole `isShellCommand`'s negation had, re-opened through the custom-agent door. When a
 * launch command's first meaningful token is one of these, the honest answer is that we cannot name
 * the binary (null ⇒ `unknown` ⇒ refuse), not that we can.
 */
const NEVER_A_BINARY = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'nu', 'pwsh', 'powershell', 'xonsh', 'elvish',
  'ssh', 'sudo', 'doas', 'su', 'tmux', 'screen', 'script'
])

/** Package runners: the interesting name is the package they fetch, not the runner. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'uvx', 'pipx'])

/** Tokens that stand between a runner/interpreter and the name we are after. */
const RUNNER_VERBS = new Set(['exec', 'run', 'dlx', 'x', '--'])

/**
 * Interpreters that are followed by the script they run. `node /usr/local/bin/claude` is the shape
 * every npm-installed agent CLI actually has on this host (measured), so argv[0]'s basename alone
 * would answer `node` for every one of them.
 *
 * Resolution applies ONLY when the next token is not an option: `sh -c 'grep -r claude .'` must not
 * resolve to `grep`, and `python3 -i` must not resolve to anything. An interpreter whose next token
 * starts with `-` keeps its own name.
 */
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl'])

/** basename, with a login shell's leading `-` stripped (`-zsh` → `zsh`). */
function baseName(token: string): string {
  const noDash = token.replace(/^-/, '')
  return noDash.split('/').pop() ?? ''
}

/**
 * The binary a command line actually runs, as a bare name. Splits on whitespace only — this is a
 * `ps` line, already tokenised by the kernel's argv, and a quoted path with a space in it is not
 * worth a shell-grammar parser here: the failure mode is a name that matches nothing, i.e. a
 * refusal, which is the safe direction.
 */
function effectiveBinary(commandLine: string): string {
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const head = baseName(tokens[0])
  if (!INTERPRETERS.has(head)) return head
  const next = tokens[1]
  if (!next || next.startsWith('-')) return head
  return baseName(next)
}

/**
 * The binary a LAUNCH COMMAND will end up running, as a bare name — or null when it cannot be named
 * safely.
 *
 * `launchCmd` is free text the user typed into Settings → Agents, so it is not a program name: it
 * is `npx -y my-agent`, `bash -lc "…"`, `env FOO=1 my-agent --flag`. The walk below skips wrappers
 * to the first thing that looks like the program, and refuses outright when that thing is something
 * every plain terminal also runs (`NEVER_A_BINARY`) — a wrong name here does not merely fail to
 * match, it matches everything.
 *
 * A trailing npm version specifier is dropped (`@acme/my-agent@1.2.3` → `my-agent`) because that is
 * how the process will appear in argv. A `.js` extension is kept, for the same reason.
 */
export function binaryFromLaunchCmd(launchCmd: string | null | undefined): string | null {
  if (!launchCmd) return null
  const tokens = launchCmd.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length && i < 16; i++) {
    const token = tokens[i]
    if (token.startsWith('-') || RUNNER_VERBS.has(token)) continue // an option or a runner verb
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue // `env FOO=1 …`'s assignments
    const base = baseName(token)
    if (!base) continue
    if (NEVER_A_BINARY.has(base)) return null
    if (RUNNERS.has(base) || INTERPRETERS.has(base) || base === 'env') continue
    // Strip an npm version specifier, but never a leading scope: `@acme/x@1` → `x`, `@acme` → `@acme`.
    const at = base.lastIndexOf('@')
    return at > 0 ? base.slice(0, at) : base
  }
  return null
}

/**
 * The binary names to expect for an agent id — built-in from the table, custom from its launch
 * command.
 *
 * Without this a `custom:<uuid>` agent has no entry, `isAgentPane` answers `unknown`, and because
 * `unknown` means "the caller may retry", a delivery gate refuses that pane on every attempt
 * forever behind a retryable-looking error. That is a dead end wearing a transient error's clothes.
 * The information to avoid it already exists — `resolveAgent`
 * (`src/renderer/state/workspace.ts`) resolves exactly this `launchCmd`, and falls back to the
 * agent id itself for an id it does not know, which is mirrored here.
 *
 * Still null (⇒ `unknown`, ⇒ refuse) in the two cases where no honest answer exists: a
 * `custom:<uuid>` whose definition is not in the list handed to us, and a launch command whose
 * program cannot be named without naming something every plain shell also runs. Null is a refusal,
 * not a guess — but a caller holding the settings can now avoid it for every configured agent.
 *
 * `customAgents` is structural rather than `CustomAgent[]` so this stays a leaf module.
 */
export function binariesFor(
  agentId: string,
  customAgents?: readonly { id: string; launchCmd: string }[]
): readonly string[] | null {
  const builtin = AGENT_BINARIES[agentId]
  if (builtin) return builtin
  const custom = customAgents?.find((c) => c.id === agentId)
  if (custom) {
    const name = binaryFromLaunchCmd(custom.launchCmd)
    return name ? [name] : null
  }
  // A `custom:` id we were given no definition for is unknowable — deriving from the id would yield
  // `custom:<uuid>`, a name that matches nothing, i.e. `not-agent`: a terminal answer to a question
  // we never actually asked. Anything else is treated as its own launch command, which is what
  // resolveAgent does for an agent id it does not recognise.
  if (agentId.startsWith('custom:')) return null
  const name = binaryFromLaunchCmd(agentId)
  return name ? [name] : null
}

/**
 * POSITIVE and kernel-truth, replacing `!isShellCommand(pane)`, which was neither.
 *
 * The old gate asked a persisted field what the pane SHOULD be running. `agentId` is durable and
 * outlives the CLI, so a plain terminal whose claude exited weeks ago still read as an agent — and
 * `isShellCommand` is a SEVEN-NAME allowlist (zsh/bash/sh/fish/dash/ksh/tcsh), so `nu`, `pwsh`,
 * `xonsh`, `ssh` and `python` all fell through its negation and were admitted as agents. Text
 * delivered to any of those EXECUTES, because sendText appends Enter.
 *
 * `unknown` is a third answer, not a shade of `not-agent`, because the two need different replies:
 * `unknown` means the probe failed and the caller may retry; `not-agent` means the kernel answered
 * and the answer was no.
 *
 * Matched on the BASENAME of argv[0] (after interpreter resolution), never on a substring of the
 * command line — `vim /etc/claude.conf` and `grep -r claude .` are not claude panes.
 *
 * `binaries` overrides the derived list. A caller holding the settings should pass
 * `binariesFor(agentId, settings.customAgents)` so a CUSTOM agent is verifiable too; without it a
 * `custom:<uuid>` cannot be named and answers `unknown`, which is a refusal, not a licence.
 *
 * ── WHAT THIS DOES NOT PROVE (carry into the delivery gate) ─────────────────────────────────────
 *
 *  1. **It proves the agent is IN the foreground process group, not that it is the thing READING
 *     the tty.** `sh -c "sleep 600 | claude"` answers `agent`, and correctly so — claude really is
 *     in the group. But claude's stdin is the PIPE, so text written to the pane sits in the tty
 *     buffer until the shell reads it after the pipeline exits. That is the "rename splice = lost
 *     launch" shape: the write succeeds and the payload surfaces later, somewhere else. A gate that
 *     needs "the agent is reading" needs a further check; this predicate is not it.
 *  2. **Two false negatives are terminal and deliberate**, documented rather than fixed because the
 *     alternative is guessing: a script path containing a SPACE (the argv split cannot tell it from
 *     two tokens), and a differently-named SYMLINK to the agent binary (argv carries the name it
 *     was invoked as, not the target). Both answer `not-agent` — a refusal, which is the safe
 *     direction.
 *
 * `isShellCommand` is deliberately NOT deleted — its existing callers (the restart exit poll, the
 * reconnect resync) ask a genuinely different question ("has the CLI let go of the pane?") for
 * which a shell allowlist is the right shape.
 */
export function isAgentPane(
  owner: PaneOwner | null | undefined,
  expected: string,
  binaries?: readonly string[] | null
): AgentPaneVerdict {
  if (!owner) return 'unknown'
  if (!owner.argv || owner.argv.length === 0) return 'unknown'
  const wanted = binaries ?? binariesFor(expected)
  if (!wanted || wanted.length === 0) return 'unknown'
  for (const line of owner.argv) {
    if (wanted.includes(effectiveBinary(line))) return 'agent'
  }
  return 'not-agent'
}

/**
 * The PID of the agent process this pane's verdict rests on — the identity `isAgentPane` finds but
 * throws away.
 *
 * It exists because "an agent owns this pane" is not the same claim as "the SAME agent owns this
 * pane", and a delivery's post-write re-verify needs the second one. The failure it closes is
 * ordinary rather than exotic:
 *
 *   pane root = bash(1000), claude(2000) in the foreground group  → we write
 *   claude exits before reading; bash reads the pasted lines and EXECUTES them
 *   a wrapper (`while :; do claude; done`) starts claude(2100)
 *   post-probe: same tty, same pane_pid (bash is the pane's ROOT process), an agent in the group
 *
 * On name alone that reads as "unchanged", and the delivery is reported as `delivered` when the body
 * in fact ran as shell commands. The pid moved, so the pid is what has to be compared.
 *
 * `null` when the pane is not an agent's, when the read carries no `pids` (an older read — treat it
 * as unknown, never as unchanged), or when the matching row has no pid.
 */
export function agentPidIn(
  owner: PaneOwner | null | undefined,
  expected: string,
  binaries?: readonly string[] | null
): number | null {
  if (!owner || !owner.argv || !owner.pids) return null
  const wanted = binaries ?? binariesFor(expected)
  if (!wanted || wanted.length === 0) return null
  for (let i = 0; i < owner.argv.length; i++) {
    if (!wanted.includes(effectiveBinary(owner.argv[i]))) continue
    const pid = owner.pids[i]
    return typeof pid === 'number' && pid > 0 ? pid : null
  }
  return null
}
