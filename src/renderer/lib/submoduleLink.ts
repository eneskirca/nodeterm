// Pure helpers for the meta-canvas submodule auto-link (ticket 09). Kept free of React/store/git
// imports so the plan is unit-testable: the effect in Canvas.tsx gathers the facts (the active
// project's projectRef groups, each referenced project's repo root + submodule list, the open
// projects' cwds) and hands them here; this decides what `dependency` links to upsert and what
// projectRef groups to create. A `dependency` link between two projectRef groups on the SAME
// meta-canvas is a `node`↔`node` edge (`dependencyLink`), so it renders as a visible amber edge.

import type { Link } from '@shared/types'
import type { SubmoduleEntry } from '@shared/worktree'
import { dependencyLink } from './noteLink'

/** A projectRef group on the active (meta) canvas, with the repo it references resolved. */
export interface RefGroup {
  /** The group node id on the meta-canvas. */
  groupId: string
  /** The referenced project's id. */
  projectId: string
}

/** An open project keyed by its working directory (the cwd lookup, like `openFolderProject`). */
export interface OpenProjectByCwd {
  cwd: string
  projectId: string
}

export interface SubmoduleLinkPlan {
  /** `dependency` links to upsert (idempotent by id — the caller dedupes against existing). */
  links: Link[]
  /** Project ids that need a NEW projectRef group on the meta-canvas (no group exists for them yet).
   *  The caller creates a `kind:'group'` node with `data.projectRef:{projectId}` for each. */
  groupsToCreate: { projectId: string; color?: string }[]
}

/**
 * Decide the `dependency` links and new projectRef groups for one referenced project's submodules.
 *
 * `repoRoot` is the referenced project's git root; each submodule `path` is RELATIVE to it, so the
 * absolute path the cwd lookup needs is `repoRoot + '/' + sub.path`. For a submodule whose absolute
 * path matches an OPEN project: draw a `dependency` link from the submodule's projectRef group to
 * the referencing project's group — BOTH are real group nodes on the meta-canvas, so it is a
 * visible `node`↔`node` edge. If no projectRef group exists yet for the submodule project, request
 * one (`groupsToCreate`); the caller creates it and the link references the new group id (which the
 * caller knows once it mints the node).
 *
 * `existingGroupForProject` maps a referenced project id → the group node id already on the
 * meta-canvas that references it (so a link is only drawn between two GROUPS, never a dangling
 * endpoint). `existingLinkKeys` is the set of dependency-link ids already persisted, so the plan is
 * idempotent across re-runs (re-opening the meta-canvas doesn't duplicate edges).
 *
 * The link direction is submodule → referencing project (child depends on parent), matching
 * `dependencyLink`'s `dep-` id convention and the two-host branch dependency direction.
 */
export function planSubmoduleLinks(
  ref: RefGroup,
  repoRoot: string,
  submodules: readonly SubmoduleEntry[],
  openProjects: readonly OpenProjectByCwd[],
  existingGroupForProject: ReadonlyMap<string, string>,
  existingLinkKeys: ReadonlySet<string>
): SubmoduleLinkPlan {
  const links: Link[] = []
  const groupsToCreate: { projectId: string; color?: string }[] = []
  const root = repoRoot.replace(/\/+$/, '')
  for (const sub of submodules) {
    const absPath = `${root}/${sub.path.replace(/^\/+/, '')}`
    const match = openProjects.find((p) => p.cwd === absPath)
    if (!match) continue // unopened submodule — v1 suggest-don't-create (no ghost yet)
    const subGroupId = existingGroupForProject.get(match.projectId)
    if (!subGroupId) {
      // No group on the meta-canvas references this submodule project yet — request one. The link
      // is still added referencing `subGroupId` (unknown here), so the CALLER must mint the group
      // FIRST and substitute its id, or skip the link until the next run. To keep the plan pure and
      // avoid a forward reference, we DO NOT add a link with an unknown id here; the next run (after
      // the group is created) picks it up. This means a freshly-discovered submodule project gets its
      // group on this run and its edge on the NEXT — one extra tick, never a dangling edge.
      groupsToCreate.push({ projectId: match.projectId })
      continue
    }
    const link = dependencyLink(subGroupId, ref.groupId)
    if (existingLinkKeys.has(link.id)) continue
    links.push(link)
  }
  return { links, groupsToCreate }
}

/** The set of dependency-link ids already on a project's `links` (for idempotent upsert). */
export function existingDependencyLinkKeys(links: readonly Link[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const l of links ?? []) if (l.kind === 'dependency') out.add(l.id)
  return out
}
