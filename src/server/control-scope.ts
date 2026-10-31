import type { AgentState } from '../shared/agents/normalize'

/**
 * Which nodes a Server Edition canvas-control caller may read and act on.
 *
 * - `creator` (the default): the caller's own node and the nodes it spawned during THIS server run
 *   (the process-local creator ledger). This is the 2026-08 incident hardening: an agent changed
 *   and closed nodes it had not opened. A restart empties the ledger, so after one nothing is
 *   actionable until the caller opens new nodes.
 * - `project`: every node of the caller's OWN project — `list`, the metadata verbs, `link`,
 *   `group`, `run`, messaging and `close` — whoever opened it and whenever. Opt-in by the OPERATOR
 *   only (`--control-scope` / `NODETERM_SERVER_CONTROL_SCOPE`): never settings.json and never the
 *   `settings` verb, because an agent must not be able to widen its own reach.
 *
 * What `project` keeps, because the Server Edition has no human to confirm a `close`:
 * - a caller never closes ITSELF;
 * - a node whose agent is working or waiting on a person (NEEDS YOU) is closed only with
 *   `--force yes` — the turn and anything typed into its prompt end with the session;
 * - a node id present in more than one project (one committed canvas opened from two folders) is
 *   refused: its tmux session is keyed by id alone and belongs to both.
 * Automatic input (an `--after` release, a boot-time held launch) still needs creator proof in
 * either scope: it is not something the caller asked for in this request.
 */
export type ControlScope = 'creator' | 'project'

export const CONTROL_SCOPES: readonly ControlScope[] = ['creator', 'project']

/** Parse the operator's value. Absent/empty = `creator`; anything else unknown fails the boot —
 *  a typo must not silently pick a scope. */
export function parseControlScope(raw: string | undefined): ControlScope {
  const value = (raw ?? '').trim().toLowerCase()
  if (value === '') return 'creator'
  if ((CONTROL_SCOPES as readonly string[]).includes(value)) return value as ControlScope
  throw new Error(
    `--control-scope / NODETERM_SERVER_CONTROL_SCOPE must be one of ${CONTROL_SCOPES.join(', ')} (got "${raw}")`
  )
}

/** A session that is mid-turn or waiting on a person: closing it ends work in progress. */
export function isBusyAgentState(state: AgentState | undefined): boolean {
  return state === 'working' || state === 'waiting' || state === 'blocked'
}

/** `close --force <yes|no>` — every flag takes a value (an SSH host may run an older shim loop). */
export function parseForceFlag(raw: string | undefined): boolean | { error: string } {
  if (raw === undefined) return false
  const v = raw.trim().toLowerCase()
  if (v === 'yes' || v === 'true' || v === '1' || v === 'on') return true
  if (v === 'no' || v === 'false' || v === '0' || v === 'off') return false
  return { error: `close: --force takes yes or no (got "${raw}")` }
}
