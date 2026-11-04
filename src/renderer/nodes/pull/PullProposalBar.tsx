import { useEffect, useState } from 'react'
import type { GitHubPullDetail, PullWriteReason, PullWriteResult } from '@shared/github-pull-detail'
import type { PullProposal } from '@shared/pull-agent-verbs'
import { mergeBlock, type PullChecksRead } from '../../lib/pullMergeBlock'
import { FAILURE_TEXT, METHOD_TEXT, OWN_PULL_TEXT, REFUSAL_TEXT, WRITE_TEXT, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

const PROPOSAL_TEXT: Record<PullProposal['action'], string> = {
  approve: 'Approve', 'request-changes': 'Request changes on', comment: 'Comment on', merge: 'Merge'
}

/** Confirm stays off this long after a proposal is shown or replaced, so an agent cannot swap the
 *  action under a click already on its way (security review of #19). */
const PROPOSAL_ARM_MS = 1_000



/**
 * The linked agent's proposed action (`pr-propose`), shown right above the merge box (above the tab
 * content on another tab, or before the detail read landed). It names exactly what will
 * be sent; nothing is sent until Confirm, which runs the same write, behind the same guards, as the
 * node's own buttons. A review and a merge are tied to the head the node shows, as there.
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

  const confirm = async () => {
    if (busy || !armed) return
    let write: Promise<PullWriteResult>
    if (proposal.action === 'merge') {
      if (!method || !seenHead) return
      write = api.mergePull({ ...at, method, headSha: seenHead })
    } else if (proposal.action === 'comment') {
      write = api.commentOnPull({ ...at, body: proposal.message })
    } else {
      if (!seenHead || ownPull) return
      write = api.reviewPull({
        ...at, event: proposal.action === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES', body: proposal.message, headSha: seenHead
      })
    }
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
  return (
    <div className="pull-proposal" role="region" aria-label="Agent proposal">
      <p className="pull-proposal__what">
        Your agent proposes:{' '}
        {isMerge && seen
          ? <>Merge <strong>#{seen.number} {seen.title}</strong> into <code>{seen.base.ref}</code></>
          : <strong>{PROPOSAL_TEXT[proposal.action]} #{pull.pullNumber}</strong>}
        {method && <> ({METHOD_TEXT[method]})</>}
      </p>
      {proposal.action !== 'merge' && proposal.message.trim() && (
        <blockquote className="pull-proposal__message">{proposal.message}</blockquote>
      )}
      {(blocked ?? refused) && <p className="pull-node__empty">{blocked ?? refused}</p>}
      {refusal && <p className="pull-compose__error" role="alert">{WRITE_TEXT[refusal]}</p>}
      <div className="pull-compose__actions">
        {!refused && (
          <button className="pull-compose__button pull-merge__confirm" disabled={busy || !armed || !!blocked || waiting}
            onClick={() => void confirm()}>Confirm</button>
        )}
        <button className="pull-compose__button" disabled={busy} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
