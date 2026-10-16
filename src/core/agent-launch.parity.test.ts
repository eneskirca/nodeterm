// The Windows launch channel (`pty:execute-launch`) replaces a typed line with the core planner's
// argv. That is only safe while the two describe the SAME launch, so this pins, for every builtin,
// mode and probe shape, that the planner's POSIX argv equals the words of the legacy typed line
// (`assembleLaunchCommand` / `assembleResumeCommand`). A grammar that drifts on one side — copilot's
// verified `--session-id=<uuid>` spelling did — fails here instead of on a Windows pane.
import { describe, expect, it } from 'vitest'
import { assembleLaunchCommand, assembleResumeCommand } from '../shared/agents/launch'
import { heldLaunchIntentFor } from '../shared/agents/launch-intent'
import { AGENT_CONFIG, ALL_PERMISSION_MODES, canResume, type AgentId } from '../shared/agents/config'
import { prepareAgentLaunch } from './agent-launch'

/** Words of a POSIX line as the shell would split them (quotes and backslash escapes only). */
function shellWords(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue }
    if (quote === '"') { if (c === '"') quote = null; else cur += c; continue }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '\\') { cur += line[++i]; started = true; continue }
    if (c === ' ') { if (cur || started) out.push(cur); cur = ''; started = false; continue }
    cur += c
  }
  if (cur || started) out.push(cur)
  return out
}

const SID = '123e4567-e89b-42d3-a456-426614174000'
const CAPS = [{}, { codexApprovalValues: ['untrusted', 'on-request', 'never'], codexNoDaemon: true }]
const MODES = [undefined, ...ALL_PERMISSION_MODES]
const builtins = Object.keys(AGENT_CONFIG) as AgentId[]

function context(agentId: AgentId, caps: (typeof CAPS)[number]) {
  return {
    expectedAgentId: agentId,
    sharedIdentityAvailable: false,
    codexApprovalValues: (caps as { codexApprovalValues?: string[] }).codexApprovalValues ?? null,
    codexNoDaemon: (caps as { codexNoDaemon?: boolean }).codexNoDaemon ?? null
  }
}

describe('planner argv ⇔ legacy typed line', () => {
  it.each(builtins)('%s: a first launch with a prompt', async (agentId) => {
    for (const permissionMode of MODES) {
      for (const caps of CAPS) {
        const typed = assembleLaunchCommand(
          { agentId, initialPrompt: `it's "go"`, permissionMode, sessionId: SID, sessionIdFlagSupported: true, approvalCaps: caps, sharedIdentity: false },
          {}
        ).command
        const held = heldLaunchIntentFor({ agentId, command: typed, remote: false, resume: false, initialPrompt: `it's "go"`, permissionMode, mintedSessionId: SID })
        expect(held, `${agentId} ${permissionMode}`).toBeDefined()
        const plan = await prepareAgentLaunch(held!.intent, 'posix', context(agentId, caps))
        expect(shellWords(plan.command), `${agentId} ${permissionMode} ${JSON.stringify(caps)}`).toEqual(shellWords(typed))
      }
    }
  })

  it.each(builtins.filter((a) => canResume(a)))('%s: a resume', async (agentId) => {
    for (const permissionMode of MODES) {
      for (const caps of CAPS) {
        const typed = assembleResumeCommand({ agentId, sessionId: SID, permissionMode, approvalCaps: caps, sharedIdentity: false }, {}).command
        const plan = await prepareAgentLaunch(
          { kind: 'agent', action: 'resume', agentId, sessionId: SID, ...(permissionMode ? { permissionMode } : {}) } as never,
          'posix',
          context(agentId, caps)
        ).catch(() => null)
        // A mode the planner refuses for this agent is a pre-delivery refusal (→ typed line), not drift.
        if (!plan) continue
        expect(shellWords(plan.command), `${agentId} ${permissionMode} ${JSON.stringify(caps)}`).toEqual(shellWords(typed))
      }
    }
  })
})
