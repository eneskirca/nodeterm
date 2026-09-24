// The context meter's mount-time rehydration (`context:ensure`), registered through the
// CorePlatform seam so BOTH shells serve it.
//
// This lived inline in `src/main/index.ts`, and the Server Edition had no handler at all — the
// browser cast into the void, so a Server-Edition claude node's meter also filled only on its next
// turn. Exactly the gap `core/transcript-ipc.ts` was moved here to close for the READ channels.
//
// What it is for: a tmux session outlives the app, so after a restart a continuing agent session is
// idle and emits no hook event — and a hook event is the only other thing that ever feeds the
// meter. Without a mount-time read the meter stays blank until the user sends a prompt.
//
// TWO rules shape everything below.
//
// 1. **Per agent, never one resolver for all of them.** Claude's `resolveTranscript` has a cwd
//    fallback that answers *the newest claude transcript for that cwd*, and a codex/gemini session
//    id always misses its sessionId leg — so pointing it at a non-claude node hands that node a
//    STRANGER's session as its meter (wrong numerator and wrong denominator), then flaps against
//    the correct tail. That is why `readsClaudeTranscript` gates the renderer today and why this
//    routes instead of widening it: each agent resolves through its OWN locator and tracks on its
//    OWN tail (whose own `parse` keeps the per-agent token formulas separate, as they must be).
// 2. **A remote session is resolved on the HOST or not at all.** For an SSH-project node the
//    transcript is on the other machine; falling through to any local resolver searches this
//    machine's disk for a file that only ever existed there. So the remote leg's "could not
//    resolve" is TERMINAL, never a fall-through — and it is never remembered as an absence either
//    (see `ContextEnsureDeps.ensureRemote`).
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import type { ContextTail } from './context-tail'
import { locateCodex, locateGemini } from './handoff/locate'
import { resolveTranscript } from './transcript-ipc'
import { SESSION_ID_RE } from './transcript-reader'

/** What an ensure is asked for. `nodeId` is only meaningful to the remote leg. */
export interface ContextEnsureQuery {
  sessionId: string
  cwd: string | undefined
  accountId: string | undefined
  nodeId: string | undefined
  agentId: string | undefined
}

/**
 * The remote leg's answer.
 *
 * `'tracked'` — the host was asked, a transcript was found, the remote tail now has it.
 * `'unresolved'` — this IS a remote session and we do not have a path for it: the host looked and
 *   found nothing, the ControlMaster was down, the home was unresolved, or this agent has no remote
 *   locator at all. Deliberately ONE value: `remoteTranscriptRefFor` cannot tell a clean miss from
 *   a failed ssh call, and inventing that distinction here would be a claim the resolver cannot
 *   support. Both mean the same two things — no meter this pass, and NOTHING cached, so the next
 *   mount (or the next hook event) tries again from scratch. A failed read must never be
 *   remembered as an absence.
 *
 * `null` (not this type) means "not a remote session at all" — take the local path.
 */
export type RemoteEnsureOutcome = 'tracked' | 'unresolved'

export interface ContextEnsureDeps {
  /** Transport/account generation for remote requests; a reconnect must not join an older read. */
  scopeKey?(q: ContextEnsureQuery): string | undefined
  /**
   * The tail that meters this agent locally, or `undefined` when the agent has no local
   * rehydration path. One tail per agent, each with its own `parse` — see `createContextTail`.
   */
  tailFor(agentId: string | undefined): ContextTail | undefined
  /**
   * Resolve + track a REMOTE (SSH-project) node's transcript on its host, or `null` when this is
   * not a remote session — the same `null` convention `TranscriptIpcDeps.readRemote` uses, and the
   * signal to take the local path below. Electron-only: the server has no SSH-project manager, and
   * needs none (it runs ON the host whose transcripts it reads).
   */
  ensureRemote?(q: ContextEnsureQuery): Promise<RemoteEnsureOutcome | null>
}

/**
 * Locate this agent's transcript on the LOCAL disk, or `undefined` when it has no local locator.
 *
 * A closed switch, not a default-to-claude: an agent that reaches here unrecognized gets NO meter,
 * which is the pre-existing behaviour for every non-claude agent and can never be wrong. Adding one
 * means adding its locator here, next to the tail that parses its numbers.
 *
 * - **claude** — `resolveTranscript`, including its `accountId`-scoped cwd fallback (correct here:
 *   the file genuinely is claude's, and the account scoping is what keeps a managed-account node
 *   off the system root).
 * - **codex / gemini** — `locateCodex` / `locateGemini`, keyed STRICTLY by session id with no cwd
 *   fallback, so neither can adopt a session that is not its own.
 * - **grok** — none, and that is by construction rather than an omission. Grok's meter reads
 *   `signals.json` out of a session directory learned from a hook event (`grokSessionDirFor`),
 *   which is empty after a restart; `locateGrok` resolves a different file entirely
 *   (`chat_history.jsonl`, the conversation). There is nothing to rehydrate from.
 */
function localTranscriptFor(
  q: ContextEnsureQuery,
  pathFor?: (s: string) => string | undefined
): Promise<string | undefined> {
  switch (q.agentId) {
    // `undefined` is the legacy call shape (the channel carried no agent id, and its one caller was
    // claude-gated), so it keeps resolving as claude — byte-identical to the pre-split handler.
    case undefined:
    case 'claude':
      return resolveTranscript(
        { sessionId: q.sessionId, cwd: q.cwd, accountId: q.accountId },
        pathFor
      )
    case 'codex':
      return locateCodex(q.sessionId)
    case 'gemini':
      return locateGemini(q.sessionId)
    default:
      return Promise.resolve(undefined)
  }
}

export function registerContextEnsureIpc(deps: ContextEnsureDeps): void {
  // Ensure calls arrive on mount, and the renderer's effect re-runs when the session id, cwd or
  // observed account changes — so the same session can be asked for twice while the first answer
  // (an ssh round-trip, on a canvas that can hold dozens of remote nodes) is still in flight.
  // De-duplicating the IN-FLIGHT call is not a cache: nothing is remembered once it settles, so a
  // resolve that failed is retried by the next ensure exactly as if this guard were not here.
  const inFlight = new Set<string>()

  platform().on(
    IPC.contextEnsure,
    async (
      sessionId?: string,
      cwd?: string,
      accountId?: string,
      nodeId?: string,
      agentId?: string
    ): Promise<void> => {
      if (!sessionId || !SESSION_ID_RE.test(sessionId)) return
      const q: ContextEnsureQuery = { sessionId, cwd, accountId, nodeId, agentId }
      const key = JSON.stringify([agentId, sessionId, nodeId, accountId, cwd, deps.scopeKey?.(q)])
      if (inFlight.has(key)) return
      inFlight.add(key)
      try {
        // Remote first, and its answer is TERMINAL either way. A remote session that could not be
        // resolved must not fall through to the local resolver: that reads the wrong machine's
        // disk, which for claude means metering an unrelated local session under this node's id.
        if (deps.ensureRemote && (await deps.ensureRemote(q)) !== null) return
        const tail = deps.tailFor(agentId)
        if (!tail) return
        // The tail's own path is the authoritative hint for claude's resolver (hook-fed when
        // present) AND the early-out for everyone: a session already tracked needs no scan.
        if (tail.pathFor(sessionId)) {
          tail.replay(sessionId)
          return
        }
        const p = await localTranscriptFor(q, (s) => tail.pathFor(s))
        if (p) tail.track(sessionId, p)
      } finally {
        inFlight.delete(key)
      }
    }
  )
}
