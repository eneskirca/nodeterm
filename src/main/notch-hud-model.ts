// Pure, Electron-free aggregation for the macOS Notch HUD (docs/notch-hud.md).
//
// The HUD controller (notch-hud.ts) owns the BrowserWindow and the mirror/IPC subscriptions; this
// module owns the DATA: it folds the four feeds (main-state edges, now-changes, the full mirror
// table, and the normalized agent-event stream for prompt + subagents, plus context-update for the
// model) into the row array the HUD renderer draws. Kept separate from the window so vitest can
// cover the state→bucket mapping, subagent grouping, the done latch, the 6h drop, and the
// prompt/model join without an Electron runtime. Imports TYPES from core plus the one shared
// clipping constant (PROMPT_MAX) — never electron.

import type { NormalizedAgentEvent, AgentState } from '../shared/agents/normalize'
import { PROMPT_MAX } from '../core/agent-status-mirror'
import type { NodeStateChange, NodeNowChange, MirrorFile } from '../core/agent-status-mirror'
import { WORKING_STALE_MS } from '@shared/agents/stale'

/** A node dropped once it's gone from the mirror AND has been idle longer than this. */
export const HUD_STALE_DROP_MS = 6 * 60 * 60 * 1000

/**
 * The HUD's belt-and-braces copy of the stale-working rule. The DECIDER is the mirror's sweep
 * (`sweepStaleWorking`), which fires a synthetic end edge every surface honors; this display-only
 * check just means the capsule never depends on that edge arriving. Same window, one constant
 * (shared/agents/stale.ts) — nothing is mutated, so any later event restores the row.
 */
export { WORKING_STALE_MS }

/** The phone-facing bucket the HUD colors rows by. `idle` = a seen/finished session. */
export type HudRowState = 'working' | 'needsYou' | 'done' | 'idle'

export interface HudSubagentRow {
  id: string
  label?: string
  state: 'working' | 'done'
}

/** One row the HUD window renders (contract shape). Title is joined in by the controller. */
export interface HudRow {
  nodeId: string
  agentId?: string
  title: string
  model?: string
  state: HudRowState
  prompt?: string
  activity?: string
  contextPercent?: number
  subagents: HudSubagentRow[]
  /**
   * A finished turn the user has not looked at yet — the sessions sidebar's `unread` mark
   * (renderer/lib/sessionList.ts), which is what the HUD's done latch has always meant.
   *
   * It used to be implicit: a seen `done` demotes to `idle` and idle rows are not emitted, so
   * "unread" was readable ONLY as "the row exists at all". That is unreadable from the user's side
   * — a row that vanishes when the phone acks it looks like a glitch rather than a read receipt —
   * so the fact is now stated on the row, labelled by the renderer and ranked by `hudRowRank`.
   */
  unread: boolean
  /** Last-change time (ms) — drives the row's "reltime" tag and the staleness watchdog. NOT the
   *  row order: see `hudRowRank` for why sorting by this is what made the panel reshuffle. */
  updatedAt: number
}

/**
 * Row order tiers, and the ONE reason the HUD does not sort by recency.
 *
 * `needsYou` → unread `done` → `working` → `idle`: what must be acted on, then what is new for
 * you, then what is merely live, then what has settled. This is the sessions sidebar's own section
 * order (`STATUS_GROUP_ORDER` in renderer/lib/sessionList.ts) — the model the owner asked the notch
 * to follow — so the two surfaces rank a session the same way and can share its vocabulary.
 *
 * The rows used to be sorted `updatedAt` descending, and `updatedAt` is bumped by EVERY feed event
 * including `applyNowChange` — the activity/context ticks a working session emits per tool call. So
 * a busy session climbed to the top every few seconds, and since the panel draws only the first
 * `HUD_ROW_CAP` rows, each climb also changed MEMBERSHIP: the last row dropped off and came back.
 * That was the reported bug ("keeps reshuffling — things disappear and come back"). A tick says
 * nothing about a session's importance, so it must not move the row.
 */
const ROW_RANK: Record<HudRowState, number> = { needsYou: 0, done: 1, working: 2, idle: 3 }

/**
 * The tier a row sorts in (lower = higher up the panel). A `done` row that is no longer unread
 * ranks with `idle`: the tier is "new for you", not "finished". (Today the latch demotes such a row
 * to `idle` before it is ever built, so this only matters if that ever changes — the rank must not
 * quietly promote a read session above a running one.)
 */
export function hudRowRank(row: Pick<HudRow, 'state' | 'unread'>): number {
  if (row.state === 'done' && !row.unread) return ROW_RANK.idle
  return ROW_RANK[row.state]
}

