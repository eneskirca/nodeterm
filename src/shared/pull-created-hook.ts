// The pull request an agent just made: read off the PostToolUse hook that reported its
// `gh pr create` (Claude Code and Codex), so nodeterm opens that PR's node beside the agent as if
// it had run `open-pr --pr <n>`. Desktop main reads the hook (verified callers only), the canvas
// places the node through the open-pr plan. Nothing here reaches GitHub.
import { parseRepository } from './github-issue-ref'
import { planOpenPr, type OpenPrPlan } from './open-pr-verb'

export interface PullCreated {
  repository: string
  pullNumber: number
}

/** What main sends the renderer (IPC.agentPullCreated): the verified caller's node and its PR. */
export interface PullCreatedEvent extends PullCreated {
  nodeId: string
}

/** Characters of tool output read, from the end: gh prints the link last. */
const SCAN_CHARS = 64_000

/** `gh pr create` in command position: at a line start or after a shell separator. A mention
 *  inside other text ("run gh pr create later") is not one. */
const GH_PR_CREATE = /(?:^|[;&|(`]|\$\()\s*gh\s+pr\s+create(?=\s|$)/m

// A github.com link up to the first space or quote; its path is checked whole below, and the
// owner/repo halves by the board's own grammar (parseRepository).
const GITHUB_LINK = /https:\/\/github\.com\/([^\s"'`<>)\]},;]+)/g
const PULL_PATH = /^([^/]+)\/([^/]+)\/pull\/([1-9]\d{0,9})$/

function lastPullLink(output: string): PullCreated | undefined {
  const tail = output.slice(-SCAN_CHARS)
  // One link per tool call: the last one, or nothing. A trailing full stop ends a sentence.
  const last = [...tail.matchAll(GITHUB_LINK)].at(-1)?.[1].replace(/[.:]$/, '')
  const m = last ? PULL_PATH.exec(last) : null
  if (!m || Number(m[3]) > 2_147_483_647) return undefined
  const repository = `${m[1]}/${m[2]}`
  return parseRepository(repository) ? { repository, pullNumber: Number(m[3]) } : undefined
}

/** The PR a `gh pr create` printed, from a Claude Code or Codex PostToolUse payload. */
export function pullCreatedFromHook(agentId: string, payload: Record<string, unknown>): PullCreated | undefined {
  if (agentId !== 'claude' && agentId !== 'codex') return undefined
  if (payload.hook_event_name !== 'PostToolUse' || payload.tool_name !== 'Bash') return undefined
  const command = (payload.tool_input as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string' || !GH_PR_CREATE.test(command)) return undefined
  const response = payload.tool_response
  // Claude: stdout only (gh prints the new PR there; "already exists" goes to stderr). Codex: the
  // one output string its hook carries.
  const output = agentId === 'claude'
    ? (response as { stdout?: unknown } | undefined)?.stdout
    : response
  return typeof output === 'string' ? lastPullLink(output) : undefined
}

/** The event for a VERIFIED hook caller, else undefined. Both shells' raw listeners call this. */
export function pullCreatedEvent(
  agentId: string,
  nodeId: string,
  payload: Record<string, unknown>,
  meta: { verified: boolean }
): PullCreatedEvent | undefined {
  if (!meta.verified || !nodeId) return undefined
  const created = pullCreatedFromHook(agentId, payload)
  return created ? { nodeId, ...created } : undefined
}

/** open-pr's plan for a PR the hook reported: only the project's own repository, approved or not. */
export function planPullCreated(input: {
  created: PullCreated
  repo: { repository?: string; approved: boolean } | undefined
  pullNodes: Parameters<typeof planOpenPr>[0]['pullNodes']
  relayGuest?: boolean
}): OpenPrPlan {
  const { created, repo } = input
  if (!input.relayGuest && repo?.repository?.toLowerCase() !== created.repository.toLowerCase()) {
    return { kind: 'refuse', error: 'pull-created-other-repo: the PR is not in this project\'s repository' }
  }
  // ponytail: `approved: true` only lets the node open; the host refuses its reads until the user
  // clicks Allow inside the node.
  return planOpenPr({
    args: { pr: String(created.pullNumber) },
    repo: { repository: repo?.repository, approved: true },
    pullNodes: input.pullNodes,
    relayGuest: input.relayGuest
  })
}
