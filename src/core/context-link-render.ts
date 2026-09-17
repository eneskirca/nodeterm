// Pure rendering for the context-link feature: transcript parsers for every agent format, node
// selection, and the text each command prints. No fs / child_process / electron — every byte the
// renderer needs is handed in, so the same code serves a LOCAL node (read from this machine's
// disk) and a REMOTE one in an SSH project (read over the project's ControlMaster).
//
// This used to live inside `CLI_SCRIPT` — a ~230-line JavaScript program embedded in a template
// literal, shipped to disk and run via Electron-as-Node. That shape made it untestable and, more
// to the point, unusable in SSH projects: the CLI had to run where the transcripts are, and the
// interpreter it needed exists only on the desktop. Moving the parsing here inverts it — the
// remote side becomes a thin sh+curl client and the desktop does the reading and the parsing.
import type { LinkDoc, LinkDocEntry } from './context-link-core'

export type ContextLinkVerb = 'list' | 'summary' | 'transcript' | 'terminal'

export const CONTEXT_LINK_VERBS: ContextLinkVerb[] = ['list', 'summary', 'transcript', 'terminal']

const SUMMARY_DEFAULT_LINES = 15
const TOOL_ARG_MAX = 200
const TOOL_RESULT_MAX = 500

/** Claude tool_result content: a string, or content parts carrying `.text`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const part = c as { type?: string; text?: string }
        return part && part.type === 'text' ? part.text ?? '' : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** codex/gemini content: a string, or an array of parts each carrying a `.text` field. */
function flatText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        const part = x as { text?: string }
        return part && typeof part.text === 'string' ? part.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function toolArg(input: unknown): string {
  const i = input as Record<string, unknown> | undefined
  if (!i) return ''
  const a = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt
  return typeof a === 'string' ? ` ${a.slice(0, TOOL_ARG_MAX)}` : ''
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** One claude transcript JSONL line -> 0..n display strings. */
export function linesFromClaude(raw: string): string[] {
  const o = parseJson(raw) as { type?: string; message?: { content?: unknown } } | undefined
  if (!o) return []
  const content = o.message?.content
  const res: string[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`assistant: ${c.text}`)
      else if (c.type === 'tool_use') res.push(`  $ ${c.name || 'tool'}${toolArg(c.input)}`)
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as { type?: string; text?: string; content?: unknown }[]) {
      if (c.type === 'text' && c.text) res.push(`user: ${c.text}`)
      else if (c.type === 'tool_result') {
        const s = textOf(c.content).split('\n').slice(0, 3).join(' ').slice(0, TOOL_RESULT_MAX)
        if (s) res.push(`  = ${s}`)
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    res.push(`user: ${content}`)
  }
  return res
}

/** One codex rollout line ({type:'response_item', payload}) -> 0..n display strings. */
export function linesFromCodex(raw: string): string[] {
  const o = parseJson(raw) as { type?: string; payload?: Record<string, unknown> } | undefined
  if (!o || o.type !== 'response_item' || !o.payload) return []
  const p = o.payload as {
    type?: string
    role?: string
    content?: unknown
    name?: string
    arguments?: unknown
    output?: unknown
  }
  const res: string[] = []
  if (p.type === 'message') {
    const role = p.role === 'user' ? 'user' : 'assistant'
    const t = flatText(p.content)
    if (t) res.push(`${role}: ${t}`)
  } else if (p.type === 'function_call') {
    const a = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? '')
    res.push(`  $ ${p.name || 'tool'} ${String(a).slice(0, TOOL_ARG_MAX)}`)
  } else if (p.type === 'function_call_output') {
    const s = flatText(p.output).split('\n').slice(0, 3).join(' ').slice(0, TOOL_RESULT_MAX)
    if (s) res.push(`  = ${s}`)
  }
  return res
}

/** The whole gemini chat file: event-sourced ($set / $push / bare message), replayed then flattened. */
export function linesFromGemini(buf: string): string[] {
  type Msg = { type?: string; content?: unknown }
  let messages: Msg[] = []
  for (const raw of buf.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    const o = parseJson(t) as
      | { $set?: { messages?: Msg[] }; $push?: { messages?: Msg | Msg[] }; content?: unknown; sessionId?: string }
      | undefined
    if (!o) continue
    if (o.$set && Array.isArray(o.$set.messages)) {
      messages = o.$set.messages
      continue
    }
    if (o.$push && typeof o.$push === 'object') {
      const m = o.$push.messages
      if (Array.isArray(m)) messages = messages.concat(m)
      else if (m && typeof m === 'object') messages.push(m)
      continue
    }
    if (o.content !== undefined && o.sessionId === undefined) messages.push(o as Msg)
  }
  const res: string[] = []
  for (const m of messages) {
    const role =
      m.type === 'user' ? 'user' : m.type === 'gemini' || m.type === 'model' ? 'assistant' : String(m.type || 'message')
    const t = flatText(m.content)
    if (t) res.push(`${role}: ${t}`)
  }
  return res
}

