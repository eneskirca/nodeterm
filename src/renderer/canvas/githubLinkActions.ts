import type { GitHubLink } from '@shared/github-issues'

/**
 * Canvas ↔ node bridge for the GitHub link actions, the same indirection `setWorktreeActionHandler`
 * uses: React Flow instantiates custom nodes itself, so a Canvas callback cannot reach them as a
 * prop. Canvas registers the handler in the same effect; a node (or a board surface) calls the
 * verbs below. Every write goes through Canvas so the node write, `markDirty` and the board-log
 * event stay one funnel.
 */
export interface GitHubLinkHandler {
  attach(nodeId: string, link: GitHubLink): void
  detach(nodeId: string, link: Pick<GitHubLink, 'kind' | 'number'>): void
  /** Open the picker anchored at a point, adding to `nodeId`. */
  openPicker(nodeId: string, anchor: { x: number; y: number }): void
  /** Open the read-only summary for one link. */
  openDetails(link: GitHubLink): void
}

let handler: GitHubLinkHandler | null = null

export function setGitHubLinkHandler(next: GitHubLinkHandler | null): void {
  handler = next
}

export function attachGitHubLink(nodeId: string, link: GitHubLink): void {
  handler?.attach(nodeId, link)
}

export function detachGitHubLink(nodeId: string, link: Pick<GitHubLink, 'kind' | 'number'>): void {
  handler?.detach(nodeId, link)
}

export function openGitHubLinkPicker(nodeId: string, anchor: { x: number; y: number }): void {
  handler?.openPicker(nodeId, anchor)
}

export function openGitHubLinkDetails(link: GitHubLink): void {
  handler?.openDetails(link)
}
