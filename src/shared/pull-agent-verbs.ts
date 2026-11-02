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

/** A proposal as the node holds it: `seq` grows on every `pr-propose`, so a replaced one remounts. */
export type ShownProposal = PullProposal & { seq: number }

/** The lines `pr-show --lines` marks in one file of the Files tab. `seq` makes a repeat show re-reveal. */
export type PullHighlight = { file: string; start: number; end: number; seq: number }

type Parsed<T> = ({ ok: true; node: string } & T) | { ok: false; error: string }

const SHOW_FLAGS = new Set(['node', 'tab', 'file', 'lines'])
const PROPOSE_FLAGS = new Set(['node', 'action', 'message', 'method'])
const TABS: readonly PullNodeTab[] = ['overview', 'files', 'conversation']
const ACTIONS = ['approve', 'request-changes', 'comment', 'merge'] as const
const METHODS: readonly PullMergeMethod[] = ['merge', 'squash', 'rebase']
const MAX_MESSAGE = 60_000

function commonRefusal(verb: string, args: Record<string, string | undefined>, flags: Set<string>): { error: string } | { node: string } {
  const unknown = Object.keys(args).find((k) => !flags.has(k))
  if (unknown) return { error: `${verb}: unknown flag --${unknown}` }
  if (!args.node || !isSafeNodeId(args.node)) return { error: `${verb} requires --node <pull node id> (open-pr printed it)` }
  return { node: args.node }
}

export function parsePrShow(args: Record<string, string | undefined>): Parsed<{ show: PullShow }> {
  const gate = commonRefusal('pr-show', args, SHOW_FLAGS)
  if ('error' in gate) return { ok: false, error: gate.error }
  const { node } = gate
  const { file, lines } = args
  const tab = TABS.find((t) => t === args.tab)
  if (args.tab !== undefined && !tab) {
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
  if (file !== undefined) return { ok: true, node, show: { tab: 'files', file, ...(range ? { lines: range } : {}) } }
  if (!tab) return { ok: false, error: 'pr-show requires --tab or --file' }
  return { ok: true, node, show: { tab } }
}

export function parsePrPropose(args: Record<string, string | undefined>): Parsed<{ proposal: PullProposal }> {
  const gate = commonRefusal('pr-propose', args, PROPOSE_FLAGS)
  if ('error' in gate) return { ok: false, error: gate.error }
  const { node } = gate
  const action = ACTIONS.find((a) => a === args.action)
  if (!action) return { ok: false, error: 'pr-propose: --action is approve, request-changes, comment or merge' }
  if (action === 'merge') {
    if (args.message !== undefined) return { ok: false, error: 'pr-propose: --action merge takes no --message' }
    const method = METHODS.find((m) => m === args.method)
    if (args.method !== undefined && !method) {
      return { ok: false, error: 'pr-propose: --method is merge, squash or rebase' }
    }
    return { ok: true, node, proposal: { action, ...(method ? { method } : {}) } }
  }
  if (args.method !== undefined) return { ok: false, error: 'pr-propose: --method is for --action merge only' }
  const message = args.message ?? ''
  if (message.length > MAX_MESSAGE) return { ok: false, error: 'pr-propose: --message is too long' }
  if (action !== 'approve' && !message.trim()) return { ok: false, error: `pr-propose: --action ${action} requires --message` }
  return { ok: true, node, proposal: { action, message } }
}

/** The shape gate the core parser and desktop main run before forwarding. Null for other verbs. */
export function pullAgentArgsRefusal(verb: string, args: Record<string, string | undefined>): string | null {
  const parsed = verb === 'pr-show' ? parsePrShow(args) : verb === 'pr-propose' ? parsePrPropose(args) : null
  return parsed && !parsed.ok ? parsed.error : null
}
