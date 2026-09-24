/**
 * The single declarative source of truth for the "add node" content items that appear in the
 * creation menus that can offer every node kind: the canvas pane right-click, the
 * sessions-sidebar project-header "+", and the bottom Dock "+".
 *
 * **The kanban column's "+ New session" is deliberately NOT one of them** — this doc used to list
 * it as a fourth consumer, which was never true and is worth stating so nobody "fixes" it by
 * wiring it up. Its `KanbanCreateChoice` is a closed union of terminal / browser / sticky / agent
 * because those are the only kinds `canvas/toKanbanSession.ts` turns INTO A CARD; feeding it this
 * list would offer kinds (a trigger, a worktree, an editor) that create a node the board can never
 * show. A surface that can only render part of the list is a different list, not a lagging copy.
 *
 * The duplication this kills: each of those surfaces used to hand-maintain its own list of
 * which node kinds you can add, so they drifted out of parity (the pane menu had "New browser" but
 * the Dock and the sidebar "+" did not, etc.). Now they all derive their CONTENT items from
 * {@link CONTENT_ADD_ITEMS}, filtered by project context (cwd / SSH). Agent entries are layered on
 * by each surface from its own source — the ContextMenu-based menus already share
 * `agentCreationItems()`, and the Dock's agent-account hover flyouts are intentionally bespoke UX —
 * so this spec owns the CONTENT list only, not the agents.
 *
 * Three render adapters map the same {@link AddItem} list to the menu worlds:
 *  - {@link buildGroupedAddMenu} → the GROUPED tree the two `ContextMenu` surfaces show (see the
 *    grouping section at the bottom of this file for why).
 *  - {@link contentAddItemsToMenuItems} → the {@link MenuItem} type the `ContextMenu` component
 *    consumes (pane menu, project-header "+").
 *  - {@link contentAddItemsToDockRows} → the Dock's custom `<button>` JSX.
 *
 * The handlers are passed in (not imported) so this module stays pure, renderer-side, and testable.
 */
import type { ReactNode } from 'react'
import type { MenuItem } from '../components/ContextMenu'
import { ACCOUNT_CAPABLE_AGENT_IDS } from '@shared/agents/account-binding'
import {
  IconAgent,
  IconBranch,
  IconCanvasView,
  IconDino,
  IconEditor,
  IconExplorer,
  IconGroup,
  IconNote,
  IconRemote,
  IconTerminal,
  IconWeb,
  IconBellFilled
} from '../components/icons'

/** A flow-space position; `undefined` means "wherever the surface's default is". */
export type AddPos = { x: number; y: number } | undefined

/**
 * Every addable CONTENT node kind (agents are handled separately — see the module doc). The
 * `kind` discriminator is the only required field; conditionals (`requiresCwd`, `disabledOnSsh`)
 * are checked by the adapters against the project context.
 */
export type AddItem =
  | { kind: 'terminal' }
  | { kind: 'remote' }
  | { kind: 'browser' }
  | { kind: 'web' }
  | { kind: 'sticky' }
  | { kind: 'files' } // requiresCwd
  | { kind: 'dino' }
  | { kind: 'trigger' }
  | { kind: 'open-file' }
  | { kind: 'new-file' } // requiresCwd
  | { kind: 'spawn-team' }
  | { kind: 'worktree' } // disabledOnSsh

/**
 * The canonical content list, in the order the pane menu established (the most-complete surface):
 * sessions first (terminal, remote), then content nodes (browser, web, sticky, dino, open/new
 * file), then the worktree affordance. Separators between these groups are the CALLER's concern —
 * a surface may want to inject agents between terminal and remote, so the spec returns flat items
 * and the caller places separators around the agent block it layers in.
 */
export const CONTENT_ADD_ITEMS: readonly AddItem[] = [
  { kind: 'terminal' },
  { kind: 'remote' },
  { kind: 'browser' },
  { kind: 'web' },
  { kind: 'sticky' },
  { kind: 'files' },
  { kind: 'dino' },
  { kind: 'trigger' },
  { kind: 'open-file' },
  { kind: 'new-file' },
  { kind: 'spawn-team' },
  { kind: 'worktree' }
] as const

