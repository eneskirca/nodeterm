// Computes each Claude session's context-window fill by tailing its transcript .jsonl and
// reading the LATEST assistant message's token usage. Read-only and local; mirrors the
// offset-based read + shared-interval pattern of subagent-tail.ts. Pushed to the renderer
// as ContextWindowUsage keyed by sessionId.
import fs from 'fs'
import type { ContextWindowUsage } from '../shared/types'
import { cachedWindowFor } from './model-window'
import { splitCompleteLines } from './subagent-tail'

const POLL_MS = 1000
// Cap the initial read: a resumed Claude transcript can be many MB, and reading the whole file
// synchronously on the main thread (Buffer.alloc(size) + JSON.parse per line) stalls all IPC.
// Only the LATEST assistant usage matters, so a tail of the file is enough; the partial first
// line is dropped naturally by the JSON.parse guard.
const INITIAL_READ_CAP = 1024 * 1024 // 1 MB

/** The scanners accept a pre-split line array so one read can split its chunk ONCE and share
 *  it — three scanners each running their own `split('\n')` tripled the allocation per tick. */
const toLines = (text: string | string[]): string[] =>
  Array.isArray(text) ? text : text.split('\n')

/**
 * Scan transcript text for the LATEST assistant message's token usage + model. Pure.
 *
 * Scans BACKWARDS and stops at the first line that settles both values: only the latest usage
 * matters, and a forward scan JSON.parsed every line of the chunk — a single tool-result line
 * can be 100 KB+ of JSON, fully parsed (at 1 Hz per tracked session, on the main thread) just
 * to learn it isn't an assistant message. The includes() pre-filters skip those without a parse:
 * a JSON-encoded assistant/usage line always contains both quoted keys.
 */
export function parseLatestUsage(
  text: string | string[]
): { used: number; model: string | null; effort?: string } | null {
  const lines = toLines(text)
  let found = false
  let usedTokens = 0
  let model: string | null = null
  let effort: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim()
    if (!s || !s.includes('"usage"') || !s.includes('"assistant"')) continue
    let o: { type?: string; effort?: unknown; message?: { model?: string; usage?: Record<string, number> } }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'assistant' || !o.message?.usage) continue
    const u = o.message.usage
    const used =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (used <= 0) continue
    if (!found) {
      found = true
      usedTokens = used // the LATEST usage — earlier lines are visited only to resolve the model
      // The reasoning effort of that same request: Claude Code writes a top-level `effort` on each
      // assistant record it sent with one (`...E!==void 0&&{effort:E}` in the 2.1.283 bundle — the
      // same field the CLI's own history reader walks). Taken from the LATEST record ONLY, never
      // carried forward like the model: a record without it means that request had no effort (a
      // model that does not take one), and an older value would be a stale claim.
      if (typeof o.effort === 'string' && o.effort) effort = o.effort
    }
    // Same rule as the old forward scan's "carry the prior model forward": the effective model
    // is the nearest usage line AT OR BEFORE the latest one that names it.
    model = o.message.model ?? null
    if (model !== null) break
  }
  if (!found) return null
  return effort === undefined ? { used: usedTokens, model } : { used: usedTokens, model, effort }
}

/**
 * A completed async subagent, announced back to the parent session as a queued
 * `<task-notification>` prompt (a `queue-operation` transcript line). Carries the spawning
 * tool_use_id, so it's the end signal the async launch's PostToolUse never was.
 */
export interface TaskNotification {
  toolUseId: string
  status?: string
  summary?: string
  result?: string
}

const tag = (content: string, name: string): string | undefined => {
  const m = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : undefined
}

/** Scan transcript lines for queued <task-notification>s. Pure. */
export function parseTaskNotifications(text: string | string[]): TaskNotification[] {
  const out: TaskNotification[] = []
  for (const line of toLines(text)) {
    const s = line.trim()
    // Cheap pre-filter; the attachment echo of the same notification is skipped by the
    // type check below so each completion fires exactly once.
    if (!s || !s.includes('task-notification') || !s.includes('queue-operation')) continue
    let o: { type?: string; content?: unknown }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'queue-operation' || typeof o.content !== 'string') continue
    if (!o.content.includes('<task-notification>')) continue
    const toolUseId = tag(o.content, 'tool-use-id')
    if (!toolUseId) continue
    out.push({
      toolUseId,
      status: tag(o.content, 'status'),
      summary: tag(o.content, 'summary'),
      // <result> holds the agent's full final text — match greedily to its LAST closing tag.
      result: o.content.match(/<result>([\s\S]*)<\/result>/)?.[1]?.trim()
    })
  }
  return out
}