/**
 * An `opencode export <sessionID>` JSON document -> display strings. opencode >= 1.18 keeps
 * sessions in SQLite, so its disk is never parsed; the export is the contract. Shapes are read
 * defensively: a messages array whose items carry role + parts[] (text / tool) or a plain string.
 */
export function linesFromOpencodeExport(raw: string): string[] | null {
  const o = parseJson(raw) as
    | { messages?: unknown[]; data?: { messages?: unknown[] } }
    | unknown[]
    | undefined
  if (o === undefined) return null
  const msgs: unknown[] = Array.isArray(o) ? o : o?.messages ?? o?.data?.messages ?? []
  const res: string[] = []
  for (const raw of msgs) {
    const m = raw as {
      role?: string
      info?: { role?: string }
      parts?: unknown[]
      content?: unknown
    }
    if (!m) continue
    const role = (m.role ?? m.info?.role) === 'user' ? 'user' : 'assistant'
    if (typeof m.content === 'string' && m.content) {
      res.push(`${role}: ${m.content}`)
      continue
    }
    const parts = m.parts ?? (Array.isArray(m.content) ? (m.content as unknown[]) : null)
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      const c = p as {
        type?: string
        text?: string
        tool?: string
        name?: string
        input?: Record<string, unknown>
        state?: { input?: Record<string, unknown> }
      }
      if (!c) continue
      if (typeof c.text === 'string' && c.text && (c.type === 'text' || !c.type)) {
        res.push(`${role}: ${c.text}`)
      } else if (c.type === 'tool' || c.type === 'tool_use' || c.tool) {
        const name = c.tool || c.name || 'tool'
        const input = c.state?.input ?? c.input
        const a = input && (input.command ?? input.filePath ?? input.file_path ?? input.pattern ?? input.description)
        res.push(`  $ ${name}${typeof a === 'string' ? ` ${a.slice(0, TOOL_ARG_MAX)}` : ''}`)
      }
    }
  }
  return res
}

/**
 * One whole grok `chat_history.jsonl`. Pure: a buffer in, display strings out.
 *
 * MEASURED against two real sessions (576 and 372 messages, grok 1.0.13, 2026-09-01), which is
 * where every mapping below comes from. Eight line shapes exist and each `type` is handled:
 *
 *   `user`               prompt text when typed (`prompt_index`); a harness injection when it
 *                        carries `synthetic_reason` — labelled with that reason, never as the human
 *   `assistant`          prose, plus `tool_calls[]` of `{id, name, arguments}`
 *   `tool_result`        the output of one call, tied back by `tool_call_id`
 *   `backend_tool_call`  a server-side tool (web search); its detail lives under `kind`
 *   `system`             a bare system message
 *   `reasoning`          model reasoning — SKIPPED, see below
 *
 * `reasoning` is skipped, and the distinction matters: its `encrypted_content` is NOT READABLE, so
 * nothing here attempts to read it — a read we cannot perform is never reported as absence. Note
 * that its sibling `summary[].text` IS plaintext and readable (138 of 156 lines in the measured
 * session carry one); it is skipped anyway, because every other parser in this file omits model
 * reasoning too (claude's renders `text` and `tool_use` only). Surfacing it is a product decision
 * about what one agent may read of another's thinking, not a parsing gap — so it is recorded here
 * rather than silently taken.
 *
 * A malformed line is skipped but NOT in silence: `linesFromGrok.skipped(buf)` counts them, so a
 * caller can say "3 lines were unreadable" instead of quietly rendering a shorter transcript.
 */
export interface GrokChatLine {
  type?: string
  content?: unknown
  tool_calls?: { id?: string; name?: string; arguments?: unknown }[]
  tool_call_id?: string
  synthetic_reason?: string
  kind?: { tool_type?: string; action?: { type?: string; query?: string } }
}

/** Exported so the ⌘M chat reader can build structured messages from the SAME shape knowledge
 *  instead of re-deriving grok's line vocabulary a second time and drifting from it. */
