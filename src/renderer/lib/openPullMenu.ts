// The add menu's and the Dock's open PR section, from two answers this machine already holds: the
// GitHub control status and the board's pull status (memory, no request). Pure, so the sentences
// and the order are tested without a canvas.
import type { GitHubControlView } from '@shared/github-issues'
import type { GitHubPullBoard } from '@shared/github-pull-status'
import { FAILURE_TEXT, REFUSAL_TEXT } from '../nodes/pull/readText'
import type { OpenPullSection } from './addMenuSpec'

/** The add menu's own sentence for a folder with no GitHub remote (its "Pull request…" toast). */
export const NO_GITHUB_REMOTE_TEXT = 'This folder has no GitHub remote. Add one with git remote add origin <url>.'
export const notAllowedText = (repository: string): string =>
  `Allow ${repository} on this computer to list its pull requests: click here to allow it.`
export const NO_READ_YET_TEXT = 'Open pull requests show after the first GitHub read.'
export const NO_OPEN_PULLS_TEXT = 'No open pull requests.'

export function openPullSection(
  view: GitHubControlView | undefined,
  board: GitHubPullBoard | undefined,
  branch?: string
): OpenPullSection {
  const base = branch ? { branch } : {}
  const repository = view?.project?.repository
  if (!view) return { ...base, reason: FAILURE_TEXT.unreachable }
  if (!repository) return { ...base, reason: NO_GITHUB_REMOTE_TEXT }
  // Approval first: the host does not resolve sign-in for an unapproved repository (host.ts
  // reports activeProvider null), so checking sign-in first said "not signed in" to a signed-in user.
  if (!view.project?.approved) return { ...base, reason: notAllowedText(repository), allow: true }
  // A sign-in that could not be CHECKED is not "signed out": the memory below may still answer.
  if (!view.auth.activeProvider && !view.auth.unreachable) return { ...base, reason: REFUSAL_TEXT['signed-out'](repository) }
  if (!board) return { ...base, reason: FAILURE_TEXT.unreachable }
  const rows = board.pulls
    .filter((pull) => pull.lifecycle === 'open' || pull.lifecycle === 'draft')
    // The PRs waiting for my review first, then newest number first (the picker's order).
    .sort((a, b) => Number(!!b.reviewRequested) - Number(!!a.reviewRequested) || b.number - a.number)
    .map((pull) => ({
      number: pull.number,
      ...(pull.title ? { title: pull.title } : {}),
      headRefName: pull.headRefName,
      draft: pull.lifecycle === 'draft',
      author: pull.authorUser ?? (pull.author ? { id: 0, login: pull.author, avatarUrl: '' } : null)
    }))
  if (!rows.length) return { ...base, reason: board.observedAt === undefined ? NO_READ_YET_TEXT : NO_OPEN_PULLS_TEXT }
  return { ...base, rows, ...(board.avatarDataUrls ? { avatars: board.avatarDataUrls } : {}) }
}
