// What the ⌘M chat composer can complete after a `/`: the agent's own built-in slash commands, the
// user's and the project's CUSTOM commands, and SKILLS. Core builds the catalog for a node
// (core/chat-catalog.ts, both shells); this module holds the wire shape, the one sanitizer every
// name and description passes through, the measured built-in tables, and the ranking the composer
// uses. Pure — no fs, no React.
import { capabilityAgentId } from './agents/config'

/** `builtin` = the CLI's own command; `command` = a custom command file; `skill` = a SKILL.md. */
export type ChatCatalogKind = 'builtin' | 'command' | 'skill'
/** Where an entry came from. `user` = the agent's config dir (the managed account's, when bound). */
export type ChatCatalogScope = 'builtin' | 'user' | 'project'

export interface ChatCatalogEntry {
  /** Without the leading `/`. Always passes `catalogName`. */
  name: string
  /** One line, sanitized, capped. May be empty. */
  description: string
  kind: ChatCatalogKind
  scope: ChatCatalogScope
  /**
   * A built-in that opens a DIALOG or picker in the agent's TUI (`/model`, `/rewind`, `/resume`, …).
   * The ⌘M view cannot see that dialog, and the agent state still reads `done` while it is up, so the
   * next message's Enter would ANSWER it (confirm its highlighted row). After such a command is sent
   * the panel flips to the terminal (ChatPanel's send), and a composer that cannot flip does not
   * offer it. Built-ins only; a custom command or skill is a prompt, never a dialog.
   */
  interactive?: true
}

export interface ChatCatalog {
  version: 1
  entries: ChatCatalogEntry[]
  /** Set when a root could not be read (remote host down, unreadable dir): the list is short, not
   *  complete. The composer still offers what it has. */
  partial?: boolean
}

export const CHAT_CATALOG_MAX_ENTRIES = 400
export const CATALOG_NAME_MAX = 64
export const CATALOG_DESCRIPTION_MAX = 160

// A name is typed into a pane after `/`, so it gets a closed alphabet: letters, digits and the
// separators the CLIs themselves use (`git:commit`, `add-dir`, `v1.2`). Anything else — spaces,
// quotes, control or format characters, a leading separator — is not a command anyone can type.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

export function catalogName(raw: unknown): string | null {
  // Not trimmed: a name that needs trimming came from somewhere that does not produce names.
  if (typeof raw !== 'string' || !raw || raw.length > CATALOG_NAME_MAX || !NAME_RE.test(raw)) return null
  return raw
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]+/g
// Bidi overrides, zero-width joiners and the rest of the format class: a description is data from a
// file anyone can commit, and a right-to-left override can make one entry read like another.
const FORMAT = /\p{Cf}+/gu

/** Descriptions are hostile data (a project's `.claude/commands` is whatever the repository holds):
 *  one line, control and format characters removed, whitespace collapsed, capped by code point. */
