// Shared between the transcript reader (core) and the ⌘M thread (renderer): how a slash command or
// a `!` bash-mode line appears in the chat. claude writes both as command RECORDS, not as the typed
// text, and the reader renders them as an assistant tool part (`name:"/model"` / `name:"!"`). The
// composer's optimistic bubble holds the TYPED text, so confirming it needs the same mapping.

/** The longest tool-part `arg` the reader emits (tool calls and local commands alike), in UTF-16
 *  code units (`String.prototype.slice`). */
export const CHAT_TOOL_ARG_MAX = 200

/** The tool-part name the reader gives a `!` bash-mode command. */
export const BASH_COMMAND_TOOL = '!'

/** The name an output record's tool part gets when there is no command to attach it to. */
export const COMMAND_OUTPUT_TOOL = 'command output'

/**
 * Whether a tool part is the USER's own local command (a `/slash` command, a `!` bash-mode line, or
 * the output of one) rather than a tool the agent called. The reader writes both as assistant tool
 * parts, so the thread can only tell them apart by name; agent tool names never start with `/`.
 */
export function isLocalCommandTool(name: string): boolean {
  return name.startsWith('/') || name === BASH_COMMAND_TOOL || name === COMMAND_OUTPUT_TOOL
}

/**
 * The command a SENT text would become, or null when it is not one: `/name args` → `{name:"/name",
 * arg}`, `!cmd` → `{name:"!", arg:"cmd"}`. Text is trimmed first (JS `trim`); `arg` is trimmed and
 * capped exactly as the reader caps it, so the two compare equal.
 */
export function sentCommand(text: string): { name: string; arg: string } | null {
  const t = text.trim()
  if (t.startsWith('!')) return { name: BASH_COMMAND_TOOL, arg: t.slice(1).trim().slice(0, CHAT_TOOL_ARG_MAX) }
  const m = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(t)
  if (!m) return null
  return { name: m[1], arg: (m[2] ?? '').trim().slice(0, CHAT_TOOL_ARG_MAX) }
}
