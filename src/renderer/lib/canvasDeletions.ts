import type { Project } from '@shared/types'

/** Session-local deletion memory, independent of the optimistic projects-store
 * baseline. An old external snapshot must not turn a just-deleted id into an
 * apparently new addition. Explicit local undo/recreation restores that id. */
export class CanvasDeletions {
  private byProject = new Map<string, Set<string>>()

  record(projectId: string, before: Iterable<string>, after: Iterable<string>): void {
    const live = new Set(after)
    const deleted = this.byProject.get(projectId) ?? new Set<string>()
    for (const id of before) if (!live.has(id)) deleted.add(id)
    for (const id of live) deleted.delete(id)
    this.byProject.set(projectId, deleted)
  }

  filter(project: Project, live?: Iterable<string>): Project {
    const deleted = this.byProject.get(project.id)
    if (!deleted?.size) return project
    if (live) for (const id of live) deleted.delete(id)
    const nodes = project.nodes.filter((n) => !deleted.has(n.id))
    return nodes.length === project.nodes.length ? project : { ...project, nodes }
  }
}
