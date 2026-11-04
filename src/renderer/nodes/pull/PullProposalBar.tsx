import { useEffect, useState } from 'react'
import type { GitHubPullDetail, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import type { PullProposal } from '@shared/pull-agent-verbs'
import { mergeBlock, type PullChecksRead } from '../../lib/pullMergeBlock'
import { Icon } from './Icon'
import { FAILURE_TEXT, METHOD_TEXT, OWN_PULL_TEXT, REFUSAL_TEXT, WRITE_TEXT, type PullNodeApi, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'
import './PullMergeBox.css'

const PROPOSAL_TEXT: Record<Exclude<PullProposal['action'], 'merge'>, string> = {
  approve: 'an approval', 'request-changes': 'requesting changes', comment: 'a comment'
}

/** Confirm stays off this long after a proposal is shown or replaced, so an agent cannot swap the
 *  action under a click already on its way (security review of #19). */
const PROPOSAL_ARM_MS = 1_000

/** The one write Confirm sends: its bridge call and the exact arguments, shown under Details. */
type Call =
  | { name: 'mergePull'; args: Parameters<PullNodeApi['mergePull']>[0] }
  | { name: 'reviewPull'; args: Parameters<PullNodeApi['reviewPull']>[0] }
  | { name: 'commentOnPull'; args: Parameters<PullNodeApi['commentOnPull']>[0] }

/**
 * The linked agent's proposed action (`pr-propose`), as the top of the merge card (F1) on the
 * Conversation tab (under the tab bar on another tab, or before the detail read landed). It names
 * what will be sent, and Details shows the exact call (method, head SHA); nothing is sent until
 * Confirm, which runs that same call, behind the same guards, as the node's own buttons. A review and
 * a merge are tied to the head the node shows, as there.
 */
export function PullProposalBar(props: ViewProps & {
  proposal: PullProposal; seen: GitHubPullDetail | undefined; seenChecks: PullChecksRead
  ownPull: boolean; onDismiss: () => void
  /** The shell's one read of the allowed methods, shared with the merge box (null = not asked yet). */
  methods: MergeMethodsRead
}): React.JSX.Element {
  const { api, projectId, pull, proposal, seen, seenChecks, ownPull, onDismiss, onWritten } = props
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const [refusal, setRefusal] = useState<PullWriteReason | null>(null)
  const isMerge = proposal.action === 'merge'
  // The bar remounts per proposal (keyed by its seq), so this runs once per shown proposal.
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), PROPOSAL_ARM_MS)
    return () => clearTimeout(timer)
  }, [])
  // One read of the allowed methods (the shell's) serves both a proposal that names one and one that does not.
  const methods = props.methods ?? 'loading'
  const allowed = methods !== 'loading' && methods.status === 'ok' ? methods.methods : null
  const method = proposal.action !== 'merge' || !allowed
    ? null
    : proposal.method ? (allowed.includes(proposal.method) ? proposal.method : null) : allowed[0] ?? null
  const seenHead = seen?.head.sha
  const at = { projectId, repository: pull.repository, pullNumber: pull.pullNumber }
  // ponytail: only one linked agent can be named; with several, any of them may have proposed.
  const who = props.agents?.length === 1 ? props.agents[0].title : 'Your agent'

  const call: Call | null = proposal.action === 'merge'
    ? method && seenHead ? { name: 'mergePull', args: { ...at, method, headSha: seenHead } } : null
    : proposal.action === 'comment'
      ? { name: 'commentOnPull', args: { ...at, body: proposal.message } }
      : seenHead && !ownPull
        ? { name: 'reviewPull', args: { ...at, event: proposal.action === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES', body: proposal.message, headSha: seenHead } }
        : null

  const confirm = async () => {
    if (busy || !armed || !call) return
    const write: Promise<PullWriteResult> = call.name === 'mergePull' ? api.mergePull(call.args)
      : call.name === 'reviewPull' ? api.reviewPull(call.args) : api.commentOnPull(call.args)
    setBusy(true)
    setRefusal(null)
    const outcome = await write.catch((): PullWriteResult => ({ ok: false, reason: 'network' }))
    setBusy(false)
    if (!outcome.ok) {
      setRefusal(outcome.reason)
      if (outcome.reason === 'head-moved') onWritten()
      return
    }
    onDismiss()
    onWritten()
  }

  // Why Confirm is off, in the same words the node's own buttons use. `refused` = no Confirm at all.
  const needsDetail = 'The pull request has not loaded yet: the action is tied to the commit it shows.'
  let blocked: string | null = null
  let refused: string | null = null
  if (proposal.action === 'merge') {
    const why = seen ? mergeBlock(seen, seenChecks)?.text ?? null : needsDetail
    if (why) blocked = why
    else if (methods === 'loading') blocked = null
    else if (methods.status === 'refused') refused = REFUSAL_TEXT[methods.reason](pull.repository)
    else if (methods.status === 'failed') refused = FAILURE_TEXT[methods.reason]
    else if (proposal.method && !methods.methods.includes(proposal.method)) {
      refused = `This repository does not allow ${METHOD_TEXT[proposal.method]}. Merge with another method, or on GitHub.`
    } else if (!method) refused = 'This repository allows no merge method for your GitHub token. Merge on GitHub instead.'
  } else if (proposal.action !== 'comment') {
    // A comment is not tied to a head, as in the Conversation tab; a review is.
    blocked = ownPull ? OWN_PULL_TEXT : !seenHead ? needsDetail : null
  }
  const waiting = isMerge && methods === 'loading'
  const what = proposal.action === 'merge'
    ? method ? METHOD_TEXT[method].toLowerCase() : 'a merge'
    : PROPOSAL_TEXT[proposal.action]
  // The call's arguments as sent, minus the project id (this node's own, not the agent's choice).
  const shown = call && (({ projectId: _, ...rest }) => rest)(call.args)
  return (
    <div className="pull-proposal" role="region" aria-label="Agent proposal">
      <div className="pr-proposal">
        <div className="pr-proposal__head">
          <Icon name="agent" className="pr-proposal__icon" />
          <span className="pr-proposal__what">
            <strong>{who} proposes {what}</strong>
            {proposal.action !== 'comment' && seenHead && <span className="pr-proposal__at"> at {seenHead.slice(0, 7)}</span>}
          </span>
          <span className="pr-proposal__actions">
            <button type="button" className="pr-btn" disabled={busy} onClick={onDismiss}>Dismiss</button>
            {!refused && (
              <button type="button" className="pr-btn pr-btn--primary" disabled={busy || !armed || !!blocked || waiting || !call}
                onClick={() => void confirm()}>Confirm</button>
            )}
          </span>
        </div>
        <p className="pr-proposal__target">
          {isMerge && seen
            ? <>Merge <strong>#{seen.number} {seen.title}</strong> into <code>{seen.base.ref}</code></>
            : <>On <strong>#{pull.pullNumber}{seen ? ` ${seen.title}` : ''}</strong></>}
        </p>
        {proposal.action !== 'merge' && proposal.message.trim() && (
          <blockquote className="pr-proposal__message">{proposal.message}</blockquote>
        )}
        {(blocked ?? refused) && <p className="pr-mbox__note">{blocked ?? refused}</p>}
        {refusal && <p className="pr-mbox__error" role="alert">{WRITE_TEXT[refusal]}</p>}
        {call && shown && (
          <details className="pr-proposal__details">
            <summary>Details</summary>
            <pre className="pr-proposal__call" aria-label="Exact call">{`${call.name}(${JSON.stringify(shown, null, 2)})`}</pre>
          </details>
        )}
      </div>
    </div>
  )
}
