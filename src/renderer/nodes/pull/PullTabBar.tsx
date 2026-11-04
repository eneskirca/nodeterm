import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullWebUrl, type PullNodeRef, type PullNodeTab } from '@shared/pull-node'
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

export function PullTabBar({ pull, shown, detail, checks, onTab, onOpenExternal }: {
  pull: PullNodeRef; shown: PullNodeTab; detail: GitHubPullDetail | undefined; checks?: PullChecksRead
  onTab: (tab: PullNodeTab) => void; onOpenExternal: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="pull-node__tabs" role="tablist">
      {PULL_TABS.map(({ tab, label, count, failing }) => {
        const failed = detail && failing ? failing(detail, checks) : 0
        return (
          <button key={tab} role="tab" aria-selected={tab === shown} className="pull-node__tab" onClick={() => onTab(tab)}>
            {label}
            {count && detail && count(detail, checks) !== undefined && <> <span
              className={`pull-node__count${failed ? ' pull-node__count--failed' : ''}`}
              title={failed ? `${failed} failing` : undefined}>{count(detail, checks)}</span></>}
          </button>
        )
      })}
      <span className="term-node__spacer" />
      <button className="pull-node__web" onClick={() => onOpenExternal(pullWebUrl(pull.repository, pull.pullNumber))}>
        Open on GitHub
      </button>
    </div>
  )
}
