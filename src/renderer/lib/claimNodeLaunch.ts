/**
 * Exactly-once claim for a node's one-shot launch command (`initialCommand`).
 *
 * Mesa's ModalTerminal can be the FIRST spawner of a node (the canvas is covered,
 * and the Grok-style stage mounts a viewer immediately). Canvas TerminalNode still
 * mounts under that overlay and will also try to type the CLI. The first caller
 * to `claimNodeLaunch` owns the write; the other no-ops. A claim that never starts
 * delivery must `releaseNodeLaunch` so a remount can try again.
 */
const claimed = new Set<string>()

export function claimNodeLaunch(nodeId: string): boolean {
  if (!nodeId || claimed.has(nodeId)) return false
  claimed.add(nodeId)
  return true
}

export function releaseNodeLaunch(nodeId: string): void {
  claimed.delete(nodeId)
}

export function nodeLaunchClaimed(nodeId: string): boolean {
  return claimed.has(nodeId)
}