/** IDs of settled tools, including Escape/decline results. Never infer an answer from
 * another tool's result or from result text. */
export function parseToolResultIds(text: string | string[]): string[] {
  const ids: string[] = []
  for (const line of toLines(text)) {
    if (!line.includes('tool_result')) continue
    try {
      const o = JSON.parse(line)
      if (!Array.isArray(o.message?.content)) continue
      for (const c of o.message.content) {
        if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string' && c.tool_use_id)
          ids.push(c.tool_use_id)
      }
    } catch { /* torn or malformed transcript line */ }
  }
  return ids
}

/**
 * The two texts Claude Code writes as a USER record when the user interrupts a turn (Esc, or
 * Ctrl+C once). A CLOSED set: measured on 2.1.285 (`shared/agents/__fixtures__/claude/
 * interrupt-capture.json`) — `[Request interrupted by user]` after streamed text,
 * `… for tool use]` when a tool call or its permission dialog was cancelled. Any other wording is
 * ignored, so a future CLI that words it differently degrades to what happened before this
 * existed (the node waits for its next hook, or the stale sweep), never to a guess.
 */
export const CLAUDE_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]'
])

const PROMPT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** How many opening-prompt ids a per-session scanner remembers (oldest dropped first). */
export const TURN_PROMPTS_SEEN_MAX = 256

type TranscriptRecord = {
  type?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  promptId?: unknown
  message?: { content?: unknown }
}

const isMarkerRecord = (o: TranscriptRecord): boolean => {
  const content = o.message?.content
  if (!Array.isArray(content) || content.length !== 1) return false
  const part = content[0] as { type?: unknown; text?: unknown } | null
  return part?.type === 'text' && typeof part.text === 'string' && CLAUDE_INTERRUPT_MARKERS.has(part.text)
}

/** A main-thread user record that OPENS a turn: the typed (or dequeued) prompt itself — not a tool
 *  result, not a meta record, not the interrupt marker. */
const isOpeningPrompt = (o: TranscriptRecord): boolean => {
  if (o.isMeta === true) return false
  const content = o.message?.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content) || content.length === 0) return false
  if (content.some((c) => (c as { type?: unknown } | null)?.type === 'tool_result')) return false
  return !isMarkerRecord(o)
}

/**
 * The interrupt markers of ONE transcript, read chunk by chunk. Stateful: it remembers the turn ids
 * whose OPENING prompt record it has already read (bounded, `TURN_PROMPTS_SEEN_MAX`), because a
 * marker only counts for a turn whose prompt came BEFORE it in the file.
 *
 * That order is not a detail. On "queue a message while Claude works, then press Esc" the CLI
 * writes the marker tagged with the QUEUED prompt's id and the queued prompt record ~36 ms AFTER
 * it (measured in real transcripts, 2.1.209–2.1.283: 34 of 114 accepted-shape markers carried the
 * NEXT prompt's id, 31 of them behind a `queue-operation`; redacted in
 * `shared/agents/__fixtures__/claude/interrupt-queued.json`). That queued prompt's
 * UserPromptSubmit makes it the node's current turn, so an id match alone ended the NEW live turn.
 * A marker whose turn was not opened earlier in what this scanner has read is dropped — the
 * interrupted turn really did end, but the node is already in the next one.
 *
 * `record` lines are read for prompts only and never report (the remote tail's historical read).
 */
export interface TurnInterruptScanner {
  scan(text: string | string[], opts?: { record?: boolean }): string[]
}

