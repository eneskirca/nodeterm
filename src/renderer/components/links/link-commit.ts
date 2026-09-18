import type { Link } from '@shared/types'

/** Canvas owns live-edge + persisted-link reconciliation, but React Flow instantiates node
 * components outside its prop tree. Register the one commit funnel here so header/card inspectors
 * cannot mutate the project store behind Canvas's edge refs and lose their edit on autosave. */
let handler: ((projectId: string, links: Link[]) => void) | null = null

export function setLinkCommitHandler(next: ((projectId: string, links: Link[]) => void) | null): void {
  handler = next
}

/** Returns false only outside a mounted Canvas (isolated component tests/story renders). */
export function commitLinksThroughCanvas(projectId: string, links: Link[]): boolean {
  if (!handler) return false
  handler(projectId, links)
  return true
}
