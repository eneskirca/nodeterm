/**
 * Capability probe for the LOCAL Codex CLI — the codex analogue of `core/claude-cli.ts`, and
 * deliberately a SECOND probe rather than a reuse of claude's.
 *
 * CLAUDE.md states the rule this file exists to obey: a capability gate fed by a version probe
 * belongs to the agent it probes. Claude's `auto` gate is fed by `claude --version`; applying it to
 * codex would downgrade codex sessions on a machine whose *claude* is old or missing, and reading
 * codex's vocabulary off claude's probe would be the same mistake with the arrow reversed.
 *
 * It answers two questions read off the same `--help` page — which values does this `codex` accept
 * for `--ask-for-approval`, and does it take `--no-daemon` (see `codexNoDaemonFrom`)? — shaped as a
 * caps bag so the next codex fact lands here instead of growing another probe.
 *
 * WHY THE VALUES AND NOT A VERSION NUMBER. The vocabulary is not stable across releases: measured
 * on real binaries, 0.146.0–0.148.0 advertise `untrusted, on-request, never` and 0.149.0 onwards
 * advertise `on-request, never`. A version floor would work today and would be wrong the next time
 * OpenAI moves the set, and it cannot answer for a build that is not on npm at all. Reading the
 * CLI's own `--help` asks the binary in front of us what it actually takes — the same choice
 * `codexCliSupportsRemote` and claude's `--session-id` detection already made.
 *
 * Lives in core (not main) so the Server Edition boots it through the same CorePlatform seam: the
 * server's own machine is the one that runs its Codex sessions, so it needs the real answer, not a
 * stub. The remote (SSH) host's codex is a different binary and is NOT covered here — a remote
 * launch falls back to the baseline vocabulary, see `ApprovalCaps` in shared/agents/approval-mode.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { UNKNOWN_CODEX_CLI_CAPS, type CodexCliCaps } from '../shared/types'
import { findInLoginPath } from './pty-manager'
import { directExecutableInvocation } from './exec-path'
import { platform } from './platform'
import { CODEX_NO_DAEMON_HELP_RE } from '../shared/agents/codex-daemon'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

/**
 * Only the option we are reading, never the one next to it.
 *
 * `--help` lists `-s, --sandbox <SANDBOX_MODE>` with its own `[possible values: read-only,
 * workspace-write, danger-full-access]` two lines above `--ask-for-approval`, so a parser that
 * scanned the page for "possible values" would confidently return the SANDBOX vocabulary and then
 * emit `--ask-for-approval read-only`. The slice below is anchored on the option's own header line
 * and ends at the next one.
 */
const ASK_FOR_APPROVAL = /--ask-for-approval\b/
/** An option header: indented at most 6 and starting with a dash. Value/description lines inside an
 *  option are indented 10, so this cannot cut a block short. */
const OPTION_HEADER = /^ {0,6}-{1,2}[A-Za-z]/

/**
 * Pure: `codex --help` output → the `--ask-for-approval` values it advertises, or `null` when the
 * page did not say (absent output, an option we could not find, a shape we do not recognise).
 *
 * `null` is a first-class answer and NOT an empty list: "the CLI accepts nothing" and "we could not
 * read the page" lead to different decisions one layer up, where `null` resolves to the baseline
 * vocabulary and an empty list would forbid every value including the two that have always worked.
 *
 * BOTH of clap's renderings are handled, because both are real. Long `--help` prints a block:
 *
 *     -a, --ask-for-approval <APPROVAL_POLICY>
 *             Configure when the model requires human approval before executing a command
 *
 *             Possible values:
 *             - on-request: The model decides when to ask the user for approval
 *             - never:      Never ask for user approval Execution failures are immediately
 *               returned to the model
 *
 * short `-h` prints it inline and wraps it mid-phrase:
 *
 *     -a, --ask-for-approval <APPROVAL_POLICY>
 *             Configure when the model requires human approval ... [possible
 *             values: on-request, never]
 *
 * — which is why the inline branch joins the slice before matching rather than working line by
 * line. The probe below asks for the long form; the short form is handled so a caller that has
 * `-h` output lying around gets the same answer instead of a silent `null`.
 *
 * Every token is validated against `[a-z][a-z0-9-]*`. These strings are appended to a launch
 * command that is typed into a tmux pane, so the help page is untrusted input at an interpolation
 * site like any other — a token we would not recognise is dropped rather than quoted and hoped
 * for, and if nothing survives the answer is `null`.
 */
