import { isRecord } from '../shared/is-record'
// The readable body of a tool call in the ⌘M chat view. Most tool calls are plumbing — a one-line
// chip (`Bash ls`) says all there is to say. Two are not: `ExitPlanMode` carries the full plan the
// user is being asked to approve, and `AskUserQuestion` carries the question and its options. The
// terminal shows both in full ("Ready to code? Here is Claude's plan: …"); the chat view showed a
// bare `ExitPlanMode` chip, so the one thing ⌘M exists for — reading it properly — was missing.
//
// PURE. Input shapes measured on real transcripts (2026-09-26):
//   ExitPlanMode    → {"plan": "<full markdown plan>"}
//   AskUserQuestion → {"questions": [{"question", "header", "multiSelect", "options": [{"label", "description"?}]}]}
// Anything that does not match degrades to NO body (today's chip) — never a half-rendered guess.
//
// `TodoWrite` (the agent's todo list) gets a body only on the opt-in `rich` read, so the golden
// fixtures and the phone's `chat.page` keep its chip. Its shape is the tool's own schema —
//   TodoWrite       → {"todos": [{"content", "status": "pending" | "in_progress" | "completed", "activeForm"?}]}
// — NOT a measurement: no TodoWrite record exists on this server's transcripts (2026-11-02; its CLIs,
// 2.1.209–2.1.316, write `TaskCreate` / `TaskUpdate` instead). The same no-guess rule covers that gap.

/** The body crosses IPC/WS with every chat read; a plan is prose, and 64K characters (UTF-16 code
 *  units, i.e. `String.length`) is far past any real one. */
export const TOOL_BODY_CAP = 64 * 1024
export const TOOL_BODY_TRUNCATED = '\n\n… (truncated)'

const FENCE = /^\s*```/

/** Caps a long text at `TOOL_BODY_CAP`, then appends `TOOL_BODY_TRUNCATED` (a tool body, and each
 *  side of an Edit/Write diff in the chat parse). */
export function capBody(s: string): string {
  if (s.length <= TOOL_BODY_CAP) return s
  let end = TOOL_BODY_CAP
  // Do not leave half a surrogate pair (an emoji) dangling at the cut.
  const last = s.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  let kept = s.slice(0, end)
  // A cut inside an open ``` block would render the marker as code (and swallow nothing after it
  // only by luck): an odd number of fence lines means one is open — close it first.
  const fences = kept.split('\n').filter((l) => FENCE.test(l)).length
  if (fences % 2 === 1) kept += '\n```'
  return kept + TOOL_BODY_TRUNCATED
}

// Model-authored text dropped into a one-line markdown slot (a bold header, a list item): a newline
// there would start a new block (a heading, an injected list item), so it collapses to a space.
const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
// Inside the `**…**` wrapper, the model's own `*` / `_` / `\` would close or break the bold.
const escapeEmphasis = (s: string): string => s.replace(/[\\*_]/g, (c) => `\\${c}`)
const bold = (s: string): string => `**${escapeEmphasis(oneLine(s))}**`

const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function planBody(input: Record<string, unknown>): string | undefined {
  return nonBlank(input.plan) ? input.plan : undefined
}

function questionsBody(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.questions)) return undefined
  const blocks: string[] = []
  for (const q of input.questions) {
    if (!isRecord(q) || !nonBlank(q.question)) continue
    const lines: string[] = []
    if (nonBlank(q.header)) lines.push(bold(q.header), '')
    // The question keeps its own paragraphs: it is a block of its own, not a one-line slot.
    lines.push(q.multiSelect === true ? `${q.question} _(select all that apply)_` : q.question)
    const options = Array.isArray(q.options)
      ? q.options
          .filter((o): o is Record<string, unknown> => isRecord(o) && nonBlank(o.label))
          .map((o) => `- ${bold(o.label as string)}${nonBlank(o.description) ? ` — ${oneLine(o.description)}` : ''}`)
      : []
    if (options.length) lines.push('', ...options)
    blocks.push(lines.join('\n'))
  }
  return blocks.length ? blocks.join('\n\n') : undefined
}

// One checklist line per readable todo: done ticked, the one in progress in bold and named so, any
// other status (pending, or one the schema does not know) an open box.
function todosBody(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.todos)) return undefined
  const lines: string[] = []
  for (const t of input.todos) {
    if (!isRecord(t) || !nonBlank(t.content)) continue
    const content = escapeEmphasis(oneLine(t.content))
    lines.push(
      t.status === 'completed'
        ? `- [x] ${content}`
        : t.status === 'in_progress'
          ? `- [ ] **${content}** _(in progress)_`
          : `- [ ] ${content}`
    )
  }
  return lines.length ? lines.join('\n') : undefined
}

/** Markdown body for a tool call worth reading in full, or undefined (render the plain chip).
 *  `opts.rich` adds the bodies only the desktop ⌘M panel draws (`ChatParseOptions.rich`): today
 *  the `TodoWrite` checklist. */
export function toolBody(name: string, input: unknown, opts?: { rich?: boolean }): string | undefined {
  if (!isRecord(input)) return undefined
  const body =
    name === 'ExitPlanMode'
      ? planBody(input)
      : name === 'AskUserQuestion'
        ? questionsBody(input)
        : name === 'TodoWrite' && opts?.rich === true
          ? todosBody(input)
          : undefined
  return body === undefined ? undefined : capBody(body)
}
