import type { AgentProcessProof } from '@shared/types'
import type { AgentPaneVerdict } from '@shared/agents/pane-owner-predicate'

export const AGENT_RESPAWN_PROCESS_TIMEOUT_MS = 8_000
export const AGENT_RESPAWN_PROCESS_POLL_MS = 150
export const AGENT_RESPAWN_PROCESS_STABLE_MS = 1_000
export const AGENT_PROCESS_PROBE_TIMEOUT_MS = 2_000

export interface AgentRespawnProcessResult {
  running: boolean
  attempts: number
  lastVerdict: AgentPaneVerdict
  shellPid?: number
  agentPid?: number
  reason: 'running' | 'deadline' | 'inactive'
}

interface AgentRespawnProcessOptions {
  timeoutMs?: number
  pollMs?: number
  stableMs?: number
  active?: () => boolean
  onAttempt?: (attempt: number, proof: AgentProcessProof, stableForMs: number) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Bound one kernel/transport proof. The overall respawn deadline cannot protect a probe whose IPC
 * promise itself never settles: execution would never get back to the deadline check and the
 * progress row would spin forever. Late probe results are deliberately ignored; every accepted
 * identity must come from a fresh call.
 */
export async function agentProcessProofWithin(
  probe: () => Promise<AgentProcessProof>,
  timeoutMs = AGENT_PROCESS_PROBE_TIMEOUT_MS
): Promise<AgentProcessProof> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe().catch((): AgentProcessProof => ({ verdict: 'unknown' })),
      new Promise<AgentProcessProof>((resolve) => {
        timer = setTimeout(
          () => resolve({ verdict: 'unknown' }),
          Math.max(0, timeoutMs)
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Poll the core's kernel-backed pane-owner verdict after a replacement command is submitted.
 * `not-agent` is retried because a shell is the expected foreground owner while the CLI starts;
 * `unknown` is retried because one transient tmux/SSH read must not manufacture a failure.
 */
export async function waitForAgentRespawnProcess(
  probe: () => Promise<AgentProcessProof>,
  options: AgentRespawnProcessOptions = {}
): Promise<AgentRespawnProcessResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? AGENT_RESPAWN_PROCESS_TIMEOUT_MS)
  const pollMs = Math.max(1, options.pollMs ?? AGENT_RESPAWN_PROCESS_POLL_MS)
  const stableMs = Math.max(0, options.stableMs ?? AGENT_RESPAWN_PROCESS_STABLE_MS)
  const active = options.active ?? (() => true)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let attempts = 0
  let lastVerdict: AgentPaneVerdict = 'unknown'
  let stableShellPid: number | undefined
  let stableAgentPid: number | undefined
  let stableSince = 0

  while (active()) {
    const remainingBeforeProbe = deadline - now()
    if (remainingBeforeProbe <= 0) {
      return { running: false, attempts, lastVerdict, reason: 'deadline' }
    }
    attempts++
    const proof = await agentProcessProofWithin(probe, remainingBeforeProbe)
    lastVerdict = proof.verdict
    const sampledAt = now()
    if (proof.verdict === 'agent' && proof.shellPid && proof.agentPid) {
      // Stabilize the PAIR. The root/login shell may stay alive while its child agent dies; the
      // opposite transition (a replaced shell generation) must reset the proof even if a PID was
      // rapidly reused for an agent in the new pane.
      if (proof.shellPid !== stableShellPid || proof.agentPid !== stableAgentPid) {
        stableShellPid = proof.shellPid
        stableAgentPid = proof.agentPid
        stableSince = sampledAt
      }
    } else {
      stableShellPid = undefined
      stableAgentPid = undefined
      stableSince = 0
    }
    const stableForMs = stableAgentPid ? sampledAt - stableSince : 0
    options.onAttempt?.(attempts, proof, stableForMs)
    // The lifecycle/ticket can expire while the IPC probe is in flight. Never let a late positive
    // sample resurrect that dead attempt, and never let a slow probe succeed after the deadline.
    if (!active()) break
    if (sampledAt > deadline) {
      return { running: false, attempts, lastVerdict, reason: 'deadline' }
    }
    if (stableShellPid && stableAgentPid && stableForMs >= stableMs) {
      return {
        running: true,
        attempts,
        lastVerdict,
        shellPid: stableShellPid,
        agentPid: stableAgentPid,
        reason: 'running'
      }
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      return { running: false, attempts, lastVerdict, reason: 'deadline' }
    }
    await sleep(Math.min(pollMs, remaining))
  }

  return { running: false, attempts, lastVerdict, reason: 'inactive' }
}