/** Project context that gates which items show / are disabled. */
export interface AddCtx {
  /** Whether the active project has a cwd (local folder or SSH remoteCwd). Gates "New file…". */
  hasCwd: boolean
  /** Whether the active project is an SSH project. Disables "New worktree…". */
  isSshProject: boolean
}

/**
 * The bag of creation callbacks every surface already has. Passed in (not imported) so the spec
 * stays free of Canvas-side state. Each takes the cursor position the menu was opened at, so a node
 * lands where the user clicked rather than at a default.
 *
 * `remote` takes a SCREEN position (the picker opens at the cursor in screen coords, not flow
 * coords) — the caller is responsible for the coordinate space, matching today's pane menu.
 */
export interface AddHandlers {
  terminal: (at?: AddPos) => void
  remote: (screenPos: { x: number; y: number }) => void
  browser: (at?: AddPos) => void
  web: (at?: AddPos) => void
  sticky: (at?: AddPos) => void
  files: (at?: AddPos) => void
  dino: (at?: AddPos) => void
  /** Adds a trigger node (issue #493) — a canvas-owned schedule that fires into another node. */
  trigger: (at?: AddPos) => void
  openFile: (at?: AddPos) => void
  newFile: (at?: AddPos) => void
  /** Opens the Spawn-a-team dialog (issue #78); `at` is where the conductor node will land. */
  spawnTeam: (at?: AddPos) => void
  worktree: (at?: AddPos) => void
}

/** The SSH worktree hint shown on the disabled row — kept here so every surface shows the same one. */
export const WORKTREE_SSH_HINT = 'Not supported in SSH projects yet'

/**
 * The two rows that need a project FOLDER, shown disabled with their reason rather than hidden.
 *
 * A cwd-less project (the "New project" card on the welcome screen) is a supported, persisted
 * canvas — its nodes live inline in `workspace.json` — so the folder-shaped features around it must
 * degrade EXPLICITLY, the same rule the SSH worktree row already follows and the same one the
 * Explorer, Source Control and Project Settings panels already state in words. "New file…" simply
 * vanished before, which teaches nothing: the row was gone and so was the reason, and the folder
 * that would fix it is one menu away.
 */
export const NEW_FILE_NO_CWD_HINT = 'This project has no folder — set one first (tab ⌄ → “Set folder…”)'
export const WORKTREE_NO_CWD_HINT = NEW_FILE_NO_CWD_HINT
/** Same reason, same fix — a file manager has nothing to list without a project folder. */
export const FILES_NO_CWD_HINT = NEW_FILE_NO_CWD_HINT

/**
 * Map the canonical content list to {@link MenuItem}s for the `ContextMenu` component.
 *
 * @param at          the flow-space position the menu was opened at (passed to each handler), or
 *                    `undefined` for surfaces with no cursor (the Dock).
 * @param screenPos   the SCREEN position, only for the `remote` picker (which opens at the cursor
 *                    in screen coords). When `at` is undefined, falls back to the window center.
 */
