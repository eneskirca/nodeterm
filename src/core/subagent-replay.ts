import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { WORKING_STALE_MS } from '../shared/agents/stale'

/** Current-host, display-only lifecycle memory. Never persisted or used as permission evidence.
 * Replays only running starts: old approvals, turn completions and alerts must not fire again. */
export class SubagentReplay {
  private readonly starts = new Map<string, NormalizedAgentEvent>()
  constructor(private readonly limit = 512) {}

  record(event: NormalizedAgentEvent, now = Date.now()): void {
    this.prune(now)
    if (event.kind === 'session' && event.sessionPhase) {
      this.clearParent(event.nodeId)
    } else if (event.kind === 'subagent-end' && event.toolUseId) {
      this.starts.delete(this.key(event))
    } else if (event.kind === 'subagent-start' && event.toolUseId) {
      const key = this.key(event)
      // A native card REPLACING the card its tool call drew (core/claude-subagent-lifecycle.ts):
      // the replayed card keeps the original start time under the new key.
      const replaced = event.supersedes ? this.starts.get(this.key({ ...event, toolUseId: event.supersedes })) : undefined
      if (event.supersedes) this.starts.delete(this.key({ ...event, toolUseId: event.supersedes }))
      const running = this.starts.get(key)
      if (running) {
        // A repeated start of a running card corrects what it shows, never when it started.
        if (event.taskLabel !== undefined) running.taskLabel = event.taskLabel.slice(0, 4000)
        if (event.subagentType !== undefined) running.subagentType = event.subagentType
      } else {
        // Copy just the display fields. In particular, a replay never carries verified identity.
        this.starts.set(key, {
          kind: 'subagent-start', nodeId: event.nodeId, agentId: event.agentId,
          toolUseId: event.toolUseId, subagentType: event.subagentType,
          taskLabel: event.taskLabel?.slice(0, 4000), subagentStartedAt: replaced?.subagentStartedAt ?? now
        })
      }
      while (this.starts.size > this.limit) this.starts.delete(this.starts.keys().next().value!)
    }
  }

  snapshot(now = Date.now()): NormalizedAgentEvent[] {
    this.prune(now)
    return [...this.starts.values()].map((e) => ({ ...e }))
  }
  clearParent(nodeId: string): void {
    for (const [key, e] of this.starts) if (e.nodeId === nodeId) this.starts.delete(key)
  }
  clear(): void { this.starts.clear() }
  private key(e: NormalizedAgentEvent): string { return JSON.stringify([e.nodeId, e.toolUseId]) }
  private prune(now: number): void {
    for (const [key, e] of this.starts) {
      if (now - e.subagentStartedAt! >= WORKING_STALE_MS || now < e.subagentStartedAt!) this.starts.delete(key)
    }
  }
}
export const subagentReplay = new SubagentReplay()
