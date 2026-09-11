import {
  decideControlConfirm,
  sanitizeControlConfirmWaivers,
  type ControlConfirmDecision,
  type ControlConfirmWaivers
} from '@shared/control-confirm'
import { resolvePermissionModeWithSource } from '@shared/agents/config'

import { useProjects } from './projects'
import { useSettings } from './settings'
import { sessionWaivedVerbs } from './controlConfirm'

/**
 * Binds the pure `decideControlConfirm` to the live stores — the canvas-control confirm's
 * counterpart to `activePermissionMode`, and in its own module for the same reason that one is:
 * `projects.ts` imports `workspace.ts`, so a store that imports the projects store cannot live
 * anywhere those two can reach.
 *
 * The permission-mode half is where the git-shared-file trap is closed, and BOTH locks are applied
 * here: the machine-local `bypassMode` opt-in comes out of `settings.json`, and
 * `resolvePermissionModeWithSource` reports whether the resolved mode was the user's own GLOBAL
 * choice or an override that arrived in `.nodeterm/project.json` — which travels to everyone who
 * clones the repo. Only `'global'` can waive anything.
 *
 * **The version gate is deliberately NOT applied.** `gatePermissionMode` exists to degrade `auto`
 * to a bare command line for an old Claude CLI; it never touches `bypassPermissions`, and asking
 * it here would tie a security decision to a `claude --version` probe on a canvas whose agent may
 * not even be claude.
 */
export function controlConfirmDecision(verb: string): ControlConfirmDecision {
  const { settings } = useSettings.getState()
  const { getProject, activeProjectId } = useProjects.getState()
  const { mode, source } = resolvePermissionModeWithSource(getProject(activeProjectId), settings)
  return decideControlConfirm({
    verb,
    sessionWaived: sessionWaivedVerbs(),
    persisted: activeControlConfirmWaivers(),
    permissionMode: mode,
    permissionModeSource: source
  })
}

/** The sanitized persisted waivers. `settings.json` is hand-editable, so this is the ONE read. */
export function activeControlConfirmWaivers(): ControlConfirmWaivers {
  return sanitizeControlConfirmWaivers(useSettings.getState().settings.controlConfirmWaivers)
}
