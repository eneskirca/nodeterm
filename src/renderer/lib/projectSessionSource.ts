import { sessionForProject, type SessionSource } from '../session/session'

/**
 * The source of the session a project's surfaces are viewed through — for the surfaces that know a
 * project id but sit outside that project's `SessionProvider` (the boards, the sessions sidebar).
 * Null when no session resolves (a registry with no session at all, e.g. a unit test).
 */
export function projectSessionSource(projectId: string): SessionSource | null {
  try {
    return sessionForProject(projectId).source
  } catch {
    return null
  }
}
