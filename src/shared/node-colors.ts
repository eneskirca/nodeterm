import { AGENT_CONFIG, BUILTIN_AGENT_IDS, FALLBACK_AGENT_COLOR } from './agents/config'

/**
 * The node/frame/sticky palette shown by every renderer color picker.
 *
 * This is also the control boundary: agent-supplied colors must be one of these exact values,
 * never an arbitrary CSS token that would be persisted and interpolated into node styles.
 *
 * It has TWO sections and they are one list, deliberately:
 *
 *  - the seven system colors, which is what the palette was;
 *  - the AGENT brand colors, which every agent node has WORN SINCE IT WAS CREATED
 *    (`createAgentNode` colors a node from `AGENT_CONFIG`, and the phone does the same) but which
 *    the palette never contained. So a Claude node was born `#d97757`, the right-click picker
 *    could not offer that color back once the user changed it, and `color --color '#d97757'` was
 *    refused by the boundary below with `node-color-invalid` — the app's own color, rejected by
 *    the app. Both halves of that are this file.
 *
 * The agent section is DERIVED from `AGENT_CONFIG`, never re-typed. A second copy of a color
 * table is the drift CLAUDE.md warns about, and it has already happened once: the iOS companion
 * keeps a hand-copied mirror stamped "last verified 2026-07-17".
 */

export interface NodeColorSwatch {
  /** The persisted value. Canonical, lowercase hex — this is what lands in `data.color`. */
  readonly value: string
  /** Human name, shown as the swatch's tooltip / accessible name. */
  readonly label: string
  /**
   * Lowercase words `resolveNodeColor` accepts for this swatch besides its hex. The FIRST is the
   * primary one and is what the CLI's help text and refusal message print beside the hex.
   */
  readonly aliases: readonly string[]
}

/**
 * The seven macOS system colors. This subset — not the whole palette — is what the auto-assign
 * ROTATIONS use (new frames, spawned teams, fresh kanban columns) and what the app-accent picker
 * offers: rotating a frame onto Claude's orange would say "this frame is Claude's" when it means
 * nothing of the kind, and an agent brand color is not an app accent. Their INDICES are load
 * bearing (`kanban-default-board.ts` names 0/1/2), so append here, never insert.
 */
export const SYSTEM_NODE_COLOR_SWATCHES: readonly NodeColorSwatch[] = [
  { value: '#0a84ff', label: 'Blue', aliases: ['blue'] },
  { value: '#32d74b', label: 'Green', aliases: ['green'] },
  { value: '#ffd60a', label: 'Yellow', aliases: ['yellow'] },
  { value: '#ff453a', label: 'Red', aliases: ['red'] },
  { value: '#bf5af2', label: 'Purple', aliases: ['purple'] },
  { value: '#6ac4dc', label: 'Teal', aliases: ['teal', 'cyan'] },
  { value: '#ff9f0a', label: 'Orange', aliases: ['orange'] }
]

/**
 * The agent brand colors, read out of `AGENT_CONFIG` in builtin order, plus the grey that
 * `createAgentNode` gives a CUSTOM agent (`FALLBACK_AGENT_COLOR`) — a color real nodes wear and
 * the picker could not express either.
 *
 * Deduped by value: nothing stops two agents sharing a hex, and a duplicate would collide as a
 * React key and draw the same swatch twice. First occurrence wins, so a future agent that adopts
 * an existing color simply adds its name as an alias of the swatch that is already there.
 */
export const AGENT_NODE_COLOR_SWATCHES: readonly NodeColorSwatch[] = dedupe([
  ...BUILTIN_AGENT_IDS.map((id) => ({
    value: AGENT_CONFIG[id].color,
    label: AGENT_CONFIG[id].label,
    // The agent id is the alias an orchestrator already knows (`open-agent --agent claude`), and
    // the label lets a human type what the swatch says.
    aliases: aliasesFor(id, AGENT_CONFIG[id].label)
  })),
  { value: FALLBACK_AGENT_COLOR, label: 'Custom agent', aliases: ['custom', 'grey', 'gray'] }
])

function aliasesFor(id: string, label: string): readonly string[] {
  const lower = label.toLowerCase()
  const squashed = lower.replace(/\s+/g, '')
  return [...new Set([id.toLowerCase(), lower, squashed])]
}

function dedupe(swatches: readonly NodeColorSwatch[]): NodeColorSwatch[] {
  const seen = new Map<string, NodeColorSwatch>()
  for (const swatch of swatches) {
    const value = swatch.value.toLowerCase()
    const existing = seen.get(value)
    if (existing) {
      seen.set(value, {
        ...existing,
        aliases: [...new Set([...existing.aliases, ...swatch.aliases])]
      })
      continue
    }
    seen.set(value, { ...swatch, value })
  }
  return [...seen.values()]
}

/** The palette as the pickers draw it: sections, in order, each with its own heading. */
export const NODE_COLOR_SECTIONS: readonly { readonly label: string; readonly swatches: readonly NodeColorSwatch[] }[] = [
  { label: 'Colors', swatches: SYSTEM_NODE_COLOR_SWATCHES },
  { label: 'Agents', swatches: AGENT_NODE_COLOR_SWATCHES }
]

