import { useEffect, useState } from 'react'
import type { GitHubPullConversationResult, GitHubPullDetailResult, PullLineDraft } from '@shared/github-pull-detail'
import type { AgentState } from '@shared/agents/normalize'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { Icon } from './Icon'
import { PullComposer } from './PullComposer'
import { PullMergeBox } from './PullMergeBox'
import { PullSidebar } from './PullSidebar'
import { PullTimeline } from './PullTimeline'
import { readState, STALE_TEXT, type Read, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

/** Below this width (the tab's own, unscaled by canvas zoom) the sidebar folds into one Details row. */
export const CONVERSATION_FOLD_PX = 760

/** True while `element` is narrower than `px`. ResizeObserver is the outside system; without one
 *  (jsdom) the layout stays two columns. */
function useNarrow(element: HTMLElement | null, px: number): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => { if (entry) setNarrow(entry.contentRect.width < px) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, px])
  return narrow
}

/** The Conversation tab (F1): the timeline (the description first), the agent proposal bar, the
 *  merge box and the comment box in the left column; the 232 px sidebar on the right, folded into
 *  one Details row when the tab is narrow. The node's detail, conversation and checks reads come
 *  from the shell, so the header, the proposal bar and this tab show one head. */
export function PullConversationTab(props: ViewProps & {
  detailRead: Read<GitHubPullDetailResult>; conversation: Read<GitHubPullConversationResult>; checks: PullChecksRead; ownPull: boolean
  pending: readonly PullLineDraft[]; onDropPending: (sent: readonly PullLineDraft[]) => void
  methods: MergeMethodsRead; onLoadMethods: () => void
  /** The shell's agent proposal bar, shown right above the merge box. */
  proposalBar?: React.ReactNode
  /** The first linked agent's live state, for the sidebar's Agent section. */
  agentState?: AgentState
}): React.JSX.Element {
  const { pull, detailRead, conversation, checks } = props
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const narrow = useNarrow(root, CONVERSATION_FOLD_PX)
  const [details, setDetails] = useState(false)
  const convo = conversation !== 'loading' && conversation.status === 'ok' ? conversation : undefined
  if (detailRead === 'loading' || detailRead.status !== 'ok') return readState(detailRead, pull.repository)
  const { detail: d } = detailRead
  const sidebar = <PullSidebar {...props} detail={d} avatars={detailRead.avatarDataUrls} />
  const s = d.sidebar
  const summary = [
    s?.reviewers?.length && `${s.reviewers.length} ${s.reviewers.length === 1 ? 'reviewer' : 'reviewers'}`,
    s?.labels?.length && `${s.labels.length} ${s.labels.length === 1 ? 'label' : 'labels'}`,
    props.agents?.[0]?.title
  ].filter(Boolean).join(' · ')
  return (
    <div ref={setRoot} className={`pull-node__conversation pr-convo${narrow ? ' pr-convo--narrow' : ''}`}>
      <div className="pr-convo__main">
        {detailRead.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[detailRead.stale]}</p>}
        {narrow && (
          // ponytail: folded, the Agent section is unmounted, so a jump to "agent" finds nothing until it opens.
          <div className="pr-fold" data-pull-section="details">
            <button className="pr-fold__row" aria-expanded={details} onClick={() => setDetails(!details)}>
              <span className="pr-fold__label">Details</span>
              {summary && <span className="pr-fold__summary">{summary}</span>}
              <Icon name="chevron" className={details ? 'pr-fold__chevron pr-fold__chevron--open' : 'pr-fold__chevron'} />
            </button>
            {details && sidebar}
          </div>
        )}
        <PullTimeline {...props} detail={d} lineComments={convo?.lineComments ?? []} resolvedThreads={convo?.resolvedThreads}
          detailAvatars={{ ...detailRead.avatarDataUrls, ...convo?.avatarDataUrls }} />
        {props.proposalBar}
        <PullMergeBox {...props} detail={d} checks={checks} />
        <PullComposer {...props} headSha={d.head.sha} lifecycle={d.lifecycle} />
      </div>
      {!narrow && sidebar}
    </div>
  )
}