export function contentAddItemsToMenuItems(
  items: readonly AddItem[],
  handlers: AddHandlers,
  ctx: AddCtx,
  at?: AddPos,
  screenPos?: { x: number; y: number }
): MenuItem[] {
  // The remote picker opens at the cursor in SCREEN coords. Callers with a cursor pass `screenPos`;
  // the fallback (no cursor — no current caller hits this) is the origin, which the picker clamps
  // on-screen anyway. Avoids touching `window` here so the function is testable in a node env.
  const remotePos = screenPos ?? { x: 0, y: 0 }
  const out: MenuItem[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'terminal':
        out.push({ label: 'New terminal', icon: <IconTerminal />, onClick: () => handlers.terminal(at) })
        break
      case 'remote':
        out.push({ label: 'New remote…', icon: <IconTerminal />, onClick: () => handlers.remote(remotePos) })
        break
      case 'browser':
        out.push({ label: 'New browser', icon: <IconRemote />, onClick: () => handlers.browser(at) })
        break
      case 'web':
        out.push({ label: 'New web view…', icon: <IconWeb />, onClick: () => handlers.web(at) })
        break
      case 'sticky':
        out.push({ label: 'New sticky note', icon: <IconNote />, onClick: () => handlers.sticky(at) })
        break
      case 'files':
        // A file manager needs a directory to root itself in. This row used to be HIDDEN on a
        // cwd-less canvas, reasoning that it was "the same as New file…" — and main has since
        // reversed exactly that rule (`NEW_FILE_NO_CWD_HINT`): a cwd-less project is a supported,
        // persisted canvas, so a folder-shaped row degrades EXPLICITLY rather than vanishing,
        // because a row that is gone takes its reason with it and the fix is one menu away.
        out.push({
          label: 'New file manager',
          icon: <IconExplorer />,
          disabled: !ctx.hasCwd,
          hint: ctx.hasCwd ? undefined : FILES_NO_CWD_HINT,
          onClick: () => handlers.files(at)
        })
        break
      case 'dino':
        out.push({ label: 'New dino game', icon: <IconDino />, onClick: () => handlers.dino(at) })
        break
      case 'trigger':
        out.push({ label: 'New trigger…', icon: <IconBellFilled />, onClick: () => handlers.trigger(at) })
        break
      case 'open-file':
        out.push({ label: 'Open file…', icon: <IconEditor />, onClick: () => void handlers.openFile(at) })
        break
      case 'new-file':
        // "New file…" creates UNDER the project folder, so a cwd-less project cannot run it — the
        // row stays, disabled, and names the reason (NEW_FILE_NO_CWD_HINT).
        out.push({
          label: 'New file…',
          icon: <IconEditor />,
          disabled: !ctx.hasCwd,
          hint: ctx.hasCwd ? undefined : NEW_FILE_NO_CWD_HINT,
          onClick: () => void handlers.newFile(at)
        })
        break
      case 'spawn-team':
        out.push({ label: 'Spawn a team…', icon: <IconGroup />, onClick: () => handlers.spawnTeam(at) })
        break
      case 'worktree':
        out.push({
          label: 'New worktree…',
          icon: <IconBranch />,
          disabled: ctx.isSshProject || !ctx.hasCwd,
          hint: ctx.isSshProject
            ? WORKTREE_SSH_HINT
            : ctx.hasCwd
              ? undefined
              : WORKTREE_NO_CWD_HINT,
          onClick: () => handlers.worktree(at)
        })
        break
    }
  }
  return out
}

/** A content row for the Dock (the JSX renderer in Dock.tsx maps over these). */
export interface DockContentRow {
  kind: AddItem['kind']
  label: string
  icon: ReactNode
  onClick: () => void
  disabled?: boolean
  hint?: string
}

/**
 * Map the canonical content list to the Dock's custom `<button>` rows. The Dock keeps its own
 * agent-account hover-flyout JSX (bespoke UX with no `ContextMenu` equivalent); this only produces
 * the CONTENT rows, in the same order as every other surface, so the Dock and the pane menu can no
 * longer drift on which kinds are addable.
 *
 * The Dock has no cursor position, so every handler is called with `undefined` (the Dock's default
 * placement). `remote` is omitted from the Dock today via the `items` filter the caller passes —
 * the Dock surfaces "New Remote Connection" (a different flow) rather than the remote picker.
 */
