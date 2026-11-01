// The prompts a person typed into an agent node, kept per node so a canvas of many sessions still
// says what each one is for. Pure (no node, no electron, no zustand): the renderer store owns
// persistence and the canvas listener feeds it from the `newTurn` hook events.
//
// "Typed by the person" is decided HERE, by a closed list of what nodeterm and the agent CLIs inject
// through the same hook (UserPromptSubmit also fires for a queued subagent notification, for the
// notes nodeterm pushes into a linked session, and for the slash commands nodeterm types itself).
// Anything not on the list is kept: the person can delete a line they do not want, but they cannot
// get back one we guessed was noise.

export const NODE_PROMPT_MAX_CHARS = 400
export const NODE_PROMPT_MAX_ENTRIES = 40
/**
 * The longest prompt kept verbatim so it can be sent again. Past this the row still shows, but is
 * not resendable: sending a truncated prompt would be a different request, and 40 entries of
 * multi-KB pastes would crowd localStorage out for every other node.
 */
export const NODE_PROMPT_MAX_RESEND_CHARS = 2000
/**
 * The most the WHOLE store may occupy in localStorage, in bytes (a UTF-16 code unit is 2 bytes
 * there). Per-node caps alone bound nothing: 40 × 2 KB per node is ~80 KB, and a canvas of 60 agent
 * nodes would fill the origin's ~5 MB quota — which every other key on the origin (agent status,
 * explorer state, view mode) then pays for. Past this, the OLDEST prompts across all nodes go.
 */
export const NODE_PROMPT_STORE_MAX_BYTES = 512 * 1024

export interface NodePrompt {
  id: string
  /** One line for display: whitespace collapsed, clipped to NODE_PROMPT_MAX_CHARS. */
  text: string
  /** ms epoch the hook event reached the app. */
  at: number
  /** The prompt exactly as typed, kept only when `text` is not already that (multi-line or clipped). */
  full?: string
  /** The prompt was too long to keep verbatim: shown, but never resent. */
  partial?: true
}

/** What `rememberPrompt` keeps of one submitted prompt — a `NodePrompt` minus its id and time. */
export type RememberedPrompt = Pick<NodePrompt, 'text' | 'full' | 'partial'>

/** Blocks a CLI wraps around text it injected itself rather than text the person typed. */
const INJECTED_BLOCK =
  /^<(task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)[\s>]/

/** What nodeterm pushes into a session: linked-context notes (`[nodeterm] …`) and agent-to-agent messages. */
const NODETERM_INJECTED = /^(\[nodeterm\]\s|--- NODETERM MESSAGE\b)/

/**
 * Slash commands that steer the CLI rather than say what the work is. `/rename` and `/branch` are
 * typed by nodeterm itself (title sync, Branch conversation). `/loop`, `/schedule` and `/cron` are
 * deliberately NOT here — they carry the task — and neither is `/init` or a custom skill.
 */
const HOUSEKEEPING_COMMANDS = new Set([
  'rename',
  'branch',
  'exit',
  'quit',
  'clear',
  'compact',
  'resume',
  'model',
  'help',
  'effort',
  'fast',
  'context',
  'status',
  'usage',
  'cost'
])

const SLASH_COMMAND = /^\/([A-Za-z][\w-]*)(?:\s|$)/

/**
 * What to remember of a submitted prompt, or null when it is not something the person wrote (empty,
 * injected by a CLI or by nodeterm, or housekeeping).
 */
export function rememberPrompt(raw: unknown): RememberedPrompt | null {
  if (typeof raw !== 'string') return null
  const typed = raw.trim()
  if (!typed) return null
  if (INJECTED_BLOCK.test(typed) || NODETERM_INJECTED.test(typed)) return null
  const command = SLASH_COMMAND.exec(typed)
  if (command && HOUSEKEEPING_COMMANDS.has(command[1].toLowerCase())) return null
  const collapsed = typed.replace(/\s+/g, ' ')
  const text =
    collapsed.length <= NODE_PROMPT_MAX_CHARS ? collapsed : `${collapsed.slice(0, NODE_PROMPT_MAX_CHARS - 1)}…`
  if (text === typed) return { text }
  return typed.length <= NODE_PROMPT_MAX_RESEND_CHARS ? { text, full: typed } : { text, partial: true }
}

/** The exact text to send again, or null when only a clipped copy survives. */
export function resendText(prompt: NodePrompt): string | null {
  return prompt.partial ? null : (prompt.full ?? prompt.text)
}

