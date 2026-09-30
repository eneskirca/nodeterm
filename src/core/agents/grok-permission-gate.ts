// Grok's NEEDS YOU, confirmed against grok's own session event log before it is published and
// cleared by that log when the dialog is answered.
//
// WHY. Grok's only "a permission dialog is open" signal is a `notification` hook with
// `notificationType: 'permission_prompt'`, which `normalizeGrok` maps to `blocked`. MEASURED on grok
// 1.0.13 (2026-09-30, interactive TUI against a local fake chat_completions model — fixture
// `src/shared/agents/__fixtures__/grok/permission-events.json`), that hook is honest about the
// OPENING and silent about everything after it:
//
//   - approved in the pane: NO hook until the approved tool FINISHES. The fixture's command slept
//     10 s, so the node sat on NEEDS YOU for 10 s while the agent was working.
//   - dismissed (Ctrl+C): NO hook at all. The turn is cancelled, and the only later hook is
//     `idle_prompt` 60 s afterwards, which the status mirror deliberately does NOT let clear a
//     `blocked` node (a node that is blocked is also idle at its prompt). So the node kept NEEDS YOU
//     until the next prompt: a stuck badge.
//   - rejected ("No, reject"): a `permission_denied` hook (→ `working`), then the turn is cancelled
//     with no Stop hook, so the node read RUNNING until the idle rescue 60 s later.
//
// Grok DOES record all of it, in `<session dir>/events.jsonl` (a sibling of `chat_history.jsonl`,
// not in its shipped docs' layout list):
//
//   {"type":"permission_requested","tool_name":"run_terminal_command","ts":"…Z"}
//   {"type":"permission_resolved","tool_name":"…","decision":"allow"|"deny"|"cancelled","wait_ms":N}
//   {"type":"turn_ended","outcome":"cancelled","cancellation_category":"permission_cancelled"|…}
//
// `permission_requested` is written ~5 ms BEFORE the notification hook fires (1–20 ms across the
// captures), so at the moment the hook arrives the file already says whether the dialog is open.
//
// THE TRAP this module is shaped around: a SUBAGENT's permission prompt fires its notification with
// the PARENT's `sessionId`, while its `permission_requested` is written to the CHILD's own
// `events.jsonl`. Reading the parent's file alone would find the parent's EARLIER, already resolved
// request and publish "resolved" over a real, open child dialog — suppressing an ask, which is the
// worse of the two failures. So a notification is tied to exactly ONE request: the latest
// `permission_requested` written within a few seconds of the notification's own timestamp, across
// the sessions this node's hooks have named (parent and children — a child's own hooks carry the
// child's id). Zero candidates or more than one means "we cannot tell", and the hook is published
// exactly as before.
//
// RULES (each is a refusal; every "cannot tell" is today's behaviour, never a guess):
//   - Closed sets: the four record types above, the three decisions. An unknown decision, an
//     unreadable or missing file, an unparsable timestamp: the notification is published unchanged
//     and nothing watches it.
//   - Only a POSITIVE resolution record changes what is shown. Absence of a record is never evidence.
//   - Events derived from the file are published UNVERIFIED (a file read is not a hook POST), the
//     same rule the claude turn-interrupt marker follows.
//   - The watch is bounded (`pendingMaxMs` while the dialog is open, `afterResolutionMaxMs` after),
//     and it costs one `stat` per poll while nothing changes.
//   - Hook ordering is preserved per node: while a confirm read is in flight, that node's later
//     hook events wait behind it, so a stale `blocked` can never land after a newer event.
//
// A REMOTE (SSH) grok node's session lives on its host; the local file does not exist, so the
// read answers "cannot tell" and the node behaves exactly as before. Lives in the hook server, so
// Desktop and Server Edition get it from one place.
import path from 'path'
import { promises as fsp } from 'fs'
import { grokRawFields, type NormalizedAgentEvent } from '../../shared/agents/normalize'
import { grokSessionDir, grokSessionsDir } from './grok-paths'

export const GROK_EVENTS_FILE = 'events.jsonl'

/** The decisions grok 1.0.13 writes on `permission_resolved`. Closed: anything else is unknown. */
export const GROK_PERMISSION_DECISIONS = ['allow', 'deny', 'cancelled'] as const
export type GrokPermissionDecision = (typeof GROK_PERMISSION_DECISIONS)[number]