export function contentAddItemsToDockRows(
  items: readonly AddItem[],
  handlers: AddHandlers,
  ctx: AddCtx
): DockContentRow[] {
  const out: DockContentRow[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'terminal':
        // The Dock renders its OWN "Terminal" button (agents have bespoke account flyouts beside
        // it, so the whole session cluster is Dock-local — see Dock.tsx). Emitting a terminal row
        // here too produced a duplicate "Terminal" entry. Skip, exactly like `remote` below.
        break
      case 'remote':
        // The Dock uses its own "New Remote Connection" affordance, not the remote picker. Skip
        // here so the Dock's content rows don't duplicate it.
        break
      case 'browser':
        out.push({ kind: 'browser', label: 'Browser', icon: <IconRemote />, onClick: () => handlers.browser() })
        break
      case 'web':
        out.push({ kind: 'web', label: 'Web View', icon: <IconWeb />, onClick: () => handlers.web() })
        break
      case 'sticky':
        out.push({ kind: 'sticky', label: 'Sticky Note', icon: <IconNote />, onClick: () => handlers.sticky() })
        break
      case 'files':
        out.push({
          kind: 'files',
          label: 'File Manager',
          icon: <IconExplorer />,
          disabled: !ctx.hasCwd,
          hint: ctx.hasCwd ? undefined : FILES_NO_CWD_HINT,
          onClick: () => handlers.files()
        })
        break
      case 'dino':
        out.push({ kind: 'dino', label: 'Dino Game', icon: <IconDino />, onClick: () => handlers.dino() })
        break
      case 'trigger':
        out.push({ kind: 'trigger', label: 'Trigger', icon: <IconBellFilled />, onClick: () => handlers.trigger() })
        break
      case 'open-file':
        out.push({ kind: 'open-file', label: 'Open file…', icon: <IconEditor />, onClick: () => void handlers.openFile() })
        break
      case 'new-file':
        out.push({
          kind: 'new-file',
          label: 'New file…',
          icon: <IconEditor />,
          disabled: !ctx.hasCwd,
          hint: ctx.hasCwd ? undefined : NEW_FILE_NO_CWD_HINT,
          onClick: () => void handlers.newFile()
        })
        break
      case 'spawn-team':
        out.push({ kind: 'spawn-team', label: 'Spawn a team…', icon: <IconGroup />, onClick: () => handlers.spawnTeam() })
        break
      case 'worktree':
        out.push({
          kind: 'worktree',
          label: 'Worktree…',
          icon: <IconBranch />,
          disabled: ctx.isSshProject || !ctx.hasCwd,
          hint: ctx.isSshProject
            ? WORKTREE_SSH_HINT
            : ctx.hasCwd
              ? undefined
              : WORKTREE_NO_CWD_HINT,
          onClick: () => handlers.worktree()
        })
        break
    }
  }
  return out
}

// ─── Grouping (the pane right-click and the sidebar "+") ─────────────────────────────────────
//
// Both of those surfaces used to render the whole flat list — 18 "New …" rows before the four
// canvas actions — which is a list you read rather than a menu you aim at. The ⌘K palette already
// makes every one of these searchable, and the keybinding registry already carries a remappable
// command per agent and per node kind (`node.new*`, #365), so this menu does not have to be
// EXHAUSTIVE; it has to be FAST. Grouping trades one hover for a target you can hit without
// reading, and leaves the exhaustive paths exactly where they already were.
//
// **Two levels here is a choice, not a cap.** `ContextMenu` used to drop a third level silently
// (`if (child.type === 'submenu') return null`), and this shape was built around that. It now
// renders any depth (the node menu's "Transfer conversation ▸ <agent> ▸ <model>" needs three), but
// the rule below is kept: an agent row that is ALREADY a submenu (Claude's and Codex's account
// pickers) stays at the first level, so picking an account never costs two hovers.

/** Which section of the grouped menu a content kind belongs to. `top` = stays a first-level row. */
export type AddGroupId = 'top' | 'view' | 'files' | 'orchestrate'

/**
 * The routing table, as a total `Record` over the kind union **on purpose**: a new `AddItem` kind
 * is a COMPILE ERROR here until somebody decides where it belongs. The alternative (a lookup with
 * a default) would silently drop a new kind into one bucket forever, which is the drift this
 * module exists to prevent.
 *
 * `terminal` and `remote` stay at the top because they are the two fastest paths to a session, and
 * because `remote` is not an agent — the one entry point to an SSH session must not be buried
 * under a menu named "New agent", where nobody would look for it.
 */
export const ADD_ITEM_GROUP: Record<AddItem['kind'], AddGroupId> = {
  terminal: 'top',
  remote: 'top',
  browser: 'view',
  web: 'view',
  sticky: 'view',
  files: 'view',
  dino: 'view',
  'open-file': 'files',
  'new-file': 'files',
  'spawn-team': 'orchestrate',
  trigger: 'orchestrate',
  worktree: 'orchestrate'
}

/** Submenu labels, kept here so every surface names the same group the same way. */
export const AGENT_GROUP_LABEL = 'New agent'
export const ADD_GROUP_LABEL: Record<Exclude<AddGroupId, 'top'>, string> = {
  view: 'New view',
  files: 'Files',
  orchestrate: 'Orchestrate'
}

/**
 * One "New <agent>" row plus the agent it belongs to. The surfaces build the ROW (accounts,
 * disabled reasons and custom agents all live in Canvas); this module only needs the id to decide
 * whether the row may be nested.
 */
