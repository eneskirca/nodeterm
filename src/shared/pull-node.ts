// The pull request node's persisted reference (CanvasNodeState.pull). It names a PR and the view
// the user left it on, and nothing else: PR text never lands in the git-shared project file. It is
// read from that hand-editable file, so every load re-validates it (`normalizePullRef`).

import { parseRepository } from './github-issue-ref'
import type { GitHubPullBoard, PullReviewDecision } from './github-pull-status'

// Commits and Checks are named here so their tickets add only a panel; the view shows a tab it has
// no panel for as Conversation.
export type PullNodeTab = 'conversation' | 'commits' | 'checks' | 'files'

export interface PullNodeRef {
  /** `owner/name` the node was opened for. The core refuses it unless it is the project's approved
   *  repository, so a shared file cannot point the user's token at another one. */
  repository: string
  pullNumber: number
  tab: PullNodeTab
  /** Files tab: the changed file shown in the diff. */
  selectedFile?: string
}

const TABS: readonly PullNodeTab[] = ['conversation', 'commits', 'checks', 'files']

/** A tab as a saved project or an agent names it. `overview` is the old name of Conversation
 *  (its content moved there). Anything else is undefined. */
export function pullTab(value: unknown): PullNodeTab | undefined {
  if (value === 'overview') return 'conversation'
  return TABS.find((tab) => tab === value)
}

/** The reference if it is well formed, else undefined (the node stays and shows no PR). Copies
 *  exactly the four fields, so nothing else on the object is ever persisted. */
export function normalizePullRef(value: unknown): PullNodeRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { repository, pullNumber, tab, selectedFile } = value as Record<string, unknown>
  // The one shared `owner/repo` grammar (github-issue-ref), so a node accepts what the board does.
  if (typeof repository !== 'string' || !parseRepository(repository)) return undefined
  if (typeof pullNumber !== 'number' || !Number.isSafeInteger(pullNumber) || pullNumber < 1 ||
      pullNumber > 2_147_483_647) return undefined
  const shown = pullTab(tab)
  if (!shown) return undefined
  const file = typeof selectedFile === 'string' && selectedFile.length > 0 && selectedFile.length <= 4_096 &&
    !selectedFile.includes('\u0000') ? selectedFile : undefined
  return { repository, pullNumber, tab: shown, ...(file ? { selectedFile: file } : {}) }
}

/** The reference as it is written to the git-shared project file. An older build's
 *  `normalizePullRef` knows only overview/files/conversation and drops the whole ref on any other
 *  tab, so Commits and Checks are saved as Conversation (CONTRIBUTING: a new board fact must be
 *  harmless to an older build). The live node keeps its tab until the next load. */
export function savedPullRef(value: unknown): PullNodeRef | undefined {
  const ref = normalizePullRef(value)
  return ref && (ref.tab === 'commits' || ref.tab === 'checks') ? { ...ref, tab: 'conversation' } : ref
}

/** A node reference from a PR's `html_url` (`https://github.com/o/r/pull/7`), opened on Conversation.
 *  Undefined unless the URL names exactly `expectedNumber`. */
export function pullRefFromHtmlUrl(htmlUrl: unknown, expectedNumber: number): PullNodeRef | undefined {
  if (typeof htmlUrl !== 'string') return undefined
  const m = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/(\d+)$/.exec(htmlUrl)
  if (!m || Number(m[2]) !== expectedNumber) return undefined
  return normalizePullRef({ repository: m[1], pullNumber: expectedNumber, tab: 'conversation' })
}

const REVIEW_TEXT: Record<PullReviewDecision, string> = {
  approved: 'Approved', 'changes-requested': 'Changes requested', required: 'Review required'
}

/** The add-menu picker's rows: the open and draft PRs the board's poll already holds (no new
 *  read), newest number first. The poll keeps only a few recent closed or merged PRs, so those are
 *  left out and the user types the number instead. */

export function pullPickerChoices(board: GitHubPullBoard | undefined): { label: string; value: string }[] {
  return (board?.pulls ?? [])
    .filter((p) => p.lifecycle === 'open' || p.lifecycle === 'draft')
    // The PRs waiting for my review first, then newest number first.
    .sort((a, b) => Number(!!b.reviewRequested) - Number(!!a.reviewRequested) || b.number - a.number)
    .map((p) => ({
      label: [
        `#${p.number} ${p.headRefName}${p.lifecycle === 'draft' ? ' (draft)' : ''}`,
        p.author,
        p.reviewRequested ? 'Review requested' : p.review && REVIEW_TEXT[p.review]
      ].filter(Boolean).join(' · '),
      value: String(p.number)
    }))
}

/** Where a PR lives on github.com, from the reference alone (no read needed). */
export function pullWebUrl(repository: string, pullNumber: number): string {
  return `https://github.com/${repository}/pull/${pullNumber}`
}

/** The node menu's "Refresh pull request" row asks the mounted pull node (detail: its node id). */
export const PULL_REFRESH_EVENT = 'nodeterm:pull-refresh'
