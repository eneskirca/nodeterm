import type { GitHubPullDetail } from '@shared/github-pull-detail'
import type { PullNodeTab } from '@shared/pull-node'
import type { PullChecksRead } from '../../lib/pullMergeBlock'
import { headChecks } from './PullChecksTab'

/** The tabs the node shows, in order, each with its label and count. Commits (07) and Checks (08)
 *  add a row here and a panel in PullNodeView. */
export const PULL_TABS: ReadonlyArray<{
  tab: PullNodeTab; label: string
  count?: (detail: GitHubPullDetail, checks?: PullChecksRead) => number | undefined
  /** The count shows red (a failing check run). */
  failing?: (detail: GitHubPullDetail, checks?: PullChecksRead) => number
}> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'commits', label: 'Commits', count: (detail) => detail.commits },
  {
    tab: 'checks', label: 'Checks',
    count: (detail, checks) => headChecks(checks, detail.head.sha)?.length,
    failing: (detail, checks) => headChecks(checks, detail.head.sha)?.filter((check) => check.state === 'failed').length ?? 0
  },
  { tab: 'files', label: 'Files changed', count: (detail) => detail.changedFiles }
]

/** The tab a saved reference names, or Conversation for one this build has no panel for. */
export const shownPullTab = (tab: PullNodeTab): PullNodeTab =>
  PULL_TABS.some((row) => row.tab === tab) ? tab : 'conversation'

/** GitHub's underline tabs with counts (F1), and the PR's size (+/-) on the right. */
export function PullTabBar({ shown, detail, checks, onTab, extra }: {
  shown: PullNodeTab; detail: GitHubPullDetail | undefined; checks?: PullChecksRead
  onTab: (tab: PullNodeTab) => void
  /** Right end of the row, after the size (F-07's "N notes for agent"). */
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="pull-node__tabs pr-tabs" role="tablist">
      {PULL_TABS.map(({ tab, label, count, failing }) => {
        const failed = detail && failing ? failing(detail, checks) : 0
        return (
          <button key={tab} role="tab" aria-selected={tab === shown} className="pull-node__tab pr-tabs__tab" onClick={() => onTab(tab)}>
            {label}
            {count && detail && count(detail, checks) !== undefined && <> <span
              className={`pull-node__count${failed ? ' pull-node__count--failed' : ''}`}
              title={failed ? `${failed} failing` : undefined}>{count(detail, checks)}</span></>}
          </button>
        )
      })}
      {detail && (
        <span className="pr-tabs__size" title={`${detail.additions} additions, ${detail.deletions} deletions`}>
          <span className="pr-add">+{detail.additions}</span> <span className="pr-del">−{detail.deletions}</span>
        </span>
      )}
      {extra}
    </div>
  )
}
