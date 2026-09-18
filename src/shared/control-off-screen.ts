// WHAT A CONTROL VERB DOES WHEN ITS OWN PROJECT IS NOT THE ONE ON SCREEN.
//
// IN `src/shared` BECAUSE IT HAS THREE SIDES, which is the whole reason this file exists rather
// than living beside the dispatch that reads it:
//
//   - the RENDERER's dispatch (`renderer/canvas/Canvas.tsx`, via `renderer/lib/controlRouting.ts`)
//     branches on it,
//   - CORE renders the agent-facing help from it (`core/canvas-control-core.ts` —
//     `buildCanvasSkillBody` and `buildCanvasControlInstructions`, the two texts orchestrating
//     agents actually read), and core cannot import the renderer,
//   - the cross-layer guard walks it against main's verb table
//     (`test/acceptance/control-verb-disposition.test.ts`).
//
// CLAUDE.md's rule for this subsystem is derive, never re-type: "a doc line with no such test is a
// plan, not a fact — see the drift that shipped as #269". A verb's off-screen behaviour is
// precisely the kind of fact a prose sentence forgets. So the table is here, once, and the help
// text is rendered from it.
//
// THE INVARIANT IT ENCODES: nothing an agent asks for may activate a project tab. Routing is by
// SOURCE — the request names the agent's own node, and the dispatch has to find the canvas that
// owns it — and for a long time the answer to "that canvas is not on screen" was to travel there.
// The user was typing in project B; a background agent in project A issued a `close`; the tab
// switched and A's SAVED viewport was applied, so their focus, camera and typing context were
// taken by a call they did not make. Two carve-outs were added over the years and each was
// written as if it were the last, because nothing walked the whole table.

/**
 * Verbs that are answered from the SERIALIZED store instead of the live canvas.
 *
 * `list` reads names only, and it is the verb an agent calls most — answering it out of the store
 * keeps a background agent's polling from yanking the user's view to another project tab on every
 * call.
 *
 * `send`/`reply` are here for a stronger reason than politeness, and it is worth being precise
 * about WHICH travel this prevents: routing here is by SOURCE
 * (`routeControlSource(projects, activeId, sourceNodeId)`), so what the declaration stops is a trip
 * to the SENDER's project — which an off-canvas orchestrator would otherwise trigger on every
 * message it sent, hijacking the human's view on a background agent's say-so and clearing that
 * node's unread badge via `setActive` on the way (G5). A delivery goes to a tmux PANE, not to a
 * canvas, so it needs no live canvas at either end.
 *
 * The other half — never travelling to the TARGET's project — is not this function's doing. It
 * comes from `resolveDeliveryScope` (`src/core/agents/agent-message-scope.ts`) taking the
 * serialized store and having no live-node parameter at all, so there is nothing to travel toward.
 *
 * LIVE AS OF PR 5: Canvas.tsx's dispatch handles `send`/`reply` BEFORE its source-routing
 * machinery, so neither `routeControlSource` nor any travel runs for them — the declaration here
 * and that early-exit are the same decision stated once each, and `controlRouting.test.ts` pins
 * this half.
 */
/*
 * `sticky` is store-answered for the send/reply reason, not the list reason: its headline use is
 * a SCHEDULED agent rewriting one note every few minutes, and routing is by SOURCE — so a live
 * requirement would yank the human's view to the sync agent's project on every run (G5), which is
 * exactly the behaviour that gets the sync loop turned off. The write lands in the owning
 * project's serialized nodes (`applyNodeMutation`, the same path peer mutations take) when that
 * project is not the active one; the live canvas handles it when it is.
 */
