import { create } from 'zustand'
import { WORKING_STALE_MS } from '@shared/agents/stale'
import { capabilityAgentId, type AgentId } from '@shared/agents/config'
import { isClaudeAgentId } from '@shared/agents/claude-subagents'

/**
 * Transient visualization of subagents an agent node spawns, keyed by the id its hooks name: the
 * tool_use_id of a Task/Agent tool call, or — for Claude's native `SubagentStart` — the child's own
 * `agent_id` (core/claude-subagent-lifecycle.ts). These render as ephemeral nodes + edges on the
 * canvas; they are never persisted to workspace.json and never enter undo/redo (see Canvas).
 */
export interface SubagentViz {
  /** The Claude terminal node that spawned this subagent. */
  parentNodeId: string
  /**
   * The PARENT's agent session and Claude account at the moment the card started — what a reader of
   * the subagent's own transcript must resolve the parent by. Recorded once, so a later resume,
   * restart or account switch of the parent does not repoint a card that is already on the canvas.
   */
  sessionId?: string
  accountId?: string
  /** The agent that spawned it (the event's `agentId`, e.g. 'claude' or a custom id). */
  agent?: AgentId
  /**
   * Drawn from Claude's native `SubagentStart` (`subagentSignal === 'native'`), so the card's key IS
   * the child's `agent_id` and its transcript can be derived from the parent's. A tool-path card's
   * key is a tool_use_id, which names no file.
   */
  native?: boolean
  /** Subagent type, e.g. 'general-purpose'. */
  type?: string
  /** The task description/prompt. */
  label?: string
  state: 'working' | 'done'
  /** When it started (for the live timer). */
  startedAt: number
  // Filled on finish (from the PostToolUse tool_response):
  durationMs?: number
  tokens?: number
  toolUses?: number
  /** What the subagent produced (shown when the node is expanded). */
  result?: string
}

/**
 * Whether a card can show the subagent's own conversation: a native Claude card (its key is the
 * child's `agent_id`, a safe file-name token) that knows the parent session to resolve it by. Every
 * other card has only the streamed text.
 */
export function chatReadable(v: SubagentViz, cardId: string): boolean {
  return (
    v.agent !== undefined &&
    capabilityAgentId(v.agent) === 'claude' &&
    v.native === true &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    isClaudeAgentId(cardId)
  )
}

export interface SubagentResult {
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
}

