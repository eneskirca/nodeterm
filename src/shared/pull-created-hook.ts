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
  // One PR link per tool call: the last one, or nothing. A trailing full stop ends a sentence.
  const last = [...tail.matchAll(GITHUB_LINK)].map((m) => m[1]).filter((p) => p.includes('/pull/')).at(-1)
    ?.replace(/[.:]$/, '')
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

/** The event for a VERIFIED hook caller, else undefined. Desktop main's raw listener calls this;
 *  the Server Edition does not (docs/github-issues-kanban.md). */
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

/** The `open-pr` call the canvas runs for the event, as if the agent had made it. */
export function pullCreatedControl(event: PullCreatedEvent): {
  cmd: { requestId: string; sourceNodeId: string; verb: 'open-pr'; args: { pr: string } }
  created: PullCreated
} {
  const { nodeId, ...created } = event
  return { cmd: { requestId: '', sourceNodeId: nodeId, verb: 'open-pr', args: { pr: String(created.pullNumber) } }, created }
}

/** What the canvas does once an open-pr plan landed. The verb frames a reused node on screen; the
 *  hook path never moves the camera and offers a jump toast for a new node instead. */
export function openPrLanding(input: {
  plan: Exclude<OpenPrPlan, { kind: 'refuse' }>
  onScreen: boolean
  fromHook: boolean
}): { travel: boolean; toast?: string } {
  const { plan } = input
  if (input.fromHook) return { travel: false, ...(plan.kind === 'create' ? { toast: `PR #${plan.ref.pullNumber} opened` } : {}) }
  return { travel: plan.kind === 'reuse' && input.onScreen }
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