export interface AgentAddEntry {
  agentId: string
  item: MenuItem
}

/**
 * Whether an agent row must stay at the FIRST level. Two independent reasons:
 *
 *  1. **It is already a submenu.** Nesting it would put the account picker two hovers deep, for
 *     exactly the users who have accounts. This half is derived from the row itself, so an agent
 *     that grows a picker later is kept at the top on the day it does.
 *  2. **It CAN own a managed account** (`ACCOUNT_CAPABLE_AGENT_IDS`). Rule 1 alone would move a
 *     row in and out of the submenu as the user adds or removes accounts — a menu that rearranges
 *     itself is a menu you cannot learn. Pinning the account-capable agents keeps the shape stable
 *     whether or not an account exists yet.
 *
 * Both halves are DERIVED — no agent id is spelled here — so a new builtin agent joins the
 * submenu by itself, and one that gains managed accounts is promoted by itself.
 */
export function isPinnedAgentEntry(entry: AgentAddEntry): boolean {
  if (entry.item.type === 'submenu') return true
  return ACCOUNT_CAPABLE_AGENT_IDS.includes(entry.agentId)
}

/**
 * Pinned agent rows, then the rest behind one `New agent ▸`. An empty tail emits NO submenu — an
 * empty flyout is a dead target.
 */
export function agentEntriesToMenuItems(agents: readonly AgentAddEntry[]): MenuItem[] {
  const pinned = agents.filter(isPinnedAgentEntry).map((e) => e.item)
  const rest = agents.filter((e) => !isPinnedAgentEntry(e)).map((e) => e.item)
  return [
    ...pinned,
    ...(rest.length > 0
      ? [
          {
            type: 'submenu',
            label: AGENT_GROUP_LABEL,
            icon: <IconAgent />,
            children: rest
          } as MenuItem
        ]
      : [])
  ]
}

const GROUP_ICON: Record<Exclude<AddGroupId, 'top'>, ReactNode> = {
  view: <IconCanvasView />,
  files: <IconEditor />,
  orchestrate: <IconGroup />
}

/**
 * The grouped "add" menu shared by the canvas pane right-click and the sessions-sidebar "+".
 *
 * Rows come from {@link contentAddItemsToMenuItems} — the same per-kind builder the flat list and
 * the Dock use — so a row's label, icon, handler and **disabled reason** are written exactly once.
 * That is what keeps "New worktree…" greyed with `WORKTREE_SSH_HINT` inside its submenu instead of
 * quietly losing the explanation on the way in: a `hint` on a leaf renders in a flyout the same as
 * at the top level.
 *
 * Order is the canonical one: top rows, then agents, then view / files / orchestrate. A group
 * whose rows are all filtered out emits no submenu at all.
 */
export function buildGroupedAddMenu(
  items: readonly AddItem[],
  handlers: AddHandlers,
  ctx: AddCtx,
  agents: readonly AgentAddEntry[],
  at?: AddPos,
  screenPos?: { x: number; y: number }
): MenuItem[] {
  const top: MenuItem[] = []
  const buckets: Record<Exclude<AddGroupId, 'top'>, MenuItem[]> = {
    view: [],
    files: [],
    orchestrate: []
  }
  for (const item of items) {
    // Built one at a time through the SHARED mapper rather than re-implemented here: a second
    // copy of the per-kind rows is exactly how these surfaces drifted apart before this module.
    const [row] = contentAddItemsToMenuItems([item], handlers, ctx, at, screenPos)
    if (!row) continue
    const group = ADD_ITEM_GROUP[item.kind]
    if (group === 'top') top.push(row)
    else buckets[group].push(row)
  }
  const submenu = (id: Exclude<AddGroupId, 'top'>): MenuItem[] =>
    buckets[id].length > 0
      ? [
          {
            type: 'submenu',
            label: ADD_GROUP_LABEL[id],
            icon: GROUP_ICON[id],
            children: buckets[id]
          } as MenuItem
        ]
      : []
  return [
    ...top,
    ...agentEntriesToMenuItems(agents),
    ...submenu('view'),
    ...submenu('files'),
    ...submenu('orchestrate')
  ]
}
