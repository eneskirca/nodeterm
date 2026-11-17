import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { WORKING_STALE_MS } from '../shared/agents/stale'

/** Current-host, display-only lifecycle memory. Never persisted or used as permission evidence.
 * Replays only running starts: old approvals, turn completions and alerts must not fire again. */
export class SubagentReplay {
  private readonly starts = new Map<string, NormalizedAgentEvent>()
  /** Last streamed transcript chunk per start, so expiry counts from the last sign of life. */
  private readonly lastActivity = new Map<string, number>()
  constructor(private readonly limit = 512) {}

  record(event: NormalizedAgentEvent, now = Date.now()): void {
    this.prune(now)
    if (event.kind === 'session' && event.sessionPhase) {
      this.clearParent(event.nodeId)
    } else if (event.kind === 'subagent-end' && event.toolUseId) {
      this.forget(this.key(event))
    } else if (event.kind === 'subagent-start' && event.toolUseId) {
      const key = this.key(event)
      // A native card REPLACING the card its tool call drew (core/claude-subagent-lifecycle.ts):
      // the replayed card keeps the original start time under the new key.
      // Its last sign of life moves with it (a time cannot double the way streamed text would), and
      // `forget` drops the old key's activity entry too — a bare `starts.delete` orphaned it.
      const oldKey = event.supersedes && event.supersedes !== event.toolUseId
        ? this.key({ ...event, toolUseId: event.supersedes })
        : undefined
      const replaced = oldKey ? this.starts.get(oldKey) : undefined
      const replacedLast = oldKey ? this.lastActivity.get(oldKey) : undefined
      if (oldKey) this.forget(oldKey)
      if (replaced && replacedLast !== undefined) {
        this.lastActivity.set(key, Math.max(replacedLast, this.lastActivity.get(key) ?? 0))
      }
      const running = this.starts.get(key)
      if (running) {
        // A repeated start of a running card corrects what it shows, never when it started.
        if (event.taskLabel !== undefined) running.taskLabel = event.taskLabel.slice(0, 4000)
        if (event.subagentType !== undefined) running.subagentType = event.subagentType
      } else {
        // Copy just the display fields. In particular, a replay never carries verified identity.
        // `subagentSignal` says which hook drew the card: a native one's key is the child's
        // agent_id, which is what lets a reloaded card keep reading the subagent's conversation.
        this.starts.set(key, {
          kind: 'subagent-start', nodeId: event.nodeId, agentId: event.agentId,
          toolUseId: event.toolUseId, subagentType: event.subagentType,
          taskLabel: event.taskLabel?.slice(0, 4000), subagentStartedAt: replaced?.subagentStartedAt ?? now,
          ...(event.subagentSignal ? { subagentSignal: event.subagentSignal } : {})
        })
      }
      while (this.starts.size > this.limit) this.forget(this.starts.keys().next().value!)
    }
  }

  /** A subagent streamed transcript. Activity is keyed by tool_use_id only (that is all the tails
   *  know); an id with no running start is ignored, so this never creates or revives an entry. */
  touch(toolUseId: string, now = Date.now()): void {
    for (const [key, e] of this.starts) if (e.toolUseId === toolUseId) this.lastActivity.set(key, now)
  }

  snapshot(now = Date.now()): NormalizedAgentEvent[] {
    this.prune(now)
    return [...this.starts].map(([key, e]) => {
      const last = this.lastActivity.get(key)
      return last === undefined ? { ...e } : { ...e, subagentLastActivityAt: last }
    })
  }
  clearParent(nodeId: string): void {
    for (const [key, e] of this.starts) if (e.nodeId === nodeId) this.forget(key)
  }
  clear(): void { this.starts.clear(); this.lastActivity.clear() }
  private forget(key: string): void { this.starts.delete(key); this.lastActivity.delete(key) }
  private key(e: NormalizedAgentEvent): string { return JSON.stringify([e.nodeId, e.toolUseId]) }
  private prune(now: number): void {
    for (const [key, e] of this.starts) {
      // An activity time ahead of `now` (the clock stepped back after it was stamped) would keep
      // the start alive until wall time caught up; clamp it, so the silence window restarts once.
      const last = this.lastActivity.get(key)
      if (last !== undefined && last > now) this.lastActivity.set(key, now)
      const lastSeen = Math.max(e.subagentStartedAt!, Math.min(last ?? 0, now))
      if (now - lastSeen >= WORKING_STALE_MS || now < e.subagentStartedAt!) this.forget(key)
    }
  }
}
export const subagentReplay = new SubagentReplay()
