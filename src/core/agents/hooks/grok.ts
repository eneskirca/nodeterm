// Grok hook service. The Grok hook config is a DIRECTORY — it merges every `$GROK_HOME/hooks/*.json`
// — so unlike claude and gemini there is no shared settings file to merge into: nodeterm owns one
// file outright and rewrites it. We still route through the shared install helper, because that is
// where the missing-script guard, the idempotent re-install and the "sweep events we no longer
// subscribe to" repair live.
import path from 'path'
import type { ManagedHookEvent } from '../../../shared/agents/hook-events'
import { GROK_HOOK_FILE, grokHomeDir } from '../grok-paths'
import { installHooksInto, removeHooksFrom } from './install-helper'

const SCRIPT_FILE_NAME = "grok.sh"

/**
 * Complete Grok 1.0.13 hook set, measured against
 * `~/.grok/docs/user-guide/10-hooks.md:84-106`. Keep all fifteen here: omitting an event makes its
 * normalizer unreachable, which is how StopCancelled existed but Esc left RUNNING stuck.
 * PreCompact/PostCompact are subscribed for their own sake, not for session identity. An earlier
 * version of this comment claimed grok mints a new session id during compaction and that both shells
 * must observe it. It does not: in the captured pair (1.0.13, 2026-09-01) `pre_compact` and
 * `post_compact` carry the SAME `sessionId`, and `docs/grok-agent.md`'s own dialect table already
 * said there is no id to re-key an association with. The claim was never measured; it read like a
 * measurement, and a branch was written against it.
 */
export const GROK_EVENTS: readonly ManagedHookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  // Tool matchers are regexes. `.*` is an explicit match-all; bare `*` is invalid and fails silent.
  { event: 'PreToolUse', matcher: '.*' },
  { event: 'PostToolUse', matcher: '.*' },
  { event: 'PostToolUseFailure', matcher: '.*' },
  { event: 'PermissionDenied', matcher: '.*' },
  'Stop',
  'StopFailure',
  'StopCancelled',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd'
]

/** Our hook file inside the Grok hooks directory. Exported for tests and for the SSH installer,
 *  which must write the identical name on the host. */
export function grokHookConfigPath(): string {
  return path.join(grokHomeDir(), "hooks", GROK_HOOK_FILE)
}

export function installGrokHooks(): void {
  installHooksInto({
    agentId: "grok",
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: grokHookConfigPath(),
    events: GROK_EVENTS,
    atomicConfig: true,
    // Grok's hook docs (user-guide/10-hooks.md) say commands run under PowerShell on Windows; its
    // binary names powershell.exe and cmd.exe. The wrapper invocation runs under either. NOT yet
    // measured on a device — see docs/grok-agent.md's checklist.
    windowsWrapper: true
  })
}

export function removeGrokHooks(): void {
  removeHooksFrom({
    configPath: grokHookConfigPath(),
    events: GROK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME,
    atomicConfig: true
  })
}
