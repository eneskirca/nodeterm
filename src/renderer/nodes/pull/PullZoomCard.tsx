import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { PullNodeRef } from '@shared/pull-node'
import type { ShownProposal } from '@shared/pull-agent-verbs'
import { Icon, type IconName } from './Icon'
import type { ReadinessSegment } from './readiness'

/** Below this canvas zoom the pull node shows only this card (F4). */
export const PULL_CARD_ZOOM = 0.5
export const isCardZoom = (zoom: number): boolean => zoom < PULL_CARD_ZOOM

const STATE_ICON: Record<GitHubPullDetail['lifecycle'], IconName> = { open: 'pr', draft: 'draft', merged: 'merged', closed: 'closed' }

/** The one readiness fact worth reading from afar: the first blocker, else review and checks together. */
function readinessLine(segments: readonly ReadinessSegment[]): ReadinessSegment | undefined {
  const facts = segments.filter((segment) => segment.key !== 'agent')
  const worst = facts.find((segment) => segment.tone === 'danger') ?? facts.find((segment) => segment.tone === 'attention')
  if (worst || !facts.length) return worst
  return { ...facts[0], label: facts.slice(0, 2).map((segment) => segment.label).join(' · ') }
}

/** The zoomed-out pull node (F4 "the node becomes its status"): state, number, title, one readiness
 *  line, and the agent's proposal. Drawn only from what the shell already read. */
export function PullZoomCard({ pull, detail, segments, proposal }: {
  pull: PullNodeRef; detail: GitHubPullDetail | undefined; segments: readonly ReadinessSegment[]; proposal?: ShownProposal
}): React.JSX.Element {
  const line = readinessLine(segments)
  const agent = proposal && segments.find((segment) => segment.key === 'agent')
  return (
    <div className="pr-zoom" data-testid="pull-zoom-card">
      <div className="pr-zoom__top">
        <span className={`pr-zoom__state pr-state--${detail?.lifecycle ?? 'draft'}`}>
          <Icon name={detail ? STATE_ICON[detail.lifecycle] : 'pr'} size={20} label={detail?.lifecycle} />
        </span>
        <span className="pr-zoom__number">#{pull.pullNumber}</span>
      </div>
      <span className="pr-zoom__title">{detail?.title ?? pull.repository}</span>
      {line && (
        <span className={`pr-zoom__line pr-zoom__line--${line.tone}`}>
          {line.icon && <Icon name={line.icon} size={20} />}{line.label}
        </span>
      )}
      {agent && <span className="pr-zoom__line pr-zoom__line--agent"><Icon name="agent" size={20} />{agent.label}</span>}
    </div>
  )
}
