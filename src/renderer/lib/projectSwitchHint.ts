import { isClosedTeamTab } from './closedHistory'

/** What a project row in the command palette says beside "Switch to <name>", or null when the
 *  palette must not offer the project at all.
 *
 *  After "Share with team" the closed SSH project and the team's tab carry the same name, so a
 *  bare "project" hint showed two identical rows that did different things (reopen the SSH copy,
 *  or switch to the team tab). A closed team tab is omitted: its reopen is refused, and "Recently
 *  closed" does not list it either. An unavailable project is omitted as before: edits made there
 *  are dropped on save. */
export function projectSwitchHint(p: {
  closed?: boolean
  remote?: boolean
  unavailable?: boolean
  handedOffTo?: unknown
}): string | null {
  if (p.unavailable || isClosedTeamTab(p)) return null
  if (p.remote) return 'team project'
  if (p.closed) return p.handedOffTo ? 'closed · shared with a team' : 'closed project'
  return 'project'
}