export function createTurnInterruptScanner(max = TURN_PROMPTS_SEEN_MAX): TurnInterruptScanner {
  const seen = new Set<string>()
  const remember = (id: string): void => {
    seen.delete(id)
    seen.add(id)
    if (seen.size > max) seen.delete(seen.values().next().value as string)
  }
  return {
    scan(text, opts) {
      const out: string[] = []
      for (const line of toLines(text)) {
        // Cheap pre-filter before the parse — this runs over every transcript chunk. Every record
        // this scanner cares about is a user record carrying a promptId.
        if (!line.includes('"promptId"') || !line.includes('"user"')) continue
        let o: TranscriptRecord
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (o?.type !== 'user' || o.isSidechain === true) continue
        if (typeof o.promptId !== 'string' || !PROMPT_ID_RE.test(o.promptId)) continue
        if (isMarkerRecord(o)) {
          if (!opts?.record && seen.has(o.promptId)) out.push(o.promptId)
        } else if (isOpeningPrompt(o)) {
          remember(o.promptId)
        }
      }
      return out
    }
  }
}

/**
 * Turn ids (`promptId`) of the interrupt markers in these transcript lines, in file order, counting
 * a marker only when its turn's opening prompt precedes it IN THESE LINES (see
 * `createTurnInterruptScanner`, which the tails use to carry that across reads). Pure.
 *
 * No hook fires when the user interrupts a Claude turn (Esc during streaming, a tool call or a
 * permission dialog; Ctrl+C once) — measured on 2.1.285 — and the CLI's `idle_prompt`
 * notification does not follow an interrupted turn either. This marker is the one trace the
 * interrupt leaves. The id is only a CANDIDATE: the status mirror acts on it only when it names
 * the turn the node is in right now (`recordTurnInterrupt`).
 *
 * Only a main-thread user record whose content is an ARRAY holding exactly one text part with a
 * marker text counts. A prompt the user typed is stored as a plain string, so typing the marker's
 * words cannot produce one.
 */
export function parseTurnInterrupts(text: string | string[]): string[] {
  return createTurnInterruptScanner().scan(text)
}

/** Legacy presence scanner; answer consumers must use parseToolResultIds. */
export function hasToolResult(text: string | string[]): boolean {
  for (const line of toLines(text)) {
    const s = line.trim()
    // Cheap pre-filter before the parse — this runs over every transcript chunk.
    if (!s || !s.includes('tool_result')) continue
    let o: { message?: { content?: unknown } }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    const content = o.message?.content
    if (!Array.isArray(content)) continue
    if (content.some((c) => (c as { type?: string })?.type === 'tool_result')) return true
  }
  return false
}

export interface ContextTailOptions {
  /** Fired when a tracked session's transcript announces a completed async subagent. */
  onTaskNotification?: (sessionId: string, n: TaskNotification) => void
  /** Fired when a tracked session's transcript records a tool RESULT — see `parseToolResultIds`. */
  onToolResult?: (sessionId: string, toolUseId: string) => void
  /** Fired when a tracked session's transcript records a turn INTERRUPT marker, with that turn's id
   *  — see `parseTurnInterrupts`. Claude only; the consumer decides whether it is the live turn. */
  onTurnInterrupted?: (sessionId: string, turnId: string) => void
  /**
   * How to read the used/window numbers out of this agent's transcript. Defaults to claude's
   * `parseLatestUsage`. gemini and codex pass their own (`core/gemini-session.ts`
   * `geminiContextParse`, `core/codex-session.ts` `codexContextParse`) because the numbers live
   * under different keys — everything else about tailing (offset reads, the torn-line carry, the
   * change-gated push) is identical, which is why this is a dep and not a second poller.
   *
   * `window` is what the TRANSCRIPT could state: codex states its own `model_context_window`, and
   * gemini's follows from the model id its transcript carries. Claude's parser returns none (hence
   * optional) and its window keeps coming from the model-family resolver.
   */
  parse?: (
    text: string | string[]
  ) => { used: number; window?: number | null; model: string | null; effort?: string } | null
  /**
   * Re-read the tracked file from byte 0 on every tick instead of tailing an offset.
   *
   * For grok, whose numbers live in `signals.json` — a whole JSON document REWRITTEN in place, not a
   * JSONL appended to. An offset read hands the parser the bytes that happen to sit past the last
   * read, which is a fragment of JSON and never parses. The meter would fill on the first tick and
   * then freeze, with nothing anywhere to say why: exactly the silent-degrade shape this codebase
   * keeps paying for. The file is a few KB, so re-reading it whole costs nothing worth optimizing.
   */
  wholeFile?: boolean
}

