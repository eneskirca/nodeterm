import {
  GITHUB_LINK_TITLE_MAX,
  GITHUB_LINKS_PER_NODE_MAX,
  type GitHubIssueCardView,
  type GitHubLink,
  type GitHubLinkKind
} from '@shared/github-issues'
import type { GitHubBranchPull } from '@shared/github-issues'
import type { ProjectKanban } from '@shared/types'
import { pullCardState } from './githubPull'

/** What a linked item currently is. `unknown` is its own answer: no card has been resolved yet,
 *  which is not the same as an item nobody can find. */
export type GitHubLinkState = 'open' | 'closed' | 'draft' | 'merged' | 'unknown'

/** Identity of a link within a node. Issue #7 and pull #7 are different items — GitHub's two
 *  spaces share one number sequence — so the kind is part of the key. */
export function linkKey(link: Pick<GitHubLink, 'kind' | 'number'>): string {
  return `${link.kind}#${link.number}`
}

export function hasLink(links: GitHubLink[] | undefined, link: Pick<GitHubLink, 'kind' | 'number'>): boolean {
  return !!links?.some((entry) => entry.kind === link.kind && entry.number === link.number)
}

/** Append a link. Returns the SAME array when it changes nothing, so a caller can skip the write
 *  (and the board-log event) on a duplicate or a full node. */
export function addLink(links: GitHubLink[] | undefined, link: GitHubLink): GitHubLink[] {
  const current = links ?? []
  if (hasLink(current, link) || current.length >= GITHUB_LINKS_PER_NODE_MAX) return current
  // Clamped here, not only in the picker: the sanitizer drops an over-long title on the next save,
  // which would turn a chip that showed a title into a bare `#n`.
  const title = link.title?.slice(0, GITHUB_LINK_TITLE_MAX)
  return [...current, { kind: link.kind, number: link.number, ...(title ? { title } : {}) }]
}

/** Remove a link. `undefined` when nothing is left — the field is absent rather than `[]`, which
 *  is what keeps a link-less node byte-identical in the shared project file. */
export function removeLink(
  links: GitHubLink[] | undefined,
  link: Pick<GitHubLink, 'kind' | 'number'>
): GitHubLink[] | undefined {
  const next = (links ?? []).filter((entry) => !(entry.kind === link.kind && entry.number === link.number))
  return next.length ? next : undefined
}

export function linkState(link: GitHubLink, card?: GitHubIssueCardView): GitHubLinkState {
  if (!card) return 'unknown'
  if (link.kind === 'pull' || card.pull) return pullCardState(card)
  return card.state === 'closed' ? 'closed' : 'open'
}

/** The chip's own text: the first link, plus how many more the node carries. */
export function linkChipLabel(links: GitHubLink[]): string {
  if (!links.length) return ''
  const first = `#${links[0].number}`
  return links.length > 1 ? `${first} +${links.length - 1}` : first
}

/** One line per link, live title preferred over the snapshot taken when it was attached. */
export function linkTooltip(
  links: GitHubLink[],
  cards?: Record<string, GitHubIssueCardView | undefined>
): string {
  return links.map((link) => linkToBoardTitle(link, cards?.[linkKey(link)])).join('\n')
}

/** `#12 Title` — the label used in menus, the board-log event and the tooltip. */
export function linkToBoardTitle(link: GitHubLink, card?: GitHubIssueCardView): string {
  const title = card?.title ?? link.title ?? ''
  return title ? `#${link.number} ${title}` : `#${link.number}`
}

/** What the picker's input box resolved to. The kind is absent for a bare number: only a lookup
 *  can say which of GitHub's two spaces owns it. */
export interface ParsedLinkInput {
  number: number
  kind?: GitHubLinkKind
}

const URL_PATTERN = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/

/**
 * Read `#123`, `123` or a github.com issue/PR URL. A URL for ANOTHER repository is `null`, not a
 * bare number: the link's repository is the project's, so accepting it would silently attach the
 * same number in the wrong repo.
 */
export function parseLinkInput(text: string, repository: string | undefined): ParsedLinkInput | null {
  const value = text.trim()
  if (!value) return null
  const url = value.match(URL_PATTERN)
  if (url) {
    if (!repository || url[1].toLocaleLowerCase('en-US') !== repository.toLocaleLowerCase('en-US')) return null
    const number = Number(url[3])
    if (!Number.isSafeInteger(number) || number <= 0) return null
    return { number, kind: url[2] === 'pull' ? 'pull' : 'issue' }
  }
  const digits = value.match(/^#?(\d+)$/)
  if (!digits) return null
  const number = Number(digits[1])
  if (!Number.isSafeInteger(number) || number <= 0) return null
  return { number }
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/

/**
 * The repository every link on this board resolves against, or `undefined` when the project has
 * none — which is also the whole "is GitHub configured here?" answer for the attach affordances.
 *
 * Deliberately NOT `core/github/config`'s `parseGitHubRepository`: that module imports
 * `node:crypto` and cannot run in the renderer, and it also ACCEPTS a git URL. The stored value
 * has already been normalised to `owner/repo` by the settings write path, so this is a shape
 * check on a value we own, not a second parser.
 */
export function linkRepository(kanban: ProjectKanban | undefined): string | undefined {
  const value = kanban?.github?.repository?.trim()
  return value && REPOSITORY.test(value) ? value : undefined
}

/**
 * The open pull requests a worktree frame may SUGGEST attaching: those not already linked and not
 * dismissed on this machine, newest first.
 *
 * Suggest, never adopt (issue #462): a bad guess costs a dismissed prompt, not a wrong chip, so
 * nothing here ever writes a link — the caller renders these and waits for a click.
 */
export function suggestionFor(
  links: GitHubLink[] | undefined,
  pulls: GitHubBranchPull[],
  dismissed: ReadonlySet<number>
): GitHubBranchPull[] {
  return pulls
    .filter((pull) => !dismissed.has(pull.number) &&
      !hasLink(links, { kind: 'pull', number: pull.number }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
}

/** The branch a worktree frame is on: what git observed now, else the last status read, else the
 *  binding. The frame's label, its suggestion and Canvas's "Check for pull request" all read this,
 *  so a checkout that moved off the bound branch is asked about under the branch it shows. */
export function worktreeBranch(
  observed: string | undefined,
  status: { branch?: string } | undefined,
  worktree: { branch: string } | undefined
): string | undefined {
  return observed || status?.branch || worktree?.branch || undefined
}

/** A branch pull request as a picker row, so the frame can hand its candidates to the picker. */
export function branchPullCard(pull: GitHubBranchPull): GitHubIssueCardView {
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: '',
    state: 'open',
    stateReason: null,
    htmlUrl: pull.htmlUrl,
    apiUrl: '',
    labels: [],
    assignees: [],
    createdAt: pull.updatedAt,
    updatedAt: pull.updatedAt,
    locked: false,
    pull: { draft: pull.draft, mergedAt: null, head: pull.head },
    columnId: null,
    conflict: null
  }
}