// The collapsed-indicator aggregation used to be duplicated here (`buildIndicator`/`HudIndicator`)
// with no production caller — the HUD renderer, which is the only thing that draws it, cannot
// import src/main. It lived on as dead code and drifted (it never learned the `needsYou` dot the
// renderer draws). The single definition is now `buildIndicator` in src/renderer/hud/indicator.ts.

interface NodeAccum {
  agentId?: string
  sessionId?: string
  state: HudRowState
  prompt?: string
  activity?: string
  contextPercent?: number
  subagents: Map<string, HudSubagentRow>
  /** Last time anything about this node changed — orders rows + gates the stale drop. */
  updatedAt: number
  /** Present in the most recent mirror flush (a node absent from it is "gone"). */
  presentInMirror: boolean
  /** The done highlight has been acknowledged (focused / panel opened) → demote to idle. */
  doneSeen: boolean
  /** The state this node was manually dismissed AT — hidden until it moves off that state.
   *  (A session can hang in `working` forever if its agent dies mid-turn; the HUD would show it
   *  for good. Dismiss hides it, and any genuine state change brings it back.) */
  dismissedAt?: HudRowState
}

/** Map an agent's 4-state model to the HUD's 3 live buckets (waiting/blocked collapse to needsYou). */
export function bucketState(s: AgentState): Exclude<HudRowState, 'idle'> {
  if (s === 'working') return 'working'
  if (s === 'done') return 'done'
  return 'needsYou' // waiting | blocked
}

/**
 * First non-empty line of a prompt/message, trimmed and clipped — the second-line summary.
 *
 * The default clip is the mirror's `PROMPT_MAX`, the SAME constant the phone's Live Activity line
 * is cut at (core/agent-status-mirror.ts): both surfaces are fed by `onNodeStateChange` /
 * `onNodeNowChange` and are meant to say the same sentence, so one prompt must not appear at two
 * lengths. The HUD's own 140 was never load-bearing — `.hud-row__sub` is a single nowrap line with
 * `text-overflow: ellipsis` inside a ~400 px panel, so the visible cut is the CSS one either way.
 * `max` stays a parameter so the helper is reusable for any other clip.
 */
