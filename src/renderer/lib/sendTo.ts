// "Send to…" on a pull node: hand the PR, or one part of it, to ANY agent node in this project.
// Three pure parts and one sender: the picker's list (planSendTargets), the short prompt per payload
// (sendToPrompt), the context link from the agent to the pull node (pullLinkPlan), then one message
// through the chat view's own send path (sendToAgentNode). A user click is the only caller; no
// control verb reaches it. The prompt names what was picked and points the agent at its link and
// at gh for the text, so GitHub text written by others is never pasted into the pane.

import { oneLine } from '@shared/one-line'
import { pullWebUrl } from '@shared/pull-node'
import { isPlainRef, PR_TEXT_UNTRUSTED, prText as data } from '@shared/pull-work'
import { isSafeNodeId } from '@shared/safe-id'
import { planBridges, type BridgePlan, type LinkEndpoint } from '@shared/canvas-link'
import { agentProcessInPane } from '../terminal/live-work'
import { chatSendMode, type ChatGateStatus } from './chatSendGate'
import { SEND_TO_RELAY_TEXT, sendToAgentNode, type AgentSendDeps } from './pullFeedbackSend'
import { nodesJoined } from '../state/pullAgent'

/** One review thread, by its first comment's id. */
export interface SendToThread { id: number; path: string; line: number | null }

/** What a "Send to…" button hands over. */
export type SendToPayload =
  | { kind: 'pr' }
  /** `all`: the user sent every open thread, not a pick. `checks`: failing check names sent with them. */
  | { kind: 'threads'; threads: readonly SendToThread[]; all?: boolean; checks?: readonly string[] }
  | { kind: 'check'; name: string }
  | { kind: 'conflict'; base: string }
  /** The user's own machine-local notes (F-07): their text is the user's, so it is sent. */
  | { kind: 'notes'; notes: readonly { path: string; line: number | null; text: string }[] }
  | { kind: 'suggestion'; thread: SendToThread }

export interface SendToPr { repository: string; number: number; title: string }

export type SendToStatus = 'idle' | 'working' | 'needs-you' | 'off' | 'unknown'

export interface SendToTarget { id: string; title: string; agentId: string; status: SendToStatus; linked: boolean }

type FlowNode = { id: string; type?: string; data: { title?: unknown; agentId?: unknown } }
type FlowEdge = { source: string; target: string }

export function sendToStatus(agentId: string, s: ChatGateStatus | undefined): SendToStatus {
  if (!agentProcessInPane(agentId, s)) return 'off'
  if (s?.state === 'done') return 'idle'
  if (s?.state === 'working') return 'working'
  if (s?.state === 'waiting' || s?.state === 'blocked') return 'needs-you'
  return 'unknown'
}

/** The agent nodes on this canvas (the active project), linked ones first, then idle ones, else in
 *  canvas order. `query` keeps the ones whose title or agent id contains it (any case). */
export function planSendTargets(input: {
  pullId: string
  nodes: readonly FlowNode[]
  edges: readonly FlowEdge[]
  status: (nodeId: string) => ChatGateStatus | undefined
  query?: string
}): SendToTarget[] {
  const q = input.query?.trim().toLowerCase() ?? ''
  const rank = (t: SendToTarget): number => (t.linked ? 0 : 2) + (t.status === 'idle' ? 0 : 1)
  return input.nodes
    .flatMap((n): SendToTarget[] => {
      const agentId = n.data.agentId
      if (n.id === input.pullId || n.type !== 'terminal' || typeof agentId !== 'string' || !agentId) return []
      const title = (typeof n.data.title === 'string' && n.data.title.trim()) || n.id
      return [{ id: n.id, title, agentId, status: sendToStatus(agentId, input.status(n.id)), linked: nodesJoined(input.edges, n.id, input.pullId) }]
    })
    .filter((t) => !q || t.title.toLowerCase().includes(q) || t.agentId.toLowerCase().includes(q))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t)
}