interface Tracked {
  /** Claude interrupt markers, with the opening prompts already read (see the scanner). */
  interrupts: TurnInterruptScanner
  path: string
  offset: number
  used: number
  window: number
  model: string | null
  /** Reasoning effort of the latest request (claude only — see parseLatestUsage); null = none. */
  effort: string | null
  // Last pushed snapshot — a push fires only when one of these changes.
  lastUsed: number
  lastModel: string | null
  lastEffort: string | null
  lastWindow: number
  sessionWindow: number | null
  /** An async read is in flight — the next tick skips this session instead of double-reading. */
  reading: boolean
  /**
   * Bytes past the last newline of the previous read — a line caught mid-write, held back and
   * prepended to the next read (see subagent-tail.ts). Without it a torn <task-notification>
   * line would be lost and its subagent card stuck on working forever. Reset on offset jumps.
   */
  carry: Buffer | null
  /**
   * The window the PARSER last read out of the transcript itself, if it can state one (codex, and
   * gemini via its model id). `null` = never stated. Sticky like `used`/`model`: a chunk with no
   * usage in it leaves the last known window alone.
   */
  parsedWindow: number | null
}

export interface ContextTail {
  track(sessionId: string | undefined, transcriptPath: string | undefined, sessionWindow?: number | null): void
  /** Replay a live snapshot only when a consumer explicitly asks to rehydrate. */
  replay(sessionId: string): void
  untrack(sessionId: string | undefined): void
  /** The transcript path currently tracked for a session, if any. */
  pathFor(sessionId: string | undefined): string | undefined
}

