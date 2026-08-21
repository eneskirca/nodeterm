import {
  AUTO_PERMISSION_MODE_MIN_VERSION,
  gatePermissionMode,
  resolvePermissionMode,
  type AgentId,
  type AgentPermissionMode
} from '@shared/agents/config'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps, type Project } from '@shared/types'
import { useProjects } from './projects'
import { useSettings } from './settings'
import { useSshConn, type SshAutoPermAnswer } from './sshConn'

/**
 * Local Claude CLI capabilities, probed once per app run through `claude.cliCaps()` (main/server →
 * core/claude-cli.ts). Kept as a module-level memo rather than a zustand store: nothing renders
 * from it — it is read only at the moment a launch command is built — and a store would invite
 * re-renders on a value that never changes while the app runs.
 *
 * Until the probe answers, `caps` is the FAIL-OPEN unknown: no `auto` flag, i.e. the bare `claude`
 * command. A launch is never blocked on the probe.
 */
let caps: ClaudeCliCaps = UNKNOWN_CLAUDE_CLI_CAPS
let capsPromise: Promise<ClaudeCliCaps> | null = null

/** How long a launch may wait on the probe before giving up on it and using the bare command. */
const CAPS_WAIT_MS = 3000

/**
 * Kick off (or join) the local CLI probe. Never rejects, and never takes longer than
 * `CAPS_WAIT_MS`. Called once at boot; awaited by any launch path that can run before boot settles
 * (a cold-restored agent node).
 *
 * The timeout is what makes "a launch is never blocked on the probe" true BY CONSTRUCTION. On the
 * desktop the IPC round-trip is bounded by the main-process probe, but in the Server Edition the
 * call goes over WS-RPC, which neither times out nor rejects its pending requests when the socket
 * drops — a drop between send and response would leave this promise (and the memo) unsettled
 * forever, and with it the agent relaunch that awaits it. On timeout we resolve to the caps we
 * have (unknown ⇒ no `auto` flag ⇒ bare command); a late answer still lands in `caps`, so the
 * NEXT launch picks it up.
 */
export function ensureClaudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!capsPromise) {
    const probe = Promise.resolve()
      .then(() => window.nodeTerminal.claude.cliCaps())
      .then((c) => (caps = c ?? UNKNOWN_CLAUDE_CLI_CAPS))
      .catch(() => UNKNOWN_CLAUDE_CLI_CAPS)
    const timeout = new Promise<ClaudeCliCaps>((resolve) =>
      setTimeout(() => resolve(caps), CAPS_WAIT_MS)
    )
    capsPromise = Promise.race([probe, timeout])
  }
  return capsPromise
}

/**
 * The last-known caps, synchronously. For callers that cannot await — node creation is a sync
 * factory — and whose correct answer when nothing has been probed yet is simply "assume nothing"
 * (UNKNOWN, i.e. the pre-feature command line). `ensureClaudeCliCaps` runs at boot, so by the time
 * a user creates a node this is the real answer.
 */
export function claudeCliCapsNow(): ClaudeCliCaps {
  return caps
}

/** Test seam: drop the memo (and optionally preload a known answer). */
export function resetClaudeCliCapsForTests(next?: ClaudeCliCaps): void {
  caps = next ?? UNKNOWN_CLAUDE_CLI_CAPS
  capsPromise = null
}

/**
 * Does the CLI that will actually RUN this project's sessions accept `--permission-mode auto`?
 *
 * An SSH project's terminals run on the remote host, whose claude can be OLDER than the local one
 * — so the local probe's answer is never applied to a remote launch. The remote is probed on its
 * own host at connect (SshProjectManager) and cached in `useSshConn`; not connected / not yet
 * probed / older CLI all answer false, which omits the flag (conservative, and exactly the
 * command nodeterm shipped before this setting existed).
 */
function autoSupportedFor(project: Project | undefined): boolean {
  if (project?.ssh) return useSshConn.getState().supportsAutoPermissionMode(project.id)
  return caps.autoPermissionMode
}

/**
 * The permission mode a session launched RIGHT NOW actually starts in — resolved against an
 * EXPLICIT project rather than the active one. The body `activePermissionMode` always had, split
 * out so a launch into a NON-active project (canvas-control `open-agent --project <B>`, ticket 05)
 * resolves B's override + the `auto` version gate against B — not against the canvas the user is
 * currently looking at. B may be an SSH project, in which case `autoSupportedFor` reads B's remote
 * probe answer (`useSshConn`), exactly as it would for an active SSH project.
 *
 * `agentId` defaults to `'claude'`, so every call site written before a second agent had a
 * permission mode keeps its exact behavior.
 *
 * Lives in its own module rather than in workspace.ts because projects.ts imports workspace.ts
 * (createProject) — importing the projects store from workspace.ts would close that cycle.
 */
/**
 * The same resolution for an EXPLICIT project — the `--project`-targeted opens (issue #338) need
 * the TARGET project's override + gate, not the active one's: a node opened into another project
 * must start with that project's permission mode (spec §2.2 defaults), never the caller's.
 */