export function catalogDescription(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const one = raw.replace(CONTROL, ' ').replace(FORMAT, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > CATALOG_DESCRIPTION_MAX ? chars.slice(0, CATALOG_DESCRIPTION_MAX - 1).join('') + '…' : one
}

const KINDS: ReadonlySet<string> = new Set(['builtin', 'command', 'skill'])
const SCOPES: ReadonlySet<string> = new Set(['builtin', 'user', 'project'])

/** A catalog that crossed a wire (IPC, WS, relay) is re-checked on arrival: every entry that does
 *  not pass is DROPPED, never repaired. Anything that is not a catalog becomes an empty one. */
export function sanitizeChatCatalog(raw: unknown): ChatCatalog {
  const out: ChatCatalogEntry[] = []
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const list = rec && Array.isArray(rec.entries) ? rec.entries : []
  for (const e of list) {
    if (out.length >= CHAT_CATALOG_MAX_ENTRIES) break
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const name = catalogName(r.name)
    if (!name || typeof r.kind !== 'string' || !KINDS.has(r.kind) || typeof r.scope !== 'string' || !SCOPES.has(r.scope)) {
      continue
    }
    out.push({
      name,
      description: catalogDescription(r.description),
      kind: r.kind as ChatCatalogKind,
      scope: r.scope as ChatCatalogScope,
      ...(r.interactive === true ? { interactive: true as const } : {})
    })
  }
  return { version: 1, entries: out, ...(rec?.partial === true ? { partial: true } : {}) }
}

type Builtin = readonly [name: string, description: string]

/**
 * Built-in slash commands per base harness — ONLY what was measured against the installed CLI, by
 * typing `/` in its interactive TUI inside a private tmux server and paging the whole menu, and
 * only the general-purpose ones (plan-, login- and experiment-gated entries are left out: a command
 * the user's CLI does not accept is worse than one they have to type). The descriptions are ours.
 *
 * - claude 2.1.285, codex 0.156.1, opencode 1.18.25 (fresh session: 17 commands) — 2026-09-30.
 * - gemini 0.62.0 — 2026-09-30, with a throwaway HOME and a dummy API key (the menu is client-side;
 *   no request was made). Every entry below is in that menu.
 * - grok: NOT listed. 1.0.44 would not start past its browser sign-in on the measuring host, and a
 *   list copied from docs is a guess about the binary the user runs.
 *
 * Any other agent (grok, copilot, antigravity, a custom agent with no base) gets no built-ins — it
 * still gets `@` file completion. A custom agent built on one of these inherits its base's list.
 *
 * `SAFE` names the built-ins that run at once with no dialog; every OTHER built-in is treated as
 * `interactive` (see ChatCatalogEntry). Over-tagging costs a flip to the terminal after the send;
 * under-tagging lets the next message answer a dialog nobody can see — so unknown means dialog.
 */
const BUILTINS: Readonly<Record<string, readonly Builtin[]>> = Object.freeze({
  claude: [
    ['add-dir', 'Add a working directory'],
    ['branch', 'Branch the conversation at this point'],
    ['btw', 'Ask a side question without interrupting'],
    ['clear', 'Start over with an empty context'],
    ['compact', 'Summarize the conversation to free context'],
    ['config', 'Open settings'],
    ['context', 'Show context usage'],
    ['copy', 'Copy the last response'],
    ['diff', 'Show uncommitted changes'],
    ['effort', 'Set the effort level'],
    ['exit', 'Exit the CLI'],
    ['export', 'Export the conversation'],
    ['help', 'Show help and commands'],
    ['hooks', 'View hook configuration'],
    ['init', 'Create the project instruction file'],
    ['mcp', 'Manage MCP servers'],
    ['memory', 'Edit memory files'],
    ['model', 'Choose the model'],
    ['output-style', 'Switch output style'],
    ['permissions', 'Manage permission rules'],
    ['plan', 'Enter plan mode or view the plan'],
    ['plugin', 'Manage plugins'],
    ['recap', 'Summarize the session in one line'],
    ['release-notes', 'View release notes'],
    ['reload-skills', 'Pick up skills changed on disk'],
    ['rename', 'Rename the conversation'],
    ['resume', 'Resume a previous conversation'],
    ['rewind', 'Restore code or conversation to an earlier point'],
    ['security-review', 'Security review of pending changes'],
    ['skills', 'List available skills'],
    ['status', 'Show version, model and account'],
    ['statusline', 'Set up the status line'],
    ['tasks', 'Manage background tasks'],
    ['theme', 'Change the theme'],
    ['usage', 'Show usage and cost']
  ],
  codex: [
    ['agents', 'Open the agent command center'],
    ['cd', 'Change the working directory'],
    ['clear', 'Clear and start a new chat'],
    ['compact', 'Summarize the conversation to free context'],
    ['copy', 'Copy the last response'],
    ['diff', 'Show the git diff'],
    ['exit', 'Exit the CLI'],
    ['export', 'Export the conversation as markdown'],
    ['fork', 'Fork the current chat'],
    ['goal', 'Set or view the goal'],
    ['hooks', 'View and manage hooks'],
    ['init', 'Create the project instruction file'],
    ['mcp', 'List configured MCP tools'],
    ['mention', 'Mention a file'],
    ['model', 'Choose the model and reasoning effort'],
    ['new', 'Start a new chat'],
    ['permissions', 'Choose what the agent may do'],
    ['plan', 'Switch to plan mode'],
    ['ps', 'List background terminals'],
    ['recap', 'Summarize the conversation now'],
    ['rename', 'Rename the thread'],
    ['resume', 'Resume a saved chat'],
    ['review', 'Review current changes'],
    ['skills', 'Use skills'],
    ['status', 'Show session configuration and token usage'],
    ['stop', 'Stop background terminals'],
    ['theme', 'Choose a syntax theme'],
    ['usage', 'View account usage']
  ],
  gemini: [
    ['about', 'Show version info'],
    ['agents', 'List available agents'],
    ['chat', 'Manage conversation checkpoints'],
    ['clear', 'Clear the screen and start a new session'],
    ['commands', 'List or reload custom commands'],
    ['compress', 'Replace the context with a summary'],
    ['copy', 'Copy the last result'],
    ['directory', 'Manage workspace directories'],
    ['help', 'Show help'],
    ['hooks', 'Manage hooks'],
    ['init', 'Create the project instruction file'],
    ['mcp', 'Manage MCP servers'],
    ['model', 'Choose the model'],
    ['permissions', 'Manage folder trust'],
    ['plan', 'Switch to plan mode'],
    ['quit', 'Exit the CLI'],
    ['resume', 'Browse saved conversations'],
    ['rewind', 'Rewind to an earlier point'],
    ['settings', 'View and edit settings'],
    ['skills', 'Manage skills'],
    ['stats', 'Show session statistics'],
    ['theme', 'Change the theme'],
    ['tools', 'List available tools']
  ],
  opencode: [
    ['agents', 'Switch agent'],
    ['connect', 'Connect a provider'],
    ['diff', 'Open the diff viewer'],
    ['editor', 'Open the editor'],
    ['exit', 'Exit the app'],
    ['help', 'Help'],
    ['init', 'Create the project instruction file'],
    ['mcps', 'Toggle MCP servers'],
    ['models', 'Switch model'],
    ['new', 'New session'],
    ['review', 'Review changes'],
    ['sessions', 'Switch session'],
    ['skills', 'Skills'],
    ['status', 'View status'],
    ['themes', 'Switch theme']
  ]
})

const SAFE: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  claude: new Set(['clear', 'compact', 'init', 'recap', 'reload-skills', 'security-review']),
  codex: new Set(['clear', 'compact', 'init', 'new', 'recap']),
  gemini: new Set(['clear', 'compress', 'init']),
  opencode: new Set(['new'])
})