export type GrokEventRecord =
  | { type: 'turn_started'; ts: number }
  | { type: 'turn_ended'; ts: number; outcome: string | undefined }
  | { type: 'permission_requested'; ts: number; toolName: string | undefined }
  | { type: 'permission_resolved'; ts: number; toolName: string | undefined; decision: string | undefined }

const TRACKED = new Set(['turn_started', 'turn_ended', 'permission_requested', 'permission_resolved'])

/** Parse the records this module reads. Other types and malformed lines are skipped. */
export function parseGrokEvents(text: string): GrokEventRecord[] {
  const out: GrokEventRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"type"')) continue
    let r: Record<string, unknown>
    try {
      r = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!r || typeof r !== 'object' || typeof r.type !== 'string' || !TRACKED.has(r.type)) continue
    const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN
    if (!Number.isFinite(ts)) continue
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    if (r.type === 'turn_started') out.push({ type: 'turn_started', ts })
    else if (r.type === 'turn_ended') out.push({ type: 'turn_ended', ts, outcome: str(r.outcome) })
    else if (r.type === 'permission_requested')
      out.push({ type: 'permission_requested', ts, toolName: str(r.tool_name) })
    else
      out.push({
        type: 'permission_resolved',
        ts,
        toolName: str(r.tool_name),
        decision: str(r.decision)
      })
  }
  return out
}

/** How far BEFORE the notification its request may have been written, and how far after. */
export const GROK_REQUEST_WINDOW_BEFORE_MS = 5_000
export const GROK_REQUEST_WINDOW_AFTER_MS = 500

/** Index of the latest `permission_requested` written within the window around `notifiedAt`, or
 *  null. "Latest" because two prompts in one burst are answered newest-first on screen too. */
export function requestNear(records: GrokEventRecord[], notifiedAt: number): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.type !== 'permission_requested') continue
    const lead = notifiedAt - r.ts
    if (lead <= GROK_REQUEST_WINDOW_BEFORE_MS && lead >= -GROK_REQUEST_WINDOW_AFTER_MS) return i
    // Older requests only get older; stop at the first one outside the window.
    if (lead > GROK_REQUEST_WINDOW_BEFORE_MS) return null
  }
  return null
}

export type GrokPermissionVerdict =
  | { phase: 'pending' }
  | {
      phase: 'resolved'
      decision: GrokPermissionDecision
      /** When grok recorded the answer. */
      resolvedTs: number
      /** Present once the turn has ended after the resolution. */
      turnEnded?: 'cancelled' | 'other'
    }
  /** A newer turn began: whatever happened to this dialog, it is no longer what the node is doing. */
  | { phase: 'superseded' }
  | { phase: 'unknown' }

/**
 * What became of the request with timestamp `reqTs` and tool `toolName`. Requests inside one turn
 * are answered one at a time, so the pairing is by ORDER within the turn: the k-th request since
 * the turn started is answered by the k-th resolution. A resolution naming a different tool than
 * its request means the pairing is not what we think it is: unknown.
 */
export function permissionVerdict(
  records: GrokEventRecord[],
  reqTs: number,
  toolName: string | undefined
): GrokPermissionVerdict {
  const at = records.findIndex(
    (r) => r.type === 'permission_requested' && r.ts === reqTs && r.toolName === toolName
  )
  if (at < 0) return { phase: 'unknown' }
  let start = 0
  for (let i = at; i >= 0; i--) {
    if (records[i].type === 'turn_started') {
      start = i
      break
    }
  }
  let ordinal = 0
  for (let i = start; i <= at; i++) if (records[i].type === 'permission_requested') ordinal++
  let seen = 0
  let resolvedAt = -1
  let decision: string | undefined
  let resolvedTs = 0
  for (let i = start; i < records.length; i++) {
    const r = records[i]
    if (i > at && r.type === 'turn_started') return { phase: 'superseded' }
    if (r.type !== 'permission_resolved') continue
    seen++
    if (seen === ordinal) {
      if (i < at || r.toolName !== toolName) return { phase: 'unknown' }
      resolvedAt = i
      decision = r.decision
      resolvedTs = r.ts
      break
    }
  }
  if (resolvedAt < 0) return { phase: 'pending' }
  if (!(GROK_PERMISSION_DECISIONS as readonly string[]).includes(decision ?? '')) return { phase: 'unknown' }
  for (let i = resolvedAt + 1; i < records.length; i++) {
    const r = records[i]
    if (r.type === 'turn_started') return { phase: 'superseded' }
    if (r.type === 'turn_ended') {
      return {
        phase: 'resolved',
        decision: decision as GrokPermissionDecision,
        resolvedTs,
        turnEnded: r.outcome === 'cancelled' ? 'cancelled' : 'other'
      }
    }
  }
  return { phase: 'resolved', decision: decision as GrokPermissionDecision, resolvedTs }
}

