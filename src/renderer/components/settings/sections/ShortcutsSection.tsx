/**
 * The Keyboard Shortcuts settings section: one dense row per registry command, with its live
 * chips, a per-chip ×, and hover-revealed Record / Add / Disable / Reset icon controls, under a
 * filter rail (a local query + a status pill carrying live counts).
 *
 * **The rail's filtering is LOCAL and additive to the global settings search.** A row is on
 * screen only when all three agree: the settings search (`SearchableRow`, unchanged), the rail's
 * query (`matchesShortcutQuery` — which also searches the CHORDS, something the global search
 * cannot see) and the status filter. The rail's counts deliberately ignore the status filter, so
 * they describe the buckets rather than the current selection. Groups get one wrapper each,
 * because the shell's body is `divide-y [&>*]:py-5` and a row per direct child made 21 dividers.
 *
 * **The pre-save gate is `commitCandidate`, and it is where the refusal messages are decided.**
 * Design D3 is "same detector, different surfacing": `sanitizeKeybindingOverrides` applies what
 * survives on LOAD, while this section refuses a bad candidate BEFORE anything is written, so the
 * user learns which chord was refused and why instead of watching a saved shortcut disappear on
 * the next launch. The checks run in this order, and the order is the whole dedupe:
 *   1. `normalizeBindingForCommand` — already inside `ShortcutRecorderButton`, so an invalid chord
 *      never reaches `onCommit` (its own hint is shown in the recorder button itself).
 *   2. `findKeybindingConflicts` over the candidate map — a same-bucket collision.
 *   3. `findMainInterceptShadowing` — a CROSS-bucket hit the conflict check cannot see.
 *   4. REVERSE shadowing — the same collision seen from the non-intercepted side.
 *   5. The two DICTATION overlap gates — the one overlap `conflictBucket` deliberately does not
 *      report, refused here in both directions, but only for `app`/`canvas`-scope commands: the
 *      keyed gesture has a focus gate, so a terminal- or scm-scope command never competes with it
 *      (see the block itself for why).
 * (2) returns early, so a candidate that trips both detectors (a main-intercepted command taking
 * a chord another GLOBAL command already holds — `node.close` ← `Cmd+K`) produces exactly ONE
 * message. The shadow message is reserved for what only it can see: `node.close` ← `Cmd+F`, where
 * the two commands live in different buckets and nothing collides, yet main swallows the key
 * before the terminal surface is ever offered it.
 *
 * Writes go through `setKeybindingOverride` (the single write path — it also mirrors
 * `speech.dictation` into the legacy `settings.speech.shortcut` field for one release).
 */
import { useMemo, useState } from 'react'
import { IconClose } from '../../icons'
import {
  bindingIdentity,
  COMMANDS_BY_ID,
  COMMAND_DEFINITIONS,
  findKeybindingConflicts,
  findMainInterceptShadowing,
  MAIN_INTERCEPTED_COMMAND_IDS,
  normalizeTerminalShortcutPolicy,
  type CommandDefinition,
  type CommandGroup,
  type CommandId,
  type KeybindingOverrides,
  type TerminalShortcutPolicy
} from '@shared/keybindings'
import { formatShortcut } from '@shared/shortcut'
import { isMacPlatform, keyLabel } from '@shared/platform-utils'
import {
  activeKeybindingOverrides,
  commandKeysFor,
  effectiveBindings,
  setKeybindingOverride
} from '../../../lib/keybindingOverrides'
import { useSettings } from '../../../state/settings'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { ShortcutRecorderButton } from '../ShortcutRecorderButton'
import { IconDisableSlash, IconPlusSmall, IconResetArrow } from '../ShortcutRowIcons'
import { Tooltip } from '../../Tooltip'
import { Input } from '@renderer/ui/Input'
import { SegmentedPill } from '@renderer/ui/SegmentedPill'
import { useSettingsSearch } from '../context'
import { matchesQuery, type SettingsSearchEntry } from '../search'
import {
  matchesShortcutQuery,
  rowPassesStatus,
  shortcutRowStatus,
  type ShortcutRowStatus,
  type ShortcutStatusFilter
} from '../shortcutFilter'