function baseWithTable(agentId: string | undefined): string | null {
  if (!agentId) return null
  const base = capabilityAgentId(agentId)
  return Object.prototype.hasOwnProperty.call(BUILTINS, base) ? base : null
}

/** The measured built-ins for a node's agent (through a custom agent's base harness), or `[]`. */
export function builtinSlashCommands(agentId: string | undefined): ChatCatalogEntry[] {
  const base = baseWithTable(agentId)
  if (!base) return []
  const safe = SAFE[base]
  return BUILTINS[base].map(([name, description]) => ({
    name,
    description,
    kind: 'builtin' as const,
    scope: 'builtin' as const,
    ...(safe?.has(name) ? {} : { interactive: true as const })
  }))
}

/**
 * Does this SENT text open a dialog in the agent's TUI — a built-in of that agent tagged
 * `interactive`, typed from the menu or by hand, with or without arguments (a flip after
 * `/model sonnet` costs nothing; a missed dialog costs the next message)? Case-sensitive like the
 * CLIs' own lookup.
 */
export function isInteractiveBuiltin(agentId: string | undefined, text: string): boolean {
  const base = baseWithTable(agentId)
  if (!base) return false
  const m = /^\/([A-Za-z0-9._:-]+)(?:\s|$)/.exec(text.trim())
  if (!m) return false
  return BUILTINS[base].some(([name]) => name === m[1]) && !SAFE[base]?.has(m[1])
}

/** Every agent id with a built-in table (tests walk it). */
export const BUILTIN_CATALOG_AGENTS: readonly string[] = Object.freeze(Object.keys(BUILTINS))

/**
 * Merge entries in precedence order — earlier lists win a name clash. Core passes project, then
 * user, then built-ins: the project's own command shadows the user's (the documented rule for
 * gemini's custom commands; the same order for claude's is our choice), and a custom command
 * named like a built-in is the one the user wrote, so it is the one offered.
 */
export function mergeCatalogEntries(...lists: readonly (readonly ChatCatalogEntry[])[]): ChatCatalogEntry[] {
  const seen = new Set<string>()
  const out: ChatCatalogEntry[] = []
  for (const list of lists) {
    for (const e of list) {
      const key = e.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
      if (out.length >= CHAT_CATALOG_MAX_ENTRIES) return out
    }
  }
  return out
}

export const CATALOG_RESULT_LIMIT = 50

/**
 * The composer's `/` list for a query (what follows the slash): prefix matches first, then
 * names containing the query, then description-only matches; within a band, shorter names first,
 * then alphabetical. Case-insensitive. An empty query lists everything in that order.
 */
export function rankCatalog(entries: readonly ChatCatalogEntry[], query: string, limit = CATALOG_RESULT_LIMIT): ChatCatalogEntry[] {
  const q = query.toLowerCase()
  const scored: { e: ChatCatalogEntry; band: number }[] = []
  for (const e of entries) {
    const n = e.name.toLowerCase()
    let band: number
    if (!q || n.startsWith(q)) band = 0
    else if (n.includes(q)) band = 1
    else if (q.length >= 3 && e.description.toLowerCase().includes(q)) band = 2
    else continue
    scored.push({ e, band })
  }
  scored.sort((a, b) => a.band - b.band || a.e.name.length - b.e.name.length || a.e.name.localeCompare(b.e.name))
  return scored.slice(0, limit).map((s) => s.e)
}
