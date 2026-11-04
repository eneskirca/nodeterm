import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { pullWebUrl, type PullNodeRef, type PullNodeTab } from '@shared/pull-node'

/** The tabs the node shows, in order, each with its label and count. Commits (07) and Checks (08)
 *  add a row here and a panel in PullNodeView. */
export const PULL_TABS: ReadonlyArray<{ tab: PullNodeTab; label: string; count?: (detail: GitHubPullDetail) => number }> = [
  { tab: 'conversation', label: 'Conversation' },
  { tab: 'files', label: 'Files changed', count: (detail) => detail.changedFiles }
]

/** The tab a saved reference names, or Conversation for one this build has no panel for. */
export const shownPullTab = (tab: PullNodeTab): PullNodeTab =>
  PULL_TABS.some((row) => row.tab === tab) ? tab : 'conversation'

export function PullTabBar({ pull, shown, detail, onTab, onOpenExternal }: {
  pull: PullNodeRef; shown: PullNodeTab; detail: GitHubPullDetail | undefined
  onTab: (tab: PullNodeTab) => void; onOpenExternal: (url: string) => void
}): React.JSX.Element {
  return (
    <div className="pull-node__tabs" role="tablist">
      {PULL_TABS.map(({ tab, label, count }) => (
        <button key={tab} role="tab" aria-selected={tab === shown} className="pull-node__tab" onClick={() => onTab(tab)}>
          {label}
          {count && detail && <> <span className="pull-node__count">{count(detail)}</span></>}
        </button>
      ))}
      <span className="term-node__spacer" />
      <button className="pull-node__web" onClick={() => onOpenExternal(pullWebUrl(pull.repository, pull.pullNumber))}>
        Open on GitHub
      </button>
    </div>
  )
}