/** Per-command help text. Only commands whose BEHAVIOR needs explaining get one — a row that
 *  merely repeats its own title is noise in a 20-row list. */
const NOTES: Partial<Record<CommandId, string>> = {
  // Reused verbatim from the old SpeechSection row: the mode is derived from the chord's SHAPE,
  // which is not guessable from a chip.
  'speech.dictation':
    'With a key = toggle (press to start, press again to stop and insert); modifiers only = hold to talk (hold to record, release to stop and insert). The Dock mic uses the same shortcut. A keyed dictation chord is claimed before any other shortcut while the canvas has focus.',
  'canvas.deleteSelection': 'Bare keys are allowed here; the typing guard keeps Backspace safe.',
  'terminal.copySelection': 'Applies to a selection xterm owns — a tmux drag copies through OSC 52.'
}

/** The policy row is NOT a registry command, so it carries its own search entry and its own
 *  `SearchableRow` — putting it inside a group Fragment would make `groupVisible` (which only
 *  knows about commands) decide whether a *setting* is on screen. */
const POLICY_LABEL = 'While a terminal has focus'
const POLICY_DESCRIPTION =
  "App shortcuts first (the default): shared shortcuts like ⌘K keep working over a focused terminal, and the first time one is captured that way the terminal says so — once per chord, ever. Terminal first: every chord but the terminal's own reaches the shell or TUI, including Close (⌘W / Ctrl+W), Minimize (⌘M / Ctrl+M), actual size (⌘0), the kanban board (⌘⇧B), Settings (⌘,) and the ⌘1–9 project jumps — the matching application-menu entries grey out while a terminal is focused, so those chords can reach it. Reload (⌘R / ⌘⇧R) is the one exception and always stays with the app, so a stuck window can still be recovered."
const POLICY_ROW: SettingsSearchEntry = {
  title: POLICY_LABEL,
  description: POLICY_DESCRIPTION,
  keywords: ['shortcut', 'terminal', 'tui', 'shell', 'policy', 'first', 'capture', 'minimize']
}

function rowEntry(def: CommandDefinition): SettingsSearchEntry {
  return {
    title: def.title,
    description: NOTES[def.id],
    keywords: ['shortcut', 'keybinding', 'hotkey', 'key', def.group, def.id]
  }
}

/**
 * Everything the LOCAL matcher searches, derived from the entry the GLOBAL settings search
 * already gets — so the two can never disagree about which rows exist.
 *
 * They are not the same shape: `rowEntry` puts the per-command NOTE in `description` (never in
 * `keywords`), `matchesQuery` searches title + description + keywords, and
 * `matchesShortcutQuery` has no description slot at all. Passing `entry.keywords` alone would
 * therefore lose the note: 'tmux' finds Copy terminal selection in the sidebar search and
 * NOTHING in the rail, on the same screen. The note rides along as one more keyword instead.
 */
function rowKeywords(entry: SettingsSearchEntry): string[] {
  const keywords = entry.keywords ?? []
  return entry.description ? [...keywords, entry.description] : keywords
}

/** The rail is not a registry command, so — like the policy row — it carries its own search
 *  entry: a query for 'unassigned' must keep the control that offers that filter. */
const RAIL_ROW: SettingsSearchEntry = {
  title: 'Filter shortcuts',
  keywords: ['filter', 'search', 'modified', 'unassigned', 'disabled']
}

/** The row's per-command controls: 16px glyph in a 24px hit target, color from the parent.
 *  The repo ships no Tailwind preflight, so `border-0 bg-transparent p-0` must be explicit —
 *  without them the browser's native button chrome (border + fill + padding) renders. */
