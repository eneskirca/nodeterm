// `pr-show` and `pr-propose`: the agent linked to a pull node drives it on the user's word.
// `pr-show` only moves the node's view (tab, file, highlighted lines). `pr-propose` only puts ONE
// pending action on the node; the node shows it with Confirm, and only that click runs the write
// (renderer/nodes/PullNodeView.tsx). Nothing here, or in the dispatch, can reach a GitHub write, so
// text inside a PR that talks the agent into "approve and merge" still stops at the user's click.
import type { PullMergeMethod } from './github-pull-detail'
import { isSafeNodeId } from './safe-id'
import type { PullNodeTab } from './pull-node'

export interface PullShow {
  tab: PullNodeTab
  file?: string
  lines?: { start: number; end: number }
}

export type PullProposal =
  | { action: 'approve' | 'request-changes' | 'comment'; message: string }
  | { action: 'merge'; method?: PullMergeMethod }

type Parsed<T> = ({ ok: true; node: string } & T) | { ok: false; error: string }

const SHOW_FLAGS = new Set(['node', 'tab', 'file', 'lines'])
const PROPOSE_FLAGS = new Set(['node', 'action', 'message', 'method'])
const TABS: readonly PullNodeTab[] = ['overview', 'files', 'conversation']
const ACTIONS = ['approve', 'request-changes', 'comment', 'merge'] as const
const METHODS: readonly PullMergeMethod[] = ['merge', 'squash', 'rebase']
const MAX_MESSAGE = 60_000

function shared(verb: string, args: Record<string, string | undefined>, flags: Set<string>): string | null {
  const unknown = Object.keys(args).find((k) => !flags.has(k))
  if (unknown) return `${verb}: unknown flag --${unknown}`
  if (!args.node || !isSafeNodeId(args.node)) return `${verb} requires --node <pull node id> (open-pr printed it)`
  return null
}

export function parsePrShow(args: Record<string, string | undefined>): Parsed<{ show: PullShow }> {
  const refusal = shared('pr-show', args, SHOW_FLAGS)
  if (refusal) return { ok: false, error: refusal }
  const { tab, file, lines } = args
  if (tab !== undefined && !TABS.includes(tab as PullNodeTab)) {
    return { ok: false, error: 'pr-show: --tab is overview, files or conversation' }
  }
  if (file !== undefined) {
    // eslint-disable-next-line no-control-regex
    if (!file || file.length > 1_024 || /[\u0000-\u001f\u007f]/.test(file)) return { ok: false, error: 'pr-show: --file is a path the PR changes' }
    if (tab !== undefined && tab !== 'files') return { ok: false, error: 'pr-show: --file opens the files tab; leave out --tab' }
  }
  let range: PullShow['lines']
  if (lines !== undefined) {
    const match = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(lines.trim())
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : start
    if (file === undefined || start < 1 || end < start) {
      return { ok: false, error: 'pr-show: --lines <start>[-<end>] needs --file, with start <= end' }
    }
    range = { start, end }
  }
  if (tab === undefined && file === undefined) return { ok: false, error: 'pr-show requires --tab or --file' }
  const show: PullShow = file !== undefined
    ? { tab: 'files', file, ...(range ? { lines: range } : {}) }
    : { tab: tab as PullNodeTab }
  return { ok: true, node: args.node!, show }
}

export function parsePrPropose(args: Record<string, string | undefined>): Parsed<{ proposal: PullProposal }> {
  const refusal = shared('pr-propose', args, PROPOSE_FLAGS)
  if (refusal) return { ok: false, error: refusal }
  const action = ACTIONS.find((a) => a === args.action)
  if (!action) return { ok: false, error: 'pr-propose: --action is approve, request-changes, comment or merge' }
  if (action === 'merge') {
    if (args.message !== undefined) return { ok: false, error: 'pr-propose: --action merge takes no --message' }
    if (args.method !== undefined && !METHODS.includes(args.method as PullMergeMethod)) {
      return { ok: false, error: 'pr-propose: --method is merge, squash or rebase' }
    }
    return { ok: true, node: args.node!, proposal: { action, ...(args.method ? { method: args.method as PullMergeMethod } : {}) } }
  }
  if (args.method !== undefined) return { ok: false, error: 'pr-propose: --method is for --action merge only' }
  const message = args.message ?? ''
  if (message.length > MAX_MESSAGE) return { ok: false, error: 'pr-propose: --message is too long' }
  if (action !== 'approve' && !message.trim()) return { ok: false, error: `pr-propose: --action ${action} requires --message` }
  return { ok: true, node: args.node!, proposal: { action, message } }
}

/** The shape gate the core parser and desktop main run before forwarding. Null for other verbs. */
export function pullAgentArgsRefusal(verb: string, args: Record<string, string | undefined>): string | null {
  const parsed = verb === 'pr-show' ? parsePrShow(args) : verb === 'pr-propose' ? parsePrPropose(args) : null
  return parsed && !parsed.ok ? parsed.error : null
}
