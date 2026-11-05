import type { ChatSendRefusal } from './chatSendGate'

/**
 * Pure decisions behind the ⌘M panel's live progress (`nodes/ChatPanel.tsx`): the status row at the
 * end of the thread while the agent works, and the throttled tail refresh that makes the answer
 * appear as it is written instead of only when the turn ends.
 */

/**
 * Minimum gap between two tail reads started by hook events. An SSH project reads its transcript
 * over ssh (a ranged `dd` per read), and a busy turn fires a hook event per tool call — so the
 * refresh is throttled, with a TRAILING read guaranteed (see `planLiveReload`), so the last event
 * of a burst is never lost.
 */
export const CHAT_LIVE_RELOAD_MIN_MS = 1500

/**
 * How long the working row shows after a send with no `working` hook event behind it. Normally
 * UserPromptSubmit flips the state within a second and the real state takes over; this bounds the
 * row for an agent whose hooks never report (a custom agent, a session with hooks unwired), so a
 * spinner can never spin forever over a turn nobody is tracking.
 */
export const CHAT_OPTIMISTIC_WORKING_MS = 15_000

/**
 * Extra tail reloads after a turn ends, in ms from the working -> idle edge. Claude Code fires its
 * Stop hook (our `done`) BEFORE it appends the turn's final reply to the transcript — measured ~50 ms
 * apart — so the one reload at `done` reads the file too early, the live refresh has already
 * stopped (`planLiveReload` skips once the agent is idle), and the reply only appeared after
 * reopening the view. A fixed schedule rather than "retry until the last message is the
 * assistant's": a turn that ends on a tool call already has an assistant message last while its
 * final text is still unwritten.
 */
export const TURN_END_RELOAD_DELAYS_MS: readonly number[] = [500, 2000]

/**
 * Does a turn-end reload keep the unconfirmed sends on screen (`applyTail`'s `carryUnconfirmed`)?
 * Every reload but the LAST in the schedule does: a prompt sent right as the turn ended may not be
 * in the transcript yet. The last one reconciles outright — a send that never landed must not
 * linger — unless the agent is working again, i.e. that prompt is the turn now running.
 */
export function turnEndReloadCarries(s: { final: boolean; working: boolean }): boolean {
  return !s.final || s.working
}

/**
 * How often an open chat view re-reads the pane's screen for the agent's own dialogs
 * (shared/agents/claude-screen.ts) — they fire no hook, so this is the only way to disable the
 * composer while one is up. One local `tmux capture-pane` per tick.
 */
export const CHAT_SCREEN_POLL_MS = 2000

/**
 * When Claude draws its suggested next prompt. MEASURED on Claude Code 2.1.318 (5 turns, Haiku, a
 * sandboxed tmux server): 1.1-2.2 s after the turn ended; one more turn got none.
 *
 * Locally, the regular 2 s poll added up to 2 s on top, which read as a lag after the reply. So for
 * a few seconds after a turn ends the panel reads faster, and stops at the first suggestion: about
 * 15 more local screen reads per turn, at most.
 */
export const SUGGESTION_BURST_MS = 300
export const SUGGESTION_BURST_WINDOW_MS = 5000

/** Did this state change end a turn? Only then is a suggestion on its way (`SUGGESTION_BURST_MS`). */
export function endsTurn(prev: string | undefined, next: string | undefined): boolean {
  return next === 'done' && (prev === 'working' || prev === 'waiting' || prev === 'blocked')
}

/** When an SSH node's chat view reads the pane for the suggestion, counted from the turn's end. An
 *  SSH pane is never polled (each read is a round trip to the host), so it is read twice instead,
 *  after the measured window above and once more later. */
export const REMOTE_SUGGESTION_READ_DELAYS_MS: readonly number[] = [2500, 6000]

/**
 * Should the panel poll the pane's screen? Only for an agent whose screen we can read, only for a
 * LOCAL pane (each read of an SSH or relay pane is a network round trip, every two seconds, for as
 * long as the view is open — those rely on the check at send time alone), and only while no other
 * refusal already explains the pane: a hook-reported dialog or a shell-owned pane stands the
 * composer down on its own. `working` still polls — a harness dialog can open mid-turn.
 */