/** Every swatch, in section order. */
export const NODE_COLOR_SWATCHES: readonly NodeColorSwatch[] = NODE_COLOR_SECTIONS.flatMap(
  (section) => section.swatches
)

/** The full allowlist — what a picker may set and what the control verbs may persist. */
export const NODE_COLORS: readonly string[] = NODE_COLOR_SWATCHES.map((swatch) => swatch.value)

/** @see SYSTEM_NODE_COLOR_SWATCHES — the rotation/accent subset, NOT the whole palette. */
export const SYSTEM_NODE_COLORS: readonly string[] = SYSTEM_NODE_COLOR_SWATCHES.map((s) => s.value)

/**
 * A palette value. Deliberately `string` and not a literal union any more: half the palette is
 * now DERIVED from `AGENT_CONFIG` at runtime, and a union can only be written by re-typing those
 * hexes here — the second copy this file exists to avoid. Nothing is lost that was load bearing:
 * every value this guards arrives from the wire (a control POST) or from hand-edited JSON, where
 * a compile-time union proves nothing, and `isNodeColor` is and always was the real boundary.
 */
export type NodeColor = string

export const NODE_COLOR_INVALID_ERROR = 'node-color-invalid'

export function isNodeColor(value: unknown): value is NodeColor {
  return typeof value === 'string' && NODE_COLORS.includes(value)
}

/**
 * The narrower boundary for the three surfaces where a palette value stops being a dot, a border
 * or a 6–20% wash and becomes TEXT or an opaque fill: the app ACCENT (`--accent`, drawn under
 * hardcoded `#fff` in `.dock-add` and the dictation button), a PROJECT color (the active tab
 * label is `color: p.color`) and a kanban COLUMN color (`ColumnPill` draws the title in the raw
 * hex at 10 px on an 18% wash of itself).
 *
 * The seven system colors were chosen to be legible that way; the agent brand colors were chosen
 * by six other companies for a logo. Measured on the dark theme: white on gemini `#4285f4` is
 * ~3.6:1 and on grok `#64748b` ~4.0:1, both under the 4.5:1 floor for the 10.5 px badge, and grok
 * grey as tab text lands at ~2.6:1. So those surfaces keep the subset — the reason they differ is
 * a contrast measurement, not taste, and `styles.theme.test.ts` is where the floors live.
 */
export function isSystemNodeColor(value: unknown): value is NodeColor {
  return typeof value === 'string' && SYSTEM_NODE_COLORS.includes(value)
}

/** @see isSystemNodeColor — `resolveNodeColor` restricted to the system section. */
export function resolveSystemNodeColor(input: unknown): NodeColor | undefined {
  const resolved = resolveNodeColor(input)
  return resolved !== undefined && isSystemNodeColor(resolved) ? resolved : undefined
}

const BY_ALIAS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>()
  for (const swatch of NODE_COLOR_SWATCHES) {
    map.set(swatch.value, swatch.value)
    for (const alias of swatch.aliases) if (!map.has(alias)) map.set(alias, swatch.value)
  }
  return map
})()

/**
 * What the user or an agent TYPED, resolved to a canonical palette value — or undefined, which is
 * still a refusal. Accepts the hex in any case, and the swatch's name (`blue`, `claude`,
 * `github copilot`).
 *
 * Names are accepted because the refusal they used to earn was measured and it was expensive: a
 * palette of seven opaque hexes taught nobody which one was teal, and `--color blue` — the
 * obvious thing a person and a model both type — came back `node-color-invalid` with a list of
 * hexes. Names cost nothing at the boundary: resolution happens BEFORE the allowlist check and
 * can only ever produce a value that was already in it, so what gets persisted is the same
 * canonical hex it always was. A name is never stored.
 */
export function resolveNodeColor(input: unknown): NodeColor | undefined {
  if (typeof input !== 'string') return undefined
  return BY_ALIAS.get(input.trim().toLowerCase())
}

/**
 * `name #hex` for every swatch — the CLI's own vocabulary, printed for agents and humans.
 *
 * The refusal used to print seven bare hexes. That is a complete answer and an unusable one:
 * nothing in `#6ac4dc, #ff9f0a` says which is teal, so the caller's next guess is another name and
 * another refusal. Printing the name it can actually type ends the loop in one round trip.
 */
export function nodeColorChoices(
  swatches: readonly NodeColorSwatch[] = NODE_COLOR_SWATCHES
): string {
  return swatches.map((swatch) => `${swatch.aliases[0]} ${swatch.value}`).join(', ')
}

/** Stable named refusal shared by desktop and Server Edition control dispatch. */
export function invalidNodeColorMessage(): string {
  return `${NODE_COLOR_INVALID_ERROR}: --color takes a palette name or its hex — ${nodeColorChoices()}`
}

/** @see isSystemNodeColor — the same refusal for the narrower surfaces. */
export function invalidSystemNodeColorMessage(): string {
  return `${NODE_COLOR_INVALID_ERROR}: --color takes a palette name or its hex — ${nodeColorChoices(
    SYSTEM_NODE_COLOR_SWATCHES
  )}`
}