const ICON_BUTTON =
  'flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-fill-weak hover:text-text focus-visible:text-text'
/** Shared pill geometry — the accent/neutral fill is appended per badge. */
const BADGE = 'rounded-full px-2 py-0.5 text-[11px] font-medium'

/** Commands whose consumers read the FIRST effective binding only, so a second chord would be
 *  dead on arrival. `speech.dictation` is the case: every dictation surface (the hold listener,
 *  the keyed gesture, the Dock mic, SpeechSection's note) goes through `dictationBinding()`, which
 *  is `effectiveBindings('speech.dictation')[0]`. Their rows get no Add and show one chip. */
const SINGLE_BINDING_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(['speech.dictation'])

function groupEntry(group: CommandGroup, defs: CommandDefinition[]): SettingsSearchEntry {
  // The header must survive any query that keeps one of its rows, so its keywords are the union
  // of what those rows match on — otherwise a filtered list shows rows under the wrong heading.
  return {
    title: group,
    keywords: ['shortcut', 'keybinding', 'hotkey', ...defs.flatMap((d) => [d.title, d.id])]
  }
}

/** Does this group have anything to show under the current query? It decides BOTH the heading and
 *  the group's presence, which is why the heading is not a `SearchableRow` of its own: a row can
 *  match on its per-command note (`NOTES`) — query "tmux" hits Copy terminal selection — and a
 *  heading filtered independently would then leave that row standing under no heading at all. */
function groupVisible(query: string, group: CommandGroup, defs: CommandDefinition[]): boolean {
  if (query.trim() === '') return true
  return (
    matchesQuery(query, groupEntry(group, defs)) || defs.some((d) => matchesQuery(query, rowEntry(d)))
  )
}

/**
 * The testable core the row controls delegate to: gate a candidate binding, then write it.
 * `mode` is `'replace'` (the recorder's primary action) or `'add'` (a second chord for the same
 * command). Re-adding a chord the command already holds is idempotent rather than a
 * self-conflict — it is filtered out of the list before being appended.
 *
 * Assumes `combo` is already canonical: `ShortcutRecorderButton` runs
 * `normalizeBindingForCommand` and never emits an invalid chord.
 */