export function shouldPollScreen(s: {
  readable: boolean
  readOnly: boolean
  remote: boolean
  refusal: ChatSendRefusal
}): boolean {
  return s.readable && !s.readOnly && !s.remote && (s.refusal === null || s.refusal === 'working')
}

/**
 * Does THIS tick of the screen poll run? Not while the page is hidden (the original gate), and not
 * while the window is unfocused: a nodeterm window left visible on a second monitor is not hidden
 * by Chromium's definition, so the hidden gate alone kept every chat view spawning a `tmux
 * capture-pane` every 2 s — ~30 spawns a minute per open chat view — for a composer nobody could
 * type into. The panel re-ticks on `focus`, so the
 * screen is re-read the moment someone can act on it, and a send re-checks the screen in core
 * (`pty.sendChatPrompt`) regardless, so skipping a tick never weakens dialog safety.
 *
 * `focused: null` is "could not tell" and polls: a hint must fail toward the old behaviour.
 */
export function screenPollTickAllowed(s: { hidden: boolean; focused: boolean | null }): boolean {
  if (s.hidden) return false
  return s.focused !== false
}

/**
 * Window focus as a hint for `screenPollTickAllowed`: `null` when the document cannot answer (no
 * `hasFocus` — a test DOM, an exotic embedder — or it throws), never a guessed `false`.
 */
export function windowFocusHint(doc: { hasFocus?: () => boolean } | undefined): boolean | null {
  if (doc === undefined || typeof doc.hasFocus !== 'function') return null
  try {
    return doc.hasFocus()
  } catch {
    return null
  }
}

/** What the row at the end of the thread says; `null` = no row. */
export type ChatActivity = 'working' | 'dialog' | null

/**
 * Derived from the composer's send refusal (`lib/chatSendGate.ts`), not from the raw state, so the
 * row and the placeholder can never disagree — and a pane the CLI has left (asleep / paused /
 * dropped / exited) shows no spinner even while a stale `working` or an optimistic send says so.
 * `optimistic` = the user just sent and no state change has happened since (the glue retires it on
 * the next state change or after `CHAT_OPTIMISTIC_WORKING_MS`). A read-only transcript (a closed
 * node) has no live session to report on.
 */
export function chatActivity(s: { refusal: ChatSendRefusal; optimistic: boolean; readOnly: boolean }): ChatActivity {
  if (s.readOnly) return null
  if (s.refusal === 'working') return 'working'
  if (s.refusal === 'dialog') return 'dialog'
  if (s.refusal === null && s.optimistic) return 'working'
  return null
}

export type LiveReloadPlan = { kind: 'run' } | { kind: 'wait'; ms: number } | { kind: 'hold' } | { kind: 'skip' }

/**
 * A hook event arrived for this node (or a deferred one is being retried): what now?
 * - `skip` — the agent is no longer working. The working→idle reload already reads the final tail;
 *   a pending event is dropped.
 * - `hold` — keep the event pending and do nothing: a tail read is in flight (never overlap one —
 *   its settle retries), or the panel has no layout box / the document is hidden (the same gate as
 *   paging; reveal and visibilitychange retry). A hidden panel costs no ssh round trips.
 * - `wait` — a read started less than `minMs` ago: retry after the rest of the interval (the
 *   trailing call).
 * - `run` — read the tail now.
 */
export function planLiveReload(s: {
  working: boolean
  visible: boolean
  inFlight: boolean
  now: number
  lastStartAt: number | null
  minMs?: number
}): LiveReloadPlan {
  const minMs = s.minMs ?? CHAT_LIVE_RELOAD_MIN_MS
  if (!s.working) return { kind: 'skip' }
  if (s.inFlight || !s.visible) return { kind: 'hold' }
  if (s.lastStartAt !== null) {
    const since = s.now - s.lastStartAt
    if (since < minMs) return { kind: 'wait', ms: minMs - since }
  }
  return { kind: 'run' }
}
