/** The host-owned orchestrator minted by Nueva misión — not the last canvas terminal. */
export function claimPendingOrchestrator(
  terminals: ReadonlyArray<{
    id: string
    data: { launchMode?: string; swarm?: unknown; agentId?: unknown }
  }>,
  ignoreIds: ReadonlySet<string>
): string | null {
  const hit = [...terminals].reverse().find(
    (t) =>
      !ignoreIds.has(t.id) &&
      t.data.launchMode === 'runtime' &&
      !t.data.swarm &&
      !t.data.agentId
  )
  return hit?.id ?? null
}

/** Hide terminals stamped for another mission. Unstamped canvas bots stay (talk / Nuevo bot). */
export function mesaVisibleTerminals<
  T extends { data: { swarm?: { missionId?: string } | unknown } }
>(terminals: readonly T[], missionId: string | undefined): T[] {
  if (!missionId) return [...terminals]
  return terminals.filter((t) => {
    const swarm = t.data.swarm
    if (!swarm || typeof swarm !== 'object') return true
    const mid = (swarm as { missionId?: unknown }).missionId
    return typeof mid !== 'string' || mid === missionId
  })
}

/** Keep the current Mesa stage unless that node is gone. New workers must not steal focus. */
export function nextMesaFocus(
  terminalIds: readonly string[],
  current: string | null,
  preferId?: string | null
): string | null {
  if (preferId && terminalIds.includes(preferId)) return preferId
  if (current && terminalIds.includes(current)) return current
  return terminalIds[0] ?? null
}
