// Pure helpers for canvas link edges: classify a new connection (context link between two
// agent nodes vs. note link between a sticky and a terminal), build the one-shot push
// message a note link injects into an agent session, and re-export the link-map builders.
// Kept free of React/store imports so the connection matrix is unit-testable.
import type { Link } from '@shared/types'
import { oneLine } from '@shared/one-line'

export interface LinkEndpoint {
  /** React Flow node type: 'terminal' | 'sticky' | 'editor' | … */
  kind: string
  /** Terminal node whose agent is CONTEXT_LINK_CAPABLE (claude/codex/gemini). */
  contextCapable: boolean
}

export type LinkKind = 'context' | 'note'

/** Decide what kind of link (if any) a new edge between two nodes forms. */
export function classifyLink(a: LinkEndpoint, b: LinkEndpoint): LinkKind | null {
  const stickies = (a.kind === 'sticky' ? 1 : 0) + (b.kind === 'sticky' ? 1 : 0)
  if (stickies === 0) return a.contextCapable && b.contextCapable ? 'context' : null
  if (stickies === 2) return null
  const other = a.kind === 'sticky' ? b : a
  return other.kind === 'terminal' ? 'note' : null
}

/**
 * Project a {@link Link} down to the `{ id, source, target }` node-id pair the renderer's edge
 * state + the rope-cover helpers reason in. Returns `null` for a link whose endpoints are not BOTH
 * `ref:'node'` (an `xnode` cross-project target or a `branch` dependency endpoint) — such a link
 * has no on-canvas node pair to draw or to share a rope with. On-canvas context/lineage links are
 * always node↔node today; the null branch is the seam tickets 03/04/05 extend through.
 */
export function nodeEndpoints(link: Link): { id: string; source: string; target: string } | null {
  if (link.source.ref !== 'node' || link.target.ref !== 'node') return null
  return { id: link.id, source: link.source.nodeId, target: link.target.nodeId }
}

/** Build a `kind:'context'` node↔node link with a stable id (the `bridge-` prefix is kept for
 *  back-compat with any persisted id a migrated file already carries). */
export function contextLink(source: string, target: string, note?: string): Link {
  return {
    id: `bridge-${source}-${target}`,
    kind: 'context',
    source: { ref: 'node', nodeId: source },
    target: { ref: 'node', nodeId: target },
    ...(note != null ? { meta: { note } } : {})
  }
}

/** Build a `kind:'lineage'` (display-only rope) node↔node link with a `ctrl-` id. */
export function lineageLink(source: string, target: string): Link {
  return {
    id: `ctrl-${source}-${target}`,
    kind: 'lineage',
    source: { ref: 'node', nodeId: source },
    target: { ref: 'node', nodeId: target },
    meta: { displayOnly: true }
  }
}

/** Build a `kind:'dependency'` node↔node link with a `dep-` id. Used by the meta-canvas submodule
 *  auto-link (ticket 09): a same-canvas `dependency` edge between two `projectRef` group frames.
 *  Unlike the cross-project/branch dependency links (off-canvas, inspector-only), a node↔node
 *  dependency is a real on-canvas edge — `linksToRuntime` renders it (amber, dashed) and
 *  `runtimeToLinks` round-trips it, so it survives the load→commit cycle. */
export function dependencyLink(source: string, target: string): Link {
  return {
    id: `dep-${source}-${target}`,
    kind: 'dependency',
    source: { ref: 'node', nodeId: source },
    target: { ref: 'node', nodeId: target }
  }
}

/** One node the plan refused to link, with the reason to report back to the caller. */
export interface SkippedBridge {
  id: string
  why: string
}

export interface BridgePlan {
  /** Links to append (already deduped against `existing` AND within the batch). */
  edges: Link[]
  linked: string[]
  skipped: SkippedBridge[]
}

/**
 * Plan the link edges connecting `fromId` to each of `targetIds` — the batch form of what
 * onConnect does for one hand-drawn edge, used by the canvas-control `link` verb and by the
 * open-agent / spawn-team fan-out (which link every session they open back to the opener).
 *
 * Pure so the refusal matrix is testable: the callers live inside Canvas.tsx, where node
 * lookup is a ref read and the result is a setState. `lookup` is injected because a caller
 * that links nodes it created in the SAME tick cannot resolve them off the canvas yet
 * (setNodes is async), and `existing` is passed in rather than read, so a batch also dedupes
 * against itself and not just against what is already on screen.
 *
 * `existing` is a node-pair projection (`{source, target}[]`) of the links already on screen,
 * not `Link[]` — dedup is endpoint-pair based and a caller holds the projection already.
 */
export function planBridges(
  fromId: string,
  targetIds: string[],
  lookup: (id: string) => LinkEndpoint | null,
  existing: readonly { source: string; target: string }[]
): BridgePlan {
  const edges: Link[] = []
  const linked: string[] = []
  const skipped: SkippedBridge[] = []
  const se = lookup(fromId)
  const linkedAlready = (a: string, b: string) =>
    [...existing, ...edges.map((e) => nodeEndpoints(e)!)].some(
      (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)
    )
  for (const tid of targetIds) {
    if (tid === fromId) {
      skipped.push({ id: tid, why: 'same node' })
      continue
    }
    const te = lookup(tid)
    if (!se || !te) {
      skipped.push({ id: tid, why: 'no such node' })
      continue
    }
    const kind = classifyLink(se, te)
    if (!kind) {
      skipped.push({
        id: tid,
        why: 'not linkable (needs two context-capable agents, or a sticky + terminal)'
      })
      continue
    }
    // Note edges are stored sticky→terminal regardless of the direction they were requested
    // in, so styling and the link map can key off "source is sticky" (mirrors onConnect).
    const source = kind === 'note' && te.kind === 'sticky' ? tid : fromId
    const target = source === fromId ? tid : fromId
    if (linkedAlready(source, target)) {
      skipped.push({ id: tid, why: 'already linked' })
      continue
    }
    edges.push(contextLink(source, target))
    linked.push(tid)
  }
  return { edges, linked, skipped }
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
 * Claude discovers the capability via its installed skill; codex/gemini get the CLI
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
  mergeContextLinkMaps,
  type LinkNodeInfo
} from '@shared/context-link-map'