export function commitCandidate(
  id: CommandId,
  combo: string,
  mode: 'replace' | 'add'
): { ok: true } | { ok: false; error: string } {
  const isMac = isMacPlatform()
  const current = activeKeybindingOverrides()
  const existing = effectiveBindings(id)
  const nextList = mode === 'add' ? [...existing.filter((b) => b !== combo), combo] : [combo]
  const chord = formatShortcut(combo, isMac)
  // The candidate's platform identity, computed ONCE: the reverse-shadow block and both dictation
  // gates all ask the same question of it, and three copies of one call is three chances to drift.
  const identity = bindingIdentity(combo, isMac)

  const conflicts = findKeybindingConflicts({ ...current, [id]: nextList }, isMac).filter((c) =>
    c.commandIds.includes(id)
  )
  if (conflicts.length) {
    const titles = [
      ...new Set(
        conflicts
          .flatMap((c) => c.commandIds)
          .filter((cid) => cid !== id)
          .map((cid) => COMMANDS_BY_ID.get(cid)?.title ?? cid)
      )
    ]
    return { ok: false, error: `${chord} is already used by ${titles.join(', ')}.` }
  }

  const shadowed = findMainInterceptShadowing(id, combo, current, isMac)
  if (shadowed.length) {
    const titles = shadowed.map((cid) => COMMANDS_BY_ID.get(cid)?.title ?? cid).join(', ')
    return { ok: false, error: `${chord} would be swallowed app-wide before ${titles} could see it.` }
  }

  // REVERSE shadowing — the same collision seen from the other side, and neither gate above can
  // see it. `findMainInterceptShadowing` answers only for an INTERCEPTED id, and a bucket conflict
  // needs both commands in one bucket; binding `terminal.find` to `Cmd+W` is neither, so it passed
  // every check and produced a permanently dead shortcut with no warning — main swallows the chord
  // in `before-input-event` and the terminal surface is never offered it.
  if (!MAIN_INTERCEPTED_COMMAND_IDS.includes(id)) {
    for (const cid of MAIN_INTERCEPTED_COMMAND_IDS) {
      const hit = effectiveBindings(cid).some((b) => bindingIdentity(b, isMac) === identity)
      if (!hit) continue
      const title = COMMANDS_BY_ID.get(cid)?.title ?? cid
      const own = COMMANDS_BY_ID.get(id)?.title ?? id
      return {
        ok: false,
        error: `${chord} is intercepted app-wide for ${title}; it would never reach ${own}.`
      }
    }
  }

  // DICTATION OVERLAP, both directions. `speech.dictation` is its own conflict bucket (see
  // `conflictBucket` in @shared/keybindings), so gate (2) above is silent about it BY DESIGN —
  // dictation never competes at dispatch, it PRE-EMPTS: the resolver skips it and its own keyed
  // listener claims the chord first while the canvas has focus. That is precedence, not ambiguity,
  // which is why the LOAD path permits an overlap (legacy files contain them, and dropping a user's
  // chord is the failure that bucket closes) while a chord a user picks HERE is refused instead:
  // an interactive pick deserves to be told about the precedence, not to discover it later.
  //
  // Both gates are keyed-only WITHOUT an explicit hold guard: `bindingIdentity` renders a
  // modifier-only chord as `…:(hold)`, which no keyed identity can ever equal — so the default
  // `Cmd+Alt` hold chord blocks nothing, and a hold candidate trips nothing.
  //
  // Both are also SCOPED to `app`/`canvas`, because the gesture has a FOCUS GATE: the keyed
  // dictation listener runs only in plain app focus (`dispatchGlobalKeydown` in
  // `renderer/lib/globalKeybindings.ts` — `!ctx.typing && !ctx.terminal && !ctx.kanbanOpen`). A
  // `terminal`- or `scm`-scope command dispatches ONLY where that gate is already shut, so it
  // never competes with dictation for its chord; refusing the overlap would forbid a binding that
  // was legal before this branch and still works at dispatch (⌘⌥D on Find in terminal, say).
  const dictationId: CommandId = 'speech.dictation'
  const dictationTitle = COMMANDS_BY_ID.get(dictationId)?.title ?? dictationId
  const candidateScope = COMMANDS_BY_ID.get(id)?.scope
  if (id !== dictationId && (candidateScope === 'app' || candidateScope === 'canvas')) {
    // "rarely", not "never": dictation's keyed listener only claims the chord where it listens.
    // An app-scope command flagged `allowInTerminal` still fires in terminal focus under
    // app-first — the message must not overclaim a chord that is merely usually lost.
    const taken = effectiveBindings(dictationId).some((b) => bindingIdentity(b, isMac) === identity)
    if (taken) {
      const own = COMMANDS_BY_ID.get(id)?.title ?? id
      return {
        ok: false,
        error: `${chord} is used by ${dictationTitle}, which claims it first; it would rarely reach ${own}.`
      }
    }
  } else if (id === dictationId) {
    for (const def of COMMAND_DEFINITIONS) {
      if (def.id === dictationId) continue
      // The same focus gate, read from the other side: a focused-surface command cannot be hidden
      // by a gesture that is never offered on that surface.
      if (def.scope === 'terminal' || def.scope === 'scm') continue
      const hit = effectiveBindings(def.id).some((b) => bindingIdentity(b, isMac) === identity)
      if (!hit) continue
      return {
        ok: false,
        error: `${chord} is already used by ${def.title}; ${dictationTitle} would claim it first and hide it.`
      }
    }
  }

  setKeybindingOverride(id, nextList)
  return { ok: true }
}

