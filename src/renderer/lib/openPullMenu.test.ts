import { describe, expect, it } from 'vitest'
import type { GitHubControlView } from '@shared/github-issues'
import { EMPTY_PULL_BOARD, type GitHubPullBoard, type GitHubPullStatus } from '@shared/github-pull-status'
import { FAILURE_TEXT, REFUSAL_TEXT } from '../nodes/pull/shared'
import {
  NO_GITHUB_REMOTE_TEXT, NO_OPEN_PULLS_TEXT, NO_READ_YET_TEXT, notAllowedText, openPullSection
} from './openPullMenu'

const view = (over: { approved?: boolean; repository?: string; signedIn?: boolean; unreachable?: boolean } = {}): GitHubControlView => ({
  control: { revision: 1, authProvider: 'auto' },
  auth: {
    selectedProvider: 'auto', activeProvider: over.signedIn === false ? null : 'gh', ghAuthenticated: over.signedIn !== false,
    tokenPresent: false, storage: 'encrypted',
    ...(over.unreachable ? { unreachable: { reason: 'unreachable' as const } } : {})
  },
  project: {
    projectId: 'p', approved: over.approved ?? true,
    ...('repository' in over ? (over.repository ? { repository: over.repository } : {}) : { repository: 'o/r' })
  }
})
const pull = (number: number, over: Partial<GitHubPullStatus> = {}): GitHubPullStatus => ({
  number, lifecycle: 'open', headRefName: `feat/${number}`, closes: [], ...over
})
const board = (pulls: GitHubPullStatus[], over: Partial<GitHubPullBoard> = {}): GitHubPullBoard => ({
  ...EMPTY_PULL_BOARD, pulls, observedAt: 1, ...over
})

describe('openPullSection', () => {
  it('lists open and draft PRs, review requests first then newest, with title, branch and author', () => {
    const user = { id: 7, login: 'ann', avatarUrl: 'https://avatars.githubusercontent.com/u/7' }
    const section = openPullSection(view(), board([
      pull(3, { title: 'Old', authorUser: user, author: 'ann' }),
      pull(5, { lifecycle: 'draft', author: 'bob' }),
      pull(4, { lifecycle: 'merged' }),
      pull(2, { reviewRequested: true })
    ], { avatarDataUrls: { 7: 'data:image/png;base64,AA==' } }), 'feat/x')
    expect(section).toEqual({
      branch: 'feat/x',
      avatars: { 7: 'data:image/png;base64,AA==' },
      rows: [
        { number: 2, headRefName: 'feat/2', draft: false, author: null },
        { number: 5, headRefName: 'feat/5', draft: true, author: { id: 0, login: 'bob', avatarUrl: '' } },
        { number: 3, title: 'Old', headRefName: 'feat/3', draft: false, author: user }
      ]
    })
  })

  it('says why there is no list: no remote, signed out, not allowed, no answer', () => {
    expect(openPullSection(view({ repository: undefined }), undefined)).toEqual({ reason: NO_GITHUB_REMOTE_TEXT })
    expect(openPullSection(view({ signedIn: false }), board([pull(1)]))).toEqual({ reason: REFUSAL_TEXT['signed-out']('o/r') })
    expect(openPullSection(view({ approved: false }), undefined, 'main')).toEqual({ branch: 'main', reason: notAllowedText('o/r') })
    expect(openPullSection(undefined, undefined)).toEqual({ reason: FAILURE_TEXT.unreachable })
    expect(openPullSection(view(), undefined)).toEqual({ reason: FAILURE_TEXT.unreachable })
  })

  it('a sign-in that could not be checked still lists what memory holds', () => {
    const section = openPullSection(view({ signedIn: false, unreachable: true }), board([pull(1)]))
    expect('rows' in section && section.rows.map((r) => r.number)).toEqual([1])
  })

  it('an empty list names whether GitHub was read yet', () => {
    expect(openPullSection(view(), board([], { observedAt: undefined }))).toEqual({ reason: NO_READ_YET_TEXT })
    expect(openPullSection(view(), board([pull(1, { lifecycle: 'closed' })]))).toEqual({ reason: NO_OPEN_PULLS_TEXT })
  })
})