interface AgentNodesState {
  byId: Record<string, SubagentViz>
  /**
   * Live transcript text per subagent, streamed while it runs — kept OUT of `byId` on purpose:
   * Canvas subscribes to `byId` to lay out the ephemeral nodes, and chunks arrive several times
   * a second, so routing them through `byId` re-rendered the whole canvas per chunk. Only the
   * expanded SubagentNode subscribes here, per id.
   */
  activityById: Record<string, string>
  /**
   * When each subagent last streamed transcript, for `sweepStaleWorking`. Kept out of `byId` for the
   * same reason as `activityById`: it changes on every chunk, and Canvas lays out from `byId`.
   */
  lastActivityAt: Record<string, number>
  /**
   * Per-ephemeral-node UI overrides (keyed by node id: subagent ids + `loop-<parentId>`).
   * `positions` holds an OFFSET FROM THE PARENT AGENT NODE, not a canvas position: the card
   * always shares the agent's coordinate space (it inherits the agent's `parentId`), so an
   * offset survives the space CHANGING under it. Storing the position itself meant that
   * grouping or ungrouping the agent — which flips its position between absolute and
   * group-relative — teleported every card the user had dragged, by the group's own x/y.
   */
  positions: Record<string, { x: number; y: number }>
  sizes: Record<string, { width: number; height: number }>
  expanded: Record<string, boolean>
  /**
   * The one selected ephemeral card, or null. Kept here (not in React Flow's selection) because
   * the cards are `selectable: false`: a rubber-band or select-all must never sweep up a whole
   * subagent fan-out and hand those ids to Group / Duplicate / Delete, which cannot act on a
   * derived node. Cards select one at a time, by click, purely to show their resize frame.
   */
  selectedId: string | null
  /**
   * `settings.autoHideFinishedSubagentCards`, mirrored here by Canvas so the store stays free of
   * the settings store.
   *
   * On, a card is DROPPED at the moment its subagent REPORTS done — `finish()`, and only
   * `finish()` — rather than left `done` for the next turn boundary to take. Only a finished card
   * is ever dropped, so #547's rule (a new turn must keep the cards of subagents that are still
   * running) and Eco's `liveSubagents` are untouched.
   *
   * An EXPANDED card is the exception (the pin rule, see `toggleExpanded`): the user is reading it,
   * so its finish only marks it done. Collapsing it then drops it at once, which is this setting's
   * promise ("finished cards do not linger") applied the moment the pin is gone.
   *
   * **`sweepStaleWorking`'s decay is deliberately NOT gated on this.** That sweep fires precisely
   * because the end never ARRIVED (crashed CLI, killed pane, slept machine), which is the opposite
   * of the setting's promise, and it is the one case where a visible card carries the most
   * information: drop it and a fan-out whose subagents died silently leaves nothing on the canvas
   * that says a subagent was ever launched. The decay keeps marking `done` and the turn boundary
   * takes the card, exactly as it did before this setting existed. It costs Eco nothing — an
   * absent card and a `done` card are the same answer to `liveSubagents`.
   *
   * Off is the default and reproduces the previous behavior exactly.
   */
  autoHideFinished: boolean
  setAutoHideFinished(on: boolean): void
  select(id: string | null): void
  setPosition(id: string, offset: { x: number; y: number }): void
  setSize(id: string, size: { width: number; height: number }): void
  /**
   * Open or close a card. An OPEN card is pinned: the turn boundary (`clearFinishedForParent`) and
   * the `autoHideFinished` drop in `finish()` both skip it, because the user is reading it (its
   * chat). `clearForParent` still takes it — the parent is gone — and the stale decay still only
   * marks it done. Closing a finished card un-pins it: it then goes at the NEXT turn boundary like
   * any finished card, except under `autoHideFinished`, where it goes at once. `tidyFanout` drops
   * the flag too, on purpose (an explicit "reset these cards"), by the same rule.
   */
  toggleExpanded(id: string): void
  /** Drop a card's dragged position + resized size, returning it to its laid-out spot. */
  resetPlacement(id: string): void
  /**
   * Draw (or re-open) a card. `supersedes` names a card this one REPLACES — Claude's first subagent
   * of a session is drawn from its tool call, then its native `SubagentStart` arrives under the
   * child's own id (core/claude-subagent-lifecycle.ts). The old card's start time, place, size,
   * expansion and selection move to the new key, so the user sees one card that never moved. Its
   * streamed activity is DROPPED, not moved: the native tail reads the same transcript file from
   * its first byte, and moving it would print everything twice.
   *
   * `lastActivityAt` seeds the sweep's clock for a card replayed after a reload; it is kept out of
   * `byId` like every activity time. A superseded card's clock is carried too (it is a time, not
   * text, so it cannot double) — the new key must not look older than the card it replaces.
   *
   * The parent session and account are the ones the card FIRST started under (this key's earlier
   * start, else the card it replaces, else this start's): a repeated start — a resumed child, a
   * reload replay — never repoints a card to another session. A card once native stays native, so
   * a replay from a host that does not carry the signal cannot swap an open chat for the text.
   */
  start(
    toolUseId: string,
    viz: Omit<SubagentViz, 'state' | 'startedAt'> & { startedAt?: number; lastActivityAt?: number },
    supersedes?: string
  ): void
  /**
   * End a card. Idempotent on a card already done — except that a late end carrying STATS (tokens
   * / tool uses) fills them in: Claude's native stop ends a sync child ~40 ms before the tool
   * path's end brings the numbers the card shows, and dropping those would be a regression.
   */
  finish(toolUseId: string, result: SubagentResult): void
  /** Append a chunk of the subagent's live transcript. */
  appendActivity(toolUseId: string, chunk: string): void
  /**
   * Remove ALL subagents spawned by a given parent node, finished or not.
   *
   * For the paths where the parent itself is gone or its session has ended — node deleted, project
   * deleted, cross-project close, orphan-session kill, `SessionEnd`. A node that no longer exists
   * has no work left to represent, so there is nothing to preserve.
   *
   * **NOT for a turn boundary** — see `clearFinishedForParent` and issue #547.
   */
  clearForParent(parentNodeId: string): void
  /**
   * Drop only the FINISHED subagent cards of a parent. The turn-boundary clear.
   *
   * Issue #547: `clearForParent` ran on every new turn on the assumption that the previous fan-out
   * is stale by definition. That holds for a card whose subagent has finished and is false for one
   * that has not — Claude launches subagents async, and "waiting for N background agents to finish"
   * is exactly the state in which the user types the next prompt. The card vanished permanently
   * (nothing rehydrates `byId`: `start()` fires only from a live `PreToolUse`, and a subagent past
   * that emits no second one) while the agent kept working. Same permanent loss as #402, different
   * trigger.
   *
   * The more expensive half is not the missing card. Eco's hibernation guard derives `liveSubagents`
   * from this same store, so a wiped card let a parent with live background agents read as idle and
   * get its CLI `/exit`ed — the regression #402 was raised to close.
   *
   * `state` already draws the line the fix needs (`'working' | 'done'`, `finish()` idempotent), so
   * this needs no new concept. What it does need is the decay: see `sweepStaleWorking`.
   *
   * An EXPANDED finished card is kept (the pin rule, see `toggleExpanded`): it is `done`, so it
   * pins nothing for Eco.
   */
  clearFinishedForParent(parentNodeId: string): void
  /**
   * Mark every card still `working` with no sign of life for `staleMs` as done — the decay `clearFinishedForParent`
   * depends on.
   *
   * Without it a subagent whose `finish()` never arrives (crashed CLI, killed pane, slept machine)
   * pins its card forever AND pins its parent against Eco forever, which is a worse bug than the
   * one being fixed. The number is `WORKING_STALE_MS`, imported rather than chosen: that module
   * exists because three surfaces each invented their own timeout, and a subagent card inventing a
   * fourth would be the same mistake in a new place.
   *
   * "No sign of life" counts from the card's last streamed activity, falling back to its start.
   * Counting from the start alone declared every subagent that ran longer than the window dead
   * while its transcript was still streaming, and the next turn boundary then removed its card.
   *
   * It marks done rather than deleting, so the card stays readable and the next turn boundary takes
   * it; `finish()` landing late is a no-op on an entry that is already done.
   */
  sweepStaleWorking(now?: number, staleMs?: number): void
  /**
   * Drop every dragged position/size/expanded override for a parent's subagent cards, snapping
   * them back to the default packed grid (`offsetFrom`'s fallback in Canvas) at base dims — an
   * expanded card kept at its larger size would still overlap its grid neighbors. Loop cards are
   * excluded — there is only ever one per parent, so there is nothing to pack. If this is ever
   * extended to loop cards, route through `saveLoopOverrides` too, or a cleared `loop-*` entry
   * would resurrect from its localStorage mirror on reload.
   *
   * Dropping `expanded` un-pins the open cards; under `autoHideFinished` a FINISHED one it un-pins
   * is dropped at once, exactly as closing it would.
   */
  tidyFanout(parentNodeId: string): void
  /**
   * Drop the loop card's UI overrides (position/size/expanded) for a parent. Separate from
   * clearForParent on purpose: a loop/cron card outlives turns, so the per-turn fan-out
   * clear must not reset where the user dragged it — this runs only when the loop ends.
   */
  clearLoop(parentNodeId: string): void
}

