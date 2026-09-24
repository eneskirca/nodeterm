// Which relay-guest methods name a PROJECT, and which project — the one table behind the scope jail
// in `relay-host.ts` (a session bound to one shared project must never let the guest reach another).
//
// The jail used to be a per-feature switch with a `default: not project-scoped` arm, so a method the
// switch did not list was waved through. That is safe only for as long as every project-naming
// channel is remembered in every switch, and it failed OPEN for the next one nobody added: a new
// `githubIssues:*` verb would have reached another project's repository with no refusal anywhere.
// So membership is by CLASS (channel prefix), and a method inside a class that this table cannot
// read a projectId out of is answered as "names an unknown project" — which a scoped session
// refuses. Adding a channel to a class therefore costs one table row to become reachable, rather
// than one forgotten row to become a hole.
//
// `projects.*` is in the class although no IPC channel carries that prefix today: it is the phone
// dialect's board verbs (`projects.ensureBoard` / `setCardColumn` / `editCardLabels`, served by
// host-service to an approved PHONE, never on this tunnel). Classifying it here means that if a
// relay guest ever sends one — or a future channel is named after it — it is judged by the shared
// project rather than passed to a router on the assumption that nothing answers.
//
// Unscoped sessions are not affected at all: with no shared project the jail is off, exactly as
// before (the host registry is then the only gate, as it is for the host's own renderer).

import { IPC } from '../../shared/ipc'

export interface ProjectScope {
  /** The method belongs to a project-scoped channel class. */
  scoped: boolean
  /** The projectId it names — `undefined` when the class is known but the method is not, which
   *  the jail treats as "not the shared project" (fail closed). */
  projectId: unknown
}

/** Channel prefixes whose every method acts on ONE project. */
export const PROJECT_SCOPED_PREFIXES = ['githubIssues:', 'board-log:', 'projects.'] as const

const fromFirstArg = (args: unknown[]): unknown => args[0]
const fromFirstArgField = (args: unknown[]): unknown =>
  args[0] && typeof args[0] === 'object' ? (args[0] as { projectId?: unknown }).projectId : undefined

/** Methods whose projectId we know how to read. Everything else in a scoped class fails closed. */
const EXTRACTORS: Record<string, (args: unknown[]) => unknown> = {
  [IPC.githubIssuesSubscribe]: fromFirstArgField,
  [IPC.githubIssuesQuery]: fromFirstArgField,
  [IPC.githubIssuesMove]: fromFirstArgField,
  [IPC.githubIssuesRefresh]: fromFirstArg,
  [IPC.githubIssuesCreateLabels]: fromFirstArg,
  [IPC.githubIssuesClearCache]: fromFirstArg,
  [IPC.githubIssuesUnsubscribe]: fromFirstArg,
  [IPC.boardLogAppend]: fromFirstArg,
  [IPC.boardLogRead]: fromFirstArg,
  [IPC.boardLogSubscribe]: fromFirstArg,
  [IPC.boardLogUnsubscribe]: fromFirstArg,
  // The phone dialect's params object, should one ever arrive as the first arg.
  'projects.ensureBoard': fromFirstArgField,
  'projects.setCardColumn': fromFirstArgField,
  'projects.editCardLabels': fromFirstArgField
}

export function projectScopeOf(method: string, args: unknown[]): ProjectScope {
  if (!PROJECT_SCOPED_PREFIXES.some((p) => method.startsWith(p))) {
    return { scoped: false, projectId: undefined }
  }
  const extract = EXTRACTORS[method]
  return { scoped: true, projectId: extract ? extract(Array.isArray(args) ? args : []) : undefined }
}

/** True when a session bound to `sharedProjectId` must refuse this method. Unscoped ⇒ never. */
export function outOfProjectScope(
  sharedProjectId: string | undefined,
  method: string,
  args: unknown[]
): boolean {
  if (!sharedProjectId) return false
  const scope = projectScopeOf(method, args)
  return scope.scoped && scope.projectId !== sharedProjectId
}
