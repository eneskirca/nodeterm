/**
 * THE ONE QUESTION EVERY MEMORY LEVER MUST ASK BEFORE IT KILLS A PTY CLIENT: would that kill end
 * work the user has running?
 *
 * The renderer reclaims terminal memory in four places, and all four are written as if dropping a
 * PTY client were free — "the tmux session keeps running and re-attach redraws". That sentence is
 * true only where tmux is actually underneath. On the plain-shell fallback (no tmux installed,
 * tmux switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so
 * the identical call kills the shell and every process under it — an agent CLI mid-turn included.
 *
 * Reported as issue #126: switching projects terminated a working Claude agent, which then
 * auto-resumed from wherever the kill landed ("terminated mid action"). Three of the four levers
 * are the park's (window expiry, LRU cap, memory-pressure drop — see `park-budget.ts`); the fourth
 * is the offscreen viewer release (`offscreen-policy.ts`). They differ in everything except this
 * question, which is why it lives here on its own rather than in whichever module happened to
 * need it first.
 *
 * The predicate is deliberately the NARROWEST one that closes the bug: it takes both halves, and
 * either half alone leaves today's behavior untouched. A tmux-backed session is never protected
 * (the kill costs a redraw, and protecting it would forfeit real memory on the setups where
 * reclaiming it is free); a plain terminal, a finished agent and an unknown state are never
 * protected either (nothing is running to lose).
 */
import { WORKING_STALE_MS } from '@shared/agents/stale'
import type { AgentState } from '@shared/agents/normalize'

/**
 * Agent states that mean the CLI is mid-task or holding something open for the user. The same set
 * hibernation refuses to `/exit` (`hibernation-policy.ts`) and for the same reasons: `working` is
 * a turn in flight, `waiting`/`blocked` is a question or a permission request the user is being
 * asked to come back for. `done` and unknown are not evidence of live work.
 */
const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'working',
  'waiting',
  'blocked'
])

export interface LiveWorkInput {
  /**
   * The session survives losing this client — a tmux session, local or remote
   * (`PtyCreateResult.persistent`). False = the plain-shell fallback, where the pty is the shell.
   */
  tmuxBacked: boolean
  /** The node's live agent state (`agentStatus.byId[nodeId].state`); absent = a plain terminal, or
   *  no hook event seen for it yet. */
  agentState?: AgentState
}

/** Would tearing down this terminal's PTY client destroy work that is still running? */
export function wouldKillLiveWork(i: LiveWorkInput): boolean {
  return !i.tmuxBacked && !!i.agentState && LIVE_AGENT_STATES.has(i.agentState)
}

/**
 * The state to judge a PARKED terminal by: the live store read, with the state captured at park
 * time as a FLOOR under it.
 *
 * A snapshot alone would be stale and a live read alone is not available — because the unmount
 * that parks a terminal is the same unmount that CLEARS its agent status. TerminalNode's
 * departure-only effect exists so a project switch doesn't leave a stale RUNNING badge behind, and
 * it runs right after the lifecycle cleanup that created the park. Every park lever reads the
 * store later than that — the LRU in a microtask, the expiry minutes on — so every one of them saw
 * `undefined` and called a working agent disposable. That is the reported #126 case (a project
 * switch past `PARK_MAX`) and, worse, it made `waiting`/`blocked` parks unprotectable in
 * principle: an agent holding a question open emits no further hook events, so nothing would ever
 * repopulate the store for it.
 *
 * The floor is only a floor, never a latch: hook events for a parked node still land in the store
 * (Canvas's `agent:status` listener is keyed by node id, not by what is mounted), so a turn that
 * ENDS while parked releases the protection on the next re-check, and one that starts adds it.
 * Live truth always wins; the snapshot only answers when there is no live truth to have.
 */
export function effectiveAgentState(
  live: AgentState | undefined,
  atParkTime: AgentState | undefined
): AgentState | undefined {
  return live ?? atParkTime
}

/**
 * The park-time snapshot, AGED: a `working` snapshot stops counting once it is older than
 * `WORKING_STALE_MS`; every other state keeps counting indefinitely.
 *
 * WHY THE SNAPSHOT NEEDS AN EXPIRY THE LIVE STATE DOES NOT. A `working` session that dies without
 * saying so is an ordinary event (Esc during a tool call runs no Stop hook, a killed CLI, a slept
 * machine, a dropped link), and the product already has one answer for it: the stale-working
 * sweep. Neither copy of that sweep can reach a PARKED node's snapshot, though — the renderer's
 * matches `state === 'working'` in the store, and the departure clear on the parking unmount has
 * already blanked that entry; the core's mirror fires an `onNodeStateChange` edge that reaches its
 * own consumers but never the renderer's `agent:status` IPC. So nothing would ever retire this
 * evidence, and the park would re-arm its expiry for the rest of the run, permanently holding one
 * of `PARK_MAX` slots for a session that no longer exists.
 *
 * The window is the SHARED constant, not a new number: this is the same judgment call about the
 * same signal ("a working node this quiet is presumed gone"), and two numbers for one question
 * drift apart. A LIVE `working` reading is deliberately never aged here — the store still knows
 * about that node, so the renderer sweep can and does correct it, and second-guessing a store that
 * says "working" right now would kill a real turn.
 *
 * `waiting`/`blocked` never expires, and that asymmetry is the point: a question held open is not
 * a stale signal, it is a session waiting for the user, and no elapsed time makes ending it right.
 * A snapshot with no timestamp cannot be aged and is treated as fresh — the safe direction, since
 * the alternative drops a live agent's protection over a bookkeeping omission.
 */
export function parkedStateFloor(
  atParkTime: AgentState | undefined,
  parkedAt: number | undefined,
  now: number
): AgentState | undefined {
  if (atParkTime !== 'working' || parkedAt === undefined) return atParkTime
  return now - parkedAt > WORKING_STALE_MS ? undefined : atParkTime
}
