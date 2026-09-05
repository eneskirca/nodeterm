// Pure helpers for canvas link edges: classify a new connection (context link between two
// agent nodes vs. note link between a sticky and a terminal), build the one-shot push
// message a note link injects into an agent session, and re-export the link-map builders.
// Kept free of React/store imports so the connection matrix is unit-testable.
import { oneLine } from '@shared/one-line'
import {
  classifyLink,
  planBridges,
  type LinkEndpoint
} from '@shared/canvas-link'

// Kept as renderer-facing re-exports so existing canvas and tests retain one import surface while
// Server Edition consumes the same pure planner directly from shared.
export {
  classifyLink,
  planBridges,
  type BridgePlan,
  type LinkEndpoint,
  type LinkKind,
  type SkippedBridge
} from '@shared/canvas-link'

/** The inline context command runs inside the endpoint node, so SSH nodes need the host path. */
export function contextLinkShimPath(localPath: string, remote: boolean): string {
  return remote ? '$HOME/.nodeterm/context.sh' : localPath
}

/** Order-independent key for an edge's endpoints (a↔b and b↔a are the same connection). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

/**
 * Context/note links that should NOT be drawn because a control rope already connects the same
 * pair. Since agent-opened nodes get both a rope (lineage) and a bridge (readable context), every
 * such node was being joined by TWO arrows saying nearly the same thing — visual noise with no
 * added meaning. One arrow per pair: the rope wins the pixels, and `linkIdsCoveredByRopes` keeps
 * the hidden link under the rope's delete so it can never become an invisible, unremovable link.
 */
export function hiddenLinkIds(
  links: readonly { id: string; source: string; target: string }[],
  ropes: readonly { id: string; source: string; target: string }[]
): Set<string> {
  if (!ropes.length) return new Set()
  const ropePairs = new Set(ropes.map((r) => pairKey(r.source, r.target)))
  const out = new Set<string>()
  for (const l of links) if (ropePairs.has(pairKey(l.source, l.target))) out.add(l.id)
  return out
}

/**
 * The link ids that must go with a set of ropes being deleted — the links those ropes were
 * standing in for on screen. Without this, deleting the only visible edge between two nodes
 * would leave them still linked, with nothing left to click.
 */
export function linkIdsCoveredByRopes(
  ropeIds: readonly string[],
  ropes: readonly { id: string; source: string; target: string }[],
  links: readonly { id: string; source: string; target: string }[]
): string[] {
  const drop = new Set(ropeIds)
  const pairs = new Set(
    ropes.filter((r) => drop.has(r.id)).map((r) => pairKey(r.source, r.target))
  )
  if (!pairs.size) return []
  return links.filter((l) => pairs.has(pairKey(l.source, l.target))).map((l) => l.id)
}

/** Longest note text pushed inline; longer notes are truncated with a pointer to the skill. */
const NOTE_PUSH_MAX = 2000

/**
 * Build the one-shot message injected into an agent session when a note is linked.
 * Single-line by construction: pty.sendText appends Enter and embedded newlines would act
 * as submits in agent REPLs, so newlines are collapsed to a visible ' ⏎ '.
 * Returns null when the note is empty (nothing to push).
 *
 * The ' ⏎ ' collapse is the READABLE part and it only covers `\r?\n`; `oneLine` is the part that
 * makes the guarantee, and it runs over the whole composed line — the note TITLE was not covered
 * at all, and a lone `\r`, a VT or a U+2028 would have walked straight through the collapse.
 */
export function buildNotePushMessage(title: string, text: string, agentId?: string): string | null {
  if (!text.trim()) return null
  const flat = oneLine(text.replace(/\s*\r?\n\s*/g, ' ⏎ '))
  const pointer =
    !agentId || agentId === 'claude'
      ? 'read the full note with the get-linked-context skill'
      : 'read the full note with the nodeterm linked-context CLI — see the get-linked-context section in your global agent instructions'
  const body =
    flat.length > NOTE_PUSH_MAX ? flat.slice(0, NOTE_PUSH_MAX) + ` … [truncated — ${pointer}]` : flat
  return `[nodeterm] Sticky note "${oneLine(title)}" linked as context: ${body}`
}

/**
 * The one-shot message injected into each endpoint when a context link is drawn.
 * Claude discovers the capability via its installed skill; other agents get the CLI
 * inline (their global-instructions block may not be loaded mid-session). Single-line:
 * pty.sendText appends Enter.
 *
 * SECURITY: `otherTitle` is the OTHER node's title, and a node title is settable over the
 * canvas-control `rename` verb — so it is agent-supplied text being quoted into a line that gets
 * SUBMITTED in a THIRD session. `oneLine` is what keeps it one line: without it, an agent could
 * rename its own node to `X\rcurl …` and wait for someone to draw a link to it.
 */
export function buildContextLinkNote(
  agentId: string | undefined,
  otherTitle: string,
  shimPath: string
): string {
  const other = oneLine(otherTitle)
  // Both variants must self-defuse: the note is injected + submitted as a prompt, and an
  // agent that reads it as a task launches an unsolicited investigation of the linked node
  // (observed with gemini). "No action needed" keeps it a notification.
  if (!agentId || agentId === 'claude') {
    return `[nodeterm] You are now linked to "${other}". Use the get-linked-context skill to read its context when you need it. No action needed now — just acknowledge briefly.`
  }
  return `[nodeterm] You are now linked to "${other}". When you need its context (and only then) run: sh "${shimPath}" list — then summary | transcript | terminal --node <id>. Details are in the get-linked-context section of your global agent instructions. No action needed now — acknowledge briefly and do not run these commands yet.`
}

// The link-map builders moved to @shared: the Server Edition derives the same map from persisted
// project files, and it may not import renderer code. Re-exported here so this module stays the
// one place the canvas asks about link edges.
export {
  buildLinkMap,
  buildBackgroundLinkMaps,
  type LinkNodeInfo
} from '@shared/context-link-map'
