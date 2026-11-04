import { useCallback, useState } from 'react'
import type { PullLineDraft } from '@shared/github-pull-detail'
import type { PullNodeRef, PullNodeTab } from '@shared/pull-node'
import type { PullHighlight, ShownProposal } from '@shared/pull-agent-verbs'
import { usePullChecks } from '../components/kanban/GitHubIssueSummaryModal'
import { PullConversationTab } from './pull/PullConversationTab'
import { PullFilesTab } from './pull/PullFilesTab'
import { PullHeader } from './pull/PullHeader'
import { PullProposalBar } from './pull/PullProposalBar'
import { PullTabBar, shownPullTab } from './pull/PullTabBar'
import { AllowContext, usePullRead, type ViewProps } from './pull/shared'

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
function PullTabs({ onTab, onSelectFile, proposal, onDismiss, highlight, ...props }: TabsProps): React.JSX.Element {
  const { api, projectId, pull, onOpenExternal } = props
  const shownTab = shownPullTab(pull.tab)
  const [opened, setOpened] = useState<readonly PullNodeTab[]>([shownTab])
  if (!opened.includes(shownTab)) setOpened([...opened, shownTab])
  const detailRead = usePullRead(api.pullDetail, props)
  const detail = detailRead !== 'loading' && detailRead.status === 'ok' ? detailRead.detail : undefined
  const ownPull = detailRead !== 'loading' && detailRead.status === 'ok' && detailRead.ownPull === true
  const readsChecks = detail && (detail.lifecycle === 'open' || detail.lifecycle === 'draft')
  const checks = usePullChecks(api, readsChecks ? projectId : undefined, pull.pullNumber, detail?.head.sha, props.refreshTick)
  // New line comments waiting for the next review submit. ponytail: kept in memory only; closing
  // the node drops them (nothing was sent).
  const [pending, setPending] = useState<readonly PullLineDraft[]>([])
  const addPending = useCallback((draft: PullLineDraft) => setPending((list) => [...list, draft]), [])
  // Drops only the drafts named: one added while a review was on its way stays for the next.
  const dropPending = useCallback((sent: readonly PullLineDraft[]) =>
    setPending((list) => list.filter((draft) => !sent.includes(draft))), [])
  return (
    <AllowContext.Provider value={props.onAllow}>
      <PullHeader pull={pull} detail={detail} />
      <PullTabBar pull={pull} shown={shownTab} detail={detail} onTab={onTab} onOpenExternal={onOpenExternal} />
      {proposal && (
        <PullProposalBar key={proposal.seq} {...props} proposal={proposal} seen={detail} seenChecks={checks} ownPull={ownPull}
          onDismiss={() => onDismiss?.()} />
      )}
      {opened.includes('conversation') && (
        <div hidden={shownTab !== 'conversation'}>
          <PullConversationTab {...props} detailRead={detailRead} checks={checks} ownPull={ownPull} pending={pending}
            onDropPending={dropPending} />
        </div>
      )}
      {opened.includes('files') && (
        <div hidden={shownTab !== 'files'}>
          <PullFilesTab {...props} head={detail?.head.sha} onSelectFile={onSelectFile} highlight={highlight} pending={pending}
            onAddPending={addPending} />
        </div>
      )}
    </AllowContext.Provider>
  )
}