export function createContextTail(
  send: (payload: unknown) => void,
  opts?: ContextTailOptions
): ContextTail {
  const sessions = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null
  // A custom parser also OWNS the window (see the window reconcile in `read`), so keep the
  // "is this claude's tail?" question to one place.
  const customParse = opts?.parse
  // Typed as the OPTION so claude's `parseLatestUsage` (which returns no `window` at all) satisfies
  // it as the default — its `window` is simply always absent, which reads as "not stated".
  const parse: NonNullable<ContextTailOptions['parse']> = customParse ?? parseLatestUsage

  const push = (sessionId: string, t: Tracked): void => {
    const usedPercent = Math.min(100, Math.max(0, (t.used / t.window) * 100))
    const payload: ContextWindowUsage = {
      sessionId,
      usedTokens: t.used,
      windowTokens: t.window,
      usedPercent,
      model: t.model,
      ...(t.effort !== null && { effort: t.effort }),
      windowSource: customParse ? 'transcript' : t.sessionWindow === null ? 'estimate' : 'session-env',
      updatedAt: Date.now()
    }
    send(payload)
  }

  // Read newly-appended transcript bytes (if any), reconcile the window from the model
  // resolver, and push when the used tokens / model / window changed since the last push.
  // Async fs throughout: this runs every second per tracked session, and sync syscalls here
  // sat on the same main thread that services all PTY streaming and IPC.
  const read = async (sessionId: string, t: Tracked): Promise<void> => {
    if (t.reading) return
    t.reading = true
    try {
      let size = -1
      try {
        size = (await fs.promises.stat(t.path)).size
      } catch {
        // file not created yet / unreadable — skip the byte read, still reconcile below
      }
      if (size >= 0) {
        const before = t.offset
        // A rewritten-in-place document has no meaningful offset: only the whole file parses.
        if (opts?.wholeFile) t.offset = 0
        if (size < t.offset) t.offset = 0 // truncated/rotated → re-read from start
        // First read of a large transcript: skip to the last INITIAL_READ_CAP bytes.
        if (t.offset === 0 && size > INITIAL_READ_CAP) t.offset = size - INITIAL_READ_CAP
        // Cap deltas too: a huge append burst (resume/compact rewriting MBs between ticks)
        // shouldn't allocate it all — only the LATEST usage matters, so jump to the tail.
        if (size - t.offset > INITIAL_READ_CAP) t.offset = size - INITIAL_READ_CAP
        if (t.offset !== before) t.carry = null // offset jumped — the held bytes don't precede it
        if (size > t.offset) {
          let buf: Buffer
          try {
            const fd = await fs.promises.open(t.path, 'r')
            try {
              buf = Buffer.alloc(size - t.offset)
              await fd.read(buf, 0, buf.length, t.offset)
              t.offset = size
            } finally {
              await fd.close()
            }
          } catch {
            return
          }
          // Usage parses the whole read (carry included) — it tolerates torn lines and the
          // latest value wins, so it must not wait for a newline. Notifications scan
          // COMPLETE lines only, with the torn tail carried into the next read, so a torn
          // <task-notification> is completed later instead of being lost.
          // ONE split serves all three scanners: the last element is exactly the torn tail
          // (everything past the final newline), so dropping it yields the complete lines.
          const combined = t.carry?.length ? Buffer.concat([t.carry, buf]) : buf
          t.carry = splitCompleteLines(combined).carry
          const lines = combined.toString('utf-8').split('\n')
          const completeLines = lines.slice(0, -1)
          const latest = parse(lines)
          if (latest) {
            t.used = latest.used
            t.model = latest.model ?? t.model
            t.effort = latest.effort ?? null
            t.parsedWindow = latest.window ?? t.parsedWindow
          }
          if (opts?.onTaskNotification) {
            for (const n of parseTaskNotifications(completeLines))
              opts.onTaskNotification(sessionId, n)
          }
          if (opts?.onToolResult)
            for (const id of parseToolResultIds(completeLines)) opts.onToolResult(sessionId, id)
          if (opts?.onTurnInterrupted)
            for (const id of t.interrupts.scan(completeLines)) opts.onTurnInterrupted(sessionId, id)
        }
      }

      // The observed session env outranks model-family estimates, even when it is smaller.
      // Custom parsers own their denominator and never inherit Claude configuration.
      const win = customParse ? t.parsedWindow : t.sessionWindow ?? cachedWindowFor(t.model)

      if (sessions.get(sessionId) !== t) return // untracked while this async read was in flight
      if (
        t.used > 0 &&
        win !== null &&
        win > 0 &&
        (t.used !== t.lastUsed || t.model !== t.lastModel || t.effort !== t.lastEffort || win !== t.lastWindow)
      ) {
        t.window = win
        push(sessionId, t)
        t.lastUsed = t.used
        t.lastModel = t.model
        t.lastEffort = t.effort
        t.lastWindow = win
      }
    } finally {
      t.reading = false
    }
  }

  const tick = (): void => {
    for (const [sessionId, t] of sessions) void read(sessionId, t)
    if (!sessions.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(sessionId, transcriptPath, sessionWindow) {
      if (!sessionId || !transcriptPath) return
      const existing = sessions.get(sessionId)
      if (existing && existing.path === transcriptPath) {
        if (sessionWindow !== undefined && sessionWindow !== existing.sessionWindow) {
          existing.sessionWindow = sessionWindow
          existing.lastWindow = 0 // publish even if only provenance changed
          void read(sessionId, existing)
        }
        return
      }
      const t: Tracked = {
        interrupts: createTurnInterruptScanner(),
        path: transcriptPath,
        offset: 0,
        used: 0,
        window: 0,
        model: null,
        effort: null,
        lastUsed: 0,
        lastModel: null,
        lastEffort: null,
        lastWindow: 0,
        sessionWindow: sessionWindow ?? null,
        reading: false,
        carry: null,
        parsedWindow: null
      }
      sessions.set(sessionId, t)
      void read(sessionId, t) // immediate first value (resumed sessions already have content)
      if (!timer) timer = setInterval(tick, POLL_MS)
    },
    replay(sessionId) {
      const t = sessions.get(sessionId)
      if (t && t.used > 0 && t.lastWindow > 0) push(sessionId, t)
    },
    untrack(sessionId) {
      if (!sessionId) return
      sessions.delete(sessionId)
      if (!sessions.size && timer) {
        clearInterval(timer)
        timer = null
      }
    },
    pathFor(sessionId) {
      if (!sessionId) return undefined
      return sessions.get(sessionId)?.path
    }
  }
}
