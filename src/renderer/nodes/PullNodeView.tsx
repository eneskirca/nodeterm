import { useCallback, useRef, useState } from 'react'
import type { PullLineDraft } from '@shared/github-pull-detail'
import type { PullNodeRef, PullNodeTab } from '@shared/pull-node'
import type { PullHighlight, ShownProposal } from '@shared/pull-agent-verbs'
import type { AgentState } from '@shared/agents/normalize'
import { usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { PullChecksTab } from './pull/PullChecksTab'
import { PullCommitsTab } from './pull/PullCommitsTab'
import { PullConversationTab } from './pull/PullConversationTab'
import { PullFilesTab } from './pull/PullFilesTab'
import { NextAction } from './pull/NextAction'
import { PullHeader } from './pull/PullHeader'
import { PullProposalBar } from './pull/PullProposalBar'
import { PullTabBar, shownPullTab } from './pull/PullTabBar'
import { ReadinessBar } from './pull/ReadinessBar'
import { nextStep, openThreadCount, pullReadiness, type PullJump } from './pull/readiness'
import { AllowContext, usePullRead, type ViewProps } from './pull/shared'
import { useMergeMethods } from './pull/useMergeMethods'
import { useMergeMethod, useUpdateBranch } from './pull/mergeActions'
import { PullJumpContext } from './pull/PullJumpContext'
import { SendToProvider, type SendToHost } from './pull/SendTo'
import { PullZoomCard } from './pull/PullZoomCard'
import { PullSinceReviewBanner, SINCE_REVIEW, useSinceReview } from './pull/PullSinceReviewBanner'
import { PullNotesButton, usePullNotes, type PullNotesApi } from './pull/PullNotes'

export type { PullNodeApi } from './pull/shared'

type TabsProps = ViewProps & {
  onTab: (tab: PullNodeTab) => void
  /** The Files tab picked a file; the frame persists it as `selectedFile`. */
  onSelectFile: (path: string) => void
  /** The linked agent's pending action (`pr-propose`). Only Confirm here sends it. */
  proposal?: ShownProposal
  onDismiss?: () => void
  /** Lines the linked agent pointed at (`pr-show --lines`), in one file of the Files tab. */
  highlight?: PullHighlight
  /** The canvas side of "Send to…" (PullNode); absent = no picker. */
  sendToHost?: SendToHost
  /** The live state of the first linked agent (`agents[0]`), for the readiness bar. */
  agentState?: AgentState
  /** Writes text to the clipboard (Copy link, Copy branch name). */
  onCopy?: (text: string) => void
  /** Canvas zoom under 50% (F-09): show the status card; the full view stays mounted, hidden. */
  zoomedOut?: boolean
  /** F-07: the machine-local notes store; absent = no notes (the composer's "Note for agent" is off). */
  notesApi?: PullNotesApi
}

/**
 * The pull request node's body (nodes/PullNode.tsx is the canvas frame around it). Takes the bridge
 * as a prop so a test can hand it a fake. The parts live in nodes/pull/: a header, a tab bar, one
 * component per tab, and the proposal bar.
 */
export function PullNodeView({
  pull,
  projectId,
  ...rest
}: Omit<TabsProps, 'pull' | 'projectId'> & {
  projectId: string | null
  pull: PullNodeRef | undefined
}): React.JSX.Element {
  if (!pull || !projectId) {
    return <p className="pull-node__state" role="status">This node has no valid pull request reference.</p>
  }
  return <PullTabs {...rest} pull={pull} projectId={projectId} />
}

/** The shell reads the detail and the checks once for every part, so the header, the tab counts,
 *  the proposal bar and each tab show the same head. A tab mounts the first time it is shown and
 *  then stays mounted (hidden when not shown), so a switch back costs no read and a draft typed in
 *  a tab survives the switch. */
function PullTabs({ onTab, onSelectFile, proposal, onDismiss, highlight, sendToHost, agentState, onCopy, zoomedOut, notesApi, ...props }: TabsProps): React.JSX.Element {
  const { api, projectId, pull } = props
  const shownTab = shownPullTab(pull.tab)
  const [opened, setOpened] = useState<readonly PullNodeTab[]>([shownTab])
  if (!opened.includes(shownTab)) setOpened([...opened, shownTab])
  const detailRead = usePullRead(api.pullDetail, props)
  const detail = detailRead !== 'loading' && detailRead.status === 'ok' ? detailRead.detail : undefined
  const ownPull = detailRead !== 'loading' && detailRead.status === 'ok' && detailRead.ownPull === true
  const readsChecks = detail && (detail.lifecycle === 'open' || detail.lifecycle === 'draft')
  const checks = usePullChecks(api, readsChecks ? projectId : undefined, pull.pullNumber, detail?.head.sha, props.refreshTick)
  // One conversation read for the readiness bar, the Conversation tab and the Files tab's threads.
  // ponytail: read even when the node opens on another tab.
  const conversation = usePullRead(api.pullConversation, props)
  const openThreads = openThreadCount(conversation)
  // F-10: one read of the comparison to the viewer's last review, for the banner and Files' Compare.
  const sinceReview = useSinceReview(props)
  const [compareTo, setCompareTo] = useState<{ value: string }>()
  const diffSinceReview = useCallback(() => { setCompareTo({ value: SINCE_REVIEW }); onTab('files') }, [onTab])
  // One read of the allowed merge methods for the merge box's select (once the Conversation tab
  // shows an open PR) and a merge proposal.
  const mergeMethods = useMergeMethods(api, projectId, pull.repository,
    (opened.includes('conversation') && detail?.lifecycle === 'open') || proposal?.action === 'merge')
  // New line comments waiting for the next review submit. ponytail: kept in memory only; closing
  // the node drops them (nothing was sent).
  const notes = usePullNotes(notesApi, pull)
  const [pending, setPending] = useState<readonly PullLineDraft[]>([])
  const addPending = useCallback((draft: PullLineDraft) => setPending((list) => [...list, draft]), [])
  // Drops only the drafts named: one added while a review was on its way stays for the next.
  const dropPending = useCallback((sent: readonly PullLineDraft[]) =>
    setPending((list) => list.filter((draft) => !sent.includes(draft))), [])
  const proposalBar = proposal && (
    <PullProposalBar key={proposal.seq} {...props} proposal={proposal} seen={detail} seenChecks={checks} ownPull={ownPull}
      methods={mergeMethods.methods} onDismiss={() => onDismiss?.()} />
  )
  // The bar is the merge card's top section, where the user acts. On another tab, or before the
  // detail read landed (no merge box yet), it sits under the tab bar so it is never out of sight.
  // ponytail: a move between the two spots remounts the bar, which restarts its one-second arm delay.
  const barAboveMerge = shownTab === 'conversation' && !!detail
  // A readiness segment or the lead button: switch tab, then scroll to its marked section.
  const top = useRef<HTMLDivElement>(null)
  const jump = useCallback(({ tab, section }: PullJump) => {
    onTab(tab)
    if (!section) return
    setTimeout(() => top.current?.parentElement?.querySelector(`[data-pull-section="${section}"]`)
      ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 0)
  }, [onTab])
  const firstAgent = props.agents?.[0]
  const readiness = detail && { detail, checks, openThreads, proposal, agent: firstAgent && { title: firstAgent.title, state: agentState } }
  const segments = readiness ? pullReadiness(readiness) : []
  // One picked method and one Update branch for the header and the merge box.
  const { method, pick: pickMethod } = useMergeMethod(mergeMethods.methods)
  const update = useUpdateBranch(props, detail)
  // F-10 "Show only new": the timeline keeps what came after the viewer's last review.
  const [onlyNew, setOnlyNew] = useState(false)
  const onlyNewAfter = onlyNew && sinceReview.since?.kind === 'moved' ? sinceReview.since.submittedAt : undefined
  const conversationCount = conversation !== 'loading' && conversation.status === 'ok' ? conversation.items.length : undefined
  return (
    <AllowContext.Provider value={props.onAllow}>
      <SendToProvider host={sendToHost} agents={props.agents} pr={{ repository: pull.repository, number: pull.pullNumber, title: detail?.title ?? '' }}>
        {zoomedOut && <PullZoomCard pull={pull} detail={detail} segments={segments} proposal={proposal} />}
        <div hidden={zoomedOut}>
          <PullJumpContext.Provider value={jump}>
            <div ref={top} className="pr-top">
              <PullHeader pull={pull} detail={detail} onCopy={onCopy}
                avatars={detailRead !== 'loading' && detailRead.status === 'ok' ? detailRead.avatarDataUrls : undefined}
                action={readiness && <NextAction {...props} detail={readiness.detail} onJump={jump} onCopy={onCopy} update={update}
                  next={nextStep({ ...readiness, method: method ?? undefined })} />} />
              {readiness && <ReadinessBar segments={segments} onJump={jump} />}
            </div>
            <PullTabBar shown={shownTab} detail={detail} checks={checks} conversationCount={conversationCount} onTab={onTab}
              extra={notesApi && <PullNotesButton notes={notes.notes} error={notes.error} onClear={notes.clear} />} />
            {!barAboveMerge && proposalBar}
            {opened.includes('conversation') && (
              <div hidden={shownTab !== 'conversation'}>
                <PullSinceReviewBanner since={sinceReview.since} onDiff={diffSinceReview} onlyNew={onlyNew} onOnlyNew={setOnlyNew} />
                <PullConversationTab {...props} detailRead={detailRead} conversation={conversation} checks={checks} ownPull={ownPull} pending={pending}
                  onDropPending={dropPending} methods={mergeMethods.methods} onLoadMethods={mergeMethods.load}
                  method={method} onPickMethod={pickMethod} update={update} onlyNewAfter={onlyNewAfter}
                  proposalBar={barAboveMerge ? proposalBar : undefined} agentState={agentState} />
              </div>
            )}
            {opened.includes('commits') && (
              <div hidden={shownTab !== 'commits'}>
                <PullCommitsTab {...props} />
              </div>
            )}
            {opened.includes('checks') && (
              <div hidden={shownTab !== 'checks'}>
                <PullChecksTab {...props} checks={checks} head={detail?.head.sha} />
              </div>
            )}
            {opened.includes('files') && (
              <div hidden={shownTab !== 'files'}>
                <PullFilesTab {...props} head={detail?.head.sha} onSelectFile={onSelectFile} highlight={highlight} pending={pending}
                  onAddPending={addPending} ownPull={ownPull} onDropPending={dropPending} conversation={conversation}
                  compareExtra={sinceReview.compareExtra} compareTo={compareTo}
                  onNoteForAgent={notesApi ? notes.add : undefined} notes={notes.notes} onDeleteNote={notesApi ? notes.remove : undefined} />
              </div>
            )}
          </PullJumpContext.Provider>
        </div>
      </SendToProvider>
    </AllowContext.Provider>
  )
}
