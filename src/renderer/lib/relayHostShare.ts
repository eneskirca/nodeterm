import type { Project } from '@shared/types'

/** One shareable project as shown in the host's project chooser. */
export interface HostShareOption {
  id: string
  name: string
}

/**
 * The list of projects a relay host may share, as `{id, name}[]`. Only OPEN (non-`closed`)
 * projects are shareable — a closed project isn't in the tab bar and has nothing to show a
 * joiner. The `activeProjectId` (when itself open) is hoisted to the front so it can be the
 * default selection. Pure; empty input yields an empty list.
 */
export function hostShareOptions(projects: Project[], activeProjectId: string): HostShareOption[] {
  const open = projects.filter((p) => !p.closed).map((p) => ({ id: p.id, name: p.name }))
  const activeIdx = open.findIndex((p) => p.id === activeProjectId)
  if (activeIdx <= 0) return open
  return [open[activeIdx], ...open.slice(0, activeIdx), ...open.slice(activeIdx + 1)]
}

/**
 * What a relay invite actually grants, in words — ONE sentence for both host surfaces (Settings →
 * Remote access and the Remote access dialog), so the two cannot drift apart.
 *
 * A SCOPED invite (a project is selected) is enforced host-side by core/relay/scoped-guest-policy.ts:
 * the joiner reaches that project's terminals, files, git and board, and none of the host's other
 * projects, settings or saved credentials. It is still consent to run commands: a terminal the joiner
 * opens is a shell on this machine as the host's user, and the sentence says so rather than implying
 * an OS sandbox. An UNSCOPED invite (nothing to scope to) is full access, and says that plainly.
 */
export function relayShareGrantCopy(sharedName: string | null, machine: string): string {
  if (!sharedName) {
    return `No project is selected, so the joiner gets full access to ${machine} as you — every project, and commands in any folder.`
  }
  return (
    `The joiner can open terminals and agents in ${sharedName}, and read and edit its files — ` +
    `running commands on ${machine} as you. The app keeps them out of your other projects, ` +
    `your settings and your saved credentials, but a terminal they open is still a shell on ${machine}.`
  )
}
