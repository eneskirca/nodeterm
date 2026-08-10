// Streams a subagent's live transcript to the renderer while it runs.
//
// Each subagent Claude spawns gets its own transcript at
//   <parent transcript dir>/<sessionId>/subagents/agent-<agentId>.jsonl
// plus an agent-<agentId>.meta.json that carries the spawning tool_use_id. We resolve the
// file by matching that toolUseId, then tail it (offset-based) and forward formatted lines.
// All read-only — if Claude changes the format we just stream less (no crash).
import fs from 'fs'
import path from 'path'

// Per-tick read ceiling, the same discipline as context-tail's INITIAL_READ_CAP: without it the
// first tick after track() (or any burst) allocates the entire delta in one Buffer. Unlike
// context-tail, a capped read here loses nothing — the tail is offset-based, so the next 400ms
// tick continues where this one stopped.
export const SUBAGENT_READ_CAP = 1024 * 1024 // 1 MB

interface Tracked {
  dir: string
  file: string | null
  offset: number
  /** An async read is in flight — the next tick skips this entry instead of double-reading. */
  reading?: boolean
  /** Meta files already parsed and rejected — don't re-read them on every 400ms tick. */
  seenMetas?: Set<string>
  /**
   * Bytes past the last newline of the previous read — a line caught mid-write. Held back
   * (as raw bytes, so a torn multibyte char survives) and prepended to the next read; without
   * this the torn line's halves each fail JSON.parse and the whole line is silently lost.
   */
  carry?: Buffer | null
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// A short, human-readable argument for a tool call (no raw JSON), e.g.
//   Read → workspace.ts   Bash → npm test   Grep → "NODE_COLORS"
function toolArg(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const base = (p: unknown) => (typeof p === 'string' ? p.split('/').pop() || p : '')
  const p = i.file_path ?? i.path ?? i.notebook_path
  if (p) return base(p)
  if (typeof i.command === 'string') return i.command.replace(/\s+/g, ' ').slice(0, 80)
  if (typeof i.pattern === 'string') return `"${i.pattern.slice(0, 60)}"`
  if (typeof i.url === 'string') return i.url
  if (typeof i.query === 'string') return i.query.slice(0, 60)
  const txt = i.description ?? i.prompt
  if (typeof txt === 'string') return txt.replace(/\s+/g, ' ').slice(0, 80)
  void name
  return ''
}

// Collapse a tool result to a one-line summary instead of dumping the full
// (often line-numbered) content — keeps the panel readable like an activity log.
function summarizeResult(content: unknown): string {
  const r = textOf(content).trim()
  if (!r) return ''
  const lines = r.split('\n')
  const first = (lines.find((l) => l.trim()) ?? '').trim().slice(0, 100)
  const extra = lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''
  return `  ↳ ${first}${extra}`
}

// Render one transcript line as a clean activity log: assistant prose verbatim,
// tool calls as `$ Tool arg`, tool results as a one-line summary. Skips metadata.
export function formatLine(line: string): string {
  let o: { type?: string; message?: { content?: unknown } }
  try {
    o = JSON.parse(line)
  } catch {
    return ''
  }
  const content = o.message?.content
  if (o.type === 'assistant' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; name?: string; input?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_use') {
          const arg = toolArg(c.name, c.input)
          return `$ ${c.name}${arg ? ` ${arg}` : ''}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (o.type === 'user' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; content?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_result') return summarizeResult(c.content)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Format a chunk of newly-read transcript bytes into the activity-log text streamed to the
// renderer: drop blank lines, format each surviving line, drop empties, join with '\n'.
// Mirrors the tail read loop exactly so local + remote streamed output stay byte-identical.
export function formatSubagentChunk(text: string): string {
  return text
    .split('\n')
    .filter(Boolean)
    .map(formatLine)
    .filter(Boolean)
    .join('\n')
}

// Split accumulated transcript bytes at the last newline: everything up to it decodes to
// complete lines, the rest is carried (still raw bytes) into the next read. Splitting at the
// byte level is what makes a mid-multibyte tear safe — '\n' (0x0a) never occurs inside a
// UTF-8 continuation, so the carry always rejoins into valid UTF-8.
export function splitCompleteLines(data: Buffer): { text: string; carry: Buffer | null } {
  const nl = data.lastIndexOf(0x0a)
  if (nl === -1) return { text: '', carry: data.length ? data : null }
  return {
    text: data.subarray(0, nl + 1).toString('utf-8'),
    // Copy the tail so the (possibly large) read buffer isn't retained by the slice.
    carry: nl + 1 < data.length ? Buffer.from(data.subarray(nl + 1)) : null
  }
}

export interface SubagentTail {
  track(toolUseId: string, transcriptPath: string | undefined): void
  finish(toolUseId: string): void
}

export function createSubagentTail(
  send: (payload: { toolUseId: string; chunk: string }) => void
): SubagentTail {
  const tracked = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null

  const emit = (toolUseId: string, chunk: string): void => {
    if (chunk) send({ toolUseId, chunk })
  }

  // Async fs throughout: this ticks every 400ms per active subagent, and the sync version's
  // readdir + per-meta reads sat on the main event loop alongside all PTY/IPC traffic.
  const readOne = async (toolUseId: string, e: Tracked): Promise<void> => {
    if (e.reading) return
    e.reading = true
    try {
      if (!e.file) {
        let metas: string[]
        try {
          metas = await fs.promises.readdir(e.dir)
        } catch {
          return // dir not created yet
        }
        const seen = (e.seenMetas ??= new Set())
        for (const m of metas) {
          if (!m.endsWith('.meta.json') || seen.has(m)) continue
          try {
            const meta = JSON.parse(await fs.promises.readFile(path.join(e.dir, m), 'utf-8'))
            if (meta.toolUseId === toolUseId) {
              e.file = path.join(e.dir, m.replace(/\.meta\.json$/, '.jsonl'))
              break
            }
            // Only blacklist a meta that positively names another subagent. A parseable file
            // whose toolUseId hasn't landed yet (caught mid-write) must be re-read next tick,
            // or this subagent's own meta gets skipped forever and its transcript never streams.
            if (meta.toolUseId) seen.add(m)
          } catch {
            // unparseable (possibly still being written) — retry next tick, don't blacklist
          }
        }
        if (!e.file) return
      }
      const size = (await fs.promises.stat(e.file)).size
      if (size <= e.offset) return
      const len = Math.min(size - e.offset, SUBAGENT_READ_CAP)
      const buf = Buffer.alloc(len)
      const fd = await fs.promises.open(e.file, 'r')
      try {
        await fd.read(buf, 0, len, e.offset)
      } finally {
        await fd.close()
      }
      e.offset += len
      const data = e.carry?.length ? Buffer.concat([e.carry, buf]) : buf
      const { text, carry } = splitCompleteLines(data)
      e.carry = carry
      const out = formatSubagentChunk(text)
      if (out) emit(toolUseId, out + '\n')
    } catch {
      // file may not exist yet / transient read error
    } finally {
      e.reading = false
    }
  }

  const tick = () => {
    for (const [toolUseId, e] of tracked) void readOne(toolUseId, e)
    if (!tracked.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(toolUseId, transcriptPath) {
      if (!transcriptPath || tracked.has(toolUseId)) return
      const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
      tracked.set(toolUseId, { dir, file: null, offset: 0 })
      if (!timer) timer = setInterval(tick, 400) // only runs while subagents are active
    },
    finish(toolUseId) {
      // The file is complete now, so a held-back carry is a real final line that just lacks
      // its trailing newline — flush it after the final read instead of dropping it.
      const flushCarry = (e: Tracked): void => {
        if (!e.carry?.length) return
        const out = formatSubagentChunk(e.carry.toString('utf-8'))
        e.carry = null
        if (out) emit(toolUseId, out + '\n')
      }
      const e = tracked.get(toolUseId)
      if (e) void readOne(toolUseId, e).then(() => flushCarry(e)) // final flush (completes well within the grace delay)
      setTimeout(() => {
        const late = tracked.get(toolUseId)
        tracked.delete(toolUseId)
        if (late) flushCarry(late) // ticks during the grace window may have re-filled the carry
      }, 1500)
    }
  }
}