export function firstPromptLine(text: string | undefined, max = PROMPT_MAX): string | undefined {
  if (!text) return undefined
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return undefined
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

export interface HudContextUpdate {
  sessionId?: string
  nodeId?: string
  model?: string | null
  usedPercent?: number
  cleared?: true
}

export interface HudModel {
  /** A main-state edge (working start / needsYou / done). Drives the row's live state + latch. */
  applyStateChange(c: NodeStateChange): void
  /** Activity line + context% tick. */
  applyNowChange(c: NodeNowChange): void
  /** The full mirror table — reconciles presence (for the gone-drop) and seeds unseen nodes. */
  applyMirrorFlush(doc: MirrorFile): void
  /** The normalized agent-event stream — the ONLY source of the user prompt + subagent grouping. */
  applyAgentEvent(ev: NormalizedAgentEvent): void
  /** A context-update {sessionId, model, usedPercent} — the ONLY source of the model name. */
  applyContextUpdate(p: HudContextUpdate): void
  /** Clear ONE node's done highlight (the user opened that row). Read is per row on purpose:
   *  a blanket "the panel was opened, so everything is read" loses sessions the user never saw. */
  noteFocus(nodeId: string): void
  /** Hide a row by hand (a stuck session). It returns if its state genuinely changes. */
  dismiss(nodeId: string): void
  /** Drop nodes gone from the mirror + idle > 6h. Returns true if anything changed. */
  prune(now: number): boolean
  /** Build the row array (active sessions, in `hudRowRank` order), joining titles in. */
  buildRows(now: number, getTitle: (nodeId: string) => string | undefined): HudRow[]
}

/**
 * Create a HUD data model. Every mutation is deterministic and Electron-free; the controller feeds
 * it and calls buildRows on a debounce. `now` is threaded through prune/buildRows so tests control
 * the clock.
 */
export function createHudModel(): HudModel {
  const nodes = new Map<string, NodeAccum>()
  // Model name arrives keyed by sessionId (context tail) — joined to a node via its sessionId.
  const modelBySession = new Map<string, string>()
  // A scoped entry remains present after a clear so this node cannot fall back to another
  // host's session-id observation. Context never creates a phantom HUD row on its own.
  const contextByNode = new Map<string, HudContextUpdate>()

  function ensure(nodeId: string, ts: number): NodeAccum {
    let a = nodes.get(nodeId)
    if (!a) {
      a = {
        state: 'idle',
        subagents: new Map(),
        updatedAt: ts,
        presentInMirror: false,
        doneSeen: false
      }
      nodes.set(nodeId, a)
    }
    return a
  }

  function applyStateChange(c: NodeStateChange): void {
    const a = ensure(c.nodeId, c.ts)
    if (c.agentId) a.agentId = c.agentId
    if (c.sessionId) a.sessionId = c.sessionId
    a.state = c.state
    a.updatedAt = c.ts
    if (c.state === 'working') {
      // A fresh working edge clears a stale done highlight.
      a.doneSeen = false
    } else if (c.state === 'done') {
      // New done → unseen (highlight it) unless this end was an explicit read-ack, or the turn was
      // INTERRUPTED (Esc) / swept as STALE: nothing was accomplished, so there is nothing to go and
      // read. Same rule the notification path uses.
      a.doneSeen = c.ack === true || c.interrupted === true || c.stale === true
    }
  }

  function applyNowChange(c: NodeNowChange): void {
    const a = ensure(c.nodeId, c.ts)
    if (c.activity !== undefined) a.activity = c.activity || undefined
    if (typeof c.contextPercent === 'number') a.contextPercent = c.contextPercent
    a.updatedAt = c.ts
  }

  function applyMirrorFlush(doc: MirrorFile): void {
    const seen = new Set<string>()
    for (const [nodeId, n] of Object.entries(doc.nodes ?? {})) {
      seen.add(nodeId)
      // Is this the FIRST time this process hears of the node? The mirror keeps entries for hours
      // and is re-read at every launch, so a node we're meeting through the file is HISTORY, not an
      // event that just happened here — see the done-seeding rule below.
      const firstSighting = !nodes.has(nodeId)
      const a = ensure(nodeId, n.updatedAt)
      a.presentInMirror = true
      if (n.agentId) a.agentId = n.agentId
      if (n.sessionId) a.sessionId = n.sessionId
      // The mirror is authoritative for a node's coarse state; keep the finer edge-driven state
      // when they agree, but let the mirror move a node OFF working (e.g. holdoff expiry) and
      // seed a node we've never heard an edge from. Don't resurrect a seen-done into unseen.
      if (n.state) {
        const bucket = bucketState(n.state)
        if (bucket === 'done') {
          if (a.state !== 'done') a.state = 'done'
          // A `done` we learn about from the mirror on FIRST sight is pre-seen: it finished before
          // this HUD existed. Otherwise every app launch (and every re-enable of the setting)
          // resurrected up to 6 h of already-read "finished" sessions as fresh green blobs. Only a
          // live done EDGE — a turn that ends while we're watching — earns the highlight.
          if (firstSighting) a.doneSeen = true
        } else {
          a.state = bucket
          if (bucket === 'working') a.doneSeen = false
        }
      }
    }
    for (const [nodeId, a] of nodes) if (!seen.has(nodeId)) a.presentInMirror = false
  }

  function applyAgentEvent(ev: NormalizedAgentEvent): void {
    const nodeId = ev.nodeId
    if (!nodeId) return
    const a = ensure(nodeId, Date.now())
    if (ev.agentId) a.agentId = ev.agentId
    if (ev.sessionId) a.sessionId = ev.sessionId
    // A genuine new turn: capture the user prompt and clear last turn's subagent fan-out.
    if (ev.kind === 'state' && ev.newTurn) {
      if (ev.task) a.prompt = firstPromptLine(ev.task)
      a.subagents.clear()
      a.updatedAt = Date.now()
      return
    }
    if (ev.kind === 'subagent-start' && ev.toolUseId) {
      a.subagents.set(ev.toolUseId, {
        id: ev.toolUseId,
        label: ev.taskLabel || ev.subagentType || undefined,
        state: 'working'
      })
      a.updatedAt = Date.now()
      return
    }
    if (ev.kind === 'subagent-end' && ev.toolUseId) {
      const s = a.subagents.get(ev.toolUseId)
      if (s) s.state = 'done'
      a.updatedAt = Date.now()
      return
    }
    // Session end clears the fan-out (the badge does the same).
    if (ev.kind === 'session' && ev.sessionPhase === 'end') {
      a.subagents.clear()
    }
  }

  function applyContextUpdate(p: HudContextUpdate): void {
    if (!p.sessionId) return
    if (p.nodeId) {
      const previous = contextByNode.get(p.nodeId)
      if (p.cleared && previous && previous.sessionId !== p.sessionId) return
      contextByNode.set(p.nodeId, p.cleared ? { nodeId: p.nodeId, sessionId: p.sessionId, cleared: true } : { ...p })
      return
    }
    if (p.model) modelBySession.set(p.sessionId, p.model)
    if (typeof p.usedPercent === 'number') {
      for (const [nodeId, a] of nodes) {
        if (!contextByNode.has(nodeId) && a.sessionId === p.sessionId) {
          a.contextPercent = p.usedPercent
          break
        }
      }
    }
  }

  function noteFocus(nodeId: string): void {
    const a = nodes.get(nodeId)
    if (a && a.state === 'done') a.doneSeen = true
  }

  function dismiss(nodeId: string): void {
    const a = nodes.get(nodeId)
    if (!a) return
    // Latch the state we're hiding AT, not a boolean: a node stuck in `working` stays hidden, but
    // the moment it really moves (done / needs-you / a new turn) it earns its row back.
    a.dismissedAt = a.state
    if (a.state === 'done') a.doneSeen = true
  }

  function prune(now: number): boolean {
    let changed = false
    for (const [nodeId, a] of nodes) {
      // A LIVE working node is never dropped; a stale one (watchdog above) is fair game.
      if (a.state === 'working' && now - a.updatedAt <= WORKING_STALE_MS) continue
      if (a.presentInMirror) continue
      if (now - a.updatedAt > HUD_STALE_DROP_MS) {
        nodes.delete(nodeId)
        contextByNode.delete(nodeId)
        changed = true
      }
    }
    return changed
  }

  function displayState(a: NodeAccum, now: number): HudRowState {
    // A done session that's been acknowledged demotes to idle (drops out of the row list below).
    if (a.state === 'done' && a.doneSeen) return 'idle'
    // Watchdog: a working session nobody has heard from in WORKING_STALE_MS is presumed gone.
    if (a.state === 'working' && now - a.updatedAt > WORKING_STALE_MS) return 'idle'
    return a.state
  }

  function buildRows(now: number, getTitle: (nodeId: string) => string | undefined): HudRow[] {
    // Collected in `nodes` iteration order — a Map iterates in INSERTION order, and an accum is
    // inserted exactly once (`ensure` sets only when the key is absent; nothing re-sets a live
    // key), so this index is "the order these sessions first appeared to the HUD". That is the
    // tiebreak below: it is a fact no feed event can change, which is precisely what `updatedAt`
    // was not. A pruned node that later returns re-enters at the end of its tier — the only way a
    // row moves within a tier, and it is a genuinely new session as far as the HUD is concerned.
    const rows: { row: HudRow; seen: number }[] = []
    for (const [nodeId, a] of nodes) {
      const state = displayState(a, now)
      // The HUD shows active sessions only — nothing when a node is idle/seen.
      if (state === 'idle') continue
      // Compare against the RAW state, not the display one: the watchdog can flip a dismissed
      // node's display to idle and back without that counting as "it changed".
      if (a.dismissedAt === a.state) continue
      a.dismissedAt = undefined
      const scoped = contextByNode.get(nodeId)
      const current = scoped?.sessionId === a.sessionId && !scoped?.cleared ? scoped : undefined
      const model = scoped ? current?.model : a.sessionId ? modelBySession.get(a.sessionId) : undefined
      const contextPercent = scoped ? current?.usedPercent : a.contextPercent
      rows.push({
        row: {
          nodeId,
          agentId: a.agentId,
          title: getTitle(nodeId) || 'Session',
          ...(model ? { model } : {}),
          state,
          ...(a.prompt ? { prompt: a.prompt } : {}),
          ...(a.activity ? { activity: a.activity } : {}),
          ...(typeof contextPercent === 'number' ? { contextPercent } : {}),
          subagents: [...a.subagents.values()],
          // The latch, said out loud: a finished turn nobody has looked at. `noteFocus` / a
          // read-ack from the phone clears `doneSeen`, which retires the row entirely.
          unread: state === 'done' && !a.doneSeen,
          updatedAt: a.updatedAt
        },
        seen: rows.length
      })
    }
    // Tier first, first-appearance second. Deliberately NOT `updatedAt` on either axis (see
    // `hudRowRank`): a row moves only when the SESSION's state moves, so an activity tick can
    // neither reorder the panel nor push the last row out of the cap and back in.
    rows.sort((x, y) => hudRowRank(x.row) - hudRowRank(y.row) || x.seen - y.seen)
    return rows.map((r) => r.row)
  }

  return {
    applyStateChange,
    applyNowChange,
    applyMirrorFlush,
    applyAgentEvent,
    applyContextUpdate,
    noteFocus,
    dismiss,
    prune,
    buildRows
  }
}