/**
 * The row's chords, as keycap chips.
 *
 * `limit` exists for `speech.dictation`: its consumers read `dictationBinding()` — the FIRST
 * effective binding — so showing a second chip would promise a chord that can never fire.
 *
 * `onRemove` is what turns each chip group into a removable one (the trailing ×). It is
 * `undefined` unless the caller decided removal is offered at all, so a chip that is the
 * command's ONLY chord never grows an × — that would be a Disable in disguise, and Disable is
 * its own control with its own meaning (`[]`, not "no override").
 */
function Chips({
  chords,
  limit,
  title,
  onRemove
}: {
  chords: readonly (readonly string[])[]
  limit?: number
  title: string
  onRemove?: (index: number) => void
}): React.JSX.Element {
  const isMac = isMacPlatform()
  const keys = limit === undefined ? chords : chords.slice(0, limit)
  if (keys.length === 0) return <></>
  return (
    <span className="flex items-center gap-2">
      {keys.map((parts, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span className="text-[11px] text-muted">or</span> : null}
          {parts.map((p, j) => (
            <kbd key={j} className="kbd">
              {keyLabel(p)}
            </kbd>
          ))}
          {onRemove ? (
            <button
              type="button"
              // The chord is named in the label because a row can hold several: "Remove" alone
              // would leave a screen reader with N identical buttons.
              aria-label={`Remove ${isMac ? parts.join('') : parts.join('+')} from ${title}`}
              title="Remove this shortcut"
              onClick={() => onRemove(i)}
              className="cursor-pointer border-0 bg-transparent px-0.5 text-[12px] leading-none text-muted opacity-0 group-hover/row:opacity-60 hover:!opacity-100 focus-visible:opacity-100"
            >
              <IconClose />
            </button>
          ) : null}
        </span>
      ))}
    </span>
  )
}

/** One row's precomputed facts: its search entry, its chords (read ONCE — the counts and the
 *  rendered list must not take two different reads of the override map) and its status. */
interface RowModel {
  def: CommandDefinition
  entry: SettingsSearchEntry
  keywords: string[]
  chords: string[][]
  status: ShortcutRowStatus
}