// Loop-card overrides survive restarts: the loop itself is persisted (agentStatus), so its
// dragged position/size must be too, or every launch teleports the card back to the default
// spot. Only `loop-*` keys are stored — subagent cards live in memory for this app run only (a
// turn boundary takes a finished one unless the user opened it; see `toggleExpanded`).
// v2: `positions` changed meaning from a canvas position to an offset from the parent agent
// node. Reading a v1 entry as an offset would fling the card across the canvas, so the old key is
// simply abandoned — the cost is one reset of a dragged loop card, not a mystery jump.
const LOOP_CARDS_KEY = 'nodeterm.loopCards.v2'

type Overrides = Pick<AgentNodesState, 'positions' | 'sizes' | 'expanded'>

function loadLoopOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(LOOP_CARDS_KEY)
    if (!raw) return { positions: {}, sizes: {}, expanded: {} }
    const d = JSON.parse(raw) as Partial<Overrides>
    return { positions: d.positions ?? {}, sizes: d.sizes ?? {}, expanded: d.expanded ?? {} }
  } catch {
    return { positions: {}, sizes: {}, expanded: {} }
  }
}

/** Card ids belonging to one parent. */
function cardsOf(s: AgentNodesState, parentNodeId: string): string[] {
  return Object.keys(s.byId).filter((id) => s.byId[id].parentNodeId === parentNodeId)
}

/**
 * Drop the given cards and everything keyed by their ids. The one removal body, so the
 * unconditional clear and the turn-boundary clear cannot drift in what they take with them.
 */