/*
 * `open-project` (issue #338) is store-answered for the G5 reason in its sharpest form: its
 * headline caller is a background orchestrator registering one repo after another, and routing is
 * by SOURCE — a live requirement would yank the human's view to the CALLER's project on every
 * registration (and clear its unread badge via `setActive` on the way). The verb acts on the
 * projects STORE through the non-activating `registerProject`, and its consent dialog is
 * app-global (`ConfirmState` overlays the window), so no live canvas is needed at either end.
 * Canvas.tsx handles it BEFORE the source-routing machinery — this declaration and that
 * early-exit are the same decision stated once each (spec §2.3, P6), pinned by
 * `controlRouting.test.ts`.
 */
/*
 * `notify` rides in `send`/`reply`'s early-exit block and always has — it is the same delivery
 * with a different destination (an OS notification rather than a pane), so no canvas is needed at
 * either end. It was simply never DECLARED here, which made it invisible to anything reasoning
 * about the table; `test/acceptance/control-verb-disposition.test.ts` is what found it. Declaring
 * it changes no behaviour (it returns above the routing block), and undeclaring it again would
 * make the only verb whose code and table disagree.
 */
const STORE_ANSWERED_VERBS: ReadonlySet<string> = new Set([
  'list',
  'send',
  'reply',
  'notify',
  'sticky',
  'open-project',
  // Reads settings.json and the projects store, and its dialog is app-global — no canvas at either
  // end, and a background agent asking must never travel the user's view (@shared/settings-verb).
  'settings'
])

/**
 * Does this verb have to run against the LIVE canvas? Everything that creates, moves, writes to or
 * closes a node does.
 */
export function needsLiveCanvas(verb: string): boolean {
  return !STORE_ANSWERED_VERBS.has(verb)
}

/**
 * Verbs that CREATE a session and can therefore be answered by writing into the owning project's
 * SERIALIZED nodes instead of activating its tab.
 *
 * The relationship to `STORE_ANSWERED_VERBS` is the whole point, and the two sets are disjoint
 * (pinned in `controlRouting.test.ts`):
 *
 *   - `STORE_ANSWERED_VERBS` — "no canvas is needed at either end". `list` reads names, `send`/
 *     `reply` deliver into a tmux PANE, `sticky` rewrites a note, `open-project` acts on the
 *     projects store. `needsLiveCanvas` is false for them and they never route at all.
 *   - `COLD_OPENABLE_VERBS` — "a canvas IS needed, but the serialized one will do". The node these
 *     verbs create is INERT until its project is next shown: the launch command moves into
 *     `pendingLaunch` (`armForColdOpen`), the node is upserted through `applyNodeMutation`, and the
 *     project's own mount path spawns the PTY and fires the armed launch. `needsLiveCanvas` stays
 *     TRUE for them — they do need a canvas — which is exactly why this is a second, narrower set
 *     rather than four more entries in the first one.
 *
 * WHY (the bug): routing is by SOURCE, so `open-claude` from an agent in a project the user is not
 * looking at travelled the user's view to that project — the camera jumped, the tab switched and
 * the target project's saved viewport was applied, all on a background agent's say-so. That is the
 * same G5 hijack `send`/`reply`/`sticky` are declared here to avoid; the difference is only that an
 * open needs somewhere to put the node, and a project's serialized nodes are somewhere.
 *
 * Deliberately NOT here: every verb that acts on nodes that already exist. Those split between
 * the FOURTH set below (`STORED_NODE_VERBS` — they reach a pane, a store writer or a board, none
 * of which needs React Flow) and an outright refusal (`OFF_SCREEN_REFUSALS` — the structural verbs
 * read live canvas state the serialized copy does not carry: measured node sizes, worktree
 * staleness, a mounted webview). Neither travels. The verbs that create a node with no session
 * behind it are the third set below.
 */
const COLD_OPENABLE_VERBS: ReadonlySet<string> = new Set([
  'open-terminal',
  'open-claude',
  'open-agent'
])

export function canColdOpen(verb: string): boolean {
  return COLD_OPENABLE_VERBS.has(verb)
}

