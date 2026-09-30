// One card per Claude subagent, from two signal paths that both still exist.
//
// Claude Code reports a subagent twice over. The NATIVE path is its own `SubagentStart` /
// `SubagentStop` hooks (since 2.0.43), keyed by the child's `agent_id`. The TOOL path is what
// nodeterm reconstructed before those hooks existed: `PreToolUse`/`PostToolUse` on the
// `Agent`/`Task` tool keyed by `tool_use_id`, an async-launch ack that is NOT the end, and the real
// end sniffed out of a `<task-notification>` in the parent transcript. The tool path breaks
// silently whenever a release renames the tool, reshapes the ack or rewords the notification; the
// native path does not depend on any of that. So NATIVE IS THE AUTHORITY whenever a session proves
// it sends it, and the tool path is kept for two jobs: a fallback for a CLI (or a session whose
// hook snapshot predates the upgrade) that never sends native hooks, and the task LABEL, which the
// native start does not carry.
//
// Everything here is MEASURED on Claude Code 2.1.284 (fixture
// shared/agents/__fixtures__/claude/subagent-hook-payloads.json; CLAUDE.md → Subagent
// visualization). The rules, and the measurement behind each:
//
//  - LATCH per node + session. A session is native once it has sent one `SubagentStart`. Before
//    that, a tool call draws its card immediately, exactly as before (an old CLI never latches,
//    and its stream passes through untouched). After it, a tool call draws NOTHING until its own
//    `SubagentStart`: the tool call is only a pending LABEL. Measured gap between the two: 20 ms
//    in print mode, ~2–5 s in interactive auto mode (the permission classifier runs between them),
//    so the card now appears when the subagent actually starts — and a tool call that never runs
//    (denied, blocked) draws no phantom card at all.
//  - The first subagent of a session is drawn from its tool call and then REPLACED by the native
//    card (`supersedes`): nothing can know, at the tool call, that a native start is coming.
//  - Cards are keyed by `agent_id`. The lifecycle (start, stop, resume) therefore follows the
//    native events EXACTLY; only the label comes from a tool call, and pairing a tool call with its
//    child is the one inference here. First in, first out by subagent type, because the CLI starts
//    the children of one message in the order it issued the calls — but in interactive mode it
//    issues every `PreToolUse` first and then starts the children within 5 ms of each other, and a
//    backgrounded hook POST can overtake another. The async launch ack names the exact pair
//    (`tool_response.agentId`, measured ~1 ms after each start), so a wrong guess is corrected
//    before anything else happens, and an ack that overtakes its own start is remembered (and the
//    call it names is not handed to another child meanwhile). A SYNC child has no ack; its end
//    names it exactly (`tool_response.agentId`), which takes its call out of the queue and gives a
//    still-running sibling that guessed it its own label back.
//  - A native stop ends a card; a later native start of the SAME id re-opens it. Measured: a
//    background agent that ends its turn while its own child still runs fires `SubagentStop`, and
//    is resumed under the same `agent_id` when the child reports back.
//  - A native stop for an id that never started is DROPPED: Claude fires stops for its internal
//    side-agents (prompt suggestions, measured after nearly every interactive turn) with an empty
//    `agent_type` and no start.
//  - Every turn end (`Stop`, `StopFailure` — never the idle-prompt rescue, which can fire while an
//    Agent call waits on a permission prompt) clears the queue of calls whose child never started:
//    every call of the turn has resolved by then, inventory or not, and a left-over label would go
//    to the next child for the rest of the session.
//  - A killed child fires NO stop (measured, SDK interrupt). The parent's next `Stop` carries the
//    session's live background-task inventory (when the CLI is new enough to send one), and a
//    native card still working that it no longer lists is over. Foreground children are never in
//    that list, and none can be running when the parent's turn ends; nested children of a
//    background agent are listed (measured).
//  - A replaced tool card also gets a plain end, AFTER the replacing start, for a consumer too old
//    to know `supersedes`.
//  - Tool-path ends (the sync `PostToolUse`, the `<task-notification>` sniff) still arrive in a
//    native session; they are re-keyed onto the native card, which makes them idempotent — and they
//    carry the sync stats (tokens, tool uses) the native stop lacks.
//
// One instance per shell, fed EVERY normalized event before anything consumes it (both shells:
// src/main/index.ts, src/server/agent-status.ts). Events it does not act on come back as the same
// object. Display-only, never persisted, never permission evidence.
import type { NormalizedAgentEvent } from '../shared/agents/normalize'

/** A tool call whose child has not started yet (or never will). */
interface Pending {
  toolUseId: string
  type?: string
  label?: string
  /** A card was drawn for it (only before the latch). */
  shown: boolean
}