/** True for the normalized event a grok `permission_prompt` notification produces. */
export function isGrokPermissionPrompt(payload: Record<string, unknown>, e: NormalizedAgentEvent | null): boolean {
  if (!e || e.kind !== 'state' || e.state !== 'blocked') return false
  if (grokRawFields(payload).event !== 'notification') return false
  const p = payload as { notificationType?: unknown; notification_type?: unknown; type?: unknown }
  return (p.notificationType ?? p.notification_type ?? p.type) === 'permission_prompt'
}

export interface GrokPermissionGateDeps {
  sessionsDir: () => string
  /** The file's text, or null when it cannot be read. */
  readFile: (file: string) => Promise<string | null>
  /** size + mtime, or null when it cannot be stat'ed. */
  stat: (file: string) => Promise<{ size: number; mtimeMs: number } | null>
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  pollMs: number
  /** How long an OPEN dialog is watched before the gate gives up (the badge then stays as is). */
  pendingMaxMs: number
  /** After a deny/cancel resolution, how long to wait for the turn to end. */
  afterResolutionMaxMs: number
  /** A confirm read slower than this publishes the hook unchanged. */
  confirmTimeoutMs: number
}

/** Past this size only the file's tail is read; a turn's records are always near the end. */
export const GROK_EVENTS_READ_MAX_BYTES = 4 * 1024 * 1024

