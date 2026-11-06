// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitHubPullDetail } from '@shared/github-pull-detail'
import { PullHeader } from './PullHeader'

const author = { id: 2, login: 'teammate', avatarUrl: 'https://avatars.githubusercontent.com/u/2' }
const merger = { id: 3, login: 'me', avatarUrl: 'https://avatars.githubusercontent.com/u/3' }
const detail: GitHubPullDetail = {
  number: 7, title: 'T', body: '', lifecycle: 'open', author,
  base: { ref: 'main', sha: 'b'.repeat(40) }, head: { ref: 'feat', sha: 'c'.repeat(40) },
  additions: 1, deletions: 0, changedFiles: 1, url: 'https://github.com/o/r/pull/7', commits: 3
}
const sentence = (d: GitHubPullDetail) => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PullHeader pull={{ repository: 'o/r', pullNumber: 7 } as never} detail={d} />)
  return host.querySelector('.pr-head__sentence')?.textContent
}

describe('PullHeader sentence', () => {
  it('names the author while the PR is open', () => {
    expect(sentence(detail)).toBe('teammate wants to merge 3 commits into main from feat')
  })

  it('names who merged it, not the author', () => {
    expect(sentence({ ...detail, lifecycle: 'merged', mergedBy: merger })).toBe('me merged 3 commits into main from feat')
  })

  it('names nobody when GitHub hides the merger', () => {
    expect(sentence({ ...detail, lifecycle: 'merged' })).toBe('3 commits merged into main from feat')
    expect(sentence({ ...detail, lifecycle: 'merged', commits: undefined })).toBe('Merged into main from feat')
  })
})