interface Card {
  agentId: string
  /** The tool call this card's label came from. */
  toolUseId?: string
  type?: string
  label?: string
  working: boolean
}

interface NodeState {
  sessionId?: string
  native: boolean
  pending: Pending[]
  /** Insertion-ordered, so eviction takes the oldest. */
  cards: Map<string, Card>
  /** agent_id → tool_use_id, from an ack that arrived before its own SubagentStart. */
  ackHints: Map<string, string>
}

const PENDING_MAX = 64
const CARDS_MAX = 128
const HINTS_MAX = 64

export interface ClaudeSubagentLifecycleOptions {
  /**
   * Called with a card key the lifecycle has just ENDED or REPLACED (never for an event it merely
   * passed through). The shells stop that key's live transcript tail here.
   */
  onRelease?: (key: string) => void
}

export class ClaudeSubagentLifecycle {
  private readonly nodes = new Map<string, NodeState>()
  private readonly onRelease: (key: string) => void

  constructor(opts: ClaudeSubagentLifecycleOptions = {}) {
    this.onRelease = opts.onRelease ?? (() => {})
  }

  /** The events to hand every consumer in place of `ev`: `[]` suppresses it, more than one adds
   *  corrections or reconciled ends after it. */
  apply(ev: NormalizedAgentEvent): NormalizedAgentEvent[] {
    if (!ev?.nodeId) return [ev]
    if (ev.kind === 'session' && ev.sessionPhase === 'end') {
      this.nodes.delete(ev.nodeId)
      return [ev]
    }
    if (ev.kind === 'state') {
      if (ev.subagentLaunch) return this.ack(ev, ev.subagentLaunch)
      // A turn end (Stop / StopFailure) — never the idle-prompt rescue, which can fire while an
      // Agent call is still held on a permission prompt.
      if (ev.state === 'done' && !ev.idle) return this.turnEnd(ev)
      return [ev]
    }
    if (!ev.subagentSignal || !ev.toolUseId) return [ev]
    if (ev.kind === 'subagent-start') {
      return ev.subagentSignal === 'native' ? this.nativeStart(ev, ev.toolUseId) : this.toolStart(ev, ev.toolUseId)
    }
    if (ev.kind === 'subagent-end') {
      return ev.subagentSignal === 'native' ? this.nativeEnd(ev, ev.toolUseId) : this.toolEnd(ev, ev.toolUseId)
    }
    return [ev]
  }

  /** Has this node's CURRENT session proved it sends native subagent hooks? The shells skip the
   *  tool path's transcript tail when it has (the native start brings its own). */
  isNative(nodeId: string, sessionId: string | undefined): boolean {
    const st = this.nodes.get(nodeId)
    return !!st?.native && (!sessionId || st.sessionId === sessionId)
  }

  forgetNode(nodeId: string): void {
    this.nodes.delete(nodeId)
  }

  clear(): void {
    this.nodes.clear()
  }

  /** Test seam: everything held, across nodes. */
  sizeForTest(): number {
    let n = 0
    for (const st of this.nodes.values()) n += st.pending.length + st.cards.size + st.ackHints.size
    return n
  }

  // ── the rules ─────────────────────────────────────────────────────────────────────────────

  private state(ev: NormalizedAgentEvent): NodeState {
    let st = this.nodes.get(ev.nodeId)
    // A different session is a different CLI run (or /clear): nothing carries over.
    if (!st || (ev.sessionId && st.sessionId && st.sessionId !== ev.sessionId)) {
      st = { sessionId: ev.sessionId, native: false, pending: [], cards: new Map(), ackHints: new Map() }
      this.nodes.set(ev.nodeId, st)
    } else if (!st.sessionId && ev.sessionId) {
      st.sessionId = ev.sessionId
    }
    return st
  }

  private toolStart(ev: NormalizedAgentEvent, toolUseId: string): NormalizedAgentEvent[] {
    const st = this.state(ev)
    const shown = !st.native
    st.pending.push({ toolUseId, type: ev.subagentType, label: ev.taskLabel, shown })
    if (st.pending.length > PENDING_MAX) st.pending.shift()
    return shown ? [ev] : []
  }

  private nativeStart(ev: NormalizedAgentEvent, agentId: string): NormalizedAgentEvent[] {
    const st = this.state(ev)
    st.native = true
    const known = st.cards.get(agentId)
    if (known) {
      // Resumed under the same id: re-open the card, with what it already knows.
      known.working = true
      return [this.startEvent(ev, known)]
    }
    const card: Card = { agentId, type: ev.subagentType, working: true }
    st.cards.set(agentId, card)
    this.evict(st)
    const out: NormalizedAgentEvent[] = []
    const hinted = st.ackHints.get(agentId)
    st.ackHints.delete(agentId)
    const superseded = hinted ? this.bind(st, card, hinted, ev, out) : this.bindNext(st, card)
    out.unshift(this.startEvent(ev, card, superseded), ...this.supersededEnd(ev, superseded, card.type))
    return out
  }

