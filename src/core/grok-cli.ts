// Capability probe for the LOCAL grok CLI.
//
// Separate from `claude-cli.ts` on purpose. Rule 9 of CLAUDE.md: *a capability gate that is fed by a
// version probe belongs to the agent it probes*. Answering "can grok mint a session id?" with what
// the OTHER CLI's probe returned would be a guess wearing a measurement's clothes — and the two are
// installed and upgraded independently, so the answer is not even correlated.
//
// Feature-detection over `grok --help`, never a version floor: an unknown flag makes grok EXIT, so a
// floor guessed too low kills every launch on the machines below it instead of degrading. Absent or
// unreadable help ⇒ false ⇒ no flag ⇒ the command line stays exactly what it is today.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'
import { grokModelsFrom } from '../shared/agents/model-gateway'
import { listGrokSessionIds } from './grok-session-mint'
import { grokSessionsDir } from './agents/grok-paths'
import { UNKNOWN_GROK_CLI_CAPS, type GrokCliCaps } from '../shared/types'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

export { UNKNOWN_GROK_CLI_CAPS, type GrokCliCaps }

/**
 * Pure: help output → caps. The impure probe below is plumbing around it.
 *
 * Anchored on a word boundary, which is load-bearing twice over. `--session-id-file` must not
 * answer yes for `--session-id`; and grok's own help MENTIONS `--session-id` inside the description
 * of `--fork-session`, wrapped in backticks — a looser match would report the flag from prose alone.
 */
export function grokCliCapsFrom(
  helpOutput: string | null | undefined,
  modelsOutput?: string | null
): GrokCliCaps {
  return {
    sessionIdFlag: /(^|\s)--session-id(\s|=|$)/m.test(helpOutput ?? ''),
    models: grokModelsFrom(modelsOutput).map((m) => m.id)
  }
}

let cached: Promise<GrokCliCaps> | null = null

/**
 * The two spawns, separated from HOW they are spawned so the composition is testable.
 *
 * `run` returns the subcommand's stdout, or null when it failed. Exported for tests: the wiring
 * between "ask `--help`" and "ask `models`" is precisely the kind of code the typecheck validates
 * and nothing exercises — drop the second call and every pure-parser test stays green while model
 * switching silently disappears.
 */
export async function grokCapsFromRunner(
  run: (args: string[]) => Promise<string | null>
): Promise<GrokCliCaps> {
  const help = await run(['--help'])
  if (help === null) return UNKNOWN_GROK_CLI_CAPS
  // A second spawn, paid once per process (the whole probe is memoized). Its failure must not cost
  // us the help answer, so it degrades on its own: no model list just means no model switching.
  const models = await run(['models'])
  return grokCliCapsFrom(help, models)
}

async function probe(): Promise<GrokCliCaps> {
  // GUI apps don't inherit the shell PATH — resolve through the login shell like every other CLI
  // lookup in the app.
  const bin = await findInLoginPath('grok').catch(() => null)
  if (!bin) return UNKNOWN_GROK_CLI_CAPS
  return grokCapsFromRunner((args) =>
    execFileP(bin, args, { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "omit the flag".
      .catch(() => null)
  )
}

/** The local grok CLI's capabilities. Memoized for the process lifetime. Never rejects. */
export function grokCliCaps(): Promise<GrokCliCaps> {
  if (!cached) cached = probe()
  return cached
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike), so both
 *  shells answer it — a probe registered in one shell only is a feature the other silently lacks. */
export function registerGrokCliIpc(): void {
  platform().handle(IPC.grokCliCaps, () => grokCliCaps())
  // The session ids grok already owns for a cwd. Sent as an ARRAY because a Set does not survive
  // the IPC/WS-RPC boundary — it would arrive as `{}` and silently report nothing taken.
  platform().handle(IPC.grokTakenSessionIds, (cwd: string) =>
    typeof cwd === 'string' && cwd ? [...listGrokSessionIds(grokSessionsDir(), cwd)] : []
  )
}
