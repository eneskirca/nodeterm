import {
  resolveProjectSettings,
  type ProjectSettingsDoc,
  type ProjectSettingsSnapshot,
  type ResolvedProjectSetting
} from '../shared/project-settings'
import type { ProjectSecretDecl } from '../shared/project-secrets'
import type { ProjectConsumerFamily } from './project-setup-service'
import type { ProjectSetupTargetInfo } from './project-setup-runner-local'
import type { ProjectTrustStore } from './project-trust-store'
import { projectFamilyTrusted, projectTrustKeyFor } from './project-trust-verdict'

/**
 * What a project contributes to a session it owns: environment variables and the terminal program.
 * `PtyManager` consumes exactly this and nothing else (`setProjectSpawnOverrides`).
 *
 * Absent fields mean "the project has no opinion" — never "clear what was there". A spawn with no
 * overrides at all answers `null`, so the whole feature costs one skipped branch on every path that
 * has no project settings.
 */
export interface ProjectSpawnOverrides {
  /** LITERAL values only. `${env:VAR}` is NOT expanded here — that is a custom-agent feature
   *  (custom-agent-env.ts) and inheriting it would turn a git-shared settings.json into a read of
   *  this machine's process environment, laundered past a dialog that rendered the literal. The
   *  keys/values are already bounded and identifier-shaped by the Task 1 sanitizer. */
  env?: Record<string, string>
  /** Still validated at the spawn (`safeSessionProgram`) — see `PtyManager.spawnSession`. */
  shell?: string
  /**
   * The project's declared secrets (@shared/project-secrets) — DECLARATIONS, never values. Not
   * trust-gated here: a declaration does nothing by itself. A value is injected only when the
   * person authorized THIS exact declaration in the app (`ProjectSecretsService.spawnEnv` compares
   * it), and that authorization shows the commands — a stronger gate than a remembered hash.
   */
  secrets?: ProjectSecretDecl[]
}

export type ProjectSpawnOverridesReader = (
  projectId: string
) => Promise<ProjectSpawnOverrides | null>

export interface ProjectSpawnOverridesDeps {
  /** This shell's own settings resolution (e.g. `WorkspaceStore.readProjectSettings`). */
  readSettings(projectId: string): Promise<ProjectSettingsSnapshot | null>
  /**
   * The project's LOCATION, from this process's own workspace index (e.g.
   * `WorkspaceStore.projectTargetInfo`) — never from the renderer, and never derived from the
   * git-shared `project.json`. Required because trust is keyed by location, not project id.
   */
  targetInfo(projectId: string): ProjectSetupTargetInfo | null
  trust: Pick<ProjectTrustStore, 'isTrusted'>
  /**
   * Raise the consent dialog for a family whose SHARED value was just refused
   * (`ProjectSetupService.ensureFamilyTrusted`, single-flight per family+location). FIRE AND
   * FORGET: this spawn has already decided to go without the value — waiting on a human would
   * block a terminal for up to five minutes, and the answer arrives in time for the NEXT launch.
   * Optional so a shell with no consent surface still gets the local-value half.
   */
  requestTrust?(projectId: string, family: ProjectConsumerFamily): unknown
}

/** Shared-sourced values are the gated ones; a local value is this machine's own typing. */
function isShared<T>(r: ResolvedProjectSetting<T> | undefined): boolean {
  return r?.source === 'shared'
}

/**
 * The ONE reader both shells inject into `PtyManager` (main/index.ts + server/index.ts).
 *
 * Rules, in the order they matter:
 *  1. A LOCAL value is always consumed, with no trust question and no prompt — the user typed it
 *     into this machine's own overlay, which is the same reason `ProjectSetupService.run` never
 *     gates a local script.
 *  2. A SHARED value (git, or a remote host's disk) is consumed only while its family's
 *     shared-content hash is trusted at this LOCATION — the verdict computed by
 *     `projectFamilyTrusted`, the same helper `project-settings:launch-info` reports from.
 *  3. An untrusted shared value is OMITTED and the family's consent dialog is requested
 *     fire-and-forget. The spawn is never delayed by it.
 *  4. Everything else fails OPEN: no settings, an unreadable document, a throwing trust store, a
 *     throwing `requestTrust` — all answer "no overrides", never an exception into the spawn path.
 */
export function makeProjectSpawnOverrides(
  deps: ProjectSpawnOverridesDeps
): ProjectSpawnOverridesReader {
  return async (projectId: string): Promise<ProjectSpawnOverrides | null> => {
    let snap: ProjectSettingsSnapshot | null
    try {
      snap = await deps.readSettings(projectId)
    } catch {
      return null
    }
    if (!snap) return null
    const resolved = resolveProjectSettings(snap.local, snap.shared ?? undefined)
    const envSetting = resolved.agents.env
    const shellSetting = resolved.terminal.shell
    const secretsSetting = resolved.agents.secrets
    if (!envSetting && !shellSetting && !secretsSetting) return null

    const sharedDoc: ProjectSettingsDoc = snap.shared ?? {}
    const key = projectTrustKeyFor(deps.targetInfo(projectId))
    /** Ask once per family, and never wait on the human. */
    const admit = async (family: ProjectConsumerFamily): Promise<boolean> => {
      if (await projectFamilyTrusted(deps.trust, key, family, sharedDoc)) return true
      try {
        // Deliberately not awaited (and not returned): `ensureFamilyTrusted` resolves only when a
        // human answers — or in five minutes, when the prompt expires.
        void deps.requestTrust?.(projectId, family)
      } catch {
        /* a shell with no window to prompt in is still a shell that spawns terminals */
      }
      return false
    }

    const out: ProjectSpawnOverrides = {}
    if (envSetting && (!isShared(envSetting) || (await admit('agents')))) {
      out.env = { ...envSetting.value }
    }
    if (shellSetting && (!isShared(shellSetting) || (await admit('shell')))) {
      out.shell = shellSetting.value
    }
    if (secretsSetting) {
      out.secrets = secretsSetting.value.map((d) => (d.command ? { env: d.env, command: [...d.command] } : { env: d.env }))
    }
    return out.env || out.shell || out.secrets ? out : null
  }
}
