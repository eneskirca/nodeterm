import { countAcceptedCriteria as countAcceptedCriteriaShared, countActivatedRoles, countActiveTasks } from '../../shared/swarm/schemas'
import type { SwarmMission, SwarmTask, TaskStatus } from '../../shared/swarm/types'

const BLOCKING: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'ready',
  'running',
  'waiting_approval',
  'validating',
  'needs_review',
  'failed',
  'cancelled',
  'stale'
])

export function isAccepted(status: TaskStatus): boolean {
  return status === 'accepted'
}

/** A dependency unlocks only after an accepted structured result — idle is not enough. */
export function dependenciesSatisfied(task: SwarmTask, byId: Map<string, SwarmTask>): boolean {
  return task.dependsOn.every((id) => {
    const dep = byId.get(id)
    return !!dep && isAccepted(dep.status)
  })
}

export function tasksReadyToRun(mission: SwarmMission): SwarmTask[] {
  if (mission.paused || mission.cancelled) return []
  const byId = new Map(mission.tasks.map((t) => [t.id, t]))
  return mission.tasks.filter((t) => t.status === 'ready' && dependenciesSatisfied(t, byId))
}

export function blockedByUnacceptedDeps(task: SwarmTask, byId: Map<string, SwarmTask>): boolean {
  return task.dependsOn.some((id) => {
    const dep = byId.get(id)
    if (!dep) return true
    return BLOCKING.has(dep.status) || dep.status !== 'accepted'
  })
}

export function countActive(mission: SwarmMission): number {
  return countActiveTasks(mission.tasks)
}

export function countAcceptedCriteria(mission: SwarmMission): { met: number; total: number } {
  const accepted = mission.tasks.filter((t) => t.status === 'accepted').flatMap((t) => t.acceptanceCriteria)
  return countAcceptedCriteriaShared(mission.goal.acceptanceCriteria, accepted)
}

export { countActivatedRoles }
