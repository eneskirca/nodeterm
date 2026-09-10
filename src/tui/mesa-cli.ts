import type { SwarmMission } from '../shared/swarm/types'
import { writerWorktreeBlockLabel } from '../shared/swarm/schemas'
import { applyTuiCommand, parseTuiLine, renderTuiHelp } from './mesa-orchestrator'

export interface MesaCliRuntime {
  load(): SwarmMission | null
  setGoal(objective: string): Promise<SwarmMission | null>
  pause(): Promise<SwarmMission | null>
  resume(): Promise<SwarmMission | null>
  cancel(): Promise<SwarmMission | null>
  approve(id: string): Promise<SwarmMission | null>
  activate(roleId: string): Promise<SwarmMission | null>
}

export async function handleCliLine(
  line: string,
  runtime: MesaCliRuntime
): Promise<{ reply: string; mission: SwarmMission | null }> {
  const parsed = parseTuiLine(line)
  const mission = runtime.load()
  const result = applyTuiCommand(mission, parsed)
  let next = mission
  if (result.action?.type === 'set-goal' && result.action.arg) next = await runtime.setGoal(result.action.arg)
  if (result.action?.type === 'pause') next = await runtime.pause()
  if (result.action?.type === 'resume') next = await runtime.resume()
  if (result.action?.type === 'cancel') next = await runtime.cancel()
  if (result.action?.type === 'approve' && result.action.arg) {
    next = await runtime.approve(result.action.arg)
    const still = next?.approvals.find((a) => a.id === result.action?.arg && a.status === 'pending')
    const blocked = writerWorktreeBlockLabel(still?.blockedReason)
    if (blocked) return { reply: blocked, mission: next }
  }
  if (result.action?.type === 'activate' && result.action.arg) next = await runtime.activate(result.action.arg)
  return { reply: result.reply || renderTuiHelp(), mission: next }
}

export function banner(): string {
  return [
    'mesa › Consola del orquestador.',
    'Escribí el objetivo o un comando. /help lista los comandos.',
    'Estos comandos no se interceptan en Claude, Codex ni en un shell.',
    ''
  ].join('\n')
}
