/**
 * The single declarative source of truth for the "add node" content items that appear in every
 * creation menu: the canvas pane right-click, the sessions-sidebar project-header "+", the bottom
 * Dock "+", and the kanban column "+ New session".
 *
 * The duplication this kills: each of those four surfaces used to hand-maintain its own list of
 * which node kinds you can add, so they drifted out of parity (the pane menu had "New browser" but
 * the Dock and the sidebar "+" did not, etc.). Now they all derive their CONTENT items from
 * {@link CONTENT_ADD_ITEMS}, filtered by project context (cwd / SSH). Agent entries are layered on
 * by each surface from its own source — the ContextMenu-based menus already share
 * `agentCreationItems()`, and the Dock's agent-account hover flyouts are intentionally bespoke UX —
 * so this spec owns the CONTENT list only, not the agents.
 *
 * Two render adapters map the same {@link AddItem} list to the two menu worlds:
 *  - {@link contentAddItemsToMenuItems} → the {@link MenuItem} type the `ContextMenu` component
 *    consumes (pane menu, project-header "+").
 *  - {@link contentAddItemsToDockRows} → the Dock's custom `<button>` JSX.
 *
 * The handlers are passed in (not imported) so this module stays pure, renderer-side, and testable.
 */
import type { ReactNode } from 'react'
import type { MenuItem } from '../components/ContextMenu'
import {
  IconBranch,
  IconDino,
  IconEditor,
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
        // "New file…" needs a project folder to create into — hidden when the project has no cwd.
        if (ctx.hasCwd) {
          out.push({ label: 'New file…', icon: <IconEditor />, onClick: () => void handlers.newFile(at) })
        }
        break
      case 'spawn-team':
        out.push({ label: 'Spawn a team…', icon: <IconGroup />, onClick: () => handlers.spawnTeam(at) })
        break
      case 'worktree':
        out.push({
          label: 'New worktree…',
          icon: <IconBranch />,
          disabled: ctx.isSshProject,
          hint: ctx.isSshProject ? WORKTREE_SSH_HINT : undefined,
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
        if (ctx.hasCwd) {
          out.push({ kind: 'new-file', label: 'New file…', icon: <IconEditor />, onClick: () => void handlers.newFile() })
        }
        break
      case 'spawn-team':
        out.push({ kind: 'spawn-team', label: 'Spawn a team…', icon: <IconGroup />, onClick: () => handlers.spawnTeam() })
        break
      case 'worktree':
        out.push({
          kind: 'worktree',
          label: 'Worktree…',
          icon: <IconBranch />,
          disabled: ctx.isSshProject,
          hint: ctx.isSshProject ? WORKTREE_SSH_HINT : undefined,
          onClick: () => handlers.worktree()
        })
        break
    }
  }
  return out
}
