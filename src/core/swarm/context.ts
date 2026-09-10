import type { MissionGoal, SwarmTask } from '../../shared/swarm/types'

export function compactGoal(goal: MissionGoal): string {
  const lines = [`v${goal.version}: ${goal.objective.trim()}`]
  if (goal.constraints.length) lines.push(`Constraints: ${goal.constraints.join('; ')}`)
  if (goal.acceptanceCriteria.length) lines.push(`Accept: ${goal.acceptanceCriteria.join('; ')}`)
  return lines.join('\n')
}

export function taskBrief(goal: MissionGoal, task: SwarmTask, coordinatorInstruction?: string): string {
  return [
    compactGoal(goal),
    coordinatorInstruction ? `Coordinator: ${coordinatorInstruction}` : '',
    `Role ${task.roleId}: ${task.instruction}`,
    task.acceptanceCriteria.length ? `Criteria: ${task.acceptanceCriteria.join('; ')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
