import type { NormalizedAgentEvent } from '../shared/agents/normalize'

/** In-memory, bounded fan-out snapshot shared by desktop and server. Replay ONLY
 * subagent events: replaying state/permission events would repeat alerts/actions. */
export class SubagentReplay {
  private cards = new Map<string, { start?: NormalizedAgentEvent; end?: NormalizedAgentEvent }>()

  record(e: NormalizedAgentEvent): void {
    if (e.newTurn || e.sessionPhase) {
      for (const [id, card] of this.cards) {
        if ((card.start ?? card.end)?.nodeId === e.nodeId && (e.sessionPhase || card.end))
          this.cards.delete(id)
      }
    }
    if (!e.toolUseId || (e.kind !== 'subagent-start' && e.kind !== 'subagent-end')) return
    const key = JSON.stringify([e.nodeId, e.toolUseId])
    const card = this.cards.get(key) ?? {}
    if (e.kind === 'subagent-start') {
      if (!card.start && !card.end)
        card.start = { ...e, subagentStartedAt: e.subagentStartedAt ?? Date.now() }
    } else card.end = { ...e }
    this.cards.set(key, card)
    while (this.cards.size > 512) this.cards.delete(this.cards.keys().next().value!)
  }

  snapshot(): NormalizedAgentEvent[] {
    return [...this.cards.values()].flatMap((c) =>
      [c.start, c.end].filter((e): e is NormalizedAgentEvent => !!e).map((e) => ({ ...e })))
  }
}
