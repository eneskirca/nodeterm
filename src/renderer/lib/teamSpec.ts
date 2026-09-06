// Pure parser for `spawn-team --team <json>` (issue #532). One parser, two consumers — the REAL
// spawn path and `--dry-run` — so the dry run can never validate a different grammar than the run
// it stands in for (the rot the issue warns about: a hand-maintained "validate only" copy drifts).
//
// It exists because the old inline parse made every mistake SILENT: a role missing a `prompt` was
// filtered out (the team opened short, nobody said which role vanished), a ninth role was sliced
// off, a typo'd `agent` id opened a broken node that failed only inside its pane. Each of those is
// now a named refusal — the caller learns which role and which field, before anything opens.
import { promptFilePathError } from '@shared/agents/launch'

export const TEAM_MAX_ROLES = 8

export interface TeamRole {
  title?: string
  prompt?: string
  promptFile?: string
  /** Defaulted to 'claude' when the role names none — the historical behavior, made explicit. */
  agent: string
  model?: string
}

export type TeamSpecResult = { ok: true; roles: TeamRole[] } | { ok: false; error: string }

const SHAPE = '{title?, prompt|promptFile, agent?, model?}'

/** A role's name for an error message: its title when it has one, else its 1-based position. */
function roleName(r: { title?: unknown }, i: number): string {
  return typeof r.title === 'string' && r.title.trim() ? `"${r.title.trim()}"` : `#${i + 1}`
}

/**
 * Parse + validate a `--team` payload. `knownAgentIds` is the full agent inventory (builtins +
 * the user's custom agents): a role naming anything else is refused HERE, at parse time, instead
 * of opening a node whose launch command is a typo — the exact "validated by running it" cost
 * issue #532 names. Error messages are bare (no `spawn-team:` prefix — the caller adds it).
 */
export function parseTeamSpec(raw: string, knownAgentIds: ReadonlySet<string>): TeamSpecResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    return { ok: false, error: `--team is empty — pass a JSON array of ${SHAPE} role objects` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error:
        `--team is not valid JSON (${why}). Expected a JSON array of ${SHAPE} role objects — ` +
        `quote the whole value in the shell: --team '[{"title":"UI","prompt":"..."}]'`
    }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `--team must be a JSON ARRAY of ${SHAPE} role objects, not a ${typeof parsed === 'object' ? 'single object' : typeof parsed}` }
  }
  if (parsed.length === 0) {
    return { ok: false, error: '--team needs at least one role with a prompt (or promptFile)' }
  }
  if (parsed.length > TEAM_MAX_ROLES) {
    return {
      ok: false,
      error: `--team has ${parsed.length} roles — max ${TEAM_MAX_ROLES} per call; split into two calls`
    }
  }
  const roles: TeamRole[] = []
  for (const [i, r] of parsed.entries()) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      return { ok: false, error: `role #${i + 1} is not an object (${SHAPE})` }
    }
    const role = r as Record<string, unknown>
    const name = roleName(role, i)
    for (const field of ['title', 'prompt', 'promptFile', 'agent', 'model'] as const) {
      if (role[field] !== undefined && typeof role[field] !== 'string') {
        return { ok: false, error: `role ${name}: "${field}" must be a string` }
      }
    }
    const prompt = typeof role.prompt === 'string' ? role.prompt.trim() : ''
    const promptFile = typeof role.promptFile === 'string' ? role.promptFile.trim() : ''
    if (prompt && promptFile) {
      return { ok: false, error: `role ${name}: pass either "prompt" or "promptFile", not both` }
    }
    if (!prompt && !promptFile) {
      return {
        ok: false,
        error: `role ${name} is missing a non-empty "prompt" (or "promptFile") — every member needs a starting task`
      }
    }
    if (promptFile) {
      const pfErr = promptFilePathError(promptFile)
      if (pfErr) return { ok: false, error: `role ${name}: promptFile ${pfErr}` }
    }
    const agent = typeof role.agent === 'string' && role.agent.trim() ? role.agent.trim() : 'claude'
    if (!knownAgentIds.has(agent)) {
      return {
        ok: false,
        error: `role ${name}: unknown agent "${agent}" — known agents: ${[...knownAgentIds].join(', ')}`
      }
    }
    roles.push({
      ...(typeof role.title === 'string' && role.title.trim() ? { title: role.title.trim() } : {}),
      ...(prompt ? { prompt } : {}),
      ...(promptFile ? { promptFile } : {}),
      agent,
      ...(typeof role.model === 'string' && role.model.trim() ? { model: role.model.trim() } : {})
    })
  }
  return { ok: true, roles }
}