/**
 * `prompts` with `text` appended as the newest entry. The same list comes back (so a store can skip
 * the write) when the newest entry already says exactly this — a /loop or a queued retry re-submits
 * the same prompt, and listing it twice in a row is noise, not history. Past the cap the OLDEST goes.
 */
export function appendPrompt(
  prompts: readonly NodePrompt[],
  entry: NodePrompt
): readonly NodePrompt[] {
  const last = prompts[prompts.length - 1]
  if (last && sameWording(last, entry)) return prompts
  const next = [...prompts, entry]
  return next.length > NODE_PROMPT_MAX_ENTRIES ? next.slice(next.length - NODE_PROMPT_MAX_ENTRIES) : next
}

/**
 * Whether two entries say the same thing — compared on what was TYPED (`full`, else `text`), never
 * on the clipped display line alone: two long prompts that share their first 400 characters (the
 * same pasted template with different tails) are different requests. Past the verbatim cap only
 * the clipped line survives, so two `partial` entries can only be compared on that.
 */
function sameWording(a: RememberedPrompt, b: RememberedPrompt): boolean {
  return a.partial === b.partial && (a.full ?? a.text) === (b.full ?? b.text)
}

export function removePrompt(prompts: readonly NodePrompt[], promptId: string): readonly NodePrompt[] {
  return prompts.some((p) => p.id === promptId) ? prompts.filter((p) => p.id !== promptId) : prompts
}

/** A stored entry is trusted only when it has the shape this module writes. */
export function isNodePrompt(v: unknown): v is NodePrompt {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.text === 'string' &&
    e.text.length > 0 &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    (e.full === undefined || typeof e.full === 'string') &&
    (e.partial === undefined || e.partial === true)
  )
}

/** Every node's prompts, keyed by node id — the shape the renderer store persists. */
export type PromptsById = Readonly<Record<string, readonly NodePrompt[]>>

/** What the whole map costs in localStorage: UTF-16, two bytes per code unit. */
export function storeBytes(byId: PromptsById): number {
  return JSON.stringify(byId).length * 2
}

/**
 * `byId` trimmed to at most `maxBytes` of localStorage by dropping the OLDEST prompts across every
 * node (a node's newest stays as long as anything does, since it is what the node is doing now).
 * The same object comes back when it already fits, so a store can skip the write.
 */
export function fitStoreBudget(byId: PromptsById, maxBytes: number = NODE_PROMPT_STORE_MAX_BYTES): PromptsById {
  let bytes = storeBytes(byId)
  if (bytes <= maxBytes) return byId
  const all: { nodeId: string; prompt: NodePrompt; bytes: number }[] = []
  for (const [nodeId, list] of Object.entries(byId)) {
    // Each entry is credited with its own text PLUS the node wrapper it might take with it — an
    // OVER-estimate of the saving, so the estimate loop stops early and the exact loop finishes.
    const wrapper = JSON.stringify(nodeId).length + 4
    for (const prompt of list) all.push({ nodeId, prompt, bytes: (JSON.stringify(prompt).length + wrapper) * 2 })
  }
  all.sort((a, b) => a.prompt.at - b.prompt.at)
  const dropped = new Set<string>()
  const without = (): PromptsById => {
    const out: Record<string, readonly NodePrompt[]> = {}
    for (const [nodeId, list] of Object.entries(byId)) {
      const kept = list.filter((p) => !dropped.has(p.id))
      if (kept.length > 0) out[nodeId] = kept
    }
    return out
  }
  // The per-entry estimate over-credits each drop, so this loop may stop a little SHORT of the
  // budget; one exact measurement per extra drop closes the gap without re-stringifying per entry.
  let i = 0
  for (; i < all.length && bytes > maxBytes; i++) {
    dropped.add(all[i].prompt.id)
    bytes -= all[i].bytes
  }
  let out = without()
  while (i < all.length && storeBytes(out) > maxBytes) {
    dropped.add(all[i++].prompt.id)
    out = without()
  }
  return out
}

/**
 * `byId` without the nodes that are in no project any more. The caller decides what "live" means
 * (and refuses to say when its project list is incomplete — see `liveNodeIds` in
 * `renderer/lib/unreadBadge.ts`); this only drops. The same object comes back when nothing is gone.
 */
export function prunePromptNodes(byId: PromptsById, live: ReadonlySet<string>): PromptsById {
  const gone = Object.keys(byId).filter((id) => !live.has(id))
  if (gone.length === 0) return byId
  const out: Record<string, readonly NodePrompt[]> = {}
  for (const [nodeId, list] of Object.entries(byId)) if (live.has(nodeId)) out[nodeId] = list
  return out
}
