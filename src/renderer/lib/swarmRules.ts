/**
 * Automated orchestration for a Mesa swarm. The human names the job once; the app
 * encodes the graph: independent workers start together, the synthesizer is armed
 * with `--after` so it launches when those workers go idle — no dispatcher, no poll.
 *
 * Caps match Grok Bot's roster limits and nodeterm's spawn-team role cap.
 */

export const MAX_SWARM_ROLES = 8
/** Grok Bot's practical group size — a swarm that would exceed this still opens, but we stay at 3. */
export const GROK_GROUP_CAP = 6

export interface SwarmMemberPlan {
  title: string
  prompt: string
}

export interface SwarmPlan {
  groupTitle: string
  /** Start immediately (independent workstreams). */
  workers: SwarmMemberPlan[]
  /** Armed behind every worker. Must not start until they are idle. */
  synthesizer: SwarmMemberPlan
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function groupTitleFrom(task: string): string {
  const t = oneLine(task)
  if (!t) return 'Swarm'
  return t.length > 36 ? `${t.slice(0, 33)}…` : t
}

/**
 * Two parallel workers + one fan-in synthesizer. The synthesizer prompt assumes the
 * wait already happened (pendingLaunch.after) — it must not tell the bot to poll.
 */
export function planSwarm(opts: {
  task: string
  leadName: string
  leadCallsign: string
}): SwarmPlan {
  const task = oneLine(opts.task)
  const lead = opts.leadName.trim()
    ? `${opts.leadName.trim()} (${opts.leadCallsign})`
    : opts.leadCallsign
  const job = task || 'the current job'
  return {
    groupTitle: groupTitleFrom(task),
    workers: [
      {
        title: 'Explore',
        prompt: oneLine(
          `You are a swarm worker for ${lead}. Independent workstream: explore the codebase and decide the approach for: ${job} Do not wait on other bots. When you finish, leave a short summary of what you found and what you would change.`
        )
      },
      {
        title: 'Build',
        prompt: oneLine(
          `You are a swarm worker for ${lead}. Independent workstream: implement and verify your slice of: ${job} Do not wait on other bots. When you finish, leave a short summary of what you produced.`
        )
      }
    ],
    synthesizer: {
      title: 'Synthesize',
      prompt: oneLine(
        `The Explore and Build swarm workers for ${lead} have finished. Read what they produced in this working tree and synthesize one result for: ${job} Reconcile conflicts. They already finished — start from their summaries.`
      )
    }
  }
}

export function swarmMemberCount(plan: SwarmPlan): number {
  return plan.workers.length + 1
}
