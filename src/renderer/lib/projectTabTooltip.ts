// What a project tab says when the pointer rests on it: where the project lives.
//
// It used to be the tab's native `title`, drawn by the OS on its own delay and in its own style.
// The tab now shows it in the app's own tooltip bubble (`useTooltip`), and this is the text, kept
// pure so every branch is testable without mounting the bar.

import type { Project } from '@shared/types'
import type { SessionSource } from '../session/session'

type TabProject = Pick<Project, 'name' | 'cwd' | 'ssh' | 'relaySsh' | 'unavailable'>

/**
 * The tab's location tooltip, or null when there is nothing to say (a cwd-less canvas has no
 * location). An SSH project names its host, because the same path means a different folder there.
 * An unavailable tab says why it cannot be opened instead, since that is what a click would hit,
 * and so does a ghosted tab whose project is open in its own window (`detached`): a click there
 * brings that window forward.
 */
export function projectTabTooltip(p: TabProject, source: SessionSource, detached = false): string | null {
  if (detached) return `${p.name} is open in its own window — click to bring it forward`
  if (p.unavailable) {
    return source === 'local'
      ? `${p.cwd ?? 'project'} is unavailable (folder missing or unreachable)`
      : `${p.name} disconnected, click to reconnect`
  }
  if (p.ssh) return `${p.ssh.server.user}@${p.ssh.server.host}:${p.ssh.remoteCwd}`
  if (p.relaySsh) return `${p.relaySsh.user}@${p.relaySsh.host}:${p.relaySsh.remoteCwd}`
  return p.cwd || null
}