/** The picker's heading: what goes out. */
export function sendToLabel(p: SendToPayload): string {
  switch (p.kind) {
    case 'pr': return 'Send this pull request'
    case 'threads': {
      const n = p.threads.length
      const checks = p.checks?.length ? ` and ${count(p.checks.length, 'failing check')}` : ''
      return `Send ${p.all ? `all ${n} open` : n} review ${n === 1 ? 'thread' : 'threads'}${checks}`
    }
    case 'check': return 'Send the failing check'
    case 'conflict': return 'Send the conflict'
    case 'notes': return `Send ${count(p.notes.length, 'note')}`
    case 'suggestion': return 'Send the suggestion'
  }
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const at = (t: { path: string; line: number | null }): string => `${t.path}${t.line !== null ? `:${t.line}` : ''}`
export const SEND_TO_MAX = 4_000
const LIST_MAX = 2_400

/** Numbered items until the list budget; the rest are counted, for gh. */
function list(items: readonly string[]): string {
  let out = ''
  let i = 0
  for (; i < items.length; i++) {
    const part = ` (${i + 1}) ${items[i]}`
    if (out.length + part.length > LIST_MAX) break
    out += part
  }
  return i < items.length ? `${out} (and ${items.length - i} more: read them with gh)` : out
}

/**
 * The one short line sent: the PR, what was picked, the task, where to read the rest. `node` (the
 * pull node, now context-linked to the agent) names the link and pr-propose; without it the agent
 * reads with gh only. Single line by construction, at most SEND_TO_MAX.
 */
export function sendToPrompt(pr: SendToPr, p: SendToPayload, node?: string): string {
  const { repository: repo, number: n } = pr
  const comments = `gh api repos/${repo}/pulls/${n}/comments`
  const [what, task] = ((): [string, string] => {
    switch (p.kind) {
      case 'pr': return ['the whole pull request',
        'Read it, then give the user a short summary of what it changes and what is still open. Wait for their instructions before you change code.']
      case 'threads': {
        const threads = p.threads.map((t) => `thread ${t.id} at ${data(at(t), 300)}`)
        const checks = (p.checks ?? []).map((name) => `failing check ${data(name, 200)}`)
        return [`${p.all ? 'all open review threads' : 'review threads'} (${count(p.threads.length, 'thread')}${checks.length ? `, ${count(checks.length, 'failing check')}` : ''}):${list([...threads, ...checks])}.`,
          `Read each thread with ${comments} (the number is its first comment's id)${checks.length ? ` and check logs with gh pr checks ${n} --repo ${repo}` : ''}, then address them in your working copy.`]
      }
      case 'check': return [`the failing check ${data(p.name, 200)}.`,
        `Find why it fails (gh pr checks ${n} --repo ${repo}, then gh run view <run-id> --log-failed) and fix it in your working copy.`]
      case 'conflict': {
        const base = isPlainRef(p.base) ? p.base : 'its base branch'
        return [`its merge conflict with ${base}.`,
          `First check out the PR's head branch yourself (gh pr checkout ${n} --repo ${repo}; if your working copy has uncommitted changes, ask the user first), then merge ${isPlainRef(p.base) ? `origin/${base}` : 'the base'} in (git fetch origin first), resolve the conflicts, run the project's checks, then stop and show the user the result (git diff and git status). Do not commit or push unless the user asks.`]
      }
      case 'notes': return [`${count(p.notes.length, 'note')} the user wrote on the diff:${list(p.notes.map((note) => `${data(at(note), 300)} ${oneLine(note.text).slice(0, 500)}`))}.`,
        'The notes are the user\'s own words. Address them in your working copy.']
      case 'suggestion': return [`the suggested change in review thread ${p.thread.id} at ${data(at(p.thread), 300)}.`,
        `Read it with ${comments}, judge whether it is right, and apply it in your working copy if it is.`]
    }
  })()
  const linked = node && isSafeNodeId(node)
  const line = [
    `[nodeterm] The user sends you ${what.endsWith('.') ? what : `${what}.`}`,
    `It is from GitHub pull request ${repo}#${n} (${pullWebUrl(repo, n)}), title ${data(pr.title, 200)}.`,
    task,
    linked
      ? `You are context-linked to pull node ${node}: read its state with the get-linked-context skill, and its text with gh pr view ${n} --repo ${repo} --comments and gh pr diff ${n} --repo ${repo}.`
      : `Read it with gh pr view ${n} --repo ${repo} --comments and gh pr diff ${n} --repo ${repo}.`,
    PR_TEXT_UNTRUSTED,
    linked
      ? `Do not write to GitHub yourself. To approve, comment or merge, use pr-propose --node ${node}: the user confirms it on the node.`
      : 'Do not reply to, resolve, approve, comment on or merge anything on GitHub unless the user asks in this session.'
  ].join(' ')
  return line.length > SEND_TO_MAX ? line.slice(0, SEND_TO_MAX) : line
}

/** The context link from the agent to the pull node (open-pr's link: the pull end is declared
 *  readable), or no edge when one exists or the agent cannot read context. */
export function pullLinkPlan(
  agentNodeId: string,
  pullId: string,
  existing: readonly FlowEdge[],
  endpointOf: (id: string) => LinkEndpoint | null
): BridgePlan {
  return planBridges(agentNodeId, [pullId], (id) => id === pullId ? { kind: 'pull', contextCapable: true } : endpointOf(id), existing)
}

/** The pull node asks Canvas (which owns the link edges) to draw that link. Synchronous: Canvas
 *  writes `linked` into the detail inside dispatchEvent. */
export const PULL_LINK_EVENT = 'nodeterm:pull-link'
export interface PullLinkRequest { pullId: string; agentNodeId: string; linked: boolean }

export function requestPullLink(pullId: string, agentNodeId: string): boolean {
  const detail: PullLinkRequest = { pullId, agentNodeId, linked: false }
  window.dispatchEvent(new CustomEvent<PullLinkRequest>(PULL_LINK_EVENT, { detail }))
  return detail.linked
}

export interface SendToDeps extends AgentSendDeps {
  relay: boolean
  nodes(): readonly FlowNode[]
  /** Draws the context link when missing; true when the agent is linked (now or already). */
  link(agentNodeId: string): boolean
}

export { SEND_TO_RELAY_TEXT }

/** Link (only when the agent can take a message now), then one prompt. Null = sent; else the sentence. */
export async function sendTo(
  deps: SendToDeps,
  req: { pullId: string; targetId: string; pr: SendToPr; payload: SendToPayload }
): Promise<string | null> {
  if (deps.relay) return SEND_TO_RELAY_TEXT
  const node = deps.nodes().find((n) => n.id === req.targetId && n.type === 'terminal')
  const agentId = node?.data.agentId
  if (!node || typeof agentId !== 'string' || !agentId) return 'That agent node is gone. Nothing was sent.'
  const title = (typeof node.data.title === 'string' && node.data.title.trim()) || node.id
  // ponytail: a busy agent gets no rope; the pane check below can still refuse after the link landed.
  const linked = chatSendMode(agentId, deps.status(node.id)) !== null && deps.link(node.id)
  return sendToAgentNode(deps, { id: node.id, title, agentId }, sendToPrompt(req.pr, req.payload, linked ? req.pullId : undefined))
}
