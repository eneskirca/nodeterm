/**
 * PURE. The open project one step from `activeId` in tab-strip order (= store array order, with
 * `closed` projects skipped because they have no tab), wrapping at both ends like a browser's
 * Ctrl+Tab. Null means "nowhere to go": fewer than two open projects — the caller then leaves
 * the key alone instead of claiming a chord it does nothing with.
 *
 * An `activeId` that is not an open tab (welcome screen, or the active project was just closed)
 * enters the strip from the matching end: forward lands on the first tab, backward on the last.
 */
export function adjacentProjectId(
  projects: readonly { id: string; closed?: boolean }[],
  activeId: string | null | undefined,
  dir: 1 | -1
): string | null {
  const open = projects.filter((p) => !p.closed)
  const at = open.findIndex((p) => p.id === activeId)
  if (at === -1) {
    if (open.length === 0) return null
    return (dir === 1 ? open[0] : open[open.length - 1]).id
  }
  if (open.length < 2) return null
  return open[(at + dir + open.length) % open.length].id
}