  private ack(ev: NormalizedAgentEvent, launch: { toolUseId: string; agentId: string }): NormalizedAgentEvent[] {
    const st = this.state(ev)
    const card = st.cards.get(launch.agentId)
    if (!card) {
      // The ack overtook its own start: remember the exact pair for when the start lands.
      st.ackHints.set(launch.agentId, launch.toolUseId)
      if (st.ackHints.size > HINTS_MAX) st.ackHints.delete(st.ackHints.keys().next().value!)
      return [ev]
    }
    if (card.toolUseId === launch.toolUseId) return [ev]
    const out: NormalizedAgentEvent[] = [ev]
    const superseded = this.bind(st, card, launch.toolUseId, ev, out)
    out.splice(
      1,
      0,
      ...(card.working ? [this.startEvent(ev, card, superseded)] : []),
      ...this.supersededEnd(ev, superseded, card.type)
    )
    return out
  }

  private nativeEnd(ev: NormalizedAgentEvent, agentId: string): NormalizedAgentEvent[] {
    const st = this.nodes.get(ev.nodeId)
    const card = st && (!ev.sessionId || st.sessionId === ev.sessionId) ? st.cards.get(agentId) : undefined
    // Never started here: an internal side-agent, or a start from another session / app run.
    if (!card) return []
    const wasWorking = card.working
    card.working = false
    if (wasWorking) this.onRelease(agentId)
    return [{ ...ev, subagentType: ev.subagentType ?? card.type }]
  }

  private toolEnd(ev: NormalizedAgentEvent, toolUseId: string): NormalizedAgentEvent[] {
    const st = this.nodes.get(ev.nodeId)
    if (!st) return [ev]
    const exact = ev.subagentAgentId ? st.cards.get(ev.subagentAgentId) : undefined
    const card = exact ?? [...st.cards.values()].find((c) => c.toolUseId === toolUseId)
    if (card) {
      const fixes: NormalizedAgentEvent[] = []
      // The sync end names its child exactly (tool_response.agentId). If the pairing guessed
      // otherwise — a SubagentStart POST that overtook its own PreToolUse, where no ack follows to
      // correct it — settle it now: this call leaves the queue (it would label the NEXT child), and
      // a still-running sibling that took it gets its own label back.
      if (exact && card.toolUseId !== toolUseId) {
        const superseded = this.bind(st, card, toolUseId, ev, fixes)
        fixes.push(...this.supersededEnd(ev, superseded, card.type))
      }
      if (card.working) this.onRelease(card.agentId)
      card.working = false
      return [{ ...ev, toolUseId: card.agentId }, ...fixes]
    }
    const i = st.pending.findIndex((p) => p.toolUseId === toolUseId)
    if (i >= 0) {
      const [p] = st.pending.splice(i, 1)
      // Its child never announced itself: end the tool card if one was drawn, else say nothing.
      return p.shown ? [ev] : []
    }
    return [ev]
  }

  private turnEnd(ev: NormalizedAgentEvent): NormalizedAgentEvent[] {
    const st = this.nodes.get(ev.nodeId)
    if (!st?.native || (ev.sessionId && st.sessionId !== ev.sessionId)) return [ev]
    const out: NormalizedAgentEvent[] = [ev]
    // The inventory, when the CLI sends one, ends the native cards it no longer lists.
    if (ev.backgroundTaskIds) {
      const alive = new Set(ev.backgroundTaskIds)
      for (const card of st.cards.values()) {
        if (!card.working || alive.has(card.agentId)) continue
        card.working = false
        this.onRelease(card.agentId)
        out.push(this.endEvent(ev, card.agentId, card.type))
      }
    }
    // Every tool call of the turn has resolved by its Stop — with or without an inventory (native
    // hooks shipped in 2.0.43, the inventory much later) — so a child that has not started by now
    // never will, and its waiting label must not go to the next child. A card drawn for one (only
    // possible before the latch) is ended.
    for (const p of st.pending) {
      if (!p.shown) continue
      this.onRelease(p.toolUseId)
      out.push({ ...this.endEvent(ev, p.toolUseId, p.type), subagentSignal: 'tool' })
    }
    st.pending = []
    return out
  }

  // ── pairing a card with a tool call ───────────────────────────────────────────────────────

