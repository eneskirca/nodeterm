/**
 * The free-tier open-project limit (docs/superpowers/specs/2026-10-29-free-tier-project-limit-design.md).
 */

/**
 * How many of `projects` are OPEN — the one definition, shared by the open-project report and the
 * gate (spec §3). A project is open when it is in the workspace, not `closed` (a "Recently closed"
 * entry) and not a relay tab (`remote` — a live connection to another machine's project, never a
 * workspace on this disk). SSH projects, cwd-less canvases and unavailable placeholders all count:
 * each is a tab on the user's screen.
 */
export function countOpenProjects(projects: readonly { closed?: boolean; remote?: boolean }[]): number {
  let open = 0
  for (const p of projects) if (!p.closed && !p.remote) open++
  return open
}
