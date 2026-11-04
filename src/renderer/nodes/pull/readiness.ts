// What the pull node's header says about merge readiness, and the one next step it offers. Pure:
// derived in render from reads the shell already holds (detail, checks, conversation, proposal,
// agent status). No request of its own.
import type { GitHubPullConversationResult, GitHubPullDetail, PullMergeMethod } from '@shared/github-pull-detail'
import type { PullNodeTab } from '@shared/pull-node'
import type { PullProposal } from '@shared/pull-agent-verbs'
import type { AgentState } from '@shared/agents/normalize'
import { pullFeedbackItems } from '../../lib/pullFeedback'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import type { IconName } from './Icon'
import { headChecks } from './PullChecksTab'
import { METHOD_TEXT, type Read } from './shared'

/** Where a click lands: a tab, and optionally a part of it marked `data-pull-section="<section>"`. */
export type PullSection = 'merge' | 'details' | 'agent'
export interface PullJump { tab: PullNodeTab; section?: PullSection }

export type ReadinessTone = 'ok' | 'attention' | 'danger' | 'muted' | 'agent'
export interface ReadinessSegment {
  key: 'review' | 'checks' | 'threads' | 'conflicts' | 'agent'
  label: string
  tone: ReadinessTone
  /** Absent for the agent segment, which shows a dot. */
  icon?: IconName
  jump: PullJump
}

export interface ReadinessInput {
  detail: GitHubPullDetail
  checks?: PullChecksRead
  /** Unresolved review threads; undefined = not known (no segment). */
  openThreads?: number
  /** The first linked agent node and its live state. */
  agent?: { title: string; state?: AgentState }
  proposal?: PullProposal
}

/** Unresolved review threads from the conversation read; undefined while loading, failed, or when
 *  GitHub did not say which threads are resolved. */
export function openThreadCount(conversation: Read<GitHubPullConversationResult>): number | undefined {
  if (conversation === 'loading' || conversation.status !== 'ok' || !conversation.resolvedThreads) return undefined
  return pullFeedbackItems(conversation.lineComments, conversation.resolvedThreads, null, undefined).length
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const PROPOSAL_VERB: Record<PullProposal['action'], string> = {
  approve: 'approve', 'request-changes': 'request changes', comment: 'comment', merge: 'merge'
}

/** The segments of the readiness bar, left to right. A fact the reads do not know yet has no segment. */
export function pullReadiness({ detail: d, checks, openThreads, agent, proposal }: ReadinessInput): ReadinessSegment[] {
  const segments: ReadinessSegment[] = []
  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'
  const read = checks && checks !== 'loading' ? checks : undefined
  if (open && read && (read.status === 'ok' || read.status === 'no-checks')) {
    const jump: PullJump = { tab: 'conversation', section: 'details' }
    if (read.review === 'approved') segments.push({ key: 'review', label: 'Approved', tone: 'ok', icon: 'check', jump })
    else if (read.review === 'changes-requested') segments.push({ key: 'review', label: 'Changes requested', tone: 'danger', icon: 'x', jump })
    else if (read.review === 'required') segments.push({ key: 'review', label: 'Review required', tone: 'attention', icon: 'eye', jump })
    else segments.push({ key: 'review', label: 'No review required', tone: 'muted', icon: 'eye', jump })
  }
  const runs = open ? headChecks(checks, d.head.sha) : undefined
  if (runs) {
    const failed = runs.filter((check) => check.state === 'failed').length
    const pending = runs.filter((check) => check.state === 'pending').length
    const jump: PullJump = { tab: 'checks' }
    if (failed) segments.push({ key: 'checks', label: plural(failed, 'failing check'), tone: 'danger', icon: 'x', jump })
    else if (pending) segments.push({ key: 'checks', label: `${runs.length - pending}/${runs.length} checks`, tone: 'attention', icon: 'sync', jump })
    else segments.push({ key: 'checks', label: `${runs.length}/${runs.length} checks`, tone: 'ok', icon: 'check', jump })
  } else if (open && read?.status === 'no-checks') {
    segments.push({ key: 'checks', label: 'No checks', tone: 'muted', icon: 'check', jump: { tab: 'checks' } })
  }
  if (open && openThreads !== undefined) {
    segments.push(openThreads
      ? { key: 'threads', label: plural(openThreads, 'open thread'), tone: 'attention', icon: 'thread', jump: { tab: 'files' } }
      : { key: 'threads', label: 'No open threads', tone: 'ok', icon: 'check', jump: { tab: 'files' } })
  }
  if (open && d.merge && d.merge !== 'undecided') {
    const jump: PullJump = { tab: 'conversation', section: 'merge' }
    if (d.merge === 'conflict') segments.push({ key: 'conflicts', label: `Conflicts with ${d.base.ref}`, tone: 'danger', icon: 'conflict', jump })
    else if (d.merge === 'behind') segments.push({ key: 'conflicts', label: `Behind ${d.base.ref}`, tone: 'attention', icon: 'sync', jump })
    else segments.push({ key: 'conflicts', label: 'No conflicts', tone: 'ok', icon: 'check', jump })
  }
  if (proposal) {
    segments.push({
      key: 'agent', label: `${agent?.title ?? 'Agent'} proposes ${PROPOSAL_VERB[proposal.action]}`, tone: 'agent',
      jump: { tab: 'conversation', section: 'merge' }
    })
  } else if (agent) {
    segments.push({ key: 'agent', label: `${agent.title} ${agent.state ?? 'idle'}`, tone: 'agent', jump: { tab: 'conversation', section: 'agent' } })
  }
  return segments
}

export type NextStepKind = 'reopen' | 'ready' | 'conflicts' | 'checks' | 'threads' | 'merge'
export interface NextStep { kind: NextStepKind; label: string; tone: 'primary' | 'attention' | 'danger' | 'neutral'; icon: IconName }

/** The one button the header leads with, by what blocks the PR first. Merged = none. */
export function nextStep({ detail: d, checks, openThreads, method }: ReadinessInput & { method?: PullMergeMethod }): NextStep | null {
  if (d.lifecycle === 'merged') return null
  if (d.lifecycle === 'closed') return { kind: 'reopen', label: 'Reopen', tone: 'neutral', icon: 'pr' }
  if (d.lifecycle === 'draft') return { kind: 'ready', label: 'Ready for review', tone: 'neutral', icon: 'eye' }
  if (d.merge === 'conflict') return { kind: 'conflicts', label: 'Resolve conflicts', tone: 'danger', icon: 'conflict' }
  if (headChecks(checks, d.head.sha)?.some((check) => check.state === 'failed')) {
    return { kind: 'checks', label: 'Fix checks', tone: 'danger', icon: 'x' }
  }
  if (openThreads) return { kind: 'threads', label: `Review ${plural(openThreads, 'open thread')}`, tone: 'attention', icon: 'thread' }
  return { kind: 'merge', label: method ? METHOD_TEXT[method] : 'Merge', tone: 'primary', icon: 'merge' }
}
