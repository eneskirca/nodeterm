// Which rows of the node right-click menu and the terminal node header the user is allowed to
// hide (Settings → the visibility toggles), plus the predicate both call sites share.
//
// Hiding is stored as a HIDDEN list rather than a visible one: an empty array means everything
// shows, so existing users see no change and any row added in a later release appears by default
// instead of silently staying hidden.
//
// The inventories are the whole safety story. Destructive and recovery actions — Delete, Restart
// agent, Branch/Transfer conversation, the terminal Search button, Close — are simply not in them,
// and `isHidden` checks membership rather than trusting the saved list, so a stale or hand-edited
// settings.json can never take Delete off the menu.

export interface HideableRow {
  /** Stable id, persisted in settings — renaming one un-hides that row for existing users. */
  id: string
  /** User-facing label, shown in the Settings toggles. Matches the menu/header wording. */
  label: string
}

/** Hideable node right-click menu entries, in menu order. */
export const HIDEABLE_MENU_ITEMS: readonly HideableRow[] = [
  { id: 'group', label: 'Group node / Group selection' },
  { id: 'remove-from-group', label: 'Remove from group' },
  { id: 'colors', label: 'Colors' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'snap-zone', label: 'Snap to zone' },
  { id: 'collapse', label: 'Collapse / Expand' },
  { id: 'markdown-view', label: 'Markdown view' },
  { id: 'refresh-terminal', label: 'Refresh terminal' },
  { id: 'github-attach', label: 'Attach GitHub issue / PR' }
]

/** Hideable terminal node header buttons, in header order. */
export const HIDEABLE_HEADER_BUTTONS: readonly HideableRow[] = [
  { id: 'maximize', label: 'Maximize' },
  { id: 'refresh', label: 'Refresh' },
  { id: 'mic', label: 'Dictate' },
  { id: 'ai-name', label: 'Name with AI' },
  { id: 'comments', label: 'Comments' },
  { id: 'hide-fanout', label: 'Hide subagent/loop cards' },
  { id: 'tidy-fanout', label: 'Tidy subagent cards' }
]

/** Every id the user may hide — the guard that makes everything else unhideable. */
const HIDEABLE_IDS = new Set<string>(
  [...HIDEABLE_MENU_ITEMS, ...HIDEABLE_HEADER_BUTTONS].map((r) => r.id)
)

/**
 * True only when `id` is BOTH hideable and present in the saved list. Unknown ids in the list are
 * ignored, and an id outside the inventory stays visible no matter what the list says.
 */
export function isHidden(id: string, hidden: readonly string[]): boolean {
  return HIDEABLE_IDS.has(id) && hidden.includes(id)
}