async function readTail(file: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    fh = await fsp.open(file, 'r')
    const { size } = await fh.stat()
    const len = Math.min(size, GROK_EVENTS_READ_MAX_BYTES)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    let text = buf.toString('utf8')
    // A cut first line is half a record; drop it.
    if (len < size) text = text.slice(text.indexOf('\n') + 1)
    return text
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

export const defaultGrokPermissionGateDeps = (): GrokPermissionGateDeps => ({
  sessionsDir: () => grokSessionsDir(),
  readFile: readTail,
  stat: async (file) => {
    try {
      const s = await fsp.stat(file)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  pollMs: 1_000,
  pendingMaxMs: 6 * 60 * 60 * 1000,
  afterResolutionMaxMs: 60_000,
  confirmTimeoutMs: 500
})

/** Sessions remembered per node (the parent and its recent children). */
const SESSIONS_PER_NODE = 16

interface Episode {
  file: string
  reqTs: number
  toolName: string | undefined
  /** The session id the hook named (the PARENT for a child's prompt): what synthetic events carry. */
  hookSessionId: string | undefined
  resolved: boolean
  startedAt: number
  resolvedAt: number
  timer: unknown
  lastStat: string
}

interface NodeState {
  sessions: Map<string, string> // sessionId → cwd, insertion order = recency
  chain: Promise<void>
  episode: Episode | null
  /** Bumped on every hook event delivered for the node. A poll whose read straddled one discards
   *  its answer and asks again next tick, so a file read can never land AFTER a newer hook. */
  gen: number
}

export interface GrokPermissionGate {
  /** Every grok hook event goes through here; `deliver` is the hook server's listener. */
  handle(nodeId: string, payload: Record<string, unknown>, e: NormalizedAgentEvent | null): void
  dispose(): void
}

export function createGrokPermissionGate(
  deliver: (e: NormalizedAgentEvent) => void,
  deps: GrokPermissionGateDeps = defaultGrokPermissionGateDeps()
): GrokPermissionGate {
  const nodes = new Map<string, NodeState>()
  let disposed = false

  // The listener fans out to several subsystems; one throw must cost that ONE event (as it did
  // inside the hook server's try/catch before this gate existed), never the node's delivery chain.
  let warned = false
  const safeDeliver = (e: NormalizedAgentEvent): void => {
    try {
      deliver(e)
    } catch (err) {
      if (!warned) {
        warned = true
        console.warn('[grok-permission-gate] listener threw; event dropped', err)
      }
    }
  }

  const stateOf = (nodeId: string): NodeState => {
    let s = nodes.get(nodeId)
    if (!s) {
      s = { sessions: new Map(), chain: Promise.resolve(), episode: null, gen: 0 }
      nodes.set(nodeId, s)
    }
    return s
  }

  const remember = (s: NodeState, sessionId: string | undefined, cwd: string | undefined): void => {
    if (!sessionId || !cwd) return
    s.sessions.delete(sessionId)
    s.sessions.set(sessionId, cwd)
    while (s.sessions.size > SESSIONS_PER_NODE) s.sessions.delete(s.sessions.keys().next().value as string)
  }

  const endEpisode = (s: NodeState): void => {
    if (s.episode?.timer) deps.clearTimer(s.episode.timer)
    s.episode = null
  }

  const synthetic = (nodeId: string, ep: Episode, patch: Partial<NormalizedAgentEvent>): void => {
    safeDeliver({
      nodeId,
      agentId: 'grok',
      kind: 'state',
      ...(ep.hookSessionId ? { sessionId: ep.hookSessionId } : {}),
      verified: false,
      ...patch
    })
  }

  /** Apply a verdict to an open episode. Returns true when the episode is over. */
  const applyVerdict = (nodeId: string, ep: Episode, v: GrokPermissionVerdict): boolean => {
    if (v.phase === 'unknown' || v.phase === 'superseded') return true
    if (v.phase === 'pending') return deps.now() - ep.startedAt > deps.pendingMaxMs
    if (v.turnEnded === 'cancelled') {
      synthetic(nodeId, ep, { state: 'done', interrupted: true })
      return true
    }
    if (!ep.resolved) {
      ep.resolved = true
      ep.resolvedAt = deps.now()
      synthetic(nodeId, ep, { state: 'working' })
    }
    // Approved: the tool runs and grok's own PostToolUse/Stop hooks take over from here.
    if (v.decision === 'allow' || v.turnEnded === 'other') return true
    return deps.now() - ep.resolvedAt > deps.afterResolutionMaxMs
  }

  // Polls run OFF the node's delivery chain: a slow or hung read must never hold hook events back.
  const poll = (nodeId: string, s: NodeState, ep: Episode): void => {
    ep.timer = deps.setTimer(() => {
      ep.timer = null
      if (disposed || s.episode !== ep) return
      void (async () => {
        const gen = s.gen
        const expired = (): boolean =>
          ep.resolved
            ? deps.now() - ep.resolvedAt > deps.afterResolutionMaxMs
            : deps.now() - ep.startedAt > deps.pendingMaxMs
        let done: boolean
        try {
          const st = await deps.stat(ep.file)
          const key = st ? `${st.size}:${st.mtimeMs}` : ''
          if (s.episode !== ep || disposed) return
          if (!st) done = true
          else if (key === ep.lastStat) done = expired()
          else {
            const text = await deps.readFile(ep.file)
            if (s.episode !== ep || disposed) return
            if (s.gen !== gen) done = expired()
            else {
              ep.lastStat = key
              done =
                text === null
                  ? true
                  : applyVerdict(nodeId, ep, permissionVerdict(parseGrokEvents(text), ep.reqTs, ep.toolName))
            }
          }
        } catch {
          done = true
        }
        if (s.episode !== ep) return
        if (done) endEpisode(s)
        else poll(nodeId, s, ep)
      })()
    }, deps.pollMs)
  }

  const confirm = async (
    nodeId: string,
    s: NodeState,
    payload: Record<string, unknown>,
    e: NormalizedAgentEvent,
    out: (e: NormalizedAgentEvent) => void
  ): Promise<void> => {
    // A new prompt is what the node now shows, whether or not it can be tied to a request: the
    // previous watch must not go on to publish ITS dialog's answer over this one. (Found by the
    // subagent replay: the parent's spawn approval landed 90 ms before the child's prompt.)
    endEpisode(s)
    const raw = payload as { timestamp?: unknown }
    const notifiedAt = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN
    if (!Number.isFinite(notifiedAt)) return out(e)
    const matches: { file: string; records: GrokEventRecord[]; index: number }[] = []
    // A SNAPSHOT: a hook arriving while a read is awaited re-inserts its session into the live Map,
    // and iterating that Map would read the same file twice and count two matches.
    for (const [sessionId, cwd] of [...s.sessions]) {
      const dir = grokSessionDir({ sessionsDir: deps.sessionsDir(), cwd, sessionId })
      if (!dir) continue
      const file = path.join(dir, GROK_EVENTS_FILE)
      const text = await deps.readFile(file)
      if (text === null) continue
      const records = parseGrokEvents(text)
      const index = requestNear(records, notifiedAt)
      if (index !== null) matches.push({ file, records, index })
    }
    // Zero: nothing ties this notification to a request. Two or more: we cannot say which one it
    // is about. Either way the hook is published exactly as it always was.
    if (matches.length !== 1) return out(e)
    const m = matches[0]
    const req = m.records[m.index] as Extract<GrokEventRecord, { type: 'permission_requested' }>
    const verdict = permissionVerdict(m.records, req.ts, req.toolName)
    if (verdict.phase !== 'pending' && verdict.phase !== 'resolved') return out(e)
    // A notification cannot be about a request that was answered BEFORE it fired. When the matched
    // request's answer predates the notification, the real request is one we did not find (a
    // child whose own hooks have not reached us yet, or a second request whose line is not on disk
    // yet) — so the hook is published unchanged and nothing is watched. Every legitimate case in
    // the captures resolves after its notification (the fastest, 216 ms after).
    if (verdict.phase === 'resolved' && verdict.resolvedTs < notifiedAt) return out(e)
    const ep: Episode = {
      file: m.file,
      reqTs: req.ts,
      toolName: req.toolName,
      hookSessionId: e.sessionId,
      resolved: false,
      startedAt: deps.now(),
      resolvedAt: 0,
      timer: null,
      lastStat: ''
    }
    endEpisode(s)
    if (verdict.phase === 'pending') {
      out(e)
    } else {
      // Answered between the notification and our read: publish what the file says instead of a
      // dialog that is no longer on screen. The STATE now comes from a file read, so it is
      // unverified like everything the watch derives.
      ep.resolved = true
      ep.resolvedAt = deps.now()
      if (verdict.turnEnded === 'cancelled')
        return out({ ...e, state: 'done', interrupted: true, lastMessage: undefined, verified: false })
      out({ ...e, state: 'working', lastMessage: undefined, verified: false })
      if (verdict.decision === 'allow' || verdict.turnEnded === 'other') return
    }
    s.episode = ep
    poll(nodeId, s, ep)
  }

  const withTimeout = (p: Promise<void>, fallback: () => void): Promise<void> =>
    new Promise<void>((resolve) => {
      let settled = false
      const t = deps.setTimer(() => {
        if (settled) return
        settled = true
        fallback()
        resolve()
      }, deps.confirmTimeoutMs)
      p.then(
        () => {
          if (settled) return
          settled = true
          deps.clearTimer(t)
          resolve()
        },
        () => {
          if (settled) return
          settled = true
          deps.clearTimer(t)
          fallback()
          resolve()
        }
      )
    })

  return {
    handle(nodeId, payload, e) {
      if (disposed) {
        if (e) safeDeliver(e)
        return
      }
      const s = stateOf(nodeId)
      const g = grokRawFields(payload)
      remember(s, g.sessionId, g.cwd)
      if (g.subagentId) remember(s, g.subagentId, g.cwd)
      if (e && isGrokPermissionPrompt(payload, e)) {
        s.chain = s.chain.then(() => {
          let published = false
          const once = (ev: NormalizedAgentEvent): void => {
            if (published) return
            published = true
            s.gen++
            safeDeliver(ev)
          }
          const guarded = confirm(nodeId, s, payload, e, once).catch(() => once(e))
          return withTimeout(guarded, () => once(e))
        }).catch(() => {})
        return
      }
      s.chain = s.chain.then(() => {
        s.gen++
        if (e) safeDeliver(e)
        const ep = s.episode
        if (!ep || !e) return
        // A new turn or a session boundary on the episode's session ends the watch: the dialog it
        // was about belongs to a turn that is over.
        if ((e.newTurn || e.kind === 'session') && e.sessionId === ep.hookSessionId) endEpisode(s)
      }).catch(() => {})
    },
    dispose() {
      disposed = true
      for (const s of nodes.values()) endEpisode(s)
      nodes.clear()
    }
  }
}
