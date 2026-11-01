import type { StoreApi } from 'zustand'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { fanoutStillWorking } from '@renderer/lib/completionAlert'
import { recordsTurnInterrupt, type AgentStatusStore } from './agentStatus'
import type { useAgentNodes } from './agentNodes'

/**
 * The store half of the agent-status listener: one `NormalizedAgentEvent` in, the agent-status and
 * subagent-card writes it implies, and the alert it raises out.
 *
 * Moved out of Canvas's `onAgentStatus` listener unchanged so the same writes can run against a
 * store other than the default one — a relay session's own `SessionStores.agentStatus` (bug D: a
 * team tab never showed agent status, because the only subscriber wrote the DEFAULT store). The
 * caller passes the store it means; nothing here reaches for a module singleton.
 *
 * What stays with the caller is everything that is a LOCAL interrupt or a fact about this window:
 * the unread mark and its ack (they depend on which terminal has focus), the sound, the OS
 * notification and the handoff fold. The reducer only says which alert the event raised.
 */

type AgentNodesState = ReturnType<typeof useAgentNodes.getState>

/** `finished` = a turn ended cleanly; `quiet` silences the interrupts (chime, OS notification) and
 *  never the unread record — see `fanoutStillWorking`. `needs-input` = blocked or waiting. */
export type AgentEventAlert = { kind: 'finished'; quiet: boolean } | { kind: 'needs-input' }

export interface ApplyAgentEventOptions {
  /** The `remote` flag `setAccount` records. Canvas: observationIsRemote(originOf(id)); relay: true. */
  observationRemote: boolean
}

export interface AgentEventResult {
  nodeId: string
  alert: AgentEventAlert | null
}