/**
 * Verbs that create a DISPLAY node — one with no session behind it — and can therefore run against
 * the owning project's serialized nodes without that canvas being on screen.
 *
 * The third set, and the reason it is not folded into `COLD_OPENABLE_VERBS`: a cold open has a
 * launch to defer, so it moves the composed command into `pendingLaunch` and tells the caller the
 * session is QUEUED. These four have nothing to defer. A web page, a video, an image and a browser
 * node are inert wherever they sit; writing one into a project's serialized nodes is the whole
 * effect, and it is complete the moment `writeDisk` returns. One set with two contracts inside it
 * is how a caller ends up told a picture is queued.
 *
 * WHY they were still travelling after the cold-open fix: an agent that renders its output as a
 * node — a report as `show-web`, a screenshot as `show-image` — is the commonest reason a
 * background session touches the canvas at all, and every one of those calls yanked the human out
 * of the project they were typing in. Same G5 objection, same answer as the two sets above.
 *
 * Deliberately NOT here: `browser`, which NAVIGATES an existing node and needs a mounted
 * `<webview>` guest to do it. `open-browser` merely places the node; the guest is created when
 * that project is next shown, exactly as a cold-opened terminal's PTY is.
 *
 * None of the four takes `--group`, which is why this set owes no worktree question. A verb
 * joining it that does would: `cwdForNewNodeIn` subtracts the worktree store's `staleGroupIds`,
 * which is epoch-scoped to the ACTIVE project, so off canvas that subtraction cannot be made.
 */
const OFF_CANVAS_VERBS: ReadonlySet<string> = new Set([
  'show-image',
  'show-video',
  'show-web',
  'open-browser'
])

export function answersOffCanvas(verb: string): boolean {
  return OFF_CANVAS_VERBS.has(verb)
}

/**
 * Verbs that act on nodes that ALREADY EXIST and can be answered against the owning project's
 * SERIALIZED nodes — the fourth set, and the one that finishes the job the three above started.
 *
 * THE BUG, in full. Routing is by SOURCE, and until this set existed everything outside the three
 * sets above fell through to `travelToProject`. So: the user is typing in project B; a background
 * agent in project A — a scheduled run, an orchestrator, a session re-adopted at boot — issues a
 * `close`, a `write`, a `rename`. The tab switches, project A's SAVED viewport is applied, and the
 * camera appears to jump. Their focus, their camera and their typing context are taken by a call
 * they did not make. Twenty-one verbs did it; the two carve-outs above were added without anyone
 * noticing the rest, because nothing pinned the whole table.
 *
 * WHAT MAKES THESE FOUR-PLUS-THREE ANSWERABLE OFF SCREEN: none of them needs React Flow. Each one
 * reaches something that is screen-independent and has a serialized counterpart:
 *
 *   - `write` reaches a tmux PANE through main and never touches the canvas at all — it does not
 *     so much as look a node up. It is on this list only because it used to travel to get here.
 *   - `close` ends a tmux session (`transport.destroy` resolves a REMOTE node's host from the
 *     persisted index, with no live client — see core/remote-end.ts) and drops the node through
 *     the store's `removeNode`. That is the cross-project teardown the sessions sidebar has always
 *     used for a node in a project that is not on screen; `closeStoredNodes` is now the one copy.
 *   - `rename` / `color` have dedicated store writers (`renameNode` / `recolorNode`) that mutate
 *     the serialized node directly, with no round-trip through the serializers.
 *   - `link` writes persisted `bridges`, which `appendCanvasLinks` appends to a non-active project —
 *     the same call the cold open already makes for the rope and bridge it owes.
 *   - `board` is a read, and `assign` writes board METADATA through `setProjectKanban`. Both used
 *     to read `activeProjectId`, which off canvas was a second bug hiding behind the first: after
 *     the travel the two projects were the same, so the wrong read was never wrong in practice.
 *
 * Deliberately NOT here — and these REFUSE rather than travel, see `offScreenDisposition`: the
 * structural verbs. A refusal an agent can act on is strictly better than hijacking the human's
 * screen, and every one of these would have to guess at something the serialized copy does not
 * carry.
 */
