import type { GitHubLink } from '@shared/github-issues'
import type { BoardLogEvent } from '@shared/types'

/**
 * Canvas ↔ node bridge for the GitHub link actions, the same indirection `setWorktreeActionHandler`
 * uses: React Flow instantiates custom nodes itself, so a Canvas callback cannot reach them as a
 * prop. Canvas registers the handler in the same effect; a node (or a board surface) calls the
 * verbs below. Every write goes through Canvas so the node write, `markDirty` and the board-log
 * event stay one funnel. `projectId` absent = the active project; the Omni board passes its lane's.
 */
export interface GitHubLinkHandler {
  attach(nodeId: string, link: GitHubLink, projectId?: string): void
  detach(nodeId: string, link: Pick<GitHubLink, 'kind' | 'number'>, projectId?: string): void
  /** Replace a node's links wholesale (the card metadata strip's ×). */
  set(nodeId: string, next: GitHubLink[] | undefined, event?: BoardLogEvent, projectId?: string): void
  /** Open the picker anchored at a point, adding to `nodeId`. */
  openPicker(nodeId: string, anchor: { x: number; y: number }, projectId?: string): void
  /** Open the read-only summary for one link. */
  openDetails(link: GitHubLink, projectId?: string): void
}

let handler: GitHubLinkHandler | null = null

export function setGitHubLinkHandler(next: GitHubLinkHandler | null): void {
  handler = next
}

export function attachGitHubLink(nodeId: string, link: GitHubLink, projectId?: string): void {
  handler?.attach(nodeId, link, projectId)
}

export function detachGitHubLink(
  nodeId: string,
  link: Pick<GitHubLink, 'kind' | 'number'>,
  projectId?: string
): void {
  handler?.detach(nodeId, link, projectId)
}

export function setGitHubLinks(
  nodeId: string,
  next: GitHubLink[] | undefined,
  event?: BoardLogEvent,
  projectId?: string
): void {
  handler?.set(nodeId, next, event, projectId)
}

export function openGitHubLinkPicker(
  nodeId: string,
  anchor: { x: number; y: number },
  projectId?: string
): void {
  handler?.openPicker(nodeId, anchor, projectId)
}

export function openGitHubLinkDetails(link: GitHubLink, projectId?: string): void {
  handler?.openDetails(link, projectId)
}
