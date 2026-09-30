// What `open-agent --issue <owner/repo#N | #N>` resolves to, for the desktop control dispatch.
//
// Pure apart from the one injected question it cannot answer itself: which repository a project's
// kanban board syncs with. That is the GitHub host controller's answer (configured, else detected
// from the project's git remote — exactly what the issue lane uses), asked of the core that owns the
// project. `#N` means that repository and nothing else; with no GitHub board, or a board whose
// repository nobody can name, `#N` is refused and told the full form. The reference is re-parsed
// here with the one shared grammar even though main already refused a malformed shape — the
// renderer never trusts that the gate in front of it ran.

import { parseIssueArg, resolveIssueArg, type IssueRef } from '@shared/github-issue-ref'
import { routeControlSource, sourceIsControlCapable, type ControlProject } from './controlRouting'
import { resolveProjectTarget, type ProjectTargetProject } from './projectOpen'

export interface IssueFlagProject {
  id: string
  kanban?: { github?: { repository?: string } }
}

export type IssueFlagResult = { ok: true; ref?: IssueRef } | { ok: false; error: string }

export async function resolveIssueFlagFor(
  raw: string | undefined,
  verb: string,
  project: IssueFlagProject | undefined,
  boardRepository: (projectId: string) => Promise<string | null>
): Promise<IssueFlagResult> {
  if (raw === undefined) return { ok: true }
  // A full `owner/repo#N` needs no repository lookup — and asking anyway would put a host round trip
  // (git remote, `gh auth`) in front of every such open for nothing. Only `#N` asks.
  const parsed = parseIssueArg(raw)
  if (!parsed.ok) return { ok: false, error: `${verb}: ${parsed.error}` }
  if (parsed.kind === 'full') return { ok: true, ref: parsed.ref }
  let repository: string | null = null
  if (project?.kanban?.github) {
    // A session api without a GitHub controller (a relay tab's) may throw synchronously rather
    // than reject — either way the answer is "unknown", never a failed open.
    repository = await Promise.resolve()
      .then(() => boardRepository(project.id))
      .catch(() => null)
    repository ??= project.kanban.github.repository ?? null
  }
  const resolved = resolveIssueArg(raw, repository)
  return resolved.ok ? { ok: true, ref: resolved.ref } : { ok: false, error: `${verb}: ${resolved.error}` }
}

/**
 * `resolveIssueFlagFor`, behind the renderer's authorization belt. A `#N` lookup runs the GitHub
 * host controller for a project (`git remote`, `gh auth`) and its answer tells the caller whether
 * that project has a board — so it runs only for a caller the open paths AUTHORIZE: a source that
 * is a known control-capable agent, and a `--project` target `resolveProjectTarget` allows (the very
 * call the `--project` path makes). A caller they would refuse is refused HERE, with the path's own
 * sentence, before anybody is asked. Argument-shape refusals (`--dry-run` with `--project`, a
 * `--group`/`--after` into another project, `--run-now` with `--after`) still come from the paths,
 * after this; they say nothing about who may look at which project. Main's `gateProjectTarget` (identity + own-or-granted) has
 * already run on the desktop; this is the renderer not depending on it, the order the Server
 * Edition keeps too. It stays ahead of the paths because each of them snapshots the projects store
 * synchronously, and an await inside one lets a tab switch land in between (#443 class).
 * An open without `--issue` is not gated here: nothing is asked for it, and its path judges it.
 */
export type IssueFlagCallProject = IssueFlagProject & ProjectTargetProject & ControlProject

export async function resolveIssueFlagForCall(
  input: {
    raw: string | undefined
    verb: string
    /** The `--project` flag, when given. */
    targetId: string | undefined
    sourceNodeId: string
    /** React Flow's nodes — the ACTIVE project's. */
    liveNodes: readonly { id: string; data: { agentId?: unknown } }[]
    projects: readonly IssueFlagCallProject[]
    activeProjectId: string
  },
  boardRepository: (projectId: string) => Promise<string | null>
): Promise<IssueFlagResult> {
  if (input.raw === undefined) return { ok: true }
  const scope = issueFlagScope(input)
  if (!scope.ok) return scope
  return resolveIssueFlagFor(
    input.raw,
    input.verb,
    input.projects.find((project) => project.id === scope.projectId),
    boardRepository
  )
}

/** Which project `#N` is resolved against — the one the node opens in — or the refusal the open
 *  paths would give this call. Exported because it is the one answer for every per-open question the
 *  dispatch decides before its paths (Canvas also sizes the open prompt's spill by it): two copies
 *  of "which project, and may this caller ask" are how one of them drifts. */
export function issueFlagScope<P extends ProjectTargetProject & ControlProject>(input: {
  targetId: string | undefined
  sourceNodeId: string
  liveNodes: readonly { id: string; data: { agentId?: unknown } }[]
  projects: readonly P[]
  activeProjectId: string
}): { ok: true; projectId: string } | { ok: false; error: string } {
  if (input.targetId !== undefined) {
    const target = resolveProjectTarget({
      targetId: input.targetId,
      sourceNodeId: input.sourceNodeId,
      liveNodes: input.liveNodes,
      projects: input.projects,
      activeProjectId: input.activeProjectId,
      sshVerbWord: 'opening'
    })
    if (target.kind === 'refused') return { ok: false, error: target.error }
    if (target.kind === 'target') return { ok: true, projectId: target.project.id }
    // 'own': the path falls through to the legacy routing below, and so does this.
  }
  const live = input.liveNodes.find((node) => node.id === input.sourceNodeId)
  if (live) {
    return sourceIsControlCapable(live.data.agentId)
      ? { ok: true, projectId: input.activeProjectId }
      : { ok: false, error: 'source node is not a control-capable agent' }
  }
  const route = routeControlSource(input.projects, input.activeProjectId, input.sourceNodeId)
  if (route.kind === 'unknown' || route.kind === 'blocked') {
    return { ok: false, error: 'source node is not on an open canvas' }
  }
  // On the active project but not on the live canvas yet (the boot load is in flight): the path
  // waits for the live node and judges ITS agent id, which the load may still have to migrate (a
  // legacy `tags:['claude']` node stores none). The source is the caller's own project either way,
  // so this gate defers to that verdict rather than being stricter than it.
  if (route.kind === 'active') return { ok: true, projectId: input.activeProjectId }
  const stored = input.projects.find((project) => project.id === route.projectId)?.nodes
    .find((node) => node.id === input.sourceNodeId)
  // The cold-open path judges the SERIALIZED node, exactly as here.
  return stored && sourceIsControlCapable(stored.agentId)
    ? { ok: true, projectId: route.projectId }
    : { ok: false, error: 'source node is not a control-capable agent' }
}