const STORED_NODE_VERBS: ReadonlySet<string> = new Set([
  'write',
  'close',
  'rename',
  'color',
  'link',
  'board',
  'assign'
])

export function answersFromStoredNodes(verb: string): boolean {
  return STORED_NODE_VERBS.has(verb)
}

/**
 * Why a verb cannot be answered while its own project is off screen — one sentence per verb, which
 * is also the sentence the agent is told. Written per verb rather than as one generic line because
 * the caller's next move differs: an `arrange` can wait for the human, a `branch` cannot happen at
 * all until that terminal is mounted.
 *
 * The rule these encode: NOTHING an agent asks for may activate a project tab. Where that leaves a
 * verb unable to act, it says so.
 */
const OFF_SCREEN_REFUSALS: Readonly<Record<string, string>> = {
  // The five structural verbs rewrite the WHOLE node array through React Flow's parent/extent
  // model and re-fit frames from MEASURED sizes (`nodeW`/`nodeH` prefer `measured` over the
  // persisted `size`), which the serialized copy does not carry — nothing rendered it. Laying a
  // canvas out to geometry the user would not get on screen, and round-tripping every node
  // through the serializers to persist it, is drift no reply could report.
  group: 'grouping re-fits frames from measured node sizes, which only a rendered canvas has',
  ungroup: 'ungrouping re-fits frames from measured node sizes, which only a rendered canvas has',
  move: 'reparenting re-fits both frames from measured node sizes, which only a rendered canvas has',
  arrange: 'arranging lays nodes out from measured node sizes, which only a rendered canvas has',
  align: 'aligning lays nodes out from measured node sizes, which only a rendered canvas has',
  // Both compose `--after` arming and context bridges over nodes created in the SAME tick, and
  // check each dep against the live canvas before arming it. A cold open defers ONE node's launch;
  // these defer a graph, and an armed station is fired by the live canvas effect.
  verify: 'a review panel arms its reviewers against the live canvas',
  'spawn-team': 'a team arms its members against the live canvas',
  // branchClaude parks the ORIGINAL node's live terminal and resumes it in the new one. Off screen
  // there is no live terminal to park.
  branch: 'branching parks the original session, which needs its terminal mounted',
  // The worktree store is epoch-scoped to the ACTIVE project, so off canvas its repoRoot and
  // staleness answers describe a different project's checkout.
  'open-worktree': 'the worktree store only answers for the project on screen',
  'close-worktree': 'the worktree store only answers for the project on screen',
  // The CDP driving in main needs a mounted <webview> guest. Placing a browser node
  // (`open-browser`) does not and is in OFF_CANVAS_VERBS; navigating one does.
  browser: 'driving a browser node needs its webview mounted',
  // STAGED (ticket 03): registered in main's verb model but not yet answered by ANY canvas —
  // the renderer dispatch has no case for them, so "off screen" is not what makes them unable
  // to act. The refusal says so rather than promising a wait that would never end.
  'link-branches': 'branch-dependency links are not wired to the canvas yet',
  'sync-stack': 'stack sync is not wired to the canvas yet'
}

/**
 * What the dispatch does with `verb` when the source's project is NOT the one on screen.
 *
 * Every verb in `ControlVerb` has an entry, and NONE of them is "travel" — that is the whole
 * invariant, and `test/acceptance/control-verb-disposition.test.ts` walks main's verb table
 * against this function to pin both halves (full coverage, and no traveller).
 */
export type OffScreenDisposition =
  /** Never routes at all — handled before the source lookup (`needsLiveCanvas` is false). */
  | { kind: 'store-answered' }
  /** Creates a session node, armed and inert until that project is next shown. */
  | { kind: 'cold-open' }
  /** Creates a display node, complete the moment it is written. */
  | { kind: 'off-canvas' }
  /** Acts on nodes that already exist, through the owning project's serialized copy. */
  | { kind: 'stored-node' }
  /** Cannot be answered off screen; `why` is the sentence the agent is given. */
  | { kind: 'refuse'; why: string }

