import type { PaneAdoptionRequest } from '../../shared/agents/pane-adoption'

/** Scope selection only, never evidence of historical ownership. Main supplies the private-index
 * lookup; a project file listing a node cannot supply this lookup or grant authority. */
export function createPrivatePaneScope(deps: {
  projects(): readonly { id: string; nodes: readonly { id: string; kind: string }[] }[]
  privateProject(projectId: string): { cwd?: string; ssh?: unknown } | null
  isSshNode(nodeId: string): boolean
  realpath(cwd: string): string
}): (request: PaneAdoptionRequest) => { projectCwd: string } | null {
  return ({ nodeId, projectId }) => {
    try {
      const target = deps.privateProject(projectId)
      if (!target?.cwd || target.ssh || deps.isSshNode(nodeId)) return null
      const matches = deps.projects().flatMap(project => project.nodes.filter(node => node.id === nodeId).map(node => ({ project, node })))
      if (matches.length !== 1 || matches[0].project.id !== projectId || matches[0].node.kind !== 'terminal') return null
      return { projectCwd: deps.realpath(target.cwd) }
    } catch { return null }
  }
}