  /** First in, first out: the oldest waiting tool call of the same type, else one with no type
   *  on either side. Returns the id of a drawn tool card the new card replaces. */
  private bindNext(st: NodeState, card: Card): string | undefined {
    // A call an ack already named for another child that has not started yet is not up for grabs.
    const reserved = new Set(st.ackHints.values())
    const free = (p: Pending): boolean => !reserved.has(p.toolUseId)
    const i = (() => {
      const same = st.pending.findIndex((p) => free(p) && p.type !== undefined && p.type === card.type)
      if (same >= 0) return same
      return st.pending.findIndex((p) => free(p) && (p.type === undefined || card.type === undefined))
    })()
    if (i < 0) return undefined
    const [p] = st.pending.splice(i, 1)
    this.take(card, p)
    return this.replaced(p)
  }

  /**
   * Give `card` exactly the tool call `toolUseId`, from wherever it is: still waiting, or wrongly
   * given to another card (which then takes the next waiting one, and gets a corrective start in
   * `out`). The call `card` held before goes back to the front of the queue for its real owner.
   * Returns the id of a drawn tool card `card` now replaces.
   */
  private bind(
    st: NodeState,
    card: Card,
    toolUseId: string,
    ev: NormalizedAgentEvent,
    out: NormalizedAgentEvent[]
  ): string | undefined {
    const previous = card.toolUseId !== undefined && card.toolUseId !== toolUseId
      ? { toolUseId: card.toolUseId, type: card.type, label: card.label, shown: false }
      : undefined
    const owner = [...st.cards.values()].find((c) => c !== card && c.toolUseId === toolUseId)
    const i = st.pending.findIndex((p) => p.toolUseId === toolUseId)
    let superseded: string | undefined
    if (owner) {
      this.take(card, { toolUseId, type: owner.type, label: owner.label, shown: false })
      owner.toolUseId = undefined
      owner.label = undefined
    } else if (i >= 0) {
      const [p] = st.pending.splice(i, 1)
      this.take(card, p)
      superseded = this.replaced(p)
    } else {
      card.toolUseId = toolUseId
    }
    if (previous) st.pending.unshift(previous)
    if (owner) {
      const ownerSuperseded = this.bindNext(st, owner)
      if (owner.working) out.push(this.startEvent(ev, owner, ownerSuperseded))
      out.push(...this.supersededEnd(ev, ownerSuperseded, owner.type))
    }
    return superseded
  }

  private take(card: Card, p: Pending): void {
    card.toolUseId = p.toolUseId
    card.label = p.label
    card.type ??= p.type
  }

  /** A drawn tool card that a native card now stands in for is released exactly once. */
  private replaced(p: Pending): string | undefined {
    if (!p.shown) return undefined
    this.onRelease(p.toolUseId)
    return p.toolUseId
  }

  private evict(st: NodeState): void {
    if (st.cards.size <= CARDS_MAX) return
    for (const [id, c] of st.cards) {
      if (!c.working) {
        st.cards.delete(id)
        if (st.cards.size <= CARDS_MAX) return
      }
    }
    st.cards.delete(st.cards.keys().next().value!)
  }

  private startEvent(ev: NormalizedAgentEvent, card: Card, supersedes?: string): NormalizedAgentEvent {
    return {
      nodeId: ev.nodeId,
      agentId: ev.agentId,
      sessionId: ev.sessionId,
      ...(ev.verified !== undefined ? { verified: ev.verified } : {}),
      kind: 'subagent-start',
      toolUseId: card.agentId,
      subagentType: card.type,
      taskLabel: card.label,
      subagentSignal: 'native',
      ...(supersedes ? { supersedes } : {})
    }
  }

  /**
   * A plain end for a tool card a native card just replaced, AFTER the replacing start. A consumer
   * that knows `supersedes` has already moved the card, so this is a no-op there; one that does not
   * (an older relay guest's renderer) would otherwise keep the tool card working until the stale
   * decay. Never before the start: with auto-hide on, an end first would drop the card the start
   * is about to move.
   */
  private supersededEnd(ev: NormalizedAgentEvent, key: string | undefined, type: string | undefined): NormalizedAgentEvent[] {
    return key ? [{ ...this.endEvent(ev, key, type), subagentSignal: 'tool' }] : []
  }

  private endEvent(ev: NormalizedAgentEvent, key: string, type: string | undefined): NormalizedAgentEvent {
    return {
      nodeId: ev.nodeId,
      agentId: ev.agentId,
      sessionId: ev.sessionId,
      kind: 'subagent-end',
      toolUseId: key,
      subagentType: type,
      subagentSignal: 'native'
    }
  }
}