function dropCards(s: AgentNodesState, ids: string[]): Partial<AgentNodesState> | AgentNodesState {
  if (!ids.length) return s
  const byId = { ...s.byId }
  const activityById = { ...s.activityById }
  const lastActivityAt = { ...s.lastActivityAt }
  const positions = { ...s.positions }
  const sizes = { ...s.sizes }
  const expanded = { ...s.expanded }
  // Loop-card overrides (`loop-<pid>`) are deliberately NOT dropped here — the card outlives turns;
  // its overrides go via clearLoop when the loop itself ends.
  for (const id of ids) {
    delete byId[id]
    delete activityById[id]
    delete lastActivityAt[id]
    delete positions[id]
    delete sizes[id]
    delete expanded[id]
  }
  // A card that just vanished must not stay "selected" — a later card reusing the id would come
  // back pre-selected.
  const selectedId = s.selectedId && ids.includes(s.selectedId) ? null : s.selectedId
  return { byId, activityById, lastActivityAt, positions, sizes, expanded, selectedId }
}

/**
 * The identity a (re)start records: the parent session and account the card first started under,
 * and a native flag that never goes back to false. See `start`.
 */
function firstIdentity(
  viz: Pick<SubagentViz, 'sessionId' | 'accountId' | 'native'>,
  first: SubagentViz | undefined
): Pick<SubagentViz, 'sessionId' | 'accountId' | 'native'> {
  const sessionId = first?.sessionId ?? viz.sessionId
  const accountId = first?.accountId ?? viz.accountId
  const native = first?.native === true ? true : viz.native
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(native !== undefined ? { native } : {})
  }
}

function saveLoopOverrides(s: Overrides): void {
  try {
    const pick = <T>(m: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('loop-')))
    localStorage.setItem(
      LOOP_CARDS_KEY,
      JSON.stringify({ positions: pick(s.positions), sizes: pick(s.sizes), expanded: pick(s.expanded) })
    )
  } catch {
    // ignore quota / serialization errors
  }
}

