// Pure prompt/lens logic for the canvas-control `verify` verb: a panel of independent reviewers,
// one per LENS, each reading the same target node's work and looking for a different class of
// problem. Diversity is the point — N identical reviewers correlate their mistakes and mostly
// agree with each other, which reads as confirmation while adding no evidence.
//
// Kept free of React/store imports so the lens table and the prompt wording are unit-testable.

import { canContextLink, hasHooks, type AgentId } from '@shared/agents/config'

/** Why an agent cannot participate in an automatically sequenced verification panel. */
export function verifyAgentBlockReason(
  agentId: AgentId
): 'cannot-read' | 'cannot-report-done' | null {
  if (!canContextLink(agentId)) return 'cannot-read'
  if (!hasHooks(agentId)) return 'cannot-report-done'
  return null
}

/** Lens id → what that reviewer is told to hunt for. */
const LENS_BRIEFS: Record<string, string> = {
  correctness:
    'logic that is wrong or incomplete — bad assumptions, unhandled inputs, off-by-one and boundary cases, error paths that silently swallow failure',
  security:
    'unsafe handling — injection through interpolated shell/SQL/paths, missing authorization, secrets or tokens that leak into logs, args or files, and input trusted because of where it came from',
  tests:
    'whether the tests actually prove what they claim — assertions that would still pass if the code were broken, missing cases for the paths that matter, and behaviour covered only by its own mock',
  performance:
    'work that will not scale — accidental quadratic loops, per-item queries or subprocesses, blocking calls on a hot path, and unbounded growth',
  regression:
    'existing behaviour this could break — callers and call sites that were not updated, persisted data written in a shape older readers cannot parse, and defaults that silently changed',
  repro:
    'whether the claimed result is real — actually run it, and report exactly what you observed versus what was claimed'
}

/** The panel used when `--lenses` is not given. */
export const DEFAULT_LENSES = ['correctness', 'security', 'tests']

/** Hard cap on panel size (matches spawn-team's role cap). */
export const MAX_LENSES = 6

/**
 * Parse and clean a `--lenses a,b,c` list. Unknown lens words are KEPT (they get a generic
 * brief) rather than rejected: "does this work offline", "accessibility" and "i18n" are
 * perfectly good review angles, and a table that only accepts what it already knows would
 * make the verb useless for the reviews nobody anticipated.
 */
export function parseLenses(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of list.length ? list : DEFAULT_LENSES) {
    if (seen.has(l)) continue
    seen.add(l)
    out.push(l)
    if (out.length >= MAX_LENSES) break
  }
  return out
}

/** How a given agent is told to read a linked node's work. */
function readInstruction(agentId: string | undefined, shimPath: string): string {
  return !agentId || agentId === 'claude'
    ? 'read its work with the get-linked-context skill (summary first, then transcript if you need detail)'
    : `read its work by running: sh "${shimPath}" summary --node <id> (then transcript --node <id> for detail) — see the get-linked-context section of your global agent instructions`
}

/**
 * The starting prompt for one lens reviewer.
 *
 * Two guardrails are deliberate. **Read-only**: a panel is several agents pointed at one
 * checkout, so a reviewer that "just fixes it" races the others into the same files — review
 * and repair are separate jobs, and only the repair one needs isolation. **Permission to find
 * nothing**: a reviewer under implicit pressure to produce findings invents them, and invented
 * findings are worse than none because they cost someone else the time to disprove.
 */
export function verifyLensPrompt(opts: {
  lens: string
  targetTitle: string
  targetId: string
  agentId?: string
  shimPath: string
  focus?: string
}): string {
  const brief = LENS_BRIEFS[opts.lens] ?? `problems of this kind: ${opts.lens}`
  const focus = opts.focus?.trim() ? ` The work under review is specifically about: ${opts.focus.trim()}.` : ''
  return [
    `You are one reviewer on a verification panel, looking at the work of the linked node "${opts.targetTitle}" (${opts.targetId}) through a single lens: ${opts.lens}.`,
    `First ${readInstruction(opts.agentId, opts.shimPath)}, and read enough of the actual code it touched to judge it for yourself rather than trusting its summary.${focus}`,
    `Then hunt specifically for ${brief}.`,
    `Report only what you can point at — a file:line, a concrete input that breaks it, or a command you ran and its output. If this lens turns up nothing real, say "nothing found" and stop; do not pad the report to look thorough.`,
    `Do NOT change any files and do NOT fix anything — other reviewers are reading the same checkout right now, and repairing is a separate job from finding.`
  ].join(' ')
}

/** The starting prompt for the panel's judge, which runs once every reviewer has gone idle. */
export function verifySynthesisPrompt(opts: {
  lenses: string[]
  targetTitle: string
  agentId?: string
  shimPath: string
}): string {
  return [
    `You are the judge of a verification panel on the work of "${opts.targetTitle}". ${opts.lenses.length} reviewers each examined it through one lens: ${opts.lenses.join(', ')}.`,
    `Each reviewer is linked to you — ${readInstruction(opts.agentId, opts.shimPath)} for each of them.`,
    `Then produce ONE verdict: drop every finding the reviewer could not point at concretely, merge the duplicates that several lenses reported, and rank what survives by what it would actually cost to ship.`,
    `Say plainly which lenses found nothing, and say plainly if nothing survived at all — an empty verdict is a real result, not a failed one.`,
    `Do NOT fix anything; report.`
  ].join(' ')
}
