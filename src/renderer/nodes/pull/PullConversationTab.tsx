import type { GitHubPullDetailResult, PullLineDraft } from '@shared/github-pull-detail'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { PullComposer } from './PullComposer'
import { PullMergeBox } from './PullMergeBox'
import { PullSendToAgent } from './PullSendToAgent'
import { PullSidebar } from './PullSidebar'
import { PullTimeline } from './PullTimeline'
import { readState, STALE_TEXT, usePullRead, type Read, type ViewProps } from './shared'
import type { MergeMethodsRead } from './useMergeMethods'

/** The Conversation tab: the timeline (the description first), the agent proposal bar, the merge
 *  box, then the comment box. The conversation read gives only the reviews' line comments. The node's detail and checks reads come from the shell, so the header, the proposal bar and
 *  this tab show one head. */
export function PullConversationTab(props: ViewProps & {
  detailRead: Read<GitHubPullDetailResult>; checks: PullChecksRead; ownPull: boolean
  pending: readonly PullLineDraft[]; onDropPending: (sent: readonly PullLineDraft[]) => void
  methods: MergeMethodsRead; onLoadMethods: () => void
  /** The shell's agent proposal bar, shown right above the merge box. */
  proposalBar?: React.ReactNode
}): React.JSX.Element {
  const { api, pull, detailRead, checks } = props
  const conversation = usePullRead(api.pullConversation, props)
  const convo = conversation !== 'loading' && conversation.status === 'ok' ? conversation : undefined
  if (detailRead === 'loading' || detailRead.status !== 'ok') return readState(detailRead, pull.repository)
  const { detail: d } = detailRead
  const open = d.lifecycle === 'open' || d.lifecycle === 'draft'
  return (
    <div className="pull-node__conversation">
      {detailRead.stale && <p className="pull-node__stale" role="status">{STALE_TEXT[detailRead.stale]}</p>}
      {open && (props.onWork || props.onSendToAgent) && (
        <div className="pull-node__actions">
          {props.onWork && <button className="pull-compose__button" onClick={() => props.onWork?.(d)}>Work on this PR</button>}
          {props.onSendToAgent && <PullSendToAgent {...props} detail={d} checks={checks} />}
        </div>
      )}
      <PullSidebar {...props} detail={d} avatars={detailRead.avatarDataUrls} />
      <PullTimeline {...props} detail={d} lineComments={convo?.lineComments ?? []}
        detailAvatars={{ ...detailRead.avatarDataUrls, ...convo?.avatarDataUrls }} />
      {props.proposalBar}
      <PullMergeBox {...props} detail={d} checks={checks} />
      <PullComposer {...props} headSha={d.head.sha} />
    </div>
  )
}