export function grokParse(buf: string): { lines: GrokChatLine[]; skipped: number } {
  const lines: GrokChatLine[] = []
  let skipped = 0
  for (const raw of buf.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    const o = parseJson(t) as GrokChatLine | undefined
    if (!o || typeof o !== 'object') {
      skipped++
      continue
    }
    lines.push(o)
  }
  return { lines, skipped }
}

export function linesFromGrok(buf: string): string[] {
  const res: string[] = []
  for (const o of grokParse(buf).lines) {
    switch (o.type) {
      case 'user':
      case 'system': {
        const t = flatText(o.content)
        if (!t) break
        // A `user` line carrying `synthetic_reason` was injected by the harness, not typed by a
        // person: grok files skill reminders, project instructions, compaction notes and subagent
        // completions under the user role and marks them only with this field. Measured across
        // every local session: 60 such lines, all `type: 'user'`, vocabulary `system_reminder`,
        // `compaction_meta`, `project_instructions`, `task_completed`.
        //
        // They are LABELLED, not dropped, and the rule is the field's PRESENCE rather than a table
        // of those four values — so a reason nobody has measured yet is still never attributed to
        // the human. Dropping them was the other candidate and it loses real events (a subagent
        // finished; the conversation was compacted) that explain what the agent did next. This
        // reader feeds context-link and transfer, where "their user said X" must mean a human
        // said X.
        const injected = typeof o.synthetic_reason === 'string' ? o.synthetic_reason.trim() : ''
        res.push(`${injected || o.type}: ${t}`)
        break
      }
      case 'assistant': {
        const t = flatText(o.content)
        if (t) res.push(`assistant: ${t}`)
        for (const c of o.tool_calls ?? []) {
          const a = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? '')
          res.push(`  $ ${c.name || 'tool'} ${String(a).slice(0, TOOL_ARG_MAX)}`.trimEnd())
        }
        break
      }
      case 'tool_result': {
        const s = flatText(o.content).split('\n').slice(0, 3).join(' ').slice(0, TOOL_RESULT_MAX)
        if (s) res.push(`  = ${s}`)
        break
      }
      case 'backend_tool_call': {
        // Server-side tool: no arguments field, the query hangs off `kind.action`.
        const name = o.kind?.tool_type || 'backend_tool'
        const q = o.kind?.action?.query
        res.push(`  $ ${name}${typeof q === 'string' ? ` ${q.slice(0, TOOL_ARG_MAX)}` : ''}`)
        break
      }
      // `reasoning` and any future type fall through deliberately: an unknown shape renders
      // nothing rather than a guessed role.
      default:
        break
    }
  }
  return res
}

/** Devin transcript: a monolithic JSON object with `steps[]`. Each step carries `source`
 *  ('system' | 'user' | 'agent') and `message` (string). Tool calls are not exposed separately,
 *  so we render the user/agent conversation as one line per step. */
export function linesFromDevin(buf: string): string[] {
  const o = parseJson(buf) as { steps?: { source?: unknown; message?: unknown }[] } | undefined
  if (!o || !Array.isArray(o.steps)) return []
  const res: string[] = []
  for (const step of o.steps) {
    if (!step || typeof step.message !== 'string' || !step.message) continue
    const source = typeof step.source === 'string' ? step.source : ''
    if (source === 'system') continue
    const role = source === 'user' ? 'user' : 'assistant'
    const text = step.message.replace(/\s+/g, ' ').trim().slice(0, TOOL_RESULT_MAX)
    if (text) res.push(`${role}: ${text}`)
  }
  return res
}

/** How many lines of this buffer could not be parsed. Skipped, but never in silence. */
linesFromGrok.skipped = (buf: string): number => grokParse(buf).skipped

/** Parse a whole transcript buffer with the parser its agent's format needs. */
export function renderTranscriptLines(agent: string | undefined, buf: string): string[] {
  if (agent === 'gemini') return linesFromGemini(buf)
  if (agent === 'grok') return linesFromGrok(buf)
  if (agent === 'devin') return linesFromDevin(buf)
  const parse = agent === 'codex' ? linesFromCodex : linesFromClaude
  const lines: string[] = []
  for (const raw of buf.split('\n')) {
    if (raw.trim()) lines.push(...parse(raw))
  }
  return lines
}

/**
 * Resolve which linked node a command targets. This is also the AUTHORIZATION boundary: a
 * request may only ever name a node inside the requester's own link document, so a caller
 * holding the hook token still cannot read a node it was never linked to.
 */
