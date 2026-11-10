// `team resume`: restart the agents a desktop handed over, on THIS core's tmux socket, with their
// conversations resumed (`claude --resume <id>`, …). Called by "Share with team" only after the
// desktop VERIFIED each node's old SSH-spawned session is gone — two processes on one
// conversation would interleave its transcript — and re-checked here per node with the EXACT tmux
// target (a bare `has-session` prefix-matches, so `nt-x-1` would answer for `nt-x-12`).
// Idempotent: a session that already exists is `already-running`, and so is a node another request
// in this process is resuming right now, so a re-run never doubles.
import type { CanvasNodeState, Project } from '../../shared/types'
import type { HeadlessLaunchResult } from '../../shared/headless-launch'
import { RESUMABLE_AGENTS, isPermissionMode, type AgentPermissionMode } from '../../shared/agents/config'
import { SAFE_SESSION_ID } from '../../shared/session-id'
import { isSafeNodeId } from '../../shared/safe-id'
import type { ResumeEntry, ResumeResult, ResumeResultEntry } from '../../shared/share-team'
import { codedError } from './admin-error'

/** At most this many agent launches run at once: each one settles a fresh shell and types a line. */
export const RESUME_CONCURRENCY = 4

/** An entry that passed every per-entry check; `permissionMode` is present only when it is a mode. */
export interface ValidResumeEntry {
  nodeId: string
  agentId: string
  sessionId: string
  permissionMode?: AgentPermissionMode
}
export interface ResumeDeps {
  /** The nodes a resume is launching right now, ONE set for the whole process. A second request for
   *  a node still in it answers `already-running`: the desktop's call can time out while this server
   *  keeps draining it, and a re-run would otherwise see `absent` too and type the resume twice. */
  inFlight: Set<string>
  loadProject(projectId: string): Promise<Project | null>
  sessionVerdict(nodeId: string): Promise<'present' | 'absent' | 'unknown'>
  /** The command line that resumes this entry on this host (null = cannot be composed). */
  command(entry: ValidResumeEntry, node: CanvasNodeState, project: Project): Promise<string | null>
  launch(project: Project, node: CanvasNodeState, command: string): Promise<HeadlessLaunchResult>
}

const isTerminal = (n: CanvasNodeState): boolean => n.kind === undefined || n.kind === 'terminal'

/**
 * Resume every listed session that may be resumed here, at most RESUME_CONCURRENCY at a time, and
 * answer one result per entry in request order. Every refusal is per entry and carries its reason;
 * only an unknown project refuses the whole request. A node listed twice is refused after its first
 * occurrence, so one request can never start two agents on one node.
 */
export async function runResume(
  deps: ResumeDeps,
  req: { projectId: string; sessions: ResumeEntry[] }
): Promise<ResumeResult> {
  const project = await deps.loadProject(req.projectId)
  if (!project) throw codedError('E_BAD_REQUEST', `There is no project ${req.projectId} on this server.`)
  const seen = new Set<string>()
  const jobs: Array<() => Promise<ResumeResultEntry>> = req.sessions.map((e) => {
    const refuse = (reason: string) => async (): Promise<ResumeResultEntry> => ({ nodeId: e.nodeId, status: 'refused', reason })
    if (seen.has(e.nodeId)) return refuse('listed twice')
    seen.add(e.nodeId)
    if (!isSafeNodeId(e.nodeId)) return refuse('not a valid node id')
    const node = project.nodes.find((n) => n.id === e.nodeId)
    if (!node || !isTerminal(node)) return refuse('not a terminal node of this project')
    if (!(RESUMABLE_AGENTS as readonly string[]).includes(e.agentId)) return refuse('this agent cannot be resumed')
    if (node.agentId !== e.agentId) return refuse('the node runs a different agent')
    // A managed account's config dir lives on the machine that added it; this core cannot know it.
    if (node.accountId) return refuse('runs under a managed account; resume it by hand')
    // The id ends up on a shell command line: re-validated here, never trusted by its type.
    if (!SAFE_SESSION_ID.test(e.sessionId)) return refuse('not a valid session id')
    // An unrecognized mode is dropped (the bare command), never forwarded to the command line.
    const entry: ValidResumeEntry = {
      nodeId: e.nodeId,
      agentId: e.agentId,
      sessionId: e.sessionId,
      ...(isPermissionMode(e.permissionMode) ? { permissionMode: e.permissionMode } : {})
    }
    return async (): Promise<ResumeResultEntry> => {
      // Claimed before the first await, so two overlapping requests cannot both pass this check.
      if (deps.inFlight.has(e.nodeId)) return { nodeId: e.nodeId, status: 'already-running' }
      deps.inFlight.add(e.nodeId)
      try {
        const verdict = await deps.sessionVerdict(e.nodeId)
        if (verdict === 'present') return { nodeId: e.nodeId, status: 'already-running' }
        // Never a launch on uncertainty: a session we could not see may still be running the agent.
        if (verdict === 'unknown') {
          return { nodeId: e.nodeId, status: 'refused', reason: 'could not check whether its session is running' }
        }
        const command = await deps.command(entry, node, project)
        if (!command) return { nodeId: e.nodeId, status: 'refused', reason: 'no resume command for this agent' }
        const r = await deps.launch(project, node, command)
        return r.outcome === 'delivered'
          ? { nodeId: e.nodeId, status: 'resumed' }
          : { nodeId: e.nodeId, status: 'refused', reason: `launch failed (${r.reason})` }
      } finally {
        deps.inFlight.delete(e.nodeId)
      }
    }
  })
  const results: ResumeResultEntry[] = new Array(jobs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++
      try {
        results[i] = await jobs[i]()
      } catch (err) {
        results[i] = {
          nodeId: req.sessions[i].nodeId,
          status: 'refused',
          reason: err instanceof Error ? err.message : String(err)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESUME_CONCURRENCY, jobs.length) }, worker))
  return { results }
}