export const useAgentNodes = create<AgentNodesState>((set) => ({
  byId: {},
  activityById: {},
  lastActivityAt: {},
  selectedId: null,
  autoHideFinished: false,
  ...loadLoopOverrides(),

  setAutoHideFinished: (on) =>
    set((s) => (s.autoHideFinished === on ? s : { autoHideFinished: on })),

  select: (id) => set((s) => (s.selectedId === id ? s : { selectedId: id })),

  setPosition: (id, offset) =>
    set((s) => {
      const next = { positions: { ...s.positions, [id]: offset } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),
  setSize: (id, size) =>
    set((s) => {
      const next = { sizes: { ...s.sizes, [id]: size } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),
  toggleExpanded: (id) =>
    set((s) => {
      // Closing a finished card under autoHideFinished: the pin was all that kept it.
      if (s.expanded[id] && s.autoHideFinished && s.byId[id]?.state === 'done') return dropCards(s, [id])
      const next = { expanded: { ...s.expanded, [id]: !s.expanded[id] } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),

  resetPlacement: (id) =>
    set((s) => {
      if (!(id in s.positions) && !(id in s.sizes)) return s
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      delete positions[id]
      delete sizes[id]
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, positions, sizes })
      return { positions, sizes }
    }),

  start: (toolUseId, { lastActivityAt: seed, ...viz }, supersedes) =>
    set((s) => {
      const old = supersedes && supersedes !== toolUseId ? s.byId[supersedes] : undefined
      const startedAt = viz.startedAt ?? s.byId[toolUseId]?.startedAt ?? old?.startedAt ?? Date.now()
      const card: SubagentViz = { ...viz, ...firstIdentity(viz, s.byId[toolUseId] ?? old), state: 'working', startedAt }
      // The sweep's clock: the newest of the replayed seed, this key's own and the replaced card's.
      const clocks = [seed, s.lastActivityAt[toolUseId], old && supersedes ? s.lastActivityAt[supersedes] : undefined]
        .filter((t): t is number => t !== undefined)
      const withClock = (m: Record<string, number>): Record<string, number> =>
        clocks.length ? { ...m, [toolUseId]: Math.max(...clocks) } : m
      if (!old || !supersedes) {
        return { byId: { ...s.byId, [toolUseId]: card }, lastActivityAt: withClock(s.lastActivityAt) }
      }
      const next = dropCards(s, [supersedes]) as AgentNodesState
      // Move what the user did to the old card, unless the new key already carries its own.
      const inherit = !(toolUseId in s.byId)
      const carry = <T>(m: Record<string, T>, from: Record<string, T>): Record<string, T> =>
        inherit && supersedes in from ? { ...m, [toolUseId]: from[supersedes] } : m
      return {
        ...next,
        byId: { ...next.byId, [toolUseId]: card },
        lastActivityAt: withClock(next.lastActivityAt),
        positions: carry(next.positions, s.positions),
        sizes: carry(next.sizes, s.sizes),
        expanded: carry(next.expanded, s.expanded),
        selectedId: s.selectedId === supersedes ? toolUseId : next.selectedId
      }
    }),

  finish: (toolUseId, result) =>
    set((s) => {
      const prev = s.byId[toolUseId]
      if (!prev) return s
      if (prev.state === 'done') {
        if (result.tokens === undefined && result.toolUses === undefined) return s
        const stats = {
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(result.tokens !== undefined ? { tokens: result.tokens } : {}),
          ...(result.toolUses !== undefined ? { toolUses: result.toolUses } : {})
        }
        return { byId: { ...s.byId, [toolUseId]: { ...prev, ...stats } } }
      }
      // An open card is pinned (see `toggleExpanded`): it only turns done.
      if (s.autoHideFinished && !s.expanded[toolUseId]) return dropCards(s, [toolUseId])
      // Async subagents end via a <task-notification> that carries no timing stats — fall
      // back to the card's own elapsed time so the duration doesn't vanish on completion.
      const durationMs = result.durationMs ?? Date.now() - prev.startedAt
      return { byId: { ...s.byId, [toolUseId]: { ...prev, state: 'done', ...result, durationMs } } }
    }),

  appendActivity: (toolUseId, chunk) =>
    set((s) => {
      if (!s.byId[toolUseId]) return s
      const activity = ((s.activityById[toolUseId] ?? '') + chunk).slice(-12000) // bounded tail
      return {
        activityById: { ...s.activityById, [toolUseId]: activity },
        lastActivityAt: { ...s.lastActivityAt, [toolUseId]: Date.now() }
      }
    }),

  clearForParent: (parentNodeId) => set((s) => dropCards(s, cardsOf(s, parentNodeId))),

  clearFinishedForParent: (parentNodeId) =>
    set((s) =>
      dropCards(s, cardsOf(s, parentNodeId).filter((id) => s.byId[id].state === 'done' && !s.expanded[id]))
    ),

  sweepStaleWorking: (now = Date.now(), staleMs = WORKING_STALE_MS) =>
    set((s) => {
      // An activity time ahead of `now` (the clock stepped back after it was stamped) would keep
      // the card working until wall time caught up; clamp it, so the silence window restarts once.
      const future = Object.keys(s.lastActivityAt).filter((id) => s.lastActivityAt[id] > now)
      const lastActivityAt = future.length
        ? { ...s.lastActivityAt, ...Object.fromEntries(future.map((id) => [id, now])) }
        : s.lastActivityAt
      const stale = Object.keys(s.byId).filter(
        (id) =>
          s.byId[id].state === 'working' &&
          now - Math.max(s.byId[id].startedAt, lastActivityAt[id] ?? 0) > staleMs
      )
      if (!stale.length) return future.length ? { lastActivityAt } : s
      const byId = { ...s.byId }
      for (const id of stale) {
        const prev = byId[id]
        // No result to report — the completion signal is what went missing. The elapsed time is
        // still true, and it is `finish()`'s own fallback for the async case.
        byId[id] = { ...prev, state: 'done', durationMs: prev.durationMs ?? now - prev.startedAt }
      }
      return future.length ? { byId, lastActivityAt } : { byId }
    }),

  tidyFanout: (parentNodeId) =>
    set((s) => {
      const ids = Object.keys(s.byId).filter((id) => s.byId[id].parentNodeId === parentNodeId)
      if (!ids.length) return s
      // Un-pinning a finished card under autoHideFinished drops it at once, as closing it does
      // (`toggleExpanded`): the pin was all that kept it.
      const drop = s.autoHideFinished ? ids.filter((id) => s.expanded[id] && s.byId[id].state === 'done') : []
      const dropped = drop.length ? dropCards(s, drop) : {}
      const base = { ...s, ...dropped }
      const positions = { ...base.positions }
      const sizes = { ...base.sizes }
      const expanded = { ...base.expanded }
      for (const id of ids) {
        delete positions[id]
        delete sizes[id]
        delete expanded[id]
      }
      return { ...dropped, positions, sizes, expanded }
    }),

  clearLoop: (parentNodeId) =>
    set((s) => {
      const id = `loop-${parentNodeId}`
      if (!(id in s.positions) && !(id in s.sizes) && !(id in s.expanded)) return s
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      const expanded = { ...s.expanded }
      delete positions[id]
      delete sizes[id]
      delete expanded[id]
      saveLoopOverrides({ positions, sizes, expanded })
      return { positions, sizes, expanded, selectedId: s.selectedId === id ? null : s.selectedId }
    })
}))