export function pickLinkNode(doc: LinkDoc, want?: string): { node: LinkDocEntry } | { message: string } {
  const links = doc.links
  if (!links.length) {
    return { message: 'No linked nodes. Draw a context-link edge from this node to another on the canvas.' }
  }
  if (want) {
    const q = want.toLowerCase()
    const m = links.find((n) => n.id.toLowerCase() === q || (n.title || '').toLowerCase() === q)
    if (!m) {
      return {
        message: `No linked node matches "${want}". Linked: ${links.map((n) => n.title).join(', ')}`
      }
    }
    return { node: m }
  }
  if (links.length === 1) return { node: links[0] }
  return {
    message: [
      'Several linked nodes — re-run with --node <id|title>:',
      ...links.map((n) => `- ${n.title}${n.note != null ? ' (note)' : ''} (id: ${n.id})`)
    ].join('\n')
  }
}

export function renderList(doc: LinkDoc): string {
  if (!doc.links.length) return 'No linked nodes.'
  return [
    'Linked nodes:',
    ...doc.links.map((n) => `- ${n.title}${n.note != null ? ' (note)' : ''} (id: ${n.id})`)
  ].join('\n')
}

/** A sticky note carries its text in the link doc — every command just prints it. */
export function renderNote(node: LinkDocEntry, verb: ContextLinkVerb): string {
  if (verb === 'terminal') return `"${node.title}" is a sticky note — it has no terminal.`
  return `=== ${node.title} — note ===\n${node.note || '(empty note)'}`
}

export function renderSummary(node: LinkDocEntry, lines: string[], n: number): string {
  return [`=== ${node.title} — last ${n} lines ===`, ...lines.slice(-n)].join('\n')
}

export function renderFullTranscript(node: LinkDocEntry, lines: string[]): string {
  return [`=== ${node.title} — full transcript (${lines.length} lines) ===`, ...lines].join('\n')
}

export function renderTerminal(node: LinkDocEntry, capture: string): string {
  const body = capture.replace(/\s+$/, '')
  return [
    `=== ${node.title} — terminal ===`,
    body || `"${node.title}" terminal session is not running.`
  ].join('\n')
}

export function parseSummaryCount(raw: string | undefined): number {
  const n = parseInt(raw || '', 10)
  return Number.isFinite(n) && n > 0 ? n : SUMMARY_DEFAULT_LINES
}

/** Everything the renderer needs fetched from the outside (local fs or over ssh). */
export interface ContextLinkFetch {
  /** The linked node's raw transcript bytes, or null when there is none / it is unreadable. */
  transcript: (node: LinkDocEntry) => Promise<string | null>
  /** The linked node's recent terminal output ('' when the session is not running). */
  terminal: (node: LinkDocEntry) => Promise<string>
  /** `opencode export <sessionId>` output, or null when it could not be produced. */
  opencodeExport: (node: LinkDocEntry) => Promise<string | null>
}

/**
 * Render one context-link command. Pure apart from the injected fetchers, which is what lets a
 * remote node's transcript be read over ssh without this file knowing ssh exists.
 */
export async function renderContextLink(
  doc: LinkDoc,
  verb: ContextLinkVerb,
  args: { node?: string; n?: string },
  fetch: ContextLinkFetch
): Promise<string> {
  if (verb === 'list') return renderList(doc)

  const picked = pickLinkNode(doc, args.node)
  if ('message' in picked) return picked.message
  const node = picked.node

  if (node.note != null) return renderNote(node, verb)

  if (verb === 'terminal') return renderTerminal(node, await fetch.terminal(node))

  const lines = await transcriptLinesFor(node, fetch)
  if (typeof lines === 'string') return lines // an explanatory message, not content
  return verb === 'summary'
    ? renderSummary(node, lines, parseSummaryCount(args.n))
    : renderFullTranscript(node, lines)
}

/** Transcript lines for a node, or a human-readable reason there are none. */
async function transcriptLinesFor(node: LinkDocEntry, fetch: ContextLinkFetch): Promise<string[] | string> {
  if (node.agent === 'opencode') {
    if (!node.sessionId) return `"${node.title}" has no session id yet.`
    const raw = await fetch.opencodeExport(node)
    if (raw == null) return `Could not export "${node.title}" session (is opencode installed?).`
    const lines = linesFromOpencodeExport(raw)
    if (lines == null) return `Unreadable opencode export for "${node.title}".`
    if (!lines.length) return `"${node.title}" export contained no readable messages.`
    return lines
  }
  const buf = await fetch.transcript(node)
  if (buf == null) return `"${node.title}" has no conversation transcript yet.`
  return renderTranscriptLines(node.agent, buf)
}
