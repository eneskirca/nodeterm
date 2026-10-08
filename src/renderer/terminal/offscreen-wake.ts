import type { SleepingWakeRequest, SleepingWakeResult } from '@shared/agents/sleeping-wake'
import type { WakeContext } from '@shared/agents/wake-identity'
import { guardConcurrentRestart } from './agent-restart'

export interface OffscreenWakeTarget {
  projectId: string
  nodeId: string
  agentId: string
  sessionId: string
  hibernated: boolean
  paused: boolean
  recorded?: WakeContext | null
}
export interface OffscreenWakeIo {
  resolve(nodeId: string): OffscreenWakeTarget | null
  current(target: OffscreenWakeTarget): boolean
  command(target: OffscreenWakeTarget): Promise<string | null>
  deliver(request: SleepingWakeRequest): Promise<SleepingWakeResult>
  completed(target: OffscreenWakeTarget): void
  refused(nodeId: string, result: SleepingWakeResult): void
  wait?(ms: number): Promise<void>
}

/** Uses saved ownership, never the currently visible project's launch settings or a fresh pane. */
export async function wakeOffscreen(nodeId: string, automatic: boolean, io: OffscreenWakeIo): Promise<void> {
  await guardConcurrentRestart(nodeId, async () => {
    const target = io.resolve(nodeId)
    if (!target || (!target.hibernated && !target.paused) || (automatic && target.paused)) return 'not-eligible'
    const command = await io.command(target)
    if (!command || !io.current(target)) return 'not-eligible'
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!io.current(target)) return 'not-eligible'
      const result = await io.deliver({ nodeId, agentId: target.agentId, command,
        recorded: target.recorded, exitedByUs: target.hibernated })
      // A hook or project change while core awaited the pane must never clear a newer sleep/pause.
      if (!io.current(target)) return 'not-eligible'
      if (result.delivered) {
        io.completed(target)
        return 'resumed'
      }
      // Only a pre-write unreadable/absent owned pane can be retried. The attach nudge precedes
      // relay registration; a delayed attach must still wake, without replaying an uncertain write.
      if (result.verdict !== 'unreadable' || attempt === 2) {
        io.refused(nodeId, result)
        return 'not-eligible'
      }
      await (io.wait?.(4000) ?? new Promise<void>((resolve) => setTimeout(resolve, 4000)))
    }
    return 'not-eligible'
  })()
}