export function applyAgentEvent(
  status: Pick<StoreApi<AgentStatusStore>, 'getState'>,
  nodes: Pick<StoreApi<AgentNodesState>, 'getState'> | null, // null = no subagent cards (relay)
  e: NormalizedAgentEvent,
  opts: ApplyAgentEventOptions
): AgentEventResult {
  const cs = status.getState()
  let alert: AgentEventAlert | null = null
  if (e.sessionId) cs.setSessionId(e.nodeId, e.sessionId)
  // Which Claude account the posting session is ACTUALLY on — a hook-derived LABEL, captured
  // off any event that carries one, exactly like `sessionId` above: a plain terminal running
  // `CLAUDE_CONFIG_DIR=~/.claude-2 claude` announces its identity nowhere else.
  //
  // The `remote` flag is decided by the CALLER and nowhere else. The classifier in core is
  // deliberately host-agnostic — two of its rules exist precisely to name a REMOTE dir — and core
  // holds only the hook payload, which never says which machine posted it. The listener is the
  // first layer that can ask, because it can reach the node and the project that owns it, and a
  // dir that names another machine's filesystem must not reach any LOCAL affordance (see
  // `observationIsRemote` and the consumers in lib/accountChip.ts).
  if (e.account) cs.setAccount(e.nodeId, { ...e.account, remote: opts.observationRemote })
  // No subagent cards on this surface (`nodes` null): every card write below is skipped.
  const an = nodes ? nodes.getState() : null
  switch (e.kind) {
    case 'state': {
      // An `idle` done (the CLI went quiet at its prompt — see normalize) is a RESCUE for a
      // node stuck on `working` after an Esc that ran no turn-end hook. It may ONLY move a
      // working node: blocked/waiting is also "idle at the prompt", and clearing it there
      // would drop a live approval off the badge. Same rule as the mirror's reduceEntry.
      const stuckRescueSkip = e.idle === true && cs.byId[e.nodeId]?.state !== 'working'
      // `pendingId` (deterministic approvals) rides a `blocked` event; the store keeps it only
      // while blocked so the header's Approve/Deny buttons appear + vanish with the state.
      // `e.verified` is the identity evidence for this very transition (hook-server labels it);
      // it was in scope here and dropped on the floor before the store had a field for it.
      if (e.state && !stuckRescueSkip)
        cs.setState(
          e.nodeId,
          e.state,
          e.agentId,
          e.newTurn,
          e.pendingId,
          e.verified,
          e.errored,
          e.held,
          recordsTurnInterrupt(e)
        )
      // Claude's Stop names the BACKGROUND tasks still running (async subagents, nested ones,
      // background shells). A background subagent that ends its turn while its own work runs
      // fires SubagentStop — its card goes done — and is resumed later, so the card alone would
      // let Eco or the bulk restart type /exit over live work. The existing background-task
      // stamp is the guard both already read; a turn start clears it, the next Stop re-decides.
      if (e.state === 'done' && !stuckRescueSkip && e.backgroundTaskIds?.length) cs.markBackgroundTask(e.nodeId)
      // A genuine new turn drops the previous fan-out — but only the cards that FINISHED
      // (issue #547). Claude launches subagents async, so "waiting for N background agents to
      // finish" is exactly the state in which the next prompt gets typed, and clearing a
      // working card there loses it permanently (nothing rehydrates `byId`) while the agent
      // keeps running — and blinds Eco's live-subagent guard into hibernating its parent.
      if (e.newTurn) an?.clearFinishedForParent(e.nodeId)
      if (e.newTurn && e.task) {
        // Prompt-prefix fallback for /loop|/schedule|/cron when the natural-language
        // phrasing doesn't trigger the tool-based (recurring) detection.
        const m = e.task.match(/^\s*\/(loop|schedule|cron)\b/)
        if (m) cs.setLoop(e.nodeId, true, m[1] as 'loop' | 'schedule' | 'cron', { task: e.task })
      }
      if (e.state === 'done' && !e.interrupted && !stuckRescueSkip) {
        // Interrupted turns (Esc/Ctrl-C) alert nobody: the user did it themselves, and
        // the turn didn't complete, so it isn't a loop iteration either.
        // An IGNORED rescue is silent for the same reason it moves no badge: it claims a turn
        // ended for a node this surface never saw running, so the "finished" is unfounded —
        // and it arrives from a second source of truth (the main-process mirror drives the SSH
        // reconnect resync, this store drives the alert), which can legitimately disagree after
        // a renderer reload. Gating the badge but not the sound/notification would half-enforce
        // the flag and leave the expensive error — a false completion — fully reachable.
        cs.bumpLoop(e.nodeId, e.lastMessage) // count loop iterations + summary (no-op if not looping)
        // Issue #708: a turn that ended only because a BACKGROUND SUBAGENT reported back is
        // not the fan-out finishing — the parent is about to be woken again by the next one.
        // Read fresh (not the `an` snapshot taken at entry): `clearFinishedForParent` may have
        // run just above. It only drops DONE cards, so the verdict is the same either way, and
        // depending on that is exactly the kind of coupling that rots. No cards = never quiet.
        const fanoutBusy = nodes
          ? fanoutStillWorking(Object.values(nodes.getState().byId), e.nodeId)
          : false
        alert = { kind: 'finished', quiet: fanoutBusy }
      }
      if (e.state === 'blocked' || e.state === 'waiting') alert = { kind: 'needs-input' }
      break
    }
    case 'subagent-start':
      if (e.toolUseId && an) {
        an.start(
          e.toolUseId,
          {
            parentNodeId: e.nodeId,
            type: e.subagentType,
            label: e.taskLabel,
            startedAt: e.subagentStartedAt,
            lastActivityAt: e.subagentLastActivityAt
          },
          // A Claude native card replacing the card its tool call drew (claude-subagent-lifecycle).
          e.supersedes
        )
      }
      break
    case 'subagent-end':
      if (e.toolUseId && an)
        an.finish(e.toolUseId, {
          durationMs: e.durationMs,
          tokens: e.tokens,
          toolUses: e.toolUses,
          result: e.result
        })
      break
    case 'background-task':
      // A background shell task runs INSIDE the CLI process, so the `/exit` Eco hibernation
      // and the bulk restart type would kill it silently. Stamp the node so both skip it.
      // The write mints a new entry object, so whole-map subscribers (minimap, the node) do
      // re-render — once per background launch, which is rarer than any state event.
      cs.markBackgroundTask(e.nodeId)
      break
    case 'recurring':
      if (e.recurringEnd) {
        // The recurring job itself was removed (CronDelete) — take the card down.
        cs.setLoop(e.nodeId, false)
        an?.clearLoop(e.nodeId)
      } else if (e.recurringKind) {
        cs.setLoop(e.nodeId, true, e.recurringKind, { schedule: e.schedule, task: e.task })
      }
      break
    case 'session':
      if (e.sessionTitle) cs.setSession(e.nodeId, e.sessionTitle)
      if (e.sessionPhase === 'start') {
        cs.setState(e.nodeId, undefined, e.agentId)
        // A SessionStart is proof a CLI just LAUNCHED in that pane, so a hibernated flag on
        // this node is now false — our own `/exit` produces a SessionEnd, never a
        // SessionStart. This is the residual `setState`'s live-state self-heal cannot reach:
        // a user who relaunches the agent by hand and then takes no turn would keep a SLEEPING
        // chip on a running CLI (and the sweep, which skips hibernated nodes, would leave that
        // session exempt from Eco for good). Deliberately NOT the same as clearing on `done`,
        // which would let a late Stop POST undo a hibernation we just performed. The setter
        // bails when the flag is already unset, so this is free for every other session start.
        cs.setHibernated(e.nodeId, false)
        // Same self-heal, same reason, for the deep "pause & end session" case: that depth
        // recycles the tmux session instead of leaving `hibernated` set, so this SessionStart
        // (the cold-restore's own resume, or a hand-launched relaunch) is the only live proof
        // that node was watching for.
        cs.setPaused(e.nodeId, false)
        // A new CLI is in the pane: whatever exited before it no longer describes this node.
        cs.setSessionEnded(e.nodeId, false)
      }
      if (e.sessionPhase === 'end') {
        cs.setState(e.nodeId, undefined, e.agentId)
        // Recorded as its OWN fact, after the state: `state: undefined` alone is what an idle
        // agent looks like, and the memory levers would keep protecting a pane that now holds
        // only a shell (see `agentProcessInPane`).
        cs.setSessionEnded(e.nodeId, true)
        // In-session /loop dies with its session; cron (and scheduled cloud routines)
        // keep running after it — their cards stay until CronDelete / manual dismiss.
        const kind = cs.byId[e.nodeId]?.loop?.kind
        if (kind === 'loop') {
          cs.setLoop(e.nodeId, false)
          an?.clearLoop(e.nodeId)
        }
        an?.clearForParent(e.nodeId)
      }
      break
  }
  return { nodeId: e.nodeId, alert }
}