export function ShortcutsSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  // Any remap re-renders every row: chips, and the Add/Disable/Reset visibility, are all derived
  // from the override map.
  const overrides = useSettings((s) => s.settings.keybindings)
  // Read through the normalizer, never as the raw field: settings.json is hand-editable, so the
  // compile-time type is not a runtime guarantee and an unknown value must render as `app-first`
  // — the same degrade `terminalShortcutPolicy()` applies at dispatch, so the pill cannot show a
  // policy the dispatcher is not using.
  const policy = normalizeTerminalShortcutPolicy(
    useSettings((s) => s.settings.terminalShortcutPolicy)
  )
  const update = useSettings((s) => s.update)
  const query = useSettingsSearch()
  const [errors, setErrors] = useState<Partial<Record<CommandId, string>>>({})
  // The rail's two controls. Local to the section on purpose: they are a way of LOOKING at the
  // list, not a setting — nothing about them belongs in settings.json.
  const [filterQuery, setFilterQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<ShortcutStatusFilter>('all')

  const groups = useMemo(() => {
    const byGroup = new Map<CommandGroup, CommandDefinition[]>()
    for (const def of COMMAND_DEFINITIONS) {
      byGroup.set(def.group, [...(byGroup.get(def.group) ?? []), def])
    }
    return [...byGroup.entries()]
  }, [])

  const entries = useMemo(
    () => [
      POLICY_ROW,
      RAIL_ROW,
      ...groups.map(([group, defs]) => groupEntry(group, defs)),
      ...COMMAND_DEFINITIONS.map(rowEntry)
    ],
    [groups]
  )

  /**
   * The RAW `settings.keybindings`, narrowed to the entries whose value is actually a list.
   *
   * **`shortcutRowStatus` reads `override.length`, and the raw map is not typed at runtime.**
   * `settings.keybindings` is hand-editable JSON and `mergeSettings` passes it through with no
   * per-value validation, so `{"canvas.undo": null}` arrives here verbatim — inside a memo that
   * runs on every render, with no error boundary above Settings, which means a `TypeError` here
   * blanks the whole renderer and takes away the page the user would have opened to repair the
   * value. The pre-redesign row carried this guard inline
   * (`Array.isArray(override) && override.length === 0`); this is that guard, at the one call
   * site that still needs it. `shortcutFilter.ts` is pure and stays as shipped: a malformed
   * value is this section's to keep out, not that module's to tolerate.
   *
   * A non-array entry reads as **absent** — the row shows its default, offers no Reset and is
   * not counted as Modified. That is the truth rather than a degrade: the sanitized read path
   * (`sanitizeKeybindingOverrides`, which already ignores it) is what the chips and every gate
   * are showing, so there is no override for a Reset to undo.
   */
  const listOverrides = useMemo<KeybindingOverrides>(() => {
    const out: KeybindingOverrides = {}
    for (const def of COMMAND_DEFINITIONS) {
      const value = overrides?.[def.id]
      if (Array.isArray(value)) out[def.id] = value
    }
    return out
  }, [overrides])

  // One read of the override map per render pass, shared by the counts and by the rendered rows.
  // Two reads would be two chances to disagree — the pill saying `Modified 2` over one row.
  const models = useMemo<RowModel[]>(
    () =>
      COMMAND_DEFINITIONS.map((def) => {
        const entry = rowEntry(def)
        const chords = commandKeysFor(def.id)
        return {
          def,
          entry,
          keywords: rowKeywords(entry),
          chords,
          status: shortcutRowStatus(def.id, listOverrides, chords.length)
        }
      }),
    [listOverrides]
  )
  const modelById = useMemo(() => new Map(models.map((m) => [m.def.id, m])), [models])

  // Counts are taken over EVERY command that passes the local query, before the status filter is
  // applied — they say how big each bucket is inside what the user is looking at, which is the
  // only reading that lets the pill be used to navigate. (A count that also honored the status
  // filter would read `Modified 2` beside two rows and `0` beside every other option.)
  const counts = useMemo(() => {
    const c = { all: 0, modified: 0, unassigned: 0, disabled: 0 }
    for (const m of models) {
      if (!matchesShortcutQuery(m.def, m.keywords, m.chords, filterQuery)) continue
      c.all += 1
      if (m.status.modified) c.modified += 1
      if (m.status.unassigned) c.unassigned += 1
      if (m.status.disabled) c.disabled += 1
    }
    return c
  }, [models, filterQuery])

  const apply = (id: CommandId, combo: string, mode: 'replace' | 'add'): void => {
    const r = commitCandidate(id, combo, mode)
    setErrors((prev) => ({ ...prev, [id]: r.ok ? undefined : r.error }))
  }
  const write = (id: CommandId, bindings: readonly string[] | null): void => {
    setKeybindingOverride(id, bindings)
    setErrors((prev) => ({ ...prev, [id]: undefined }))
  }
  /** Per-chip ×. A plain list write through `write`, deliberately NOT through `commitCandidate`:
   *  taking a chord away cannot CREATE a conflict, so there is no candidate to gate — and routing
   *  it through the gate would let an unrelated pre-existing refusal block a removal that is
   *  always safe. The index is into `effectiveBindings`, which is the same order `commandKeysFor`
   *  renders the chips in. */
  const removeBinding = (id: CommandId, index: number): void => {
    write(
      id,
      effectiveBindings(id).filter((_, i) => i !== index)
    )
  }

  // What is on screen, decided before render because the group wrappers need the answer: a group
  // renders only when the GLOBAL query keeps it (`groupVisible` — a heading must never outlive
  // its rows) AND at least one of its rows survives the local query, the status filter and that
  // same global query. An empty wrapper is not invisible here: the shell's body is
  // `divide-y [&>*]:py-5`, so it draws a padded strip with a divider over nothing.
  const localVisible = (m: RowModel): boolean =>
    matchesShortcutQuery(m.def, m.keywords, m.chords, filterQuery) &&
    rowPassesStatus(m.status, statusFilter)
  const visibleGroups = groups.flatMap(([group, defs]) => {
    if (!groupVisible(query, group, defs)) return []
    const rows = defs.map((d) => modelById.get(d.id)!).filter(localVisible)
    // The global leg is asked here only to COUNT; `SearchableRow` below is what actually mounts
    // or drops the row (and with it its recorder — see ShortcutRecorderButton's release note).
    if (!rows.some((m) => matchesQuery(query, m.entry))) return []
    return [{ group, rows }]
  })

  const renderRow = (m: RowModel): React.JSX.Element => {
    const { def, chords, status } = m
    const single = SINGLE_BINDING_COMMANDS.has(def.id)
    const bound = chords.length > 0
    const note = NOTES[def.id]
    const error = errors[def.id]
    return (
      <SearchableRow key={def.id} {...m.entry}>
        <div
          data-command={def.id}
          className="group/row -mx-2 flex items-start justify-between gap-4 rounded-lg px-2 py-2 transition-colors hover:bg-fill-weak/60"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text">{def.title}</span>
              {status.modified ? (
                <span
                  data-badge="modified"
                  className={`${BADGE} bg-[color:var(--accent)]/15 text-[color:var(--accent)]`}
                >
                  Modified
                </span>
              ) : null}
              {def.scope === 'terminal' ? (
                <span data-badge="terminal" className={`${BADGE} bg-fill-weak text-muted`}>
                  Terminal
                </span>
              ) : null}
            </div>
            {note ? <p className="mt-1 text-[12px] leading-relaxed text-muted">{note}</p> : null}
            {error ? (
              <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--warn)]">{error}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {bound ? (
              <Chips
                chords={chords}
                limit={single ? 1 : undefined}
                title={def.title}
                onRemove={
                  chords.length > 1 && !single ? (i) => removeBinding(def.id, i) : undefined
                }
              />
            ) : status.disabled ? (
              <span className={`${BADGE} bg-fill-weak text-muted`}>Disabled</span>
            ) : (
              <span className="text-[13px] text-muted">—</span>
            )}
            {/* Hidden until the row is hovered so a 21-row list reads as chords, not as a wall of
                buttons — `focus-within` is the keyboard user's door to the same controls. */}
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
              {/* Tooltips say what the glyphs cannot: Record REPLACES the current shortcut,
                  Add records ANOTHER one beside it. Native `title` is not used here — it takes
                  the OS's ~1.5s delay and reads as no tooltip at all. */}
              <ShortcutRecorderButton
                commandId={def.id}
                appearance="icon"
                idleLabel={bound ? 'Record' : 'Record shortcut'}
                label={bound ? `Record ${def.title}` : `Record shortcut for ${def.title}`}
                tooltip={bound ? 'Replace shortcut' : 'Record a shortcut'}
                onCommit={(combo) => apply(def.id, combo, 'replace')}
              />
              {bound && !single ? (
                <ShortcutRecorderButton
                  commandId={def.id}
                  appearance="icon"
                  idleLabel="Add"
                  label={`Add a shortcut to ${def.title}`}
                  tooltip="Add another shortcut"
                  // Record sits immediately to its left in the same label-less cluster; the
                  // glyph is the only thing telling the two apart.
                  idleIcon={<IconPlusSmall />}
                  onCommit={(combo) => apply(def.id, combo, 'add')}
                />
              ) : null}
              {bound ? (
                <Tooltip label="Disable shortcut">
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Disable ${def.title}`}
                    onClick={() => write(def.id, [])}
                  >
                    <IconDisableSlash />
                  </button>
                </Tooltip>
              ) : null}
              {status.modified ? (
                <Tooltip label="Reset to default">
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    aria-label={`Reset ${def.title}`}
                    onClick={() => write(def.id, null)}
                  >
                    <IconResetArrow />
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>
        </div>
      </SearchableRow>
    )
  }

  return (
    <SettingsSection
      id="shortcuts"
      title="Keyboard Shortcuts"
      // The one remaining limitation is the application MENU's, not macOS's: its accelerators are
      // handled above the page on every platform. While a recorder is armed main now suspends the
      // items in `menuItemIdsToSuspend` (Minimize, Toggle Kanban Board, Settings, off-mac Close),
      // so those chords reach the recorder — but RELOAD is deliberately never suspended, because it
      // is the crash-recovery lever. See `src/main/keydown-intercept.ts`.
      // The residual clause is the KNOWN GAP `menuItemIdsToSuspend` documents: one list drives
      // both stand-downs, so the always-on app roles are deliberately left unsuspended and still
      // act while recording. The ruling stands; the user is simply told.
      description="Remap any command. Overrides are stored in settings.json under `keybindings`; Disable turns a command's shortcut off, Reset restores its default. Reload (⌘R / ⌘⇧R) cannot be recorded — it always stays with the app; the system-level chords the menu keeps — ⌘Q (Quit), ⌘H (Hide) and the developer roles — also act while recording, so don't try to bind them."
      isActive={isActive}
      searchEntries={entries}
    >
      <SearchableRow {...POLICY_ROW}>
        <div data-setting="terminal-shortcut-policy">
          <FieldRow
            label={POLICY_LABEL}
            description={POLICY_DESCRIPTION}
            control={
              <SegmentedPill<TerminalShortcutPolicy>
                value={policy}
                ariaLabel={POLICY_LABEL}
                options={[
                  { value: 'app-first', label: 'App shortcuts first' },
                  { value: 'terminal-first', label: 'Terminal first' }
                ]}
                onChange={(v) => update({ terminalShortcutPolicy: v })}
              />
            }
          />
        </div>
      </SearchableRow>

      <SearchableRow {...RAIL_ROW}>
        <div className="flex items-center justify-between gap-4">
          <div className="relative">
            {/* The sidebar's magnifier, verbatim — one search affordance, one look. */}
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="6" cy="6" r="4" />
              <path d="M9.2 9.2 12 12" />
            </svg>
            <Input
              className="h-8 w-[220px] pl-8"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filter shortcuts"
              aria-label="Filter shortcuts"
            />
          </div>
          <SegmentedPill<ShortcutStatusFilter>
            value={statusFilter}
            ariaLabel="Filter shortcuts by status"
            options={[
              { value: 'all', label: `All ${counts.all}` },
              { value: 'modified', label: `Modified ${counts.modified}` },
              { value: 'unassigned', label: `Unassigned ${counts.unassigned}` },
              { value: 'disabled', label: `Disabled ${counts.disabled}` }
            ]}
            onChange={setStatusFilter}
          />
        </div>
      </SearchableRow>

      {/* One wrapper per group, so the shell's `divide-y` separates GROUPS rather than every
          single row — 21 dividers is a table, not a list. */}
      {visibleGroups.map(({ group, rows }) => (
        <div key={group} className="space-y-1">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{group}</h3>
          {rows.map(renderRow)}
        </div>
      ))}

      {/* The sentence is ABOUT the rail, so it rides the rail's OWN search entry and can never
          outlive the control it explains. A global settings query can keep this section for the
          policy row alone ('policy', 'shell', 'tui', 'minimize' appear in no command title, id,
          group or note) — and answering that with "No shortcuts match." would describe a filter
          that is not on screen, in a section showing exactly what was asked for. */}
      <SearchableRow {...RAIL_ROW}>
        {visibleGroups.length === 0 ? (
          <p className="text-[13px] text-muted">No shortcuts match.</p>
        ) : null}
      </SearchableRow>
    </SettingsSection>
  )
}
