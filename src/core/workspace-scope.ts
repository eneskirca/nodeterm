import type { WorkspaceIndexV3 } from './workspace-files'

/**
 * Which projects a `workspace:save` may WRITE — the invariant that makes pop-out windows safe.
 *
 * Every renderer saves the WHOLE assembled workspace (`toWorkspace()`), and a pop-out window is a
 * second full renderer. Without a scope the two windows would take turns writing each other's
 * projects from their own stale copies: the main window edits A and saves; the pop-out (holding
 * the A it loaded ten minutes ago) autosaves its project B, and its copy of A — which differs from
 * what is on disk — goes straight back over the main window's write. `sameProjectContent` skips
 * only an UNCHANGED candidate, and a stale one is by definition changed.
 *
 * So a save carries the sender's scope, decided by the shell from the window that sent it
 * (`saveScopeFor` in main/popout-windows.ts), and the store keeps its own previous knowledge for
 * everything outside it:
 *   - `main`   owns every project EXCEPT the popped-out ones (the main window);
 *   - `popout` owns exactly one project (a pop-out window).
 * `undefined` (no shell resolver — the Server Edition, tests) is the unscoped save, byte-identical
 * to what it always was.
 */
export type SaveScope =
  | { kind: 'main'; detached: readonly string[] }
  | { kind: 'popout'; projectId: string }

export function ownsProject(scope: SaveScope | undefined, projectId: string): boolean {
  if (!scope) return true
  if (scope.kind === 'popout') return scope.projectId === projectId
  return !scope.detached.includes(projectId)
}

/**
 * Merge the index a scoped save built (`incoming`, from the sender's workspace) with the index the
 * store last wrote or loaded (`previous`), so that the sender can change ONLY what it owns:
 *
 *   - an entry the sender owns is taken from `incoming` (new, changed or deleted by the sender);
 *   - an entry the sender does NOT own keeps the store's previous entry, verbatim — a sender cannot
 *     move, rename, reorder-into-oblivion or delete a project another window is editing, and it
 *     cannot introduce one either (an out-of-scope entry with no previous counterpart is dropped:
 *     it is a stale copy of something the owner has since removed, or a project the sender has no
 *     business creating);
 *   - a previous out-of-scope entry the sender's workspace does not even list is kept, at the end
 *     (a pop-out's workspace is a one-project slice; main's is complete, so this leg is a backstop).
 *
 * For a `popout` scope the previous ORDER and the previous `activeProjectId` stand as well: the
 * pop-out is not the window whose tab order or "reopen on this project" preference this file
 * records. `previous === null` — a store that has never read or written an index — cannot happen
 * on the pop-out path (main always saves before it opens one), but the fallback is the honest
 * one: only what the sender owns is written.
 */
export function scopeIndex(
  previous: WorkspaceIndexV3 | null,
  incoming: WorkspaceIndexV3,
  scope: SaveScope
): WorkspaceIndexV3 {
  const prevById = new Map((previous?.entries ?? []).map((e) => [e.id, e] as const))
  if (scope.kind === 'popout') {
    const own = incoming.entries.find((e) => e.id === scope.projectId)
    if (!previous) return { ...incoming, entries: own ? [own] : [] }
    return {
      ...previous,
      // The owned entry replaced IN PLACE; a pop-out whose project vanished from the previous index
      // (deleted from the main window while the pop-out was open — refused there, but a hand-edit
      // could do it) may not resurrect it.
      entries: previous.entries.map((e) => (e.id === scope.projectId && own ? own : e))
    }
  }
  const seen = new Set<string>()
  const entries: WorkspaceIndexV3['entries'] = []
  for (const e of incoming.entries) {
    seen.add(e.id)
    if (ownsProject(scope, e.id)) {
      entries.push(e)
      continue
    }
    const prev = prevById.get(e.id)
    if (prev) entries.push(prev)
  }
  for (const e of previous?.entries ?? []) {
    if (seen.has(e.id) || ownsProject(scope, e.id)) continue
    entries.push(e)
  }
  return { ...incoming, entries }
}