export function offScreenDisposition(verb: string): OffScreenDisposition {
  if (!needsLiveCanvas(verb)) return { kind: 'store-answered' }
  if (canColdOpen(verb)) return { kind: 'cold-open' }
  if (answersOffCanvas(verb)) return { kind: 'off-canvas' }
  if (answersFromStoredNodes(verb)) return { kind: 'stored-node' }
  const why = OFF_SCREEN_REFUSALS[verb]
  // An unknown verb refuses too. The dispatch's own `default` case answers "unknown verb" first on
  // the on-screen path, so this only ever reads for a verb someone added to main's table and
  // forgot to classify here — and refusing is the fail-closed direction.
  return { kind: 'refuse', why: why ?? 'it needs the live canvas' }
}

/**
 * The refusal an agent is given for a verb whose project is off screen. It NAMES the project,
 * because the caller's fix is to have the human open that tab, and an agent that is told only
 * "not on screen" cannot say which of the user's tabs to ask for.
 */
export function offScreenRefusal(verb: string, projectName?: string): string {
  const where = projectName ? `project "${projectName}"` : 'that project'
  const d = offScreenDisposition(verb)
  const why = d.kind === 'refuse' ? d.why : 'it needs the live canvas'
  return `${verb}: ${where} is not on screen — ${why}. Open that project and run this again; nothing was changed.`
}

/** Test-only view of the four sets, so their disjointness can be asserted rather than eyeballed. */
export function controlVerbSetsForTests(): {
  storeAnswered: string[]
  coldOpenable: string[]
  offCanvas: string[]
  storedNode: string[]
} {
  return {
    storeAnswered: [...STORE_ANSWERED_VERBS],
    coldOpenable: [...COLD_OPENABLE_VERBS],
    offCanvas: [...OFF_CANVAS_VERBS],
    storedNode: [...STORED_NODE_VERBS]
  }
}

/**
 * The agent-facing paragraph about a project that is not on screen, RENDERED from the tables above
 * rather than re-typed as prose — the same discipline as `messagingGuidanceLines` in
 * `core/canvas-control-core.ts`, and for the same reason CLAUDE.md gives for this subsystem: a
 * doc line with no test behind it is a plan, not a fact (#269 shipped exactly that drift).
 *
 * `canvas-control-core.test.ts` walks the real tables against the rendered text, so a verb that
 * changes sides here lands in both generated bodies the day it moves.
 *
 * Both consumers are plain-text bodies (a SKILL.md and a marker block), so this returns lines and
 * lets the caller indent.
 */
export function offScreenGuidanceLines(): string[] {
  const sets = controlVerbSetsForTests()
  const answered = [
    ...sets.storeAnswered,
    ...sets.coldOpenable,
    ...sets.offCanvas,
    ...sets.storedNode
  ].sort()
  const refused = Object.keys(OFF_SCREEN_REFUSALS).sort()
  return [
    "NO VERB EVER SWITCHES THE USER'S VIEW. The canvas your call is answered on is the one your",
    'own node lives on, which is often NOT the project the user is looking at — you may be a',
    'scheduled run, a background orchestrator, or a session re-adopted after a restart. Their tab,',
    'camera and typing focus are never taken to answer you.',
    `- Answered whether or not that project is on screen: ${answered.join(', ')}.`,
    '  The reply says where the work landed; say so too rather than assuming the user saw it.',
    `- REFUSED while that project is off screen, changing nothing: ${refused.join(', ')}.`,
    ...refused.map((v) => `  - ${v}: ${OFF_SCREEN_REFUSALS[v]}.`),
    '  The refusal names the project. Ask the user to open it and run the call again; do not',
    '  retry it on a timer, and do not report the action as done.'
  ]
}
