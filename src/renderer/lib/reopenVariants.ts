import {
  AGENT_CONFIG,
  canResume,
  type AgentId,
  type BuiltinAgentId,
} from "@shared/agents/config";
import type { CustomAgent } from "@shared/types";
import { resolveAgentBase } from "@shared/agents/custom-agent";

/**
 * One agent a node could reopen its current session id AS, in place, by swapping the CLI that
 * resumes it. All variants share the source's base harness (`capabilityAgentId`), because a
 * provider session id is resumable only by a binary of the harness that minted it — a claude id
 * resumes under plain `claude` OR a custom `baseAgent: 'claude'` agent's binary, never under
 * `codex`. The list is the base harness itself plus every enabled custom agent inheriting it,
 * minus the node's own current agent (no "reopen as yourself").
 */
export interface ReopenVariant {
  id: AgentId;
  label: string;
  base: BuiltinAgentId;
}

/**
 * The same-base variants a node running `sourceAgentId` could reopen its session id as. Returns
 * `[]` when the source's base is not resumable (`canResume` resolves through
 * `capabilityAgentId`, so a claude-base custom passes; a baseless custom or a plain shell does
 * not) — only a resumable base offers reopen-by-id. Mirrors the Dock's `inheritingByBase`
 * grouping (`Dock.tsx`): the base builtin, then its inheriting enabled customs, with the source
 * and any disabled agent filtered out.
 *
 * Pure + unit-tested; Canvas wraps it in setState.
 */
export function reopenVariants(
  sourceAgentId: AgentId,
  customAgents: readonly CustomAgent[],
  disabledAgents: readonly AgentId[],
  /** Node-persisted current harness; lets an orphaned custom node reopen as its builtin base. */
  sourceBaseId?: BuiltinAgentId,
): ReopenVariant[] {
  // Resolve from the records passed in rather than the runtime's injected capability resolver.
  // This keeps the helper deterministic in tests and, more importantly, makes a deleted/unknown
  // custom source ineligible instead of guessing that its id is a harness.
  const base = resolveAgentBase(
    sourceAgentId,
    customAgents.find((c) => c.id === sourceAgentId),
    sourceBaseId,
  );
  if (!base || !canResume(base)) return [];

  const disabled = new Set(disabledAgents);
  const out: ReopenVariant[] = [];

  // The base harness itself is a variant (reopen a custom-agent session as the plain harness, or
  // vice versa), unless the source IS the base builtin.
  if (sourceAgentId !== base && !disabled.has(base)) {
    out.push({ id: base, label: AGENT_CONFIG[base].label, base });
  }

  // Every enabled custom agent that inherits this base, minus the source itself.
  for (const c of customAgents) {
    if (c.id === sourceAgentId) continue;
    if (disabled.has(c.id)) continue;
    if (c.baseAgent !== base) continue;
    out.push({ id: c.id, label: c.label, base });
  }

  return out;
}