export function projectPermissionMode(
  project: Project | undefined,
  agentId: AgentId = 'claude'
): AgentPermissionMode {
  const { settings } = useSettings.getState()
  const mode = resolvePermissionMode(project, settings)
  // The version gate is CLAUDE-specific BY CONSTRUCTION: it exists because Claude Code < 2.1.71
  // exits 1 on `--permission-mode auto`, and it is fed by a `claude --version` probe (local, or the
  // SSH host's). grok has accepted every mode we emit since 1.0.0, its first release, so applying
  // the gate to it would downgrade a grok session to `default` on a machine whose CLAUDE is old —
  // or absent entirely. An agent that needs its own gate adds it here, beside this one, rather than
  // inheriting claude's.
  return agentId === 'claude' ? gatePermissionMode(mode, autoSupportedFor(project)) : mode
}

/**
 * The permission mode a session launched RIGHT NOW actually starts in: the active project's
 * override, else the global setting — with `auto` degraded to `manual` (no flag → bare command)
 * when the CLI that will run it is too old to know the value (Claude Code < 2.1.71, which exits 1
 * on it) or hasn't been probed yet. The other four modes are never touched by the gate.
 *
 * Thin wrapper over `projectPermissionMode` that resolves the active project; the two share one
 * body so a launch into a background project and a launch into the active one can never diverge.
 */
export function activePermissionMode(agentId: AgentId = 'claude'): AgentPermissionMode {
  const { getProject, activeProjectId } = useProjects.getState()
  return projectPermissionMode(getProject(activeProjectId), agentId)
}

/** How long a launch on an SSH project may wait for the REMOTE probe's first answer. The probe
 *  fires right after connect and pushes every attempt's answer immediately, so this usually
 *  resolves in the first couple of seconds; the cap keeps a dead probe from stalling a relaunch. */
export const SSH_AUTO_PROBE_WAIT_MS = 10_000

/** Resolve once the project's remote probe has ANY answer (yes/no), or after `ms`. Fail-open:
 *  a timeout just means the caller gates on 'unknown' — bare command, never a blocked launch. */
function waitForSshAutoAnswer(projectId: string, ms: number): Promise<void> {
  if (useSshConn.getState().autoPermAnswer(projectId) !== 'unknown') return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const unsub = useSshConn.subscribe((s) => {
      if (s.autoPermByProject[projectId] !== undefined) finish()
    })
    const timer = setTimeout(finish, ms)
  })
}

/**
 * `activePermissionMode()` for callers that can run BEFORE the boot-time probe has answered — the
 * cold-restore agent relaunch fires on node mount. Awaiting the (memoized, warmed in the shell)
 * probe there means a rebooted machine still gets `auto`, instead of silently falling back to the
 * bare command for one session.
 *
 * On an SSH project the gate consults the REMOTE probe, which races the same mount (it fires
 * after connect, through a slow login shell) — so when the resolved mode is `auto`, this also
 * waits (bounded) for that probe's first answer. Any other mode never waits: the gate only ever
 * touches `auto`.
 *
 * BOTH waits are for claude's gate, and nothing else — so a non-claude agent waits on neither:
 * blocking a grok launch on a `claude --version` probe (or on an SSH host's claude probe, which on
 * a host without claude never answers at all) would be a delay bought for no decision.
 */
export async function ensureActivePermissionMode(
  agentId: AgentId = 'claude'
): Promise<AgentPermissionMode> {
  if (agentId !== 'claude') return activePermissionMode(agentId)
  await ensureClaudeCliCaps()
  const { settings } = useSettings.getState()
  const { getProject, activeProjectId } = useProjects.getState()
  const project = getProject(activeProjectId)
  if (project?.ssh && resolvePermissionMode(project, settings) === 'auto') {
    await waitForSshAutoAnswer(project.id, SSH_AUTO_PROBE_WAIT_MS)
  }
  return activePermissionMode('claude')
}

/**
 * Why `auto` may not apply on this SSH project, for the tab menu's Auto rows — null when the
 * remote CLI is confirmed and Auto works as chosen. The silent fail-open degrade is correct for
 * launches but indistinguishable from "the dropdown is broken" without this.
 *
 * Every sentence names CLAUDE explicitly: the gate this describes is claude's alone (grok accepts
 * `auto` on every version), so an unprefixed warning on a project that also runs grok sessions
 * would read as a limitation of the mode itself.
 */
export function sshAutoModeHint(
  answer: SshAutoPermAnswer,
  version: string | null | undefined
): string | null {
  if (answer === 'yes') return null
  if (answer === 'no') {
    const v = version?.match(/\d+\.\d+\.\d+/)?.[0]
    return v
      ? `The server's Claude CLI is ${v} — Auto needs ${AUTO_PERMISSION_MODE_MIN_VERSION} or newer, so Claude sessions start without a mode flag until it is upgraded.`
      : 'Claude CLI was not found on the server, so Auto cannot apply to Claude sessions — they start without a mode flag.'
  }
  return `Claude sessions: not verified on this server yet — Auto applies to them once the server's Claude CLI (≥ ${AUTO_PERMISSION_MODE_MIN_VERSION}) is confirmed.`
}