export function codexApprovalValuesFrom(helpOutput: string | null | undefined): string[] | null {
  if (!helpOutput) return null
  const lines = helpOutput.split(/\r?\n/)
  const start = lines.findIndex((l) => ASK_FOR_APPROVAL.test(l))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !OPTION_HEADER.test(lines[end])) end++
  const slice = lines.slice(start, end)

  const values: string[] = []
  const inline = slice.join(' ').match(/\[possible\s+values:\s*([^\]]*)\]/i)
  if (inline) {
    values.push(...inline[1].split(','))
  } else {
    // The block form. Anchored on the `Possible values:` marker so a bullet inside the option's
    // prose description can never be mistaken for a value.
    const marker = slice.findIndex((l) => /^\s*possible\s+values:\s*$/i.test(l))
    if (marker < 0) return null
    for (const line of slice.slice(marker + 1)) {
      const m = line.match(/^\s*-\s+([^\s:]+)\s*:/)
      if (m) values.push(m[1])
    }
  }
  const clean = values.map((v) => v.trim()).filter((v) => /^[a-z][a-z0-9-]*$/.test(v))
  return clean.length ? Array.from(new Set(clean)) : null
}

/**
 * Pure: `codex --help` output → does this CLI accept `--no-daemon`? `null` when there is no page to
 * read (no codex, a timeout) — the caller then emits nothing, i.e. today's command line.
 *
 * WHY THIS FLAG MATTERS. From 0.157.0 the `daemon_auto_start` feature is `stable, true` (0.156.1:
 * `experimental, false`): a plain `codex` TUI no longer runs in-process but starts — or JOINS — ONE
 * background `app-server` per `CODEX_HOME`, and that daemon keeps the environment of the pane that
 * started it. MEASURED on 0.159.2 (private CODEX_HOME, private tmux socket): pane A started with
 * `NODETERM_NODE_ID=node-A`, pane B with `node-B`; in pane B both the tool shell (`echo
 * $NODETERM_NODE_ID` printed `node-A`) and every hook process (`node-A` in the hook log) ran as
 * pane A. Every nodeterm hook POST, canvas-control verb and context-link read from pane B was
 * attributed to another node. `--no-daemon` ("Run without the shared background server, even if it
 * is already running") put pane C's tool shell and hooks back on `node-C`;
 * `-c features.daemon_auto_start=false` did NOT — it still joined the running daemon. There is no
 * environment-variable switch.
 *
 * Anchored on an option HEADER line, never on prose: a description mentioning the flag inside
 * another option must not read as the option itself.
 */
export function codexNoDaemonFrom(helpOutput: string | null | undefined): boolean | null {
  if (!helpOutput) return null
  return helpOutput.split(/\r?\n/).some((l) => CODEX_NO_DAEMON_HELP_RE.test(l))
}

let helpCached: Promise<string | null> | null = null

/**
 * `codex --help`, memoized for the process lifetime. Exported because two capability answers are
 * read off the same page — this file's approval vocabulary and `codex-identity-caps`'s `--remote`
 * detection — and paying for the page twice per boot to answer two questions about one binary is
 * the kind of duplication that turns into two different answers.
 *
 * Never rejects: a missing CLI, a timeout or a non-zero exit all resolve to `null`, which every
 * reader treats as "we do not know".
 *
 * `codex-identity-caps.ts` spawns the same page for its own `--remote` detection and deliberately
 * keeps doing so: its probe is handed an already-resolved `bin` (and falls through to `resume
 * --help`, which this file has no use for), and it only runs on an install that has the standalone
 * runtime. The two read DIFFERENT facts off the page with different parsers, so there is no shared
 * rule here to drift — only, on that one install shape, one extra boot-time spawn.
 */
export function codexHelpText(): Promise<string | null> {
  if (!helpCached) {
    helpCached = (async () => {
      try {
        // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
        // CLI lookup in the app (pty-manager, claude-cli, commit-message).
        const bin = await findInLoginPath('codex')
        if (!bin) return null
        // Through the same wrapper the `--remote` probe uses (`codex-identity-caps.ts`): on
        // Windows the resolved `codex` is routinely a `.cmd` shim, which `execFile` cannot spawn
        // directly, and a probe that silently fails there would report "unknown vocabulary" on
        // every Windows machine.
        const invocation = directExecutableInvocation(bin, ['--help'])
        if (!invocation) return null
        const { stdout } = await execFileP(invocation.executable, invocation.args, {
          ...invocation.options,
          timeout: PROBE_TIMEOUT_MS
        })
        return stdout
      } catch {
        return null
      }
    })()
  }
  return helpCached
}

let cached: Promise<CodexCliCaps> | null = null

/**
 * The local Codex CLI's capabilities. Memoized for the process lifetime: the answer only changes
 * when the user upgrades the CLI, which a relaunch picks up. Never rejects — unknown resolves to
 * `UNKNOWN_CODEX_CLI_CAPS`, i.e. the baseline vocabulary, i.e. the command line nodeterm has always
 * sent for the modes that never depended on this.
 */
export function codexCliCaps(): Promise<CodexCliCaps> {
  if (!cached) {
    cached = codexHelpText()
      .then((help) => ({
        approvalValues: codexApprovalValuesFrom(help),
        noDaemon: codexNoDaemonFrom(help)
      }))
      .catch(() => UNKNOWN_CODEX_CLI_CAPS)
  }
  return cached
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerCodexCliIpc(): void {
  platform().handle(IPC.codexCliCaps, () => codexCliCaps())
}

export function resetCodexCliCapsForTests(): void {
  cached = null
  helpCached = null
}
